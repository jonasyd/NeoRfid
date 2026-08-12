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
function decimalConcatToHex(values: string[], width: number): string {
  const raw = values.join('').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`El componente EPC "${raw}" debe ser numérico para la máscara actual.`);
  }
  return BigInt(raw).toString(16).toUpperCase().padStart(width, '0');
}

function decimalToHex(value: string, width: number): string {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`El componente EPC "${raw}" debe ser numérico para la máscara actual.`);
  }
  return BigInt(raw).toString(16).toUpperCase().padStart(width, '0');
}

export function buildEpc(parts: EpcParts, mode: EpcDetectionMode): EpcResult {
  const firstPart = decimalConcatToHex([parts.brandPrefix, parts.modelrfid], 6);

  if (mode === 'model') {
    return { mode, epc: firstPart, firstPart };
  }

  if (mode === 'color') {
    if (!parts.modelcolrfid) throw new Error('El SKU no tiene modelcolrfid.');
    const colorPart = decimalToHex(parts.modelcolrfid, 3);
    return { mode, epc: `${firstPart}${colorPart}`, firstPart, colorPart };
  }

  if (!parts.modelsizfid) throw new Error('El SKU no tiene modelsizfid.');
  const sizePart = decimalToHex(parts.modelsizfid, 3);
  return { mode, epc: `${firstPart}${sizePart}`, firstPart, sizePart };
}
