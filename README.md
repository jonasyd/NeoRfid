# Chafon Stock App

Expo + React Native + TypeScript + Kotlin/Expo Module para CHAFON H103.

## Estado actual

- Login con `Authorization: Basic base64(usuario:password)`.
- Token Bearer almacenado en SecureStore.
- Renovación preventiva configurable, por defecto 15 minutos.
- Consulta de depósitos después del login.
- Selección de depósito.
- Home.
- Bottom navigation: Stock, Inventario, Pedidos, Configuración.
- Consulta de stock con búsqueda incremental y debounce.
- Modelo de respuesta con foto Base64 y SKUs.
- Módulo nativo CHAFON H103 con el `cf-sdk-v1.0.3.aar` incluido.
- Escaneo BLE y conexión configurables desde Configuración.
- Inventory RFID básico preparado; la lectura barcode/EPC se implementará sobre esta capa.

## Instalación

```bash
npm install
cp .env.example .env
npx expo prebuild --clean
```

Para desarrollo con código nativo se necesita un Development Build, no Expo Go:

```bash
eas build --platform android --profile development
```

Después:

```bash
npx expo start --dev-client
```

## Variables de entorno

Ver `.env.example`. Los paths son deliberadamente configurables porque todavía no se definieron las URLs reales de la API.

## Importante sobre CHAFON H103

El AAR suministrado expone `CfSdk`, `BleCore`, `CmdBuilder` y `CmdHandler`. El SDK no expone en las clases inspeccionadas UUIDs de servicio/característica, por lo que el módulo permite configurarlos desde la app.

Antes de probar inventory real hay que confirmar los UUID BLE del H103 y los parámetros de `buildInventoryISOContinueCmd` que usa vuestro firmware.

## Build

Preview genera APK instalable. Production genera AAB.


## EPC / RFID detection

The stock result exposes three detection actions: model, color and size. The app builds an EPC using the current `brandPrefix` plus the RFID model/color/size identifiers and applies an H103 select mask before starting inventory.

**Important:** the current encoder assumes the RFID identifiers are numeric decimal values. If production values are alphanumeric (the sample contract uses placeholders such as `RFID-100`), confirm the exact business encoding before production; the encoder is isolated in `src/services/epc.ts`.


### Search contract
`POST /v1/mobile/search` now supports exactly one of `{ sku }` or `{ query }`. Description search starts at 3 characters with a 350 ms debounce. Barcode/HID input submits the SKU and calls the same endpoint with `{ sku }`.

### RFID detection
Each stock row has three actions: **Modelo**, **Color** and **Talle**. The native H103 module applies an EPC select mask and starts inventory. The model action uses `brandPrefix + modelrfid`; color appends `modelcolrfid`; size appends `modelsizfid`.


## V4 — imagen de stock

La respuesta de `/v1/mobile/stock` soporta ahora `image` como Base64. La pantalla de stock muestra una única miniatura por resultado y conserva los tres botones de detección RFID (Modelo, Color y Talle). Si `image` ya viene como `data:image/...;base64,...`, se respeta el MIME; si viene como Base64 puro, se utiliza JPEG como fallback.
