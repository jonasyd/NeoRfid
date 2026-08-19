import { EventEmitter, requireNativeModule } from 'expo-modules-core';

export type ChafonDevice = {
  id: string;
  name?: string;
  address: string;
  rssi: number;
  isCfDevice: boolean;
  isBonded?: boolean;
};

export type ChafonTag = {
  epc: string;
  rssi: number;
  antenna: number;
  channel: number;
  isMatch?: boolean;
};

export type ChafonBatteryEvent = { level: number };

export type ChafonAllParamEvent = { power: number; buzzerEnabled: boolean };

/** mode 0 = HID (teclado Bluetooth), 1 = transparente (datos por BLE). */
export type ChafonOutputModeEvent = { mode: number; transparent: boolean };

export type ChafonConnectionState = 'connected' | 'disconnected';

/**
 * En modo transparente el H103 entrega el código de barras por el mismo canal que los EPC:
 * los bytes crudos llegan como hex. Esto los convierte al texto original.
 */
export function hexToAscii(hex: string): string {
  if (!hex || hex.length % 2 !== 0) return hex;
  try {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.substr(i, 2), 16);
      // Descartamos NUL y los caracteres de control que el lector agrega como terminadores.
      if (code === 0 || code === 2 || code === 3 || code === 13 || code === 10) continue;
      out += String.fromCharCode(code);
    }
    return out.trim() || hex;
  } catch {
    return hex;
  }
}

export interface ChafonH103NativeModule {
  isSupported(): boolean;
  isEnabled(): boolean;
  isLocationEnabled(): boolean;
  requestPermissions(): Promise<boolean>;
  initialize(): Promise<void>;
  configureCharacteristics(serviceUuid: string, notifyUuid: string, writeUuid: string): Promise<void>;
  scan(timeoutMs: number): Promise<void>;
  stopScan(): void;
  connect(address: string): Promise<boolean>;
  disconnect(): void;
  isConnected(): boolean;
  /** true cuando el pipeline GATT terminó (servicios + MTU + notify) y ya se puede escribir. */
  isReady(): boolean;
  startInventory(mode: number, intervalMs: number): Promise<void>;
  stopInventory(): Promise<void>;
  setReadMode(mode: 'rfid' | 'barcode'): Promise<void>;
  setPower(powerDbm: number): Promise<void>;
  setSoundEnabled(enabled: boolean): Promise<void>;
  startDetection(epc: string, mode?: number, intervalMs?: number): Promise<void>;
  clearDetectionMask(): Promise<void>;
  getAllParam(): Promise<void>;
  setTransparentMode(transparent: boolean): Promise<void>;
  /** RFM_REBOOT: restaura el equipo a valores de fábrica y lo reinicia. */
  factoryReset(): Promise<void>;
  getBattery(): Promise<number>;
  getDeviceInfo(): Promise<Record<string, string>>;
}

let Native: any = null;
try {
  Native = requireNativeModule<ChafonH103NativeModule>('ChafonH103');
} catch {
  // Graceful fallback for simulator / non-native environments / Expo Go
  Native = {
    isSupported: () => false,
    isEnabled: () => false,
    isLocationEnabled: () => true,
    requestPermissions: async () => false,
    initialize: async () => {},
    configureCharacteristics: async () => {},
    scan: async () => {},
    stopScan: () => {},
    connect: async () => false,
    disconnect: () => {},
    isConnected: () => false,
    isReady: () => false,
    startInventory: async () => {},
    stopInventory: async () => {},
    setReadMode: async () => {},
    setPower: async () => {},
    setSoundEnabled: async () => {},
    startDetection: async () => {},
    clearDetectionMask: async () => {},
    getAllParam: async () => {},
    setTransparentMode: async () => {},
    factoryReset: async () => {},
    getBattery: async () => 85,
    getDeviceInfo: async () => ({ model: "CHAFON H103 MOCK", firmware: "v1.0.0" }),
    addListener: () => {},
    removeListeners: () => {},
  };
}

/**
 * Duración de cada ventana de inventario, en segundos (ver startInventory). La UI la renueva
 * antes de que expire para que la búsqueda se sienta continua.
 */
export const INVENTORY_WINDOW_SECONDS = 100;

const emitter = new EventEmitter(Native as any);

/**
 * Estado compartido del lector, para que cualquier pantalla vea lo mismo sin duplicar lógica
 * ni depender de qué tab lo configuró. Se actualiza solo: desde los wrappers de setReadMode /
 * setPower y desde los eventos nativos (conexión, batería, parámetros del equipo).
 */
export type ChafonStatus = {
  connected: boolean;
  readMode: 'rfid' | 'barcode';
  power: number | null;
  battery: number | null;
  deviceName: string | null;
  /** null = desconocido. false = el equipo está en HID y tipea como teclado Bluetooth. */
  transparentMode: boolean | null;
};

let status: ChafonStatus = {
  connected: false,
  readMode: 'rfid',
  power: null,
  battery: null,
  deviceName: null,
  transparentMode: null,
};

const statusListeners = new Set<(s: ChafonStatus) => void>();

function setStatus(patch: Partial<ChafonStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l(status));
}

export function getChafonStatus(): ChafonStatus {
  return status;
}

/**
 * Sincroniza el estado con la verdad del módulo nativo. Hace falta porque una pantalla puede
 * montarse DESPUÉS de que ocurrió la conexión: en ese caso nunca vio el evento y se quedaría
 * mostrando "desconectada". Los getters nativos son síncronos y baratos.
 */
export function syncChafonStatusFromNative(): ChafonStatus {
  try {
    const connected = Native.isConnected() === true && Native.isReady() === true;
    if (connected !== status.connected) {
      setStatus(connected ? { connected: true } : { connected: false, battery: null });
    }
  } catch {
    // Sin módulo nativo: dejamos el estado como está.
  }
  return status;
}

export function subscribeChafonStatus(listener: (s: ChafonStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

// Suscripciones internas: mantienen el estado al día pase lo que pase en la UI.
try {
  (emitter as any).addListener('onConnectionState', (st: ChafonConnectionState) => {
    if (st === 'connected') {
      setStatus({ connected: true });
    } else {
      setStatus({ connected: false, battery: null, deviceName: null, transparentMode: null });
    }
  });
  (emitter as any).addListener('onBatteryLevel', (p: ChafonBatteryEvent) => {
    if (typeof p?.level === 'number' && p.level >= 0) setStatus({ battery: p.level });
  });
  (emitter as any).addListener('onAllParamLoaded', (p: ChafonAllParamEvent) => {
    if (typeof p?.power === 'number') setStatus({ power: p.power });
  });
  (emitter as any).addListener('onOutputMode', (p: ChafonOutputModeEvent) => {
    setStatus({ transparentMode: p?.transparent === true });
  });
} catch {
  // Entorno sin módulo nativo (Expo Go / simulador): el estado queda en sus valores por defecto.
}

const ChafonH103 = {
  isSupported: () => Native.isSupported(),
  isEnabled: () => Native.isEnabled(),
  isLocationEnabled: () => Native.isLocationEnabled(),
  requestPermissions: () => Native.requestPermissions(),
  initialize: () => Native.initialize(),
  configureCharacteristics: (serviceUuid: string, notifyUuid: string, writeUuid: string) =>
    Native.configureCharacteristics(serviceUuid, notifyUuid, writeUuid),
  scan: (timeoutMs = 5000) => Native.scan(timeoutMs),
  stopScan: () => Native.stopScan(),
  async connect(address: string) {
    const ok = await Native.connect(address);
    return ok;
  },
  disconnect: () => {
    Native.disconnect();
    setStatus({ connected: false, battery: null, deviceName: null });
  },
  isConnected: () => Native.isConnected(),
  isReady: () => Native.isReady(),
  /**
   * InvType 0 = inventario por tiempo; InvParam en SEGUNDOS.
   *
   * El manual dice que 0 significa "continuo hasta stopInventory", pero este firmware lo
   * RECHAZA: responde STATUS 0x02 ("command execution failed due to internal module error")
   * y no arranca. Con un valor positivo responde 0x12 (comando aceptado). Por eso usamos una
   * ventana larga y la UI la renueva mientras la búsqueda siga abierta.
   */
  startInventory: (invType = 0, seconds = INVENTORY_WINDOW_SECONDS) =>
    Native.startInventory(invType, seconds),
  stopInventory: () => Native.stopInventory(),
  async setReadMode(mode: 'rfid' | 'barcode') {
    await Native.setReadMode(mode);
    setStatus({ readMode: mode });
  },
  async setPower(powerDbm: number) {
    await Native.setPower(powerDbm);
    setStatus({ power: powerDbm });
  },
  setSoundEnabled: (enabled: boolean) => Native.setSoundEnabled(enabled),
  startDetection: (epc: string, invType = 0, seconds = INVENTORY_WINDOW_SECONDS) =>
    Native.startDetection(epc, invType, seconds),
  clearDetectionMask: () => Native.clearDetectionMask(),
  getAllParam: () => Native.getAllParam(),
  setTransparentMode: (transparent: boolean) => Native.setTransparentMode(transparent),
  factoryReset: () => Native.factoryReset(),
  // getBattery() dispara el comando y espera la respuesta async del H103 (evento
  // "onBatteryLevel"). El mock de simulador resuelve un valor fijo de inmediato, así que
  // esa rama también termina la promesa sin esperar el evento.
  getBattery(): Promise<number> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        sub.remove();
        resolve(value);
      };
      const sub = (emitter as any).addListener('onBatteryLevel', (payload: ChafonBatteryEvent) => finish(payload.level));
      const timeoutId = setTimeout(() => finish(-1), 5000);
      Native.getBattery()
        .then((value: unknown) => {
          if (typeof value === 'number' && value >= 0) finish(value);
        })
        .catch(() => finish(-1));
    });
  },
  getDeviceInfo: () => Native.getDeviceInfo(),
  addDeviceListener(listener: (device: ChafonDevice) => void) {
    try {
      return (emitter as any).addListener('onDeviceFound', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addScanErrorListener(listener: (error: { errorCode?: number; message: string }) => void) {
    try {
      return (emitter as any).addListener('onScanError', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addTagListener(listener: (tag: ChafonTag) => void) {
    try {
      return (emitter as any).addListener('onTagRead', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addConnectionListener(listener: (state: ChafonConnectionState) => void) {
    try {
      return (emitter as any).addListener('onConnectionState', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addAllParamListener(listener: (payload: ChafonAllParamEvent) => void) {
    try {
      return (emitter as any).addListener('onAllParamLoaded', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addBatteryListener(listener: (payload: ChafonBatteryEvent) => void) {
    try {
      return (emitter as any).addListener('onBatteryLevel', listener);
    } catch {
      return { remove: () => {} };
    }
  },
};

export default ChafonH103;
