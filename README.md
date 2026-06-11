# Facturacion Automatica

Aplicacion local para gestionar clientes, emitir facturas y generar documentos Word mensuales. La hice como un proyecto pequeño de automatizacion para simplificar una facturacion sencilla: datos de cliente, numeracion anual, calculo de IVA, generacion de documentos y copias de seguridad locales.

Funciona como una app web local: se abre en el navegador, pero los datos se guardan en el propio equipo mediante SQLite.

> Proyecto personal creado para ayudar a una profesional autonoma a simplificar la emision de facturas, la generacion de documentos y la organizacion de datos desde una aplicacion local sencilla.

## Funcionalidades

- Gestion de clientes.
- Creacion de facturas con subtotal, IVA y total calculados.
- Numeracion anual automatica.
- Formas de pago: efectivo, transferencia y Bizum.
- Generacion de factura individual en Word.
- Word mensual consolidado.
- Dashboard con ingresos y facturas por mes.
- Cliente con mayor facturacion.
- Papelera para clientes y facturas.
- Exportacion CSV de clientes y facturas.
- Importacion CSV de clientes.
- Importacion de configuracion desde JSON.
- Copias de seguridad automaticas al arrancar.

## Tecnologias

<img src="https://skillicons.dev/icons?i=py,html,css,js,sqlite&perline=5" alt="Stack">

## Requisitos

- Windows.
- Python 3.10 o superior para ejecutar la app desde codigo fuente.
- Microsoft Word o un editor compatible con `.docx` para abrir las facturas generadas.
- LibreOffice es opcional; solo se usa si se quiere generar PDF automaticamente.

## Arranque local

Doble clic en:

```text
Facturacion.cmd
```

O desde PowerShell:

```powershell
.\start_facturacion.ps1
```

La app se abre en:

```text
http://127.0.0.1:8765
```

## Datos locales

La aplicacion crea estas carpetas al usarse:

- `data/`: base de datos SQLite.
- `generated/`: facturas individuales generadas.
- `facturas/`: documentos Word mensuales.
- `backups/`: copias automaticas de la base de datos.

Estas carpetas estan preparadas para existir en el repositorio con `.gitkeep`, pero su contenido real queda ignorado por Git.

## Configuracion

Los datos del emisor se configuran desde `Ajustes`. Tambien se puede importar un perfil JSON desde la seccion `Importar configuracion`.

Ejemplo de estructura:

```json
{
  "app": "Facturacion",
  "type": "settings",
  "settings": {
    "issuer_name": "NOMBRE DEL EMISOR",
    "issuer_tax_id": "DNI/NIF",
    "issuer_address": "DIRECCION DEL EMISOR",
    "issuer_postal_city": "CP, CIUDAD",
    "invoice_series": "{year}-",
    "invoice_next_number": "1",
    "default_concept": "1 SERVICIO",
    "default_unit_price": "0",
    "default_vat_rate": "21"
  }
}
```

## Instalador

El instalador se genera con:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\build_installer.ps1
```

El resultado queda en `dist/Facturacion-Setup.exe`. La carpeta `dist/` no se versiona.

## Privacidad

El repositorio no incluye datos reales ni debe contener:

- Bases de datos `.db`.
- Facturas generadas.
- Backups.
- Instaladores compilados.
- Excels o exports reales.
- Perfiles JSON con datos privados.
