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

let formQty = 1; // solo cambia al editar registros antiguos que tenían varias piezas
const getQty = () => formQty;
const peopleOf = d => 1 + ((d.coDonors && d.coDonors.length) || 0);
function addCoRow(p = {}) {
  const row = document.createElement('div');
  row.className = 'co-row';
  row.innerHTML = `<div class="co-title"><span class="co-n"></span><button type="button" class="co-del">Quitar</button></div>
    <label class="field co-name"><span class="lbl">Nombre completo *</span><input class="co-f-name" maxlength="120" placeholder="Nombre de la persona"></label>
    <label class="field"><span class="lbl">Matrícula *</span><input class="co-f-mat" maxlength="15" autocapitalize="characters" placeholder="Ej. 243110221"></label>
    <label class="field"><span class="lbl">Grupo *</span><input class="co-f-group" maxlength="30" placeholder="Ej. 3B"></label>
    <label class="field co-mail"><span class="lbl">Correo institucional *</span><input class="co-f-mail" type="email" maxlength="120" inputmode="email" autocapitalize="none" placeholder="matricula@escuela.edu.mx"></label>`;
  row.querySelector('.co-f-name').value = p.name || '';
  row.querySelector('.co-f-mat').value = p.matricula || '';
  row.querySelector('.co-f-group').value = p.group || '';
  row.querySelector('.co-f-mail').value = p.email || '';
  row.querySelector('.co-del').addEventListener('click', () => { row.remove(); numberCo(); });
  $('#coList').appendChild(row);
  numberCo();
}
function numberCo() { $('#coList').querySelectorAll('.co-n').forEach((el, i) => { el.textContent = 'Persona ' + (i + 2); }); }
function readCo() {
  return [...$('#coList').querySelectorAll('.co-row')].map(r => ({
    name: r.querySelector('.co-f-name').value.trim(),
    matricula: r.querySelector('.co-f-mat').value.trim().toUpperCase(),
    group: r.querySelector('.co-f-group').value.trim().toUpperCase(),
    email: r.querySelector('.co-f-mail').value.trim()
  }));
}
function syncMultiple() {
  const on = $('#f-multiple').checked;
  $('#coWrap').hidden = !on;
  if (on && !$('#coList').children.length) addCoRow();
  updateTotal();
}
$('#btnAddCo').addEventListener('click', () => { if ($('#coList').children.length < 20) addCoRow(); });
const SCREEN_RE = /pantalla|televisi|\btv\b|\btele\b|monitor|laptop|tablet|proyector/i;
const SIZE_HINTS = {
  'Electrónicos': 'Ej. 32 pulgadas, 4 GB, 128 GB',
  'Ropa y calzado': 'Ej. talla M, color azul, 5 piezas',
  'Muebles': 'Ej. 120 x 60 cm, madera',
  'Alimentos': 'Ej. 1 kg, caduca 03/2027',
  'Medicamentos y salud': 'Ej. 500 mg, caduca 03/2027',
  'Libros y útiles': 'Ej. 3er semestre, pasta dura',
  'Juguetes': 'Ej. edad recomendada, piezas',
  'Herramientas': 'Ej. medida, potencia, material'
};
const CHOICES = [['#worksChips', '#f-works']];
function syncChoices() {
  CHOICES.forEach(([grp, inp]) => {
    const cur = $(inp).value;
    $$(grp + ' [data-v]').forEach(b => { const on = b.dataset.v === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  });
}
CHOICES.forEach(([grp, inp]) => $(grp).addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  $(inp).value = (grp === '#worksChips' && $(inp).value === b.dataset.v) ? '' : b.dataset.v;
  syncChoices();
}));
function updateDetailUI() {
  const isScreen = SCREEN_RE.test($('#f-object').value);
  $('#inchesWrap').hidden = !isScreen;
  $('#worksWrap').hidden = !isScreen;
  $('#f-size').placeholder = SIZE_HINTS[$('#f-category').value] || 'Ej. talla, medidas, color, capacidad';
  syncChoices();
}
$('#f-object').addEventListener('input', () => {
  $('#f-category').value = SCREEN_RE.test($('#f-object').value) ? 'Electrónicos' : 'Otro';
  updateDetailUI();
});
$('#f-category').addEventListener('change', updateDetailUI);

function updateTotal() {
  const t = round2(getQty() * (parseFloat($('#f-unit').value) || 0));
  $('#f-total').textContent = fmtMoney(t);
  return t;
}
$('#f-unit').addEventListener('input', updateTotal);
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
  if (!ok) setHint('Escanea el código de barras del producto y pulsa "Usar este código". El código identifica el donativo; el nombre, la marca y los demás datos los capturas tú.');
}
const setHint = t => { $('#barcodeHint').textContent = t; $('#barcodeHint').classList.toggle('note', !!t); };

async function lookupProduct(code) {
  if (!/^\d{8,14}$/.test(code)) { setHint('Código guardado. Esta app no tiene base de datos de productos: describe abajo qué es, la marca, el modelo y las medidas.'); return; }
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
      setHint('Se encontró un nombre en Open Food Facts. Revísalo y completa la marca, el modelo y las medidas.');
      return;
    }
  } catch (e) { /* sin internet o sin resultado */ }
  setHint('Código guardado. Este producto no aparece en ninguna base de datos en línea, así que no se llena solo: describe abajo qué es, la marca, el modelo y las medidas.');
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
    $('#f-condition').value = prev.condition || '';
    $('#f-brand').value = prev.brand || '';
    $('#f-model').value = prev.model || '';
    $('#f-size').value = prev.size || '';
    $('#f-inches').value = prev.inches || '';
    $('#f-works').value = prev.works || '';
    updateDetailUI();
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
  formQty = 1;
  $('#coList').innerHTML = '';
  $('#f-unit').value = 0;
  $('#f-condition').value = '';
  $('#f-category').value = 'Otro';
  $('#f-works').value = '';
  setPhoto(null);
  updateDetailUI();
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
  $('#f-condition').value = d.condition || '';
  $('#f-brand').value = d.brand || '';
  $('#f-model').value = d.model || '';
  $('#f-size').value = d.size || '';
  $('#f-inches').value = d.inches || '';
  $('#f-works').value = d.works || '';
  formQty = d.qty || 1;
  $('#coList').innerHTML = '';
  (d.coDonors || []).forEach(addCoRow);
  $('#f-multiple').checked = (d.coDonors || []).length > 0;
  $('#f-unit').value = d.unit;
  $('#f-notes').value = d.notes || '';
  setPhoto(d.photo);
  updateDetailUI();
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
  const qty = getQty();
  const coDonors = multiple ? readCo() : [];
  const unit = parseFloat($('#f-unit').value) || 0;
  const barcode = $('#f-barcode').value.trim();
  const matricula = $('#f-matricula').value.trim().toUpperCase();
  const email = $('#f-email').value.trim();
  const group = $('#f-group').value.trim().toUpperCase();
  const condition = $('#f-condition').value;
  const inches = parseFloat($('#f-inches').value) || 0;
  const needInches = !$('#inchesWrap').hidden;
  const errors = [];
  if (!barcode) errors.push('Falta el código de barras del producto.');
  if (!donor) errors.push('Falta indicar quién donó.');
  if (!/^[A-Za-z0-9-]{5,15}$/.test(matricula)) errors.push('La matrícula debe tener entre 5 y 15 letras o números.');
  if (!group) errors.push('Falta el grupo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Escribe un correo institucional válido.');
  if (!object) errors.push('Falta indicar qué es el objeto donado.');
  else if (object.length < 3) errors.push('Describe mejor el objeto: escribe qué es exactamente.');
  if (needInches && !(inches > 0)) errors.push('Indica de cuántas pulgadas es.');
  if (!date) errors.push('Falta la fecha.');
  if (multiple && !coDonors.length) errors.push('En un donativo múltiple agrega al menos a otra persona.');
  coDonors.forEach((p, i) => {
    const n = 'Persona ' + (i + 2) + ': ';
    if (!p.name) errors.push(n + 'falta el nombre.');
    if (!/^[A-Za-z0-9-]{5,15}$/.test(p.matricula)) errors.push(n + 'la matrícula debe tener entre 5 y 15 letras o números.');
    if (!p.group) errors.push(n + 'falta el grupo.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.push(n + 'escribe un correo institucional válido.');
  });
  if (unit < 0) errors.push('El valor por unidad no puede ser negativo.');
  if (errors.length) return { errors };
  return {
    data: {
      barcode, donor, matricula, group, email, multiple, coDonors, object, date, qty, unit,
      total: round2(qty * unit),
      contact: $('#f-contact').value.trim(),
      category: $('#f-category').value,
      condition,
      brand: $('#f-brand').value.trim(),
      model: $('#f-model').value.trim(),
      size: $('#f-size').value.trim(),
      inches: needInches ? inches : 0,
      works: $('#worksWrap').hidden ? '' : $('#f-works').value,
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
      const hay = [d.barcode, d.code, d.brand, d.model, d.size, d.matricula, d.group, d.email, d.donor, d.object, d.notes, d.contact, d.category, ...(d.coDonors || []).flatMap(p => [p.name, p.matricula, p.group, p.email])].join(' ').toLowerCase();
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
function renderList() {
  const list = filtered();
  const total = list.reduce((s, d) => s + d.total, 0);
  $('#resultCount').textContent = `${list.length} de ${donations.length} donativos, ${fmtMoney(total)}`;
  $('#emptyMsg').hidden = list.length > 0;
  $('#emptyMsg').textContent = donations.length ? 'Ningún donativo coincide con los filtros. Prueba con otra búsqueda o limpia los filtros.' : 'Todavía no hay donativos. Registra el primero escaneando un código de barras.';
  $('#list').innerHTML = list.map((d, i) => {
    const color = PALETTE[i % PALETTE.length];
    const people = peopleOf(d);
    return `
    <li class="dcard ${color}" data-id="${esc(d.id)}">
      <div class="dc-top">${d.category && d.category !== 'Otro' ? `<span class="tag">${esc(d.category)}</span>` : ''}${d.condition ? `<span class="tag">${esc(d.condition)}</span>` : ''}${people > 1 ? `<span class="tag mult">${fmtNum(people)} donantes</span>` : ''}</div>
      <div class="dc-main">
        <div class="dc-thumb">${d.photo ? `<img data-act="photo" alt="Foto: ${esc(d.object)}" src="${d.photo}">` : 'Sin foto'}</div>
        <div class="dc-info">
          <h3>${esc(d.object)}</h3>
          <p>${esc(d.donor)}</p>
          <p class="dc-sub">${[d.brand, d.model].filter(Boolean).length ? `<span>${esc([d.brand, d.model].filter(Boolean).join(' '))}</span>` : ''}${d.inches ? `<span>${fmtNum(d.inches)} pulg.</span>` : ''}${d.matricula ? `<span>Mat. ${esc(d.matricula)}</span>` : ''}${d.group ? `<span>${esc(d.group)}</span>` : ''}</p>
        </div>
      </div>
      <div class="dc-code"><span>Barras ${esc(d.barcode)}</span><span>${esc(d.code)}</span><span>${esc(fmtDate(d.date))}</span></div>
      <div class="dc-foot">
        <div class="dc-amount"><b>${fmtMoney(d.total)}</b><small>${d.qty > 1 ? fmtNum(d.qty) + ' x ' + fmtMoney(d.unit) : 'Valor del producto'}</small></div>
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
  const co = d.coDonors || [];
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
      ${cell('Marca', d.brand)}
      ${cell('Modelo', d.model)}
      ${cell('Pulgadas', d.inches ? fmtNum(d.inches) : '')}
      ${cell('Tamaño o características', d.size, true)}
      ${cell('¿Funciona?', d.works)}
      ${cell('Donativo múltiple', co.length ? 'Sí, donaron ' + fmtNum(co.length + 1) + ' personas' : 'No')}
      ${d.qty > 1 ? cell('Cantidad', fmtNum(d.qty)) : ''}
      ${cell(d.qty > 1 ? 'Valor por unidad' : 'Valor del producto', fmtMoney(d.unit))}
      <div class="wide sheet-total"><dt>Valor total</dt><dd>${fmtMoney(d.total)}</dd></div>
      ${cell('Notas', d.notes, true)}
    </dl>
    ${co.length ? `<div class="sheet-people"><h4>Otras personas que donaron este producto</h4><table><thead><tr><th>Nombre</th><th>Matrícula</th><th>Grupo</th><th>Correo institucional</th></tr></thead><tbody>${co.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.matricula)}</td><td>${esc(p.group)}</td><td>${esc(p.email)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${d.photo ? `<figure><img alt="Foto del objeto donado" src="${d.photo}"><figcaption>Foto del objeto donado</figcaption></figure>` : ''}
    <div class="signs${co.length ? ' many' : ''}">${co.length ? [d.donor, ...co.map(p => p.name)].map(n => `<div>Firma: ${esc(n)}</div>`).join('') : '<div>Firma de quien dona</div>'}<div>Firma de quien recibe</div></div>
    <footer class="sheet-foot"><span>${esc(d.code)}</span><span>Impreso el ${esc(new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }))}</span></footer>
  </article>`;
}

function labelHTML(d) {
  return `<div class="label"><svg class="barcode" data-code="${esc(d.barcode)}" data-format="${barcodeFormat(d.barcode)}"></svg><b>${esc(d.object)}</b>${esc(d.donor)}${(d.coDonors || []).length ? ' y ' + fmtNum(d.coDonors.length) + ' más' : ''}${d.matricula ? ', ' + esc(d.matricula) : ''}<br>${esc(fmtDate(d.date))}, ${d.qty > 1 ? fmtNum(d.qty) + ' x ' + fmtMoney(d.unit) + ' = ' : ''}${fmtMoney(d.total)}</div>`;
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
  const rows = list.map(d => `<tr><td>${esc(d.barcode)}</td><td>${esc(d.code)}</td><td>${esc(fmtDate(d.date))}</td><td>${esc([d.donor, ...(d.coDonors || []).map(p => p.name)].join('; '))}</td><td>${esc([d.matricula, ...(d.coDonors || []).map(p => p.matricula)].filter(Boolean).join('; '))}</td><td>${esc([d.group, ...(d.coDonors || []).map(p => p.group)].filter(Boolean).join('; '))}</td><td>${esc(d.object)}</td><td>${esc(d.category)}</td><td class="r">${fmtNum(d.qty)}</td><td class="r">${fmtMoney(d.unit)}</td><td class="r">${fmtMoney(d.total)}</td></tr>`).join('');
  doPrint(`<div class="report"><h2>${esc(Settings.org)}</h2><p>Listado de donativos · ${list.length} registros · generado el ${esc(new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }))}</p>
    <table><thead><tr><th>Código de barras</th><th>Folio</th><th>Fecha</th><th>Donante</th><th>Matrícula</th><th>Grupo</th><th>Objeto</th><th>Categoría</th><th class="r">Cant.</th><th class="r">Valor u.</th><th class="r">Total</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><th colspan="10" class="r">Total</th><th class="r">${fmtMoney(total)}</th></tr></tfoot></table></div>`);
});

/* ============ Escáner de código de barras ============ */
let scanStream = null, scanTimer = null;
function stopScan() {
  scanSession++;
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

let scanSession = 0;
let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (!zxingPromise) zxingPromise = new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
    sc.onload = ok;
    sc.onerror = () => { zxingPromise = null; sc.remove(); fail(new Error('zxing')); };
    document.head.appendChild(sc);
  });
  return zxingPromise;
}
// Chrome/Android usan BarcodeDetector; iPhone (Safari) usa la librería ZXing
async function makeDetector() {
  if ('BarcodeDetector' in window) {
    let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
    try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (e) { /* usar lista completa */ }
    const det = new BarcodeDetector({ formats });
    return async video => { const f = await det.detect(video); return f.length ? f[0].rawValue : null; };
  }
  await loadZXing();
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async video => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const k = Math.min(1, 900 / vw);
    canvas.width = Math.round(vw * k); canvas.height = Math.round(vh * k);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decode(bmp).getText();
    } catch (e) { return null; }
  };
}

async function openScanner(onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador no permite usar la cámara. Escribe el código o usa un lector de código de barras.');
    return;
  }
  const id = ++scanSession;
  $('#scanModal').hidden = false;
  $('#scanMsg').textContent = 'Preparando la cámara...';
  let detect;
  try { detect = await makeDetector(); } catch (e) {
    if (scanSession === id) { stopScan(); toast('No se pudo cargar el lector. Revisa tu internet o escribe el código.'); }
    return;
  }
  if (scanSession !== id) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (err) {
    if (scanSession === id) {
      stopScan();
      toast(err && err.name === 'NotAllowedError' ? 'La cámara está bloqueada. En iPhone: Ajustes > Safari > Cámara > Permitir.' : 'No se pudo abrir la cámara.');
    }
    return;
  }
  if (scanSession !== id) { stream.getTracks().forEach(t => t.stop()); return; }
  scanStream = stream;
  const video = $('#scanVideo');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* se reintenta al detectar */ }
  $('#scanMsg').textContent = 'Apunta la cámara al código de barras del producto.';
  const tick = async () => {
    if (scanSession !== id || !scanStream) return;
    try {
      const raw = await detect(video);
      if (raw) {
        if (onCode(raw) !== false) { stopScan(); return; }
        $('#scanMsg').textContent = 'Código leído (' + raw + ') pero no está registrado aquí.';
      }
    } catch (e) { /* seguir intentando */ }
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}

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
  const donors = new Set(donations.flatMap(d => [d.donor, ...(d.coDonors || []).map(p => p.name)]).map(n => String(n).trim().toLowerCase())).size;
  $('#stats').innerHTML = [
    ['Donativos registrados', fmtNum(donations.length)],
    ['Piezas o unidades', fmtNum(pieces)],
    ['Valor total', fmtMoney(total)],
    ['Donantes distintos', fmtNum(donors)]
  ].map(([l, v]) => `<div class="stat"><small>${l}</small><b>${v}</b></div>`).join('');

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
  const head = ['Código de barras', 'Folio', 'Fecha', 'Donante', 'Matrícula', 'Grupo', 'Correo institucional', 'Donativo múltiple', 'Otros donantes', 'Teléfono', 'Objeto', 'Marca', 'Modelo', 'Pulgadas', 'Tamaño o características', '¿Funciona?', 'Categoría', 'Estado', 'Cantidad', 'Valor unitario', 'Total', 'Notas'];
  const rows = [...donations].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0))
    .map(d => [d.barcode, d.code, d.date, d.donor, d.matricula, d.group, d.email, (d.coDonors || []).length ? 'Sí' : 'No', (d.coDonors || []).map(p => `${p.name} (${p.matricula}, ${p.group}, ${p.email})`).join(' | '), d.contact, d.object, d.brand, d.model, d.inches || '', d.size, d.works, d.category, d.condition, d.qty, d.unit, d.total, d.notes].map(csvCell).join(','));
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
    multiple: Array.isArray(d.coDonors) && d.coDonors.length > 0,
    coDonors: (Array.isArray(d.coDonors) ? d.coDonors : []).slice(0, 20).map(p => ({ name: String(p && p.name || '').slice(0, 120), matricula: String(p && p.matricula || '').slice(0, 20), group: String(p && p.group || '').slice(0, 30), email: String(p && p.email || '').slice(0, 120) })).filter(p => p.name),
    contact: String(d.contact || '').slice(0, 120),
    date: String(d.date).slice(0, 10),
    object: String(d.object).slice(0, 160),
    category: CATEGORIES.includes(d.category) ? d.category : 'Otro',
    condition: String(d.condition || '').slice(0, 40),
    brand: String(d.brand || '').slice(0, 60),
    model: String(d.model || '').slice(0, 60),
    size: String(d.size || '').slice(0, 120),
    inches: Math.max(0, Number(d.inches) || 0),
    works: ['Sí', 'No', 'No sé'].includes(d.works) ? d.works : '',
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
