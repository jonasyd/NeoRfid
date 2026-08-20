export interface AuthSession {
  accessToken: string;
  brandPrefix: string;
  expiresAt: number;
  username: string;
  depositos: Deposito[];
  depositoSeleccionado?: Deposito;
}

export interface AuthResponseBody {
  message: string;
}

export interface Deposito {
  nombre: string;
  uuid: string;
  Sucursal?: string;
  /** Código del depósito, que es lo que espera el endpoint de ajustes (depositoCode). */
  Codigo?: string;
}

export interface DepositosResponse {
  deposites: Deposito[];
}

export interface SearchResult {
  model: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface StockRow {
  sku: string;
  skuDescription?: string;
  skucolor: string;
  skusize: string;
  colordesc?: string;
  sizedesc?: string;
  modelrfid: string;
  modelcolrfid: string;
  modelsizfid: string;
  stock: number;
  stockInTransit?: number;
  precio?: string;
  Oferta?: string;
  image?: string;
  modelphoto?: string;
}

export interface StockResponse {
  rows: StockRow[];
  modelphoto?: string;
}


/* ------------------------------ Inventarios ------------------------------ */

/** Cómo se cargan los ítems. Cada modo va a un endpoint distinto. */
export type InventarioModo = 'barcode' | 'rfid';

/** T = producto terminado, I = insumo, S = semi elaborado. */
export type TipoItem = 'T' | 'I' | 'S';

/** F = físico, T = tránsito. */
export type TipoMovimiento = 'F' | 'T';

/** S = ajusta por diferencia, N = no ajusta. */
export type AjustaPorDiferencia = 'S' | 'N';

export interface InventarioCabecera {
  /** <entero autoincremental>-<yyyyMMddHHmmss>, por ejemplo 285-20260623083004. */
  idAjuste: string;
  tipoItem: TipoItem;
  tipoMovimiento: TipoMovimiento;
  /** Fecha y hora en formato "YYYY-MM-DD HH:mm:ss". */
  fecha: string;
  depositoCode: string;
  motivoCode: string;
  /** Texto libre, hasta 150 caracteres. */
  nota: string;
  ajustaPorDiferencia: AjustaPorDiferencia;
}

export interface InventarioLinea {
  /** Código leído: el código de barras, o el EPC si el inventario es por RFID. */
  codigo: string;
  cantidad: number;
}

/**
 * Máscara de búsqueda de un inventario por RFID.
 *
 * Se arma con el brandPrefix de la sesión más el modelo, que es obligatorio, y opcionalmente el
 * color y el talle. Cuanto más se completa, más angosta es la búsqueda.
 */
export interface MascaraEpc {
  modelrfid: string;
  modelcolrfid?: string;
  modelsizfid?: string;
  /** Prefijo HEX ya armado, que es lo que se compara contra los EPC leídos. */
  prefijo: string;
}

/**
 * borrador  = se está confeccionando
 * pendiente = terminado, guardado para enviar más tarde
 * enviado   = el endpoint lo aceptó
 * error     = el envío falló y se puede reintentar
 */
export type InventarioEstado = 'borrador' | 'pendiente' | 'enviado' | 'error';

export interface Inventario {
  /** Igual al idAjuste; identifica el inventario en el almacenamiento local. */
  id: string;
  modo: InventarioModo;
  cabecera: InventarioCabecera;
  lineas: InventarioLinea[];
  estado: InventarioEstado;
  /** Sólo en los inventarios por RFID. */
  mascara?: MascaraEpc;
  creadoEn: number;
  actualizadoEn: number;
  ultimoError?: string;
}

/**
 * Cuerpo que espera el endpoint de ajustes de stock.
 *
 * El arreglo se llama `sku` en los dos modos; lo que cambia es la clave de cada elemento:
 * `barcode` cuando se cargó con el escáner y `epc` cuando se cargó por RFID.
 */
export type AjusteItem = { barcode: string; cantidad: string } | { epc: string; cantidad: string };

export interface AjustePayload {
  ajuste: InventarioCabecera & {
    sku: AjusteItem[];
  };
}
