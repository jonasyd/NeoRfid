import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import type {
  AuthResponseBody,
  AuthSession,
  Deposito,
  DepositosResponse,
  SearchResponse,
  SearchResult,
  StockRow,
} from '@/types/api';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const AUTH_PATH = process.env.EXPO_PUBLIC_AUTH_PATH ?? '/v1/mobile/auth';
const DEPOSITS_PATH = process.env.EXPO_PUBLIC_DEPOSITS_PATH ?? '/v1/mobile/deposites';
const SEARCH_PATH = process.env.EXPO_PUBLIC_SEARCH_PATH ?? '/v1/mobile/search';
const STOCK_PATH = process.env.EXPO_PUBLIC_STOCK_PATH ?? '/v1/mobile/stock';
const TOKEN_REFRESH_SECONDS = Number(process.env.EXPO_PUBLIC_TOKEN_REFRESH_SECONDS ?? '900');
const REFRESH_SKEW_SECONDS = Number(process.env.EXPO_PUBLIC_TOKEN_REFRESH_SKEW_SECONDS ?? '30');

const SESSION_KEY = 'chafon.session.v2';
const CREDENTIALS_KEY = 'chafon.credentials.v1';

if (!API_BASE_URL) console.warn('EXPO_PUBLIC_API_BASE_URL no está configurado.');

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
});

let session: AuthSession | null = null;
let credentials: { username: string; password: string } | null = null;
let refreshPromise: Promise<string> | null = null;

function basicHeader(username: string, password: string): string {
  const value = `${username}:${password}`;
  const bytes = unescape(encodeURIComponent(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes.charCodeAt(i));
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : fallbackBase64(binary);
  return `Basic ${base64}`;
}

function fallbackBase64(input: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  let i = 0;
  while (i < input.length) {
    const a = input.charCodeAt(i++);
    const b = input.charCodeAt(i++);
    const c = input.charCodeAt(i++);
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += Number.isNaN(b) ? '=' : chars[(triplet >> 6) & 63];
    output += Number.isNaN(c) ? '=' : chars[triplet & 63];
  }
  return output;
}

async function persistSession() {
  if (!session) {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return;
  }
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

async function persistCredentials() {
  if (!credentials) {
    await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
    return;
  }
  // El backend no ofrece refresh_token: la renovación se realiza repitiendo Basic Auth.
  // SecureStore evita guardar la contraseña en AsyncStorage o en texto plano.
  await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
}

export async function restoreSession(): Promise<AuthSession | null> {
  const [rawSession, rawCredentials] = await Promise.all([
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
  ]);

  if (rawCredentials) {
    try {
      credentials = JSON.parse(rawCredentials) as { username: string; password: string };
    } catch {
      credentials = null;
    }
  }

  if (!rawSession) return null;
  try {
    session = JSON.parse(rawSession) as AuthSession;
    return session;
  } catch {
    session = null;
    return null;
  }
}

export function getSession(): AuthSession | null {
  return session;
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as Record<string, unknown>;
  const value = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof value === 'string' ? value : undefined;
}

async function authenticate(): Promise<string> {
  if (!credentials) throw new Error('No hay credenciales disponibles para renovar la sesión.');

  const response = await axios.post<AuthResponseBody>(
    `${API_BASE_URL}${AUTH_PATH}`,
    undefined,
    {
      headers: {
        Authorization: basicHeader(credentials.username, credentials.password),
      },
      timeout: 15000,
    },
  );

  const token = getHeaderValue(response.headers, 'token');
  const brandPrefix = getHeaderValue(response.headers, 'brandPrefix') ?? session?.brandPrefix ?? '';

  if (!token) throw new Error('El endpoint de autenticación no devolvió el header token.');

  const expiresAt = Date.now() + Math.max(60, TOKEN_REFRESH_SECONDS - REFRESH_SKEW_SECONDS) * 1000;
  session = {
    accessToken: token,
    brandPrefix,
    expiresAt,
    username: credentials.username,
    depositos: session?.depositos ?? [],
    depositoSeleccionado: session?.depositoSeleccionado,
  };
  await persistSession();
  return token;
}

export async function login(username: string, password: string): Promise<AuthSession> {
  credentials = { username: username.trim(), password };
  const token = await authenticate();
  await persistCredentials();

  if (!session) throw new Error('No se pudo crear la sesión.');
  session.accessToken = token;
  await persistSession();
  return session;
}

async function refreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = authenticate().finally(() => {
    refreshPromise = null;
  });
  const promise = refreshPromise;
  if (!promise) throw new Error('No se pudo iniciar la renovación del token.');
  return promise;
}

async function ensureValidToken(): Promise<string> {
  if (!session) throw new Error('Sesión no iniciada.');
  if (Date.now() >= session.expiresAt) return refreshToken();
  return session.accessToken;
}

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  if (config.url?.endsWith(AUTH_PATH)) return config;
  const token = await ensureValidToken();
  config.headers.token = token;
  return config;
});

let retrying401 = false;
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (error.response?.status === 401 && !retrying401 && !error.config?.url?.endsWith(AUTH_PATH)) {
      retrying401 = true;
      try {
        const token = await refreshToken();
        if (error.config) {
          error.config.headers.token = token;
          return api.request(error.config);
        }
      } finally {
        retrying401 = false;
      }
    }
    throw error;
  },
);

export async function loadDepositos(): Promise<Deposito[]> {
  const response = await api.get<DepositosResponse>(DEPOSITS_PATH);
  const data = Array.isArray(response.data?.deposites) ? response.data.deposites : [];
  if (session) {
    session.depositos = data;
    await persistSession();
  }
  return data;
}

export async function selectDeposito(deposito: Deposito): Promise<void> {
  if (!session) throw new Error('Sesión no iniciada.');
  session.depositoSeleccionado = deposito;
  await persistSession();
}

export async function searchModels(params: { sku?: string; query?: string }): Promise<SearchResult[]> {
  const sku = params.sku?.trim();
  const query = params.query?.trim();
  if (!!sku === !!query) {
    throw new Error('La búsqueda requiere exactamente uno de los campos: sku o query.');
  }
  const response = await api.post<SearchResponse>(SEARCH_PATH, sku ? { sku } : { query });
  return Array.isArray(response.data?.results) ? response.data.results : [];
}

export async function getStock(sku: string, constock = true): Promise<StockRow[]> {
  const depositUuid = session?.depositoSeleccionado?.uuid;
  if (!depositUuid) throw new Error('Seleccioná un depósito antes de consultar stock.');

  const response = await api.post<StockRow[]>(STOCK_PATH, {
    depositUuid,
    sku: sku.trim(),
    constock,
  });

  return Array.isArray(response.data) ? response.data : [];
}

export async function refreshAccessToken(): Promise<string> {
  return refreshToken();
}

export async function logout(): Promise<void> {
  credentials = null;
  session = null;
  refreshPromise = null;
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_KEY),
    SecureStore.deleteItemAsync(CREDENTIALS_KEY),
  ]);
}
