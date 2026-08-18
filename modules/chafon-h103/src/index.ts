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
};

export type ChafonConnectionState = 'connected' | 'disconnected';

export interface ChafonH103NativeModule {
  isSupported(): boolean;
  isEnabled(): boolean;
  requestPermissions(): Promise<boolean>;
  initialize(): Promise<void>;
  configureCharacteristics(serviceUuid: string, notifyUuid: string, writeUuid: string): Promise<void>;
  scan(timeoutMs: number): Promise<void>;
  stopScan(): void;
  connect(address: string): Promise<boolean>;
  disconnect(): void;
  isConnected(): boolean;
  startInventory(mode: number, intervalMs: number): Promise<void>;
  stopInventory(): Promise<void>;
  setPower(powerDbm: number): Promise<void>;
  setSoundEnabled(enabled: boolean): Promise<void>;
  startDetection(epc: string, mode?: number, intervalMs?: number): Promise<void>;
  clearDetectionMask(): Promise<void>;
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
    requestPermissions: async () => false,
    initialize: async () => {},
    configureCharacteristics: async () => {},
    scan: async () => {},
    stopScan: () => {},
    connect: async () => false,
    disconnect: () => {},
    isConnected: () => false,
    startInventory: async () => {},
    stopInventory: async () => {},
    setPower: async () => {},
    setSoundEnabled: async () => {},
    startDetection: async () => {},
    clearDetectionMask: async () => {},
    getBattery: async () => 85,
    getDeviceInfo: async () => ({ model: "CHAFON H103 MOCK", firmware: "v1.0.0" }),
    addListener: () => {},
    removeListeners: () => {},
  };
}

const emitter = new EventEmitter(Native as any);

const ChafonH103 = {
  isSupported: () => {
    try {
      return Native.isSupported();
    } catch {
      return false;
    }
  },
  isEnabled: () => {
    try {
      return Native.isEnabled();
    } catch {
      return false;
    }
  },
  requestPermissions: () => {
    try {
      return Native.requestPermissions();
    } catch {
      return Promise.resolve(false);
    }
  },
  initialize: () => {
    try {
      return Native.initialize();
    } catch {
      return Promise.resolve();
    }
  },
  configureCharacteristics: (serviceUuid: string, notifyUuid: string, writeUuid: string) => {
    try {
      return Native.configureCharacteristics(serviceUuid, notifyUuid, writeUuid);
    } catch {
      return Promise.resolve();
    }
  },
  scan: (timeoutMs = 5000) => {
    try {
      return Native.scan(timeoutMs);
    } catch {
      return Promise.resolve();
    }
  },
  stopScan: () => {
    try {
      Native.stopScan();
    } catch {}
  },
  connect: (address: string) => {
    try {
      return Native.connect(address);
    } catch {
      return Promise.resolve(false);
    }
  },
  disconnect: () => {
    try {
      Native.disconnect();
    } catch {}
  },
  isConnected: () => {
    try {
      return Native.isConnected();
    } catch {
      return false;
    }
  },
  startInventory: (mode = 0, intervalMs = 100) => {
    try {
      return Native.startInventory(mode, intervalMs);
    } catch {
      return Promise.resolve();
    }
  },
  stopInventory: () => {
    try {
      return Native.stopInventory();
    } catch {
      return Promise.resolve();
    }
  },
  setPower: (powerDbm: number) => {
    try {
      return Native.setPower(powerDbm);
    } catch {
      return Promise.resolve();
    }
  },
  setSoundEnabled: (enabled: boolean) => {
    try {
      return Native.setSoundEnabled(enabled);
    } catch {
      return Promise.resolve();
    }
  },
  startDetection: (epc: string, mode = 0, intervalMs = 100) => {
    try {
      return Native.startDetection(epc, mode, intervalMs);
    } catch {
      return Promise.resolve();
    }
  },
  clearDetectionMask: () => {
    try {
      return Native.clearDetectionMask();
    } catch {
      return Promise.resolve();
    }
  },
  getBattery: () => {
    try {
      return Native.getBattery();
    } catch {
      return Promise.resolve(85);
    }
  },
  getDeviceInfo: () => {
    try {
      return Native.getDeviceInfo();
    } catch {
      return Promise.resolve({ model: "CHAFON H103 MOCK", firmware: "v1.0.0" });
    }
  },
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
};

export default ChafonH103;
