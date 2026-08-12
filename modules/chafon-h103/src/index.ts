import { EventEmitter, requireNativeModule } from 'expo-modules-core';

export type ChafonDevice = {
  id: string;
  name?: string;
  address: string;
  rssi: number;
  isCfDevice: boolean;
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
  startDetection(epc: string, mode?: number, intervalMs?: number): Promise<void>;
  clearDetectionMask(): Promise<void>;
  getBattery(): Promise<number>;
  getDeviceInfo(): Promise<Record<string, string>>;
}

const Native = requireNativeModule<ChafonH103NativeModule>('ChafonH103');
const emitter = new EventEmitter(Native);

const ChafonH103 = {
  isSupported: () => Native.isSupported(),
  isEnabled: () => Native.isEnabled(),
  requestPermissions: () => Native.requestPermissions(),
  initialize: () => Native.initialize(),
  configureCharacteristics: (serviceUuid: string, notifyUuid: string, writeUuid: string) => Native.configureCharacteristics(serviceUuid, notifyUuid, writeUuid),
  scan: (timeoutMs = 5000) => Native.scan(timeoutMs),
  stopScan: () => Native.stopScan(),
  connect: (address: string) => Native.connect(address),
  disconnect: () => Native.disconnect(),
  isConnected: () => Native.isConnected(),
  startInventory: (mode = 0, intervalMs = 100) => Native.startInventory(mode, intervalMs),
  stopInventory: () => Native.stopInventory(),
  startDetection: (epc: string, mode = 0, intervalMs = 100) => Native.startDetection(epc, mode, intervalMs),
  clearDetectionMask: () => Native.clearDetectionMask(),
  getBattery: () => Native.getBattery(),
  getDeviceInfo: () => Native.getDeviceInfo(),
  addDeviceListener(listener: (device: ChafonDevice) => void) {
    return emitter.addListener('onDeviceFound', listener);
  },
  addTagListener(listener: (tag: ChafonTag) => void) {
    return emitter.addListener('onTagRead', listener);
  },
  addConnectionListener(listener: (state: ChafonConnectionState) => void) {
    return emitter.addListener('onConnectionState', listener);
  },
};

export default ChafonH103;
