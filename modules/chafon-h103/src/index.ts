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

/** workMode: 0 = respuesta (el gatillo no reporta por BLE), 1 = activo, 2 = gatillo. */
export type ChafonAllParamEvent = { power: number; buzzerEnabled: boolean; workMode?: number };

/** mode 0 = HID (teclado Bluetooth), 1 = transparente (datos por BLE). */
export type ChafonOutputModeEvent = { mode: number; transparent: boolean };

/**
 * El equipo respondió un comando con error. `0x02` es el importante: el módulo RFID del lector
 * quedó trabado. El Bluetooth sigue contestando, pero la radio no lee ningún tag y el equipo
 * deja de devolver sus parámetros; sin este aviso la app se ve "conectada y buscando" con cero
 * lecturas indefinidamente, y el problema parece de la app cuando en realidad es del equipo.
 */
export type ChafonModuleFaultEvent = { command: string; status: number; message: string };

/**
 * Fin de un barrido de inventario que no trajo tags. Permite distinguir "el lector no está
 * buscando" de "el lector barrió y no había nada", que en pantalla se veían igual: Lecturas 0.
 */
export type ChafonInventoryOutcomeEvent = { status: number; completed: boolean; noTags: boolean };

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
  /** Dispara una lectura de código de barras (el equipo no escanea solo por cambiar de modo). */
  triggerBarcodeScan(): Promise<void>;
  setPower(powerDbm: number): Promise<void>;
  /** 0 = respuesta, 1 = activo, 2 = gatillo. */
  setWorkMode(mode: number): Promise<void>;
  setSoundEnabled(enabled: boolean): Promise<void>;
  startDetection(epc: string, mode?: number, intervalMs?: number): Promise<void>;
  clearDetectionMask(): Promise<void>;
  getAllParam(): Promise<void>;
  setTransparentMode(transparent: boolean): Promise<void>;
  /** RFM_MODULE_INT: reinicializa el módulo RFID con los parámetros guardados. */
  moduleInit(): Promise<void>;
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
    triggerBarcodeScan: async () => {},
    setPower: async () => {},
    setWorkMode: async () => {},
    setSoundEnabled: async () => {},
    startDetection: async () => {},
    clearDetectionMask: async () => {},
    getAllParam: async () => {},
    setTransparentMode: async () => {},
    moduleInit: async () => {},
    factoryReset: async () => {},
    getBattery: async () => 85,
    getDeviceInfo: async () => ({ model: "CHAFON H103 MOCK", firmware: "v1.0.0" }),
    addListener: () => {},
    removeListeners: () => {},
  };
}

/**
 * InvParam del inventory. 0 = continuo hasta stopInventory.
 *
 * Es el valor que usa la app demo del fabricante y con el que el equipo lee sin problemas
 * (comando verificado en su tráfico: CF FF 00 01 05 00 00 00 00 00). Se había cambiado a 100
 * porque el equipo respondió una vez STATUS 0x02, pero ese error venía del módulo RFID trabado,
 * no del parámetro: con InvParam=100 el equipo acepta el comando y contesta "0 tags" al instante.
 */
export const INVENTORY_WINDOW_SECONDS = 0;

const emitter = new EventEmitter(Native as any);

/**
 * Estado compartido del lector, para que cualquier pantalla vea lo mismo sin duplicar lógica
 * ni depender de qué tab lo configuró. Se actualiza solo: desde los wrappers de setReadMode /
 * setPower y desde los eventos nativos (conexión, batería, parámetros del equipo).
 */
export type ChafonStatus = {
  connected: boolean;
  readMode: 'rfid' | 'barcode';
  /** Potencia CONFIRMADA por el equipo (releída de sus parámetros). Fuente de verdad. */
  power: number | null;
  /** Última potencia que le pedimos. Si no coincide con `power`, el equipo no la aplicó. */
  powerRequested: number | null;
  battery: number | null;
  deviceName: string | null;
  /** null = desconocido. false = el equipo está en HID y tipea como teclado Bluetooth. */
  transparentMode: boolean | null;
  /** Falla informada por el equipo, o null si está sano. Se limpia al reconectar. */
  moduleFault: string | null;
  /** Cuántos barridos terminó el lector sin encontrar tags desde la última lectura buena. */
  emptySweeps: number;
  /** Modo de trabajo del equipo: 0 respuesta, 1 activo, 2 gatillo. null = desconocido. */
  workMode: number | null;
};

let status: ChafonStatus = {
  connected: false,
  readMode: 'rfid',
  power: null,
  powerRequested: null,
  battery: null,
  deviceName: null,
  transparentMode: null,
  moduleFault: null,
  emptySweeps: 0,
  workMode: null,
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
      // El nativo fuerza modo RFID al conectar, así que el estado compartido arranca acorde.
      setStatus({ connected: true, readMode: 'rfid' });
    } else {
      setStatus({
        connected: false,
        battery: null,
        deviceName: null,
        transparentMode: null,
        moduleFault: null,
        emptySweeps: 0,
      });
    }
  });
  (emitter as any).addListener('onBatteryLevel', (p: ChafonBatteryEvent) => {
    if (typeof p?.level === 'number' && p.level >= 0) setStatus({ battery: p.level });
  });
  (emitter as any).addListener('onAllParamLoaded', (p: ChafonAllParamEvent) => {
    if (typeof p?.power === 'number') setStatus({ power: p.power });
    if (typeof p?.workMode === 'number') setStatus({ workMode: p.workMode });
  });
  (emitter as any).addListener('onOutputMode', (p: ChafonOutputModeEvent) => {
    setStatus({ transparentMode: p?.transparent === true });
  });
  (emitter as any).addListener('onModuleFault', (p: ChafonModuleFaultEvent) => {
    if (p?.message) setStatus({ moduleFault: p.message });
  });
  (emitter as any).addListener('onInventoryOutcome', (p: ChafonInventoryOutcomeEvent) => {
    // Barrido terminado sin tags. Los contamos para poder decirle a la persona que el lector
    // sí está buscando y no encuentra nada, en vez de dejar un "Lecturas 0" mudo.
    if (p?.completed || p?.noTags) setStatus({ emptySweeps: status.emptySweeps + 1 });
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
  /** InvType 0 = por tiempo; InvParam en segundos (0 = continuo hasta stopInventory). */
  startInventory: (invType = 0, seconds = INVENTORY_WINDOW_SECONDS) =>
    Native.startInventory(invType, seconds),
  stopInventory: () => Native.stopInventory(),
  async setReadMode(mode: 'rfid' | 'barcode') {
    await Native.setReadMode(mode);
    setStatus({ readMode: mode });
  },
  triggerBarcodeScan: () => Native.triggerBarcodeScan(),
  /**
   * Pide una potencia y espera la confirmación del equipo.
   *
   * Antes se actualizaba el estado de forma optimista con el valor pedido, así que la UI
   * mostraba lo solicitado aunque el equipo hubiera aplicado otra cosa (se vio pedir 28 dBm
   * y que el equipo reportara 23). Ahora `power` sale únicamente de la relectura real de los
   * parámetros; lo pedido queda aparte en `powerRequested` para poder comparar.
   */
  setWorkMode: (mode: number) => Native.setWorkMode(mode),
  async setPower(powerDbm: number) {
    if (status.powerRequested === powerDbm) return;
    setStatus({ powerRequested: powerDbm });
    await Native.setPower(powerDbm);
  },
  setSoundEnabled: (enabled: boolean) => Native.setSoundEnabled(enabled),
  startDetection: (epc: string, invType = 0, seconds = INVENTORY_WINDOW_SECONDS) =>
    Native.startDetection(epc, invType, seconds),
  clearDetectionMask: () => Native.clearDetectionMask(),
  getAllParam: () => Native.getAllParam(),
  setTransparentMode: (transparent: boolean) => Native.setTransparentMode(transparent),
  moduleInit: () => Native.moduleInit(),
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
  addOutputModeListener(listener: (payload: ChafonOutputModeEvent) => void) {
    try {
      return (emitter as any).addListener('onOutputMode', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  addModuleFaultListener(listener: (payload: ChafonModuleFaultEvent) => void) {
    try {
      return (emitter as any).addListener('onModuleFault', listener);
    } catch {
      return { remove: () => {} };
    }
  },
  /** Limpia el diagnóstico acumulado al arrancar una búsqueda nueva. */
  resetDiagnostics() {
    setStatus({ moduleFault: null, emptySweeps: 0 });
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
