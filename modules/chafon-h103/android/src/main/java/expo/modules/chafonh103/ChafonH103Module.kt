package expo.modules.chafonh103

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanCallback
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
import com.cf.beans.CmdData
import com.cf.beans.TagInfoBean
import com.cf.zsdk.BleCore
import com.cf.zsdk.CfSdk
import com.cf.zsdk.cmd.CmdBuilder
import com.cf.zsdk.cmd.CmdHandler
import java.util.UUID

class ChafonH103Module : Module() {
  private var bleCore: BleCore? = null
  private val devices = mutableMapOf<String, BluetoothDevice>()
  private var serviceUuid: UUID? = null
  private var notifyUuid: UUID? = null
  private var writeUuid: UUID? = null
  private var inventoryRunning = false
  private var soundEnabled = true
  private var detectionMaskEpc: String? = null

  override fun definition() = ModuleDefinition {
    Name("ChafonH103")
    Events("onDeviceFound", "onTagRead", "onConnectionState")

    Function("isSupported") {
      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      manager?.adapter != null
    }

    Function("isEnabled") {
      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      manager?.adapter?.isEnabled == true
    }

    AsyncFunction("requestPermissions") {
      requestBluetoothPermissions()
    }

    AsyncFunction("initialize") {
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android no disponible")
      CfSdk.load()
      if (bleCore == null) {
        bleCore = CfSdk.get(BleCore::class.java)
        bleCore?.init(context)
        bleCore?.setIConnectDoneCallback(object : IConnectDoneCallback {
          override fun onConnectDone(success: Boolean) {
            sendEvent("onConnectionState", mapOf("state" to if (success) "connected" else "disconnected"))
          }
        })
        bleCore?.setIBleDisConnectCallback(object : IBleDisConnectCallback {
          override fun onBleDisconnect() {
            inventoryRunning = false
            sendEvent("onConnectionState", mapOf("state" to "disconnected"))
          }
        })
        bleCore?.setOnNotifyCallback(object : IOnNotifyCallback {
          override fun onNotify(type: Int, data: CmdData) {
            val value = data.data
            if (value is TagInfoBean) {
              sendTag(value)
            }
          }
        })
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

      // 1. Emitir primero los dispositivos ya vinculados/emparejados en el sistema Bluetooth
      emitBondedDevices()

      // 2. Escaneo vía Chafon BleCore SDK
      try {
        bleCore?.startScan(object : IBtScanCallback {
          override fun onBtScanResult(result: android.bluetooth.le.ScanResult) {
            handleScanResult(result)
          }

          override fun onBtScanFail(errorCode: Int) {
            sendEvent("onDeviceFound", mapOf("error" to errorCode))
          }
        })
      } catch (_: Exception) {}

      // 3. Escaneo estándar Android LE como fallback para capturar la terminal H103 visible en Bluetooth
      try {
        val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
        val scanner = manager?.adapter?.bluetoothLeScanner
        scanner?.startScan(leScanCallback)
      } catch (_: SecurityException) {} catch (_: Exception) {}

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
      val started = bleCore?.connectDevice(device, appContext.reactContext, false) != null
      if (started && notifyUuid != null && serviceUuid != null) {
        // El callback de conexión termina de descubrir las características en el firmware.
        // El notify se habilita inmediatamente después si el stack ya lo permite.
        try {
          val s = serviceUuid
          val n = notifyUuid
          if (s != null && n != null) bleCore?.setNotifyState(s, n, true)
        } catch (_: Exception) {
          // Se deja que la aplicación reintente una vez conectado.
        }
      }
      started
    }

    Function("disconnect") {
      bleCore?.disconnectedDevice()
      inventoryRunning = false
    }

    Function("isConnected") {
      bleCore?.isConnect == true
    }

    AsyncFunction("startInventory") { mode: Int, intervalMs: Int ->
      ensureInitialized()
      requireCharacteristics()
      val command = CmdBuilder.buildInventoryISOContinueCmd(mode.toByte(), intervalMs)
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = bleCore?.writeData(s, w, command) == true
      if (!ok) throw IllegalStateException("No se pudo enviar el comando de inventory al H103")
      inventoryRunning = true
    }

    AsyncFunction("stopInventory") {
      ensureInitialized()
      requireCharacteristics()
      val command = CmdBuilder.buildStopInventoryCmd()
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = bleCore?.writeData(s, w, command) == true
      inventoryRunning = false
      detectionMaskEpc = null
      if (!ok) throw IllegalStateException("No se pudo detener el inventory")
    }

    AsyncFunction("setPower") { powerDbm: Int ->
      ensureInitialized()
      requireCharacteristics()
      val clampedPower = powerDbm.coerceIn(0, 30)
      val command = CmdBuilder.buildSetPowerCmd(clampedPower.toByte())
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = bleCore?.writeData(s, w, command) == true
      if (!ok) throw IllegalStateException("No se pudo establecer la potencia RFID.")
    }

    AsyncFunction("setSoundEnabled") { enabled: Boolean ->
      soundEnabled = enabled
      ensureInitialized()
      requireCharacteristics()
      try {
        val command = CmdBuilder.buildSetBuzzerCmd(if (enabled) 1.toByte() else 0.toByte())
        val s = serviceUuid
        val w = writeUuid
        if (s != null && w != null) {
          bleCore?.writeData(s, w, command)
        }
      } catch (_: Exception) {}
      Unit
    }

    AsyncFunction("startDetection") { epcHex: String, mode: Int, intervalMs: Int ->
      ensureInitialized()
      requireCharacteristics()
      detectionMaskEpc = epcHex.uppercase()
      val command = CmdBuilder.buildInventoryISOContinueCmd(mode.toByte(), intervalMs)
      val s = serviceUuid ?: throw IllegalStateException("Falta Service UUID del H103.")
      val w = writeUuid ?: throw IllegalStateException("Falta Write Characteristic UUID del H103.")
      val ok = bleCore?.writeData(s, w, command) == true
      if (!ok) throw IllegalStateException("No se pudo iniciar la detección EPC")
      inventoryRunning = true
    }

    AsyncFunction("clearDetectionMask") {
      detectionMaskEpc = null
      Unit
    }

    AsyncFunction("getBattery") {
      // Se deja como siguiente paso porque la respuesta es asíncrona en el SDK.
      // La orden puede dispararse desde Kotlin cuando definamos el modelo de eventos de respuesta.
      -1
    }

    AsyncFunction("getDeviceInfo") {
      emptyMap<String, String>()
    }
  }

  private fun ensureInitialized() {
    if (bleCore == null) throw IllegalStateException("CHAFON no inicializado. Llamá initialize() primero.")
  }

  private fun requireCharacteristics() {
    if (serviceUuid == null || writeUuid == null) {
      throw IllegalStateException("Faltan Service UUID y Write Characteristic UUID del H103.")
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
      adapter.bondedDevices?.forEach { device ->
        val address = device.address ?: return@forEach
        devices[address] = device
        sendEvent("onDeviceFound", mapOf(
          "id" to address,
          "address" to address,
          "name" to (try { device.name } catch (_: SecurityException) { null }),
          "rssi" to 0,
          "isCfDevice" to true,
          "isBonded" to true
        ))
      }
    } catch (_: SecurityException) {}
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

  private fun sendTag(tag: TagInfoBean) {
    val epc = tag.mEPCNum?.toHex() ?: return
    val mask = detectionMaskEpc
    val isMatch = mask == null || epc.startsWith(mask)
    if (mask != null && !isMatch) {
      return
    }
    if (soundEnabled || mask != null) {
      try {
        val s = serviceUuid
        val w = writeUuid
        if (s != null && w != null) {
          bleCore?.writeData(s, w, CmdBuilder.buildSetBuzzerCmd(1.toByte()))
        }
      } catch (_: Exception) {}
    }
    sendEvent("onTagRead", mapOf(
      "epc" to epc,
      "rssi" to tag.mRSSI,
      "antenna" to tag.mAntenna,
      "channel" to tag.mChannel,
      "isMatch" to isMatch
    ))
  }

  private val leScanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: android.bluetooth.le.ScanResult) {
      handleScanResult(result)
    }
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
    try { bleCore?.stopScan() } catch (_: Exception) {}
    try {
      val manager = appContext.reactContext?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      val scanner = manager?.adapter?.bluetoothLeScanner
      scanner?.stopScan(leScanCallback)
    } catch (_: SecurityException) {} catch (_: Exception) {}
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02X".format(it.toInt() and 0xFF) }
}
