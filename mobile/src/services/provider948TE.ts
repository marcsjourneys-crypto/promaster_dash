/**
 * 948TE (9-speed, 2022+ ProMaster) transmission temp provider.
 *
 * Candidate paths are defined here (permanent home — the diagnostic probe
 * sweep in trans948Probe.ts imports them and is removable independently).
 * PROMOTED_948_CANDIDATES ships empty: until a candidate is validated on a
 * real 2022+ van via probe mode, probe948TE() answers false with zero bus
 * traffic and the resolver falls through to the unavailable state.
 *
 * Promotion after parking-lot validation: add the winning candidate to
 * PROMOTED_948_CANDIDATES. probe948TE() then live-verifies it at connect and
 * persists it to @promaster/trans948Candidate (verify-or-accept on later
 * connects — the same pattern as the 62TE @promaster/transCandidate).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TransTempProvider } from './transTempProvider';
import { sendCommand } from './obdTransport';
import { parseMode22, transTempToF } from './obdParser';
import { getLockedProtocol, getBroadcastHeader } from './obdService';
import { useVehicleStore } from '../store/vehicleStore';
import { dlog } from './debugLog';

export type Decode948 = 'div64' | 'offset40';

export interface Candidate948 {
  name: string;
  /** Exact AT commands sent in order before the request (split ATCP+3-byte
   *  form — the clone-safe variant, and exactly what goes on the wire). */
  setup: string[];
  request: string; // '22' + DID
  did: string;     // for parseMode22 marker matching
  decode: Decode948;
  minBytes: number; // 2 for div64, 1 for offset40
}

/**
 * 948TE candidates, in sweep order (highest probability first).
 * Sources:
 *  #1 TCM 0x18 DID 08DF, °F = A×1.8−40 — ScanGauge's official Cherokee KL /
 *     Renegade XGauge (18F12208DF, same 948TE trans), matches a promasterforum
 *     OBDLink user-defined PID for the 2022+ PM built with Linear Logic
 *     support; ScanGauge 3 autoscan confirmed reading trans temp on 2022/2025
 *     ProMasters, so this path is known to pass the Secure Gateway.
 *  #2 same DID at the ECM (0x10) in case the 2022+ ECM mirrors it.
 *  #3/#4 legacy 62TE ECM paths (confirmed 2017–2021 PMs only) as fallbacks.
 *  #5 classic FCA 11-bit TCM — longshot, covers an 11-bit-negotiated van.
 */
export const CANDIDATES_948: Candidate948[] = [
  {
    name: '948TE #1: TCM 0x18 DID 08DF (29-bit, ScanGauge KL/Renegade)',
    setup: ['ATSP7', 'ATCP18', 'ATSHDA18F1', 'ATCRA18DAF118'],
    request: '2208DF',
    did: '08DF',
    decode: 'offset40',
    minBytes: 1,
  },
  {
    name: '948TE #2: ECM 0x10 DID 08DF (29-bit, mirror fallback)',
    setup: ['ATSP7', 'ATCP18', 'ATSHDA10F1', 'ATCRA18DAF110', 'ATFCSHDA10F1'],
    request: '2208DF',
    did: '08DF',
    decode: 'offset40',
    minBytes: 1,
  },
  {
    name: '948TE #3: ECM 0x10 DID 9110 (29-bit, legacy 62TE path)',
    setup: ['ATSP7', 'ATCP18', 'ATSHDA10F1', 'ATCRA18DAF110', 'ATFCSHDA10F1'],
    request: '229110',
    did: '9110',
    decode: 'div64',
    minBytes: 2,
  },
  {
    name: '948TE #4: ECM 0x10 DID B010 (29-bit, legacy 62TE path)',
    setup: ['ATSP7', 'ATCP18', 'ATSHDA10F1', 'ATCRA18DAF110', 'ATFCSHDA10F1'],
    request: '22B010',
    did: 'B010',
    decode: 'div64',
    minBytes: 2,
  },
  {
    name: '948TE #5: TCM 7E1 DID B010 (11-bit classic FCA, longshot)',
    setup: ['ATSP6', 'ATSH7E1', 'ATCRA7E9'],
    request: '22B010',
    did: 'B010',
    decode: 'div64',
    minBytes: 2,
  },
];

/**
 * Candidates validated on a real 2022+ van, tried by probe948TE() at connect.
 * SHIPS EMPTY — promote the winner from a [948TE-PROBE] sweep here.
 */
export const PROMOTED_948_CANDIDATES: Candidate948[] = [];

/** Decode a Mode 22 positive-response payload for a 948TE candidate.
 *  div64: (A·256+B)/64 = °F.  offset40: °C = A−40 → °F = A×1.8−40 (the
 *  transTempToF single-byte fallback is exactly this formula). */
export function decode948(bytes: number[], decode: Decode948): number {
  return transTempToF(bytes, decode === 'div64');
}

// ---------------------------------------------------------------------------
// Persistence (mirrors the 62TE @promaster/transCandidate pattern)
// ---------------------------------------------------------------------------

const TRANS_948_CANDIDATE_KEY = '@promaster/trans948Candidate';

export async function save948Candidate(candidate: Candidate948): Promise<void> {
  try {
    await AsyncStorage.setItem(TRANS_948_CANDIDATE_KEY, JSON.stringify(candidate));
    dlog(`Trans948: Saved candidate "${candidate.name}" to storage`);
  } catch (e: any) {
    dlog(`Trans948: Failed to save candidate: ${e.message}`);
  }
}

export async function clear948Candidate(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRANS_948_CANDIDATE_KEY);
    dlog('Trans948: Cleared saved candidate from storage');
  } catch (e: any) {
    dlog(`Trans948: Failed to clear candidate: ${e.message}`);
  }
}

export async function load948Candidate(): Promise<Candidate948 | null> {
  try {
    const raw = await AsyncStorage.getItem(TRANS_948_CANDIDATE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Candidate948;
    dlog(`Trans948: Loaded saved candidate "${c.name}" from storage`);
    return c;
  } catch (e: any) {
    dlog(`Trans948: Failed to load candidate from storage: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live read cycle
// ---------------------------------------------------------------------------

// Active candidate for this connection (set by a successful probe)
let active948: Candidate948 | null = null;

let skip948LogCount = 0;

/**
 * One full read cycle for a candidate: AT setup → tester-present → request →
 * decode → range gate. Adapter teardown ALWAYS runs (the setup mutates
 * protocol/receive-filter state the rest of the app never touches).
 *
 * TODO(perf): skip the ATSPn command when it matches getLockedProtocol() to
 * avoid per-poll protocol renegotiation — decide after probe results show
 * whether the winning candidate's protocol matches the van's locked protocol.
 */
async function readCycle(c: Candidate948): Promise<number | null> {
  let protocolChanged = false;
  try {
    for (const at of c.setup) {
      const r = await sendCommand(at, 1500);
      if (at.startsWith('ATSP')) protocolChanged = true;
      if (r.includes('?')) {
        // Some clones lack ATCRA/ATFCSH — a rejected setup command means this
        // cycle can't be trusted; bail to teardown.
        dlog(`Trans948: read aborted — adapter rejected ${at}`);
        return null;
      }
    }
    await sleep(100); // Let adapter reconfigure CAN filter

    // Tester-present wakeup — FCA modules go quiet without it. 3E00 = valid
    // sub-function (respond); 3E01 is invalid and draws 7F3E12 (2022 van log).
    await sendCommand('3E00', 1500);

    const resp = await sendCommand(c.request, 2500);
    dlog(`Trans948: raw: "${resp}"`);
    const bytes = parseMode22(resp, c.did);

    if (bytes && bytes.length >= c.minBytes) {
      const tempF = decode948(bytes, c.decode);
      dlog(`Trans948: = ${tempF.toFixed(1)}°F`);
      if (tempF >= -40 && tempF <= 400) {
        useVehicleStore.getState().updateOBD({ transF: tempF });
        return tempF;
      }
    } else {
      dlog(`Trans948: parse FAILED for raw: "${resp}"`);
    }
    return null;
  } finally {
    // Restore adapter state: clear receive filter, restore locked protocol if
    // we changed it, return to the functional broadcast header, flush.
    try {
      await sendCommand('ATCRA', 1500);
      if (protocolChanged) {
        await sendCommand(`ATSP${getLockedProtocol()}`, 2000);
      }
      await sendCommand(`ATSH${getBroadcastHeader()}`, 1500);
      await sendCommand('ATAR', 1500);
    } catch {}
  }
}

async function probe948TE(): Promise<boolean> {
  active948 = null;

  // 1. Saved candidate → verify-or-accept
  const saved = await load948Candidate();
  if (saved) {
    dlog(`Trans948: Verifying saved candidate "${saved.name}"...`);
    const temp = await readCycle(saved);
    if (temp !== null) {
      active948 = saved;
      dlog(`Trans948: Saved candidate verified (${temp.toFixed(1)}°F)`);
      return true;
    }
    dlog('Trans948: Saved candidate failed verification — clearing');
    await clear948Candidate();
  }

  // 2. Promoted candidates (ships empty — zero bus traffic until promotion)
  for (const c of PROMOTED_948_CANDIDATES) {
    dlog(`Trans948: Probing promoted candidate "${c.name}"...`);
    const temp = await readCycle(c);
    if (temp !== null) {
      active948 = c;
      await save948Candidate(c);
      dlog(`Trans948: Promoted candidate answered (${temp.toFixed(1)}°F)`);
      return true;
    }
  }

  return false;
}

async function read948TE(): Promise<number | null> {
  if (!active948) {
    skip948LogCount++;
    if (skip948LogCount <= 3 || skip948LogCount % 10 === 0) {
      dlog(`Trans948: SKIPPED — no active candidate (skip #${skip948LogCount})`);
    }
    return null;
  }
  return readCycle(active948);
}

export const provider948TE: TransTempProvider = {
  id: '948TE',
  probe: probe948TE,
  read: read948TE,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
