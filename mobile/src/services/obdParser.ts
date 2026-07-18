/**
 * OBD-II response parsing helpers.
 * Handles Mode 01, Mode 03 (DTCs), Mode 22 (UDS), and voltage.
 */

/**
 * Clean raw ELM327 response:
 * - Remove echo, "SEARCHING...", "NO DATA", whitespace
 * - Return cleaned hex lines
 */
export function cleanResponse(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const upper = line.toUpperCase();
      if (upper.includes('SEARCHING')) return false;
      if (upper.includes('STOPPED')) return false;
      if (upper.includes('BUS INIT')) return false;
      if (upper.includes('UNABLE')) return false;
      if (upper.includes('ERROR')) return false;
      if (upper.includes('?')) return false;
      if (upper === 'OK') return false;
      return true;
    });
}

/** Check if response indicates no data. */
export function isNoData(raw: string): boolean {
  const upper = raw.toUpperCase();
  return upper.includes('NO DATA') || upper.includes('NO RESPONSE');
}

/**
 * Parse Mode 01 response for a given PID.
 * Returns data bytes (A, B, ...) or null.
 *
 * Expected: "41 <PID> <A> [B] ..."
 * With headers off: "41050A" or "41 05 0A"
 */
export function parseMode01(raw: string, pid: string): number[] | null {
  if (isNoData(raw)) return null;

  const lines = cleanResponse(raw);
  const pidUpper = pid.toUpperCase();
  const marker = `41${pidUpper}`;

  for (const line of lines) {
    // Remove spaces for uniform parsing
    const hex = line.replace(/\s/g, '').toUpperCase();

    // Find the 41+PID marker
    const idx = hex.indexOf(marker);
    if (idx < 0) continue;

    // Extract data bytes after the marker
    const dataHex = hex.substring(idx + marker.length);
    if (dataHex.length < 2) continue;

    const bytes: number[] = [];
    for (let i = 0; i < dataHex.length; i += 2) {
      const b = parseInt(dataHex.substring(i, i + 2), 16);
      if (isNaN(b)) break;
      bytes.push(b);
    }

    if (bytes.length > 0) return bytes;
  }

  return null;
}

/**
 * Parse Mode 22 (UDS) response for a given DID.
 * Returns data bytes or null.
 *
 * Expected: "62 <DID> <data...>"
 */
export function parseMode22(raw: string, did: string): number[] | null {
  if (isNoData(raw)) return null;

  const lines = cleanResponse(raw);
  const didUpper = did.toUpperCase();
  const marker = `62${didUpper}`;

  for (const line of lines) {
    const hex = line.replace(/\s/g, '').toUpperCase();
    const idx = hex.indexOf(marker);
    if (idx < 0) continue;

    const dataHex = hex.substring(idx + marker.length);
    if (dataHex.length < 2) continue;

    const bytes: number[] = [];
    for (let i = 0; i < dataHex.length; i += 2) {
      const b = parseInt(dataHex.substring(i, i + 2), 16);
      if (isNaN(b)) break;
      bytes.push(b);
    }

    if (bytes.length > 0) return bytes;
  }

  return null;
}

/** Shared DTC byte-pair parser. marker = '43' (Mode 03) or '47' (Mode 07). */
function parseDTCResponse(raw: string, marker: string): string[] {
  if (isNoData(raw)) return [];
  const lines = cleanResponse(raw);
  const codes: string[] = [];
  const target = marker.toUpperCase();
  for (const line of lines) {
    const hex = line.replace(/\s/g, '').toUpperCase();
    let idx = hex.indexOf(target);
    if (idx < 0) continue;
    idx += 2;
    while (idx + 4 <= hex.length) {
      const a = parseInt(hex.substring(idx, idx + 2), 16);
      const b = parseInt(hex.substring(idx + 2, idx + 4), 16);
      idx += 4;
      if (isNaN(a) || isNaN(b)) break;
      if (a === 0 && b === 0) continue;
      const code = decodeDTC(a, b);
      if (code) codes.push(code);
    }
  }
  return codes;
}

/** Parse Mode 03 stored DTC response. Returns codes like ["P0300", "U0140"]. */
export function parseMode03(raw: string): string[] {
  return parseDTCResponse(raw, '43');
}

/** Parse Mode 07 pending DTC response (same byte format as Mode 03, prefix 47). */
export function parseMode07(raw: string): string[] {
  return parseDTCResponse(raw, '47');
}

/** Decode 2 bytes into a DTC string. Returns null for invalid/implausible codes. */
function decodeDTC(a: number, b: number): string | null {
  const typeMap = ['P', 'C', 'B', 'U'];
  const typeIdx = (a >> 6) & 0x03;
  const prefix = typeMap[typeIdx];
  const d1 = (a >> 4) & 0x03;
  const d2 = a & 0x0f;
  const d3 = (b >> 4) & 0x0f;
  const d4 = b & 0x0f;

  const code = `${prefix}${d1}${d2.toString(16).toUpperCase()}${d3.toString(16).toUpperCase()}${d4.toString(16).toUpperCase()}`;

  // Reject all-F codes (0xFFFF = bus error / invalid frame)
  if (a === 0xFF && b === 0xFF) return null;
  // Reject codes where all data nibbles are F (e.g. PFFF, P1FFF patterns)
  if (d2 === 0x0F && d3 === 0x0F && d4 === 0x0F) return null;
  // OBD-II digit 1 (d1) must be 0–3; values 4–F indicate non-standard/manufacturer code prefix issues
  // d1 is already masked to 0x03 so this is always valid, no extra check needed

  return code;
}

/** Parse ATRV voltage response. Returns volts or null. */
export function parseVoltage(raw: string): number | null {
  const lines = cleanResponse(raw);
  for (const line of lines) {
    // Look for pattern like "12.3V" or "12.3"
    const match = line.match(/([\d.]+)\s*[Vv]?/);
    if (match) {
      const v = parseFloat(match[1]);
      if (!isNaN(v) && v > 5 && v < 20) return v;
    }
  }
  return null;
}

// ---- Value conversion helpers ----

/** Mode 01 PID 05: Coolant temp. A - 40 (°C) → °F */
export function coolantToF(bytes: number[]): number {
  return ((bytes[0] - 40) * 9) / 5 + 32;
}

/** Mode 01 PID 0C: RPM. ((A*256)+B)/4 */
export function bytesToRPM(bytes: number[]): number {
  return Math.round(((bytes[0] * 256) + bytes[1]) / 4);
}

/** Mode 01 PID 0D: Speed. A (km/h) → mph */
export function obdSpeedToMph(bytes: number[]): number {
  return Math.round(bytes[0] * 0.621371);
}

/**
 * Mode 22 trans temp.
 * B010/9110: (A*256+B)/64 → °F directly (confirmed via ScanGauge XGauge).
 * Single-byte (twoByteMode=false): (A - 40) * 1.8 + 32 — i.e. °C = A − 40.
 * This is also the 948TE DID 08DF decode ('offset40', ScanGauge KL/Renegade).
 */
export function transTempToF(bytes: number[], twoByteMode = false): number {
  if (twoByteMode && bytes.length >= 2) {
    return (bytes[0] * 256 + bytes[1]) / 64;
  }
  return ((bytes[0] - 40) * 9) / 5 + 32;
}

/**
 * Mode 22 single-byte signed °C → °F.
 * A is a two's-complement signed byte in °C. (Kept for future candidates;
 * no current provider uses it — 948TE 08DF turned out to be offset-40.)
 */
export function signedCelsiusToF(bytes: number[]): number {
  const c = bytes[0] > 127 ? bytes[0] - 256 : bytes[0];
  return c * 1.8 + 32;
}

/** Mode 01 PID 04: Engine load. A * 100 / 255 (%) */
export function bytesToLoadPct(bytes: number[]): number {
  return (bytes[0] * 100) / 255;
}

/** Mode 01 PID 0F: Intake air temp. A - 40 (°C) → °F */
export function intakeAirToF(bytes: number[]): number {
  return ((bytes[0] - 40) * 9) / 5 + 32;
}

/** Mode 01 PID 2F: Fuel tank level. A * 100 / 255 (%) */
export function bytesToFuelLevelPct(bytes: number[]): number {
  return (bytes[0] * 100) / 255;
}

/** Mode 01 PID 46: Ambient air temp. A - 40 (°C) → °F */
export function ambientAirToF(bytes: number[]): number {
  return ((bytes[0] - 40) * 9) / 5 + 32;
}

/** Mode 22 DID 022A: Oil pressure. A * 29 / 50 (PSI) */
export function bytesToOilPressurePsi(bytes: number[]): number {
  return (bytes[0] * 29) / 50;
}

/** Mode 22 DID 0121: Oil temp. (A - 64) * 1.8 + 32 (°F) */
export function bytesToOilTempF(bytes: number[]): number {
  return (bytes[0] - 64) * 1.8 + 32;
}

/** Mode 01 PIDs 06/07/08/09: Fuel trim. (A − 128) × 100 / 128 (%). 0x80 → 0%, 0x00 → −100%, 0xFF → +99.2%. */
export function bytesToFuelTrimPct(bytes: number[]): number {
  return (bytes[0] - 128) * 100 / 128;
}

