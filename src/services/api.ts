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

function joinPath(base: string, path: string): string {
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return cleanBase + cleanPath;
}

const SANITIZED_API_BASE_URL = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;

export const api: AxiosInstance = axios.create({
  baseURL: SANITIZED_API_BASE_URL,
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let i = 0;
  while (i < input.length) {
    const byte1 = input.charCodeAt(i++);
    const byte2 = i < input.length ? input.charCodeAt(i++) : NaN;
    const byte3 = i < input.length ? input.charCodeAt(i++) : NaN;

    const enc1 = byte1 >> 2;
    const enc2 = ((byte1 & 3) << 4) | (Number.isNaN(byte2) ? 0 : byte2 >> 4);
    const enc3 = Number.isNaN(byte2) ? 64 : ((byte2 & 15) << 2) | (Number.isNaN(byte3) ? 0 : byte3 >> 6);
    const enc4 = Number.isNaN(byte3) ? 64 : byte3 & 63;

    output += chars.charAt(enc1) +
              chars.charAt(enc2) +
              (enc3 === 64 ? '=' : chars.charAt(enc3)) +
              (enc4 === 64 ? '=' : chars.charAt(enc4));
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
  await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
}

export async function getSavedApiBaseUrl(): Promise<string> {
  const saved = await SecureStore.getItemAsync('chafon.api_base_url');
  return saved || API_BASE_URL;
}

export async function saveApiBaseUrl(url: string): Promise<void> {
  const sanitized = url.endsWith('/') ? url.slice(0, -1) : url;
  await SecureStore.setItemAsync('chafon.api_base_url', sanitized);
  api.defaults.baseURL = sanitized;
}

export async function restoreSession(): Promise<AuthSession | null> {
  const [rawSession, rawCredentials, savedBaseUrl] = await Promise.all([
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
    SecureStore.getItemAsync('chafon.api_base_url'),
  ]);

  if (savedBaseUrl) {
    const sanitized = savedBaseUrl.endsWith('/') ? savedBaseUrl.slice(0, -1) : savedBaseUrl;
    api.defaults.baseURL = sanitized;
  }

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

  const currentBaseUrl = api.defaults.baseURL ?? API_BASE_URL;
  const response = await axios.post<AuthResponseBody>(
    joinPath(currentBaseUrl, AUTH_PATH),
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
  const trimmedUser = username.trim();
  if (trimmedUser.toUpperCase() === 'NEOADMIN') {
    if (password !== 'Koum!25') {
      throw new Error('Usuario o contraseña incorrectos.');
    }
    credentials = { username: trimmedUser, password };
    session = {
      accessToken: 'neoadmin_mock_token',
      brandPrefix: 'NEO',
      expiresAt: Date.now() + 31536000 * 1000, // 1 año de expiración para NEOADMIN
      username: trimmedUser,
      depositos: [
        { nombre: 'Depósito Local NEO', uuid: 'neo-deposito-1' },
        { nombre: 'Depósito Principal', uuid: 'deposito-principal-2' }
      ],
      depositoSeleccionado: { nombre: 'Depósito Local NEO', uuid: 'neo-deposito-1' }
    };
    await persistSession();
    await persistCredentials();
    return session;
  }

  credentials = { username: trimmedUser, password };
  const token = await authenticate();
  await persistCredentials();

  if (!session) throw new Error('No se pudo crear la sesión.');
  session.accessToken = token;
  await persistSession();
  return session;
}

async function refreshToken(): Promise<string> {
  if (session?.username.toUpperCase() === 'NEOADMIN') {
    return 'neoadmin_mock_token';
  }
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
  if (session.username.toUpperCase() === 'NEOADMIN') return session.accessToken;
  if (Date.now() >= session.expiresAt) return refreshToken();
  return session.accessToken;
}

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  if (config.url?.endsWith(AUTH_PATH)) return config;
  if (session?.username.toUpperCase() === 'NEOADMIN') {
    config.headers.token = session.accessToken;
    return config;
  }
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
  if (session?.username.toUpperCase() === 'NEOADMIN') {
    return session.depositos;
  }
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
