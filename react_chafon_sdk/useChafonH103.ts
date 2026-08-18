import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ChafonH103Service,
  BluetoothDeviceModel,
} from './ChafonH103Service';
import {
  TagInfo,
  TagOperation,
  KeyState,
  BarcodeData,
  BatteryData,
} from './ChafonH103Protocol';

export interface UseChafonH103Return {
  isConnected: boolean;
  isScanning: boolean;
  batteryLevel: number | null;
  scannedDevices: BluetoothDeviceModel[];
  tags: TagInfo[];
  singleTag: TagOperation | null;
  lastBarcode: BarcodeData | null;
  keyState: KeyState | null;
  readMode: 'rfid' | 'barcode';
  error: string | null;

  // Actions
  startScan: () => Promise<void>;
  stopScan: () => Promise<void>;
  connect: (deviceOrAddress: any) => Promise<boolean>;
  disconnect: () => Promise<void>;
  getBatteryLevel: () => Promise<void>;
  setReadMode: (mode: 'rfid' | 'barcode') => Promise<void>;
  startInventory: () => Promise<void>;
  stopInventory: () => Promise<void>;
  readSingleTag: (memoryBank?: number) => Promise<void>;
  startRadar: (epc: string) => Promise<void>;
  startRadarMasked: (
    maskStartAddress: number,
    maskLength: number,
    mask: string
  ) => Promise<void>;
  stopRadar: () => Promise<void>;
  startBarcodeScan: () => Promise<void>;
  stopBarcodeScan: () => Promise<void>;
  clearTags: () => void;
  clearBarcode: () => void;
}

export function useChafonH103(): UseChafonH103Return {
  const serviceRef = useRef<ChafonH103Service>(ChafonH103Service.getInstance());

  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [scannedDevices, setScannedDevices] = useState<BluetoothDeviceModel[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [singleTag, setSingleTag] = useState<TagOperation | null>(null);
  const [lastBarcode, setLastBarcode] = useState<BarcodeData | null>(null);
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  const [readMode, setReadModeState] = useState<'rfid' | 'barcode'>('rfid');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ChafonH103Service.initCallbacks({
      onDeviceFound: (device) => {
        setScannedDevices((prev) => {
          if (prev.some((d) => d.address === device.address)) return prev;
          return [...prev, device];
        });
      },
      onTagRead: (tag) => {
        setTags((prev) => {
          const index = prev.findIndex((t) => t.epc === tag.epc);
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = tag;
            return updated;
          }
          return [tag, ...prev];
        });
      },
      onTagReadSingle: (tag) => {
        setSingleTag(tag);
      },
      onRadarSignal: (signal) => {
        setTags((prev) => {
          const index = prev.findIndex((t) => t.epc === signal.epc);
          const updatedTag: TagInfo = {
            epc: signal.epc,
            rssi: signal.rssi,
            timestamp: signal.timestamp,
          };
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = updatedTag;
            return updated;
          }
          return [updatedTag, ...prev];
        });
      },
      onBarcodeRead: (barcode) => {
        setLastBarcode(barcode);
      },
      onKeyState: (state) => {
        setKeyState(state);
      },
      onBatteryLevel: (battery) => {
        setBatteryLevel(battery.level);
      },
      onReadError: (err) => {
        setError(err.error);
      },
      onScanError: (err) => {
        setError(err);
      },
      onDisconnected: () => {
        setIsConnected(false);
        setBatteryLevel(null);
      },
    });
  }, []);

  const startScan = useCallback(async () => {
    setError(null);
    setIsScanning(true);
    try {
      await serviceRef.current.startScan();
    } catch (e: any) {
      setError(e.message || 'Scan error');
    } finally {
      setIsScanning(false);
    }
  }, []);

  const stopScan = useCallback(async () => {
    await serviceRef.current.stopScan();
    setIsScanning(false);
  }, []);

  const connect = useCallback(async (deviceOrAddress: any): Promise<boolean> => {
    setError(null);
    const success = await serviceRef.current.connect(deviceOrAddress);
    setIsConnected(success);
    return success;
  }, []);

  const disconnect = useCallback(async () => {
    await serviceRef.current.disconnect();
    setIsConnected(false);
  }, []);

  const getBatteryLevel = useCallback(async () => {
    try {
      await serviceRef.current.getBatteryLevel();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const setReadMode = useCallback(async (mode: 'rfid' | 'barcode') => {
    try {
      await serviceRef.current.setReadMode(mode);
      setReadModeState(mode);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startInventory = useCallback(async () => {
    try {
      await serviceRef.current.startInventory();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const stopInventory = useCallback(async () => {
    try {
      await serviceRef.current.stopInventory();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const readSingleTag = useCallback(async (memoryBank: number = 0x01) => {
    try {
      await serviceRef.current.readSingleTag(memoryBank);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startRadar = useCallback(async (epc: string) => {
    try {
      await serviceRef.current.startRadar(epc);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startRadarMasked = useCallback(
    async (maskStartAddress: number, maskLength: number, mask: string) => {
      try {
        await serviceRef.current.startRadarMasked(maskStartAddress, maskLength, mask);
      } catch (e: any) {
        setError(e.message);
      }
    },
    []
  );

  const stopRadar = useCallback(async () => {
    try {
      await serviceRef.current.stopRadar();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startBarcodeScan = useCallback(async () => {
    try {
      await serviceRef.current.startBarcodeScan();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const stopBarcodeScan = useCallback(async () => {
    try {
      await serviceRef.current.stopBarcodeScan();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const clearTags = useCallback(() => {
    setTags([]);
    setSingleTag(null);
  }, []);

  const clearBarcode = useCallback(() => {
    setLastBarcode(null);
  }, []);

  return {
    isConnected,
    isScanning,
    batteryLevel,
    scannedDevices,
    tags,
    singleTag,
    lastBarcode,
    keyState,
    readMode,
    error,
    startScan,
    stopScan,
    connect,
    disconnect,
    getBatteryLevel,
    setReadMode,
    startInventory,
    stopInventory,
    readSingleTag,
    startRadar,
    startRadarMasked,
    stopRadar,
    startBarcodeScan,
    stopBarcodeScan,
    clearTags,
    clearBarcode,
  };
}
