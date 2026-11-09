# Registro de donativos

Página web para llevar el control de donativos desde el celular o la computadora. Funciona sin servidor: todo se guarda en el navegador del dispositivo.

## Qué hace

- Registra quién donó, la fecha, qué objeto donó, cantidad, valor por unidad y valor total (cantidad × valor).
- Adjunta una foto del objeto donado (cámara o galería).
- Genera un folio único por donativo (DON-000001, DON-000002, ...) con código de barras Code 128.
- Genera la hoja de donativo lista para imprimir (con foto, código de barras y espacio para firmas), una etiqueta con código de barras y un listado imprimible.
- Busca y filtra por folio, donante, objeto, categoría y fechas. Escanea el código de barras con la cámara (Chrome en Android) o con un lector USB.
- Resumen por categoría, donante y mes.
- Respaldo en JSON, exportación a Excel (CSV) e importación de respaldos.
- Se puede instalar en el celular como app y abre sin internet.

## Importante

Los datos viven en cada navegador y dispositivo; no hay base de datos compartida. Descarga un respaldo desde la pestaña Datos de forma periódica y úsalo para pasar la información a otro equipo.

## Archivos

- `index.html`, `styles.css`, `app.js`: la aplicación.
- `vendor/jsbarcode.min.js`: librería JsBarcode (licencia MIT) para el código de barras.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: instalación como app y uso sin internet.
