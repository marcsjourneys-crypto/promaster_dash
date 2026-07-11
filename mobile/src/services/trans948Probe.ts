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
import { parseMode22, isNoData } from './obdParser';
import { CANDIDATES_948, decode948, type Candidate948 } from './provider948TE';
import { useVehicleStore } from '../store/vehicleStore';
import { dlog } from './debugLog';

/** Flip to true to enable the 948TE PROBE button on the BLE screen. */
export const TRANS_PROBE_MODE = false;

interface ProbeResult {
  candidate: Candidate948;
  answered: boolean;
  raw: string;
  tempF: number | null;
  plausible: boolean | null;
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

  // Tester-present keepalive: FCA modules go quiet without 3E01 every ~3s.
  // Sequential (no timer) — sendCommand is strictly one-at-a-time. Sent after
  // each candidate's header setup (so it targets the module being probed) and
  // after each response, which keeps the cadence ≈3s across the sweep.
  let lastTP = 0;
  const tp = async (): Promise<void> => {
    if (Date.now() - lastTP < 2500) return;
    const r = await sendCommand('3E01', 1500);
    plog(`TP  → 3E01  ← "${r.trim()}"`);
    lastTP = Date.now();
  };

  try {
    plog('================ SWEEP START ================');
    const { coolantF, ambientAirF } = useVehicleStore.getState();
    plog(`Reference: coolant=${coolantF !== null ? coolantF.toFixed(1) : 'n/a'}°F  ambient=${ambientAirF !== null ? ambientAirF.toFixed(1) : 'n/a'}°F`);

    for (const c of CANDIDATES_948) {
      plog(`---- ${c.name} ----`);
      const result: ProbeResult = { candidate: c, answered: false, raw: '', tempF: null, plausible: null };

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
        plog(`REQ → ${c.request}  ← RAW "${escapeRaw(raw)}"`);
        await tp();

        const bytes = parseMode22(raw, c.did);
        if (bytes && bytes.length >= c.minBytes) {
          const hex = bytes.map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
          const f = decode948(bytes, c.decode);
          result.answered = true;
          result.tempF = f;
          result.plausible =
            f > (ambientAirF ?? 32) &&
            f < 260 &&
            (coolantF === null || Math.abs(f - coolantF) > 3);
          plog(`DECODED bytes=[${hex}] → ${f.toFixed(1)}°F  plausible=${result.plausible}`);
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
        ? `${r.tempF!.toFixed(1)}°F  plausible=${r.plausible}`
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
