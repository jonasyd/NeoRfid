import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Alert, PermissionsAndroid, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '@/components/Screen';
import ChafonH103, { type ChafonDevice } from '@modules/chafon-h103';
import { useSession } from '@/context/SessionContext';

export default function ConfiguracionScreen() {
  const { session, signOut } = useSession();
  const [serviceUuid, setServiceUuid] = useState('');
  const [notifyUuid, setNotifyUuid] = useState('');
  const [writeUuid, setWriteUuid] = useState('');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<ChafonDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connection, setConnection] = useState('disconnected');

  useEffect(() => {
    ChafonH103.isSupported().then(setSupported).catch(() => setSupported(false));
    const deviceSub = ChafonH103.addDeviceListener((device) => {
      if (!device.address) return;
      setDevices((current) => current.some((d) => d.address === device.address) ? current.map((d) => d.address === device.address ? device : d) : [...current, device]);
    });
    const connectionSub = ChafonH103.addConnectionListener((state) => setConnection(state));
    return () => { deviceSub.remove(); connectionSub.remove(); ChafonH103.stopScan(); };
  }, []);

  async function initialize() {
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN && PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
      const result = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
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

  return (
    <Screen>
      <Text style={styles.title}>Configuración</Text>
      <Text style={styles.section}>Sesión</Text>
      <View style={styles.row}><Ionicons name="person-outline" size={20} color="#667085" /><Text style={styles.rowText}>{session?.username}</Text></View>
      <View style={styles.row}><Ionicons name="business-outline" size={20} color="#667085" /><Text style={styles.rowText}>{session?.depositoSeleccionado?.deposito ?? 'Sin depósito'}</Text></View>

      <Text style={styles.section}>CHAFON H103</Text>
      <Text style={styles.status}>SDK Android: {supported === null ? 'consultando…' : supported ? 'compatible' : 'no disponible'}</Text>
      <Text style={styles.help}>Los UUID BLE deben confirmarse con el H103/firmware.</Text>
      <TextInput style={styles.input} placeholder="Service UUID" value={serviceUuid} onChangeText={setServiceUuid} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Notify Characteristic UUID" value={notifyUuid} onChangeText={setNotifyUuid} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Write Characteristic UUID" value={writeUuid} onChangeText={setWriteUuid} autoCapitalize="none" />
      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={scan}><Text style={styles.buttonText}>{scanning ? 'Buscando…' : 'Buscar H103'}</Text></Pressable>
        <Pressable style={[styles.button, styles.secondary]} onPress={connect}><Text style={styles.secondaryText}>Inicializar</Text></Pressable>
      </View>
      <Text style={styles.status}>Conexión: {connection}</Text>
      {devices.map((device) => (
        <Pressable key={device.address} style={styles.device} onPress={async () => { try { await prepareConnection(); await ChafonH103.connect(device.address); } catch (e: any) { Alert.alert('CHAFON', e?.message ?? 'No se pudo conectar.'); } }}>
          <View style={{ flex: 1 }}><Text style={styles.deviceName}>{device.name || 'Dispositivo sin nombre'}</Text><Text style={styles.deviceMeta}>{device.address} · RSSI {device.rssi}{device.isCfDevice ? ' · CHAFON' : ''}</Text></View>
          <Ionicons name="bluetooth-outline" size={22} color="#0b63ce" />
        </Pressable>
      ))}

      <Pressable style={[styles.button, styles.logout]} onPress={() => signOut()}><Text style={styles.logoutText}>Salir</Text></Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({ actions: { flexDirection: 'row', gap: 8 }, secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#0b63ce', flex: 1 }, secondaryText: { color: '#0b63ce', fontWeight: '700' }, device: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 10, marginTop: 8 }, deviceName: { fontWeight: '600', color: '#101828' }, deviceMeta: { fontSize: 11, color: '#667085', marginTop: 3 }, title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 4 }, section: { fontSize: 15, fontWeight: '700', color: '#344054', marginTop: 24, marginBottom: 10 }, row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 13, borderRadius: 10, marginBottom: 7 }, rowText: { marginLeft: 10, color: '#344054' }, status: { color: '#475467', marginBottom: 4 }, help: { color: '#667085', fontSize: 12, marginBottom: 10 }, input: { height: 46, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 10, paddingHorizontal: 12, marginBottom: 9 }, button: { flex: 1, height: 46, backgroundColor: '#0b63ce', borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 5 }, buttonText: { color: '#fff', fontWeight: '700' }, logout: { backgroundColor: '#fff1f0', marginTop: 20 }, logoutText: { color: '#d92d20', fontWeight: '700' } });
