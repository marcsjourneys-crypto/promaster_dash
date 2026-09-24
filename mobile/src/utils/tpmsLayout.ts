/**
 * Resolve TPMS readings onto the four wheel positions and classify each tire.
 *
 * Pure. Used by the TPMS screen for colours and by the store for alerts, so
 * the two can never disagree about what counts as low.
 */

import {
  TIRE_POSITIONS,
  sensorAt,
  targetPsi,
  type TirePosition,
  type TpmsConfig,
} from '../config/tpmsConfig';
import type { TpmsReading, TpmsReceiverStatus } from '../services/tpmsProtocol';

/** Pressure verdict. `hot` only applies when the pressure itself is fine. */
export type TireStatus = 'ok' | 'lowWarn' | 'lowCrit' | 'high' | 'hot' | 'noData';

/**
 * Sensors go quiet when the van is parked, so an old reading is normal —
 * it is shown dimmed, not hidden. Twenty minutes covers any drive pause
 * while making a parked van's numbers obviously not live.
 */
export const STALE_MS = 20 * 60 * 1000;

export interface TireView {
  position: TirePosition;
  sensorId: string | null;
  reading: TpmsReading | null;
  targetPsi: number;
  status: TireStatus;
  stale: boolean;
  ageMs: number | null;
}

export interface ResolvedTires {
  tires: Record<TirePosition, TireView>;
  /** Readings from sensors that are not on any wheel yet. */
  unassigned: TpmsReading[];
}

export function tireStatus(
  reading: TpmsReading | null,
  target: number,
  config: TpmsConfig,
): TireStatus {
  if (!reading) return 'noData';
  const { psi } = reading;
  if (psi <= target * (1 - config.lowCritPct / 100)) return 'lowCrit';
  if (psi <= target * (1 - config.lowWarnPct / 100)) return 'lowWarn';
  if (psi >= target * (1 + config.highWarnPct / 100)) return 'high';
  if (reading.tempF >= config.tempWarnF) return 'hot';
  return 'ok';
}

export function resolveTires(
  config: TpmsConfig,
  readings: Record<string, TpmsReading>,
  nowMs: number,
): ResolvedTires {
  const tires = {} as Record<TirePosition, TireView>;
  for (const position of TIRE_POSITIONS) {
    const sensorId = sensorAt(config, position);
    const reading = sensorId ? readings[sensorId] ?? null : null;
    const target = targetPsi(config, position);
    const ageMs = reading ? Math.max(0, nowMs - reading.ts) : null;
    tires[position] = {
      position,
      sensorId,
      reading,
      targetPsi: target,
      status: tireStatus(reading, target, config),
      stale: ageMs !== null && ageMs > STALE_MS,
      ageMs,
    };
  }
  const placed = new Set(config.sensors.filter((s) => s.position).map((s) => s.id));
  const unassigned = Object.values(readings)
    .filter((r) => !placed.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { tires, unassigned };
}

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface ReceiverHealth {
  text: string;
  tone: HealthTone;
}

/**
 * One line answering "is the receiver hearing anything?" for the TPMS screen.
 * `warn` is the case the first van test hit: bursts arrive but none decode.
 */
export function receiverHealth(status: TpmsReceiverStatus | null, connected: boolean): ReceiverHealth {
  if (!connected) return { text: 'Receiver not connected', tone: 'muted' };
  const radio = status?.radio;
  if (!radio) return { text: 'Receiver connected (update its firmware for radio stats)', tone: 'muted' };
  if (radio.edgesPerSec === 0) {
    return { text: 'RX silent: 0 edges/s. Check the RX470C wiring', tone: 'bad' };
  }
  const last = radio.lastBurstAgeS === null ? 'none yet' : `last ${formatAge(radio.lastBurstAgeS * 1000)} ago`;
  const text =
    `RX ${radio.edgesPerSec} edges/s · ${radio.bursts} burst${radio.bursts === 1 ? '' : 's'}` +
    ` · ${radio.burstsDecoded} decoded · ${last}`;
  if (radio.bursts > 0 && radio.burstsDecoded === 0) return { text, tone: 'warn' };
  return { text, tone: 'ok' };
}

/** "now", "45s", "12m", "3h", "2d" */
export function formatAge(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
