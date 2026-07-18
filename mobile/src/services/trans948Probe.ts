// =============================================================================
// TEMPORARY DIAGNOSTIC — 948TE probe mode. Remove before App Store release.
//
// TRANS_PROBE_MODE = true:
//   • Shows a "948TE PROBE" button on the BLE screen (when connected).
//   • run948ProbeSweep() sweeps the CANDIDATES_948 list in order, logging
//     every AT command, request, raw response, and decoded value with a
//     [948TE-PROBE] prefix (console + on-device shareable debug log).
//   • Ends with a SUMMARY block including a plausibility flag per candidate.
//   • Restores the adapter via full re-init (ATZ + standard init) — the sweep
//     mutates ATSP/ATCRA/ATFCSH state the normal app path never touches.
//
// To remove: delete this file and the TRANS_PROBE_MODE block in BLEScreen.tsx.
// The candidate list and decoders live permanently in provider948TE.ts.
// =============================================================================

import { sendCommand } from './obdTransport';
import { initializeAdapter } from './obdService';
import { parseMode22, isNoData, transTempToF } from './obdParser';
import { CANDIDATES_948, decode948, type Candidate948 } from './provider948TE';
import { useVehicleStore } from '../store/vehicleStore';
import { dlog } from './debugLog';

/** Flip to true to enable the 948TE PROBE button on the BLE screen. */
export const TRANS_PROBE_MODE = true;

interface ProbeResult {
  candidate: Candidate948;
  answered: boolean;
  raw: string;
  bytes: number[] | null;
  tempF: number | null;
  plausible: boolean | null;
}

function hexBytes(bytes: number[]): string {
  return bytes.map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Every decode interpretation of a payload, so a one-shot parking-lot test
 * can't be spoiled by promoting the right DID with the wrong formula.
 */
function allDecodes(bytes: number[]): string {
  const parts = [`offset40=${transTempToF(bytes, false).toFixed(1)}°F`];
  if (bytes.length >= 2) parts.unshift(`div64=${transTempToF(bytes, true).toFixed(1)}°F`);
  return parts.join('  ');
}

/** UDS negative-response codes seen in the wild, for readable logs. */
const NRC_NAMES: Record<string, string> = {
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

/** If raw is a UDS negative response (7F <svc> <nrc>), name the NRC. */
function nrcNote(raw: string): string {
  const m = raw.replace(/\s/g, '').toUpperCase().match(/7F([0-9A-F]{2})([0-9A-F]{2})/);
  if (!m) return '';
  return `  [NRC ${m[2]}: ${NRC_NAMES[m[2]] ?? 'unknown'}]`;
}

function plog(msg: string): void {
  dlog(`[948TE-PROBE] ${msg}`);
}

function escapeRaw(raw: string): string {
  return raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/**
 * Sweep all 948TE candidates and log everything. Caller must stopPolling()
 * first and startPolling() after. Always leaves the adapter re-initialized.
 */
export async function run948ProbeSweep(): Promise<void> {
  const results: ProbeResult[] = [];

  // Tester-present keepalive: FCA modules go quiet without 3E00 every ~3s.
  // (3E00 = respond sub-function; 3E01 is invalid — drew 7F3E12 on a 2022 van.)
  // Sequential (no timer) — sendCommand is strictly one-at-a-time. Sent after
  // each candidate's header setup (so it targets the module being probed) and
  // after each response, which keeps the cadence ≈3s across the sweep.
  let lastTP = 0;
  const tp = async (): Promise<void> => {
    if (Date.now() - lastTP < 2500) return;
    const r = await sendCommand('3E00', 1500);
    plog(`TP  → 3E00  ← "${r.trim()}"${nrcNote(r)}`);
    lastTP = Date.now();
  };

  try {
    plog('================ SWEEP START ================');
    const { coolantF, ambientAirF } = useVehicleStore.getState();
    plog(`Reference: coolant=${coolantF !== null ? coolantF.toFixed(1) : 'n/a'}°F  ambient=${ambientAirF !== null ? ambientAirF.toFixed(1) : 'n/a'}°F`);

    // TCM liveness pre-probe: DIDs confirmed alive on the 948TE TCM (module
    // 0x18) via ScanGauge's KL/Renegade XGauge list — present gear (2852) and
    // turbine speed (A002) — plus F190 (VIN) as a default-session control: if
    // VIN answers but the trans DIDs draw NRC 31, those DIDs are session-gated
    // or absent; if VIN is also rejected, the module gates everything.
    const TCM_SETUP = ['ATSP7', 'ATCP18', 'ATSHDA18F1', 'ATCRA18DAF118'];
    const livenessProbes = [
      { req: '222852', did: '2852', label: 'present gear' },
      { req: '22A002', did: 'A002', label: 'turbine speed' },
      { req: '22F190', did: 'F190', label: 'VIN control' },
    ];
    plog('---- TCM liveness pre-probe (module 0x18) ----');
    try {
      for (const at of TCM_SETUP) {
        const r = await sendCommand(at, 2000);
        plog(`AT  → ${at}  ← "${r.trim()}"`);
      }
      await sleep(150);
      lastTP = 0; // force a tester-present right after header setup
      await tp();
      for (const lp of livenessProbes) {
        const raw = await sendCommand(lp.req, 3000);
        const bytes = parseMode22(raw, lp.did);
        let decoded = 'no decode';
        if (bytes) {
          decoded = `bytes=[${hexBytes(bytes)}]`;
          if (lp.did === 'A002' && bytes.length >= 2) {
            decoded += ` → ${((bytes[0] * 256 + bytes[1]) / 4).toFixed(0)} rpm`;
          }
        }
        plog(`LIV → ${lp.req} (${lp.label})  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}  [${decoded}]`);
        await tp();
      }
    } catch (e: any) {
      plog(`LIVENESS ERROR: ${e.message}`);
    }

    // Extended-session retry: the 2022 van's TCM answered NRC 31 for every DID
    // in the default session — on Stellantis modules that often means the DID
    // only serves in extended diagnostic session (10 03). Open it, retry the
    // key DIDs fast (S3 timeout ≈5 s), then politely return to default (10 01).
    plog('---- Extended-session retry (module 0x18, UDS 10 03) ----');
    try {
      for (const at of TCM_SETUP) {
        await sendCommand(at, 2000);
      }
      await sleep(150);
      const sess = await sendCommand('1003', 3000);
      plog(`SES → 1003  ← RAW "${escapeRaw(sess)}"${nrcNote(sess)}`);
      for (const lp of [...livenessProbes, { req: '2208DF', did: '08DF', label: 'trans temp 08DF' }]) {
        const raw = await sendCommand(lp.req, 3000);
        const bytes = parseMode22(raw, lp.did);
        const decoded = bytes ? `bytes=[${hexBytes(bytes)}]  ${allDecodes(bytes)}` : 'no decode';
        plog(`SES → ${lp.req} (${lp.label})  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}  [${decoded}]`);
      }
      const back = await sendCommand('1001', 2000);
      plog(`SES → 1001 (back to default)  ← RAW "${escapeRaw(back)}"`);
    } catch (e: any) {
      plog(`SESSION ERROR: ${e.message}`);
    }

    // Broadcast discovery: headers ON, receive filter cleared, functional
    // broadcast (18DB33F1) for each temp DID — ANY module that serves the DID
    // answers, and with ATH1 the response header names its address (18DAF1xx).
    // This finds the trans-temp module even if it's not 0x10/0x18.
    plog('---- Broadcast discovery (ATH1, functional 18DB33F1) ----');
    try {
      for (const at of ['ATSP7', 'ATCP18', 'ATCRA', 'ATSHDB33F1', 'ATH1']) {
        const r = await sendCommand(at, 2000);
        plog(`AT  → ${at}  ← "${r.trim()}"`);
      }
      await sleep(150);
      for (const did of ['08DF', 'B010', '9110', '1C44']) {
        const raw = await sendCommand(`22${did}`, 4000);
        plog(`BRD → 22${did}  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}`);
      }
      await sendCommand('ATH0', 2000); // headers back off for the candidate loop
    } catch (e: any) {
      plog(`BROADCAST ERROR: ${e.message}`);
      try { await sendCommand('ATH0', 2000); } catch {}
    }

    for (const c of CANDIDATES_948) {
      plog(`---- ${c.name} ----`);
      const result: ProbeResult = { candidate: c, answered: false, raw: '', bytes: null, tempF: null, plausible: null };

      try {
        for (const at of c.setup) {
          const r = await sendCommand(at, 2000);
          plog(`AT  → ${at}  ← "${r.trim()}"`);
          if (r.includes('?')) {
            plog(`NOTE: adapter rejected ${at} — continuing (clone without ATCRA/ATFCSH; reply may still pass default filters)`);
          }
        }
        await sleep(150);
        lastTP = 0; // force a tester-present right after header setup
        await tp();

        const raw = await sendCommand(c.request, 3000);
        result.raw = raw;
        plog(`REQ → ${c.request}  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}`);
        await tp();

        const bytes = parseMode22(raw, c.did);
        if (bytes && bytes.length >= c.minBytes) {
          const f = decode948(bytes, c.decode);
          result.answered = true;
          result.bytes = bytes;
          result.tempF = f;
          result.plausible =
            f > (ambientAirF ?? 32) &&
            f < 260 &&
            (coolantF === null || Math.abs(f - coolantF) > 3);
          plog(`DECODED bytes=[${hexBytes(bytes)}] → ${f.toFixed(1)}°F (${c.decode})  plausible=${result.plausible}`);
          plog(`ALL-DECODES: ${allDecodes(bytes)}`);
        } else {
          plog(`NO POSITIVE 62 RESPONSE (${isNoData(raw) ? 'NO DATA' : 'CAN ERROR / unparseable'})`);
        }
      } catch (e: any) {
        result.raw = e.message ?? 'Error';
        plog(`ERROR: ${e.message}`);
      }
      results.push(result);
    }

    plog('================ SUMMARY ================');
    plog(`coolant=${coolantF !== null ? coolantF.toFixed(1) : 'n/a'}°F  ambient=${ambientAirF !== null ? ambientAirF.toFixed(1) : 'n/a'}°F  (plausible = ambient < F < 260 AND |F − coolant| > 3)`);
    for (const r of results) {
      const detail = r.answered
        ? `${r.tempF!.toFixed(1)}°F (${r.candidate.decode})  plausible=${r.plausible}  all: ${allDecodes(r.bytes!)}`
        : 'no decode';
      plog(`${r.candidate.name}: ANSWERED=${r.answered ? 'yes' : 'no'}  raw="${escapeRaw(r.raw)}"  [${detail}]`);
    }
    plog('Sanity: warm cruise ~165-180°F, climbing ~205-220°F, ~80-90°F above ambient. A value tracking coolant within ±3°F means wrong sensor.');
    plog('================ SWEEP END ================');
  } finally {
    // The sweep changed protocol (ATSP7/ATSP6), receive filters (ATCRA), and
    // flow-control headers (ATFCSH) — wipe it all deterministically.
    plog('Restoring adapter via full re-init (ATZ + standard init)...');
    try {
      await initializeAdapter();
      plog('Adapter re-init complete');
    } catch (e: any) {
      plog(`Adapter re-init FAILED: ${e.message} — power-cycle the adapter if gauges stay dead`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
