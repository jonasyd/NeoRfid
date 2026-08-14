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


## Solución de Problemas de Depuración (Troubleshooting DevTools)

Si al iniciar el servidor de desarrollo e intentar abrir las herramientas de depuración (**React Native DevTools** / **Hermes Debugger**) encuentras la siguiente advertencia:
```
WARN  No compatible apps connected. React Native DevTools can only be used with the Hermes engine.
```

Esto ocurre porque el servidor Metro no puede establecer una conexión WebSocket de depuración con el motor Hermes en tu dispositivo físico (`Positivo_Smart_NFC`). Sigue estos pasos para solucionarlo:

### 1. Reenvío de Puertos (Port Forwarding con ADB)
Para que el motor de depuración local se comunique con el dispositivo físico a través de USB, debes activar el reenvío de puertos de ADB. Ejecuta el siguiente comando en tu terminal (con el dispositivo conectado por USB y la depuración USB activada):
```bash
adb reverse tcp:8081 tcp:8081
```
*Nota: Si estás usando depuración por Wi-Fi, asegúrate de que ambos dispositivos (tu PC y tu teléfono) estén exactamente en la misma subred de Wi-Fi y de que no haya un cortafuegos (firewall) bloqueando el puerto `8081`.*

### 2. Esperar a que la Aplicación cargue Completamente
Metro intenta abrir las DevTools automáticamente al iniciar o inmediatamente después del empaquetado (`Android Bundled`). Si las DevTools se abren antes de que la aplicación haya terminado de inicializarse en el dispositivo físico, Metro no detectará ninguna aplicación compatible conectada.
- Espera a que la app cargue por completo en la pantalla de inicio del dispositivo.
- Si ves el aviso, puedes presionar la tecla `j` en la consola de Metro para intentar reabrir las herramientas de depuración una vez que la aplicación esté completamente activa y conectada.

### 3. Asegurar que Hermes esté habilitado de forma Explícita
Hemos configurado de forma explícita `"jsEngine": "hermes"` dentro del archivo `app.json`. Si has realizado cambios de configuración nativa en el motor JS, es indispensable realizar un nuevo prebuild y compilación limpia del APK para asegurar que el motor Hermes se empaquete correctamente:
```bash
npx expo prebuild --clean
# O compilar localmente con Gradle o EAS Build para actualizar tu APK en el dispositivo
```

### 4. Desactivar el uso de `--tunnel` para Depuración Activa
Si inicias el servidor con la bandera `--tunnel` (por ejemplo, `npx expo start --tunnel`), las conexiones WebSocket de depuración de React Native DevTools no se admiten sobre el túnel proxy de Ngrok de Expo. Utiliza la conexión por red local (LAN) o USB para depurar de forma interactiva.
