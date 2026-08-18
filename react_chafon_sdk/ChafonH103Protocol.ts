/**
 * Chafon CF-H103 Protocol Implementation in TypeScript
 * Handles binary command generation, CRC16 calculation, and notification response parsing.
 */

export interface DeviceConfig {
  power: number;
  region: number;
  qValue: number;
  session: number;
}

export interface TagInfo {
  epc: string;
  rssi: number;
  antenna?: number;
  timestamp: number;
}

export interface TagOperation {
  epc: string;
  data: string;
  status: number;
  timestamp: number;
}

export interface KeyState {
  state: 'start' | 'finish';
  timestamp: number;
}

export interface BarcodeData {
  value: string;
  timestamp: number;
}

export interface BatteryData {
  level: number;
}

export class ChafonH103Protocol {
  // Constants for Read Mode
  static readonly READ_MODE_RFID = 0x00;
  static readonly READ_MODE_BARCODE = 0x01;

  // Constants for Command Types (CmdType)
  static readonly TYPE_INVENTORY = 0x01;
  static readonly TYPE_STOP_INVENTORY = 0x02;
  static readonly TYPE_READ_TAG = 0x03;
  static readonly TYPE_GET_ALL_PARAM = 0x68;
  static readonly TYPE_SET_ALL_PARAM = 0x69;
  static readonly TYPE_GET_BATTERY_CAPACITY = 0x76;
  static readonly TYPE_FLASH_SAVE = 0x79;
  static readonly TYPE_KEY_STATE = 0x7A;
  static readonly TYPE_SET_READ_MODE = 0x7C;
  static readonly TYPE_REPORT_KEY_STATE = 0x7D;

  /**
   * Calculates CRC16 for Chafon CF-H103 frame (Polynomial 0x8408, seed 0xFFFF).
   */
  static calculateCRC16(data: Uint8Array, length: number): number {
    let crc = 0xffff;
    for (let i = 0; i < length; i++) {
      crc ^= data[i] & 0xff;
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x0001) !== 0) {
          crc = (crc >> 1) ^ 0x8408;
        } else {
          crc >>= 1;
        }
      }
    }
    return crc & 0xffff;
  }

  /**
   * Helper to format Uint8Array as HEX string
   */
  static bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join('');
  }

  /**
   * Helper to convert HEX string to Uint8Array
   */
  static hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.trim().replace(/^0x/i, '').replace(/\s+/g, '');
    if (cleanHex.length % 2 !== 0) {
      throw new Error('HEX string must have an even length.');
    }
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  /**
   * Normalizes EPC / Mask Hex string
   */
  static normalizeHex(hex: string): string {
    let normalized = hex.trim().replace(/\s+/g, '');
    if (normalized.startsWith('0x') || normalized.startsWith('0X')) {
      normalized = normalized.substring(2);
    }
    normalized = normalized.toUpperCase();
    if (normalized.length % 2 !== 0 || !/^[0-9A-F]*$/.test(normalized)) {
      return '';
    }
    return normalized;
  }

  /**
   * Wraps payload in Chafon frame: [0xCF, 0xFF, length, cmd, ...data, crcHi, crcLo]
   */
  static buildFrame(cmd: number, payload: number[] = []): Uint8Array {
    const dataLen = payload.length;
    const totalLen = 5 + dataLen + 2; // 0xCF, 0xFF, LEN, CMD, payload..., CRC_H, CRC_L
    const frame = new Uint8Array(totalLen);

    frame[0] = 0xcf;
    frame[1] = 0xff;
    frame[2] = dataLen + 1; // Length field including CMD
    frame[3] = cmd;

    for (let i = 0; i < dataLen; i++) {
      frame[4 + i] = payload[i];
    }

    const crc = this.calculateCRC16(frame, 4 + dataLen);
    frame[4 + dataLen] = (crc >> 8) & 0xff;
    frame[5 + dataLen] = crc & 0xff;

    return frame;
  }

  // ========== Command Builders ==========

  /**
   * Get Battery Capacity command
   */
  static buildGetBatteryCapacityCmd(): Uint8Array {
    return this.buildFrame(this.TYPE_GET_BATTERY_CAPACITY, []);
  }

  /**
   * Start Inventory ISO command
   */
  static buildStartInventoryCmd(): Uint8Array {
    return new Uint8Array([
      0xcf, 0xff, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3d, 0xd0
    ]);
  }

  /**
   * Stop Inventory command
   */
  static buildStopInventoryCmd(): Uint8Array {
    return this.buildFrame(this.TYPE_STOP_INVENTORY, []);
  }

  /**
   * Read Single ISO Tag command
   * memoryBank: 0x01 = EPC, 0x02 = TID, 0x03 = USER
   */
  static buildReadSingleTagCmd(memoryBank: number = 0x01): Uint8Array {
    const accPwd = [0x00, 0x00, 0x00, 0x00];
    const wordPtr = memoryBank === 0x01 ? [0x00, 0x02] : [0x00, 0x00];
    const wordCount = 0x06;

    const payload = [...accPwd, memoryBank, ...wordPtr, wordCount];
    return this.buildFrame(this.TYPE_READ_TAG, payload);
  }

  /**
   * Set Read Mode command: 0x00 = RFID, 0x01 = Barcode
   */
  static buildSetReadModeCmd(mode: number): Uint8Array {
    const payload = [mode, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    return this.buildFrame(this.TYPE_SET_READ_MODE, payload);
  }

  /**
   * Barcode Trigger Scan command
   */
  static buildStartBarcodeScanCmd(): Uint8Array {
    return this.buildFrame(0x01, [0x01, 0x01]);
  }

  /**
   * Report Key State / Stop Barcode Scan command
   */
  static buildStopBarcodeScanCmd(): Uint8Array {
    return this.buildFrame(this.TYPE_REPORT_KEY_STATE, [0x02]);
  }

  /**
   * Get All Device Config command
   */
  static buildGetAllParamCmd(): Uint8Array {
    return this.buildFrame(this.TYPE_GET_ALL_PARAM, []);
  }

  /**
   * Save Params to Flash memory command
   */
  static buildSaveFlashCmd(): Uint8Array {
    const cmd = new Uint8Array([0xcf, 0xff, 0x00, 0x79, 0x00, 0x00, 0x00]);
    const crc = this.calculateCRC16(cmd, 5);
    cmd[5] = (crc >> 8) & 0xff;
    cmd[6] = crc & 0xff;
    return cmd;
  }

  // ========== Frame & Mask Matcher Helpers ==========

  /**
   * Checks if EPC matches software mask:
   * maskStartAddress in BYTES offset inside EPC
   * maskLength in BYTES
   * maskHex normalized HEX string
   */
  static matchesEpcMask(
    epcHex: string,
    maskStartAddressBytes: number,
    maskLengthBytes: number,
    maskHex: string
  ): boolean {
    const normEpc = this.normalizeHex(epcHex);
    const normMask = this.normalizeHex(maskHex);

    if (!normEpc || !normMask) return false;
    if (maskStartAddressBytes < 0 || maskLengthBytes < 0) return false;
    if (normMask.length !== maskLengthBytes * 2) return false;

    const startIndex = maskStartAddressBytes * 2;
    const endIndex = startIndex + maskLengthBytes * 2;

    if (startIndex < 0 || endIndex > normEpc.length) {
      return false;
    }

    const epcSlice = normEpc.substring(startIndex, endIndex);
    return epcSlice.toUpperCase() === normMask.toUpperCase();
  }

  /**
   * Formats RFID Code (integer) to fixed-length HEX string
   */
  static encodeRfidCodeHex(value: number, hexWidth: number, fieldName: string): string {
    if (value <= 0) {
      throw new Error(`RFID Code for ${fieldName} must be greater than 0: received ${value}`);
    }
    const hex = value.toString(16).toUpperCase();
    if (hex.length > hexWidth) {
      throw new Error(`RFID Code for ${fieldName} (${hex}) exceeds expected HEX width (${hexWidth})`);
    }
    return hex.padStart(hexWidth, '0');
  }

  /**
   * Encodes numeric model code to 6-char HEX string
   */
  static encodeModelArticleHex(modelCode: string): string {
    const parsed = parseInt(modelCode.trim(), 10);
    if (isNaN(parsed)) {
      throw new Error(`Model code "${modelCode}" is non-numeric and cannot be encoded to HEX.`);
    }
    return this.encodeRfidCodeHex(parsed, 6, 'model code');
  }
}
