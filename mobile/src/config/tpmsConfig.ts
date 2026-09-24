/**
 * TPMS configuration model: which sensor IDs belong to the van, which wheel
 * each one is on, and the alert limits.
 *
 * Pure — persistence lives in tpmsConfigStorage.ts so the store and tests can
 * import this without AsyncStorage.
 */

export type TirePosition = 'LF' | 'RF' | 'LR' | 'RR';

export const TIRE_POSITIONS: TirePosition[] = ['LF', 'RF', 'LR', 'RR'];

export const POSITION_LABELS: Record<TirePosition, string> = {
  LF: 'Left Front',
  RF: 'Right Front',
  LR: 'Left Rear',
  RR: 'Right Rear',
};

export interface TpmsSensor {
  id: string;
  position: TirePosition | null;
}

export interface TpmsConfig {
  /** BLE id of the paired PM-TPMS receiver. */
  receiverId: string | null;
  receiverName: string | null;
  sensors: TpmsSensor[];
  /** Cold targets from the door placard (psi). */
  frontTargetPsi: number;
  rearTargetPsi: number;
  /** Percent below target that warns / goes critical. 25% matches FMVSS 138. */
  lowWarnPct: number;
  lowCritPct: number;
  /** Percent above target that warns. */
  highWarnPct: number;
  tempWarnF: number;
}

/** Heard by the RTL-SDR on 2026-09-21; wheel positions not yet known. */
export const CAPTURED_SENSOR_IDS = ['05E671A', '05E670D', '00FA4D3', '00FBFF7'];

export const DEFAULT_TPMS_CONFIG: TpmsConfig = {
  receiverId: null,
  receiverName: null,
  sensors: CAPTURED_SENSOR_IDS.map((id) => ({ id, position: null })),
  frontTargetPsi: 65,
  rearTargetPsi: 65,
  lowWarnPct: 10,
  lowCritPct: 25,
  highWarnPct: 20,
  tempWarnF: 170,
};

export function targetPsi(config: TpmsConfig, position: TirePosition): number {
  return position === 'LF' || position === 'RF' ? config.frontTargetPsi : config.rearTargetPsi;
}

/** Put `id` on `position`. Whoever held that position is unassigned. */
export function assignPosition(config: TpmsConfig, id: string, position: TirePosition): TpmsConfig {
  const known = config.sensors.some((s) => s.id === id);
  const sensors = (known ? config.sensors : [...config.sensors, { id, position: null }]).map((s) => {
    if (s.id === id) return { ...s, position };
    if (s.position === position) return { ...s, position: null };
    return s;
  });
  return { ...config, sensors };
}

export function addSensor(config: TpmsConfig, id: string): TpmsConfig {
  if (config.sensors.some((s) => s.id === id)) return config;
  return { ...config, sensors: [...config.sensors, { id, position: null }] };
}

export function removeSensor(config: TpmsConfig, id: string): TpmsConfig {
  return { ...config, sensors: config.sensors.filter((s) => s.id !== id) };
}

/** Sensor id at each position, or null. */
export function sensorAt(config: TpmsConfig, position: TirePosition): string | null {
  return config.sensors.find((s) => s.position === position)?.id ?? null;
}

/** Merge a stored blob over defaults, dropping anything malformed. */
export function normalizeTpmsConfig(stored: unknown): TpmsConfig {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_TPMS_CONFIG };
  const merged = { ...DEFAULT_TPMS_CONFIG, ...(stored as Partial<TpmsConfig>) };
  const sensors = Array.isArray(merged.sensors) ? merged.sensors : DEFAULT_TPMS_CONFIG.sensors;
  const seenPos = new Set<TirePosition>();
  merged.sensors = sensors
    .filter((s): s is TpmsSensor => !!s && typeof s.id === 'string')
    .map((s) => {
      const pos = TIRE_POSITIONS.includes(s.position as TirePosition) ? (s.position as TirePosition) : null;
      if (pos && seenPos.has(pos)) return { id: s.id, position: null };
      if (pos) seenPos.add(pos);
      return { id: s.id, position: pos };
    });
  return merged;
}
