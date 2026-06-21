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
  notes: string;
}

/** Candidate list for ProMaster 62TE transmission temp. */
export const CANDIDATES: TransTempCandidate[] = [
  // Prefer 11-bit to avoid 29-bit/11-bit protocol switching issues
  {
    name: 'PCM 11-bit B010',
    header: '7E0',
    did: 'B010',
    twoByteMode: true,
    notes: 'Standard 11-bit CAN — preferred (avoids header switching)',
  },
  {
    name: 'PCM 29-bit B010',
    header: '18DA10F1',
    did: 'B010',
    twoByteMode: true,
    notes: 'PCM via 29-bit extended CAN',
  },
  {
    name: 'TCM 29-bit B010',
    header: '18DA18F1',
    did: 'B010',
    twoByteMode: true,
    notes: 'TCM via 29-bit extended CAN',
  },
  {
    name: 'TCM 29-bit 9110',
    header: '18DA18F1',
    did: '9110',
    twoByteMode: true,
    notes: 'Alternate TCM DID — confirmed via Linear Logic ScanGauge code',
  },
  {
    name: 'PCM 29-bit 1C44',
    header: '18DA10F1',
    did: '1C44',
    twoByteMode: true,
    notes: 'PCM alternate DID, two-byte',
  },
  {
    name: 'PCM 11-bit 08DF',
    header: '7E0',
    did: '08DF',
    twoByteMode: true,
    notes: 'Standard 11-bit, two-byte',
  },
];

export interface CandidateResult {
  candidate: TransTempCandidate;
  tempF: number | null;
  success: boolean;
  rawResponse: string;
}

/**
 * Scan all candidates and return results.
 * Must be called when BLE is connected and adapter is initialized.
 */
export async function scanCandidates(restoreProtocol = '0'): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];

  for (const candidate of CANDIDATES) {
    try {
      dlog(`Trans scan: Trying "${candidate.name}" (ATSH${candidate.header}, 22${candidate.did})...`);
      // Set CAN header
      await sendCommand(`ATSH${candidate.header}`, 2000);
      // Longer delay for generic ELM327 clones that are slow to process ATSH
      await sleep(200);

      // Request Mode 22 read
      const raw = await sendCommand(`22${candidate.did}`, 3000);

      const bytes = parseMode22(raw, candidate.did);
      let tempF: number | null = null;
      let success = false;

      if (bytes && bytes.length >= 1) {
        tempF = transTempToF(bytes, candidate.twoByteMode);
        // Sanity check: -40°F to 400°F
        success = tempF >= -40 && tempF <= 400;
      }

      dlog(`Trans scan: "${candidate.name}" → raw="${raw}", tempF=${tempF?.toFixed(1) ?? 'null'}, success=${success}`);
      results.push({ candidate, tempF, success, rawResponse: raw });
    } catch (e: any) {
      dlog(`Trans scan: "${candidate.name}" → ERROR: ${e.message}`);
      results.push({
        candidate,
        tempF: null,
        success: false,
        rawResponse: e.message ?? 'Error',
      });
    }
  }

  // Reset header and restore the detected protocol.
  // Using ATSP<N> (specific) instead of ATSP0 (auto) avoids a full re-negotiation
  // that can fail when 29-bit ATSH commands have left the adapter in a dirty state.
  // restoreProtocol comes from ATDPN captured during adapter init in obdService.
  try {
    await sendCommand('ATSH7DF', 2000);
    await sendCommand(`ATSP${restoreProtocol}`, 2000);
    await sendCommand('ATAR', 2000);
  } catch {}

  return results;
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
