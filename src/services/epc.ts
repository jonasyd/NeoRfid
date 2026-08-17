export type EpcDetectionMode = 'model' | 'color' | 'size';

export interface EpcParts {
  brandPrefix: string;
  modelrfid: string;
  modelcolrfid?: string;
  modelsizfid?: string;
}

export interface EpcResult {
  mode: EpcDetectionMode;
  epc: string;
  firstPart: string;
  colorPart?: string;
  sizePart?: string;
}

/**
 * Convierte un campo numérico decimal a HEX y aplica el ancho mínimo indicado.
 *
 * La máscara de negocio indicada para el proyecto es:
 *   [brandPrefix + modelrfid] -> HEX, mínimo 6 dígitos
 *   modelcolrfid               -> HEX, mínimo 3 dígitos
 *   modelsizfid                -> HEX, mínimo 3 dígitos
 *
 * Se mantiene aquí, aislada de la UI, para poder cambiar la codificación si el
 * backend confirma que alguno de estos identificadores no es numérico.
 */
export function stringToHex(value: string, minWidth = 0): string {
  const raw = value ? String(value).trim() : '';
  if (!raw) return '';

  // Si es puramente numérico (ej: "811031") convertimos como entero BigInt
  if (/^\d+$/.test(raw)) {
    const hex = BigInt(raw).toString(16).toUpperCase();
    return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
  }

  // Si ya es un valor hexadecimal válido
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    const hex = raw.toUpperCase();
    return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
  }

  // Convertir caracteres ASCII a HEX (byte a byte)
  let hex = '';
  for (let i = 0; i < raw.length; i++) {
    hex += raw.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
  }
  return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
}

function decimalConcatToHex(values: string[], width: number): string {
  const raw = values.map((v) => (v ? String(v).trim() : '')).join('');
  if (!raw) return '';
  if (/^\d+$/.test(raw)) {
    return BigInt(raw).toString(16).toUpperCase().padStart(width, '0');
  }
  return stringToHex(raw, width);
}

export function buildEpc(parts: EpcParts, mode: EpcDetectionMode): EpcResult {
  const firstPart = decimalConcatToHex([parts.brandPrefix, parts.modelrfid], 6);

  const colorPart = parts.modelcolrfid ? stringToHex(parts.modelcolrfid, 3) : '';
  const sizePart = parts.modelsizfid ? stringToHex(parts.modelsizfid, 3) : '';

  if (mode === 'model') {
    const epc = `${firstPart}${colorPart}${sizePart}`;
    return { mode, epc, firstPart, colorPart, sizePart };
  }

  if (mode === 'color') {
    if (!parts.modelcolrfid) throw new Error('El SKU no tiene modelcolrfid.');
    return { mode, epc: `${firstPart}${colorPart}`, firstPart, colorPart };
  }

  if (!parts.modelsizfid) throw new Error('El SKU no tiene modelsizfid.');
  return { mode, epc: `${firstPart}${sizePart}`, firstPart, sizePart };
}
