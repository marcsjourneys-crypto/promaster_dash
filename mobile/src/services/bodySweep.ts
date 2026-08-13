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

import { sendCommand, sendAtsh } from './obdTransport';
import { parseMode22 } from './obdParser';
import { getBroadcastHeader, initializeAdapter } from './obdService';
import { dlog } from './debugLog';
import {
  BODY_SWEEP_TARGETS,
  KNOWN_LIVE_TARGETS,
  FINGERPRINT_DIDS,
  BODY_SWEEP_DID_TARGET,
  BODY_SWEEP_DID_PAGES,
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

/** Flip to true to enable the BODY SWEEP button on the BLE screen.
 *  ENABLED for the v2.5.0 build 1 TestFlight build — TPMS discovery in the van.
 *  Set back to false before any App Store submission. */
export const BODY_SWEEP_MODE = true;

/** Per-command timeout during the fast address walk (ms). ATST19 keeps silent
 *  addresses failing quickly, so this only bounds the pathological case. */
const PROBE_TIMEOUT = 1200;
/** Timeout for the (possibly multi-frame) fingerprint reads. */
const FINGERPRINT_TIMEOUT = 3000;

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

/** Read one DID and return the raw string plus parsed payload. */
async function readDid(did: string, timeout: number): Promise<{ raw: string; bytes: number[] | null }> {
  const raw = await sendCommand(`22${did}`, timeout);
  return { raw, bytes: parseMode22(raw, did) };
}

/**
 * Full body-module sweep. Caller must stopPolling() first and startPolling()
 * after. Always leaves the adapter re-initialized (see finally).
 *
 * Phase 1: address sweep  — which 18DA<target>F1 answer 3E00.
 * Phase 2: fingerprint    — VIN / serial / SW version on each responder.
 * Phase 3: DID sweep      — optional, one configured address.
 */
export async function runBodySweep(): Promise<void> {
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

    // ---- Phase 3: optional DID sweep on one configured address ----
    if (BODY_SWEEP_DID_TARGET) {
      const t = normTarget(BODY_SWEEP_DID_TARGET);
      const dids = expandDidPages(BODY_SWEEP_DID_PAGES);
      plog(`---- Phase 3: DID sweep on 0x${t} (${dids.length} DIDs across pages [${BODY_SWEEP_DID_PAGES.join(', ')}]) ----`);
      const hits: string[] = [];
      try {
        if (!(await aimAtTarget(t))) {
          plog(`0x${t}: ATSH rejected — cannot DID-sweep`);
        } else {
          await sendCommand('ATST19', PROBE_TIMEOUT); // fast fail on dead DIDs
          await sleep(60);
          await sendCommand('3E00', PROBE_TIMEOUT);
          for (const did of dids) {
            const first = await readDid(did, PROBE_TIMEOUT);
            if (first.bytes) {
              // Positive — read again to tell a live value from a constant.
              await sleep(120);
              const second = await readDid(did, PROBE_TIMEOUT);
              const constant = payloadsEqual(first.bytes, second.bytes);
              const tag = constant ? '[CONSTANT? — suspect, a response is not a value]' : '[VARYING — candidate]';
              hits.push(did);
              plog(`DID ${did} POSITIVE  ← "${escapeRaw(first.raw)}"  bytes=[${hexBytes(first.bytes)}]  ${tag}`);
            } else {
              const kind = classifyResponse(first.raw, did);
              if (kind === 'nrc' && nrcCode(first.raw) === '31') {
                // NRC 31 is the expected "not supported" — don't log each, too noisy.
              } else if (kind !== 'no-data' && kind !== 'empty') {
                plog(`DID ${did} ${kind.toUpperCase()}  ← "${escapeRaw(first.raw)}"${nrcNote(first.raw)}`);
              }
            }
          }
          try { await sendCommand('ATST7D', PROBE_TIMEOUT); } catch {}
        }
      } catch (e: any) {
        plog(`DID SWEEP ERROR: ${e.message}`);
      } finally {
        await resetHeader();
      }
      plog(`DID SWEEP POSITIVES on 0x${t}: [${hits.join(', ') || 'none'}]`);
    } else {
      plog('Phase 3: DID sweep skipped (set BODY_SWEEP_DID_TARGET to a responder to enable).');
    }

    plog('================ SUMMARY ================');
    plog(`Responders: [${responders.map((r) => '0x' + r).join(', ') || 'none'}]`);
    const fresh = responders.filter((r) => !KNOWN_LIVE_TARGETS.includes(r));
    plog(`New (not in prior powertrain census): [${fresh.map((r) => '0x' + r).join(', ') || 'none'}]`);
    plog('Next: for a body/TPMS module, look for a responder returning a sane VIN (real module), then set BODY_SWEEP_DID_TARGET to it and re-run for the DID sweep. Ground-truth pressures with the 30/40/50/60 method (vault: TPMS Hunt).');
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
  }
}
