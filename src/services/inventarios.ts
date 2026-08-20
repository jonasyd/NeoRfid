import * as FileSystem from 'expo-file-system/legacy';
import type {
  AjustaPorDiferencia,
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
const ARCHIVO = 'inventarios.v1.json';

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
    // El endpoint de ejemplo repite el idAjuste como nota; sirve de valor inicial razonable.
    nota: idAjuste,
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
 * Agrega una lectura agrupando por código: si ya estaba, suma a su cantidad; si no, la agrega al
 * principio, que es donde se la espera ver al escanear.
 */
export function agregarLectura(lineas: InventarioLinea[], codigo: string, cantidad = 1): InventarioLinea[] {
  const limpio = codigo.trim();
  if (!limpio) return lineas;
  const i = lineas.findIndex((l) => l.barcode === limpio);
  if (i < 0) return [{ barcode: limpio, cantidad }, ...lineas];
  const copia = [...lineas];
  copia[i] = { ...copia[i], cantidad: copia[i].cantidad + cantidad };
  return copia;
}

export function cambiarCantidad(lineas: InventarioLinea[], codigo: string, cantidad: number): InventarioLinea[] {
  if (cantidad <= 0) return lineas.filter((l) => l.barcode !== codigo);
  return lineas.map((l) => (l.barcode === codigo ? { ...l, cantidad } : l));
}

export function eliminarLinea(lineas: InventarioLinea[], codigo: string): InventarioLinea[] {
  return lineas.filter((l) => l.barcode !== codigo);
}

export function totalUnidades(lineas: InventarioLinea[]): number {
  return lineas.reduce((acc, l) => acc + l.cantidad, 0);
}

/** El endpoint no acepta espacios en el motivo, así que se limpian al vuelo. */
export function limpiarMotivo(valor: string): string {
  return valor.replace(/\s+/g, '');
}
