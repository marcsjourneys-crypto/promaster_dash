// =============================================================================
// TEMPORARY DIAGNOSTIC — Body-module address sweep. Remove before release.
//
// BODY_SWEEP_MODE = true:
//   • Shows a "BODY SWEEP" button on the BLE screen (when connected).
//   • runBodySweep() walks a list of 29-bit physical addresses (18DA<target>F1),
//     tester-presents each, and logs which answer — then fingerprints every
//     responder with the ISO identification DIDs (VIN / serial / SW version),
//     and optionally DID-sweeps one chosen address.
//   • Every line is logged with a [BODY-SWEEP] prefix (console + on-device
//     shareable debug log), same as the 948TE probe.
//   • Restores the adapter via full re-init (ATZ + standard init) on exit — the
//     sweep mutates ATSH / ATCRA / receive-filter state the normal path never
//     touches.
//
// PURPOSE: a from-scratch reverse-engineering aid for finding which BODY-side
// modules (Body Computer / TPMS) are reachable from the OBD-II port, and at what
// 29-bit address. Nothing here is a shipping feature and nothing is written to
// the PID registry or the store — discovery only. Vault: "TPMS Hunt",
// "Candidate Enhanced DIDs".
//
// Pure logic (addressing, classification, sequencing) lives in bodySweepCore.ts
// so it is unit-tested without a bus. To remove: delete both files and the
// BODY_SWEEP_MODE block in BLEScreen.tsx. Modelled on trans948Probe.ts.
// =============================================================================

import { DIAGNOSTICS_ENABLED } from '../config/diagnostics';
import { sendCommand, sendAtsh } from './obdTransport';
import { getBroadcastHeader, initializeAdapter } from './obdService';
import { dlog } from './debugLog';
import {
  BODY_SWEEP_TARGETS,
  KNOWN_LIVE_TARGETS,
  FINGERPRINT_DIDS,
  BODY_SWEEP_DID_TARGETS,
  BODY_SWEEP_DID_PAGES,
  BODY_SWEEP_DID_EXTENDED_SESSION,
  parseFingerprint,
  normTarget,
  physicalHeader,
  receiveFilter,
  expandDidPages,
  classifyResponse,
  isLiveResponse,
  nrcCode,
  nrcNote,
  decodeAscii,
  isSaneVin,
  hexBytes,
  escapeRaw,
  payloadsEqual,
} from './bodySweepCore';

/** Shows the BODY SWEEP button on the BLE screen. Tied to the diagnostics
 *  build switch, so it is on only for `npm run ios:diag` cable builds and off
 *  in anything handed to a tester. No longer needs flipping by hand. */
export const BODY_SWEEP_MODE = DIAGNOSTICS_ENABLED;

/** Per-command timeout during the fast address walk (ms). ATST19 keeps silent
 *  addresses failing quickly, so this only bounds the pathological case. */
const PROBE_TIMEOUT = 1200;
/** Timeout for the (possibly multi-frame) fingerprint reads. */
const FINGERPRINT_TIMEOUT = 3000;

/** Guards against a second sweep starting while one is already running — two
 *  concurrent runs interleave commands on the one BLE link and wedge it
 *  (seen live 2026-08-16). */
let sweepInProgress = false;

function plog(msg: string): void {
  dlog(`[BODY-SWEEP] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Point the adapter at one 29-bit module address, clone-safe. sendAtsh() handles
 * adapters that reject the 4-byte ATSH by falling back to ATCP + 3-byte split.
 * Returns whether the transmit header was accepted.
 */
async function aimAtTarget(target: string): Promise<boolean> {
  const accepted = await sendAtsh(physicalHeader(target));
  if (accepted) {
    const f = await sendCommand(`ATCRA${receiveFilter(target)}`, PROBE_TIMEOUT);
    if (f.includes('?')) plog(`NOTE: 0x${normTarget(target)} — adapter rejected ATCRA (clone); replies may still pass default filter`);
  }
  return accepted;
}

/**
 * Reset the adapter's header/filter back to the protocol-correct functional
 * broadcast. MUST run after every probe (task constraint; see CAN Protocol
 * Runbook) — a physical or wrong-width header left pinned wedges fragile clones.
 */
async function resetHeader(): Promise<void> {
  try {
    await sendCommand('ATCRA', PROBE_TIMEOUT); // clear receive filter
    await sendAtsh(getBroadcastHeader()); // 18DB33F1 on 29-bit, 7DF on 11-bit — never hardcoded
    await sendCommand('ATAR', PROBE_TIMEOUT); // flush adaptive timing
  } catch (e: any) {
    plog(`RESET WARN: ${e.message}`);
  }
}

/** Read one DID and return the raw string plus parsed payload (multi-frame aware). */
async function readDid(did: string, timeout: number): Promise<{ raw: string; bytes: number[] | null }> {
  const raw = await sendCommand(`22${did}`, timeout);
  return { raw, bytes: parseFingerprint(raw, did) };
}

/**
 * Full body-module sweep. Caller must stopPolling() first and startPolling()
 * after. Always leaves the adapter re-initialized (see finally).
 *
 * Phase 1: address sweep  — which 18DA<target>F1 answer 3E00.
 * Phase 2: fingerprint    — VIN / serial / SW version on each responder.
 * Phase 3: DID sweep      — optional, the configured addresses.
 */
export async function runBodySweep(): Promise<void> {
  if (sweepInProgress) {
    plog('IGNORED — a sweep is already running. Wait for it to finish (SUMMARY line).');
    return;
  }
  sweepInProgress = true;

  const responders: string[] = [];

  try {
    plog('================ BODY SWEEP START ================');
    plog(`Targets: ${BODY_SWEEP_TARGETS.length} address(es) as 18DA<target>F1. Known-live from prior census: [${KNOWN_LIVE_TARGETS.join(', ')}]`);
    plog('A responder is any address whose 3E00 draws a positive, an NRC, or a bus error — i.e. something is there. Silence = not reachable at the port.');

    // ---- Phase 1: address sweep ----
    plog('---- Phase 1: address sweep (3E00 to 18DA<target>F1) ----');
    await sendCommand('ATST19', PROBE_TIMEOUT); // fast-fail on silent addresses
    try {
      let scanned = 0;
      for (const target of BODY_SWEEP_TARGETS) {
        const t = normTarget(target);
        try {
          const accepted = await aimAtTarget(t);
          if (!accepted) {
            plog(`0x${t}: ATSH rejected by adapter — skipped`);
            continue;
          }
          await sleep(40);
          const raw = await sendCommand('3E00', PROBE_TIMEOUT);
          const kind = classifyResponse(raw);
          if (isLiveResponse(raw)) {
            responders.push(t);
            const known = KNOWN_LIVE_TARGETS.includes(t) ? '' : '  <<< NEW (not in prior census)';
            plog(`0x${t} RESPONDER [${kind}]  ← 3E00 "${escapeRaw(raw)}"${nrcNote(raw)}${known}`);
          }
        } finally {
          // Unconditional teardown after every probe.
          await resetHeader();
        }
        scanned++;
        if ((scanned & 0x1f) === 0) plog(`...scanned ${scanned}/${BODY_SWEEP_TARGETS.length} (0x${t}), ${responders.length} responder(s) so far`);
      }
    } finally {
      try { await sendCommand('ATST7D', PROBE_TIMEOUT); } catch {}
    }
    plog(`ADDRESS SWEEP RESPONDERS: [${responders.map((r) => '0x' + r).join(', ') || 'none'}]`);

    // ---- Phase 2: fingerprint every responder ----
    plog('---- Phase 2: fingerprint responders (ISO identification DIDs) ----');
    for (const t of responders) {
      plog(`-- fingerprint 0x${t} --`);
      try {
        if (!(await aimAtTarget(t))) {
          plog(`0x${t}: ATSH rejected — cannot fingerprint`);
          continue;
        }
        await sleep(60);
        await sendCommand('3E00', PROBE_TIMEOUT); // wake before reading
        for (const fp of FINGERPRINT_DIDS) {
          const { raw, bytes } = await readDid(fp.did, FINGERPRINT_TIMEOUT);
          let decoded = 'no positive response';
          if (bytes) {
            const ascii = decodeAscii(bytes);
            decoded = `bytes=[${hexBytes(bytes)}]`;
            if (fp.ascii) {
              decoded += `  ascii="${ascii}"`;
              if (fp.did === 'F190') decoded += isSaneVin(ascii) ? '  <<< SANE VIN — real module' : '  (not a 17-char VIN)';
            }
          }
          plog(`FP 0x${t} → 22${fp.did} (${fp.label})  ← RAW "${escapeRaw(raw)}"${nrcNote(raw)}  [${decoded}]`);
        }
      } catch (e: any) {
        plog(`FINGERPRINT 0x${t} ERROR: ${e.message}`);
      } finally {
        await resetHeader();
      }
    }

    // ---- Phase 3: optional DID sweep on the configured address(es) ----
    if (BODY_SWEEP_DID_TARGETS.length > 0) {
      const dids = expandDidPages(BODY_SWEEP_DID_PAGES);
      const sessionNote = BODY_SWEEP_DID_EXTENDED_SESSION ? 'extended session (10 03)' : 'default session';
      plog(`---- Phase 3: DID sweep on [${BODY_SWEEP_DID_TARGETS.map((x) => '0x' + normTarget(x)).join(', ')}] in ${sessionNote} (${dids.length} DIDs/module across pages [${BODY_SWEEP_DID_PAGES.join(', ')}]) ----`);
      for (const target of BODY_SWEEP_DID_TARGETS) {
        const t = normTarget(target);
        plog(`-- DID sweep 0x${t} --`);
        const hits: string[] = [];
        // Tester-present keepalive: keeps an extended session from timing out
        // (S3 ~5 s) during long NRC-31 stretches. Sent at most every ~2.5 s.
        let lastTP = 0;
        const keepAlive = async (): Promise<void> => {
          if (Date.now() - lastTP < 2500) return;
          await sendCommand('3E00', PROBE_TIMEOUT);
          lastTP = Date.now();
        };
        try {
          if (!(await aimAtTarget(t))) {
            plog(`0x${t}: ATSH rejected — cannot DID-sweep`);
            continue;
          }
          await sendCommand('ATST19', PROBE_TIMEOUT); // fast fail on dead DIDs
          await sleep(60);
          lastTP = 0;
          await keepAlive(); // 3E00 (also a default-session tester-present)
          if (BODY_SWEEP_DID_EXTENDED_SESSION) {
            const sess = await sendCommand('1003', PROBE_TIMEOUT);
            plog(`0x${t} → 10 03 (extended session)  ← "${escapeRaw(sess)}"${nrcNote(sess)}`);
          }
          for (let i = 0; i < dids.length; i++) {
            const did = dids[i];
            await keepAlive();
            const first = await readDid(did, PROBE_TIMEOUT);
            if (first.bytes) {
              // Positive — read again to tell a live value from a constant.
              await sleep(120);
              const second = await readDid(did, PROBE_TIMEOUT);
              const constant = payloadsEqual(first.bytes, second.bytes);
              // A varying, multi-byte payload is the pressure-shaped signal.
              const pressureHint = !constant && first.bytes.length >= 4 ? '  (multi-byte — check for 4 tires)' : '';
              const tag = constant ? '[CONSTANT? — suspect, a response is not a value]' : `[VARYING — candidate]${pressureHint}`;
              hits.push(did);
              plog(`0x${t} DID ${did} POSITIVE  ← "${escapeRaw(first.raw)}"  bytes=[${hexBytes(first.bytes)}]  ${tag}`);
            } else {
              const kind = classifyResponse(first.raw, did);
              if (kind === 'nrc' && nrcCode(first.raw) === '31') {
                // NRC 31 is the expected "not supported" — don't log each, too noisy.
              } else if (kind !== 'no-data' && kind !== 'empty') {
                plog(`0x${t} DID ${did} ${kind.toUpperCase()}  ← "${escapeRaw(first.raw)}"${nrcNote(first.raw)}`);
              }
            }
            // Heartbeat every 128 DIDs so an all-NRC-31 stretch can't look frozen.
            if ((i & 0x7f) === 0x7f) {
              plog(`...swept ${i + 1}/${dids.length} on 0x${t} (through ${did}), ${hits.length} positive(s)`);
            }
          }
          if (BODY_SWEEP_DID_EXTENDED_SESSION) {
            try { await sendCommand('1001', PROBE_TIMEOUT); } catch {} // back to default session
          }
          try { await sendCommand('ATST7D', PROBE_TIMEOUT); } catch {}
        } catch (e: any) {
          plog(`DID SWEEP 0x${t} ERROR: ${e.message}`);
        } finally {
          await resetHeader();
        }
        plog(`DID SWEEP POSITIVES on 0x${t}: [${hits.join(', ') || 'none'}]`);
      }
    } else {
      plog('Phase 3: DID sweep skipped (set BODY_SWEEP_DID_TARGETS to enable).');
    }

    plog('================ SUMMARY ================');
    plog(`Responders: [${responders.map((r) => '0x' + r).join(', ') || 'none'}]`);
    const fresh = responders.filter((r) => !KNOWN_LIVE_TARGETS.includes(r));
    plog(`New (not in prior powertrain census): [${fresh.map((r) => '0x' + r).join(', ') || 'none'}]`);
    plog('Next: a VARYING multi-byte DID is the pressure-shaped signal. Ground-truth with the 30/40/50/60 method (vault: TPMS Hunt) — set four distinct known pressures and confirm four candidate values track them.');
    plog('================ BODY SWEEP END ================');
  } finally {
    // The sweep changed the header, receive filter, and ST timeout — wipe it all
    // deterministically with a full re-init, exactly like the 948TE probe.
    plog('Restoring adapter via full re-init (ATZ + standard init)...');
    try {
      await initializeAdapter();
      plog('Adapter re-init complete');
    } catch (e: any) {
      plog(`Adapter re-init FAILED: ${e.message} — power-cycle the adapter if gauges stay dead`);
    }
    sweepInProgress = false;
  }
}
