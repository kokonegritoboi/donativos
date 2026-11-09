/* Registro de donativos - app.js */
'use strict';

/* ============ Utilidades ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
const fmtNum = n => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toLocaleDateString('en-CA');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function barcodeFormat(code) {
  if (/^\d{13}$/.test(code)) return 'EAN13';
  if (/^\d{12}$/.test(code)) return 'UPC';
  if (/^\d{8}$/.test(code)) return 'EAN8';
  return 'CODE128';
}

const CATEGORIES = ['Ropa y calzado', 'Alimentos', 'Medicamentos y salud', 'Muebles', 'Electrónicos', 'Libros y útiles', 'Juguetes', 'Herramientas', 'Dinero', 'Otro'];

/* ============ Almacenamiento (IndexedDB) ============ */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('donativos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('donations', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  store(mode) { return this.db.transaction('donations', mode).objectStore('donations'); },
  wrap(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); },
  all() { return this.wrap(this.store('readonly').getAll()); },
  put(d) { return this.wrap(this.store('readwrite').put(d)); },
  del(id) { return this.wrap(this.store('readwrite').delete(id)); },
  clear() { return this.wrap(this.store('readwrite').clear()); },
  bulk(arr) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('donations', 'readwrite');
      const s = t.objectStore('donations');
      arr.forEach(d => s.put(d));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }
};

const Settings = {
  get org() { return localStorage.getItem('don_org') || 'Registro de donativos'; },
  get sub() { return localStorage.getItem('don_sub') || ''; },
  set(org, sub) { localStorage.setItem('don_org', org.trim()); localStorage.setItem('don_sub', sub.trim()); }
};

function nextCode() {
  const n = (parseInt(localStorage.getItem('don_counter') || '0', 10) || 0) + 1;
  localStorage.setItem('don_counter', String(n));
  return 'DON-' + String(n).padStart(6, '0');
}
function syncCounter(list) {
  const max = list.reduce((m, d) => {
    const n = parseInt(String(d.code || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const cur = parseInt(localStorage.getItem('don_counter') || '0', 10) || 0;
  if (max > cur) localStorage.setItem('don_counter', String(max));
}

/* ============ Estado ============ */
let donations = [];
let editingId = null;
let photoData = null;
let currentSheetId = null;

/* ============ Navegación ============ */
function showView(name) {
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
  $$('.nav-btn').forEach(t => { const on = t.dataset.view === name; t.classList.toggle('active', on); if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  if (name === 'lista') renderList();
  if (name === 'resumen') renderSummary();
  if (name === 'respaldo') renderData();
  window.scrollTo({ top: 0 });
}
$$('.nav-btn').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
$('#btnTopSearch').addEventListener('click', () => { showView('lista'); $('#q').focus(); });

/* ============ Formulario ============ */
function fillCategories() {
  const opts = CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('');
  $('#f-category').innerHTML = opts;
  $('#fCategory').innerHTML = '<option value="">Todas las categorías</option>' + opts;
}

const getQty = () => ($('#f-multiple').checked ? (parseInt($('#f-qty').value, 10) || 0) : 1);
function syncMultiple() {
  const on = $('#f-multiple').checked;
  $('#qtyWrap').hidden = !on;
  if (on && !(parseInt($('#f-qty').value, 10) >= 2)) $('#f-qty').value = 2;
  updateTotal();
}
function updateTotal() {
  const t = round2(getQty() * (parseFloat($('#f-unit').value) || 0));
  $('#f-total').textContent = fmtMoney(t);
  return t;
}
['#f-qty', '#f-unit'].forEach(s => $(s).addEventListener('input', updateTotal));
$('#f-multiple').addEventListener('change', syncMultiple);

function setPhoto(data) {
  photoData = data || null;
  $('#photoPreview').innerHTML = data ? `<img alt="Foto del objeto" src="${data}">` : '<em>Sin foto</em>';
  $('#photoClear').hidden = !data;
}
$('#photoClear').addEventListener('click', () => setPhoto(null));

function compressImage(file, max = 1000, quality = 0.75) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}
['#f-photo-cam', '#f-photo-file'].forEach(sel => $(sel).addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { setPhoto(await compressImage(file)); }
  catch (err) { toast(err.message); }
}));

function refreshDonorList() {
  const donors = [...new Set(donations.map(d => d.donor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  $('#donorList').innerHTML = donors.map(n => `<option value="${esc(n)}"></option>`).join('');
  const groups = [...new Set(donations.map(d => d.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  $('#groupList').innerHTML = groups.map(n => `<option value="${esc(n)}"></option>`).join('');
}

// Si la matrícula ya se registró, se completan los datos de la persona
$('#f-matricula').addEventListener('change', () => {
  const m = $('#f-matricula').value.trim().toLowerCase();
  if (!m) return;
  const prev = donations.filter(d => (d.matricula || '').toLowerCase() === m && d.id !== editingId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!prev) return;
  if (!$('#f-donor').value.trim()) $('#f-donor').value = prev.donor;
  if (!$('#f-email').value.trim()) $('#f-email').value = prev.email || '';
  if (!$('#f-group').value.trim()) $('#f-group').value = prev.group || '';
  if (!$('#f-contact').value.trim()) $('#f-contact').value = prev.contact || '';
  toast('Se completaron los datos de esta matrícula');
});

let barcodeOk = false;
function setBarcodeOk(ok) {
  barcodeOk = ok;
  $('#detailFields').disabled = !ok;
  if (!ok) $('#barcodeHint').textContent = 'Escanea el código de barras que trae el producto (cámara o lector USB) y pulsa Continuar para registrar el donativo.';
}
const setHint = t => { $('#barcodeHint').textContent = t; };

async function lookupProduct(code) {
  if (!/^\d{8,14}$/.test(code)) { setHint('Escribe el nombre del objeto.'); return; }
  setHint('Buscando el producto...');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    const name = [j.product?.product_name, j.product?.brands].filter(Boolean).join(' · ');
    if (j.status === 1 && name && !$('#f-object').value.trim() && $('#f-barcode').value.trim() === code) {
      $('#f-object').value = name;
      setHint('Nombre encontrado en Open Food Facts; revísalo.');
      return;
    }
  } catch (e) { /* sin internet o sin resultado */ }
  setHint('Producto no encontrado en línea; escribe el nombre del objeto.');
}

async function confirmBarcode(raw) {
  const code = String(raw ?? $('#f-barcode').value).trim();
  if (!code) { toast('Escanea o escribe el código de barras'); $('#f-barcode').focus(); return; }
  $('#f-barcode').value = code;
  setBarcodeOk(true);
  const prev = donations.filter(d => d.barcode === code && d.id !== editingId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (prev && !$('#f-object').value.trim()) {
    $('#f-object').value = prev.object;
    $('#f-category').value = prev.category;
    $('#f-unit').value = prev.unit;
    $('#f-condition').value = prev.condition || 'Buen estado';
    updateTotal();
    setHint('Producto ya registrado antes: se copiaron nombre, categoría y valor. Revísalos.');
  } else if (!$('#f-object').value.trim()) {
    lookupProduct(code);
  } else {
    setHint('');
  }
  $('#f-donor').focus();
}
$('#btnBarcodeOk').addEventListener('click', () => confirmBarcode());
$('#f-barcode').addEventListener('input', () => { if (barcodeOk) setBarcodeOk(false); });
$('#f-barcode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmBarcode(); } });

function resetForm() {
  editingId = null;
  $('#donationForm').reset();
  setBarcodeOk(false);
  $('#f-date').value = todayISO();
  $('#f-qty').value = 2;
  $('#f-unit').value = 0;
  $('#f-condition').value = 'Buen estado';
  setPhoto(null);
  syncMultiple();
  $('#formTitle').textContent = 'Nuevo donativo';
  $('#heroSub').textContent = 'Escanea el código de barras del producto para empezar.';
  $('#editingPill').hidden = true;
  $('#btnCancelEdit').hidden = true;
  $('#btnSave').textContent = 'Guardar donativo';
  $('#formError').hidden = true;
}

function startEdit(id) {
  const d = donations.find(x => x.id === id);
  if (!d) return;
  showView('registrar');
  editingId = id;
  $('#f-barcode').value = d.barcode;
  setBarcodeOk(true);
  setHint('');
  $('#f-donor').value = d.donor;
  $('#f-matricula').value = d.matricula || '';
  $('#f-group').value = d.group || '';
  $('#f-email').value = d.email || '';
  $('#f-contact').value = d.contact || '';
  $('#f-date').value = d.date;
  $('#f-object').value = d.object;
  $('#f-category').value = d.category;
  $('#f-condition').value = d.condition || 'Buen estado';
  $('#f-multiple').checked = !!(d.multiple || d.qty > 1);
  $('#f-qty').value = (d.multiple || d.qty > 1) ? d.qty : 2;
  $('#f-unit').value = d.unit;
  $('#f-notes').value = d.notes || '';
  setPhoto(d.photo);
  syncMultiple();
  $('#formTitle').textContent = 'Editar donativo';
  $('#heroSub').textContent = 'Corrige lo que haga falta y guarda los cambios.';
  $('#editingPill').textContent = d.code;
  $('#editingPill').hidden = false;
  $('#btnCancelEdit').hidden = false;
  $('#btnSave').textContent = 'Guardar cambios';
}
$('#btnCancelEdit').addEventListener('click', resetForm);

function readForm() {
  const donor = $('#f-donor').value.trim();
  const object = $('#f-object').value.trim();
  const date = $('#f-date').value;
  const multiple = $('#f-multiple').checked;
  const qty = multiple ? parseInt($('#f-qty').value, 10) : 1;
  const unit = parseFloat($('#f-unit').value) || 0;
  const barcode = $('#f-barcode').value.trim();
  const matricula = $('#f-matricula').value.trim().toUpperCase();
  const email = $('#f-email').value.trim();
  const group = $('#f-group').value.trim().toUpperCase();
  const errors = [];
  if (!barcode) errors.push('Falta el código de barras del producto.');
  if (!donor) errors.push('Falta indicar quién donó.');
  if (!/^[A-Za-z0-9-]{5,15}$/.test(matricula)) errors.push('La matrícula debe tener entre 5 y 15 letras o números.');
  if (!group) errors.push('Falta el grupo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Escribe un correo institucional válido.');
  if (!object) errors.push('Falta indicar el objeto donado.');
  if (!date) errors.push('Falta la fecha.');
  if (multiple && !(qty >= 2)) errors.push('En un donativo múltiple indica cuántos fueron (mínimo 2).');
  if (unit < 0) errors.push('El valor por unidad no puede ser negativo.');
  if (errors.length) return { errors };
  return {
    data: {
      barcode, donor, matricula, group, email, multiple, object, date, qty, unit,
      total: round2(qty * unit),
      contact: $('#f-contact').value.trim(),
      category: $('#f-category').value,
      condition: $('#f-condition').value,
      notes: $('#f-notes').value.trim(),
      photo: photoData
    }
  };
}

async function saveDonation(andPrint) {
  const { data, errors } = readForm();
  const box = $('#formError');
  if (errors) { box.textContent = errors.join(' '); box.hidden = false; return; }
  box.hidden = true;
  let rec;
  const existing = editingId && donations.find(x => x.id === editingId);
  if (existing) rec = { ...existing, ...data, updatedAt: Date.now() };
  else rec = { id: uid(), code: nextCode(), createdAt: Date.now(), ...data };
  try {
    await DB.put(rec);
  } catch (err) {
    box.textContent = 'No se pudo guardar: ' + (err && err.message ? err.message : 'error de almacenamiento.');
    box.hidden = false;
    return;
  }
  const i = donations.findIndex(x => x.id === rec.id);
  if (i >= 0) donations[i] = rec; else donations.push(rec);
  refreshDonorList();
  updateBadge();
  toast(existing ? 'Cambios guardados (' + rec.code + ')' : 'Donativo guardado (' + rec.code + ')');
  resetForm();
  if (andPrint) openSheet(rec.id, true);
  else $('#f-barcode').focus();
}
$('#donationForm').addEventListener('submit', e => { e.preventDefault(); saveDonation(false); });
$('#btnSavePrint').addEventListener('click', () => saveDonation(true));

/* ============ Lista ============ */
function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const cat = $('#fCategory').value;
  const from = $('#fFrom').value, to = $('#fTo').value;
  const sort = $('#fSort').value;
  let list = donations.filter(d => {
    if (cat && d.category !== cat) return false;
    if (from && d.date < from) return false;
    if (to && d.date > to) return false;
    if (q) {
      const hay = [d.barcode, d.code, d.matricula, d.group, d.email, d.donor, d.object, d.notes, d.contact, d.category].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const byDate = (a, b) => (a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date < b.date ? -1 : 1);
  if (sort === 'date-desc') list.sort((a, b) => byDate(b, a));
  else if (sort === 'date-asc') list.sort(byDate);
  else if (sort === 'value-desc') list.sort((a, b) => b.total - a.total);
  else if (sort === 'donor-asc') list.sort((a, b) => a.donor.localeCompare(b.donor, 'es'));
  return list;
}

const PALETTE = ['sun', 'lilac', 'sky', 'pink', 'peach', 'mint'];
function renderChips() {
  const cur = $('#fCategory').value;
  const items = [['', 'Todos'], ...CATEGORIES.map(c => [c, c])];
  $('#catChips').innerHTML = items.map(([v, l]) => `<button type="button" class="chip-btn${v === cur ? ' active' : ''}" data-cat="${esc(v)}" aria-pressed="${v === cur}">${esc(l)}</button>`).join('');
}
$('#catChips').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  $('#fCategory').value = b.dataset.cat;
  renderList();
});

function renderList() {
  renderChips();
  const list = filtered();
  const total = list.reduce((s, d) => s + d.total, 0);
  $('#resultCount').textContent = `${list.length} de ${donations.length} donativos, ${fmtMoney(total)}`;
  $('#emptyMsg').hidden = list.length > 0;
  $('#emptyMsg').textContent = donations.length ? 'Ningún donativo coincide con los filtros. Prueba con otra búsqueda o limpia los filtros.' : 'Todavía no hay donativos. Registra el primero escaneando un código de barras.';
  $('#list').innerHTML = list.map(d => {
    const color = PALETTE[Math.max(0, CATEGORIES.indexOf(d.category)) % PALETTE.length];
    const multi = d.multiple || d.qty > 1;
    return `
    <li class="dcard ${color}" data-id="${esc(d.id)}">
      <div class="dc-top"><span class="tag">${esc(d.category)}</span>${multi ? `<span class="tag mult">Múltiple x${fmtNum(d.qty)}</span>` : ''}</div>
      <div class="dc-main">
        <div class="dc-thumb">${d.photo ? `<img data-act="photo" alt="Foto: ${esc(d.object)}" src="${d.photo}">` : 'Sin foto'}</div>
        <div class="dc-info">
          <h3>${esc(d.object)}</h3>
          <p>${esc(d.donor)}</p>
          <p class="dc-sub">${d.matricula ? `<span>Mat. ${esc(d.matricula)}</span>` : ''}${d.group ? `<span>${esc(d.group)}</span>` : ''}</p>
        </div>
      </div>
      <div class="dc-code"><span>Barras ${esc(d.barcode)}</span><span>${esc(d.code)}</span><span>${esc(fmtDate(d.date))}</span></div>
      <div class="dc-foot">
        <div class="dc-amount"><b>${fmtMoney(d.total)}</b><small>${fmtNum(d.qty)} x ${fmtMoney(d.unit)}</small></div>
        <div class="dc-actions">
          <button class="btn sm primary" data-act="sheet">Ver hoja</button>
          <button class="btn sm" data-act="edit">Editar</button>
          <button class="btn sm ghost" data-act="del">Eliminar</button>
        </div>
      </div>
    </li>`;
  }).join('');
}
['#q', '#fFrom', '#fTo', '#fSort'].forEach(s => $(s).addEventListener('input', renderList));
$('#btnClearFilters').addEventListener('click', () => {
  $('#q').value = ''; $('#fCategory').value = ''; $('#fFrom').value = ''; $('#fTo').value = ''; $('#fSort').value = 'date-desc';
  renderList();
});

$('#list').addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.closest('.dcard').dataset.id;
  const act = el.dataset.act;
  if (act === 'sheet' || act === 'photo') openSheet(id);
  else if (act === 'edit') startEdit(id);
  else if (act === 'del') {
    const d = donations.find(x => x.id === id);
    if (!d || !confirm(`¿Eliminar el donativo ${d.code} (${d.object})? No se puede deshacer.`)) return;
    await DB.del(id);
    donations = donations.filter(x => x.id !== id);
    refreshDonorList(); updateBadge(); renderList();
    toast('Donativo eliminado');
  }
});

function updateBadge() {
  $$('.count-badge').forEach(b => { b.textContent = donations.length; });
  $('#statToday').textContent = donations.filter(d => d.date === todayISO()).length;
  $('#statTotal').textContent = fmtMoney(donations.reduce((s, d) => s + d.total, 0));
  renderWeek();
}

function renderWeek() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const names = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const withDonations = new Set(donations.map(d => d.date));
  $('#week').innerHTML = names.map((n, i) => {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = dt.toLocaleDateString('en-CA');
    return `<button type="button" class="day${iso === todayISO() ? ' today' : ''}" data-date="${iso}" aria-label="Ver donativos del ${esc(fmtDate(iso))}"><i class="dot${withDonations.has(iso) ? ' on' : ''}"></i><span>${n}</span><b>${dt.getDate()}</b></button>`;
  }).join('');
}
$('#week').addEventListener('click', e => {
  const b = e.target.closest('.day');
  if (!b) return;
  $('#fFrom').value = b.dataset.date;
  $('#fTo').value = b.dataset.date;
  showView('lista');
});

/* ============ Hoja de donativo ============ */
function sheetHTML(d) {
  const sub = Settings.sub;
  const multi = d.multiple || d.qty > 1;
  const cell = (label, value, wide) => value ? `<div${wide ? ' class="wide"' : ''}><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
  return `<article class="sheet">
    <header class="sheet-head">
      <div><h2>${esc(Settings.org)}</h2><p>Hoja de donativo${sub ? ', ' + esc(sub) : ''}</p></div>
      <div class="sheet-code"><svg class="barcode" data-code="${esc(d.barcode)}" data-format="${barcodeFormat(d.barcode)}"></svg></div>
    </header>
    <dl class="sheet-grid">
      ${cell('Código de barras del producto', d.barcode)}
      ${cell('Fecha', fmtDate(d.date))}
      ${cell('Folio de registro', d.code)}
      ${cell('Estado del objeto', d.condition)}
      ${cell('Quién lo donó', d.donor, true)}
      ${cell('Matrícula', d.matricula)}
      ${cell('Grupo', d.group)}
      ${cell('Correo institucional', d.email, true)}
      ${cell('Teléfono', d.contact)}
      ${cell('Objeto donado', d.object, true)}
      ${cell('Categoría', d.category)}
      ${cell('Donativo múltiple', multi ? 'Sí, ' + fmtNum(d.qty) + ' piezas' : 'No')}
      ${cell('Cantidad', fmtNum(d.qty))}
      ${cell('Valor por unidad', fmtMoney(d.unit))}
      <div class="wide sheet-total"><dt>Valor total (cantidad x valor)</dt><dd>${fmtMoney(d.total)}</dd></div>
      ${cell('Notas', d.notes, true)}
    </dl>
    ${d.photo ? `<figure><img alt="Foto del objeto donado" src="${d.photo}"><figcaption>Foto del objeto donado</figcaption></figure>` : ''}
    <div class="signs"><div>Firma de quien dona</div><div>Firma de quien recibe</div></div>
    <footer class="sheet-foot"><span>${esc(d.code)}</span><span>Impreso el ${esc(new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }))}</span></footer>
  </article>`;
}

function labelHTML(d) {
  return `<div class="label"><svg class="barcode" data-code="${esc(d.barcode)}" data-format="${barcodeFormat(d.barcode)}"></svg><b>${esc(d.object)}</b>${esc(d.donor)}${d.matricula ? ', ' + esc(d.matricula) : ''}<br>${esc(fmtDate(d.date))}, ${fmtNum(d.qty)} x ${fmtMoney(d.unit)} = ${fmtMoney(d.total)}</div>`;
}

function renderBarcodes(root) {
  $$('svg.barcode', root).forEach(svg => {
    const code = svg.dataset.code;
    const opts = { width: 2, height: 54, displayValue: true, fontSize: 14, margin: 0, background: '#ffffff' };
    try {
      JsBarcode(svg, code, { ...opts, format: svg.dataset.format || 'CODE128' });
    } catch (err) {
      try {
        svg.innerHTML = '';
        JsBarcode(svg, code, { ...opts, format: 'CODE128' });
      } catch (err2) { svg.outerHTML = `<strong>${esc(code)}</strong>`; }
    }
  });
}

function openSheet(id, autoPrint) {
  const d = donations.find(x => x.id === id);
  if (!d) return;
  currentSheetId = id;
  $('#sheetBox').innerHTML = sheetHTML(d);
  renderBarcodes($('#sheetBox'));
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  if (autoPrint) setTimeout(() => printSheet(), 150);
}
function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  currentSheetId = null;
}
$('#btnCloseModal').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

function doPrint(html) {
  const area = $('#printArea');
  area.innerHTML = html;
  renderBarcodes(area);
  const clear = () => { area.innerHTML = ''; window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  window.print();
}
function printSheet() {
  const d = donations.find(x => x.id === currentSheetId);
  if (d) doPrint(sheetHTML(d));
}
function printLabel() {
  const d = donations.find(x => x.id === currentSheetId);
  if (d) doPrint(labelHTML(d));
}
$('#btnPrintSheet').addEventListener('click', printSheet);
$('#btnPrintLabel').addEventListener('click', printLabel);

$('#btnPrintList').addEventListener('click', () => {
  const list = filtered();
  if (!list.length) { toast('No hay donativos para imprimir'); return; }
  const total = list.reduce((s, d) => s + d.total, 0);
  const rows = list.map(d => `<tr><td>${esc(d.barcode)}</td><td>${esc(d.code)}</td><td>${esc(fmtDate(d.date))}</td><td>${esc(d.donor)}</td><td>${esc(d.matricula || '')}</td><td>${esc(d.group || '')}</td><td>${esc(d.object)}</td><td>${esc(d.category)}</td><td class="r">${fmtNum(d.qty)}</td><td class="r">${fmtMoney(d.unit)}</td><td class="r">${fmtMoney(d.total)}</td></tr>`).join('');
  doPrint(`<div class="report"><h2>${esc(Settings.org)}</h2><p>Listado de donativos · ${list.length} registros · generado el ${esc(new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }))}</p>
    <table><thead><tr><th>Código de barras</th><th>Folio</th><th>Fecha</th><th>Donante</th><th>Matrícula</th><th>Grupo</th><th>Objeto</th><th>Categoría</th><th class="r">Cant.</th><th class="r">Valor u.</th><th class="r">Total</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><th colspan="10" class="r">Total</th><th class="r">${fmtMoney(total)}</th></tr></tfoot></table></div>`);
});

/* ============ Escáner de código de barras ============ */
let scanStream = null, scanTimer = null;
function stopScan() {
  clearTimeout(scanTimer);
  if (scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
  $('#scanVideo').srcObject = null;
  $('#scanModal').hidden = true;
}
$('#btnCloseScan').addEventListener('click', stopScan);

function matchesFor(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return donations.filter(d => (d.barcode || '').toUpperCase() === c || d.code.toUpperCase() === c);
}

async function openScanner(onCode) {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador no escanea con cámara. Usa un lector de código de barras o escribe el código.');
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    toast('No se pudo abrir la cámara. Revisa los permisos del navegador.');
    return;
  }
  const video = $('#scanVideo');
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  $('#scanModal').hidden = false;
  $('#scanMsg').textContent = 'Apunta la cámara al código de barras del producto.';
  let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (e) { /* usar lista completa */ }
  const detector = new BarcodeDetector({ formats });
  const tick = async () => {
    if (!scanStream) return;
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const raw = found[0].rawValue;
        if (onCode(raw) !== false) { stopScan(); return; }
        $('#scanMsg').textContent = 'Código leído (' + raw + ') pero no está registrado aquí.';
      }
    } catch (e) { /* seguir intentando */ }
    scanTimer = setTimeout(tick, 300);
  };
  tick();
}

// Buscar un donativo escaneando
$('#btnScan').addEventListener('click', () => openScanner(raw => {
  const m = matchesFor(raw);
  if (!m.length) return false;
  if (m.length === 1) openSheet(m[0].id);
  else { $('#q').value = raw; renderList(); }
  return true;
}));
// Registrar un donativo escaneando el producto
$('#btnScanForm').addEventListener('click', () => openScanner(raw => { $('#f-barcode').value = raw; confirmBarcode(raw); return true; }));

// Un lector USB escribe el código y pulsa Enter: abrir la hoja si hay una sola coincidencia exacta
$('#q').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const m = matchesFor($('#q').value);
  if (m.length === 1) { openSheet(m[0].id); $('#q').value = ''; renderList(); }
});

/* ============ Resumen ============ */
function groupSum(list, keyFn) {
  const m = new Map();
  list.forEach(d => {
    const k = keyFn(d);
    const cur = m.get(k) || { total: 0, count: 0 };
    cur.total += d.total; cur.count += 1;
    m.set(k, cur);
  });
  return [...m.entries()].map(([k, v]) => ({ k, ...v }));
}
function barRows(rows, fmtLabel = x => x) {
  if (!rows.length) return '<p class="muted">Sin datos todavía.</p>';
  const max = Math.max(...rows.map(r => r.total), 1);
  return rows.map(r => `<div class="bar-row"><span class="lbl" title="${esc(fmtLabel(r.k))}">${esc(fmtLabel(r.k))}</span><span class="bar"><i style="width:${Math.max(2, (r.total / max) * 100)}%"></i></span><span class="val">${fmtMoney(r.total)} <small class="muted">(${r.count})</small></span></div>`).join('');
}

function renderSummary() {
  const total = donations.reduce((s, d) => s + d.total, 0);
  const pieces = donations.reduce((s, d) => s + d.qty, 0);
  const donors = new Set(donations.map(d => d.donor.trim().toLowerCase())).size;
  $('#stats').innerHTML = [
    ['Donativos registrados', fmtNum(donations.length)],
    ['Piezas o unidades', fmtNum(pieces)],
    ['Valor total', fmtMoney(total)],
    ['Donantes distintos', fmtNum(donors)]
  ].map(([l, v]) => `<div class="stat"><small>${l}</small><b>${v}</b></div>`).join('');

  $('#byCategory').innerHTML = barRows(groupSum(donations, d => d.category).sort((a, b) => b.total - a.total));
  $('#byDonor').innerHTML = barRows(groupSum(donations, d => d.donor.trim()).sort((a, b) => b.total - a.total || b.count - a.count).slice(0, 8));

  $('#byGroup').innerHTML = barRows(groupSum(donations.filter(d => d.group), d => d.group.trim()).sort((a, b) => b.total - a.total || b.count - a.count).slice(0, 8));

  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'));
  }
  const byM = new Map(groupSum(donations, d => d.date.slice(0, 7)).map(r => [r.k, r]));
  const rows = months.map(k => ({ k, total: byM.get(k)?.total || 0, count: byM.get(k)?.count || 0 }));
  $('#byMonth').innerHTML = donations.length ? barRows(rows, k => {
    const [y, m] = k.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  }) : '<p class="muted">Sin datos todavía.</p>';
}

/* ============ Datos: respaldo, CSV, ajustes ============ */
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#btnExportJson').addEventListener('click', () => {
  if (!donations.length) { toast('No hay donativos que respaldar'); return; }
  const payload = { app: 'donativos', version: 1, exportedAt: new Date().toISOString(), org: Settings.org, sub: Settings.sub, donations };
  download(`donativos-respaldo-${todayISO()}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  toast('Respaldo descargado');
});

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmulas al abrir en Excel
  return '"' + s.replace(/"/g, '""') + '"';
}
$('#btnExportCsv').addEventListener('click', () => {
  if (!donations.length) { toast('No hay donativos que exportar'); return; }
  const head = ['Código de barras', 'Folio', 'Fecha', 'Donante', 'Matrícula', 'Grupo', 'Correo institucional', 'Donativo múltiple', 'Teléfono', 'Objeto', 'Categoría', 'Estado', 'Cantidad', 'Valor unitario', 'Total', 'Notas'];
  const rows = [...donations].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0))
    .map(d => [d.barcode, d.code, d.date, d.donor, d.matricula, d.group, d.email, (d.multiple || d.qty > 1) ? 'Sí' : 'No', d.contact, d.object, d.category, d.condition, d.qty, d.unit, d.total, d.notes].map(csvCell).join(','));
  const csv = '﻿' + [head.map(csvCell).join(','), ...rows].join('\r\n');
  download(`donativos-${todayISO()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  toast('CSV exportado');
});

function sanitize(d) {
  if (!d || typeof d !== 'object') return null;
  const qty = Number(d.qty), unit = Number(d.unit) || 0;
  if (!d.donor || !d.object || !d.date || !(qty > 0) || !(d.barcode || d.code)) return null;
  const photo = typeof d.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(d.photo) ? d.photo : null;
  return {
    id: String(d.id || uid()),
    code: String(d.code || nextCode()),
    barcode: String(d.barcode || d.code || '').slice(0, 40),
    createdAt: Number(d.createdAt) || Date.now(),
    donor: String(d.donor).slice(0, 120),
    matricula: String(d.matricula || '').slice(0, 20),
    group: String(d.group || '').slice(0, 30),
    email: String(d.email || '').slice(0, 120),
    multiple: d.multiple === true || (d.multiple === undefined && qty > 1),
    contact: String(d.contact || '').slice(0, 120),
    date: String(d.date).slice(0, 10),
    object: String(d.object).slice(0, 160),
    category: CATEGORIES.includes(d.category) ? d.category : 'Otro',
    condition: String(d.condition || 'Buen estado').slice(0, 40),
    qty, unit, total: round2(qty * unit),
    notes: String(d.notes || '').slice(0, 500),
    photo
  };
}

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const arr = Array.isArray(json) ? json : json.donations;
    if (!Array.isArray(arr)) throw new Error('El archivo no tiene el formato esperado.');
    const clean = arr.map(sanitize).filter(Boolean);
    if (!clean.length) throw new Error('El archivo no contiene donativos válidos.');
    const replace = donations.length && confirm(`El respaldo trae ${clean.length} donativos. Aceptar = reemplazar los ${donations.length} actuales. Cancelar = combinarlos con los actuales.`);
    if (replace) await DB.clear();
    await DB.bulk(clean);
    if (json.org) Settings.set(json.org, json.sub || '');
    donations = await DB.all();
    syncCounter(donations);
    refreshDonorList(); updateBadge(); applySettings(); renderData();
    toast(`${clean.length} donativos importados`);
  } catch (err) {
    toast('No se pudo importar: ' + err.message);
  }
});

$('#btnWipe').addEventListener('click', async () => {
  if (!donations.length) { toast('No hay nada que borrar'); return; }
  if (!confirm(`Se borrarán ${donations.length} donativos de este dispositivo. ¿Continuar?`)) return;
  if (!confirm('Última confirmación: esta acción no se puede deshacer.')) return;
  await DB.clear();
  donations = [];
  refreshDonorList(); updateBadge(); renderData();
  toast('Se borraron todos los donativos');
});

function applySettings() {
  $('#orgTitle').textContent = Settings.org;
  $('#orgSub').textContent = Settings.sub || 'Control de donaciones recibidas';
  document.title = Settings.org;
}
$('#btnSaveSettings').addEventListener('click', () => {
  Settings.set($('#s-org').value || 'Registro de donativos', $('#s-sub').value);
  applySettings();
  toast('Datos guardados');
});

async function renderData() {
  $('#s-org').value = localStorage.getItem('don_org') || '';
  $('#s-sub').value = Settings.sub;
  const bytes = donations.reduce((s, d) => s + (d.photo ? d.photo.length : 0), 0);
  let info = `${donations.length} donativos, fotos ≈ ${(bytes / 1048576).toFixed(1)} MB.`;
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      info += ` Almacenamiento del navegador usado: ${(usage / 1048576).toFixed(1)} MB de ${(quota / 1048576).toFixed(0)} MB.`;
    }
  } catch (e) { /* sin estimación */ }
  $('#storageInfo').textContent = info;
}

/* ============ Teclado ============ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#scanModal').hidden) stopScan();
    else if (!$('#modal').hidden) closeModal();
  }
});

/* ============ Inicio ============ */
(async function init() {
  $('#todayPill').textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
  fillCategories();
  applySettings();
  try {
    await DB.open();
    donations = await DB.all();
    syncCounter(donations);
  } catch (err) {
    $('#formError').textContent = 'Este navegador no permite guardar datos (¿modo privado?). Los donativos no se conservarán.';
    $('#formError').hidden = false;
  }
  refreshDonorList();
  updateBadge();
  resetForm();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
