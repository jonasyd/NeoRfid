import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform, PermissionsAndroid, Pressable, StyleSheet, Text, TextInput, View, ScrollView, ActivityIndicator } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';
import { getSavedApiBaseUrl, saveApiBaseUrl } from '@/services/api';
import ChafonH103, { type ChafonDevice, type ChafonTag } from '@modules/chafon-h103';

type TestTag = {
  epc: string;
  rssi: number;
  antenna: number;
  channel: number;
  isMatch: boolean;
  count: number;
  lastSeen: number;
};

// Reintentos espaciados y pocos: reconectar de forma agresiva abría varios clientes GATT
// contra el mismo equipo y eso rompía el descubrimiento de servicios (la conexión quedaba
// colgada y el lector cortaba solo a los ~30s).
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 6000;
// Debe superar el watchdog nativo (25s) para no pisar un intento que sigue vivo.
const CONNECT_TIMEOUT_MS = 30000;
// Potencia RFID soportada por el H103 (ficha técnica del fabricante): 4 a 33 dBm.
const POWER_MIN = 1;
const POWER_MAX = 33;

// En modo barcode el H103 manda el texto leído como los mismos bytes crudos que en RFID
// llegarían como EPC (hex). Acá los decodificamos a texto para mostrarlos legibles.
function hexToAsciiSafe(hex: string): string {
  if (!hex || hex.length % 2 !== 0) return hex;
  try {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.substr(i, 2), 16);
      if (code === 0) continue;
      out += String.fromCharCode(code);
    }
    return out || hex;
  } catch {
    return hex;
  }
}

// Confirmados contra el plugin Java probado y react_chafon_sdk/ChafonH103Service.ts.
// (Los valores fee7/36f1/36f2 que había antes acá estaban mal: no correspondían a ninguna
// característica real del H103, por eso batería/inventory/modo transparente fallaban.)
const DEFAULT_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const DEFAULT_NOTIFY_UUID = '0000ffe4-0000-1000-8000-00805f9b34fb';
const DEFAULT_WRITE_UUID = '0000ffe3-0000-1000-8000-00805f9b34fb';

export default function ConfiguracionScreen() {
  const { session } = useSession();
  const [serviceUuid, setServiceUuid] = useState(DEFAULT_SERVICE_UUID);
  const [notifyUuid, setNotifyUuid] = useState(DEFAULT_NOTIFY_UUID);
  const [writeUuid, setWriteUuid] = useState(DEFAULT_WRITE_UUID);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<ChafonDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connection, setConnection] = useState<'connected' | 'disconnected'>('disconnected');
  const [connectedDevice, setConnectedDevice] = useState<ChafonDevice | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const lastAddressRef = useRef<string | null>(null);
  const userDisconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  // Una sola cadena de reintentos a la vez: el nativo puede emitir "disconnected" desde varios
  // lugares (watchdog, onBleDisconnect, onConnectDone fallido) y cada evento arrancaba su propia
  // cadena en paralelo, por eso salían 3 alertas de "Terminal desconectada".
  const reconnectChainActiveRef = useRef(false);
  // Set de waiters: antes era uno solo y cada nueva espera pisaba a la anterior, así que solo
  // la última se resolvía. Las anteriores expiraban por timeout, lanzaban otro reintento, y ese
  // reintento tiraba abajo una conexión que ya estaba funcionando (bucle de auto-desconexión).
  const connectWaitersRef = useRef<Set<(success: boolean) => void>>(new Set());

  // Espera a que llegue el próximo evento de conexión real, con timeout. connect() nativo
  // resuelve `ok:true` apenas ARRANCA el intento BLE, no cuando la conexión realmente prende —
  // sin este timeout, si el evento "connected"/"disconnected" nunca llega (stack BLE colgado),
  // el estado se quedaba en "Reconectando…" para siempre.
  function waitForConnectResult(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        connectWaitersRef.current.delete(finish);
        resolve(ok);
      };
      connectWaitersRef.current.add(finish);
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  function resolveAllConnectWaiters(ok: boolean) {
    const waiters = Array.from(connectWaitersRef.current);
    connectWaitersRef.current.clear();
    waiters.forEach((w) => w(ok));
  }

  // Potencia de antena RFID (dBm, 0-30)
  const [antennaPower, setAntennaPower] = useState(20);

  // Último valor leído (RFID o código de barras), para el cuadro de texto libre del panel de testeo
  const [lastScannedValue, setLastScannedValue] = useState('');
  const lastValueInputRef = useRef<TextInput>(null);
  const readModeRef = useRef<'rfid' | 'barcode'>('rfid');

  // Batería del equipo Chafon (vía comando + evento nativo, no el hook Web-Bluetooth)
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [batteryLoading, setBatteryLoading] = useState(false);

  // Herramienta de testeo: lectura/"radar" EPC genérico, solo para verificar en pantalla
  // lo que el lector está detectando (no queda persistido a ningún lado).
  const [testRunning, setTestRunning] = useState(false);
  const [testEpcFilter, setTestEpcFilter] = useState('');
  const [testTags, setTestTags] = useState<TestTag[]>([]);
  const testRunningRef = useRef(false);

  // URL Base dynamic config
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  const [readMode, setReadModeState] = useState<'rfid' | 'barcode'>('rfid');

  // Modo de trabajo del equipo: 0 respuesta, 1 activo, 2 gatillo. null mientras no lo sepamos.
  const [workMode, setWorkMode] = useState<number | null>(null);

  // Modo de salida del equipo: 0 HID, 1 transparente. null mientras no lo sepamos.
  const [outputMode, setOutputMode] = useState<number | null>(null);

  // Solo mostramos lectores Chafon. El resto de los BLE del entorno (auriculares, relojes,
  // direcciones random) no sirven y solo generan errores: conectarse a uno deja la app
  // reintentando contra un equipo que jamás va a exponer el servicio del lector.
  // Aceptamos por nombre (CF-H...) o por la detección del propio SDK (isCfDevice, que lee los
  // datos de fabricante del advertising), para no ocultar el lector si no publica el nombre.
  const chafonDevices = devices.filter(
    (d) => /cf-?h/i.test(d.name ?? '') || d.isCfDevice
  );
  const hiddenDevicesCount = devices.length - chafonDevices.length;

  useEffect(() => {
    testRunningRef.current = testRunning;
  }, [testRunning]);

  useEffect(() => {
    readModeRef.current = readMode;
  }, [readMode]);

  // Reconexión automática: la terminal a veces se desconecta sola de la app (sigue activa a
  // nivel Android/OS) y hay que reconectarla a mano. Reintentamos solos con backoff, salvo que
  // el usuario haya tocado "Desconectar" explícitamente (userDisconnectRef).
  async function attemptReconnect(address: string) {
    if (userDisconnectRef.current) {
      reconnectChainActiveRef.current = false;
      return;
    }
    // Si la terminal ya está operativa, cortamos la cadena: seguir reintentando reconectaría
    // encima de una conexión sana y la tiraría abajo.
    try {
      if (ChafonH103.isReady()) {
        reconnectChainActiveRef.current = false;
        reconnectAttemptsRef.current = 0;
        setReconnecting(false);
        setConnection('connected');
        return;
      }
    } catch {}
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      reconnectChainActiveRef.current = false;
      reconnectAttemptsRef.current = 0;
      setReconnecting(false);
      setConnectedDevice(null);
      Alert.alert(
        'Terminal desconectada',
        `No se pudo reconectar automáticamente con ${address}. Verificá que sea el lector Chafon (marcado con la etiqueta "Chafon" en la lista) y volvé a conectarlo.`
      );
      return;
    }
    reconnectAttemptsRef.current += 1;
    setReconnecting(true);
    const delay = RECONNECT_BASE_DELAY_MS * reconnectAttemptsRef.current;
    setTimeout(async () => {
      if (userDisconnectRef.current) return;
      try {
        await prepareConnection();
        const ok = await ChafonH103.connect(address);
        if (!ok) throw new Error('connect() devolvió false');
        // ok:true solo significa que el intento arrancó. Esperamos la confirmación real por
        // evento, con timeout, para no quedar en "Conectando…" para siempre si nunca llega.
        const confirmed = await waitForConnectResult(CONNECT_TIMEOUT_MS);
        if (!confirmed) throw new Error('timeout esperando confirmación de conexión');
      } catch {
        if (!userDisconnectRef.current) attemptReconnect(address);
      }
    }, delay);
  }

  useEffect(() => {
    getSavedApiBaseUrl().then(setApiBaseUrl).catch(() => undefined);

    const devSub = ChafonH103.addDeviceListener((dev) => {
      setDevices((prev) => {
        if (prev.some((d) => d.address === dev.address)) return prev;
        return [...prev, dev];
      });
    });

    const connSub = ChafonH103.addConnectionListener((st) => {
      resolveAllConnectWaiters(st === 'connected');
      setConnection(st);
      if (st === 'connected') {
        reconnectAttemptsRef.current = 0;
        reconnectChainActiveRef.current = false;
        setReconnecting(false);
        return;
      }
      // disconnected
      setBatteryLevel(null);
      setTestRunning(false);
      if (userDisconnectRef.current) {
        userDisconnectRef.current = false;
        setConnectedDevice(null);
        return;
      }
      const address = lastAddressRef.current;
      if (address && !reconnectChainActiveRef.current) {
        reconnectChainActiveRef.current = true;
        attemptReconnect(address);
      } else if (!address) {
        setConnectedDevice(null);
      }
    });

    const errSub = ChafonH103.addScanErrorListener((err) => {
      Alert.alert('Escaneo BLE', err.message || 'Error durante el escaneo BLE.');
    });

    const paramSub = ChafonH103.addAllParamListener((payload) => {
      // Reflejamos la potencia real del equipo. Sirve para detectar casos como el visto en
      // hardware, donde la terminal reportaba 0 dBm (RFID sin alcance: no lee ningún tag).
      if (typeof payload.power === 'number' && payload.power > 0) {
        setAntennaPower(payload.power);
      } else if (payload.power === 0) {
        setAntennaPower(0);
      }
      // Modo de trabajo del equipo, para que el botón muestre el estado real.
      if (typeof payload.workMode === 'number') {
        setWorkMode(payload.workMode);
      }
    });

    const outputSub = ChafonH103.addOutputModeListener((payload) => {
      if (typeof payload?.mode === 'number') setOutputMode(payload.mode);
    });

    const batterySub = ChafonH103.addBatteryListener((payload) => {
      setBatteryLevel(payload.level);
      setBatteryLoading(false);
    });

    const tagSub = ChafonH103.addTagListener((tag: ChafonTag) => {
      const displayValue = readModeRef.current === 'barcode' ? hexToAsciiSafe(tag.epc) : tag.epc;
      setLastScannedValue(displayValue);

      if (!testRunningRef.current) return;
      setTestTags((prev) => {
        const now = Date.now();
        const idx = prev.findIndex((t) => t.epc === tag.epc);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], rssi: tag.rssi, antenna: tag.antenna, channel: tag.channel, isMatch: tag.isMatch ?? true, count: updated[idx].count + 1, lastSeen: now };
          return updated;
        }
        return [{ epc: tag.epc, rssi: tag.rssi, antenna: tag.antenna, channel: tag.channel, isMatch: tag.isMatch ?? true, count: 1, lastSeen: now }, ...prev].slice(0, 50);
      });
    });

    return () => {
      devSub.remove();
      connSub.remove();
      errSub.remove();
      batterySub.remove();
      paramSub.remove();
      outputSub.remove();
      tagSub.remove();
    };
  }, []);

  async function requestBluetoothPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      await ChafonH103.initialize();
      return true;
    }

    const sdkInt = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

    // Android 12+ (API 31+): el escaneo BLE requiere BLUETOOTH_SCAN/BLUETOOTH_CONNECT.
    // Android < 12: el escaneo BLE requiere permiso de Ubicación (el SDK Chafon no expone
    // esos permisos nuevos, así que sin Ubicación el scan no devuelve ningún dispositivo).
    const permissions: string[] = [
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ];
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN) permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);

    const res = await PermissionsAndroid.requestMultiple(permissions as any);

    const locationGranted = res[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    const scanGranted = res[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED;
    const connectGranted = res[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;

    if (sdkInt < 31 && !locationGranted) {
      return false;
    }
    if (sdkInt >= 31 && (!scanGranted || !connectGranted)) {
      return false;
    }

    await ChafonH103.initialize();
    return true;
  }

  async function prepareConnection(s = serviceUuid, n = notifyUuid, w = writeUuid) {
    const finalS = s || DEFAULT_SERVICE_UUID;
    const finalN = n || DEFAULT_NOTIFY_UUID;
    const finalW = w || DEFAULT_WRITE_UUID;
    await ChafonH103.initialize();
    await ChafonH103.configureCharacteristics(finalS, finalN, finalW);
  }

  async function handleStartScan() {
    try {
      const granted = await requestBluetoothPermissions();
      if (!granted) {
        Alert.alert(
          'Permisos requeridos',
          'Concedé los permisos de Bluetooth y Ubicación desde Ajustes para poder detectar la terminal Chafon H103. ' +
            'Además, en Android 11 o anterior el escaneo BLE solo funciona con la Ubicación del sistema (GPS) activada.',
          [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Abrir Ajustes', onPress: () => Linking.openSettings() },
          ]
        );
        return;
      }

      if (Platform.OS === 'android' && !ChafonH103.isLocationEnabled()) {
        Alert.alert(
          'Ubicación (GPS) apagada',
          'El permiso de Ubicación está concedido, pero el switch de Ubicación del sistema está apagado. ' +
            'Android descarta el escaneo BLE en silencio en ese caso: activá la Ubicación para poder detectar la terminal.',
          [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Activar Ubicación', onPress: () => Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS') },
          ]
        );
        return;
      }

      setScanning(true);
      setDevices([]);
      await ChafonH103.scan(8000);
      setTimeout(() => setScanning(false), 8000);
    } catch (e: any) {
      setScanning(false);
      Alert.alert('Chafon BLE', e?.message ?? 'No se pudo escanear.');
    }
  }

  function handleConnectPress(device: ChafonDevice) {
    // Guarda contra el error más fácil de cometer: la lista muestra todos los BLE cercanos y
    // conectarse a uno ajeno deja a la app reintentando contra un equipo que nunca va a
    // responder (visto en logs: ciclos infinitos contra un dispositivo random).
    if (!device.isCfDevice) {
      Alert.alert(
        'No parece un lector Chafon',
        `"${device.name || 'Dispositivo sin nombre'}" (${device.address}) no fue reconocido como terminal Chafon. ` +
          'Si te conectás a un equipo que no es el lector, la app va a quedar reintentando sin éxito.',
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Conectar igual', onPress: () => handleConnect(device) },
        ]
      );
      return;
    }
    handleConnect(device);
  }

  async function handleConnect(device: ChafonDevice) {
    try {
      userDisconnectRef.current = false;
      reconnectAttemptsRef.current = 0;
      reconnectChainActiveRef.current = false;
      setReconnecting(false);
      // Cortamos el escaneo ya mismo: mantener la radio escaneando mientras se negocia la
      // conexión hace que el descubrimiento de servicios BLE nunca termine.
      try { ChafonH103.stopScan(); } catch {}
      setScanning(false);
      await prepareConnection();
      const started = await ChafonH103.connect(device.address);
      if (!started) {
        Alert.alert('CHAFON', 'No se pudo iniciar la conexión con la terminal.');
        return;
      }
      // connect() solo arranca el pipeline GATT (conexión -> descubrir servicios -> MTU ->
      // notify). El módulo nativo emite "connected" recién cuando todo eso terminó y las
      // escrituras ya funcionan; hasta entonces mostramos "Conectando…".
      setConnectedDevice(device);
      lastAddressRef.current = device.address;
      setReconnecting(true);
      const confirmed = await waitForConnectResult(CONNECT_TIMEOUT_MS);
      // Si falló pero el auto-reintento ya arrancó, lo dejamos seguir en vez de avisar y
      // cortar: el estado sigue mostrando "Conectando…" hasta que resuelva o se agote.
      if (!confirmed && reconnectAttemptsRef.current === 0) {
        setReconnecting(false);
        setConnectedDevice(null);
        Alert.alert(
          'CHAFON',
          `No se completó la conexión con ${device.name || device.address}. ` +
            'Verificá que el lector esté encendido y cerca. ' +
            'Si el equipo es el correcto y aun así falla varias veces seguidas, apagá y volvé a encender el Bluetooth del teléfono: ' +
            'el stack BLE de Android puede quedar en mal estado tras intentos fallidos.',
          [
            { text: 'Cerrar', style: 'cancel' },
            { text: 'Abrir Bluetooth', onPress: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS') },
          ]
        );
      } else if (confirmed) {
        setReconnecting(false);
      }
    } catch (e: any) {
      setReconnecting(false);
      Alert.alert('CHAFON', e?.message ?? 'No se pudo conectar.');
    }
  }

  function handleDisconnect() {
    userDisconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    reconnectChainActiveRef.current = false;
    setReconnecting(false);
    try {
      ChafonH103.disconnect();
    } catch {}
    setConnection('disconnected');
    setConnectedDevice(null);
    setBatteryLevel(null);
    setTestRunning(false);
    setReadModeState('rfid');
    lastAddressRef.current = null;
  }

  async function handleSetReadMode(mode: 'rfid' | 'barcode') {
    try {
      await ChafonH103.setReadMode(mode);
      setReadModeState(mode);
      // Foco en el cuadro de último valor leído: útil sobre todo en Barcode, para tener el
      // cursor listo ahí apenas cambia de modo.
      lastValueInputRef.current?.focus();
    } catch (e: any) {
      Alert.alert('Modo de lectura', e?.message ?? 'No se pudo cambiar el modo RFID/Barcode.');
    }
  }

  async function handleSetPower(value: number) {
    // Rango real del H103 según ficha técnica: 4 a 33 dBm (antes usábamos 0-30, incorrecto).
    const clamped = Math.max(POWER_MIN, Math.min(POWER_MAX, value));
    const previous = antennaPower;
    setAntennaPower(clamped);
    try {
      await ChafonH103.setPower(clamped);
    } catch (e: any) {
      setAntennaPower(previous);
      Alert.alert('Potencia RFID', e?.message ?? 'No se pudo cambiar la potencia de la antena.');
    }
  }

  /**
   * Alterna entre modo respuesta (0) y modo gatillo (2).
   *
   * En modo respuesta el lector sólo actúa ante comandos de la app: al apretar el gatillo hace su
   * barrido y contesta "comando completado", pero no entrega los tags por BLE. En modo gatillo el
   * disparo inicia el inventario y sí reporta las lecturas.
   */
  /**
   * Alterna el modo de salida del equipo entre HID (0x00) y transparente (0x01).
   *
   * Ojo con la intuición: el manual llama al 0x01 "transparent transmission", pero en este equipo
   * los tags llegan por BLE estando en 0x00. Tras un restore de fábrica queda en 0x00, y en ese
   * estado la app del fabricante lee sin tocar nada. Pasarlo a 0x01 hace que el inventario siga
   * contestando "comando ejecutado" sin entregar una sola trama de tag.
   * Por eso la app ya no lo cambia sola: se cambia acá, a mano, si hace falta.
   */
  async function handleToggleOutputMode() {
    const next = outputMode === 1 ? 0 : 1;
    try {
      await ChafonH103.setTransparentMode(next === 1);
      Alert.alert(
        'Modo de salida',
        next === 1
          ? 'La terminal quedó en modo transparente.'
          : 'La terminal quedó en modo HID, que es con el que este equipo entrega las lecturas por Bluetooth.'
      );
    } catch (e: any) {
      Alert.alert('Modo de salida', e?.message ?? 'No se pudo cambiar el modo de salida.');
    }
  }

  async function handleToggleWorkMode() {
    const next = workMode === 2 ? 0 : 2;
    try {
      await ChafonH103.setWorkMode(next);
      Alert.alert(
        'Modo de trabajo',
        next === 2
          ? 'La terminal quedó en modo gatillo: al apretar el gatillo empieza a inventariar y las lecturas llegan a la app.'
          : 'La terminal volvió a modo respuesta: sólo lee cuando la app se lo pide.'
      );
    } catch (e: any) {
      Alert.alert('Modo de trabajo', e?.message ?? 'No se pudo cambiar el modo de trabajo.');
    }
  }

  function handleFactoryReset() {
    Alert.alert(
      'Restaurar de fábrica',
      'Esto devuelve la terminal a su configuración original (comando RFM_REBOOT del fabricante) y la reinicia. ' +
        'Sirve para destrabarla si quedó en un modo raro, por ejemplo pegada en código de barras. ' +
        'La terminal se va a desconectar y vas a tener que volver a conectarla. ¿Continuamos?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Restaurar',
          style: 'destructive',
          onPress: async () => {
            try {
              await ChafonH103.factoryReset();
              userDisconnectRef.current = true;
              setConnection('disconnected');
              setConnectedDevice(null);
              setReadModeState('rfid');
              Alert.alert('Restaurar de fábrica', 'Comando enviado. La terminal se reinicia; esperá unos segundos y volvé a conectarla.');
            } catch (e: any) {
              Alert.alert('Restaurar de fábrica', e?.message ?? 'No se pudo enviar el comando.');
            }
          },
        },
      ]
    );
  }

  async function handleGetBattery() {
    setBatteryLoading(true);
    try {
      const level = await ChafonH103.getBattery();
      setBatteryLevel(level);
      if (level < 0) {
        Alert.alert('Batería', 'La terminal no respondió a tiempo. Probá de nuevo.');
      }
    } catch (e: any) {
      Alert.alert('Batería', e?.message ?? 'No se pudo consultar el nivel de batería.');
    } finally {
      setBatteryLoading(false);
    }
  }

  async function handleStartTest() {
    try {
      setTestTags([]);
      const filter = testEpcFilter.trim();
      if (filter) {
        await ChafonH103.startDetection(filter, 0, 100);
      } else {
        await ChafonH103.startInventory(0, 100);
      }
      setTestRunning(true);
    } catch (e: any) {
      Alert.alert('Testeo EPC', e?.message ?? 'No se pudo iniciar la lectura.');
    }
  }

  async function handleStopTest() {
    try {
      await ChafonH103.stopInventory();
      await ChafonH103.clearDetectionMask();
    } catch {}
    setTestRunning(false);
  }

  async function handleSaveApiUrl() {
    try {
      await saveApiBaseUrl(apiBaseUrl.trim());
      Alert.alert('Configuración', 'URL Base guardada. Se recomienda reiniciar la aplicación.');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'No se pudo guardar la URL Base.');
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Configuración</Text>
        <Text style={styles.buildTag}>Build #8148 (reorden del tab Stock)</Text>

        {/* Sesión de Usuario */}
        <Text style={styles.section}>Sesión de Usuario</Text>
        <View style={styles.row}>
          <Ionicons name="person-outline" size={20} color="#022449" />
          <Text style={styles.rowText}>{session?.username}</Text>
        </View>

        {/* Endpoint Config */}
        <Text style={styles.section}>URL Base del Endpoint API</Text>
        <View style={styles.urlContainer}>
          <TextInput
            style={[styles.input, { flex: 1, marginBottom: 0 }]}
            placeholder="http://192.168.68.69:8000"
            value={apiBaseUrl}
            onChangeText={setApiBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.saveUrlButton} onPress={handleSaveApiUrl}>
            <Ionicons name="save-outline" size={20} color="#fff" />
          </Pressable>
        </View>

        <Text style={styles.section}>Conexión a Terminal RFID (BLE)</Text>
        <Text style={styles.status}>
          Estado de Terminal:{' '}
          <Text style={{ fontWeight: '700', color: reconnecting ? '#f79009' : connection === 'connected' ? '#12b76a' : '#f04438' }}>
            {reconnecting ? 'Conectando…' : connection === 'connected' ? 'Conectado' : 'Desconectado'}
          </Text>
        </Text>
        {connection === 'connected' && connectedDevice && (
          <Text style={styles.linkedDeviceLabel}>
            Terminal vinculada: <Text style={{ fontWeight: '700' }}>{connectedDevice.name || 'Terminal Chafon H103'}</Text> ({connectedDevice.address})
          </Text>
        )}
        <Text style={styles.help}>Presione &quot;Buscar Terminales&quot; para detectar automáticamente el lector Chafon H103 vía BLE.</Text>

        <View style={styles.actions}>
          <Pressable style={[styles.button, scanning && styles.buttonScanning]} onPress={handleStartScan}>
            <Text style={styles.buttonText}>{scanning ? 'Buscando Terminales…' : 'Buscar Terminales BLE'}</Text>
          </Pressable>
        </View>

        {devices.length > 0 && (
          <Text style={[styles.help, { marginTop: -4 }]}>
            Solo se listan los lectores Chafon detectados. Los demás equipos BLE del entorno se ocultan.
          </Text>
        )}

        {/* Dos secciones separadas y en orden de aparición. Antes era una sola lista reordenada
            por isCfDevice: al aparecer un equipo nuevo durante el escaneo las filas se corrían y
            un toque podía caer en el dispositivo equivocado (pasó en pruebas reales). */}
        {chafonDevices.length > 0 && (
          <Text style={styles.subSectionTitle}>Terminales Chafon</Text>
        )}
        {!scanning && devices.length > 0 && chafonDevices.length === 0 && (
          <Text style={styles.help}>
            No se encontró ningún lector Chafon. Verificá que el equipo esté encendido y cerca, y volvé a escanear.
          </Text>
        )}
        {chafonDevices.map((device) => (
          <DeviceRow key={device.address} device={device} onPress={() => handleConnectPress(device)} />
        ))}

        {hiddenDevicesCount > 0 && (
          <Text style={styles.help}>
            Se ocultaron {hiddenDevicesCount} dispositivo{hiddenDevicesCount === 1 ? '' : 's'} BLE que no son lectores Chafon.
          </Text>
        )}

        {connection === 'connected' && (
          <View style={styles.connectedActions}>
            <Pressable style={styles.buttonSecondary} onPress={handleDisconnect}>
              <Ionicons name="power-outline" size={18} color="#d92d20" />
              <Text style={[styles.buttonSecondaryText, { color: '#d92d20' }]}>Desconectar</Text>
            </Pressable>

            <Pressable style={styles.buttonSecondary} onPress={handleGetBattery} disabled={batteryLoading}>
              {batteryLoading ? (
                <ActivityIndicator size="small" color="#0b63ce" />
              ) : (
                <Ionicons name="battery-charging-outline" size={18} color="#0b63ce" />
              )}
              <Text style={styles.buttonSecondaryText}>
                {batteryLevel != null && batteryLevel >= 0 ? `Batería: ${batteryLevel}%` : 'Batería'}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.buttonSecondary, readMode === 'rfid' && styles.buttonActive]}
              onPress={() => handleSetReadMode('rfid')}
            >
              <Ionicons name="radio-outline" size={18} color={readMode === 'rfid' ? '#fff' : '#0b63ce'} />
              <Text style={[styles.buttonSecondaryText, readMode === 'rfid' && styles.buttonActiveText]}>RFID</Text>
            </Pressable>

            <Pressable
              style={[styles.buttonSecondary, readMode === 'barcode' && styles.buttonActive]}
              onPress={() => handleSetReadMode('barcode')}
            >
              <Ionicons name="barcode-outline" size={18} color={readMode === 'barcode' ? '#fff' : '#0b63ce'} />
              <Text style={[styles.buttonSecondaryText, readMode === 'barcode' && styles.buttonActiveText]}>Barcode</Text>
            </Pressable>

            <Pressable style={styles.buttonSecondary} onPress={handleToggleOutputMode}>
              <Ionicons name="swap-horizontal-outline" size={18} color="#0b63ce" />
              <Text style={styles.buttonSecondaryText}>
                Salida: {outputMode === 1 ? 'Transparente' : outputMode === 0 ? 'HID' : '—'}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.buttonSecondary, workMode === 2 && styles.buttonActive]}
              onPress={handleToggleWorkMode}
            >
              <Ionicons name="flash-outline" size={18} color={workMode === 2 ? '#fff' : '#0b63ce'} />
              <Text style={[styles.buttonSecondaryText, workMode === 2 && styles.buttonActiveText]}>
                {workMode === 2 ? 'Modo gatillo activo' : 'Activar modo gatillo'}
              </Text>
            </Pressable>

            <Pressable style={styles.buttonSecondary} onPress={handleFactoryReset}>
              <Ionicons name="refresh-outline" size={18} color="#d92d20" />
              <Text style={[styles.buttonSecondaryText, { color: '#d92d20' }]}>Restaurar de fábrica</Text>
            </Pressable>
          </View>
        )}

        {connection === 'connected' && (
          <>
            <Text style={styles.section}>Potencia de Antena RFID</Text>
            <View style={styles.powerRow}>
              <Pressable style={styles.powerStepButton} onPress={() => handleSetPower(antennaPower - 2)}>
                <Ionicons name="remove" size={20} color="#0b63ce" />
              </Pressable>
              <Text style={styles.powerValue}>{antennaPower} dBm</Text>
              <Pressable style={styles.powerStepButton} onPress={() => handleSetPower(antennaPower + 2)}>
                <Ionicons name="add" size={20} color="#0b63ce" />
              </Pressable>
            </View>
            <Text style={styles.help}>Rango {POWER_MIN}-{POWER_MAX} dBm. Bajala si detecta tags de más lejos de lo que necesitás.</Text>
          </>
        )}

        {connection === 'connected' && (
          <>
            <Text style={styles.section}>Herramientas de Testeo RFID (EPC)</Text>
            <Text style={styles.help}>
              Lee EPCs crudos detectados por el lector para verificar en pantalla que está funcionando. Dejá el campo vacío
              para ver todo lo que detecta, o cargá un EPC para modo &quot;radar&quot; (resalta solo las coincidencias).
            </Text>
            <View style={styles.urlContainer}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                placeholder="EPC objetivo (opcional, HEX)"
                value={testEpcFilter}
                onChangeText={setTestEpcFilter}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!testRunning}
              />
            </View>
            <View style={styles.actions}>
              {testRunning ? (
                <Pressable style={[styles.button, { backgroundColor: '#d92d20' }]} onPress={handleStopTest}>
                  <Text style={styles.buttonText}>Detener Lectura</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.button} onPress={handleStartTest}>
                  <Text style={styles.buttonText}>Iniciar Lectura EPC (Test)</Text>
                </Pressable>
              )}
            </View>

            <Text style={[styles.subSectionTitle, { marginTop: 10 }]}>Último valor leído (RFID o código de barras)</Text>
            <TextInput
              ref={lastValueInputRef}
              style={[styles.input, { fontFamily: 'monospace' }]}
              value={lastScannedValue}
              onChangeText={setLastScannedValue}
              placeholder={testRunning ? 'Esperando lectura…' : 'Sin lecturas todavía.'}
              autoCapitalize="characters"
            />

            {testTags.length > 0 && (
              <View style={styles.testTagsContainer}>
                {testTags.map((t) => (
                  <View key={t.epc} style={[styles.testTagRow, t.isMatch && testEpcFilter.trim() && styles.testTagRowMatch]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.testTagEpc}>{t.epc}</Text>
                      <Text style={styles.testTagMeta}>
                        RSSI {t.rssi} · Antena {t.antenna} · Canal {t.channel} · x{t.count}
                      </Text>
                    </View>
                    {testEpcFilter.trim() ? (
                      <View style={[styles.bondedBadge, t.isMatch ? { borderColor: '#a6f4c5', backgroundColor: '#ecfdf3' } : undefined]}>
                        <Text style={[styles.bondedText, t.isMatch ? { color: '#12b76a' } : undefined]}>
                          {t.isMatch ? 'Match' : 'Sin match'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>
            )}
          </>
        )}

      </ScrollView>
    </Screen>
  );
}

function DeviceRow({ device, onPress }: { device: ChafonDevice; onPress: () => void }) {
  return (
    <Pressable style={styles.deviceCard} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={styles.deviceName}>
            {device.name || (device.isCfDevice ? 'Terminal Chafon H103' : 'Dispositivo BLE sin nombre')}
          </Text>
          {device.isCfDevice && (
            <View style={[styles.bondedBadge, { borderColor: '#b2ddff', backgroundColor: '#eff8ff' }]}>
              <Text style={[styles.bondedText, { color: '#0b63ce' }]}>Chafon</Text>
            </View>
          )}
          {device.isBonded && (
            <View style={styles.bondedBadge}>
              <Text style={styles.bondedText}>Vinculado</Text>
            </View>
          )}
        </View>
        <Text style={styles.deviceAddress}>
          {device.address} {device.rssi ? `· RSSI ${device.rssi}` : ''}
        </Text>
      </View>
      <View style={styles.connectBadge}>
        <Text style={styles.connectBadgeText}>Conectar</Text>
        <Ionicons name="chevron-forward" size={16} color="#0b63ce" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: 40 },
  actions: { flexDirection: 'row', gap: 8 },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#0b63ce', flex: 1 },
  secondaryText: { color: '#0b63ce', fontWeight: '700' },
  device: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 10, marginTop: 8 },
  deviceName: { fontWeight: '600', color: '#101828' },
  deviceMeta: { fontSize: 11, color: '#667085', marginTop: 3 },
  title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 4 },
  buildTag: { fontSize: 11, fontWeight: '700', color: '#0b63ce', marginTop: 2 },
  section: { fontSize: 15, fontWeight: '700', color: '#344054', marginTop: 24, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 13, borderRadius: 10, marginBottom: 7 },
  rowText: { marginLeft: 10, color: '#344054' },
  status: { color: '#475467', marginBottom: 4, marginTop: 10 },
  help: { color: '#667085', fontSize: 12, marginBottom: 10 },
  input: { height: 46, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 10, paddingHorizontal: 12, marginBottom: 9 },
  button: { flex: 1, height: 46, backgroundColor: '#0b63ce', borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  buttonText: { color: '#fff', fontWeight: '700' },
  logout: { backgroundColor: '#fff1f0', marginTop: 20 },
  logoutText: { color: '#d92d20', fontWeight: '700' },
  urlContainer: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 10 },
  saveUrlButton: { backgroundColor: '#0b63ce', width: 46, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  bondedBadge: { backgroundColor: '#eff8ff', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: '#b2ddff' },
  bondedText: { fontSize: 10, fontWeight: '700', color: '#0b63ce' },
  toolsContainer: { flexDirection: 'row', gap: 10, marginTop: 5 },
  toolButton: { flex: 1, backgroundColor: '#fff', padding: 12, borderRadius: 10, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#eaecf0' },
  toolButtonText: { fontSize: 12, fontWeight: '600', color: '#344054' },
  toolVal: { fontSize: 11, color: '#0b63ce', marginTop: 2 },

  // New Chafon BLE Status & Button Styles
  statusCard: { padding: 14, borderRadius: 12, borderWidth: 1, marginTop: 4, marginBottom: 10 },
  statusCardConnected: { backgroundColor: '#ecfdf3', borderColor: '#a6f4c5' },
  statusCardDisconnected: { backgroundColor: '#fef3f2', borderColor: '#fda29b' },
  statusHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusTitle: { fontSize: 14, fontWeight: '800', color: '#101828' },
  statusDetails: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)', gap: 4 },
  statusDetailText: { fontSize: 13, color: '#344054' },
  errorCard: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fef3f2', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#fda29b', marginBottom: 10 },
  errorText: { fontSize: 12, color: '#b42318', flex: 1 },
  actionsRow: { marginTop: 6, marginBottom: 12 },
  buttonPrimary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, backgroundColor: '#0b63ce', borderRadius: 10 },
  buttonScanning: { backgroundColor: '#344054' },
  buttonPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  connectedActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  buttonSecondary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd' },
  buttonSecondaryText: { fontSize: 13, fontWeight: '600', color: '#0b63ce' },
  buttonActive: { backgroundColor: '#0b63ce', borderColor: '#0b63ce' },
  buttonActiveText: { color: '#fff' },
  devicesContainer: { marginTop: 10 },
  subSectionTitle: { fontSize: 14, fontWeight: '700', color: '#344054', marginBottom: 8 },
  deviceCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#eaecf0', marginBottom: 8 },
  deviceAddress: { fontSize: 11, color: '#667085', marginTop: 2 },
  connectBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#eff8ff', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#b2ddff' },
  connectBadgeText: { fontSize: 11, fontWeight: '700', color: '#0b63ce' },
  linkedDeviceLabel: { color: '#344054', fontSize: 12, marginTop: 2 },

  testTagsContainer: { marginTop: 10, gap: 6 },
  testTagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#eaecf0' },
  testTagRowMatch: { borderColor: '#a6f4c5', backgroundColor: '#f6fffa' },
  testTagEpc: { fontSize: 12, fontWeight: '700', color: '#101828', fontFamily: 'monospace' },
  testTagMeta: { fontSize: 11, color: '#667085', marginTop: 2 },

  powerRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 4 },
  powerStepButton: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd', alignItems: 'center', justifyContent: 'center' },
  powerValue: { fontSize: 18, fontWeight: '700', color: '#101828', minWidth: 70, textAlign: 'center' },
});
