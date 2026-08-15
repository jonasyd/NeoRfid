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
  skucolor: string;
  skusize: string;
  colordesc: string;
  sizedesc: string;
  modelrfid: string;
  modelcolrfid: string;
  modelsizfid: string;
  stock: number;
  image?: string;
}
