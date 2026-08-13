import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Alert, PermissionsAndroid, Pressable, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';
import { Screen } from '@/components/Screen';
import ChafonH103, { type ChafonDevice } from '@modules/chafon-h103';
import { useSession } from '@/context/SessionContext';
import { getSavedApiBaseUrl, saveApiBaseUrl } from '@/services/api';

export default function ConfiguracionScreen() {
  const { session, signOut } = useSession();
  const [serviceUuid, setServiceUuid] = useState('');
  const [notifyUuid, setNotifyUuid] = useState('');
  const [writeUuid, setWriteUuid] = useState('');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<ChafonDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connection, setConnection] = useState('disconnected');

  // URL Base dynamic config
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  // SDK Tools state
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<string | null>(null);

  useEffect(() => {
    // Cargar la URL Base guardada
    getSavedApiBaseUrl().then(setApiBaseUrl).catch(() => undefined);

    // Cargar soporte de Chafon de forma segura
    try {
      const isSup = ChafonH103.isSupported();
      if (isSup && typeof (isSup as any).then === 'function') {
        (isSup as any).then((res: any) => setSupported(!!res)).catch(() => setSupported(false));
      } else {
        setTimeout(() => setSupported(!!isSup), 0);
      }
    } catch {
      setTimeout(() => setSupported(false), 0);
    }

    const deviceSub = ChafonH103.addDeviceListener((device) => {
      if (!device.address) return;
      setDevices((current) =>
        current.some((d) => d.address === device.address)
          ? current.map((d) => d.address === device.address ? device : d)
          : [...current, device]
      );
    });

    const connectionSub = ChafonH103.addConnectionListener((state) => setConnection(state));

    return () => {
      deviceSub.remove();
      connectionSub.remove();
      ChafonH103.stopScan();
    };
  }, []);

  async function initialize() {
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN && PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
      ]);
      const granted = Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED);
      if (!granted) throw new Error('Concedé los permisos Bluetooth y volvé a intentar.');
    }
    await ChafonH103.initialize();
  }

  async function prepareConnection() {
    if (!serviceUuid || !notifyUuid || !writeUuid) throw new Error('Completá los tres UUID BLE del H103.');
    await initialize();
    await ChafonH103.configureCharacteristics(serviceUuid, notifyUuid, writeUuid);
  }

  async function scan() {
    try {
      await initialize();
      setDevices([]);
      setScanning(true);
      await ChafonH103.scan(7000);
      setTimeout(() => setScanning(false), 7200);
    } catch (e: any) {
      setScanning(false);
      Alert.alert('CHAFON', e?.message ?? 'No se pudo iniciar el escaneo.');
    }
  }

  async function connect() {
    try {
      await prepareConnection();
      Alert.alert('CHAFON', 'SDK inicializado y UUID configurados.');
    } catch (e: any) {
      Alert.alert('CHAFON', e?.message ?? 'No se pudo inicializar.');
    }
  }

  async function handleSaveApiUrl() {
    try {
      await saveApiBaseUrl(apiBaseUrl.trim());
      Alert.alert('Configuración', 'Debe reiniciar la app');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'No se pudo guardar la URL Base.');
    }
  }

  // SDK Tools functions
  async function fetchBattery() {
    try {
      const level = await ChafonH103.getBattery();
      setBatteryLevel(level);
      Alert.alert('Herramientas Chafon', `Nivel de Batería: ${level}%`);
    } catch (e: any) {
      Alert.alert('Herramientas Chafon', e?.message ?? 'No se pudo leer la batería.');
    }
  }

  async function fetchDeviceInfo() {
    try {
      const info = await ChafonH103.getDeviceInfo();
      const infoStr = JSON.stringify(info, null, 2);
      setDeviceInfo(infoStr);
      Alert.alert('Herramientas Chafon', `Info de Dispositivo:\n${infoStr}`);
    } catch (e: any) {
      Alert.alert('Herramientas Chafon', e?.message ?? 'No se pudo leer la información del dispositivo.');
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Configuración</Text>

        <Text style={styles.section}>Sesión</Text>
        <View style={styles.row}>
          <Ionicons name="person-outline" size={20} color="#667085" />
          <Text style={styles.rowText}>{session?.username}</Text>
        </View>
        <View style={styles.row}>
          <Ionicons name="business-outline" size={20} color="#667085" />
          <Text style={styles.rowText}>{session?.depositoSeleccionado?.nombre ?? 'Sin depósito'}</Text>
        </View>

        <Text style={styles.section}>URL Base del Endpoint</Text>
        <View style={styles.urlContainer}>
          <TextInput
            style={[styles.input, { flex: 1, marginBottom: 0 }]}
            placeholder="https://api.tuservicio.com"
            value={apiBaseUrl}
            onChangeText={setApiBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.saveUrlButton} onPress={handleSaveApiUrl}>
            <Ionicons name="save-outline" size={20} color="#fff" />
          </Pressable>
        </View>

        <Text style={styles.section}>CHAFON H103 - Configuración BLE</Text>
        <Text style={styles.status}>
          SDK Android: {supported === null ? 'consultando…' : supported ? 'compatible' : 'no disponible'}
        </Text>
        <Text style={styles.help}>Los UUID BLE deben confirmarse con el H103/firmware.</Text>
        <TextInput style={styles.input} placeholder="Service UUID" value={serviceUuid} onChangeText={setServiceUuid} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Notify Characteristic UUID" value={notifyUuid} onChangeText={setNotifyUuid} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Write Characteristic UUID" value={writeUuid} onChangeText={setWriteUuid} autoCapitalize="none" />

        <View style={styles.actions}>
          <Pressable style={styles.button} onPress={scan}>
            <Text style={styles.buttonText}>{scanning ? 'Buscando…' : 'Buscar H103'}</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondary]} onPress={connect}>
            <Text style={styles.secondaryText}>Inicializar</Text>
          </Pressable>
        </View>

        <Text style={styles.status}>Conexión: {connection}</Text>

        {devices.map((device) => (
          <Pressable
            key={device.address}
            style={styles.device}
            onPress={async () => {
              try {
                await prepareConnection();
                await ChafonH103.connect(device.address);
              } catch (e: any) {
                Alert.alert('CHAFON', e?.message ?? 'No se pudo conectar.');
              }
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>{device.name || 'Dispositivo sin nombre'}</Text>
              <Text style={styles.deviceMeta}>
                {device.address} · RSSI {device.rssi}{device.isCfDevice ? ' · CHAFON' : ''}
              </Text>
            </View>
            <Ionicons name="bluetooth-outline" size={22} color="#0b63ce" />
          </Pressable>
        ))}

        <Text style={styles.section}>Herramientas del SDK (SDK Tools)</Text>
        <View style={styles.toolsContainer}>
          <Pressable style={styles.toolButton} onPress={fetchBattery}>
            <Ionicons name="battery-charging-outline" size={22} color="#475467" />
            <Text style={styles.toolButtonText}>Ver Batería</Text>
            {batteryLevel !== null && <Text style={styles.toolVal}>Batería: {batteryLevel}%</Text>}
          </Pressable>
          <Pressable style={styles.toolButton} onPress={fetchDeviceInfo}>
            <Ionicons name="information-circle-outline" size={22} color="#475467" />
            <Text style={styles.toolButtonText}>Info Dispositivo</Text>
            {deviceInfo !== null && <Text style={styles.toolVal} numberOfLines={1}>Cargado</Text>}
          </Pressable>
        </View>

        <Pressable style={[styles.button, styles.logout]} onPress={() => signOut()}>
          <Text style={styles.logoutText}>Salir</Text>
        </Pressable>
      </ScrollView>
    </Screen>
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
  toolsContainer: { flexDirection: 'row', gap: 10, marginTop: 5 },
  toolButton: { flex: 1, backgroundColor: '#fff', padding: 12, borderRadius: 10, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#eaecf0' },
  toolButtonText: { fontSize: 12, fontWeight: '600', color: '#344054' },
  toolVal: { fontSize: 11, color: '#0b63ce', marginTop: 2 }
});
