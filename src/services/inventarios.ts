import * as FileSystem from 'expo-file-system/legacy';
import { buildEpc, type EpcDetectionMode } from '@/services/epc';
import type {
  AjustaPorDiferencia,
  MascaraEpc,
  Inventario,
  InventarioCabecera,
  InventarioEstado,
  InventarioLinea,
  InventarioModo,
  TipoItem,
  TipoMovimiento,
} from '@/types/api';

/**
 * Almacén local de inventarios.
 *
 * Se guarda en un archivo JSON del directorio de documentos y no en SecureStore: allí los valores
 * tienen un tope de unos pocos kilobytes y un inventario con cientos de lecturas lo pasa de largo.
 */
// v2: las líneas pasaron de `barcode` a `codigo` para poder alojar también EPCs. Se cambia el
// nombre del archivo en vez de migrar: los borradores viejos se descartan solos.
const ARCHIVO = 'inventarios.v2.json';

/** Cuántos inventarios se conservan. Al superarlo se descarta el más viejo. */
export const MAX_INVENTARIOS = 10;

/** Longitud máxima del campo de nota, según el endpoint. */
export const NOTA_MAX = 150;

type Almacen = {
  /** Se incrementa con cada inventario nuevo y forma la primera parte del idAjuste. */
  contador: number;
  inventarios: Inventario[];
};

const VACIO: Almacen = { contador: 0, inventarios: [] };

function ruta(): string {
  return `${FileSystem.documentDirectory}${ARCHIVO}`;
}

async function leer(): Promise<Almacen> {
  try {
    const info = await FileSystem.getInfoAsync(ruta());
    if (!info.exists) return { ...VACIO };
    const crudo = await FileSystem.readAsStringAsync(ruta());
    const datos = JSON.parse(crudo) as Partial<Almacen>;
    return {
      contador: typeof datos.contador === 'number' ? datos.contador : 0,
      inventarios: Array.isArray(datos.inventarios) ? datos.inventarios : [],
    };
  } catch {
    // Archivo ausente o corrupto: se arranca de cero en vez de dejar la pantalla rota.
    return { ...VACIO };
  }
}

async function escribir(almacen: Almacen): Promise<void> {
  await FileSystem.writeAsStringAsync(ruta(), JSON.stringify(almacen));
}

/** "YYYY-MM-DD HH:mm:ss" — el formato que espera el campo `fecha`. */
export function fechaHora(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** "yyyyMMddHHmmss" — la segunda parte del idAjuste. */
function selloTemporal(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Reserva el próximo número de inventario y arma el idAjuste.
 *
 * El contador se persiste antes de devolver el id, así que dos inventarios creados en el mismo
 * segundo tampoco chocan.
 */
export async function siguienteIdAjuste(ahora: Date = new Date()): Promise<string> {
  const almacen = await leer();
  almacen.contador += 1;
  await escribir(almacen);
  return `${almacen.contador}-${selloTemporal(ahora)}`;
}

/** Inventarios guardados, del más reciente al más viejo. */
export async function listarInventarios(): Promise<Inventario[]> {
  const almacen = await leer();
  return [...almacen.inventarios].sort((a, b) => b.creadoEn - a.creadoEn);
}

export async function obtenerInventario(id: string): Promise<Inventario | null> {
  const almacen = await leer();
  return almacen.inventarios.find((i) => i.id === id) ?? null;
}

/**
 * Crea o actualiza un inventario y conserva sólo los MAX_INVENTARIOS más recientes.
 *
 * El recorte va por fecha de creación, no de modificación: si no, reabrir un borrador viejo lo
 * rejuvenecería y empujaría afuera a uno más nuevo.
 */
export async function guardarInventario(inv: Inventario): Promise<Inventario[]> {
  const almacen = await leer();
  const i = almacen.inventarios.findIndex((x) => x.id === inv.id);
  const actualizado: Inventario = { ...inv, actualizadoEn: Date.now() };
  if (i >= 0) almacen.inventarios[i] = actualizado;
  else almacen.inventarios.push(actualizado);

  almacen.inventarios.sort((a, b) => b.creadoEn - a.creadoEn);
  almacen.inventarios = almacen.inventarios.slice(0, MAX_INVENTARIOS);

  await escribir(almacen);
  return almacen.inventarios;
}

export async function eliminarInventario(id: string): Promise<Inventario[]> {
  const almacen = await leer();
  almacen.inventarios = almacen.inventarios.filter((x) => x.id !== id);
  await escribir(almacen);
  return almacen.inventarios;
}

export async function marcarEstado(
  id: string,
  estado: InventarioEstado,
  ultimoError?: string
): Promise<void> {
  const almacen = await leer();
  const inv = almacen.inventarios.find((x) => x.id === id);
  if (!inv) return;
  inv.estado = estado;
  inv.ultimoError = ultimoError;
  inv.actualizadoEn = Date.now();
  await escribir(almacen);
}

/** Arma un inventario nuevo en blanco, listo para configurar. */
export async function crearInventario(params: {
  modo: InventarioModo;
  depositoCode: string;
  tipoItem?: TipoItem;
  tipoMovimiento?: TipoMovimiento;
  ajustaPorDiferencia?: AjustaPorDiferencia;
}): Promise<Inventario> {
  const ahora = new Date();
  const idAjuste = await siguienteIdAjuste(ahora);
  const cabecera: InventarioCabecera = {
    idAjuste,
    tipoItem: params.tipoItem ?? 'T',
    tipoMovimiento: params.tipoMovimiento ?? 'F',
    fecha: fechaHora(ahora),
    depositoCode: params.depositoCode,
    motivoCode: '',
    nota: '',
    ajustaPorDiferencia: params.ajustaPorDiferencia ?? 'N',
  };
  return {
    id: idAjuste,
    modo: params.modo,
    cabecera,
    lineas: [],
    estado: 'borrador',
    creadoEn: ahora.getTime(),
    actualizadoEn: ahora.getTime(),
  };
}

/**
 * Agrega una lectura al principio de la lista, que es donde se la espera ver al escanear.
 *
 * Con `unico` en true la lectura repetida se ignora en vez de sumar: es el caso de RFID, donde
 * cada EPC identifica una unidad física concreta y leerla dos veces no significa dos unidades.
 * En código de barras, en cambio, cada lectura repetida sí suma.
 */
export function agregarLectura(
  lineas: InventarioLinea[],
  codigo: string,
  opciones: { cantidad?: number; unico?: boolean } = {}
): InventarioLinea[] {
  const { cantidad = 1, unico = false } = opciones;
  const limpio = codigo.trim();
  if (!limpio) return lineas;
  const i = lineas.findIndex((l) => l.codigo === limpio);
  if (i < 0) return [{ codigo: limpio, cantidad }, ...lineas];
  if (unico) return lineas;
  const copia = [...lineas];
  copia[i] = { ...copia[i], cantidad: copia[i].cantidad + cantidad };
  return copia;
}

export function cambiarCantidad(lineas: InventarioLinea[], codigo: string, cantidad: number): InventarioLinea[] {
  if (cantidad <= 0) return lineas.filter((l) => l.codigo !== codigo);
  return lineas.map((l) => (l.codigo === codigo ? { ...l, cantidad } : l));
}

export function eliminarLinea(lineas: InventarioLinea[], codigo: string): InventarioLinea[] {
  return lineas.filter((l) => l.codigo !== codigo);
}

/**
 * Arma el prefijo de búsqueda de un inventario por RFID.
 *
 * El modelo es obligatorio; el color y el talle van refinando. Se reusa el mismo armador que usa
 * el radar de Stock, así que la codificación es exactamente la misma que la de los tags.
 */
export function construirMascara(
  brandPrefix: string,
  campos: { modelrfid: string; modelcolrfid?: string; modelsizfid?: string }
): MascaraEpc {
  const modelrfid = campos.modelrfid.trim();
  const modelcolrfid = campos.modelcolrfid?.trim() || undefined;
  const modelsizfid = campos.modelsizfid?.trim() || undefined;
  if (!modelrfid) throw new Error('El modelo es obligatorio para buscar por RFID.');
  // El talle sólo se puede usar junto con el color, igual que en el radar de Stock.
  const mode: EpcDetectionMode = modelsizfid && modelcolrfid ? 'size' : modelcolrfid ? 'color' : 'model';
  const { epc } = buildEpc({ brandPrefix, modelrfid, modelcolrfid, modelsizfid }, mode);
  return { modelrfid, modelcolrfid, modelsizfid, prefijo: epc };
}

export function totalUnidades(lineas: InventarioLinea[]): number {
  return lineas.reduce((acc, l) => acc + l.cantidad, 0);
}

/**
 * Campos de la cabecera que tienen que estar completos para poder arrancar el inventario.
 *
 * La nota queda afuera a propósito: es texto libre y opcional. El resto sí se valida acá y no
 * recién al enviar, porque descubrir que falta el motivo después de escanear doscientos códigos
 * es tarde.
 */
export function faltantesMascara(mascara?: MascaraEpc): string[] {
  if (!mascara?.modelrfid?.trim()) return ['Modelo (modelrfid)'];
  return [];
}

export function faltantesCabecera(c: InventarioCabecera): string[] {
  const faltan: string[] = [];
  if (!c.idAjuste?.trim()) faltan.push('Número de inventario');
  if (!c.fecha?.trim()) faltan.push('Fecha');
  if (!c.depositoCode?.trim()) faltan.push('Depósito');
  if (!c.tipoItem) faltan.push('Tipo de ítem');
  if (!c.tipoMovimiento) faltan.push('Tipo de movimiento');
  if (!c.motivoCode?.trim()) faltan.push('Código de motivo');
  if (c.ajustaPorDiferencia !== 'S' && c.ajustaPorDiferencia !== 'N') faltan.push('Ajusta por diferencia');
  return faltan;
}

/** El endpoint no acepta espacios en el motivo, así que se limpian al vuelo. */
export function limpiarMotivo(valor: string): string {
  return valor.replace(/\s+/g, '');
}
