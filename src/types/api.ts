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
  /** Código leído. En modo RFID acá va el EPC. */
  barcode: string;
  cantidad: number;
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
  creadoEn: number;
  actualizadoEn: number;
  ultimoError?: string;
}

/** Cuerpo que espera el endpoint de ajustes de stock. */
export interface AjustePayload {
  ajuste: InventarioCabecera & {
    sku: { barcode: string; cantidad: string }[];
  };
}
