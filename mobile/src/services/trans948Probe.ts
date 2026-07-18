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

/**
 * Temp-DID candidates tried on every live endpoint. First four are the
 * Cherokee/62TE-era set (all rejected everywhere on the 2022 van, kept for
 * cross-checking); the rest are additional Stellantis/ZF-9HP suspects.
 */
const TEMP_DIDS = ['08DF', 'B010', '9110', '1C44', '0510', '04FE', '2802', 'A010', '1940'];

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

    // Passive broadcast sniff: the 2022+ cluster can DISPLAY trans temp, so
    // the value crosses the CAN as a periodic broadcast frame. If the OBD
    // port sees any broadcast traffic, the signal is in there without UDS at
    // all; if the port is silent, the SGW isolates broadcast — door closed.
    plog('---- Passive CAN sniff (ATMA, ~4s) ----');
    try {
      await sendCommand('ATH1', 2000);
      const dump = await sendCommand('ATMA', 4500); // timeout returns partial buffer
      await sendCommand('AT', 1500); // any char halts monitor mode
      const flat = dump.replace(/\s+/g, ' ').trim();
      if (!flat || isNoData(flat)) {
        plog('SNIFF: no broadcast traffic visible at OBD port (SGW isolates the bus)');
      } else {
        const out = flat.length > 1500 ? `${flat.slice(0, 1500)} …(+${flat.length - 1500} more chars)` : flat;
        plog(`SNIFF RAW: ${out}`);
      }
      await sendCommand('ATH0', 2000);
    } catch (e: any) {
      plog(`SNIFF ERROR: ${e.message}`);
      try { await sendCommand('ATH0', 2000); } catch {}
    }

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

    // Endpoint census (sweep v3, 2026-07-18) mapped the SGW's proxied
    // allow-list on this van: exactly these 8 physical addresses answered
    // 3E00 out of all 256. Reuse the map — re-walking costs ~90 s per run.
    const liveAddrs = ['10', '18', '1F', '40', '60', 'C6', 'C7', 'CB'];
    plog(`Using endpoint map from prior census: [${liveAddrs.join(', ')}]`);

    // Interrogate every live endpoint for the temp DIDs. Lines where either
    // decode lands in the plausible trans-temp band get a "<<< CHECK THIS"
    // marker so the winner jumps out of the log.
    plog('---- Temp DIDs on live endpoints ----');
    const isPlausibleTemp = (f: number): boolean =>
      f > (ambientAirF ?? 32) && f < 260 && (coolantF === null || Math.abs(f - coolantF) > 3);
    const plausibleAny = (bytes: number[]): boolean =>
      isPlausibleTemp(transTempToF(bytes, false)) ||
      (bytes.length >= 2 && isPlausibleTemp(transTempToF(bytes, true)));
    try {
      for (const hx of liveAddrs.slice(0, 24)) {
        plog(`-- endpoint 0x${hx} --`);
        await sendCommand(`ATSHDA${hx}F1`, 2000);
        await sendCommand(`ATCRA18DAF1${hx}`, 2000);
        await sleep(100);
        lastTP = 0;
        await tp();
        for (const did of TEMP_DIDS) {
          const raw = await sendCommand(`22${did}`, 2500);
          const bytes = parseMode22(raw, did);
          const decoded = bytes ? `bytes=[${hexBytes(bytes)}]  ${allDecodes(bytes)}` : 'no decode';
          const mark = bytes && plausibleAny(bytes) ? '  <<< CHECK THIS' : '';
          plog(`EP${hx} → 22${did}  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}  [${decoded}]${mark}`);
        }
      }
      if (liveAddrs.length > 24) plog(`NOTE: ${liveAddrs.length - 24} additional endpoints not probed (cap 24)`);
    } catch (e: any) {
      plog(`ENDPOINT PROBE ERROR: ${e.message}`);
    }

    // Mode-22 DID sweep on the ECM (0x10): research confirms Fiat-platform
    // vans expose trans oil temp from the ENGINE module via 18DA10F1 (per
    // ScanGauge's engineer), but the exact 948TE DID is proprietary/NDA'd.
    // The ECM rejects unknown DIDs fast (NRC ~200 ms), so brute-force the
    // likely pages. Page order: 91xx first (6-spd temp=9110, slip=91C0 both
    // live there on 0x10), then B0/A0/08 (B010 6-spd, A002 Cherokee, 08DF
    // placeholder), then low data pages. ~15-20 min total; parked-van OK.
    plog('---- Mode-22 DID sweep on ECM 0x10 (18DA10F1) ----');
    const didHits: string[] = [];
    try {
      for (const at of ['ATSP7', 'ATCP18', 'ATSHDA10F1', 'ATCRA18DAF110']) {
        await sendCommand(at, 2000);
      }
      await sendCommand('ATST19', 2000); // fast fail on dead DIDs
      await sleep(100);
      const PAGES = ['91', 'B0', 'A0', '08', '02', '03', '04', '05', '06', '07', '00', '01', '09', '0A', '0B', '0C'];
      for (const pg of PAGES) {
        for (let lo = 0; lo <= 0xff; lo++) {
          const did = pg + lo.toString(16).padStart(2, '0').toUpperCase();
          const raw = (await sendCommand(`22${did}`, 1200)).trim();
          const bytes = parseMode22(raw, did);
          if (bytes) {
            didHits.push(did);
            const mark = plausibleAny(bytes) ? '  <<< CHECK THIS' : '';
            plog(`DID ${did} POSITIVE  ← RAW "${escapeRaw(raw)}"  bytes=[${hexBytes(bytes)}]  ${allDecodes(bytes)}${mark}`);
          }
        }
        plog(`...page ${pg}xx done (${didHits.length} positives so far)`);
      }
      plog(`DID SWEEP POSITIVES on 0x10: [${didHits.join(', ') || 'none'}]`);
    } catch (e: any) {
      plog(`DID SWEEP ERROR: ${e.message}`);
    } finally {
      try {
        await sendCommand('ATST7D', 2000);
      } catch {}
    }

    // Quick mode-21 probes on the ECM (US-platform recipe used 21 30 on the
    // TCM; one shot each on the engine module costs nothing). Raw-logged only
    // — responses are 61 xx ..., not 62, so no parseMode22.
    plog('---- Mode-21 probes on ECM 0x10 ----');
    try {
      for (const req of ['2100', '2110', '2130', '2140']) {
        const raw = await sendCommand(req, 2500);
        plog(`M21 → ${req}  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}`);
      }
    } catch (e: any) {
      plog(`MODE-21 ERROR: ${e.message}`);
    }

    // 11-bit Fiat-style diagnostic scan: the Ducato platform historically
    // parks module diagnostics on 11-bit IDs in the 0x700 range, invisible to
    // the 29-bit census above. Walk 0x700–0x7FF (skipping the 7DF functional
    // broadcast), then hit any live endpoint with the temp DIDs.
    plog('---- 11-bit diagnostic scan (ATSP6, 0x700–0x7FF) ----');
    const live11: string[] = [];
    try {
      await sendCommand('ATSP6', 3000);
      await sendCommand('ATH1', 2000);
      await sendCommand('ATCRA', 1500); // clear receive filter — see every reply
      await sendCommand('ATST19', 2000);
      for (let id = 0x700; id <= 0x7ff; id++) {
        if (id === 0x7df) continue; // functional broadcast, not a module
        const hx = id.toString(16).toUpperCase().padStart(3, '0');
        await sendCommand(`ATSH${hx}`, 800);
        const r = (await sendCommand('3E00', 1000)).trim();
        const up = r.toUpperCase();
        if (r && !isNoData(r) && !r.includes('?') && !up.includes('ERROR') && !up.includes('STOPPED') && !up.includes('SEARCHING')) {
          live11.push(hx);
          plog(`11BIT 0x${hx} ALIVE  ← "${escapeRaw(r)}"`);
        }
        if ((id & 0x3f) === 0x3f) plog(`...scanned through 0x${hx}`);
      }
      plog(`11-BIT ENDPOINTS: [${live11.join(', ') || 'none'}]`);
      for (const hx of live11.slice(0, 12)) {
        plog(`-- 11-bit endpoint 0x${hx} --`);
        await sendCommand(`ATSH${hx}`, 1500);
        for (const did of TEMP_DIDS) {
          const raw = await sendCommand(`22${did}`, 2000);
          const bytes = parseMode22(raw, did);
          const decoded = bytes ? `bytes=[${hexBytes(bytes)}]  ${allDecodes(bytes)}` : 'no decode';
          const mark = bytes && plausibleAny(bytes) ? '  <<< CHECK THIS' : '';
          plog(`B${hx} → 22${did}  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}  [${decoded}]${mark}`);
        }
        // US-platform recipe (Cherokee/Pacifica read trans temp as 21 30)
        const m21 = await sendCommand('2130', 2000);
        plog(`B${hx} → 2130  ← RAW "${escapeRaw(m21)}"${nrcNote(m21)}`);
      }
    } catch (e: any) {
      plog(`11-BIT SCAN ERROR: ${e.message}`);
    } finally {
      try {
        await sendCommand('ATST7D', 2000);
        await sendCommand('ATH0', 2000);
      } catch {}
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
