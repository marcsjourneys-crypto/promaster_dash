/**
 * BLE wire format of the PM-TPMS receiver (firmware/tpms_receiver).
 *
 * Mirror of the firmware's README "BLE protocol (v1)" — change both together.
 * Pure: no BLE or store imports, so the framing is unit-testable.
 *
 * Readings are converted to psi / °F here, at ingest, because everything
 * inside the app is imperial (see utils/units.ts).
 */

export const TPMS_DEVICE_NAME = 'PM-TPMS';
export const TPMS_SERVICE_UUID = '7d2a0001-6c1e-4f3b-9a5e-3b1f0c2d8e41';
export const TPMS_READING_UUID = '7d2a0002-6c1e-4f3b-9a5e-3b1f0c2d8e41';
export const TPMS_CONFIG_UUID = '7d2a0003-6c1e-4f3b-9a5e-3b1f0c2d8e41';
export const TPMS_STATUS_UUID = '7d2a0004-6c1e-4f3b-9a5e-3b1f0c2d8e41';
export const TPMS_CONTROL_UUID = '7d2a0005-6c1e-4f3b-9a5e-3b1f0c2d8e41';

export const PROTO_VERSION = 1;
export const CTRL_REPLAY = 0x01;
/** Firmware allowlist capacity (MAX_IDS). */
export const MAX_SENSOR_IDS = 8;

const RFLAG_KNOWN = 0x01;
const RFLAG_CACHED = 0x02;
const KPA_TO_PSI = 0.1450377;

export interface TpmsReading {
  /** 7 hex digits, upper case — the same spelling rtl_433 prints. */
  id: string;
  psi: number;
  tempF: number;
  kPa: number;
  tempC: number;
  flags: number;
  /** On the receiver's allowlist. False only for learn-mode sightings. */
  known: boolean;
  /** Replayed from the receiver's cache rather than heard just now. */
  cached: boolean;
  /** When the sensor actually transmitted (epoch ms), corrected for cache age. */
  ts: number;
}

export interface TpmsReceiverConfig {
  ids: string[];
  learn: boolean;
}

export interface TpmsReceiverStatus {
  uptimeS: number;
  decoded: number;
  reported: number;
  overflows: number;
}

export function formatSensorId(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(7, '0');
}

/** Parse a hex sensor id; null unless it fits in 28 bits. */
export function parseSensorId(s: string): number | null {
  const t = s.trim();
  if (!/^[0-9a-f]{1,7}$/i.test(t)) return null;
  return parseInt(t, 16);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** READING: ver, id u32, pressureRaw, tempRaw, flags, rflags, age_s u16, reserved. */
export function decodeReadingFrame(b: Uint8Array, nowMs: number): TpmsReading | null {
  if (b.length < 12 || b[0] !== PROTO_VERSION) return null;
  const kPa = b[5] * 2.5;
  const tempC = b[6] - 50;
  return {
    id: formatSensorId(u32(b, 1)),
    kPa,
    tempC,
    psi: kPa * KPA_TO_PSI,
    tempF: (tempC * 9) / 5 + 32,
    flags: b[7],
    known: (b[8] & RFLAG_KNOWN) !== 0,
    cached: (b[8] & RFLAG_CACHED) !== 0,
    ts: nowMs - u16(b, 9) * 1000,
  };
}

/** CONFIG: ver, learn, n, id u32 × n. Invalid ids are dropped. */
export function encodeConfigFrame(ids: string[], learn: boolean): Uint8Array {
  const nums = ids
    .map(parseSensorId)
    .filter((n): n is number => n !== null)
    .slice(0, MAX_SENSOR_IDS);
  const b = new Uint8Array(3 + 4 * nums.length);
  b[0] = PROTO_VERSION;
  b[1] = learn ? 1 : 0;
  b[2] = nums.length;
  nums.forEach((n, i) => {
    const o = 3 + 4 * i;
    b[o] = n & 0xff;
    b[o + 1] = (n >>> 8) & 0xff;
    b[o + 2] = (n >>> 16) & 0xff;
    b[o + 3] = (n >>> 24) & 0xff;
  });
  return b;
}

export function decodeConfigFrame(b: Uint8Array): TpmsReceiverConfig | null {
  if (b.length < 3 || b[0] !== PROTO_VERSION) return null;
  const n = b[2];
  if (b.length !== 3 + 4 * n) return null;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(formatSensorId(u32(b, 3 + 4 * i)));
  return { ids, learn: b[1] !== 0 };
}

/** STATUS: ver, uptime_s, decoded, reported, overflows (all u32). */
export function decodeStatusFrame(b: Uint8Array): TpmsReceiverStatus | null {
  if (b.length < 17 || b[0] !== PROTO_VERSION) return null;
  return {
    uptimeS: u32(b, 1),
    decoded: u32(b, 5),
    reported: u32(b, 9),
    overflows: u32(b, 13),
  };
}
