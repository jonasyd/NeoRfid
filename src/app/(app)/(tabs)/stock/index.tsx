import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
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
  const [modelphoto, setModelphoto] = useState<string | undefined>(undefined);
  const [selectedSku, setSelectedSku] = useState('');
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingStock, setLoadingStock] = useState(false);
  const [error, setError] = useState('');
  const [detection, setDetection] = useState<DetectionState>(null);

  // Dropdown de depósitos
  const [showDepositDropdown, setShowDepositDropdown] = useState(false);

  // Calibración de potencia (0 - 30 dBm)
  const [rfidPower, setRfidPower] = useState(20);

  // Filtro de conStock (default: false)
  const [conStockFilter, setConStockFilter] = useState(false);

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

  async function loadStockForSku(sku: string, constockParam = conStockFilter) {
    setLoadingStock(true);
    setError('');
    try {
      const res = await getStock(sku, constockParam);
      setStock(res.rows);
      setModelphoto(res.modelphoto);
    } catch (e: any) {
      setStock([]);
      setModelphoto(undefined);
      setError(e?.response?.data?.message ?? e?.message ?? 'No se pudo consultar stock.');
    } finally {
      setLoadingStock(false);
    }
  }

  // Si cambia el depósito seleccionado, el SKU activo o la opción conStock, volver a cargar el stock
  const activeDepositUuid = session?.depositoSeleccionado?.uuid;
  useEffect(() => {
    if (selectedSku) {
      const timer = setTimeout(() => {
        loadStockForSku(selectedSku, conStockFilter);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activeDepositUuid, selectedSku, conStockFilter]);

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
            {session?.depositoSeleccionado
              ? session.depositoSeleccionado.Sucursal
                ? `${session.depositoSeleccionado.Sucursal} - ${session.depositoSeleccionado.nombre}`
                : session.depositoSeleccionado.nombre
              : 'Seleccionar Depósito'}
          </Text>
          <Ionicons
            name={showDepositDropdown ? "chevron-up" : "chevron-down"}
            size={20}
            color="#475467"
          />
        </Pressable>

        {showDepositDropdown && (
          <View style={styles.dropdownList}>
            {(session?.depositos ?? []).map((dep) => {
              const label = dep.Sucursal ? `${dep.Sucursal} - ${dep.nombre}` : dep.nombre;
              return (
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
                    {label}
                  </Text>
                  {session?.depositoSeleccionado?.uuid === dep.uuid && (
                    <Ionicons name="checkmark" size={18} color="#0b63ce" />
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      {/* Ajustar potencia RFID y opción Con Stock */}
      <View style={styles.configRowContainer}>
        <View style={[styles.calibrationCard, { flex: 1, marginBottom: 0 }]}>
          <View style={styles.calibrationHeader}>
            <Ionicons name="flash-outline" size={18} color="#0b63ce" />
            <Text style={styles.calibrationTitle}>Ajustar potencia RFID</Text>
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

        <View style={[styles.conStockCard]}>
          <Text style={styles.conStockTitle}>Sólo con stock</Text>
          <Switch
            value={conStockFilter}
            onValueChange={setConStockFilter}
            trackColor={{ false: '#d0d5dd', true: '#b2ddff' }}
            thumbColor={conStockFilter ? '#0b63ce' : '#f2f4f7'}
          />
        </View>
      </View>

      {/* Indicador de Modo de Búsqueda */}
      <View style={styles.modeContainer}>
        <Text style={styles.modeText}>
          Modo actual:{' '}
          <Text style={styles.modeActive}>
            {searchMode === 'barcode' ? 'Búsqueda por SKU' : 'Búsqueda por descripción'}
          </Text>
        </Text>
        {searchMode === 'barcode' && (
          <Pressable style={styles.resetModeButton} onPress={() => { setSearchMode('text'); setQuery(''); }}>
            <Text style={styles.resetModeButtonText}>Volver a Descripción</Text>
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

      {!loadingStock && stock.length > 0 ? (
        <GroupedStockCard
          stock={stock}
          modelphoto={modelphoto}
          detecting={detection?.epc}
          onDetect={(item, mode) => startDetection(item, mode)}
        />
      ) : !loadingStock && selectedSku ? (
        <Text style={styles.empty}>Sin stock para el SKU consultado en el depósito activo.</Text>
      ) : null}
    </Screen>
  );
}

function extractSku(model: string): string | null {
  const match = model.match(/\(([^)]+)\)\s*$/);
  return match?.[1]?.trim() || null;
}

function GroupedStockCard({
  stock,
  modelphoto,
  detecting,
  onDetect,
}: {
  stock: StockRow[];
  modelphoto?: string;
  detecting?: string;
  onDetect: (item: StockRow, mode: EpcDetectionMode) => void;
}) {
  const colors = Array.from(new Set(stock.map((s) => s.colordesc || s.skucolor)));
  const [userSelectedColor, setUserSelectedColor] = useState<string | null>(null);
  const [showRfidDetails, setShowRfidDetails] = useState(false);

  const activeColor = (userSelectedColor && colors.includes(userSelectedColor))
    ? userSelectedColor
    : (colors[0] || '');

  const rowsForColor = stock.filter((s) => (s.colordesc || s.skucolor) === activeColor);

  const sizes = Array.from(new Set(rowsForColor.map((s) => s.sizedesc || s.skusize)));
  const [userSelectedSize, setUserSelectedSize] = useState<string | null>(null);

  const activeSize = (userSelectedSize && sizes.includes(userSelectedSize))
    ? userSelectedSize
    : (sizes[0] || '');

  const activeRow = rowsForColor.find((s) => (s.sizedesc || s.skusize) === activeSize) || rowsForColor[0] || stock[0];

  const title = activeRow?.skuDescription || activeRow?.sku || 'Producto';
  const rawImage = modelphoto || activeRow?.modelphoto || activeRow?.image;
  const imageUri = getImageUri(rawImage);

  const sess = getSession();
  const brandPrefix = sess?.brandPrefix || '';

  let modelEpcHex = '';
  let colorEpcHex = '';
  let sizeEpcHex = '';

  if (activeRow) {
    try {
      if (activeRow.modelrfid) {
        modelEpcHex = buildEpc({ brandPrefix, modelrfid: activeRow.modelrfid }, 'model').epc;
      }
      if (activeRow.modelrfid && activeRow.modelcolrfid) {
        colorEpcHex = buildEpc({ brandPrefix, modelrfid: activeRow.modelrfid, modelcolrfid: activeRow.modelcolrfid }, 'color').epc;
      }
      if (activeRow.modelrfid && activeRow.modelsizfid) {
        sizeEpcHex = buildEpc({ brandPrefix, modelrfid: activeRow.modelrfid, modelsizfid: activeRow.modelsizfid }, 'size').epc;
      }
    } catch {
      // Ignore HEX computation errors for display
    }
  }

  return (
    <View style={styles.cardContainer}>
      {/* Top Header Row with Photo & Details */}
      <View style={styles.topRow}>
        <View style={styles.imageWrapLarge}>
          {imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={styles.productImageLarge}
              resizeMode="cover"
              accessibilityLabel={`Imagen de ${title}`}
            />
          ) : (
            <View style={styles.imagePlaceholderLarge}>
              <Ionicons name="image-outline" size={40} color="#98a2b3" />
            </View>
          )}
        </View>

        <View style={styles.detailsCol}>
          <Text style={styles.productTitle}>{title}</Text>
          <Text style={styles.colorSubtitle}>
            Color: <Text style={styles.colorValue}>{activeColor || activeRow?.skucolor}</Text>
          </Text>

          {colors.length > 1 && (
            <View style={styles.colorPickerRow}>
              {colors.map((c) => {
                const colorStock = stock.filter((s) => (s.colordesc || s.skucolor) === c).reduce((acc, curr) => acc + curr.stock, 0);
                const hasStock = colorStock > 0;
                const isSelected = activeColor === c;

                return (
                  <Pressable
                    key={c}
                    style={[
                      styles.colorChip,
                      hasStock ? styles.colorChipSolid : styles.colorChipDashed,
                      isSelected && (hasStock ? styles.colorChipActive : styles.colorChipDashedActive)
                    ]}
                    onPress={() => { setUserSelectedColor(c); setUserSelectedSize(null); }}
                  >
                    <Text
                      style={[
                        styles.colorChipText,
                        hasStock ? styles.textGreen : styles.textRed,
                        isSelected && styles.colorChipTextActive
                      ]}
                    >
                      {c}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {activeRow?.Oferta ? (
            <View style={styles.ofertaBadge}>
              <Ionicons name="pricetag" size={14} color="#b58a00" />
              <Text style={styles.ofertaText}>En oferta</Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.divider} />

      {/* Talles disponibles */}
      <Text style={styles.tallesTitle}>Talles disponibles:</Text>
      <View style={styles.tallesRow}>
        {sizes.map((sz) => {
          const rowForSz = rowsForColor.find((s) => (s.sizedesc || s.skusize) === sz);
          const szStock = rowForSz ? rowForSz.stock : 0;
          const hasStock = szStock > 0;
          const isSelected = activeSize === sz;

          return (
            <Pressable
              key={sz}
              style={[
                styles.talleButton,
                hasStock ? styles.talleSolid : styles.talleDashed,
                isSelected && (hasStock ? styles.talleButtonActive : styles.talleDashedActive)
              ]}
              onPress={() => setUserSelectedSize(sz)}
            >
              <Text
                style={[
                  styles.talleText,
                  hasStock ? styles.textGreen : styles.textRed,
                  isSelected && styles.talleTextActive
                ]}
              >
                {sz}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Detalle del talle seleccionado */}
      {activeRow && (
        <View style={styles.selectedSizeDetail}>
          <Text style={styles.selectedTalleHeader}>Talle: {activeRow.sizedesc || activeRow.skusize}</Text>

          <View style={styles.infoGrid}>
            <View style={styles.infoCol}>
              <View style={styles.iconValRow}>
                <View style={[styles.dot, activeRow.stock > 0 ? styles.dotGreen : styles.dotRed]} />
                <Text style={styles.infoLabel}>Stock: </Text>
                <Text style={[styles.infoValueBold, activeRow.stock > 0 ? styles.textGreen : styles.textRed]}>
                  {activeRow.stock}
                </Text>
              </View>
              {activeRow.stockInTransit !== undefined && (
                <Text style={styles.infoSubtext}>Tránsito: {activeRow.stockInTransit}</Text>
              )}
            </View>

            <View style={[styles.infoCol, { alignItems: 'flex-end' }]}>
              {activeRow.precio && (
                <Text style={styles.infoPrice}>
                  Precio: ${activeRow.precio}
                </Text>
              )}
              {activeRow.Oferta && (
                <Text style={styles.infoOfertaPrice}>
                  Oferta: ${activeRow.Oferta}
                </Text>
              )}
            </View>
          </View>

          {/* Detección RFID Icons (Remera, Paleta de Colores, Regla) */}
          <View style={styles.detectActions}>
            <DetectButton
              icon="shirt-outline"
              label="Modelo"
              onPress={() => onDetect(activeRow, 'model')}
            />
            <DetectButton
              icon="color-palette-outline"
              label="Color"
              disabled={!activeRow.modelcolrfid}
              onPress={() => onDetect(activeRow, 'color')}
            />
            <DetectButton
              icon="options-outline"
              label="Talle"
              disabled={!activeRow.modelsizfid}
              onPress={() => onDetect(activeRow, 'size')}
            />
          </View>

          {/* Acordeón para Códigos RFID e Identificadores HEX (Contraído por defecto) */}
          <Pressable
            style={styles.accordionHeader}
            onPress={() => setShowRfidDetails(!showRfidDetails)}
          >
            <Ionicons name="hardware-chip-outline" size={16} color="#475467" />
            <Text style={styles.accordionTitle}>Detalle Códigos e Identificadores EPC (HEX)</Text>
            <Ionicons name={showRfidDetails ? "chevron-up" : "chevron-down"} size={16} color="#475467" />
          </Pressable>

          {showRfidDetails && (
            <View style={styles.accordionBody}>
              <Text style={styles.rfidCodeText}>
                modelrfid: <Text style={styles.codeVal}>{activeRow.modelrfid || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                modelcolrfid: <Text style={styles.codeVal}>{activeRow.modelcolrfid || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                modelsizfid: <Text style={styles.codeVal}>{activeRow.modelsizfid || '-'}</Text>
              </Text>
              <View style={{ height: 1, backgroundColor: '#eaecf0', marginVertical: 6 }} />
              <Text style={styles.rfidCodeText}>
                HEX Modelo: <Text style={styles.codeValHex}>{modelEpcHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                HEX Color: <Text style={styles.codeValHex}>{colorEpcHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                HEX Talle: <Text style={styles.codeValHex}>{sizeEpcHex || '-'}</Text>
              </Text>
            </View>
          )}
        </View>
      )}
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

  // Config Row styles (Power calibration & Con Stock filter)
  configRowContainer: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  calibrationCard: { backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#eaecf0' },
  calibrationHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  calibrationTitle: { fontSize: 12, fontWeight: '700', color: '#344054' },
  calibrationControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 2 },
  calibButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: '#d0d5dd', backgroundColor: '#f9fafb', justifyContent: 'center', alignItems: 'center' },
  calibButtonText: { fontSize: 16, fontWeight: '600', color: '#101828' },
  calibValue: { fontSize: 13, fontWeight: '700', color: '#0b63ce', minWidth: 50, textAlign: 'center' },
  conStockCard: { width: 110, backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#eaecf0', alignItems: 'center', justifyContent: 'center', gap: 4 },
  conStockTitle: { fontSize: 11, fontWeight: '700', color: '#344054', textAlign: 'center' },

  // Solid & Dashed stock styles
  colorChipSolid: { borderWidth: 1, borderColor: '#12b76a' },
  colorChipDashed: { borderWidth: 1, borderColor: '#f04438', borderStyle: 'dashed' },
  colorChipDashedActive: { backgroundColor: '#f04438', borderColor: '#f04438' },
  talleSolid: { borderWidth: 1, borderColor: '#12b76a' },
  talleDashed: { borderWidth: 1, borderColor: '#f04438', borderStyle: 'dashed' },
  talleDashedActive: { backgroundColor: '#f04438', borderColor: '#f04438' },
  textGreen: { color: '#027a48', fontWeight: '700' },
  textRed: { color: '#b42318', fontWeight: '700' },

  // Accordion details styles
  accordionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#eaecf0' },
  accordionTitle: { flex: 1, fontSize: 12, fontWeight: '700', color: '#344054' },
  accordionBody: { marginTop: 8, backgroundColor: '#f8fafc', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  rfidCodeText: { fontSize: 11, color: '#475467', marginVertical: 1 },
  codeVal: { fontWeight: '700', color: '#0f172a' },
  codeValHex: { fontWeight: '700', color: '#0284c7', fontFamily: 'monospace' },

  // Mode select styles
  modeContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, marginTop: 4 },
  modeText: { fontSize: 12, color: '#475467' },
  modeActive: { fontWeight: '700', color: '#0b63ce' },
  resetModeButton: { padding: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: '#f2f4f7' },
  resetModeButtonText: { fontSize: 11, fontWeight: '600', color: '#344054' },

  // Simulate button styles
  simulateButton: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: '#eff8ff', borderWidth: 1, borderColor: '#b2ddff', alignSelf: 'flex-start' },
  simulateButtonText: { fontSize: 11, fontWeight: '600', color: '#0b63ce' },

  // Grouped Stock Card styles
  cardContainer: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginTop: 12, marginBottom: 16, borderWidth: 1, borderColor: '#eaecf0', elevation: 2 },
  topRow: { flexDirection: 'row', gap: 14 },
  imageWrapLarge: { width: 110, height: 130, borderRadius: 12, overflow: 'hidden', backgroundColor: '#f2f4f7' },
  productImageLarge: { width: '100%', height: '100%' },
  imagePlaceholderLarge: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  detailsCol: { flex: 1, justifyContent: 'flex-start' },
  productTitle: { fontSize: 20, fontWeight: '800', color: '#022449', letterSpacing: 0.5 },
  colorSubtitle: { fontSize: 14, color: '#475467', marginTop: 4 },
  colorValue: { fontWeight: '700', color: '#101828' },
  colorPickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  colorChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: '#f2f4f7', borderWidth: 1, borderColor: '#d0d5dd' },
  colorChipActive: { backgroundColor: '#022449', borderColor: '#022449' },
  colorChipText: { fontSize: 11, color: '#344054' },
  colorChipTextActive: { color: '#fff', fontWeight: '700' },
  ofertaBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#fffbeb', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: '#fef08a', alignSelf: 'flex-start', marginTop: 10 },
  ofertaText: { fontSize: 12, fontWeight: '700', color: '#b58a00' },
  divider: { height: 1, backgroundColor: '#eaecf0', marginVertical: 14 },
  tallesTitle: { fontSize: 14, fontWeight: '700', color: '#101828', marginBottom: 10 },
  tallesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  talleButton: { width: 48, height: 40, borderRadius: 10, backgroundColor: '#f2f4f7', borderWidth: 1, borderColor: '#d0d5dd', justifyContent: 'center', alignItems: 'center' },
  talleButtonActive: { backgroundColor: '#2080d0', borderColor: '#2080d0' },
  talleText: { fontSize: 14, fontWeight: '600', color: '#344054' },
  talleTextActive: { color: '#fff', fontWeight: '800' },
  selectedSizeDetail: { backgroundColor: '#f9fafb', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#f2f4f7', marginTop: 4 },
  selectedTalleHeader: { fontSize: 15, fontWeight: '700', color: '#101828', marginBottom: 8 },
  infoGrid: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoCol: { gap: 2 },
  iconValRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotGreen: { backgroundColor: '#12b76a' },
  dotRed: { backgroundColor: '#f04438' },
  infoLabel: { fontSize: 14, color: '#475467' },
  infoValueBold: { fontSize: 16, fontWeight: '800', color: '#101828' },
  infoSubtext: { fontSize: 12, color: '#667085' },
  infoPrice: { fontSize: 14, color: '#475467', fontWeight: '600' },
  infoOfertaPrice: { fontSize: 15, color: '#b58a00', fontWeight: '800' }
});
