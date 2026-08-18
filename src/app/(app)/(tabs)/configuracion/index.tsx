import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Alert, PermissionsAndroid, Pressable, StyleSheet, Text, TextInput, View, ScrollView, ActivityIndicator } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';
import { getSavedApiBaseUrl, saveApiBaseUrl } from '@/services/api';
import { useChafonH103 } from '../../../../../react_chafon_sdk/useChafonH103';

const DEFAULT_SERVICE_UUID = '0000fee7-0000-1000-8000-00805f9b34fb';
const DEFAULT_NOTIFY_UUID = '000036f1-0000-1000-8000-00805f9b34fb';
const DEFAULT_WRITE_UUID = '000036f2-0000-1000-8000-00805f9b34fb';

export default function ConfiguracionScreen() {
  const { session } = useSession();
  const [serviceUuid, setServiceUuid] = useState(DEFAULT_SERVICE_UUID);
  const [notifyUuid, setNotifyUuid] = useState(DEFAULT_NOTIFY_UUID);
  const [writeUuid, setWriteUuid] = useState(DEFAULT_WRITE_UUID);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<ChafonDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connection, setConnection] = useState('disconnected');

  // URL Base dynamic config
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  const {
    isConnected,
    isScanning,
    batteryLevel,
    scannedDevices,
    keyState,
    readMode,
    error,
    startScan,
    stopScan,
    connect,
    disconnect,
    getBatteryLevel,
    setReadMode,
  } = useChafonH103();

  useEffect(() => {
    getSavedApiBaseUrl().then(setApiBaseUrl).catch(() => undefined);
  }, []);

  async function requestBluetoothPermissions() {
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN && PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
      } catch {
        // Ignore permission request errors if already granted at OS level
      }
    }
    try {
      await ChafonH103.initialize();
    } catch {
      // Ignore native module re-initialization errors
    }
  }

  async function prepareConnection(s = serviceUuid, n = notifyUuid, w = writeUuid) {
    const finalS = s || DEFAULT_SERVICE_UUID;
    const finalN = n || DEFAULT_NOTIFY_UUID;
    const finalW = w || DEFAULT_WRITE_UUID;
    await initialize();
    await ChafonH103.configureCharacteristics(finalS, finalN, finalW);
  }

  async function handleStartScan() {
    try {
      await requestBluetoothPermissions();
      if (isScanning) {
        await stopScan();
      } else {
        await startScan();
      }
    } catch (e: any) {
      Alert.alert('Chafon BLE', e?.message ?? 'No se pudo escanear.');
    }
  }

  async function handleConnect(device: any) {
    try {
      await prepareConnection();
      Alert.alert('CHAFON', 'SDK inicializado.');
    } catch (e: any) {
      Alert.alert('Chafon Terminal', e?.message ?? 'Error de conexión.');
    }
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
          Estado de Terminal: <Text style={{ fontWeight: '700', color: isConnected ? '#12b76a' : '#f04438' }}>{isConnected ? 'Conectado' : 'Desconectado'}</Text>
        </Text>
        <Text style={styles.help}>Presione &quot;Buscar Terminales&quot; para detectar automáticamente el lector Chafon H103 vía BLE.</Text>

        <View style={styles.actions}>
          <Pressable style={[styles.button, isScanning && styles.buttonScanning]} onPress={handleStartScan}>
            <Text style={styles.buttonText}>{isScanning ? 'Buscando Terminales…' : 'Buscar Terminales BLE'}</Text>
          </Pressable>
        </View>

        {isConnected && (
          <View style={styles.connectedActions}>
            <Pressable style={styles.buttonSecondary} onPress={disconnect}>
              <Ionicons name="power-outline" size={18} color="#d92d20" />
              <Text style={[styles.buttonSecondaryText, { color: '#d92d20' }]}>Desconectar</Text>
            </Pressable>

            <Pressable style={styles.buttonSecondary} onPress={getBatteryLevel}>
              <Ionicons name="battery-charging-outline" size={18} color="#0b63ce" />
              <Text style={styles.buttonSecondaryText}>Batería</Text>
            </Pressable>

            <Pressable
              style={[styles.buttonSecondary, readMode === 'rfid' && styles.buttonActive]}
              onPress={() => setReadMode('rfid')}
            >
              <Ionicons name="radio-outline" size={18} color={readMode === 'rfid' ? '#fff' : '#0b63ce'} />
              <Text style={[styles.buttonSecondaryText, readMode === 'rfid' && styles.buttonActiveText]}>RFID</Text>
            </Pressable>

            <Pressable
              style={[styles.buttonSecondary, readMode === 'barcode' && styles.buttonActive]}
              onPress={() => setReadMode('barcode')}
            >
              <Ionicons name="barcode-outline" size={18} color={readMode === 'barcode' ? '#fff' : '#0b63ce'} />
              <Text style={[styles.buttonSecondaryText, readMode === 'barcode' && styles.buttonActiveText]}>Barcode</Text>
            </Pressable>
          </View>
        )}

        {/* Dispositivos Escaneados */}
        {!isConnected && scannedDevices.length > 0 && (
          <View style={styles.devicesContainer}>
            <Text style={styles.subSectionTitle}>Dispositivos detectados:</Text>
            {scannedDevices.map((dev) => (
              <Pressable
                key={dev.address}
                style={styles.deviceCard}
                onPress={() => handleConnect(dev)}
              >
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.deviceName}>{dev.name || 'Terminal Chafon H103'}</Text>
                  </View>
                  <Text style={styles.deviceAddress}>{dev.address}</Text>
                </View>
                <View style={styles.connectBadge}>
                  <Text style={styles.connectBadgeText}>Emparejar</Text>
                  <Ionicons name="chevron-forward" size={16} color="#0b63ce" />
                </View>
              </Pressable>
            ))}
          </View>
        )}
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
  connectBadgeText: { fontSize: 11, fontWeight: '700', color: '#0b63ce' }
});
