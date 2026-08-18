import ChafonH103 from '@modules/chafon-h103';
import {
  ChafonH103Protocol,
  TagInfo,
  TagOperation,
  KeyState,
  BarcodeData,
  BatteryData,
} from './ChafonH103Protocol';

export interface BluetoothDeviceModel {
  name: string;
  address: string;
  rssi?: number;
  rawDevice?: any;
}

export interface ChafonCallbacks {
  onTagRead?: (tag: TagInfo) => void;
  onTagReadSingle?: (tag: TagOperation) => void;
  onRadarSignal?: (signal: {
    epc: string;
    rssi: number;
    timestamp: number;
    targetEpc?: string;
    mask?: string;
    maskStartAddress?: number;
    maskLength?: number;
  }) => void;
  onBatteryLevel?: (battery: BatteryData) => void;
  onBatteryTimeout?: () => void;
  onReadError?: (error: { error: string }) => void;
  onDisconnected?: () => void;
  onDeviceFound?: (device: BluetoothDeviceModel) => void;
  onBarcodeRead?: (barcode: BarcodeData) => void;
  onKeyState?: (state: KeyState) => void;
  onScanError?: (error: string) => void;
}

export class ChafonH103Service {
  static readonly SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
  static readonly WRITE_UUID = '0000ffe3-0000-1000-8000-00805f9b34fb';
  static readonly NOTIFY_UUID = '0000ffe4-0000-1000-8000-00805f9b34fb';

  private static instance: ChafonH103Service;
  private callbacks: ChafonCallbacks = {};

  private currentDevice: any = null;
  private gattServer: any = null;
  private writeCharacteristic: any = null;
  private notifyCharacteristic: any = null;

  private isConnectedState: boolean = false;
  private currentReadMode: number = ChafonH103Protocol.READ_MODE_RFID;
  private inventoryRunning: boolean = false;

  // Radar state
  private radarActive: boolean = false;
  private radarEpc: string | null = null;
  private radarUseMask: boolean = false;
  private radarMaskStartAddress: number = 0;
  private radarMaskLengthBytes: number = 0;
  private radarMaskHex: string | null = null;

  // Timeout handlers
  private batteryTimeoutTimer: any = null;

  private constructor() {
    this.setupNativeListeners();
  }

  private setupNativeListeners(): void {
    try {
      ChafonH103.addDeviceListener((dev) => {
        if (dev && this.callbacks.onDeviceFound) {
          this.callbacks.onDeviceFound({
            name: dev.name || 'Chafon CF-H103',
            address: dev.address,
            rssi: dev.rssi,
            rawDevice: dev,
          });
        }
      });

      ChafonH103.addTagListener((tag) => {
        if (tag && this.callbacks.onTagRead) {
          this.callbacks.onTagRead({
            epc: tag.epc,
            rssi: tag.rssi,
            timestamp: Date.now(),
          });
        }
      });

      ChafonH103.addConnectionListener((state) => {
        if (state === 'connected') {
          this.isConnectedState = true;
        } else {
          this.handleDisconnected();
        }
      });
    } catch {}
  }

  static getInstance(): ChafonH103Service {
    if (!ChafonH103Service.instance) {
      ChafonH103Service.instance = new ChafonH103Service();
    }
    return ChafonH103Service.instance;
  }

  /**
   * Initialize or update callback listeners
   */
  static initCallbacks(callbacks: ChafonCallbacks): void {
    const service = ChafonH103Service.getInstance();
    service.callbacks = { ...service.callbacks, ...callbacks };
  }

  // ========== Connection & Scanning ==========

  /**
   * Starts BLE scan using Web Bluetooth API or custom BLE provider
   */
  async startScan(): Promise<string> {
    if (typeof navigator !== 'undefined' && (navigator as any).bluetooth) {
      try {
        const device = await (navigator as any).bluetooth.requestDevice({
          filters: [
            { services: [ChafonH103Service.SERVICE_UUID] },
            { namePrefix: 'CF' },
            { namePrefix: 'Chafon' },
            { namePrefix: 'RFID' },
          ],
          optionalServices: [ChafonH103Service.SERVICE_UUID],
        });

        if (device && this.callbacks.onDeviceFound) {
          this.callbacks.onDeviceFound({
            name: device.name || 'Chafon CF-H103',
            address: device.id,
            rssi: 0,
            rawDevice: device,
          });
        }
        return 'scan_started';
      } catch (err: any) {
        if (this.callbacks.onScanError) {
          this.callbacks.onScanError(err.message || 'Bluetooth scan cancelled or failed');
        }
        throw err;
      }
    }

    try {
      await ChafonH103.initialize();
      await ChafonH103.scan(7000);
      return 'scan_started_native';
    } catch (e: any) {
      if (this.callbacks.onScanError) {
        this.callbacks.onScanError(e.message || 'Scan error');
      }
      throw e;
    }
  }

  async stopScan(): Promise<string> {
    try {
      ChafonH103.stopScan();
    } catch {}
    return 'scan_stopped';
  }

  /**
   * Connect to Chafon device via Web Bluetooth GATT or supplied raw device
   */
  async connect(deviceOrAddress: any): Promise<boolean> {
    try {
      let address = typeof deviceOrAddress === 'string' ? deviceOrAddress : deviceOrAddress?.address;

      if (typeof navigator !== 'undefined' && (navigator as any).bluetooth) {
        let device = deviceOrAddress;
        if (typeof deviceOrAddress === 'string') {
          device = await (navigator as any).bluetooth.requestDevice({
            filters: [{ services: [ChafonH103Service.SERVICE_UUID] }],
          });
        }
        if (device && device.gatt) {
          this.currentDevice = device;
          if (device.addEventListener) {
            device.addEventListener('gattserverdisconnected', () => {
              this.handleDisconnected();
            });
          }
          this.gattServer = await device.gatt.connect();
          const service = await this.gattServer.getPrimaryService(ChafonH103Service.SERVICE_UUID);
          this.writeCharacteristic = await service.getCharacteristic(ChafonH103Service.WRITE_UUID);
          this.notifyCharacteristic = await service.getCharacteristic(ChafonH103Service.NOTIFY_UUID);
          await this.notifyCharacteristic.startNotifications();
          this.notifyCharacteristic.addEventListener(
            'characteristicvaluechanged',
            (event: any) => this.handleNotifyValue(event.target.value)
          );
          this.isConnectedState = true;
          await this.setRfidMode();
          return true;
        }
      }

      // Fallback for Native Expo environment
      if (!address && deviceOrAddress?.rawDevice?.address) {
        address = deviceOrAddress.rawDevice.address;
      }
      if (!address) throw new Error('No MAC/Address specified');

      await ChafonH103.initialize();
      await ChafonH103.configureCharacteristics(
        ChafonH103Service.SERVICE_UUID,
        ChafonH103Service.NOTIFY_UUID,
        ChafonH103Service.WRITE_UUID
      );
      const connected = await ChafonH103.connect(address);
      this.isConnectedState = connected;
      return connected;
    } catch (err: any) {
      this.isConnectedState = false;
      if (this.callbacks.onReadError) {
        this.callbacks.onReadError({ error: err.message || 'Connection failed' });
      }
      return false;
    }
  }

  async isConnected(): Promise<boolean> {
    if (this.currentDevice && this.currentDevice.gatt) {
      return this.currentDevice.gatt.connected;
    }
    return this.isConnectedState;
  }

  async disconnect(): Promise<boolean> {
    try {
      if (this.gattServer && this.gattServer.connected) {
        this.gattServer.disconnect();
      }
      ChafonH103.disconnect();
      this.handleDisconnected();
      return true;
    } catch (e) {
      return false;
    }
  }

  private handleDisconnected(): void {
    this.isConnectedState = false;
    this.inventoryRunning = false;
    this.clearRadarState();
    this.currentReadMode = ChafonH103Protocol.READ_MODE_RFID;

    if (this.callbacks.onDisconnected) {
      this.callbacks.onDisconnected();
    }
  }

  // ========== Write Data with Retry ==========

  private async writeData(data: Uint8Array): Promise<boolean> {
    if (!this.writeCharacteristic) return false;

    for (let i = 0; i < 3; i++) {
      try {
        if (this.writeCharacteristic.writeValueWithoutResponse) {
          await this.writeCharacteristic.writeValueWithoutResponse(data);
        } else {
          await this.writeCharacteristic.writeValue(data);
        }
        return true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 120 * (i + 1)));
      }
    }
    return false;
  }

  // ========== Notification Handling ==========

  private handleNotifyValue(dataView: DataView): void {
    const bytes = new Uint8Array(dataView.buffer);
    if (bytes.length === 0) return;

    // Check if it's a valid Chafon frame header [0xCF, 0xFF]
    if (bytes.length >= 5 && bytes[0] === 0xcf && bytes[1] === 0xff) {
      const cmd = bytes[3];
      const len = bytes[4];

      // Handle Key State (0x7A)
      if (cmd === ChafonH103Protocol.TYPE_KEY_STATE && bytes.length >= 6) {
        const keyStateVal = bytes[5] === 0x01 ? 'start' : 'finish';
        if (this.callbacks.onKeyState) {
          this.callbacks.onKeyState({
            state: keyStateVal,
            timestamp: Date.now(),
          });
        }
        return;
      }

      // Handle Battery Capacity
      if (cmd === ChafonH103Protocol.TYPE_GET_BATTERY_CAPACITY && bytes.length >= 6) {
        if (this.batteryTimeoutTimer) {
          clearTimeout(this.batteryTimeoutTimer);
          this.batteryTimeoutTimer = null;
        }
        const level = bytes[5];
        if (this.callbacks.onBatteryLevel) {
          this.callbacks.onBatteryLevel({ level });
        }
        return;
      }

      // Handle Inventory Tag / Barcode in Inventory Frame
      if (cmd === ChafonH103Protocol.TYPE_INVENTORY) {
        if (this.currentReadMode === ChafonH103Protocol.READ_MODE_BARCODE) {
          const barcodeStr = new TextDecoder()
            .decode(bytes.slice(5, 5 + len))
            .replace(/\u0000/g, '')
            .trim();

          if (barcodeStr && this.callbacks.onBarcodeRead) {
            this.callbacks.onBarcodeRead({
              value: barcodeStr,
              timestamp: Date.now(),
            });
          }
        } else {
          this.handleInventoryTagFrame(bytes);
        }
        return;
      }

      // Handle Read Single Tag (0x03)
      if (cmd === ChafonH103Protocol.TYPE_READ_TAG) {
        const epcHex = ChafonH103Protocol.bytesToHex(bytes.slice(5, 17));
        const dataHex = ChafonH103Protocol.bytesToHex(bytes.slice(17, bytes.length - 2));

        if (this.callbacks.onTagReadSingle) {
          this.callbacks.onTagReadSingle({
            epc: epcHex || '<empty>',
            data: dataHex,
            status: bytes[5],
            timestamp: Date.now(),
          });
        }
        return;
      }
    } else if (this.currentReadMode === ChafonH103Protocol.READ_MODE_BARCODE) {
      // Fallback barcode decoding from raw string
      const barcodeStr = new TextDecoder()
        .decode(bytes)
        .replace(/\u0000/g, '')
        .trim();

      if (barcodeStr && this.callbacks.onBarcodeRead) {
        this.callbacks.onBarcodeRead({
          value: barcodeStr,
          timestamp: Date.now(),
        });
      }
    }
  }

  private handleInventoryTagFrame(bytes: Uint8Array): void {
    if (bytes.length < 15) return;

    // EPC extraction (typically bytes[6..18] or length indicated)
    const epcBytes = bytes.slice(6, bytes.length - 3);
    const epc = ChafonH103Protocol.bytesToHex(epcBytes);
    const rssi = -(256 - bytes[bytes.length - 3]); // convert to dBm signed

    if (this.radarActive) {
      if (this.matchesRadarFilter(epc)) {
        if (this.callbacks.onRadarSignal) {
          this.callbacks.onRadarSignal({
            epc,
            rssi,
            timestamp: Date.now(),
            ...(this.radarUseMask
              ? {
                  mask: this.radarMaskHex!,
                  maskStartAddress: this.radarMaskStartAddress,
                  maskLength: this.radarMaskLengthBytes,
                }
              : { targetEpc: this.radarEpc! }),
          });
        }
      }
      return;
    }

    if (this.callbacks.onTagRead) {
      this.callbacks.onTagRead({
        epc,
        rssi,
        timestamp: Date.now(),
      });
    }
  }

  // ========== Radar Matching Helpers ==========

  private matchesRadarFilter(epcHex: string): boolean {
    if (!this.radarActive || !epcHex) return false;

    if (this.radarUseMask) {
      return ChafonH103Protocol.matchesEpcMask(
        epcHex,
        this.radarMaskStartAddress,
        this.radarMaskLengthBytes,
        this.radarMaskHex!
      );
    }

    return this.radarEpc !== null && epcHex.toUpperCase() === this.radarEpc.toUpperCase();
  }

  private clearRadarState(): void {
    this.radarActive = false;
    this.radarEpc = null;
    this.radarUseMask = false;
    this.radarMaskStartAddress = 0;
    this.radarMaskLengthBytes = 0;
    this.radarMaskHex = null;
  }

  // ========== Public Operations ==========

  async getBatteryLevel(): Promise<string> {
    if (typeof navigator === 'undefined' || !(navigator as any).bluetooth) {
      try {
        const level = await ChafonH103.getBattery();
        if (this.callbacks.onBatteryLevel) {
          this.callbacks.onBatteryLevel({ level });
        }
        return 'battery_level_received';
      } catch {}
    }

    const cmd = ChafonH103Protocol.buildGetBatteryCapacityCmd();
    const ok = await this.writeData(cmd);

    if (ok) {
      if (this.batteryTimeoutTimer) clearTimeout(this.batteryTimeoutTimer);
      this.batteryTimeoutTimer = setTimeout(() => {
        if (this.callbacks.onBatteryTimeout) {
          this.callbacks.onBatteryTimeout();
        }
      }, 5000);
      return 'battery_request_sent';
    }
    throw new Error('Failed to send battery request');
  }

  async setReadMode(mode: 'rfid' | 'barcode'): Promise<string> {
    const modeByte =
      mode === 'barcode'
        ? ChafonH103Protocol.READ_MODE_BARCODE
        : ChafonH103Protocol.READ_MODE_RFID;

    const cmd = ChafonH103Protocol.buildSetReadModeCmd(modeByte);
    const ok = await this.writeData(cmd);

    if (ok) {
      this.currentReadMode = modeByte;
      if (modeByte === ChafonH103Protocol.READ_MODE_BARCODE) {
        this.inventoryRunning = false;
        this.clearRadarState();
      }
      return `${mode}_mode_enabled`;
    }
    throw new Error(`Failed to set mode ${mode}`);
  }

  async setBarcodeMode(): Promise<string> {
    return this.setReadMode('barcode');
  }

  async setRfidMode(): Promise<string> {
    return this.setReadMode('rfid');
  }

  async startInventory(): Promise<string> {
    if (this.currentReadMode !== ChafonH103Protocol.READ_MODE_RFID) {
      await this.setRfidMode();
    }

    await this.stopInventory();
    await new Promise((r) => setTimeout(r, 120));

    const cmd = ChafonH103Protocol.buildStartInventoryCmd();
    const ok = await this.writeData(cmd);

    if (ok) {
      this.inventoryRunning = true;
      return 'inventory_started';
    }
    throw new Error('Failed to start inventory');
  }

  async stopInventory(): Promise<string> {
    const cmd = ChafonH103Protocol.buildStopInventoryCmd();
    await this.writeData(cmd);
    this.inventoryRunning = false;
    return 'inventory_stopped';
  }

  async readSingleTag(memoryBank: number = 0x01): Promise<string> {
    if (this.currentReadMode !== ChafonH103Protocol.READ_MODE_RFID) {
      await this.setRfidMode();
    }

    const cmd = ChafonH103Protocol.buildReadSingleTagCmd(memoryBank);
    const ok = await this.writeData(cmd);

    if (ok) return 'read_tag_command_sent';
    throw new Error('Failed to send readSingleTag command');
  }

  async startRadar(epc: string): Promise<void> {
    const norm = ChafonH103Protocol.normalizeHex(epc);
    if (!norm) throw new Error('Target EPC must be valid HEX');

    this.radarEpc = norm;
    this.radarUseMask = false;
    this.radarActive = true;

    await this.startInventory();
  }

  async startRadarMasked(
    maskStartAddress: number,
    maskLength: number,
    mask: string
  ): Promise<void> {
    const normMask = ChafonH103Protocol.normalizeHex(mask);
    if (!normMask) throw new Error('Mask must be valid HEX with even length');
    if (normMask.length !== maskLength * 2) {
      throw new Error('maskLength is in BYTES, so mask HEX length must equal maskLength * 2');
    }

    this.radarEpc = null;
    this.radarUseMask = true;
    this.radarMaskStartAddress = maskStartAddress;
    this.radarMaskLengthBytes = maskLength;
    this.radarMaskHex = normMask;
    this.radarActive = true;

    await this.startInventory();
  }

  async stopRadar(): Promise<void> {
    this.clearRadarState();
    await this.stopInventory();
  }

  async startBarcodeScan(): Promise<string> {
    if (this.inventoryRunning) {
      await this.stopInventory();
      await new Promise((r) => setTimeout(r, 120));
    }

    if (this.currentReadMode !== ChafonH103Protocol.READ_MODE_BARCODE) {
      await this.setBarcodeMode();
    }

    const cmd = ChafonH103Protocol.buildStartBarcodeScanCmd();
    const ok = await this.writeData(cmd);

    if (ok) return 'barcode_scan_triggered';
    throw new Error('Failed to trigger barcode scan');
  }

  async stopBarcodeScan(): Promise<string> {
    const cmd = ChafonH103Protocol.buildStopBarcodeScanCmd();
    await this.writeData(cmd);
    return 'barcode_scan_stopped';
  }
}
