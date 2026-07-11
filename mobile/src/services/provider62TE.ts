/**
 * 62TE (6-speed, 2014–2021 ProMaster) transmission temp provider.
 *
 * Pure wrapper around the shipping 62TE path: probe() is the connect-time
 * candidate load/auto-scan block moved verbatim from BLEScreen.handleConnect,
 * and read() delegates to obdService.pollTransTemp() — the polling body did
 * not move. Zero behavior change to the 62TE command sequences.
 */

import type { TransTempProvider } from './transTempProvider';
import {
  pollTransTemp,
  setTransCandidate,
  getTransCandidate,
  saveTransCandidate,
  loadTransCandidate,
  clearTransCandidate,
  getLockedProtocol,
} from './obdService';
import { scanCandidates, selectBestCandidate, type ScanResult } from './transTempCandidates';
import { dlog } from './debugLog';

// Most recent connect-time scan result, kept so the BLE screen can still show
// the 29-bit capability banner (previously set inline in handleConnect).
let lastScan: ScanResult | null = null;

/** Scan metadata from the last connect-time auto-scan (null if none ran). */
export function getLast62ScanResult(): ScanResult | null {
  return lastScan;
}

async function probe62TE(): Promise<boolean> {
  // Load saved trans candidate or auto-scan for one
  const saved = await loadTransCandidate();
  if (saved && saved.twoByteMode === false) {
    dlog('Trans: Clearing stale candidate (twoByteMode was false, needs re-scan)');
    await clearTransCandidate();
    setTransCandidate(null);
  } else if (saved) {
    setTransCandidate(saved);
    dlog(`Trans: Using saved candidate "${saved.name}"`);
  }
  if (!saved || saved.twoByteMode === false) {
    dlog('Trans: No saved candidate — scanning...');
    try {
      const scan = await scanCandidates(getLockedProtocol());
      lastScan = scan;
      const best = selectBestCandidate(scan.results);
      if (best) {
        setTransCandidate(best);
        await saveTransCandidate(best);
        dlog(`Trans: Auto-found "${best.name}" (DID ${best.did})`);
      } else {
        dlog('Trans: Auto-scan found no valid candidates');
      }
    } catch (e: any) {
      dlog(`Trans: Auto-scan error: ${e.message}`);
    }
  }
  return getTransCandidate() !== null;
}

export const provider62TE: TransTempProvider = {
  id: '62TE',
  probe: probe62TE,
  read: () => pollTransTemp(),
};
