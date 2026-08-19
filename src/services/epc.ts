export type EpcDetectionMode = 'model' | 'color' | 'size';

export interface EpcParts {
  brandPrefix: string;
  modelrfid: string;
  modelcolrfid?: string;
  modelsizfid?: string;
}

export interface EpcResult {
  mode: EpcDetectionMode;
  /** Prefijo HEX a usar como máscara de detección radar (match por "empieza con"). */
  epc: string;
  brandHex: string;
  modelHex: string;
  colorHex?: string;
  sizeHex?: string;
}

/**
 * Normaliza un valor que YA viene en HEX: no lo convierte, solo lo limpia y lo rellena.
 *
 * Se usa para brandPrefix, que el backend entrega directamente en HEX (ej: "008100"). Pasarlo
 * por stringToHex() lo rompía: al ser todo dígitos se interpretaba como decimal y "008100"
 * terminaba como "001FA4", con lo cual TODOS los prefijos de detección radar quedaban mal.
 */
export function hexPassthrough(value: string | undefined, minWidth = 0): string {
  const raw = value ? String(value).trim().replace(/^0[xX]/, '') : '';
  if (!raw) return '';
  const hex = raw.toUpperCase();
  return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
}

/**
 * Convierte un campo a HEX y lo rellena a la izquierda ("left pad") hasta minWidth.
 *
 * - Si es puramente numérico (ej: "811031") se interpreta como entero decimal y se convierte.
 * - Si ya es HEX válido, se normaliza a mayúsculas y se rellena.
 * - Si no es ninguna de las dos cosas, se codifica byte a byte (ASCII -> HEX) como fallback.
 *
 * OJO: no usar para brandPrefix — ese ya viene en HEX, va por hexPassthrough().
 */
export function stringToHex(value: string | undefined, minWidth = 0): string {
  const raw = value ? String(value).trim() : '';
  if (!raw) return '';

  if (/^\d+$/.test(raw)) {
    const hex = BigInt(raw).toString(16).toUpperCase();
    return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
  }

  if (/^[0-9a-fA-F]+$/.test(raw)) {
    const hex = raw.toUpperCase();
    return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
  }

  let hex = '';
  for (let i = 0; i < raw.length; i++) {
    hex += raw.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
  }
  return minWidth > 0 ? hex.padStart(minWidth, '0') : hex;
}

/**
 * Arma el prefijo EPC (HEX) según la especificación real de 96 bits confirmada contra un tag
 * de ejemplo:
 *
 *   EPC completo: 0081000C6017021315000000  (24 hex = 12 bytes = EPC-96)
 *     brandPrefix  -> 008100  (YA viene en HEX: se usa tal cual, NO se convierte) — "Marca"
 *     modelrfid    -> 0C6017  (decimal 811031 -> HEX, 6 dígitos, left-pad)  — "Modelo"
 *     modelcolrfid -> 021     (HEX, 3 dígitos, left-pad)  — "Color"
 *     modelsizfid  -> 315     (HEX, 3 dígitos, left-pad)  — "Talle"
 *     resto        -> 000000 (6 dígitos finales de serie/padding — no los generamos, el radar
 *                              nativo matchea por prefijo con startsWith, no hace falta el EPC
 *                              completo)
 *
 * brandPrefix y modelrfid van CADA UNO en sus propios 6 dígitos (no comparten un solo bloque
 * de 6 entre los dos).
 *
 * Prefijos de búsqueda "radar" resultantes:
 *   Modelo -> brandHex + modelHex                    (12 hex)
 *   Color  -> brandHex + modelHex + colorHex         (15 hex)
 *   Talle  -> brandHex + modelHex + colorHex + sizeHex (18 hex, incluye el color)
 */
export function buildEpc(parts: EpcParts, mode: EpcDetectionMode): EpcResult {
  const brandHex = hexPassthrough(parts.brandPrefix, 6);
  const modelHex = stringToHex(parts.modelrfid, 6);
  const colorHex = parts.modelcolrfid ? stringToHex(parts.modelcolrfid, 3) : undefined;
  const sizeHex = parts.modelsizfid ? stringToHex(parts.modelsizfid, 3) : undefined;

  if (mode === 'model') {
    return { mode, epc: `${brandHex}${modelHex}`, brandHex, modelHex, colorHex, sizeHex };
  }

  if (mode === 'color') {
    if (!colorHex) throw new Error('El SKU no tiene modelcolrfid.');
    return { mode, epc: `${brandHex}${modelHex}${colorHex}`, brandHex, modelHex, colorHex, sizeHex };
  }

  // mode === 'size': la búsqueda por talle incluye el color, según la especificación de negocio.
  if (!colorHex) throw new Error('El SKU no tiene modelcolrfid (hace falta para buscar por talle).');
  if (!sizeHex) throw new Error('El SKU no tiene modelsizfid.');
  return { mode, epc: `${brandHex}${modelHex}${colorHex}${sizeHex}`, brandHex, modelHex, colorHex, sizeHex };
}

export interface EpcBreakdown {
  brand: string;
  model: string;
  color: string;
  size: string;
  tail: string;
  /** Valores decimales equivalentes, que son los que entrega la API. */
  modelDec: number | null;
  colorDec: number | null;
  sizeDec: number | null;
}

/**
 * Descompone un EPC leído según el layout de 96 bits del proyecto:
 *   marca(6) + modelo(6) + color(3) + talle(3) + cola(6)
 * La cola es serie/relleno y no participa de las búsquedas por prefijo.
 *
 * Sirve para comparar contra lo que devuelve la API: si el tag dice color 14B pero la API
 * manda modelcolrfid 710 (=2C6), el dato no corresponde a ese artículo.
 */
export function breakdownEpc(epc: string): EpcBreakdown | null {
  const hex = (epc ?? '').trim().toUpperCase();
  if (hex.length < 18) return null;
  const toDec = (h: string) => {
    const n = parseInt(h, 16);
    return Number.isNaN(n) ? null : n;
  };
  return {
    brand: hex.slice(0, 6),
    model: hex.slice(6, 12),
    color: hex.slice(12, 15),
    size: hex.slice(15, 18),
    tail: hex.slice(18),
    modelDec: toDec(hex.slice(6, 12)),
    colorDec: toDec(hex.slice(12, 15)),
    sizeDec: toDec(hex.slice(15, 18)),
  };
}
