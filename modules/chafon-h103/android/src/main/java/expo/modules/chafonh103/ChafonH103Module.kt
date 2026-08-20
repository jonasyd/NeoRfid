package expo.modules.chafonh103

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.cf.ble.BleUtil
import com.cf.ble.interfaces.IBleDisConnectCallback
import com.cf.ble.interfaces.IBtScanCallback
import com.cf.ble.interfaces.IConnectDoneCallback
import com.cf.ble.interfaces.IOnNotifyCallback
import com.cf.beans.AllParamBean
import com.cf.beans.BatteryCapacityBean
import com.cf.beans.CmdData
import com.cf.beans.KeyStateBean
import com.cf.beans.OutputModeBean
import com.cf.beans.TagInfoBean
import com.cf.zsdk.BleCore
import com.cf.zsdk.CfSdk
import com.cf.zsdk.cmd.CmdBuilder
import com.cf.zsdk.cmd.CmdHandler
import java.util.UUID

class ChafonH103Module : Module() {
  companion object {
    private const val LOG_TAG = "ChafonH103"

    // Codigos STATUS del protocolo (apendice A del manual del lector).
    private const val CMD_INVENTORY = 0x0001
    private const val CMD_READMODE = 0x008E
    private const val READ_MODE_RFID: Byte = 0x00
    private const val READ_MODE_BARCODE: Byte = 0x01
    private const val STATUS_PARAM_ERROR = 0x01     // parametro fuera de rango o no soportado
    private const val STATUS_MODULE_ERROR = 0x02    // fallo interno del modulo (fijar frecuencia/potencia)
    private const val STATUS_INVENTORY_DONE = 0x12  // el barrido termino
    private const val STATUS_NO_TAGS = 0x13         // no se encontro ningun tag

    // El equipo puede repetir la MISMA respuesta decenas de veces: se midieron 125 respuestas
    // identicas a un unico SET_PWR. Colapsamos las repetidas dentro de esta ventana.
    private const val FRAME_DEDUPE_MS = 400L

    // NO usar RFM_SETISO_SELECTMASK como filtro de inventario.
    //
    // El manual es explicito: "This command is used to set the tag EPC number required for tag
    // OPERATION (read, write, lock and deactivate)". Es la precondicion para operar sobre un tag
    // puntual, no un filtro de busqueda; la app del fabricante solo la usa en su pantalla de
    // operaciones sobre tags y jamas en el inventario.
    //
    // Peor todavia: la seleccion QUEDA GUARDADA EN EL EQUIPO. Al usarla como filtro, el lector
    // dejaba de reportar tags y el estado sobrevivia al cierre de la app: la propia app del
    // fabricante tampoco podia leer hasta hacerle un "restore" de fabrica al equipo.
    //
    // El filtrado por prefijo se hace en la app (ver detectionMaskEpc en sendTag), que siempre
    // funciono y no deja rastro en el equipo.
    private const val USE_HARDWARE_SELECT_MASK = false
    // Descubrir servicios + negociar MTU puede tardar bastante en equipos lentos; damos margen
    // amplio antes de dar por colgada la conexión (el equipo real cortaba solo a los ~30s).
    private const val CONNECT_WATCHDOG_MS = 20_000L
    // Rango del H103 según el manual del protocolo (RFM_SET_PWR): [1, 33] dBm.
    // (La ficha comercial indica 4-33; el manual es más permisivo, usamos el del protocolo.)
    const val POWER_MIN = 1
    const val POWER_MAX = 33
  }

  private var bleCore: BleCore? = null
  private val devices = mutableMapOf<String, BluetoothDevice>()
  private var serviceUuid: UUID? = null
  private var notifyUuid: UUID? = null
  private var writeUuid: UUID? = null
  private var inventoryRunning = false
  @Volatile private var lastFrameHex: String? = null
  @Volatile private var lastFrameAtMs = 0L
  @Volatile private var duplicateFrameCount = 0
  // Última potencia efectivamente enviada al equipo, para no repetir el comando al pedo.
  @Volatile private var lastPowerSent: Int? = null
  // Modo de lectura REAL del equipo en esta conexion (0x00 RFID, 0x01 codigo de barras).
  // El equipo guarda el modo de forma persistente y lo conserva entre apps y entre reinicios,
  // asi que no alcanza con lo que la UI crea recordar: hay que forzarlo y llevar la cuenta aca.
  @Volatile private var currentReadMode: Byte? = null
  private var soundEnabled = true
  private var detectionMaskEpc: String? = null
  private var scanResultCount = 0

  // BLE listo = GATT conectado + servicios descubiertos + MTU negociado + notify habilitado.
  // Hasta que esto sea true, BleCore.writeData() devuelve false SIEMPRE, porque internamente
  // hace mGatt.getService(uuid) y el servicio todavía no existe (ver bytecode de writeData:
  // devuelve false si mGatt==null, si getService()==null o si getCharacteristic()==null).
  // Esta es la causa de "No se pudo cambiar el modo de lectura / establecer potencia / etc":
  // no era el comando, era que se escribía antes de que el pipeline GATT terminara.
  @Volatile private var bleReady = false

  // Evita conexiones GATT superpuestas (ver comentario en connect()). Se libera cuando la
  // conexión queda lista, cuando falla, o por watchdog si el SDK nunca responde.
  private val connectInProgress = java.util.concurrent.atomic.AtomicBoolean(false)

  // Generación de conexión: cada connect() la incrementa. El watchdog solo actúa si sigue
  // siendo el intento vigente; sin esto, el watchdog de un intento viejo cerraba el GATT de
  // un intento nuevo 25s después (se veía en el log matando la conexión siguiente).
  private val connectGeneration = java.util.concurrent.atomic.AtomicInteger(0)

  // Guardamos el BluetoothGatt que devuelve connectDevice() para poder re-disparar nosotros
  // el descubrimiento de servicios desde el main thread (ver kickDiscovery()).
  @Volatile private var currentGatt: android.bluetooth.BluetoothGatt? = null

  // El arranque post-conexión debe correr UNA sola vez por conexión, venga por donde venga:
  // puede dispararlo onConnectDone del SDK o nuestro propio monitor de servicios.
  private val setupDone = java.util.concurrent.atomic.AtomicBoolean(false)

  // Bloque completo de parámetros del H103 (potencia, buzzer, Q/session, etc). El SDK no permite
  // cambiar un solo campo: hay que traer este bloque entero (getAllParam) y reescribirlo entero
  // (buildSetAllParamCmd) con el campo modificado.
  @Volatile private var latestAllParam: AllParamBean? = null

  private val notifyCallback = object : IOnNotifyCallback {
    // Trama cruda: el SDK solo nos entrega beans para algunos comandos, así que el STATUS de
    // respuestas como SET_PWR (0x53) o SET_ALL_PARAM (0x71) no llega por onNotify(int, CmdData).
    // Loguearlas acá permite ver si el equipo aceptó o rechazó cada comando.
    override fun onNotify(bytes: ByteArray?) {
      if (bytes == null || bytes.size < 6) return
      val cmd = ((bytes[2].toInt() and 0xFF) shl 8) or (bytes[3].toInt() and 0xFF)
      val len = bytes[4].toInt() and 0xFF
      val status = bytes[5].toInt() and 0xFF
      val signature = bytes.toHex()
      val now = System.currentTimeMillis()

      // Colapsamos las repeticiones identicas: el equipo llego a contestar 125 veces la misma
      // trama a un solo comando, lo que tapaba el resto del log.
      if (signature == lastFrameHex && now - lastFrameAtMs < FRAME_DEDUPE_MS) {
        duplicateFrameCount++
        lastFrameAtMs = now
        return
      }
      if (duplicateFrameCount > 0) {
        android.util.Log.d(LOG_TAG, "(se omitieron $duplicateFrameCount repeticiones de $lastFrameHex)")
        duplicateFrameCount = 0
      }
      lastFrameHex = signature
      lastFrameAtMs = now
      android.util.Log.d(LOG_TAG, "respuesta cruda cmd=0x%04X len=%d status=0x%02X : %s".format(cmd, len, status, signature))

      // STATUS 0x02 es el estado en el que el modulo RFID del lector queda trabado: el Bluetooth
      // sigue contestando, pero la radio no lee ningun tag y el equipo deja de devolver sus
      // parametros. Sin avisarlo, la app se ve "conectada y buscando" con 0 lecturas para
      // siempre, y el problema parece de la app cuando en realidad es del equipo.
      if (status == STATUS_MODULE_ERROR || status == STATUS_PARAM_ERROR) {
        val message = if (status == STATUS_MODULE_ERROR) {
          // 0x02 durante un barrido suele ser potencia demasiado alta para lo que el equipo
          // tolera: se midio a este lector fallar a 33 dBm y leer sin problemas a 2 dBm.
          if (cmd == CMD_INVENTORY)
            "El modulo RFID fallo al ejecutar el barrido. Suele ser potencia de antena demasiado alta: proba bajarla."
          else
            "El modulo RFID del lector esta en falla y no ejecuta comandos. Proba bajar la potencia de antena."
        } else {
          "El lector rechazo un parametro del comando."
        }
        android.util.Log.w(LOG_TAG, "falla del equipo en cmd=0x%04X: $message".format(cmd))
        sendEvent("onModuleFault", mapOf(
          "command" to "0x%04X".format(cmd),
          "status" to status,
          "message" to message
        ))
      }

      // Respuesta de RFM_SET_GET_READMODE en modo lectura: CF 00 00 8E 09 STATUS READMODE ...
      // El SDK no la convierte en bean, asi que la interpretamos aca para saber en que modo esta
      // realmente el equipo sin tener que escribirselo.
      if (cmd == CMD_READMODE && len >= 2 && status == 0x00 && bytes.size > 6) {
        val reported = bytes[6]
        currentReadMode = reported
        android.util.Log.d(LOG_TAG, "modo de lectura del equipo = ${if (reported == READ_MODE_BARCODE) "barcode" else "rfid"}")
        sendEvent("onReadMode", mapOf("mode" to if (reported == READ_MODE_BARCODE) "barcode" else "rfid"))
      }

      // Respuestas de inventario sin datos de tag. Distinguen "el lector no esta buscando" de
      // "el lector barrio y no habia nada", que en la UI se veian igual: Lecturas 0.
      if (cmd == CMD_INVENTORY && len == 1) {
        sendEvent("onInventoryOutcome", mapOf(
          "status" to status,
          "completed" to (status == STATUS_INVENTORY_DONE),
          "noTags" to (status == STATUS_NO_TAGS)
        ))
      }
    }

    override fun onNotify(type: Int, data: CmdData) {
      when (val value = data.data) {
        is TagInfoBean -> sendTag(value)
        is BatteryCapacityBean -> {
          val level = value.mBatteryCapacity.toInt() and 0xFF
          android.util.Log.d(LOG_TAG, "onNotify batería level=$level")
          sendEvent("onBatteryLevel", mapOf("level" to level))
        }
        is OutputModeBean -> {
          // MODE 0x00 = HID (el equipo tipea como teclado Bluetooth), 0x01 = transparente
          // (los datos llegan por este canal BLE, que es lo que necesita la app).
          val mode = value.mMode.toInt() and 0xFF
          android.util.Log.d(LOG_TAG, "onNotify OutputMode mode=$mode (0=HID, 1=transparente)")
          sendEvent("onOutputMode", mapOf("mode" to mode, "transparent" to (mode == 0x01)))
          // NO lo corregimos. Solo lo informamos.
          //
          // Contra lo que sugiere el manual (0x00 "HID output", 0x01 "transparent"), este equipo
          // reporta los tags por BLE estando en 0x00. Se comprobo: tras un restore de fabrica el
          // equipo queda en 0x00, y en ese estado la app del fabricante leyo 14 tags sin siquiera
          // consultar el modo de salida. Cuando nosotros lo pasabamos a 0x01, el inventario
          // seguia contestando "comando ejecutado" pero no llegaba ni una trama de tag.
          // El modo de salida se cambia solo si la persona lo pide (setTransparentMode).
        }
        is KeyStateBean -> {
          val st = value.mKeyState.toInt() and 0xFF
          android.util.Log.d(LOG_TAG, "onNotify KeyState=$st (1=start, 2=end)")
          sendEvent("onKeyState", mapOf("state" to if (st == 0x01) "start" else "end"))
        }
        is AllParamBean -> {
          // El SDK arma un AllParamBean tambien para las respuestas de ERROR, con el STATUS
          // puesto y el resto de los campos vacios. Aceptarlo hacia que la UI mostrara
          // parametros inventados: informaba una potencia como confirmada por el equipo cuando
          // la respuesta real era "error interno del modulo".
          if (value.mStatus != 0) {
            android.util.Log.w(LOG_TAG, "AllParam descartado: status=0x%02X".format(value.mStatus))
          } else {
            latestAllParam = value
            val pwr = value.mRfidPower.toInt() and 0xFF
            android.util.Log.d(LOG_TAG, "onNotify AllParam power=$pwr")
            if (pwr == 0) {
              // Antena apagada: el inventario corre, termina al instante y no ve ningun tag.
              android.util.Log.w(LOG_TAG, "el equipo reporta potencia 0 dBm: la antena esta apagada")
            }
            sendEvent("onAllParamLoaded", mapOf(
              "power" to pwr,
              "buzzerEnabled" to ((value.mBuzzerTime.toInt() and 0xFF) != 0),
              "workMode" to (value.mWorkMode.toInt() and 0xFF)
            ))
          }
        }
        else -> {}
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ChafonH103")
    Events("onDeviceFound", "onTagRead", "onConnectionState", "onScanError", "onBatteryLevel", "onAllParamLoaded", "onOutputMode", "onKeyState", "onModuleFault", "onInventoryOutcome", "onReadMode")

    Function("isSupported") {
      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      manager?.adapter != null
    }

    Function("isEnabled") {
      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      manager?.adapter?.isEnabled == true
    }

    // El permiso de Ubicación de la app es distinto del switch de Ubicación (GPS) del sistema.
    // Con el permiso concedido pero el switch apagado, Android descarta los resultados del
    // escaneo BLE en silencio (sin lanzar ningún error), lo que se ve como "no detecta nada".
    Function("isLocationEnabled") {
      val context = appContext.reactContext
      if (context == null) {
        true
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val lm = context.getSystemService(android.content.Context.LOCATION_SERVICE) as? android.location.LocationManager
        lm?.isLocationEnabled == true
      } else {
        try {
          val mode = android.provider.Settings.Secure.getInt(
            context.contentResolver,
            android.provider.Settings.Secure.LOCATION_MODE,
            android.provider.Settings.Secure.LOCATION_MODE_OFF
          )
          mode != android.provider.Settings.Secure.LOCATION_MODE_OFF
        } catch (_: Exception) {
          true
        }
      }
    }

    AsyncFunction("requestPermissions") {
      requestBluetoothPermissions()
    }

    AsyncFunction("initialize") {
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android no disponible")
      android.util.Log.d(LOG_TAG, "initialize() llamado. bleCore ya creado=${bleCore != null}")
      CfSdk.load()
      if (bleCore == null) {
        bleCore = CfSdk.get(BleCore::class.java)
        android.util.Log.d(LOG_TAG, "CfSdk.get(BleCore) devolvió=${bleCore != null}")
        bleCore?.init(context)
        bleCore?.setIBleDisConnectCallback(object : IBleDisConnectCallback {
          override fun onBleDisconnect() {
            android.util.Log.d(LOG_TAG, "onBleDisconnect")
            inventoryRunning = false
            bleReady = false
            connectInProgress.set(false)
            currentGatt = null
            sendEvent("onConnectionState", mapOf("state" to "disconnected"))
          }
        })
        bleCore?.setOnNotifyCallback(notifyCallback)
      }
    }

    AsyncFunction("configureCharacteristics") { service: String, notify: String, write: String ->
      serviceUuid = UUID.fromString(service)
      notifyUuid = UUID.fromString(notify)
      writeUuid = UUID.fromString(write)
      Unit
    }

    AsyncFunction("scan") { timeoutMs: Int ->
      ensureInitialized()
      devices.clear()
      scanResultCount = 0

      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      val adapter = manager?.adapter
      android.util.Log.d(LOG_TAG, "scan() llamado. bleCore=${bleCore != null} adapter=${adapter != null} btEnabled=${adapter?.isEnabled} bleScannerDisponible=${adapter?.bluetoothLeScanner != null}")

      // 1. Emitir primero los dispositivos ya vinculados/emparejados en el sistema Bluetooth
      emitBondedDevices()

      // 2. Escaneo vía Chafon BleCore SDK
      try {
        android.util.Log.d(LOG_TAG, "Llamando bleCore.startScan()...")
        bleCore?.startScan(object : IBtScanCallback {
          override fun onBtScanResult(result: android.bluetooth.le.ScanResult) {
            scanResultCount++
            val d = result.device
            val nm = try { d?.name } catch (_: SecurityException) { "<sin permiso>" }
            android.util.Log.d(LOG_TAG, "onBtScanResult #$scanResultCount name=$nm address=${d?.address} rssi=${result.rssi}")
            handleScanResult(result)
          }

          override fun onBtScanFail(errorCode: Int) {
            android.util.Log.e(LOG_TAG, "onBtScanFail errorCode=$errorCode (1=ALREADY_STARTED,2=APP_REGISTRATION_FAILED,3=INTERNAL_ERROR,4=FEATURE_UNSUPPORTED,5=OUT_OF_HARDWARE_RESOURCES,6=SCANNING_TOO_FREQUENTLY)")
            sendEvent("onScanError", mapOf("errorCode" to errorCode, "message" to "Chafon SDK scan failed: $errorCode"))
          }
        })
        android.util.Log.d(LOG_TAG, "bleCore.startScan() retornó sin excepción")
      } catch (e: Exception) {
        android.util.Log.e(LOG_TAG, "Excepción al iniciar escaneo Chafon SDK", e)
        sendEvent("onScanError", mapOf("message" to (e.message ?: "Error al iniciar escaneo Chafon SDK")))
      }

      // Nota: NO registramos un segundo BluetoothLeScanner.startScan() propio en paralelo.
      // BleCore.startScan() ya invoca adapter.getBluetoothLeScanner().startScan() internamente;
      // registrar una segunda sesión de scan sobre el mismo adaptador (con otro callback) puede
      // devolver SCAN_FAILED_ALREADY_STARTED o interferir con el scan del SDK en ciertos stacks BLE,
      // impidiendo detectar la terminal aunque esté anunciándose correctamente.

      if (timeoutMs > 0) {
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          stopScanInternal()
        }, timeoutMs.toLong())
      }
      Unit
    }

    Function("stopScan") {
      stopScanInternal()
    }

    AsyncFunction("connect") { address: String ->
      ensureInitialized()
      val device = devices[address] ?: findBondedDevice(address) ?: throw IllegalArgumentException("Dispositivo no encontrado: $address")

      // Si ya hay una conexión SANA con este mismo equipo, no la tocamos. Sin esta guarda, un
      // reintento tardío (de una cadena de reconexión vieja) hacía disconnectedDevice() sobre
      // una conexión que estaba funcionando y la tiraba abajo, entrando en un bucle donde la
      // app se desconectaba sola una y otra vez.
      val alreadyHealthy = if (bleReady && bleCore?.isConnect == true) {
        val current = try { bleCore?.getConnectedDevice()?.address } catch (_: Exception) { null }
        current != null && current.equals(address, ignoreCase = true)
      } else false

      if (alreadyHealthy) {
        android.util.Log.d(LOG_TAG, "connect($address): ya conectado y listo; no se reconecta")
        sendEvent("onConnectionState", mapOf("state" to "connected"))
      } else {
      // Un solo intento de conexión a la vez: sin esto quedaban VARIOS clientes GATT abiertos
      // contra el mismo equipo (se veían 3 threads distintos disparando onConnectionStateChange)
      // y con la conexión duplicada el descubrimiento de servicios no termina nunca.
      //
      // Pero si ya hay uno en curso NO rechazamos el pedido: abortamos el anterior y seguimos.
      // Rechazar dejaba al usuario bloqueado con "ya hay una conexión en curso" hasta que
      // venciera el watchdog (20s), incluso cuando el intento previo ya estaba muerto.
      if (!connectInProgress.compareAndSet(false, true)) {
        android.util.Log.w(LOG_TAG, "connect($address): abortando el intento anterior en curso")
        // Invalidamos generación para que el watchdog y el monitor viejos no toquen nada.
        connectGeneration.incrementAndGet()
        try { bleCore?.disconnectedDevice() } catch (_: Exception) {}
        currentGatt = null
        try { Thread.sleep(400) } catch (_: InterruptedException) {}
        connectInProgress.set(true)
      }

      bleReady = false
      setupDone.set(false)
      val generation = connectGeneration.incrementAndGet()

      // NOTA: el H103 NO requiere vinculación (bonding). Verificado en hardware: la app oficial
      // del fabricante conecta y opera con el equipo sin vincular ("Bonded devices" vacío).
      // Cuando el descubrimiento de servicios se cuelga, la causa es que el stack BLE de Android
      // quedó en mal estado por conexiones GATT fallidas acumuladas; se destraba apagando y
      // encendiendo el Bluetooth del teléfono, no vinculando el equipo.

      // CRÍTICO: cortar el escaneo BLE antes de conectar. Escanear mantiene la radio ocupada y
      // en Android es una causa clásica de que el descubrimiento de servicios nunca termine:
      // en el log se veía connectDevice() y onBtScanResult intercalados, y la conexión moría
      // con status 8 (timeout) sin que onServicesDiscovered llegara nunca.
      try {
        android.util.Log.d(LOG_TAG, "connect(): deteniendo scan antes de conectar")
        stopScanInternal()
      } catch (_: Exception) {}
      try { Thread.sleep(400) } catch (_: InterruptedException) {}

      // Cerramos SIEMPRE el GATT previo antes de abrir uno nuevo (antes solo lo hacíamos si
      // isConnect==true, y así se colaban clientes huérfanos de intentos fallidos).
      // disconnectedDevice() hace disconnect() + close() + refresh() + limpia mGatt.
      try {
        android.util.Log.d(LOG_TAG, "connect(): cerrando cualquier GATT previo")
        bleCore?.disconnectedDevice()
      } catch (_: Exception) {}
      // El stack BLE de Android necesita un respiro real después de un close() antes de
      // aceptar un connectGatt() nuevo sobre el mismo device.
      try { Thread.sleep(600) } catch (_: InterruptedException) {}

      // IMPORTANTE: mIConnectDoneCallback es de UN SOLO USO. El bytecode de BleCore$1.onMtuChanged
      // hace `mIConnectDoneCallback = null` inmediatamente después de invocarlo, así que hay que
      // re-registrarlo ANTES DE CADA connectDevice(). Registrarlo una sola vez en initialize()
      // hacía que la 2da conexión en adelante nunca disparara onConnectDone => nunca se habilitaba
      // notify => sin eventos de tag/batería y sin bleReady. (El plugin Java de referencia lo
      // re-registra en cada connect por este mismo motivo.)
      bleCore?.setIConnectDoneCallback(object : IConnectDoneCallback {
        override fun onConnectDone(success: Boolean) {
          android.util.Log.d(LOG_TAG, "onConnectDone success=$success")
          if (success) {
            enableNotifyAndForceTransparentMode()
          } else {
            bleReady = false
            connectInProgress.set(false)
            sendEvent("onConnectionState", mapOf("state" to "disconnected"))
          }
        }
      })
      // El notify callback NO es de un solo uso (no se anula en onCharacteristicChanged), pero lo
      // re-registramos igual por si un setNotifyState(false) previo lo dejó en null.
      bleCore?.setOnNotifyCallback(notifyCallback)

      // autoConnect=false = conexión DIRECTA e inmediata. Con true, Android no conecta ya: deja
      // una "conexión en segundo plano" esperando a que el equipo publique advertising, lo que
      // puede tardar decenas de segundos o no ocurrir nunca => onConnectDone nunca se dispara y
      // la app queda en "Conectando…" hasta el timeout. (Probamos true en el build #8109 copiando
      // el plugin Java y rompió la conexión, que con false venía funcionando bien.)
      // La reconexión automática la maneja la capa JS, que reintenta llamando de nuevo a connect().
      // connectGatt() en el MAIN THREAD. En varios stacks (este equipo es Unisoc) las
      // operaciones GATT lanzadas desde un hilo cualquiera se comportan de forma errática.
      val gattHolder = arrayOfNulls<android.bluetooth.BluetoothGatt>(1)
      val latch = java.util.concurrent.CountDownLatch(1)
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        try {
          gattHolder[0] = bleCore?.connectDevice(device, appContext.reactContext, false)
        } catch (e: Exception) {
          android.util.Log.e(LOG_TAG, "connectDevice falló", e)
        }
        latch.countDown()
      }
      try { latch.await(4, java.util.concurrent.TimeUnit.SECONDS) } catch (_: InterruptedException) {}
      val gatt = gattHolder[0]
      currentGatt = gatt
      android.util.Log.d(LOG_TAG, "connect($address): connectDevice devolvió gatt=${gatt != null}. Esperando onConnectDone...")

      // Re-disparamos el descubrimiento de servicios desde el main thread. El SDK lo llama
      // dentro de onConnectionStateChange (binder thread) y ahí se cuelga: devuelve true y
      // onServicesDiscovered no llega nunca. Al re-emitirlo desde el main thread, el callback
      // del propio SDK se dispara y su cadena (servicios -> MTU -> onConnectDone) continúa.
      if (gatt != null) {
        scheduleDiscoveryKicks(generation)
      }

      if (gatt == null) {
        connectInProgress.set(false)
      } else {
        // Watchdog: si el SDK nunca dispara onConnectDone (pasa cuando onServicesDiscovered
        // no llega: discoverServices() devuelve true y después silencio total), liberamos el
        // flag y cerramos el GATT colgado para que un reintento posterior arranque limpio.
        // Solo actúa si sigue siendo el intento vigente: si ya arrancó otro connect(), este
        // watchdog quedó viejo y no debe tocar nada (antes cerraba la conexión NUEVA).
        Thread {
          try { Thread.sleep(CONNECT_WATCHDOG_MS) } catch (_: InterruptedException) {}
          if (connectGeneration.get() != generation) {
            android.util.Log.d(LOG_TAG, "Watchdog gen=$generation obsoleto (actual=${connectGeneration.get()}), se ignora")
          } else if (connectInProgress.get() && !bleReady) {
            android.util.Log.w(LOG_TAG, "Watchdog: onConnectDone nunca llegó; cerrando GATT colgado")
            try { bleCore?.disconnectedDevice() } catch (_: Exception) {}
            connectInProgress.set(false)
            sendEvent("onConnectionState", mapOf("state" to "disconnected"))
          }
        }.start()
      }
      }
      true
    }

    Function("disconnect") {
      bleCore?.disconnectedDevice()
      inventoryRunning = false
      bleReady = false
      connectInProgress.set(false)
      currentGatt = null
    }

    Function("isConnected") {
      bleCore?.isConnect == true
    }

    Function("isReady") {
      bleReady
    }

    AsyncFunction("startInventory") { mode: Int, intervalMs: Int ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      ensureRfidMode(s, w)
      if (inventoryRunning) {
        writeWithRetry(s, w, CmdBuilder.buildStopInventoryCmd())
        try { Thread.sleep(300) } catch (_: InterruptedException) {}
      }
      val command = CmdBuilder.buildInventoryISOContinueCmd(mode.toByte(), intervalMs)
      val ok = writeWithRetry(s, w, command)
      android.util.Log.d(LOG_TAG, "startInventory(invType=$mode, invParam=$intervalMs) -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo enviar el comando de inventory al H103")
      inventoryRunning = true
    }

    AsyncFunction("stopInventory") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val command = CmdBuilder.buildStopInventoryCmd()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, command)
      inventoryRunning = false
      detectionMaskEpc = null
      if (!ok) throw IllegalStateException("No se pudo detener el inventory")
    }

    AsyncFunction("setReadMode") { mode: String ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      android.util.Log.d(LOG_TAG, "setReadMode($mode) llamado. isConnect=${bleCore?.isConnect}")
      // Al cambiar de modo se limpia la máscara de detección: si quedaba una de una búsqueda
      // anterior, filtraba también las lecturas de código de barras.
      detectionMaskEpc = null
      inventoryRunning = false
      // La app del fabricante conmuta este flag global del SDK junto con el modo del equipo:
      // define como se interpreta la carga util de las respuestas de inventario. En modo escaner
      // el contenido es el codigo de barras en crudo y no debe separarse en EPC + datos.
      CfSdk.readerOrScanner = if (mode == "barcode") CfSdk.SCANNER_MODEL else CfSdk.RFID_MODEL
      val modeByte = if (mode == "barcode") READ_MODE_BARCODE else READ_MODE_RFID
      val command = CmdBuilder.buildSetReadModeCmd(modeByte, ByteArray(7))
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, command)
      android.util.Log.d(LOG_TAG, "setReadMode($mode) -> ok=$ok isConnect=${bleCore?.isConnect}")
      if (!ok) throw IllegalStateException("No se pudo cambiar el modo de lectura (RFID/Barcode).")
      currentReadMode = modeByte
      // El manual (RFM_SET_GET_READMODE) indica: "when setting, you need to wait for 1 second
      // to completely start the module". Sin esta espera, el comando siguiente puede perderse.
      try { Thread.sleep(1100) } catch (_: InterruptedException) {}
    }

    // Dispara UNA lectura de código de barras. Verificado contra la app demo del fabricante:
    // en modo barcode manda el mismo comando de inventory pero con InvType=0x01 (por cantidad
    // de ciclos) e InvParam=1, o sea un único disparo:  CF FF 00 01 05 01 00 00 00 01
    // Sin este comando el equipo nunca escanea: cambiar el modo de lectura no alcanza, y por eso
    // el 2D no entregaba nada por BLE.
    AsyncFunction("triggerBarcodeScan") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      CfSdk.readerOrScanner = CfSdk.SCANNER_MODEL
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, CmdBuilder.buildInventoryISOContinueCmd(0x01.toByte(), 1))
      android.util.Log.d(LOG_TAG, "triggerBarcodeScan -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo disparar la lectura de código de barras.")
    }

    /**
     * Modo de trabajo del equipo: 0 = respuesta, 1 = activo, 2 = gatillo.
     *
     * En modo RESPUESTA (el de fabrica) el lector solo actua ante comandos del host: al apretar
     * el gatillo hace un barrido local y contesta "comando completado", pero NO entrega los tags
     * por el canal de comandos. Por eso el gatillo pita y a la app no le llega nada.
     * En modo GATILLO el propio disparo inicia el inventario y reporta las lecturas.
     *
     * Se fija dentro del bloque completo de parametros, igual que la potencia: el equipo lo
     * guarda de forma persistente.
     */
    AsyncFunction("setWorkMode") { mode: Int ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      if (mode !in 0..2) throw IllegalArgumentException("Modo de trabajo inválido: $mode (0=respuesta, 1=activo, 2=gatillo).")
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")

      var param = latestAllParam
      if (param == null) {
        writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
        val end = System.currentTimeMillis() + 2000
        while (latestAllParam == null && System.currentTimeMillis() < end) {
          try { Thread.sleep(50) } catch (_: InterruptedException) {}
        }
        param = latestAllParam
      }
      if (param == null) {
        throw IllegalStateException("El equipo no devolvió sus parámetros, así que no se puede cambiar el modo de trabajo. Reintentá en unos segundos.")
      }

      param.mWorkMode = mode.toByte()
      val ok = writeWithRetry(s, w, CmdBuilder.buildSetAllParamCmd(param))
      if (!ok) throw IllegalStateException("No se pudo cambiar el modo de trabajo del equipo.")
      android.util.Log.d(LOG_TAG, "setWorkMode($mode) via SET_ALL_PARAM -> ok=$ok")
      try { Thread.sleep(500) } catch (_: InterruptedException) {}
      writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
    }

    AsyncFunction("setPower") { powerDbm: Int ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val clampedPower = powerDbm.coerceIn(POWER_MIN, POWER_MAX)
      if (clampedPower == lastPowerSent) {
        android.util.Log.d(LOG_TAG, "setPower($clampedPower dBm) omitido: ya es la potencia actual")
        return@AsyncFunction
      }
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")

      // La potencia se fija dentro del bloque completo de parametros (RFM_SET_ALL_PARAM, 0x0071),
      // NO con RFM_SET_PWR (0x0053).
      //
      // Medido sobre el equipo: 0x0053 acepta el comando (STATUS 0x00) pero no aplica el valor.
      // Devuelve ~150 respuestas identicas por comando y termina dejando la potencia en 0, o sea
      // la antena apagada: el inventario corre, termina al instante y no ve un solo tag. Se llego
      // a ver el equipo pasar de 33 dBm a 0 despues de una tanda de 0x0053.
      // La app del fabricante nunca usa 0x0053; fija la potencia con 0x0071, y asi el equipo lee
      // sin problemas. Hacemos lo mismo.
      var param = latestAllParam
      if (param == null) {
        writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
        val end = System.currentTimeMillis() + 2000
        while (latestAllParam == null && System.currentTimeMillis() < end) {
          try { Thread.sleep(50) } catch (_: InterruptedException) {}
        }
        param = latestAllParam
      }
      if (param == null) {
        throw IllegalStateException("El equipo no devolvió sus parámetros, así que no se puede cambiar la potencia con seguridad. Reintentá en unos segundos.")
      }

      param.mRfidPower = clampedPower.toByte()
      val ok = writeWithRetry(s, w, CmdBuilder.buildSetAllParamCmd(param))
      if (!ok) throw IllegalStateException("No se pudo establecer la potencia RFID.")
      android.util.Log.d(LOG_TAG, "setPower($clampedPower dBm) via SET_ALL_PARAM -> ok=$ok")
      lastPowerSent = clampedPower
      // Ahora si conviene releer: 0x0071 no provoca la avalancha de respuestas que provocaba
      // 0x0053, y necesitamos el valor CONFIRMADO por el equipo.
      try { Thread.sleep(500) } catch (_: InterruptedException) {}
      writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
      Unit
    }

    // Fuerza el modo de salida: true = transparente (datos por BLE, lo que necesita la app),
    // false = HID (el equipo actúa como teclado Bluetooth).
    AsyncFunction("setTransparentMode") { transparent: Boolean ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val mode = if (transparent) 0x01.toByte() else 0x00.toByte()
      val ok = writeWithRetry(s, w, CmdBuilder.buildSetOutputModeCmd(mode))
      android.util.Log.d(LOG_TAG, "setTransparentMode($transparent) -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo cambiar el modo de salida del H103.")
      try { Thread.sleep(300) } catch (_: InterruptedException) {}
      writeWithRetry(s, w, CmdBuilder.buildGetOutputModeCmd())
      Unit
    }

    AsyncFunction("getAllParam") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val command = CmdBuilder.buildGetAllParamCmd()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, command)
      if (!ok) throw IllegalStateException("No se pudo pedir la configuración del H103.")
      // La respuesta llega async por el evento "onAllParamLoaded".
      Unit
    }

    AsyncFunction("setSoundEnabled") { enabled: Boolean ->
      // El buzzer del H103 no es un comando de "beep ahora": es el campo mBuzzerTime dentro del
      // bloque completo de parámetros (AllParamBean), que hay que traer entero (getAllParam) y
      // reescribir entero (buildSetAllParamCmd). No existe "buildSetBuzzerCmd" en este SDK.
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      soundEnabled = enabled
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      applyBuzzer(s, w, enabled)
    }

    AsyncFunction("startDetection") { epcHex: String, mode: Int, intervalMs: Int ->
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      detectionMaskEpc = epcHex.uppercase()
      android.util.Log.d(LOG_TAG, "startDetection mask=$detectionMaskEpc invType=$mode invParam=$intervalMs")
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      // El equipo tiene que estar en RFID: si quedo en modo codigo de barras (estado que
      // sobrevive al cierre de la app), el inventario no devuelve ningun EPC.
      ensureRfidMode(s, w)
      // Solo cortamos si HAY un barrido corriendo.
      //
      // Mandar el stop siempre, justo antes del inventario, resultaba en esto: se escribian los
      // dos comandos en el mismo segundo, el ack del stop llegaba DESPUES de haber mandado el
      // inventario, y un segundo mas tarde el equipo contestaba 0x12 ("comando ejecutado") sin
      // un solo tag. O sea que el stop terminaba matando el barrido recien arrancado.
      // La app del fabricante no manda ningun stop antes de inventariar, y lee.
      if (inventoryRunning) {
        writeWithRetry(s, w, CmdBuilder.buildStopInventoryCmd())
        try { Thread.sleep(300) } catch (_: InterruptedException) {}
      }
      // Sin tocar la seleccion del equipo: el prefijo se compara en la app (sendTag).
      val command = CmdBuilder.buildInventoryISOContinueCmd(mode.toByte(), intervalMs)
      val ok = writeWithRetry(s, w, command)
      android.util.Log.d(LOG_TAG, "startDetection -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo iniciar la detección EPC")
      inventoryRunning = true
    }

    AsyncFunction("clearDetectionMask") {
      // Solo limpiamos el prefijo que compara la app. NO se toca la seleccion del equipo:
      // este lector rechaza RFM_SETISO_SELECTMASK con STATUS 0x02 (error interno del modulo) y
      // queda sin reportar tags, incluso para la app del fabricante. Como ya no ponemos ninguna
      // seleccion, tampoco hay nada que deshacer.
      detectionMaskEpc = null
      Unit
    }

    AsyncFunction("getBattery") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val command = CmdBuilder.buildGetBatteryCapacityCmd()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, command)
      if (!ok) throw IllegalStateException("No se pudo solicitar el nivel de batería.")
      // La respuesta es asíncrona: llega por el evento "onBatteryLevel" (ver setOnNotifyCallback).
      Unit
    }

    // RFM_MODULE_INT (0x0050): "el equipo realiza la configuración inicial según sus parámetros
    // almacenados". Sirve para destrabar el módulo RFID cuando empieza a responder 0x02
    // ("error interno del módulo") a comandos como GET_ALL_PARAM o el inventory, que es el
    // síntoma de que la parte de radiofrecuencia quedó en falla aunque el BLE siga respondiendo.
    AsyncFunction("moduleInit") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, CmdBuilder.buildModuleInitCmd())
      android.util.Log.d(LOG_TAG, "moduleInit -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo enviar la inicialización del módulo RFID.")
      // Tras inicializar, el equipo reconfigura la RF: le damos tiempo y releemos parámetros.
      try { Thread.sleep(1200) } catch (_: InterruptedException) {}
      writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
      Unit
    }

    // RFM_REBOOT (0x0052): restaura el equipo a valores de fábrica. Es la vía documentada para
    // sacarlo de un estado raro (p. ej. quedó trabado en modo código de barras). El equipo se
    // reinicia y corta la conexión BLE: hay que volver a conectarlo después.
    AsyncFunction("factoryReset") {
      ensureInitialized()
      requireCharacteristics()
      requireReady()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = writeWithRetry(s, w, CmdBuilder.buildRebootCmd())
      android.util.Log.d(LOG_TAG, "factoryReset -> ok=$ok")
      if (!ok) throw IllegalStateException("No se pudo enviar el comando de restauración de fábrica.")
      inventoryRunning = false
      detectionMaskEpc = null
      latestAllParam = null
      lastPowerSent = null
      currentReadMode = null
    }

    AsyncFunction("getDeviceInfo") {
      emptyMap<String, String>()
    }
  }

  // GATT solo admite UNA escritura en vuelo por vez: si dos llegan pisadas (p.ej. el fetch
  // automático de parámetros al conectar + el usuario tocando "RFID" al toque) el characteristic
  // write puede fallar Y en algunos stacks tirar abajo la conexión entera. writeLock serializa
  // TODAS las escrituras del módulo (incluidas las de enableNotifyAndForceTransparentMode) y
  // fuerza un espacio mínimo entre una y la siguiente para darle tiempo real al BLE stack.
  private val writeLock = Any()
  @Volatile private var lastWriteAtMs = 0L
  private val minWriteGapMs = 120L

  // El plugin Java de referencia (probado en producción) siempre reintenta las escrituras BLE
  // hasta 3 veces con backoff — un solo intento falla intermitentemente en varios stacks BLE,
  // sobre todo justo después de reconectar. AsyncFunction corre en un dispatcher de background,
  // así que el Thread.sleep acá no bloquea la UI/JS thread.
  private fun writeWithRetry(service: UUID, write: UUID, data: ByteArray, maxAttempts: Int = 3): Boolean {
    synchronized(writeLock) {
      val sinceLast = System.currentTimeMillis() - lastWriteAtMs
      if (sinceLast in 0 until minWriteGapMs) {
        try { Thread.sleep(minWriteGapMs - sinceLast) } catch (_: InterruptedException) {}
      }
      for (attempt in 1..maxAttempts) {
        val ok = try {
          bleCore?.writeData(service, write, data) == true
        } catch (_: Exception) {
          false
        }
        lastWriteAtMs = System.currentTimeMillis()
        if (ok) return true
        if (attempt < maxAttempts) {
          try { Thread.sleep(150L * attempt) } catch (_: InterruptedException) {}
        }
      }
      return false
    }
  }

  // Programa varios reintentos de discoverServices() en el MAIN THREAD. El primero va apenas
  // después de que la conexión GATT se asienta; los siguientes cubren el caso de que el equipo
  // tarde más. Cada uno se cancela solo si ya hay conexión lista o si arrancó otro intento.
  private fun scheduleDiscoveryKicks(generation: Int) {
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    // UN SOLO reintento. Antes eran cuatro (900/2500/5000/9000 ms) y además llamaban a
    // gatt.refresh(): re-emitir discoverServices() o limpiar la caché MIENTRAS hay un
    // descubrimiento en curso lo aborta, así que los reintentos se saboteaban entre sí y el
    // descubrimiento no terminaba nunca. Este kick único solo cubre el caso de que la llamada
    // que hace el SDK desde el binder thread se haya perdido.
    handler.postDelayed({ kickDiscovery(generation, 1200L) }, 1200L)
    // Monitor propio: en vez de depender de la cadena del SDK
    // (onServicesDiscovered -> requestMtu(512) -> onMtuChanged -> onConnectDone), miramos
    // directamente si el servicio ya está disponible en el GATT. Esa cadena tiene dos puntos
    // frágiles confirmados: discoverServices() se cuelga al llamarse desde el binder thread, y
    // el equipo es BLE 4.2, donde un requestMtu(512) puede no responder nunca — y el SDK emite
    // onConnectDone SOLO desde onMtuChanged. Con este monitor, la conexión queda operativa
    // apenas los servicios existen, sin importar si el SDK completa su secuencia.
    Thread { monitorServicesReady(generation) }.start()
  }

  private fun monitorServicesReady(generation: Int) {
    val s = serviceUuid ?: return
    val deadline = System.currentTimeMillis() + CONNECT_WATCHDOG_MS
    while (System.currentTimeMillis() < deadline) {
      if (connectGeneration.get() != generation) return
      if (bleReady) return
      val gatt = currentGatt
      if (gatt != null) {
        val service = try { gatt.getService(s) } catch (_: Exception) { null }
        if (service != null) {
          android.util.Log.d(LOG_TAG, "Monitor: servicio $s disponible en el GATT; arrancando setup")
          enableNotifyAndForceTransparentMode()
          return
        }
      }
      try { Thread.sleep(400) } catch (_: InterruptedException) { return }
    }
    android.util.Log.w(LOG_TAG, "Monitor: el servicio $s nunca apareció en el GATT (gen=$generation)")
  }

  private fun kickDiscovery(generation: Int, delay: Long) {
    if (connectGeneration.get() != generation) return
    if (bleReady) return
    val gatt = currentGatt ?: return
    // Si el servicio ya está, el descubrimiento terminó: no lo volvemos a disparar.
    val already = try { serviceUuid?.let { gatt.getService(it) } } catch (_: Exception) { null }
    if (already != null) {
      android.util.Log.d(LOG_TAG, "kick omitido: los servicios ya están descubiertos")
      return
    }
    try {
      val ok = gatt.discoverServices()
      android.util.Log.d(LOG_TAG, "kick discoverServices desde main thread (+${delay}ms) -> $ok")
    } catch (e: Exception) {
      android.util.Log.e(LOG_TAG, "kick discoverServices falló", e)
    }
  }

  private fun ensureInitialized() {
    if (bleCore == null) {
      android.util.Log.e(LOG_TAG, "ensureInitialized() falló: bleCore es null (no se llamó initialize() o CfSdk.get() devolvió null)")
      throw IllegalStateException("CHAFON no inicializado. Llamá initialize() primero.")
    }
  }

  private fun requireCharacteristics() {
    if (serviceUuid == null || writeUuid == null) {
      throw IllegalStateException("Faltan Service UUID y Write Characteristic UUID del H103.")
    }
  }

  // El H103 tiene dos modos de salida: HID (emula teclado Bluetooth) y BLE Transparente/SPP
  // (el protocolo propietario Chafon que usa este módulo). Si el firmware quedó en modo HID,
  // Android lo engancha a su propio perfil HID_HOST del sistema y deja de estar disponible
  // para nuestra conexión GATT. Apenas conectamos, forzamos modo transparente (0x01) para
  // evitar que el terminal vuelva a anunciarse/operar como teclado HID.
  private fun enableNotifyAndForceTransparentMode() {
    // Puede llamarlo onConnectDone (cadena del SDK) o nuestro monitor de servicios, lo que
    // ocurra primero. Solo la primera llamada de cada conexión hace el trabajo.
    if (!setupDone.compareAndSet(false, true)) {
      android.util.Log.d(LOG_TAG, "setup post-conexión ya ejecutado, se ignora la llamada duplicada")
      return
    }
    val s = serviceUuid
    val n = notifyUuid
    val w = writeUuid
    if (s == null || n == null) {
      android.util.Log.e(LOG_TAG, "onConnectDone sin UUIDs configurados: llamá configureCharacteristics() antes de connect()")
      sendEvent("onConnectionState", mapOf("state" to "disconnected"))
      return
    }

    // Todo el arranque post-conexión va en un hilo aparte: usa sleeps y escrituras BLE.
    Thread { runPostConnectSetup(s, n, w) }.start()
  }

  // El bloque de parámetros llega async tras conectar. Si todavía no está, lo pedimos y
  // esperamos un toque en vez de fallar: esto lo llama el flujo de detección del tab Stock
  // y no queremos que un buzzer sin configurar impida arrancar la búsqueda RFID.
  private fun applyBuzzer(s: UUID, w: UUID, enabled: Boolean) {
    var param = latestAllParam
    if (param == null) {
      writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
      val end = System.currentTimeMillis() + 1500
      while (latestAllParam == null && System.currentTimeMillis() < end) {
        try { Thread.sleep(50) } catch (_: InterruptedException) {}
      }
      param = latestAllParam
    }
    if (param == null) {
      android.util.Log.w(LOG_TAG, "setSoundEnabled($enabled): sin AllParam, se guarda la preferencia sin aplicarla al equipo")
      return
    }

    param.mBuzzerTime = if (enabled) 0x05.toByte() else 0x00.toByte()
    val ok = writeWithRetry(s, w, CmdBuilder.buildSetAllParamCmd(param))
    android.util.Log.d(LOG_TAG, "setSoundEnabled($enabled) -> ok=$ok")
    if (!ok) throw IllegalStateException("No se pudo actualizar el buzzer del H103.")
  }

  // Ejecuta setNotifyState en el main thread y espera el resultado. Requisito del SDK
  // (ver comentario en runPostConnectSetup).
  private fun setNotifyStateOnMainThread(s: UUID, n: UUID): Boolean {
    val result = booleanArrayOf(false)
    val latch = java.util.concurrent.CountDownLatch(1)
    android.os.Handler(android.os.Looper.getMainLooper()).post {
      try {
        result[0] = bleCore?.setNotifyState(s, n, true) == true
      } catch (e: Exception) {
        android.util.Log.e(LOG_TAG, "setNotifyState falló", e)
      }
      latch.countDown()
    }
    return try {
      latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
      result[0]
    } catch (_: InterruptedException) {
      false
    }
  }

  private fun runPostConnectSetup(s: UUID, n: UUID, w: UUID?) {
    // setNotifyState DEBE ejecutarse en el MAIN THREAD: lo dice explícitamente el código de la
    // app demo oficial del fabricante ("打开蓝牙通知(需在主线程调用)" = abrir la notificación
    // Bluetooth debe llamarse en el hilo principal). Llamarlo desde un hilo de background
    // devuelve false o queda colgado.
    var notifyOk = false
    for (attempt in 1..5) {
      notifyOk = setNotifyStateOnMainThread(s, n)
      if (notifyOk) break
      try { Thread.sleep(200L * attempt) } catch (_: InterruptedException) {}
    }
    android.util.Log.d(LOG_TAG, "setNotifyState (main thread) -> ok=$notifyOk")

    if (!notifyOk) {
      // Sin notify no hay eventos de tag/batería y las escrituras tampoco van a andar
      // (mismo requisito de servicio/característica), así que no marcamos ready.
      bleReady = false
      connectInProgress.set(false)
      sendEvent("onScanError", mapOf("message" to "Conectado, pero no se pudo habilitar la notificación BLE. Verificá los UUIDs del H103."))
      sendEvent("onConnectionState", mapOf("state" to "disconnected"))
      return
    }

    // El descriptor de notify necesita un respiro antes de mandar comandos (mismo patrón que
    // el plugin Java: setNotifyState -> 200ms -> configuración).
    try { Thread.sleep(250) } catch (_: InterruptedException) {}

    bleReady = true
    connectInProgress.set(false)
    // Recién ahora la conexión sirve de verdad: avisamos a JS.
    sendEvent("onConnectionState", mapOf("state" to "connected"))

    if (w == null) return

    try {
      android.util.Log.d(LOG_TAG, "Forzando modo transparente post-conexión...")
      // Solo PREGUNTAMOS en que modo de salida esta. Si contesta HID lo corregimos en el
      // handler de OutputModeBean; si ya esta en transparente no le escribimos nada.
      //
      // La app del fabricante, en la sesion donde leyo 14 tags, no escribio NADA antes de
      // inventariar: solo pidio info del equipo y sus parametros. Cada escritura de
      // configuracion que le agregabamos era una oportunidad de dejar el modulo en mal estado.
      val okMode = writeWithRetry(s, w, CmdBuilder.buildGetOutputModeCmd())
      android.util.Log.d(LOG_TAG, "Consultando modo de salida -> ok=$okMode")
    } catch (_: Exception) {}

    // Preguntamos en que modo de lectura esta, sin escribirlo. El equipo recuerda el modo entre
    // sesiones, asi que hay que conocerlo; pero FIJARLO reinicia el modulo lector (el manual pide
    // esperar 1 segundo tras hacerlo) y en este equipo eso deja la parte de RF sin reportar tags.
    // Si la respuesta dice que quedo en codigo de barras, ensureRfidMode() lo corrige antes del
    // inventario; si ya esta en RFID no le escribimos nada.
    try {
      if (w != null) {
        val okRead = writeWithRetry(s, w, CmdBuilder.buildGetReadModeCmd())
        android.util.Log.d(LOG_TAG, "Consultando modo de lectura -> ok=$okRead")
      }
    } catch (_: Exception) {}

    // Info del equipo: es el primer comando que manda la app del fabricante en la sesion donde
    // leyo 14 tags, y el unico suyo que no estabamos mandando.
    try {
      if (w != null) writeWithRetry(s, w, CmdBuilder.buildGetDeviceInfoCmd())
    } catch (_: Exception) {}

    try {
      android.util.Log.d(LOG_TAG, "Pidiendo AllParam post-conexión...")
      val okParam = writeWithRetry(s, w, CmdBuilder.buildGetAllParamCmd())
      android.util.Log.d(LOG_TAG, "Pedido AllParam -> ok=$okParam")
    } catch (_: Exception) {}

    // Confirmamos con el equipo en qué modo de salida quedó. Si responde HID (0x00), los datos
    // del gatillo salen como pulsaciones de teclado en vez de por este canal BLE: el escaneo
    // "funciona" tipeando en el campo enfocado y el foco salta solo por la app.
    try {
      writeWithRetry(s, w, CmdBuilder.buildGetOutputModeCmd())
    } catch (_: Exception) {}
  }

  // Espera a que el pipeline GATT termine (servicios + MTU + notify). Sin esto, cualquier
  // comando disparado apenas conecta falla porque BleCore.writeData() no encuentra el servicio.
  // Mismo patrón que waitBleReady() del plugin Java de referencia.
  private fun waitBleReady(timeoutMs: Long): Boolean {
    val end = System.currentTimeMillis() + timeoutMs
    while (!bleReady && System.currentTimeMillis() < end) {
      try { Thread.sleep(50) } catch (_: InterruptedException) {}
    }
    return bleReady
  }

  private fun requireReady() {
    if (!waitBleReady(3000)) {
      throw IllegalStateException("La terminal todavía no terminó de conectarse. Esperá un momento y reintentá.")
    }
  }

  private fun requestBluetoothPermissions(): Boolean {
    val activity = appContext.currentActivity ?: return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val scanGranted = ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    val connectGranted = ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    if (scanGranted && connectGranted) return true
    ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), 7001)
    return false
  }

  private fun emitBondedDevices() {
    val context = appContext.reactContext ?: return
    val manager = context.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager ?: return
    val adapter = manager.adapter ?: return
    try {
      val bonded = adapter.bondedDevices
      android.util.Log.d("ChafonH103", "bondedDevices count = ${bonded?.size ?: -1}")
      bonded?.forEach { device ->
        val address = device.address ?: return@forEach
        devices[address] = device
        val name = try { device.name } catch (_: SecurityException) { null }
        val isCf = name?.contains("CF", ignoreCase = true) == true || name?.contains("H103", ignoreCase = true) == true
        android.util.Log.d("ChafonH103", "bonded device: name=$name, address=$address")
        sendEvent("onDeviceFound", mapOf(
          "id" to address,
          "address" to address,
          "name" to name,
          "rssi" to 0,
          "isCfDevice" to isCf,
          "isBonded" to true
        ))
      }
    } catch (e: SecurityException) {
      android.util.Log.e("ChafonH103", "SecurityException leyendo bondedDevices", e)
      sendEvent("onScanError", mapOf("message" to (e.message ?: "Permisos insuficientes para consultar dispositivos vinculados")))
    } catch (e: Exception) {
      android.util.Log.e("ChafonH103", "Error leyendo bondedDevices", e)
      sendEvent("onScanError", mapOf("message" to (e.message ?: "Error al obtener dispositivos vinculados")))
    }
  }

  private fun findBondedDevice(address: String): BluetoothDevice? {
    val context = appContext.reactContext ?: return null
    val manager = context.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager ?: return null
    return try {
      manager.adapter?.bondedDevices?.firstOrNull { it.address.equals(address, ignoreCase = true) }
    } catch (_: SecurityException) {
      null
    }
  }

  /**
   * Filtro de tags por hardware: RFM_SELECT_MASK (0x0007).
   *
   * Le pide al lector que solo conteste por los tags cuyo EPC empieza con la mascara, en vez de
   * traer todos y descartarlos en la app. Es lo que hacen los lectores cuando ofrecen una
   * busqueda tipo "radar": mucho menos trafico BLE y un RSSI que corresponde siempre al tag
   * buscado, que es justo lo que necesita la guia de proximidad.
   *
   * La mascara solo puede expresarse en BYTES enteros, asi que se envia la parte del prefijo que
   * cae en un byte completo. El resto (por ejemplo el ultimo digito del color, que es medio byte)
   * se sigue comparando en la app contra detectionMaskEpc.
   */
  private fun applySelectMask(s: UUID, w: UUID, epcHex: String?) {
    val aligned = epcHex?.let { it.take((it.length / 2) * 2) } ?: ""
    // Poner una seleccion esta desactivado a proposito (ver USE_HARDWARE_SELECT_MASK).
    if (aligned.isNotEmpty() && !USE_HARDWARE_SELECT_MASK) return
    val mask = try {
      ByteArray(aligned.length / 2) { i -> aligned.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    } catch (e: Exception) {
      android.util.Log.w(LOG_TAG, "mascara EPC invalida: $aligned", e)
      return
    }
    android.util.Log.d(LOG_TAG, "applySelectMask bytes=${mask.size}" + if (mask.isEmpty()) " (limpiar seleccion)" else " hex=$aligned")
    // No es fatal: si el equipo la rechaza, seguimos filtrando en la app.
    writeWithRetry(s, w, CmdBuilder.buildSelectMaskCmd(mask))
  }

  // NOTA: NO existe una rutina para "limpiar la seleccion de tag" del equipo.
  //
  // Se intento en su momento mandar RFM_SETISO_SELECTMASK con Pointer 0x0000 y Length 0x00 (los
  // valores por defecto segun el manual) para deshacer una seleccion previa. Este lector lo
  // RECHAZA con STATUS 0x02 (error interno del modulo) y a partir de ahi deja de reportar tags:
  // se comprobo restaurando el equipo de fabrica, verificando que leia, conectando esta app y
  // viendo que el unico comando entre "leia" y "no lee" era justamente ese.
  // Como ya no ponemos ninguna seleccion (ver USE_HARDWARE_SELECT_MASK), no hay nada que deshacer.

  private fun ensureRfidMode(s: UUID, w: UUID) {
    if (currentReadMode == null) {
      // No lo sabemos todavia: preguntamos en vez de escribir a ciegas.
      writeWithRetry(s, w, CmdBuilder.buildGetReadModeCmd())
      val end = System.currentTimeMillis() + 1200
      while (currentReadMode == null && System.currentTimeMillis() < end) {
        try { Thread.sleep(50) } catch (_: InterruptedException) {}
      }
    }
    if (currentReadMode == READ_MODE_RFID) return
    if (currentReadMode == null) {
      android.util.Log.w(LOG_TAG, "no sabemos el modo de lectura del equipo; no lo tocamos")
      return
    }
    android.util.Log.d(LOG_TAG, "ensureRfidMode: el equipo no esta confirmado en RFID, lo forzamos")
    val ok = writeWithRetry(s, w, CmdBuilder.buildSetReadModeCmd(READ_MODE_RFID, ByteArray(7)))
    if (ok) {
      currentReadMode = READ_MODE_RFID
      // El manual (RFM_SET_GET_READMODE) pide esperar 1 segundo tras fijar el modo para que el
      // modulo termine de arrancar; sin la espera el comando siguiente se pierde.
      try { Thread.sleep(1100) } catch (_: InterruptedException) {}
    } else {
      android.util.Log.w(LOG_TAG, "ensureRfidMode: no se pudo fijar el modo RFID")
    }
  }

  private fun sendTag(tag: TagInfoBean) {
    val epc = tag.mEPCNum?.toHex() ?: return
    val mask = detectionMaskEpc
    val isMatch = mask == null || epc.startsWith(mask)
    android.util.Log.d(LOG_TAG, "sendTag epc=$epc rssi=${tag.mRSSI} mask=${mask ?: "-"} match=$isMatch")
    // SIEMPRE emitimos la lectura, con isMatch para que la UI decida qué hacer. Antes las
    // lecturas que no coincidían con la máscara se descartaban acá en silencio: si el prefijo
    // calculado no correspondía a los tags reales no llegaba absolutamente nada (ni forma de
    // darse cuenta), y en modo código de barras una máscara vieja bloqueaba también los códigos.
    // El buzzer al leer lo maneja el firmware del equipo según mBuzzerTime (ver setSoundEnabled).
    sendEvent("onTagRead", mapOf(
      "epc" to epc,
      "rssi" to tag.mRSSI,
      "antenna" to tag.mAntenna,
      "channel" to tag.mChannel,
      "isMatch" to isMatch
    ))
  }

  private fun handleScanResult(result: android.bluetooth.le.ScanResult) {
    val device = result.device ?: return
    val address = try { device.address } catch (_: SecurityException) { return }
    if (address.isBlank()) return
    devices[address] = device
    val name = try { device.name } catch (_: SecurityException) { null }
    val bytes = result.scanRecord?.bytes ?: ByteArray(0)
    val isCfByBytes = try { BleUtil.isCfDevice(bytes) } catch (_: Exception) { false }
    val isCfByName = name?.contains("CF", ignoreCase = true) == true || name?.contains("H103", ignoreCase = true) == true
    val isBonded = try { device.bondState == BluetoothDevice.BOND_BONDED } catch (_: SecurityException) { false }

    sendEvent("onDeviceFound", mapOf(
      "id" to address,
      "address" to address,
      "name" to name,
      "rssi" to result.rssi,
      "isCfDevice" to (isCfByBytes || isCfByName),
      "isBonded" to isBonded
    ))
  }

  private fun stopScanInternal() {
    android.util.Log.d(LOG_TAG, "Deteniendo scan. Total de resultados BLE crudos recibidos=$scanResultCount, dispositivos únicos=${devices.size}")
    try { bleCore?.stopScan() } catch (e: Exception) {
      android.util.Log.e(LOG_TAG, "Excepción al detener el scan", e)
    }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02X".format(it.toInt() and 0xFF) }
}
