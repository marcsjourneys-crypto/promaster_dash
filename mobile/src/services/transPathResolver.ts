/**
 * Transmission path resolver — picks 62TE vs 948TE per vehicle.
 *
 * Modes (settings.transMode, default 'auto'):
 *   'auto'  — probe 62TE first (the proven path), then 948TE. The winner is
 *             latched in AsyncStorage so subsequent launches skip re-probing
 *             the other path. A latched path that later fails its probe clears
 *             the latch and re-resolves.
 *   '62TE' / '948TE' — force that path, no latch reads or writes.
 *
 * If no path answers, the provider is left null: transF stays null and the
 * gauge shows its existing '--' unavailable state. No loud errors.
 *
 * TODO(auto-order): on a 2022+ van the 62TE scan's "PCM 29-bit B010" entry
 * (18DA10F1 + 22B010, ÷64 two-byte — literally 948TE candidate #2) will very
 * likely answer, so auto latches '62TE' on a 9-speed van but reads correct
 * temps; only the label is wrong. Probe mode and the manual 9-speed setting
 * are the correction paths. Consider preferring 948TE first in auto order
 * once a promoted 948TE candidate exists and is validated. Second wrinkle: if
 * a 2022+ van negotiates 11-bit (protocol 6), the 62TE scan's width guard
 * only tries 7E0/7E1 — the probe sweep's candidate #3 tests exactly that.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TransTempProvider, TransPathId } from './transTempProvider';
import { setTransProvider, startPolling, stopPolling } from './obdService';
import { provider62TE } from './provider62TE';
import { provider948TE } from './provider948TE';
import { isConnected } from './obdTransport';
import { loadSettings, type TransMode } from '../config/settings';
import { dlog } from './debugLog';

const TRANS_PATH_KEY = '@promaster/transPath';

/** Latch a resolved path so later launches skip probing the other one. */
export async function latchTransPath(id: TransPathId): Promise<void> {
  try {
    await AsyncStorage.setItem(TRANS_PATH_KEY, id);
  } catch {}
}

/** Clear the latched path (e.g. when transMode changes). */
export async function clearTransPathLatch(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRANS_PATH_KEY);
  } catch {}
}

async function loadLatchedPath(): Promise<TransPathId | null> {
  try {
    const v = await AsyncStorage.getItem(TRANS_PATH_KEY);
    return v === '62TE' || v === '948TE' ? v : null;
  } catch {
    return null;
  }
}

function providerFor(id: TransPathId): TransTempProvider {
  return id === '62TE' ? provider62TE : provider948TE;
}

/**
 * Resolve the transmission path and install the winning provider into
 * obdService. Call after initializeAdapter() succeeds, before startPolling().
 * Returns the resolved provider, or null if no path answered.
 */
export async function resolveTransPath(
  modeOverride?: TransMode,
): Promise<TransTempProvider | null> {
  const mode = modeOverride ?? (await loadSettings()).transMode;

  let order: TransTempProvider[];
  if (mode === '62TE' || mode === '948TE') {
    dlog(`TransPath: mode=${mode} (manual) — forcing path`);
    order = [providerFor(mode)];
  } else {
    const latched = await loadLatchedPath();
    if (latched) {
      dlog(`TransPath: mode=auto, latched=${latched} — probing latched path first`);
      const p = providerFor(latched);
      if (await p.probe()) {
        setTransProvider(p);
        dlog(`TransPath: resolved → ${p.id} (latched)`);
        return p;
      }
      dlog(`TransPath: latched ${latched} failed probe — clearing latch, re-resolving`);
      await clearTransPathLatch();
    }
    order = [provider62TE, provider948TE];
  }

  for (const p of order) {
    dlog(`TransPath: probing ${p.id}...`);
    if (await p.probe()) {
      setTransProvider(p);
      if (mode === 'auto') await latchTransPath(p.id);
      dlog(`TransPath: resolved → ${p.id}`);
      return p;
    }
  }

  setTransProvider(null);
  dlog('TransPath: no transmission path answered — trans gauge unavailable');
  return null;
}

/**
 * Handle a transMode settings change: clear the latch (per-path candidate
 * knowledge in @promaster/transCandidate / @promaster/trans948Candidate is
 * kept) and re-resolve now if connected, else on next connect.
 */
export async function applyTransModeChange(mode: TransMode): Promise<void> {
  await clearTransPathLatch();
  if (!isConnected()) return;
  stopPolling();
  try {
    await resolveTransPath(mode);
  } finally {
    startPolling();
  }
}
