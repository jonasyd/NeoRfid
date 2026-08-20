import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, Vibration, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { getStock, searchModels, getSession } from '@/services/api';
import { buildEpc, stringToHex, hexPassthrough, breakdownEpc, type EpcDetectionMode } from '@/services/epc';
import type { SearchResult, StockRow, Deposito } from '@/types/api';
import ChafonH103, { getChafonStatus, hexToAscii, type ChafonTag } from '@modules/chafon-h103';
import { useSession } from '@/context/SessionContext';
import { useChafonStatus } from '@/hooks/useChafonStatus';

const POWER_MIN = 1;
const POWER_MAX = 33;

const MIN_SEARCH = 3;
const DEBOUNCE_MS = 350;

type DetectionState = {
  mode: EpcDetectionMode;
  epc: string;
  running: boolean;
  /** Última lectura que coincide con el prefijo buscado. */
  lastTag?: ChafonTag;
  /** Total de tags leídos desde que arrancó la búsqueda (coincidan o no). */
  reads: number;
  /** Cuántos coincidieron con el prefijo. */
  matches: number;
  /** Última lectura recibida, coincida o no: sirve para diagnosticar prefijos que no matchean. */
  lastAnyEpc?: string;
} | null;

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
  // Para llevar la vista hasta la guía de detección apenas arranca una búsqueda.
  const scrollRef = useRef<ScrollView>(null);
  const detectionY = useRef(0);

  // Dropdown de depósitos
  const [showDepositDropdown, setShowDepositDropdown] = useState(false);

  // Estado del lector compartido con el tab de Configuración (conexión, modo, potencia, batería).
  const chafon = useChafonStatus();

  // Mostramos la potencia CONFIRMADA por el equipo. Mientras no haya confirmado, mostramos
  // la pedida como valor provisorio.
  const rfidPower = chafon.power ?? chafon.powerRequested ?? 20;
  // La aritmética del +/- va sobre lo ÚLTIMO PEDIDO, no sobre lo confirmado: este equipo no
  // contesta GET_ALL_PARAM, así que `power` se queda en null y el botón recalculaba siempre el
  // mismo valor (se vio mandar 24 dBm doce veces seguidas sin que el número avanzara).
  const powerBase = chafon.powerRequested ?? chafon.power ?? 20;
  // true cuando pedimos una potencia y el equipo terminó aplicando otra.
  const powerMismatch =
    chafon.power != null &&
    chafon.powerRequested != null &&
    chafon.power !== chafon.powerRequested;

  const [batteryLoading, setBatteryLoading] = useState(false);

  // Filtro de conStock (default: false)
  const [conStockFilter, setConStockFilter] = useState(false);

  const requestId = useRef(0);
  const inputRef = useRef<any>(null);
  const detectionRunningRef = useRef(false);
  const lastPulseRef = useRef(0);
  // El listener de tags se registra una sola vez; estos refs le dan acceso al estado actual
  // sin recrear la suscripción en cada render.
  const onBarcodeRef = useRef<(value: string) => void>(() => {});

  useEffect(() => {
    const sub = ChafonH103.addTagListener((tag: ChafonTag) => {
      // En modo transparente el código de barras llega por este mismo canal (antes entraba
      // "tipeado" porque el equipo estaba en modo teclado HID). Lo decodificamos y buscamos.
      if (getChafonStatus().readMode === 'barcode') {
        const value = hexToAscii(tag.epc);
        if (value) onBarcodeRef.current(value);
        return;
      }

      const matched = tag.isMatch !== false;
      setDetection((current) =>
        current
          ? {
              ...current,
              reads: current.reads + 1,
              matches: current.matches + (matched ? 1 : 0),
              lastTag: matched ? tag : current.lastTag,
              lastAnyEpc: tag.epc,
            }
          : current
      );

      // Guía de proximidad en el teléfono: vibra en cada lectura del tag buscado, más seguido
      // y más fuerte cuanto mejor es la señal (más cerca). Complementa el pitido del equipo.
      if (!detectionRunningRef.current || !matched) return;
      const now = Date.now();
      const rssi = typeof tag.rssi === 'number' ? tag.rssi : -90;
      // RSSI típico: -80 (lejos) .. -30 (encima). Lo mapeamos a un intervalo de 600ms a 90ms.
      const closeness = Math.max(0, Math.min(1, (rssi + 80) / 50));
      const minGap = 600 - closeness * 510;
      if (now - lastPulseRef.current < minGap) return;
      lastPulseRef.current = now;
      Vibration.vibrate(Math.round(12 + closeness * 45));
    });
    return () => sub.remove();
  }, []);

  // Búsqueda incremental con Debounce (solo si el modo es 'text' y no coincide exactamente con selectedSku)
  useEffect(() => {
    if (searchMode !== 'text') return;

    if (selectedSku && query.trim() === selectedSku.trim()) {
      setSuggestions([]);
      return;
    }

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
  }, [query, searchMode, selectedSku]);

  /**
   * Corta la detección RFID en curso. Se llama al iniciar cualquier búsqueda nueva: la guía
   * de proximidad corresponde al ítem que se estaba buscando y deja de tener sentido apenas
   * se consulta otro modelo.
   */
  async function clearDetection() {
    if (!detectionRunningRef.current) {
      setDetection(null);
      return;
    }
    try {
      await ChafonH103.stopInventory();
      await ChafonH103.clearDetectionMask();
    } catch {
      // Si el equipo no responde igual limpiamos la guía en pantalla.
    } finally {
      setDetection(null);
    }
  }

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

  // Activa la lectura 2D: pone la terminal Chafon en modo Barcode de verdad (antes solo
  // cambiaba el modo de búsqueda local, sin avisarle nada al hardware), enfoca el campo de
  // texto y cambia a modo barcode en la UI.
  async function handleBarcodeSearch() {
    setQuery('');
    setSuggestions([]);
    setStock([]);
    setSelectedSku('');
    setError('');
    await clearDetection();
    // Pone la terminal en modo Barcode Y dispara una lectura.
    await scanBarcodeNow();
  }

  // Ejecuta la búsqueda enviando SKU en el body
  async function handleSkuScanSubmit(scannedSku?: string) {
    const sku = (scannedSku ?? query).trim();
    if (!sku) return;
    await clearDetection();
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

  // Al leer un código de barras: lo cargamos como SKU y disparamos la búsqueda.
  useEffect(() => {
    onBarcodeRef.current = (value: string) => {
      setQuery(value);
      setSearchMode('barcode');
      setTimeout(() => {
        handleSkuScanSubmit(value).catch(() => undefined);
      }, 0);
    };
  });

  async function handleSelect(result: SearchResult) {
    const rawSku = (result as any).sku || (result as any).SKU;
    const sku = rawSku?.trim() || extractSku(result.model) || result.model?.trim();
    if (!sku) {
      setError('La respuesta de search no contiene un SKU reconocible.');
      return;
    }
    setSuggestions([]);
    await clearDetection();
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

      // La terminal puede venir en modo Barcode (p. ej. si se usó el escáner 2D antes). El
      // inventory RFID no hace nada en ese modo, así que la pasamos a RFID primero. El módulo
      // nativo ya espera el segundo que exige el manual tras cambiar de modo.
      if (chafon.readMode !== 'rfid') {
        await ChafonH103.setReadMode('rfid');
      }
      // Nota: NO tocamos el buzzer acá. setSoundEnabled reescribe el bloque completo de
      // parámetros (el SDK no permite cambiar un campo suelto) y este equipo lo rechaza con
      // STATUS 0x01 (error de parámetro), dejando además al módulo en mal estado justo antes
      // del inventory. El equipo ya pita solo en cada lectura según su propio BuzzerTime.
      // Arrancamos con el diagnóstico en cero: la falla y los barridos vacíos que informe el
      // equipo de acá en más corresponden a ESTA búsqueda.
      ChafonH103.resetDiagnostics();
      await ChafonH103.startDetection(epc);
      setDetection({ mode, epc, running: true, reads: 0, matches: 0 });
      // La guía queda al final de la pantalla; sin esto hay que bajar a mano justo cuando se
      // necesita tener las manos en la terminal. El margen deja ver el encabezado del bloque.
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: Math.max(0, detectionY.current - 12), animated: true });
      }, 250);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo iniciar la detección RFID.');
    }
  }

  useEffect(() => {
    detectionRunningRef.current = !!detection?.running;
  }, [detection?.running]);

  // El inventory arranca en modo continuo (InvParam=0) y sigue hasta stopInventory, así que
  // no hace falta renovarlo.

  /**
   * Detiene el barrido pero DEJA los resultados en pantalla.
   *
   * Antes se limpiaba todo al parar, así que el último tag leído, las cuentas y el desglose del
   * EPC desaparecían justo cuando la persona quería mirarlos. La guía se limpia sola al buscar
   * otro artículo (ver clearDetection), que es cuando deja de tener sentido.
   */
  async function stopDetection() {
    try {
      await ChafonH103.stopInventory();
      await ChafonH103.clearDetectionMask();
    } finally {
      setDetection((current) => (current ? { ...current, running: false } : null));
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

  // Calibración de potencia RFID Chafon (+/-). Rango del H103 según el manual: [1, 33] dBm.
  async function adjustPower(amount: number) {
    const next = Math.max(POWER_MIN, Math.min(POWER_MAX, powerBase + amount));
    if (next === powerBase) return;
    try {
      await ChafonH103.setPower(next);
      // Confirmación háptica: el equipo no tiene comando de "beep a demanda" (su buzzer solo
      // suena tras operaciones RFID), así que el aviso de "comando enviado" lo damos acá.
      Vibration.vibrate(25);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar la potencia de la antena.');
    }
  }

  // Modo de lectura del equipo, compartido con Configuración.
  async function changeReadMode(mode: 'rfid' | 'barcode') {
    try {
      await ChafonH103.setReadMode(mode);
      if (mode === 'barcode') {
        setSearchMode('barcode');
        setTimeout(() => inputRef.current?.focus(), 100);
      } else {
        setSearchMode('text');
      }
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar el modo de lectura.');
    }
  }

  /**
   * Dispara una lectura de código de barras. Cambiar el modo no alcanza: el equipo escanea solo
   * cuando recibe el comando de inventory (así lo hace la app del fabricante).
   */
  async function scanBarcodeNow() {
    try {
      if (getChafonStatus().readMode !== 'barcode') {
        await ChafonH103.setReadMode('barcode');
        setSearchMode('barcode');
      }
      await ChafonH103.triggerBarcodeScan();
      Vibration.vibrate(25);
      setError('');
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo disparar la lectura de código de barras.');
    }
  }

  // Pasa la terminal a modo transparente. En modo HID el equipo actúa como teclado Bluetooth:
  // al apretar el gatillo tipea el dato en el campo enfocado y mueve el foco por la pantalla,
  // y los tags no llegan por el canal BLE que usa la detección RFID.
  async function fixTransparentMode() {
    try {
      await ChafonH103.setTransparentMode(true);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar el modo de salida de la terminal.');
    }
  }

  async function refreshBattery() {
    setBatteryLoading(true);
    try {
      const level = await ChafonH103.getBattery();
      if (level < 0) setError('La terminal no respondió el nivel de batería.');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo consultar la batería.');
    } finally {
      setBatteryLoading(false);
    }
  }

  return (
    <Screen>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
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

      {/* Filtro de existencias y batería de la terminal, arriba de todo: son los dos datos
          que se miran de un vistazo antes de buscar. */}
      <View style={styles.filtersRow}>
        <View style={styles.conStockInline}>
          <Text style={styles.conStockTitle}>Sólo con stock</Text>
          <Switch
            value={conStockFilter}
            onValueChange={setConStockFilter}
            trackColor={{ false: '#d0d5dd', true: '#b2ddff' }}
            thumbColor={conStockFilter ? '#0b63ce' : '#f2f4f7'}
          />
        </View>

        <Pressable
          style={styles.batteryChip}
          onPress={refreshBattery}
          disabled={!chafon.connected || batteryLoading}
        >
          {batteryLoading ? (
            <ActivityIndicator size="small" color="#0b63ce" />
          ) : (
            <Ionicons name="battery-half-outline" size={15} color={chafon.connected ? '#0b63ce' : '#98a2b3'} />
          )}
          <Text style={[styles.batteryChipText, !chafon.connected && { color: '#98a2b3' }]}>
            {chafon.battery != null ? `${chafon.battery}%` : '--'}
          </Text>
        </Pressable>
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
          <Pressable style={styles.resetModeButton} onPress={() => { setSearchMode('text'); setQuery(''); ChafonH103.setReadMode('rfid').catch(() => undefined); }}>
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
          onSubmitEditing={searchMode === 'barcode' ? () => handleSkuScanSubmit() : undefined}
        />
        <Pressable accessibilityLabel="Leer barcode" style={styles.scanButton} onPress={handleBarcodeSearch}>
          <Ionicons name="barcode-outline" size={23} color="#0b63ce" />
        </Pressable>
      </View>

      {/* Simulador de Escaneo de Barcode solo visible para el usuario NEOADMIN */}
      {searchMode === 'barcode' && session?.username?.toUpperCase() === 'NEOADMIN' && (
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

      {/* Estado y control de la terminal: potencia, modo de lectura y batería. El estado se
          comparte con el tab de Configuración, así que refleja lo que ya estaba establecido. */}
      <View style={styles.terminalCard}>
        <View style={styles.terminalHeader}>
          <View style={[styles.terminalDot, chafon.connected ? styles.dotGreen : styles.dotRed]} />
          <Text style={styles.terminalTitle}>
            Terminal {chafon.connected ? 'conectada' : 'desconectada'}
          </Text>
        </View>

        <View style={styles.terminalControls}>
          <View style={styles.powerGroup}>
            <Text style={styles.groupLabel}>Potencia</Text>
            <View style={styles.calibrationControls}>
              <Pressable style={styles.calibButton} onPress={() => adjustPower(-1)} disabled={!chafon.connected}>
                <Text style={styles.calibButtonText}>-</Text>
              </Pressable>
              <Text style={styles.calibValue}>{rfidPower} dBm</Text>
              <Pressable style={styles.calibButton} onPress={() => adjustPower(1)} disabled={!chafon.connected}>
                <Text style={styles.calibButtonText}>+</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.modeGroup}>
            <Text style={styles.groupLabel}>Modo</Text>
            <View style={styles.modeToggleRow}>
              <Pressable
                style={[styles.modeToggle, chafon.readMode === 'rfid' && styles.modeToggleActive]}
                onPress={() => changeReadMode('rfid')}
                disabled={!chafon.connected}
              >
                <Ionicons name="radio-outline" size={15} color={chafon.readMode === 'rfid' ? '#fff' : '#0b63ce'} />
                <Text style={[styles.modeToggleText, chafon.readMode === 'rfid' && styles.modeToggleTextActive]}>RFID</Text>
              </Pressable>
              <Pressable
                style={[styles.modeToggle, chafon.readMode === 'barcode' && styles.modeToggleActive]}
                onPress={() => changeReadMode('barcode')}
                disabled={!chafon.connected}
              >
                <Ionicons name="barcode-outline" size={15} color={chafon.readMode === 'barcode' ? '#fff' : '#0b63ce'} />
                <Text style={[styles.modeToggleText, chafon.readMode === 'barcode' && styles.modeToggleTextActive]}>Barcode</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {powerMismatch && (
          <Text style={styles.powerWarn}>
            Pediste {chafon.powerRequested} dBm y el equipo aplicó {chafon.power} dBm. Puede estar
            limitado por su configuración de región o firmware.
          </Text>
        )}

        {chafon.connected && chafon.power === 0 && (
          <View style={styles.moduleFaultWarning}>
            <Ionicons name="alert-circle" size={16} color="#b42318" />
            <Text style={styles.moduleFaultText}>
              La antena está en 0 dBm (apagada): el lector no puede leer ningún tag. Subí la
              potencia con el botón +.
            </Text>
          </View>
        )}

        {chafon.moduleFault && (
          <View style={styles.moduleFaultWarning}>
            <Ionicons name="alert-circle" size={16} color="#b42318" />
            <Text style={styles.moduleFaultText}>
              {chafon.moduleFault} Está en Configuración → Reiniciar módulo RFID.
            </Text>
          </View>
        )}

        {/* El aviso de "pasala a modo transparente" se sacó a propósito: era mal consejo. Este
            equipo reporta los tags por BLE estando en modo HID, y pasarlo a transparente los
            hace desaparecer. El modo HID sólo molesta si además está vinculado como teclado en
            Android; en ese caso hay que desvincularlo desde el sistema, no cambiarle el modo. */}

      </View>

      {/* Guía de detección: va debajo del detalle del producto, y se limpia sola
          cuando se busca otro ítem por descripción o SKU (ver clearDetection). */}
      {detection && (
        <View
          style={styles.detectionBanner}
          onLayout={(e) => {
            detectionY.current = e.nativeEvent.layout.y;
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.detectionTitle}>
              {detection.running ? 'Buscando' : 'Búsqueda detenida'} por{' '}
              {detection.mode === 'model' ? 'Modelo' : detection.mode === 'color' ? 'Color' : 'Talle'}
            </Text>
            <Text style={styles.detectionEpc}>Prefijo EPC: {detection.epc}</Text>

            <Text style={styles.detectionReads}>
              Lecturas: {detection.reads} · Coincidencias: {detection.matches}
            </Text>

            {detection.lastTag ? (
              <>
                <Text style={styles.detectionTag}>
                  Detectado: {detection.lastTag.epc} · RSSI {detection.lastTag.rssi} dBm
                </Text>
                {/* Barra de proximidad: cuanto mejor la señal, más cerca está el tag. */}
                <View style={styles.proximityTrack}>
                  <View
                    style={[
                      styles.proximityFill,
                      { width: `${Math.round(proximityPct(detection.lastTag.rssi) * 100)}%` },
                      proximityPct(detection.lastTag.rssi) > 0.66
                        ? styles.proximityNear
                        : proximityPct(detection.lastTag.rssi) > 0.33
                        ? styles.proximityMid
                        : styles.proximityFar,
                    ]}
                  />
                </View>
                <Text style={styles.proximityHint}>
                  {proximityPct(detection.lastTag.rssi) > 0.66
                    ? 'Muy cerca'
                    : proximityPct(detection.lastTag.rssi) > 0.33
                    ? 'Cerca'
                    : 'Señal débil, seguí buscando'}
                </Text>
              </>
            ) : detection.reads > 0 ? (
              <>
                <Text style={styles.detectionWarn}>
                  Se están leyendo tags, pero ninguno coincide con este prefijo.
                </Text>
                {(() => {
                  const b = detection.lastAnyEpc ? breakdownEpc(detection.lastAnyEpc) : null;
                  if (!b) return null;
                  return (
                    <View style={styles.breakdownBox}>
                      <Text style={styles.breakdownTitle}>Último tag leído: {detection.lastAnyEpc}</Text>
                      <Text style={styles.breakdownRow}>Marca: {b.brand}</Text>
                      <Text style={styles.breakdownRow}>
                        Modelo: {b.model} (API debería mandar {b.modelDec})
                      </Text>
                      <Text style={styles.breakdownRow}>
                        Color: {b.color} (API debería mandar {b.colorDec})
                      </Text>
                      <Text style={styles.breakdownRow}>
                        Talle: {b.size} (API debería mandar {b.sizeDec})
                      </Text>
                      <Text style={styles.breakdownRow}>Serie/relleno: {b.tail} (se descarta)</Text>
                    </View>
                  );
                })()}
              </>
            ) : chafon.moduleFault ? (
              /* El equipo contestó un error. Hasta que se recupere no va a leer ningún tag, por
                 más que la app siga "buscando": mostrarlo evita perseguir en la app un problema
                 que está en el lector. */
              <Text style={styles.detectionError}>{chafon.moduleFault}</Text>
            ) : chafon.emptySweeps > 0 ? (
              /* El lector confirmó que barrió y no había nada en el campo. Es distinto de que la
                 app no esté recibiendo: acá el canal funciona y el tag no aparece. */
              <Text style={styles.detectionWarn}>
                El lector barrió {chafon.emptySweeps} {chafon.emptySweeps === 1 ? 'vez' : 'veces'} sin
                encontrar ningún tag. Acercá la terminal o subí la potencia de la antena.
              </Text>
            ) : (
              <Text style={styles.detectionEpc}>Barré la zona con la terminal…</Text>
            )}
          </View>
          {detection.running && (
            <Pressable onPress={stopDetection} style={styles.stopButton}>
              <Ionicons name="stop-circle-outline" size={28} color="#b42318" />
            </Pressable>
          )}
        </View>
      )}
      </ScrollView>
    </Screen>
  );
}

/** Convierte el RSSI (aprox. -80 lejos .. -30 encima) en un valor 0..1 de cercanía. */
function proximityPct(rssi: number): number {
  if (typeof rssi !== 'number') return 0;
  return Math.max(0, Math.min(1, (rssi + 80) / 50));
}

function extractSku(model?: string): string | null {
  if (!model) return null;
  const match = model.match(/\(([^)]+)\)\s*$/);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  return model.trim() || null;
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

  const { session } = useSession();
  const brandPrefix = session?.brandPrefix || getSession()?.brandPrefix || '';

  // "Roll" de detalle HEX: cada campo convertido a HEX y left-padded según la especificación
  // real de 96 bits (ver services/epc.ts). Se recalcula solo con activeRow, así que siempre
  // queda al día apenas cambia el color/talle seleccionado.
  // brandPrefix ya viene en HEX del backend: no se convierte, solo se normaliza.
  const brandHex = hexPassthrough(brandPrefix, 6);
  const modelHex = activeRow?.modelrfid ? stringToHex(activeRow.modelrfid, 6) : '';
  const colorHex = activeRow?.modelcolrfid ? stringToHex(activeRow.modelcolrfid, 3) : '';
  const sizeHex = activeRow?.modelsizfid ? stringToHex(activeRow.modelsizfid, 3) : '';

  // Prefijos de búsqueda "radar" (usados por los botones Modelo/Color/Talle vía startDetection)
  let modelEpcHex = '';
  let colorEpcHex = '';
  let sizeEpcHex = '';

  if (activeRow) {
    try {
      if (activeRow.modelrfid) {
        modelEpcHex = buildEpc({
          brandPrefix,
          modelrfid: activeRow.modelrfid,
          modelcolrfid: activeRow.modelcolrfid,
          modelsizfid: activeRow.modelsizfid,
        }, 'model').epc;
      }
      if (activeRow.modelrfid && activeRow.modelcolrfid) {
        colorEpcHex = buildEpc({
          brandPrefix,
          modelrfid: activeRow.modelrfid,
          modelcolrfid: activeRow.modelcolrfid,
          modelsizfid: activeRow.modelsizfid,
        }, 'color').epc;
      }
      if (activeRow.modelrfid && activeRow.modelcolrfid && activeRow.modelsizfid) {
        sizeEpcHex = buildEpc({
          brandPrefix,
          modelrfid: activeRow.modelrfid,
          modelcolrfid: activeRow.modelcolrfid,
          modelsizfid: activeRow.modelsizfid,
        }, 'size').epc;
      }
    } catch {
      // No debería pasar (ya chequeamos los campos arriba), pero por las dudas dejamos
      // los prefijos vacíos en vez de romper el render.
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
              disabled={!activeRow.modelcolrfid || !activeRow.modelsizfid}
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
                Marca: <Text style={styles.codeValHex}>{brandHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                Modelo: <Text style={styles.codeValHex}>{modelHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                Color: <Text style={styles.codeValHex}>{colorHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                Talle: <Text style={styles.codeValHex}>{sizeHex || '-'}</Text>
              </Text>
              <View style={{ height: 1, backgroundColor: '#eaecf0', marginVertical: 6 }} />
              <Text style={styles.rfidCodeText}>
                Prefijo radar Modelo: <Text style={styles.codeValHex}>{modelEpcHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                Prefijo radar Color: <Text style={styles.codeValHex}>{colorEpcHex || '-'}</Text>
              </Text>
              <Text style={styles.rfidCodeText}>
                Prefijo radar Talle: <Text style={styles.codeValHex}>{sizeEpcHex || '-'}</Text>
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
  scrollContent: { paddingBottom: 32 },
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
  breakdownBox: { marginTop: 8, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#fedf89', padding: 8 },
  breakdownTitle: { fontSize: 11, fontWeight: '700', color: '#7a2e0e', marginBottom: 4, fontFamily: 'monospace' },
  breakdownRow: { fontSize: 11, color: '#475467', fontFamily: 'monospace' },
  detectionReads: { fontSize: 11, color: '#667085', marginTop: 4 },
  detectionWarn: { fontSize: 11, color: '#b54708', marginTop: 6, fontWeight: '600' },
  proximityTrack: { height: 8, borderRadius: 4, backgroundColor: '#f2f4f7', marginTop: 8, overflow: 'hidden' },
  proximityFill: { height: '100%', borderRadius: 4 },
  proximityNear: { backgroundColor: '#12b76a' },
  proximityMid: { backgroundColor: '#f79009' },
  proximityFar: { backgroundColor: '#f04438' },
  proximityHint: { fontSize: 11, color: '#7a2e0e', marginTop: 4, fontWeight: '600' },

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
  terminalCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#eaecf0', marginBottom: 12, gap: 10 },
  terminalHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  terminalDot: { width: 9, height: 9, borderRadius: 5 },
  terminalTitle: { flex: 1, fontSize: 13, fontWeight: '700', color: '#344054' },
  filtersRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 },
  conStockInline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  batteryChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: '#eff8ff', borderWidth: 1, borderColor: '#b2ddff' },
  batteryChipText: { fontSize: 12, fontWeight: '700', color: '#0b63ce' },
  terminalControls: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  powerGroup: { flex: 1 },
  modeGroup: { flex: 1 },
  groupLabel: { fontSize: 11, fontWeight: '600', color: '#667085', marginBottom: 5 },
  modeToggleRow: { flexDirection: 'row', gap: 6 },
  modeToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#d0d5dd', backgroundColor: '#f9fafb' },
  modeToggleActive: { backgroundColor: '#0b63ce', borderColor: '#0b63ce' },
  modeToggleText: { fontSize: 11, fontWeight: '700', color: '#0b63ce' },
  modeToggleTextActive: { color: '#fff' },
  powerWarn: { fontSize: 11, color: '#b54708', fontWeight: '600' },
  detectionError: { fontSize: 12, color: '#b42318', fontWeight: '700', marginTop: 4 },
  moduleFaultWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef3f2', borderWidth: 1, borderColor: '#fecdca', borderRadius: 8, padding: 8 },
  moduleFaultText: { flex: 1, fontSize: 11, color: '#b42318', fontWeight: '700' },
  hidWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fffaeb', borderWidth: 1, borderColor: '#fedf89', borderRadius: 8, padding: 8 },
  hidWarningText: { flex: 1, fontSize: 11, color: '#b54708', fontWeight: '600' },
  conStockRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#f2f4f7', paddingTop: 8 },
  calibrationControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 2 },
  calibButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: '#d0d5dd', backgroundColor: '#f9fafb', justifyContent: 'center', alignItems: 'center' },
  calibButtonText: { fontSize: 16, fontWeight: '600', color: '#101828' },
  calibValue: { fontSize: 13, fontWeight: '700', color: '#0b63ce', minWidth: 50, textAlign: 'center' },
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
