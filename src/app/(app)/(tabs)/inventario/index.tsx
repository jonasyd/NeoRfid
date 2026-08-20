import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';
import { useChafonStatus } from '@/hooks/useChafonStatus';
import { enviarInventario } from '@/services/api';
import {
  NOTA_MAX,
  agregarLectura,
  cambiarCantidad,
  crearInventario,
  eliminarInventario,
  construirMascara,
  eliminarLinea,
  faltantesCabecera,
  faltantesMascara,
  guardarInventario,
  limpiarMotivo,
  listarInventarios,
  totalUnidades,
} from '@/services/inventarios';
import ChafonH103, { getChafonStatus, hexToAscii, type ChafonTag } from '@modules/chafon-h103';
import type {
  Deposito,
  Inventario,
  MascaraEpc,
  InventarioModo,
  TipoItem,
  TipoMovimiento,
} from '@/types/api';

type Paso = 'lista' | 'config' | 'grilla';

const TIPOS_ITEM: { valor: TipoItem; etiqueta: string }[] = [
  { valor: 'T', etiqueta: 'Terminado' },
  { valor: 'I', etiqueta: 'Insumo' },
  { valor: 'S', etiqueta: 'Semi elab.' },
];

const TIPOS_MOVIMIENTO: { valor: TipoMovimiento; etiqueta: string }[] = [
  { valor: 'F', etiqueta: 'Físico' },
  { valor: 'T', etiqueta: 'Tránsito' },
];

export default function InventarioScreen() {
  const { session, setDeposito } = useSession();
  const chafon = useChafonStatus();

  const [paso, setPaso] = useState<Paso>('lista');
  const [inventarios, setInventarios] = useState<Inventario[]>([]);
  const [actual, setActual] = useState<Inventario | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const [pidiendoTipo, setPidiendoTipo] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const [codigoManual, setCodigoManual] = useState('');
  const [mostrarDepositos, setMostrarDepositos] = useState(false);
  // Barrido RFID en curso. Se refleja en el botón y decide si aceptamos lecturas.
  const [barriendo, setBarriendo] = useState(false);
  const entradaRef = useRef<TextInput>(null);

  // Las pestañas mantienen las pantallas montadas, así que Stock e Inventario están suscritos a
  // las lecturas al mismo tiempo: un código escaneado en una aparecía también en la otra. Cada
  // pantalla atiende las lecturas sólo mientras está a la vista.
  const enPantallaRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      enPantallaRef.current = true;
      return () => {
        enPantallaRef.current = false;
      };
    }, [])
  );

  // El listener de la terminal necesita ver el inventario vigente sin recrearse en cada lectura.
  const actualRef = useRef<Inventario | null>(null);
  const barriendoRef = useRef(false);
  useEffect(() => {
    barriendoRef.current = barriendo;
  }, [barriendo]);
  useEffect(() => {
    actualRef.current = actual;
  }, [actual]);

  const depositoCode = session?.depositoSeleccionado?.Codigo ?? '';

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      setInventarios(await listarInventarios());
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    recargar();
  }, [recargar]);

  /* ----------------------------- lecturas ----------------------------- */

  const sumarCodigo = useCallback((codigo: string, unico = false) => {
    const inv = actualRef.current;
    if (!inv) return;
    setActual({ ...inv, lineas: agregarLectura(inv.lineas, codigo, { unico }) });
  }, []);

  useEffect(() => {
    const sub = ChafonH103.addTagListener((tag: ChafonTag) => {
      // Sólo capturamos mientras se está confeccionando y con la terminal en modo código de
      // barras: en RFID esta misma señal trae EPCs, que todavía no se cargan acá.
      if (!enPantallaRef.current) return;
      const inv = actualRef.current;
      if (!inv) return;

      if (inv.modo === 'rfid') {
        // Cada EPC es una unidad física concreta: se registra una sola vez por más que el lector
        // lo vea decenas de veces mientras barre.
        if (!barriendoRef.current) return;
        if (tag.isMatch === false) return;
        sumarCodigo(tag.epc, true);
        return;
      }

      if (getChafonStatus().readMode !== 'barcode') return;
      const valor = hexToAscii(tag.epc);
      if (valor) sumarCodigo(valor);
    });
    return () => sub.remove();
  }, [sumarCodigo]);

  /* ----------------------------- acciones ----------------------------- */

  async function elegirModo(modo: InventarioModo) {
    setPidiendoTipo(false);
    setMostrarDepositos(false);
    setError('');

    // El modo de la terminal se cambia en el momento de elegir, que es lo que se espera al
    // arrancar un inventario de un tipo u otro.
    try {
      await ChafonH103.setReadMode(modo);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar el modo de la terminal.');
    }

    if (!depositoCode) {
      setError('El depósito seleccionado no tiene código. Elegí un depósito antes de inventariar.');
      return;
    }

    try {
      const nuevo = await crearInventario({ modo, depositoCode });
      setActual(nuevo);
      setPaso('config');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo crear el inventario.');
    }
  }

  /**
   * Cambia el depósito activo.
   *
   * La selección es la misma que la del tab de Stock: se guarda en la sesión, así que elegir acá
   * también cambia sobre qué depósito consulta Stock, y al revés. Si hay un inventario en
   * confección se le actualiza el código, porque es el que va a viajar en el ajuste.
   */
  async function elegirDeposito(dep: Deposito) {
    setMostrarDepositos(false);
    try {
      await setDeposito(dep);
      setActual((inv) =>
        inv ? { ...inv, cabecera: { ...inv.cabecera, depositoCode: dep.Codigo ?? '' } } : inv
      );
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar el depósito.');
    }
  }

  function etiquetaDeposito(dep?: Deposito | null): string {
    if (!dep) return 'Seleccionar depósito';
    return dep.Sucursal ? `${dep.Sucursal} - ${dep.nombre}` : dep.nombre;
  }

  /**
   * Guarda los campos de la máscara y recalcula el prefijo.
   *
   * El prefijo se arma en cada cambio y no al confirmar, para que se vea al instante qué se va a
   * buscar: es la única forma de darse cuenta de que un valor está mal antes de salir a barrer.
   */
  function editarMascara(campo: keyof MascaraEpc, valor: string) {
    setActual((inv) => {
      if (!inv) return inv;
      const base: MascaraEpc = inv.mascara ?? { modelrfid: '', prefijo: '' };
      const campos = { ...base, [campo]: valor.trim() };
      let prefijo = '';
      try {
        prefijo = construirMascara(session?.brandPrefix ?? '', campos).prefijo;
      } catch {
        // Falta el modelo o hay un valor inválido: se deja el prefijo vacío y la validación avisa.
      }
      return { ...inv, mascara: { ...campos, prefijo } };
    });
  }

  function editarCabecera(campo: keyof Inventario['cabecera'], valor: string) {
    setActual((inv) => (inv ? { ...inv, cabecera: { ...inv.cabecera, [campo]: valor } } : inv));
  }

  async function irAGrilla() {
    if (!actual) return;
    const faltan = [
      ...faltantesCabecera(actual.cabecera),
      ...(actual.modo === 'rfid' ? faltantesMascara(actual.mascara) : []),
    ];
    if (faltan.length > 0) {
      setError(
        faltan.length === 1
          ? `Falta completar: ${faltan[0]}.`
          : `Faltan completar: ${faltan.join(', ')}.`
      );
      return;
    }
    setError('');
    await guardarInventario(actual);
    await recargar();
    setPaso('grilla');
    setTimeout(() => entradaRef.current?.focus(), 150);
  }

  async function alternarBarrido() {
    const inv = actualRef.current;
    if (!inv?.mascara?.prefijo) {
      setError('Definí la máscara antes de barrer.');
      return;
    }
    try {
      if (barriendo) {
        await ChafonH103.stopInventory();
        await ChafonH103.clearDetectionMask();
        setBarriendo(false);
      } else {
        ChafonH103.resetDiagnostics();
        await ChafonH103.startDetection(inv.mascara.prefijo);
        setBarriendo(true);
      }
      setError('');
    } catch (e: any) {
      setBarriendo(false);
      setError(e?.message ?? 'No se pudo cambiar el estado del barrido.');
    }
  }

  function agregarManual() {
    const codigo = codigoManual.trim();
    if (!codigo) return;
    sumarCodigo(codigo);
    setCodigoManual('');
    entradaRef.current?.focus();
  }

  async function guardarYSalir(estado: Inventario['estado']) {
    if (!actual) return;
    if (barriendo) {
      try {
        await ChafonH103.stopInventory();
        await ChafonH103.clearDetectionMask();
      } catch {}
      setBarriendo(false);
    }
    await guardarInventario({ ...actual, estado });
    await recargar();
    setActual(null);
    setPaso('lista');
  }

  async function enviar(inv: Inventario) {
    setEnviando(true);
    setError('');
    try {
      await enviarInventario(inv);
      await guardarInventario({ ...inv, estado: 'enviado', ultimoError: undefined });
      await recargar();
      setConfirmando(false);
      setActual(null);
      setPaso('lista');
      Alert.alert('Inventario aplicado', `El ajuste ${inv.cabecera.idAjuste} se envió correctamente.`);
    } catch (e: any) {
      const mensaje = e?.response?.data?.message ?? e?.message ?? 'No se pudo enviar el inventario.';
      await guardarInventario({ ...inv, estado: 'error', ultimoError: mensaje });
      await recargar();
      setError(mensaje);
    } finally {
      setEnviando(false);
    }
  }

  function confirmarBorrado(inv: Inventario) {
    Alert.alert('Eliminar inventario', `¿Eliminar el ajuste ${inv.cabecera.idAjuste}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          await eliminarInventario(inv.id);
          await recargar();
        },
      },
    ]);
  }

  /* ----------------------------- pantallas ----------------------------- */

  if (paso === 'lista') {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.encabezado}>
            <Text style={styles.titulo}>INVENTARIOS</Text>
            <Pressable style={styles.botonNuevo} onPress={() => setPidiendoTipo(true)}>
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.botonNuevoTexto}>Nuevo</Text>
            </Pressable>
          </View>

          <SelectorDeposito
            seleccionado={session?.depositoSeleccionado}
            depositos={session?.depositos ?? []}
            abierto={mostrarDepositos}
            onAlternar={() => setMostrarDepositos((v) => !v)}
            onElegir={elegirDeposito}
            etiqueta={etiquetaDeposito}
          />

          <Text style={styles.ayuda}>
            Se conservan los últimos 10. Al crear uno nuevo se descarta el más viejo.
          </Text>

          {!!error && <Text style={styles.error}>{error}</Text>}
          {cargando && <ActivityIndicator style={{ marginVertical: 20 }} />}

          {!cargando && inventarios.length === 0 && (
            <View style={styles.vacio}>
              <Ionicons name="clipboard-outline" size={64} color="#98a2b3" />
              <Text style={styles.vacioTexto}>Todavía no hay inventarios.</Text>
            </View>
          )}

          {inventarios.map((inv) => (
            <Pressable
              key={inv.id}
              style={styles.fila}
              onPress={() => {
                setActual(inv);
                setPaso(inv.estado === 'borrador' ? 'grilla' : 'config');
              }}
            >
              <View style={[styles.modoChip, inv.modo === 'rfid' ? styles.chipRfid : styles.chipBarcode]}>
                <Ionicons
                  name={inv.modo === 'rfid' ? 'radio-outline' : 'barcode-outline'}
                  size={14}
                  color={inv.modo === 'rfid' ? '#6941c6' : '#0b63ce'}
                />
                <Text style={[styles.modoChipTexto, inv.modo === 'rfid' && { color: '#6941c6' }]}>
                  {inv.modo === 'rfid' ? 'RFID' : 'Barcode'}
                </Text>
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.filaId}>{inv.cabecera.idAjuste}</Text>
                <Text style={styles.filaMeta}>
                  {inv.cabecera.fecha} · {inv.lineas.length} códigos · {totalUnidades(inv.lineas)} u.
                </Text>
                {!!inv.ultimoError && <Text style={styles.filaError}>{inv.ultimoError}</Text>}
              </View>

              <View style={styles.filaDerecha}>
                <Text style={[styles.estado, estadoEstilo(inv.estado)]}>{estadoTexto(inv.estado)}</Text>
                <Pressable onPress={() => confirmarBorrado(inv)} hitSlop={8}>
                  <Ionicons name="trash-outline" size={18} color="#b42318" />
                </Pressable>
              </View>
            </Pressable>
          ))}

          {inventarios.some((i) => i.estado === 'pendiente' || i.estado === 'error') && (
            <Text style={styles.ayuda}>
              Los inventarios pendientes o con error se reenvían abriéndolos y tocando Finalizar.
            </Text>
          )}
        </ScrollView>

        <Modal visible={pidiendoTipo} transparent animationType="fade" onRequestClose={() => setPidiendoTipo(false)}>
          <View style={styles.modalFondo}>
            <View style={styles.modalCaja}>
              <Text style={styles.modalTitulo}>¿Qué tipo de inventario?</Text>
              <Text style={styles.modalTexto}>
                La terminal se va a poner en el modo correspondiente.
              </Text>

              <Pressable style={styles.modalOpcion} onPress={() => elegirModo('barcode')}>
                <Ionicons name="barcode-outline" size={22} color="#0b63ce" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalOpcionTitulo}>Código de barras</Text>
                  <Text style={styles.modalOpcionTexto}>Lectura del escáner 2D de la terminal.</Text>
                </View>
              </Pressable>

              <Pressable style={styles.modalOpcion} onPress={() => elegirModo('rfid')}>
                <Ionicons name="radio-outline" size={22} color="#6941c6" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalOpcionTitulo}>RFID</Text>
                  <Text style={styles.modalOpcionTexto}>Lectura de tags por radiofrecuencia.</Text>
                </View>
              </Pressable>

              <Pressable style={styles.modalCancelar} onPress={() => setPidiendoTipo(false)}>
                <Text style={styles.modalCancelarTexto}>Cancelar</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </Screen>
    );
  }

  if (!actual) return null;

  if (paso === 'config') {
    // Se recalcula en cada render para que el botón refleje el estado del formulario al instante.
    const faltantes = [
      ...faltantesCabecera(actual.cabecera),
      ...(actual.modo === 'rfid' ? faltantesMascara(actual.mascara) : []),
    ];
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.encabezado}>
            <Pressable onPress={() => setPaso('lista')} hitSlop={8}>
              <Ionicons name="arrow-back" size={22} color="#101828" />
            </Pressable>
            <Text style={styles.titulo}>CONFIGURAR</Text>
            <View style={{ width: 22 }} />
          </View>

          <Campo etiqueta="Número de inventario">
            <Text style={styles.soloLectura}>{actual.cabecera.idAjuste}</Text>
          </Campo>

          <Campo etiqueta="Fecha">
            <Text style={styles.soloLectura}>{actual.cabecera.fecha}</Text>
          </Campo>

          <Campo etiqueta="Depósito">
            <SelectorDeposito
              seleccionado={session?.depositoSeleccionado}
              depositos={session?.depositos ?? []}
              abierto={mostrarDepositos}
              onAlternar={() => setMostrarDepositos((v) => !v)}
              onElegir={elegirDeposito}
              etiqueta={etiquetaDeposito}
              sinTitulo
            />
          </Campo>

          <Campo etiqueta="Tipo de ítem">
            <View style={styles.chips}>
              {TIPOS_ITEM.map((t) => (
                <Pressable
                  key={t.valor}
                  style={[styles.chip, actual.cabecera.tipoItem === t.valor && styles.chipActivo]}
                  onPress={() => editarCabecera('tipoItem', t.valor)}
                >
                  <Text
                    style={[styles.chipTexto, actual.cabecera.tipoItem === t.valor && styles.chipTextoActivo]}
                  >
                    {t.etiqueta}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Campo>

          <Campo etiqueta="Tipo de movimiento">
            <View style={styles.chips}>
              {TIPOS_MOVIMIENTO.map((t) => (
                <Pressable
                  key={t.valor}
                  style={[styles.chip, actual.cabecera.tipoMovimiento === t.valor && styles.chipActivo]}
                  onPress={() => editarCabecera('tipoMovimiento', t.valor)}
                >
                  <Text
                    style={[
                      styles.chipTexto,
                      actual.cabecera.tipoMovimiento === t.valor && styles.chipTextoActivo,
                    ]}
                  >
                    {t.etiqueta}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Campo>

          <Campo etiqueta="Código de motivo">
            <TextInput
              style={styles.entrada}
              value={actual.cabecera.motivoCode}
              onChangeText={(v) => editarCabecera('motivoCode', limpiarMotivo(v))}
              autoCapitalize="characters"
              placeholder="Por ejemplo: SM"
              placeholderTextColor="#98a2b3"
            />
          </Campo>

          <Campo etiqueta={`Nota (${actual.cabecera.nota.length}/${NOTA_MAX})`}>
            <TextInput
              style={[styles.entrada, styles.entradaMultilinea]}
              value={actual.cabecera.nota}
              onChangeText={(v) => editarCabecera('nota', v)}
              maxLength={NOTA_MAX}
              multiline
            />
          </Campo>

          {actual.modo === 'rfid' && (
            <View style={styles.mascaraCaja}>
              <Text style={styles.mascaraTitulo}>Máscara de búsqueda EPC</Text>
              <Text style={styles.ayudaChica}>
                Arranca con la marca de la sesión. El modelo es obligatorio; el color y el talle
                van angostando la búsqueda.
              </Text>

              <Campo etiqueta="Marca (de la sesión)">
                <Text style={styles.soloLectura}>{session?.brandPrefix || '—'}</Text>
              </Campo>

              <Campo etiqueta="Modelo (modelrfid) *">
                <TextInput
                  style={styles.entrada}
                  value={actual.mascara?.modelrfid ?? ''}
                  onChangeText={(v) => editarMascara('modelrfid', v)}
                  keyboardType="number-pad"
                  placeholder="Obligatorio"
                  placeholderTextColor="#98a2b3"
                />
              </Campo>

              <View style={styles.mascaraFila}>
                <View style={{ flex: 1 }}>
                  <Campo etiqueta="Color (opcional)">
                    <TextInput
                      style={styles.entrada}
                      value={actual.mascara?.modelcolrfid ?? ''}
                      onChangeText={(v) => editarMascara('modelcolrfid', v)}
                      keyboardType="number-pad"
                    />
                  </Campo>
                </View>
                <View style={{ flex: 1 }}>
                  <Campo etiqueta="Talle (opcional)">
                    <TextInput
                      style={styles.entrada}
                      value={actual.mascara?.modelsizfid ?? ''}
                      onChangeText={(v) => editarMascara('modelsizfid', v)}
                      keyboardType="number-pad"
                    />
                  </Campo>
                </View>
              </View>

              {!!actual.mascara?.modelsizfid && !actual.mascara?.modelcolrfid && (
                <Text style={styles.avisoMascara}>
                  El talle sólo se puede usar junto con el color: por ahora se busca sólo por modelo.
                </Text>
              )}

              <Campo etiqueta="Prefijo que se va a buscar">
                <Text style={[styles.soloLectura, styles.prefijo]}>
                  {actual.mascara?.prefijo || '—'}
                </Text>
              </Campo>
            </View>
          )}

          <View style={styles.filaSwitch}>
            <View style={{ flex: 1 }}>
              <Text style={styles.etiqueta}>Ajusta por diferencia</Text>
              <Text style={styles.ayudaChica}>
                {actual.cabecera.ajustaPorDiferencia === 'S' ? 'Sí (S)' : 'No (N)'}
              </Text>
            </View>
            <Switch
              value={actual.cabecera.ajustaPorDiferencia === 'S'}
              onValueChange={(v) => editarCabecera('ajustaPorDiferencia', v ? 'S' : 'N')}
              trackColor={{ false: '#d0d5dd', true: '#b2ddff' }}
              thumbColor={actual.cabecera.ajustaPorDiferencia === 'S' ? '#0b63ce' : '#f2f4f7'}
            />
          </View>

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.botonPrimario, faltantes.length > 0 && styles.botonDeshabilitado]}
            onPress={irAGrilla}
            disabled={faltantes.length > 0}
          >
            <Text style={styles.botonPrimarioTexto}>
              {faltantes.length > 0 ? `Falta: ${faltantes[0]}` : 'Continuar'}
            </Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </Pressable>
        </ScrollView>
      </Screen>
    );
  }

  /* ------------------------------ grilla ------------------------------ */

  const unidades = totalUnidades(actual.lineas);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.encabezado}>
          <Pressable onPress={() => setPaso('config')} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color="#101828" />
          </Pressable>
          <Text style={styles.titulo}>{actual.cabecera.idAjuste}</Text>
          <View style={[styles.puntoTerminal, chafon.connected ? styles.puntoVerde : styles.puntoRojo]} />
        </View>

        <View style={styles.resumen}>
          <Text style={styles.resumenTexto}>
            {actual.lineas.length} códigos · {unidades} unidades
          </Text>
          <Text style={styles.resumenTexto}>
            {actual.cabecera.tipoItem} / {actual.cabecera.tipoMovimiento} · {actual.cabecera.motivoCode}
          </Text>
        </View>

        {actual.modo === 'rfid' ? (
          <>
            <View style={styles.mascaraResumen}>
              <Ionicons name="radio-outline" size={16} color="#6941c6" />
              <Text style={styles.mascaraResumenTexto} numberOfLines={1}>
                Buscando {actual.mascara?.prefijo}
              </Text>
            </View>

            <Pressable
              style={[styles.botonPrimario, barriendo && styles.botonDetener]}
              onPress={alternarBarrido}
            >
              <Ionicons name={barriendo ? 'stop-circle-outline' : 'play'} size={18} color="#fff" />
              <Text style={styles.botonPrimarioTexto}>
                {barriendo ? 'Detener barrido' : 'Iniciar barrido'}
              </Text>
            </Pressable>
          </>
        ) : (
        <View style={styles.entradaFila}>
          <Ionicons name="barcode-outline" size={20} color="#667085" />
          <TextInput
            ref={entradaRef}
            style={styles.entradaCodigo}
            value={codigoManual}
            onChangeText={setCodigoManual}
            onSubmitEditing={agregarManual}
            placeholder="Escaneá o escribí un código"
            placeholderTextColor="#98a2b3"
            autoCapitalize="characters"
            returnKeyType="done"
          />
          <Pressable style={styles.botonAgregar} onPress={agregarManual}>
            <Ionicons name="add" size={20} color="#fff" />
          </Pressable>
        </View>
        )}

        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.grillaCabecera}>
          <Text style={[styles.grillaTitulo, { flex: 1 }]}>
            {actual.modo === 'rfid' ? 'EPC detectado' : 'Código de barras'}
          </Text>
          {actual.modo === 'barcode' && (
            <Text style={[styles.grillaTitulo, { width: 130, textAlign: 'center' }]}>Cantidad</Text>
          )}
          <View style={{ width: 28 }} />
        </View>

        {actual.lineas.length === 0 && (
          <Text style={styles.vacioTexto}>
            {actual.modo === 'rfid' ? 'Sin EPC detectados todavía.' : 'Sin lecturas todavía.'}
          </Text>
        )}

        {actual.lineas.map((linea) => (
          <View key={linea.codigo} style={styles.grillaFila}>
            <Text style={styles.codigo} numberOfLines={1}>
              {linea.codigo}
            </Text>

            {actual.modo === 'barcode' && (
            <View style={styles.cantidadCaja}>
              <Pressable
                style={styles.cantidadBoton}
                onPress={() =>
                  setActual({ ...actual, lineas: cambiarCantidad(actual.lineas, linea.codigo, linea.cantidad - 1) })
                }
              >
                <Ionicons name="remove" size={16} color="#0b63ce" />
              </Pressable>

              <TextInput
                style={styles.cantidadEntrada}
                value={String(linea.cantidad)}
                onChangeText={(v) => {
                  const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
                  setActual({
                    ...actual,
                    lineas: cambiarCantidad(actual.lineas, linea.codigo, Number.isNaN(n) ? 0 : n),
                  });
                }}
                keyboardType="number-pad"
                selectTextOnFocus
              />

              <Pressable
                style={styles.cantidadBoton}
                onPress={() =>
                  setActual({ ...actual, lineas: cambiarCantidad(actual.lineas, linea.codigo, linea.cantidad + 1) })
                }
              >
                <Ionicons name="add" size={16} color="#0b63ce" />
              </Pressable>
            </View>
            )}

            <Pressable
              onPress={() => setActual({ ...actual, lineas: eliminarLinea(actual.lineas, linea.codigo) })}
              hitSlop={8}
            >
              <Ionicons name="trash-outline" size={18} color="#b42318" />
            </Pressable>
          </View>
        ))}

        <View style={styles.acciones}>
          <Pressable style={styles.botonSecundario} onPress={() => guardarYSalir('borrador')}>
            <Ionicons name="save-outline" size={18} color="#0b63ce" />
            <Text style={styles.botonSecundarioTexto}>Guardar borrador</Text>
          </Pressable>

          <Pressable
            style={[styles.botonPrimario, actual.lineas.length === 0 && styles.botonDeshabilitado]}
            onPress={() => setConfirmando(true)}
            disabled={actual.lineas.length === 0}
          >
            <Text style={styles.botonPrimarioTexto}>Finalizar</Text>
            <Ionicons name="checkmark" size={18} color="#fff" />
          </Pressable>
        </View>
      </ScrollView>

      <Modal visible={confirmando} transparent animationType="fade" onRequestClose={() => setConfirmando(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalCaja}>
            <Text style={styles.modalTitulo}>¿Desea aplicar el inventario ahora?</Text>
            <Text style={styles.modalTexto}>
              {actual.lineas.length} códigos, {unidades} unidades, ajuste {actual.cabecera.idAjuste}.
            </Text>

            {!!error && <Text style={styles.error}>{error}</Text>}
            {enviando && <ActivityIndicator style={{ marginVertical: 10 }} />}

            {!enviando && (
              <>
                <Pressable style={styles.botonPrimario} onPress={() => enviar(actual)}>
                  <Text style={styles.botonPrimarioTexto}>{error ? 'Reintentar' : 'Sí, aplicar ahora'}</Text>
                </Pressable>

                <Pressable style={styles.botonSecundario} onPress={() => guardarYSalir('pendiente')}>
                  <Ionicons name="time-outline" size={18} color="#0b63ce" />
                  <Text style={styles.botonSecundarioTexto}>Guardar para enviar más tarde</Text>
                </Pressable>

                <Pressable
                  style={styles.modalCancelar}
                  onPress={() => {
                    setError('');
                    setConfirmando(false);
                  }}
                >
                  <Text style={styles.modalCancelarTexto}>No, volver a la grilla</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

/**
 * Desplegable de depósitos. Muestra el código junto al nombre porque es el dato que termina
 * viajando en el ajuste, y sin verlo no hay forma de darse cuenta de que falta.
 */
function SelectorDeposito({
  seleccionado,
  depositos,
  abierto,
  onAlternar,
  onElegir,
  etiqueta,
  sinTitulo,
}: {
  seleccionado?: Deposito | null;
  depositos: Deposito[];
  abierto: boolean;
  onAlternar: () => void;
  onElegir: (dep: Deposito) => void;
  etiqueta: (dep?: Deposito | null) => string;
  sinTitulo?: boolean;
}) {
  return (
    <View style={styles.depositoCaja}>
      {!sinTitulo && <Text style={styles.etiqueta}>Depósito</Text>}

      <Pressable style={styles.depositoSelector} onPress={onAlternar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.depositoNombre} numberOfLines={1}>
            {etiqueta(seleccionado)}
          </Text>
          <Text style={[styles.depositoCodigo, !seleccionado?.Codigo && styles.depositoSinCodigo]}>
            {seleccionado?.Codigo ? `Código: ${seleccionado.Codigo}` : 'Sin código: no se puede inventariar'}
          </Text>
        </View>
        <Ionicons name={abierto ? 'chevron-up' : 'chevron-down'} size={20} color="#475467" />
      </Pressable>

      {abierto && (
        <View style={styles.depositoLista}>
          {depositos.length === 0 && <Text style={styles.ayudaChica}>No hay depósitos disponibles.</Text>}
          {depositos.map((dep) => {
            const activo = seleccionado?.uuid === dep.uuid;
            return (
              <Pressable
                key={dep.uuid}
                style={[styles.depositoItem, activo && styles.depositoItemActivo]}
                onPress={() => onElegir(dep)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.depositoItemTexto, activo && styles.depositoItemTextoActivo]}>
                    {etiqueta(dep)}
                  </Text>
                  <Text style={styles.depositoCodigo}>{dep.Codigo ?? 'sin código'}</Text>
                </View>
                {activo && <Ionicons name="checkmark" size={18} color="#0b63ce" />}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function Campo({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      {children}
    </View>
  );
}

function estadoTexto(estado: Inventario['estado']): string {
  if (estado === 'enviado') return 'Enviado';
  if (estado === 'pendiente') return 'Pendiente';
  if (estado === 'error') return 'Error';
  return 'Borrador';
}

function estadoEstilo(estado: Inventario['estado']) {
  if (estado === 'enviado') return styles.estadoEnviado;
  if (estado === 'error') return styles.estadoError;
  if (estado === 'pendiente') return styles.estadoPendiente;
  return styles.estadoBorrador;
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32, gap: 12 },
  encabezado: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  titulo: { fontSize: 20, fontWeight: '800', color: '#101828', letterSpacing: 0.5 },
  ayuda: { fontSize: 12, color: '#667085' },
  ayudaChica: { fontSize: 12, color: '#667085', marginTop: 2 },
  error: { color: '#b42318', fontWeight: '600', fontSize: 13 },

  botonNuevo: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#0b63ce', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
  },
  botonNuevoTexto: { color: '#fff', fontWeight: '700' },

  vacio: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  vacioTexto: { color: '#667085', textAlign: 'center' },

  fila: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#eaecf0',
  },
  filaId: { fontWeight: '700', color: '#101828' },
  filaMeta: { fontSize: 12, color: '#667085', marginTop: 2 },
  filaError: { fontSize: 11, color: '#b42318', marginTop: 2 },
  filaDerecha: { alignItems: 'flex-end', gap: 8 },

  modoChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  chipBarcode: { backgroundColor: '#eff8ff' },
  chipRfid: { backgroundColor: '#f4f3ff' },
  modoChipTexto: { fontSize: 11, fontWeight: '700', color: '#0b63ce' },

  estado: { fontSize: 11, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  estadoBorrador: { backgroundColor: '#f2f4f7', color: '#475467' },
  estadoPendiente: { backgroundColor: '#fffaeb', color: '#b54708' },
  estadoEnviado: { backgroundColor: '#ecfdf3', color: '#027a48' },
  estadoError: { backgroundColor: '#fef3f2', color: '#b42318' },

  depositoCaja: { gap: 6 },
  depositoSelector: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
  },
  depositoNombre: { fontWeight: '600', color: '#101828' },
  depositoCodigo: { fontSize: 11, color: '#667085', marginTop: 2 },
  depositoSinCodigo: { color: '#b42318', fontWeight: '700' },
  depositoLista: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#eaecf0',
    borderRadius: 10, overflow: 'hidden',
  },
  depositoItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#f2f4f7',
  },
  depositoItemActivo: { backgroundColor: '#eff8ff' },
  depositoItemTexto: { color: '#344054', fontWeight: '600' },
  depositoItemTextoActivo: { color: '#0b63ce' },

  mascaraCaja: {
    gap: 10, backgroundColor: '#faf9ff', borderWidth: 1, borderColor: '#e9d7fe',
    borderRadius: 12, padding: 14,
  },
  mascaraTitulo: { fontWeight: '800', color: '#6941c6' },
  mascaraFila: { flexDirection: 'row', gap: 10 },
  prefijo: { fontWeight: '700', color: '#101828', letterSpacing: 1 },
  avisoMascara: { fontSize: 11, color: '#b54708', fontWeight: '600' },
  mascaraResumen: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f4f3ff', borderRadius: 10, padding: 10,
  },
  mascaraResumenTexto: { flex: 1, fontSize: 12, color: '#6941c6', fontWeight: '700', letterSpacing: 0.5 },
  botonDetener: { backgroundColor: '#b42318' },

  campo: { gap: 6 },
  etiqueta: { fontSize: 13, fontWeight: '700', color: '#344054' },
  soloLectura: {
    backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#eaecf0',
    borderRadius: 10, padding: 12, color: '#475467',
  },
  entrada: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd',
    borderRadius: 10, padding: 12, color: '#101828',
  },
  entradaMultilinea: { minHeight: 70, textAlignVertical: 'top' },

  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: '#d0d5dd', backgroundColor: '#fff',
  },
  chipActivo: { backgroundColor: '#0b63ce', borderColor: '#0b63ce' },
  chipTexto: { fontSize: 13, fontWeight: '600', color: '#475467' },
  chipTextoActivo: { color: '#fff' },

  filaSwitch: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },

  botonPrimario: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#0b63ce', borderRadius: 12, paddingVertical: 14, marginTop: 8,
  },
  botonPrimarioTexto: { color: '#fff', fontWeight: '700', fontSize: 15 },
  botonDeshabilitado: { backgroundColor: '#b2ddff' },
  botonSecundario: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: '#0b63ce', borderRadius: 12, paddingVertical: 13, marginTop: 8,
  },
  botonSecundarioTexto: { color: '#0b63ce', fontWeight: '700' },

  puntoTerminal: { width: 12, height: 12, borderRadius: 6 },
  puntoVerde: { backgroundColor: '#12b76a' },
  puntoRojo: { backgroundColor: '#f04438' },

  resumen: {
    backgroundColor: '#f9fafb', borderRadius: 10, padding: 10,
    borderWidth: 1, borderColor: '#eaecf0', gap: 2,
  },
  resumenTexto: { fontSize: 12, color: '#475467' },

  entradaFila: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4,
  },
  entradaCodigo: { flex: 1, paddingVertical: 10, color: '#101828' },
  botonAgregar: { backgroundColor: '#0b63ce', borderRadius: 8, padding: 6 },

  grillaCabecera: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingTop: 6,
  },
  grillaTitulo: { fontSize: 11, fontWeight: '700', color: '#667085', textTransform: 'uppercase', letterSpacing: 0.4 },
  grillaFila: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: 10, padding: 10,
    borderWidth: 1, borderColor: '#eaecf0',
  },
  codigo: { flex: 1, fontWeight: '600', color: '#101828', fontSize: 13 },
  cantidadCaja: { flexDirection: 'row', alignItems: 'center', width: 130, justifyContent: 'center', gap: 4 },
  cantidadBoton: { padding: 6, borderRadius: 6, backgroundColor: '#eff8ff' },
  cantidadEntrada: {
    width: 52, textAlign: 'center', paddingVertical: 6,
    borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, color: '#101828', fontWeight: '700',
  },

  acciones: { marginTop: 8 },

  modalFondo: { flex: 1, backgroundColor: 'rgba(16,24,40,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCaja: { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 20, gap: 6 },
  modalTitulo: { fontSize: 17, fontWeight: '800', color: '#101828' },
  modalTexto: { fontSize: 13, color: '#667085', marginBottom: 6 },
  modalOpcion: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: '#eaecf0', borderRadius: 12, padding: 14, marginTop: 6,
  },
  modalOpcionTitulo: { fontWeight: '700', color: '#101828' },
  modalOpcionTexto: { fontSize: 12, color: '#667085', marginTop: 2 },
  modalCancelar: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  modalCancelarTexto: { color: '#667085', fontWeight: '600' },
});
