/**
 * Pure decision/formatting logic for the body-module address sweep.
 *
 * Kept free of transport/store imports (only the pure obdParser) so the sweep's
 * addressing, classification, and command sequencing are unit-testable without a
 * bus — the same split as pollScheduler.ts vs obdService.ts. All bus I/O lives
 * in bodySweep.ts.
 *
 * TEMPORARY DIAGNOSTIC — remove with bodySweep.ts before release.
 */

import { parseMode22, isNoData } from './obdParser';

// ---------------------------------------------------------------------------
// Configurable sweep parameters — edit these, they are the whole control surface
// ---------------------------------------------------------------------------

/**
 * 29-bit target bytes to walk, as `18DA<target>F1`. Default is the full
 * 0x00–0xFF space: the goal is to discover *which* addresses the security
 * gateway proxies to the OBD port, so an exhaustive walk is the honest answer.
 * A prior powertrain census (vault: "948TE Probe Mode") saw only 8 answer — see
 * KNOWN_LIVE_TARGETS. To probe a short list, replace with e.g. ['20','21','22'].
 */
export const BODY_SWEEP_TARGETS: string[] = expandTargetRange(0x00, 0xff);

/**
 * Addresses already known to answer on this van from the powertrain-era census.
 * Hits on these are annotated so genuinely NEW responders stand out in the log.
 */
export const KNOWN_LIVE_TARGETS: string[] = ['10', '18', '1F', '40', '60', 'C6', 'C7', 'CB'];

/**
 * ISO 14229 identification DIDs — module fingerprints, not gauges. A responder
 * that returns a sane VIN to F190 is a real, correctly-addressed module.
 * (Vault: "Candidate Enhanced DIDs".)
 */
export const FINGERPRINT_DIDS: { did: string; label: string; ascii: boolean }[] = [
  { did: 'F190', label: 'VIN', ascii: true },
  { did: 'F18C', label: 'ECU serial', ascii: true },
  { did: 'F195', label: 'ECU software version', ascii: true },
  { did: 'F18A', label: 'system supplier id', ascii: true },
  { did: 'F18B', label: 'ECU manufacturing date', ascii: false },
];

/**
 * Optional DID sweep. Set BODY_SWEEP_DID_TARGET to a target byte (e.g. '40')
 * that answered the address sweep, and the sweep will walk BODY_SWEEP_DID_PAGES
 * on it after fingerprinting. Leave null to skip.
 */
export const BODY_SWEEP_DID_TARGET: string | null = null;
export const BODY_SWEEP_DID_PAGES: string[] = ['F1', '00', '01', '02', '25', '28', '29'];

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** Normalise a target byte to two upper-case hex chars. */
export function normTarget(target: string | number): string {
  const n = typeof target === 'number' ? target : parseInt(target, 16);
  return (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** 29-bit physical transmit header addressing a module: 18DA<target>F1. */
export function physicalHeader(target: string): string {
  return `18DA${normTarget(target)}F1`;
}

/** 29-bit receive filter for that module's replies (to tester F1 from target). */
export function receiveFilter(target: string): string {
  return `18DAF1${normTarget(target)}`;
}

/** Inclusive range of target bytes as 2-hex strings, e.g. (0x00,0xFF) → 256 entries. */
export function expandTargetRange(lo: number, hi: number): string[] {
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) out.push(normTarget(n));
  return out;
}

/** Expand DID pages (['F1']) into full DID list (F100..F1FF). */
export function expandDidPages(pages: string[]): string[] {
  const out: string[] = [];
  for (const pg of pages) {
    const p = pg.toUpperCase().padStart(2, '0');
    for (let lo = 0; lo <= 0xff; lo++) {
      out.push(p + lo.toString(16).toUpperCase().padStart(2, '0'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

export type ResponseKind = 'positive' | 'nrc' | 'no-data' | 'rejected' | 'empty' | 'other';

/** UDS negative-response codes seen in the wild, for readable logs. */
export const NRC_NAMES: Record<string, string> = {
  '10': 'generalReject',
  '11': 'serviceNotSupported',
  '12': 'subFunctionNotSupported',
  '13': 'incorrectLength',
  '22': 'conditionsNotCorrect',
  '31': 'requestOutOfRange (DID not supported in current session)',
  '33': 'securityAccessDenied',
  '78': 'responsePending',
  '7E': 'subFunctionNotSupportedInActiveSession',
  '7F': 'serviceNotSupportedInActiveSession',
};

/** Extract the NRC byte from a UDS negative response (7F <svc> <nrc>), or null. */
export function nrcCode(raw: string): string | null {
  const m = (raw ?? '').replace(/\s/g, '').toUpperCase().match(/7F[0-9A-F]{2}([0-9A-F]{2})/);
  return m ? m[1] : null;
}

/** Human note for an NRC, e.g. "  [NRC 31: requestOutOfRange…]". Empty if none. */
export function nrcNote(raw: string): string {
  const code = nrcCode(raw);
  if (!code) return '';
  return `  [NRC ${code}: ${NRC_NAMES[code] ?? 'unknown'}]`;
}

/**
 * Classify a raw ELM response for the sweep. A positive UDS reply for `did` is
 * `62<did>…`; a negative is `7F22<nrc>`. Silence, clone rejections ('?'), and
 * bus errors each get their own kind so the log tells them apart.
 */
export function classifyResponse(raw: string, did?: string): ResponseKind {
  const flat = (raw ?? '').replace(/\s/g, '').toUpperCase();
  if (!flat) return 'empty';
  if (isNoData(raw)) return 'no-data';
  if (flat.includes('?')) return 'rejected';
  if (did && parseMode22(raw, did) !== null) return 'positive';
  if (!did && /62[0-9A-F]{4}/.test(flat)) return 'positive';
  if (nrcCode(raw) !== null) return 'nrc';
  return 'other';
}

/** True if a 3E00 tester-present drew any sign of life (not silence/rejection). */
export function isLiveResponse(raw: string): boolean {
  const kind = classifyResponse(raw);
  return kind === 'positive' || kind === 'nrc' || kind === 'other';
}

// ---------------------------------------------------------------------------
// Decoding & formatting
// ---------------------------------------------------------------------------

/** Decode a byte array as printable ASCII, non-printables shown as '.'. */
export function decodeAscii(bytes: number[]): string {
  return bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
}

/** A plausible VIN: 17 chars from the legal VIN alphabet (no I, O, Q). */
export function isSaneVin(s: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
}

/** Hex-dump helper matching the 948TE probe's format. */
export function hexBytes(bytes: number[]): string {
  return bytes.map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Escape CR/LF for single-line logging. */
export function escapeRaw(raw: string): string {
  return (raw ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Two payloads equal? Used to flag constant (suspect) vs varying DID values. */
export function payloadsEqual(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Command sequencing
// ---------------------------------------------------------------------------

export interface ProbeStep {
  role: 'set-header' | 'set-filter' | 'tester-present' | 'clear-filter' | 'reset-header' | 'flush';
  cmd: string;
}

/**
 * The ordered command plan for probing one address, teardown included. The
 * orchestrator executes this; the test asserts against it. The invariant that
 * matters: the sequence ALWAYS ends by resetting the header to the functional
 * broadcast and flushing — teardown is unconditional and last.
 */
export function buildAddressProbeSequence(target: string, broadcast: string): ProbeStep[] {
  return [
    { role: 'set-header', cmd: `ATSH${physicalHeader(target)}` },
    { role: 'set-filter', cmd: `ATCRA${receiveFilter(target)}` },
    { role: 'tester-present', cmd: '3E00' },
    { role: 'clear-filter', cmd: 'ATCRA' },
    { role: 'reset-header', cmd: `ATSH${broadcast}` },
    { role: 'flush', cmd: 'ATAR' },
  ];
}
