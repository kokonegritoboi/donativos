# Registro de donativos

Página web para llevar el control de donativos desde el celular o la computadora. Funciona sin servidor: todo se guarda en el navegador del dispositivo.

## Qué hace

- Registra quién donó (nombre, matrícula, grupo, correo institucional y teléfono opcional), la fecha, qué objeto donó, cantidad, valor por unidad y valor total (cantidad × valor).
- Describe el objeto con detalle: qué es, marca, modelo, tamaño o características y, si es una pantalla, las pulgadas y si funciona.
- Donativo múltiple: un interruptor indica si fueron varias piezas y pide cuántas fueron (mínimo 2); la cantidad se multiplica por el valor por unidad.
- Adjunta una foto del objeto donado (cámara o galería).
- Escáner con cámara: en Chrome/Android usa el detector del navegador; en iPhone (Safari) carga la librería ZXing desde internet (jsDelivr) la primera vez y requiere permitir la cámara en Ajustes > Safari > Cámara.
- Para registrar un donativo primero se escanea (cámara o lector USB) o se escribe el código de barras que trae el producto (EAN-13, UPC, EAN-8 u otro). Ese código es el que sale impreso en la hoja y la etiqueta. Si el producto ya se registró antes, se copian nombre, categoría y valor; si no, intenta buscar el nombre en Open Food Facts.
- Cada registro también recibe un folio interno (DON-000001, DON-000002, ...).
- Genera la hoja de donativo lista para imprimir (con foto, código de barras y espacio para firmas), una etiqueta con código de barras y un listado imprimible.
- Busca y filtra por folio, donante, matrícula, grupo, objeto, categoría y fechas. Encuentra un donativo escaneando el código del producto con la cámara (Android, iPhone y computadora) o con un lector USB.
- Resumen por categoría, donante, grupo y mes.
- Respaldo en JSON, exportación a Excel (CSV) e importación de respaldos.
- Se puede instalar en el celular como app y abre sin internet.

## Importante

Los datos viven en cada navegador y dispositivo; no hay base de datos compartida. Descarga un respaldo desde la pestaña Datos de forma periódica y úsalo para pasar la información a otro equipo.

## Archivos

- `index.html`, `styles.css`, `app.js`: la aplicación.
- `vendor/jsbarcode.min.js`: librería JsBarcode (licencia MIT) para el código de barras.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: instalación como app y uso sin internet.
