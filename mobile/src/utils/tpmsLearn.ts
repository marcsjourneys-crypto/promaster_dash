/**
 * Deflate-to-identify: which sensor is on this corner?
 *
 * The user picks a corner and lets a few psi out of that tire. A Schrader
 * sensor transmits straight away on a pressure drop, so the sensor whose
 * reading falls from its baseline is the one on that wheel.
 *
 * Pure and snapshot-based: `evaluateLearn` takes the whole readings map and
 * is safe to call on every store update.
 */

import type { TirePosition } from '../config/tpmsConfig';
import type { TpmsReading } from '../services/tpmsProtocol';

/** A drop this large is deliberate, not temperature drift or 1-count jitter. */
export const LEARN_DROP_PSI = 2;
export const LEARN_TIMEOUT_MS = 3 * 60 * 1000;

export type LearnPhase = 'waiting' | 'proposed' | 'timeout';

export interface LearnState {
  corner: TirePosition;
  startedAt: number;
  /** psi per sensor at the start, or at its first sighting after the start. */
  baselines: Record<string, number>;
  phase: LearnPhase;
  proposedId: string | null;
  dropPsi: number | null;
}

export function startLearn(
  corner: TirePosition,
  readings: Record<string, TpmsReading>,
  nowMs: number,
): LearnState {
  const baselines: Record<string, number> = {};
  for (const r of Object.values(readings)) baselines[r.id] = r.psi;
  return { corner, startedAt: nowMs, baselines, phase: 'waiting', proposedId: null, dropPsi: null };
}

export function evaluateLearn(
  state: LearnState,
  readings: Record<string, TpmsReading>,
  nowMs: number,
): LearnState {
  if (state.phase !== 'waiting') return state;
  if (nowMs - state.startedAt > LEARN_TIMEOUT_MS) return { ...state, phase: 'timeout' };

  let baselines = state.baselines;
  let best: { id: string; drop: number } | null = null;

  for (const r of Object.values(readings)) {
    // Cache replays and anything heard before the wizard started carry no
    // information about what the user is doing now.
    if (r.cached || r.ts < state.startedAt) continue;
    const base = baselines[r.id];
    if (base === undefined) {
      baselines = { ...baselines, [r.id]: r.psi };
      continue;
    }
    const drop = base - r.psi;
    if (drop >= LEARN_DROP_PSI && (!best || drop > best.drop)) best = { id: r.id, drop };
  }

  if (best) {
    return { ...state, baselines, phase: 'proposed', proposedId: best.id, dropPsi: best.drop };
  }
  return baselines === state.baselines ? state : { ...state, baselines };
}
