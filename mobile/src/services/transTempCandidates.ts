/**
 * Transmission temperature candidate DIDs for 2014 Ram ProMaster 62TE.
 * Used during discovery to find which DID + header returns valid trans temp.
 */

import { sendCommand } from './obdTransport';
import { parseMode22, transTempToF } from './obdParser';
import { dlog } from './debugLog';

export interface TransTempCandidate {
  name: string;
  header: string;       // CAN header (e.g., '18DA10F1' for 29-bit)
  did: string;          // DID hex (e.g., 'B010')
  twoByteMode: boolean; // Whether temp is 2-byte or 1-byte
  is29bit: boolean;     // Requires 29-bit CAN — skipped on adapters that return '?' for ATSH18DA...
  notes: string;
}

/**
 * Candidates for ProMaster 62TE transmission temp.
 * 11-bit entries run first so adapters that lack 29-bit support still get a shot.
 * 29-bit entries are probed and skipped automatically if the adapter rejects them.
 */
export const CANDIDATES: TransTempCandidate[] = [
  {
    name: 'PCM 11-bit B010',
    header: '7E0',
    did: 'B010',
    twoByteMode: true,
    is29bit: false,
    notes: 'PCM via standard 11-bit CAN',
  },
  {
    name: 'TCM 11-bit B010',
    header: '7E1',
    did: 'B010',
    twoByteMode: true,
    is29bit: false,
    notes: 'TCM via 11-bit CAN — common for 6-speed automatics',
  },
  {
    name: 'TCM 11-bit 9110',
    header: '7E1',
    did: '9110',
    twoByteMode: true,
    is29bit: false,
    notes: 'TCM alternate DID via 11-bit — confirmed via Linear Logic ScanGauge',
  },
  {
    name: 'PCM 11-bit 08DF',
    header: '7E0',
    did: '08DF',
    twoByteMode: true,
    is29bit: false,
    notes: 'PCM alternate DID via 11-bit',
  },
  {
    name: 'PCM 29-bit B010',
    header: '18DA10F1',
    did: 'B010',
    twoByteMode: true,
    is29bit: true,
    notes: 'PCM via 29-bit extended CAN — confirmed on 2014 ProMaster with VLinker MS',
  },
  {
    name: 'TCM 29-bit B010',
    header: '18DA18F1',
    did: 'B010',
    twoByteMode: true,
    is29bit: true,
    notes: 'TCM via 29-bit extended CAN',
  },
  {
    name: 'TCM 29-bit 9110',
    header: '18DA18F1',
    did: '9110',
    twoByteMode: true,
    is29bit: true,
    notes: 'TCM alternate DID via 29-bit — confirmed via Linear Logic ScanGauge',
  },
  {
    name: 'PCM 29-bit 1C44',
    header: '18DA10F1',
    did: '1C44',
    twoByteMode: true,
    is29bit: true,
    notes: 'PCM alternate DID via 29-bit, two-byte',
  },
];

export interface CandidateResult {
  candidate: TransTempCandidate;
  tempF: number | null;
  success: boolean;
  rawResponse: string;
  skipped?: boolean; // true when adapter lacked 29-bit CAN support — not a failure
}

export interface ScanResult {
  results: CandidateResult[];
  supports29bit: boolean; // false = adapter returned '?' on ATSH18DA10F1
}

/**
 * Scan candidates and return results with adapter 29-bit capability info.
 *
 * Probes 29-bit support once up front. If the adapter returns '?' for
 * ATSH18DA10F1, all 29-bit candidates are skipped — sending Mode 22 DIDs
 * to an adapter that rejected the header corrupts its state and breaks
 * subsequent standard Mode 01 polling.
 *
 * restoreProtocol comes from ATDPN captured during adapter init (obdService),
 * so cleanup uses ATSP<N> instead of ATSP0 (auto), avoiding full re-negotiation.
 */
export async function scanCandidates(restoreProtocol = '0'): Promise<ScanResult> {
  const results: CandidateResult[] = [];

  // Probe 29-bit CAN support. Cheap ELM327 clones return '?' here.
  dlog('Trans scan: Probing 29-bit CAN support (ATSH18DA10F1)...');
  const probeResp = await sendCommand('ATSH18DA10F1', 2000);
  const supports29bit = !probeResp.includes('?');
  dlog(
    supports29bit
      ? 'Trans scan: 29-bit CAN SUPPORTED'
      : 'Trans scan: 29-bit CAN NOT SUPPORTED — adapter returned "?" — 29-bit candidates will be skipped',
  );
  // Reset header after probe regardless of outcome
  await sendCommand('ATSH7DF', 1000);

  for (const candidate of CANDIDATES) {
    // Skip 29-bit candidates on adapters that can't handle them
    if (candidate.is29bit && !supports29bit) {
      dlog(`Trans scan: SKIP "${candidate.name}" — adapter lacks 29-bit CAN`);
      results.push({ candidate, tempF: null, success: false, rawResponse: '—', skipped: true });
      continue;
    }

    try {
      dlog(`Trans scan: Trying "${candidate.name}" (ATSH${candidate.header}, 22${candidate.did})...`);

      const shResp = await sendCommand(`ATSH${candidate.header}`, 2000);
      if (shResp.includes('?')) {
        // Shouldn't happen for 11-bit (7E0/7E1) but guard anyway
        dlog(`Trans scan: SKIP "${candidate.name}" — ATSH${candidate.header} rejected`);
        results.push({ candidate, tempF: null, success: false, rawResponse: shResp, skipped: true });
        continue;
      }
      await sleep(200);

      const raw = await sendCommand(`22${candidate.did}`, 3000);
      const bytes = parseMode22(raw, candidate.did);
      let tempF: number | null = null;
      let success = false;

      if (bytes && bytes.length >= 1) {
        tempF = transTempToF(bytes, candidate.twoByteMode);
        success = tempF >= -40 && tempF <= 400;
      }

      dlog(`Trans scan: "${candidate.name}" → raw="${raw}", tempF=${tempF?.toFixed(1) ?? 'null'}, success=${success}`);
      results.push({ candidate, tempF, success, rawResponse: raw });
    } catch (e: any) {
      dlog(`Trans scan: "${candidate.name}" → ERROR: ${e.message}`);
      results.push({ candidate, tempF: null, success: false, rawResponse: e.message ?? 'Error' });
    }
  }

  // Restore known-good protocol (not ATSP0/auto) to avoid full re-negotiation
  try {
    await sendCommand('ATSH7DF', 2000);
    await sendCommand(`ATSP${restoreProtocol}`, 2000);
    await sendCommand('ATAR', 2000);
  } catch {}

  return { results, supports29bit };
}

/** Select the first working candidate from scan results. */
export function selectBestCandidate(
  results: CandidateResult[],
): TransTempCandidate | null {
  const working = results.filter((r) => r.success);
  return working.length > 0 ? working[0].candidate : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
