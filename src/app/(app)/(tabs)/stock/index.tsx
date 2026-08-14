import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { getStock, searchModels, getSession } from '@/services/api';
import { buildEpc, type EpcDetectionMode } from '@/services/epc';
import type { SearchResult, StockRow, Deposito } from '@/types/api';
import ChafonH103, { type ChafonTag } from '@modules/chafon-h103';
import { useSession } from '@/context/SessionContext';

const MIN_SEARCH = 3;
const DEBOUNCE_MS = 350;

type DetectionState = { mode: EpcDetectionMode; epc: string; running: boolean; lastTag?: ChafonTag } | null;

export default function StockScreen() {
  const { session, setDeposito } = useSession();
  const [query, setQuery] = useState('');

  // 'text' para buscar por query, 'barcode' para buscar por sku
  const [searchMode, setSearchMode] = useState<'text' | 'barcode'>('text');

  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [selectedSku, setSelectedSku] = useState('');
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingStock, setLoadingStock] = useState(false);
  const [error, setError] = useState('');
  const [detection, setDetection] = useState<DetectionState>(null);

  // Dropdown de depósitos
  const [showDepositDropdown, setShowDepositDropdown] = useState(false);

  // Calibración de potencia (0 - 30 dBm)
  const [rfidPower, setRfidPower] = useState(20);

  const requestId = useRef(0);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    const sub = ChafonH103.addTagListener((tag: ChafonTag) => {
      setDetection((current) => current ? { ...current, lastTag: tag } : current);
    });
    return () => sub.remove();
  }, []);

  // Búsqueda incremental con Debounce (solo si el modo es 'text')
  useEffect(() => {
    if (searchMode !== 'text') return;

    if (query.trim().length < MIN_SEARCH) {
      setTimeout(() => {
        setSuggestions([]);
        setError('');
      }, 0);
      return;
    }

    const timer = setTimeout(async () => {
      const id = ++requestId.current;
      setLoadingSearch(true);
      setError('');
      try {
        const data = await searchModels({ query: query.trim() });
        if (id === requestId.current) setSuggestions(data);
      } catch (e: any) {
        if (id === requestId.current) setError(e?.response?.data?.message ?? e?.message ?? 'No se pudo realizar la búsqueda.');
      } finally {
        if (id === requestId.current) setLoadingSearch(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, searchMode]);

  async function loadStockForSku(sku: string) {
    setLoadingStock(true);
    setError('');
    try {
      const data = await getStock(sku, true);
      setStock(data);
    } catch (e: any) {
      setStock([]);
      setError(e?.response?.data?.message ?? e?.message ?? 'No se pudo consultar stock.');
    } finally {
      setLoadingStock(false);
    }
  }

  // Si cambia el depósito seleccionado o el SKU activo, volver a cargar el stock
  const activeDepositUuid = session?.depositoSeleccionado?.uuid;
  useEffect(() => {
    if (selectedSku) {
      const timer = setTimeout(() => {
        loadStockForSku(selectedSku);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activeDepositUuid, selectedSku]);

  async function loadSku(sku: string) {
    setSelectedSku(sku);
    setQuery(sku);
    setSuggestions([]);
    await loadStockForSku(sku);
  }

  // Activa la lectura 2D enfoca el campo de texto y cambia a modo barcode
  async function handleBarcodeSearch() {
    setSearchMode('barcode');
    setQuery('');
    setSuggestions([]);
    setStock([]);
    setSelectedSku('');
    setError('');
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }

  // Ejecuta la búsqueda enviando SKU en el body
  async function handleSkuScanSubmit() {
    const sku = query.trim();
    if (!sku) return;
    setLoadingSearch(true);
    setSuggestions([]);
    setError('');
    try {
      const results = await searchModels({ sku });
      setSuggestions(results);
      if (results.length === 1) {
        const detectedSku = extractSku(results[0].model) ?? sku;
        await loadSku(detectedSku);
      } else if (results.length === 0) {
        // Si no se encuentra un modelo, intentamos consultar el stock directamente con ese SKU
        await loadSku(sku);
      }
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'No se pudo buscar el SKU.');
    } finally {
      setLoadingSearch(false);
    }
  }

  async function handleSelect(result: SearchResult) {
    const sku = extractSku(result.model);
    if (!sku) {
      setError('La respuesta de search no contiene un SKU reconocible.');
      return;
    }
    await loadSku(sku);
  }

  async function startDetection(row: StockRow, mode: EpcDetectionMode) {
    try {
      const sess = getSession();
      if (!sess?.brandPrefix) throw new Error('No hay brandPrefix en la sesión.');
      const epc = buildEpc({
        brandPrefix: sess.brandPrefix,
        modelrfid: row.modelrfid,
        modelcolrfid: row.modelcolrfid,
        modelsizfid: row.modelsizfid,
      }, mode).epc;
      await ChafonH103.startDetection(epc, 0, 100);
      setDetection({ mode, epc, running: true });
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo iniciar la detección RFID.');
    }
  }

  async function stopDetection() {
    try {
      await ChafonH103.stopInventory();
      await ChafonH103.clearDetectionMask();
    } finally {
      setDetection(null);
    }
  }

  // Cambiar depósito de forma reactiva
  async function handleSelectDeposit(dep: Deposito) {
    try {
      await setDeposito(dep);
      setShowDepositDropdown(false);
    } catch {
      setError('No se pudo cambiar de depósito.');
    }
  }

  // Calibración de potencia RFID Chafon (+/-)
  function adjustPower(amount: number) {
    setRfidPower((prev) => {
      const next = prev + amount;
      return Math.max(0, Math.min(30, next));
    });
  }

  return (
    <Screen>
      <Text style={styles.title}>BÚSQUEDA DE ITEMS</Text>

      {/* Selector de Depósitos (Combo Box Customizado) */}
      <View style={styles.depositContainer}>
        <Text style={styles.depositLabel}>Seleccione un depósito:</Text>
        <Pressable
          style={styles.depositPicker}
          onPress={() => setShowDepositDropdown(!showDepositDropdown)}
        >
          <Text style={styles.depositPickerText}>
            {session?.depositoSeleccionado?.nombre ?? 'Seleccionar Depósito'}
          </Text>
          <Ionicons
            name={showDepositDropdown ? "chevron-up" : "chevron-down"}
            size={20}
            color="#475467"
          />
        </Pressable>

        {showDepositDropdown && (
          <View style={styles.dropdownList}>
            {(session?.depositos ?? []).map((dep) => (
              <Pressable
                key={dep.uuid}
                style={[
                  styles.dropdownItem,
                  session?.depositoSeleccionado?.uuid === dep.uuid && styles.dropdownItemActive
                ]}
                onPress={() => handleSelectDeposit(dep)}
              >
                <Text
                  style={[
                    styles.dropdownItemText,
                    session?.depositoSeleccionado?.uuid === dep.uuid && styles.dropdownItemTextActive
                  ]}
                >
                  {dep.nombre}
                </Text>
                {session?.depositoSeleccionado?.uuid === dep.uuid && (
                  <Ionicons name="checkmark" size={18} color="#0b63ce" />
                )}
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* Sección de Calibración de Potencia RFID */}
      <View style={styles.calibrationCard}>
        <View style={styles.calibrationHeader}>
          <Ionicons name="flash-outline" size={18} color="#0b63ce" />
          <Text style={styles.calibrationTitle}>Calibración de Potencia RFID</Text>
        </View>
        <View style={styles.calibrationControls}>
          <Pressable style={styles.calibButton} onPress={() => adjustPower(-1)}>
            <Text style={styles.calibButtonText}>-</Text>
          </Pressable>
          <Text style={styles.calibValue}>{rfidPower} dBm</Text>
          <Pressable style={styles.calibButton} onPress={() => adjustPower(1)}>
            <Text style={styles.calibButtonText}>+</Text>
          </Pressable>
        </View>
      </View>

      {/* Indicador de Modo de Búsqueda */}
      <View style={styles.modeContainer}>
        <Text style={styles.modeText}>
          Modo actual:{' '}
          <Text style={styles.modeActive}>
            {searchMode === 'barcode' ? 'Lectura Barcode/SKU' : 'Búsqueda Texto/Query'}
          </Text>
        </Text>
        {searchMode === 'barcode' && (
          <Pressable style={styles.resetModeButton} onPress={() => { setSearchMode('text'); setQuery(''); }}>
            <Text style={styles.resetModeButtonText}>Volver a Texto</Text>
          </Pressable>
        )}
      </View>

      {/* Barra de Búsqueda */}
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={21} color="#667085" />
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={searchMode === 'barcode' ? "Escanee / Ingrese SKU" : "Buscá por descripción"}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={searchMode === 'barcode' ? handleSkuScanSubmit : undefined}
        />
        <Pressable accessibilityLabel="Leer barcode" style={styles.scanButton} onPress={handleBarcodeSearch}>
          <Ionicons name="barcode-outline" size={23} color="#0b63ce" />
        </Pressable>
      </View>

      {/* Simulador de Escaneo de Barcode para facilitar pruebas automatizadas */}
      {searchMode === 'barcode' && (
        <Pressable
          style={styles.simulateButton}
          onPress={() => {
            const testSku = query || 'MOCK-SKU-100';
            setQuery(testSku);
            setTimeout(() => {
              handleSkuScanSubmit().catch(() => undefined);
            }, 100);
          }}
        >
          <Ionicons name="play-outline" size={16} color="#0b63ce" />
          <Text style={styles.simulateButtonText}>Simular Lectura de Barcode (Enviar SKU)</Text>
        </Pressable>
      )}

      {loadingSearch && <ActivityIndicator style={{ marginVertical: 14 }} />}
      {!!error && <Text style={styles.error}>{error}</Text>}

      {!loadingSearch && suggestions.length > 0 && (
        <View style={styles.suggestions}>
          {suggestions.map((item, index) => (
            <Pressable key={`${item.model}-${index}`} style={styles.suggestion} onPress={() => handleSelect(item)}>
              <Ionicons name="pricetag-outline" size={18} color="#475467" />
              <Text style={styles.suggestionText}>{item.model}</Text>
              <Ionicons name="chevron-forward" size={18} color="#98a2b3" />
            </Pressable>
          ))}
        </View>
      )}

      {loadingStock && <ActivityIndicator style={{ marginVertical: 14 }} />}
      {selectedSku !== '' && !loadingStock && <Text style={styles.resultTitle}>SKU {selectedSku}</Text>}

      {detection?.running && (
        <View style={styles.detectionBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.detectionTitle}>Detección RFID activa</Text>
            <Text style={styles.detectionEpc}>{detection.epc}</Text>
            {detection.lastTag && (
              <Text style={styles.detectionTag}>
                Detectado: {detection.lastTag.epc} · RSSI {detection.lastTag.rssi}
              </Text>
            )}
          </View>
          <Pressable onPress={stopDetection} style={styles.stopButton}>
            <Ionicons name="stop-circle-outline" size={28} color="#b42318" />
          </Pressable>
        </View>
      )}

      <FlatList
        data={stock}
        keyExtractor={(item, index) => `${item.sku}-${item.skucolor}-${item.skusize}-${index}`}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 20 }}
        renderItem={({ item }) => (
          <StockCard
            item={item}
            detecting={detection?.epc}
            onDetect={(mode) => startDetection(item, mode)}
          />
        )}
        ListEmptyComponent={
          !loadingStock && selectedSku ? (
            <Text style={styles.empty}>Sin stock para el SKU consultado en el depósito activo.</Text>
          ) : undefined
        }
      />
    </Screen>
  );
}

function extractSku(model: string): string | null {
  const match = model.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() || null;
}

function StockCard({
  item,
  onDetect,
  detecting,
}: {
  item: StockRow;
  onDetect: (mode: EpcDetectionMode) => void;
  detecting?: string;
}) {
  const imageUri = getImageUri(item.image);

  return (
    <View style={styles.card}>
      <View style={styles.imageWrap}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={styles.productImage}
            resizeMode="cover"
            accessibilityLabel={`Imagen de ${item.sku}`}
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="image-outline" size={30} color="#98a2b3" />
          </View>
        )}
      </View>

      <View style={styles.productInfo}>
        <Text style={styles.sku} numberOfLines={1}>{item.sku}</Text>
        <Text style={styles.model} numberOfLines={1}>
          {item.colordesc || item.skucolor} · {item.sizedesc || item.skusize}
        </Text>
        <Text style={styles.rfid} numberOfLines={1}>
          RFID: {item.modelrfid}
        </Text>

        <View style={styles.detectActions}>
          <DetectButton icon="radio-outline" label="Modelo" onPress={() => onDetect('model')} />
          <DetectButton
            icon="color-filter-outline"
            label="Color"
            disabled={!item.modelcolrfid}
            onPress={() => onDetect('color')}
          />
          <DetectButton
            icon="resize-outline"
            label="Talle"
            disabled={!item.modelsizfid}
            onPress={() => onDetect('size')}
          />
        </View>
      </View>

      <View style={[styles.stockBadge, item.stock === 0 && styles.stockBadgeZero]}>
        <Text style={[styles.stock, item.stock === 0 && styles.stockZero]}>{item.stock}</Text>
        <Text style={[styles.stockLabel, item.stock === 0 && styles.stockLabelZero]}>stock</Text>
      </View>
    </View>
  );
}

function getImageUri(image?: string): string | undefined {
  if (!image) return undefined;
  const value = image.trim();
  if (!value) return undefined;
  if (value.startsWith('data:image/')) return value;
  return `data:image/jpeg;base64,${value}`;
}

function DetectButton({
  icon,
  label,
  onPress,
  disabled = false
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean
}) {
  return (
    <Pressable
      disabled={disabled}
      accessibilityLabel={`Detectar ${label}`}
      onPress={onPress}
      style={[styles.detectButton, disabled && styles.detectButtonDisabled]}
    >
      <Ionicons name={icon} size={20} color={disabled ? '#98a2b3' : '#0b63ce'} />
      <Text style={[styles.detectLabel, disabled && styles.detectLabelDisabled]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '700', color: '#101828', marginTop: 8, marginBottom: 12 },
  searchBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#d0d5dd', paddingLeft: 12, minHeight: 50 },
  input: { flex: 1, paddingHorizontal: 10, color: '#101828', fontSize: 15 },
  scanButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', borderLeftWidth: 1, borderLeftColor: '#eaecf0' },
  error: { color: '#d92d20', marginTop: 10 },
  suggestions: { backgroundColor: '#fff', borderRadius: 12, marginTop: 8, borderWidth: 1, borderColor: '#eaecf0', overflow: 'hidden' },
  suggestion: { minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: '#f2f4f7' },
  suggestionText: { flex: 1, color: '#344054', fontSize: 13 },
  resultTitle: { marginTop: 16, fontWeight: '700', color: '#101828' },
  empty: { textAlign: 'center', color: '#667085', marginTop: 30 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 10, marginBottom: 10, flexDirection: 'row', elevation: 1, gap: 10 },
  imageWrap: { width: 78, height: 96, borderRadius: 10, overflow: 'hidden', backgroundColor: '#f2f4f7' },
  productImage: { width: '100%', height: '100%' },
  imagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1 },
  sku: { fontSize: 14, fontWeight: '700', color: '#101828' },
  model: { fontSize: 12, color: '#475467', marginTop: 5 },
  rfid: { fontSize: 11, color: '#98a2b3', marginTop: 6 },
  stockBadge: { minWidth: 54, height: 58, borderRadius: 10, backgroundColor: '#ecfdf3', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  stockBadgeZero: { backgroundColor: '#fef3f2' },
  stock: { color: '#027a48', fontSize: 20, fontWeight: '800' },
  stockZero: { color: '#b42318' },
  stockLabel: { color: '#027a48', fontSize: 10, marginTop: 2 },
  stockLabelZero: { color: '#b42318' },
  detectActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  detectButton: { minWidth: 72, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, borderColor: '#b2ddff', backgroundColor: '#eff8ff', alignItems: 'center' },
  detectLabel: { fontSize: 10, color: '#0b63ce', marginTop: 2, fontWeight: '600' },
  detectButtonDisabled: { opacity: 0.55, backgroundColor: '#f2f4f7', borderColor: '#d0d5dd' },
  detectLabelDisabled: { color: '#98a2b3' },
  detectionBanner: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: '#fffaeb', borderWidth: 1, borderColor: '#fedf89', flexDirection: 'row', alignItems: 'center' },
  detectionTitle: { fontWeight: '700', color: '#7a2e0e', fontSize: 13 },
  detectionEpc: { color: '#667085', fontSize: 10, marginTop: 3 },
  detectionTag: { color: '#027a48', fontSize: 11, marginTop: 5, fontWeight: '600' },
  stopButton: { padding: 8 },

  // Custom deposit selector styles
  depositContainer: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#eaecf0', marginBottom: 12 },
  depositLabel: { fontSize: 12, fontWeight: '600', color: '#475467', marginBottom: 6 },
  depositPicker: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, padding: 10, backgroundColor: '#f9fafb' },
  depositPickerText: { fontSize: 14, fontWeight: '600', color: '#101828' },
  dropdownList: { marginTop: 6, borderWidth: 1, borderColor: '#eaecf0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  dropdownItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#f2f4f7' },
  dropdownItemActive: { backgroundColor: '#f5f9ff' },
  dropdownItemText: { fontSize: 13, color: '#344054' },
  dropdownItemTextActive: { fontWeight: '700', color: '#0b63ce' },

  // Power calibration styles
  calibrationCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#eaecf0', marginBottom: 12 },
  calibrationHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  calibrationTitle: { fontSize: 13, fontWeight: '700', color: '#344054' },
  calibrationControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, paddingVertical: 4 },
  calibButton: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: '#d0d5dd', backgroundColor: '#f9fafb', justifyContent: 'center', alignItems: 'center' },
  calibButtonText: { fontSize: 18, fontWeight: '600', color: '#101828' },
  calibValue: { fontSize: 15, fontWeight: '700', color: '#0b63ce', minWidth: 60, textAlign: 'center' },

  // Mode select styles
  modeContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, marginTop: 4 },
  modeText: { fontSize: 12, color: '#475467' },
  modeActive: { fontWeight: '700', color: '#0b63ce' },
  resetModeButton: { padding: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: '#f2f4f7' },
  resetModeButtonText: { fontSize: 11, fontWeight: '600', color: '#344054' },

  // Simulate button styles
  simulateButton: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: '#eff8ff', borderWidth: 1, borderColor: '#b2ddff', alignSelf: 'flex-start' },
  simulateButtonText: { fontSize: 11, fontWeight: '600', color: '#0b63ce' }
});
