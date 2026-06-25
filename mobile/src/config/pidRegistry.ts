/**
 * Central PID registry — defines all supported OBD-II parameters.
 *
 * Each entry describes how to poll, parse, display, and alert for a PID.
 * The polling service, dashboard, and settings all derive from this registry.
 */

export type PidMode = 'mode01' | 'mode22';
export type GaugeMode = 'temp' | 'volt' | 'pressure_low' | 'percent' | 'info' | 'fuel_trim';
export type PidGroup = 'drivetrain' | 'temperatures' | 'engine' | 'informational';

export interface PidDef {
  /** Unique key used in store, settings, and polling schedule. */
  id: string;

  /** Display name on gauge card. */
  label: string;

  /** Unit string shown on gauge. */
  unit: string;

  /** Grouping for settings UI. */
  group: PidGroup;

  /** OBD mode: standard Mode 01 or manufacturer Mode 22. */
  mode: PidMode;

  /**
   * For mode01: the 2-char PID (e.g. '0C' for RPM).
   * For mode22: the DID to send after '22' prefix (e.g. '022A').
   */
  pid: string;

  /** CAN header to set with ATSH before polling (Mode 22 only). */
  header?: string;

  /** Number of data bytes expected in response. */
  dataBytes: number;

  /** Gauge display mode — determines segment bar coloring logic. */
  gaugeMode: GaugeMode;

  /** Gauge range [min, max]. */
  range: [number, number];

  /** Warning threshold (null = no warning). */
  warn: number | null;

  /** Critical threshold (null = no critical). */
  crit: number | null;

  /** Polling interval in ms. */
  intervalMs: number;

  /** Whether this PID is enabled by default. */
  defaultEnabled: boolean;

  /** Display order on dashboard (lower = higher priority). */
  displayOrder: number;
}

// ---------------------------------------------------------------------------
// PID definitions
// ---------------------------------------------------------------------------

export const PID_REGISTRY: PidDef[] = [
  // ---- Drivetrain ----
  {
    id: 'transF',
    label: 'TRANS TEMP',
    unit: '\u00b0F',
    group: 'drivetrain',
    mode: 'mode22',
    pid: 'TRANS',  // special — handled by trans discovery system
    dataBytes: 1,
    gaugeMode: 'temp',
    range: [140, 280],
    warn: 220,
    crit: 245,
    intervalMs: 1500,
    defaultEnabled: true,
    displayOrder: 1,
  },
  {
    id: 'oilPressurePsi',
    label: 'OIL PRESS',
    unit: 'PSI',
    group: 'drivetrain',
    mode: 'mode22',
    pid: '022A',
    header: '18DA10F1',
    dataBytes: 1,
    gaugeMode: 'pressure_low',
    range: [0, 100],
    warn: 25,
    crit: 7,
    intervalMs: 1000,
    defaultEnabled: false,
    displayOrder: 3,
  },

  // ---- Temperatures ----
  {
    id: 'coolantF',
    label: 'COOLANT',
    unit: '\u00b0F',
    group: 'temperatures',
    mode: 'mode01',
    pid: '05',
    dataBytes: 1,
    gaugeMode: 'temp',
    range: [140, 270],
    warn: 240,
    crit: 255,
    intervalMs: 1500,
    defaultEnabled: true,
    displayOrder: 2,
  },
  {
    id: 'oilTempF',
    label: 'OIL TEMP',
    unit: '\u00b0F',
    group: 'temperatures',
    mode: 'mode22',
    pid: '0121',
    header: '18DA10F1',
    dataBytes: 1,
    gaugeMode: 'temp',
    range: [100, 300],
    warn: 230,
    crit: 250,
    intervalMs: 1500,
    defaultEnabled: false,
    displayOrder: 4,
  },
  {
    id: 'intakeAirF',
    label: 'INTAKE AIR',
    unit: '\u00b0F',
    group: 'temperatures',
    mode: 'mode01',
    pid: '0F',
    dataBytes: 1,
    gaugeMode: 'temp',
    range: [0, 220],
    warn: 160,
    crit: 200,
    intervalMs: 5000,
    defaultEnabled: false,
    displayOrder: 7,
  },
  {
    id: 'ambientAirF',
    label: 'AMBIENT',
    unit: '\u00b0F',
    group: 'temperatures',
    mode: 'mode01',
    pid: '46',
    dataBytes: 1,
    gaugeMode: 'info',
    range: [-40, 140],
    warn: null,
    crit: null,
    intervalMs: 5000,
    defaultEnabled: false,
    displayOrder: 8,
  },

  // ---- Engine ----
  {
    id: 'voltageV',
    label: 'VOLTAGE',
    unit: 'V',
    group: 'engine',
    mode: 'mode01',
    pid: 'ATRV',  // special — AT command, not a standard PID
    dataBytes: 0,
    gaugeMode: 'volt',
    range: [11, 15.5],
    warn: 12.2,
    crit: 15,
    intervalMs: 3000,
    defaultEnabled: true,
    displayOrder: 5,
  },
  {
    id: 'engineLoadPct',
    label: 'ENG LOAD',
    unit: '%',
    group: 'engine',
    mode: 'mode01',
    pid: '04',
    dataBytes: 1,
    gaugeMode: 'percent',
    range: [0, 100],
    warn: null,
    crit: null,
    intervalMs: 3000,
    defaultEnabled: false,
    displayOrder: 6,
  },
  // ---- Fuel Trim ----
  {
    id: 'stftBank1Pct', label: 'STFT B1', unit: '%',
    group: 'engine', mode: 'mode01', pid: '06',
    dataBytes: 1, gaugeMode: 'fuel_trim',
    range: [-25, 25], warn: 10, crit: null,
    intervalMs: 3000, defaultEnabled: true, displayOrder: 50,
  },
  {
    id: 'ltftBank1Pct', label: 'LTFT B1', unit: '%',
    group: 'engine', mode: 'mode01', pid: '07',
    dataBytes: 1, gaugeMode: 'fuel_trim',
    range: [-25, 25], warn: 10, crit: null,
    intervalMs: 5000, defaultEnabled: true, displayOrder: 51,
  },
  {
    id: 'stftBank2Pct', label: 'STFT B2', unit: '%',
    group: 'engine', mode: 'mode01', pid: '08',
    dataBytes: 1, gaugeMode: 'fuel_trim',
    range: [-25, 25], warn: 10, crit: null,
    intervalMs: 3000, defaultEnabled: true, displayOrder: 52,
  },
  {
    id: 'ltftBank2Pct', label: 'LTFT B2', unit: '%',
    group: 'engine', mode: 'mode01', pid: '09',
    dataBytes: 1, gaugeMode: 'fuel_trim',
    range: [-25, 25], warn: 10, crit: null,
    intervalMs: 5000, defaultEnabled: true, displayOrder: 53,
  },

  // ---- Informational ----
  {
    id: 'fuelLevelPct',
    label: 'FUEL LEVEL',
    unit: '%',
    group: 'informational',
    mode: 'mode01',
    pid: '2F',
    dataBytes: 1,
    gaugeMode: 'percent',
    range: [0, 100],
    warn: null,
    crit: null,
    intervalMs: 5000,
    defaultEnabled: false,
    displayOrder: 9,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a PID definition by id. */
export function getPidDef(id: string): PidDef | undefined {
  return PID_REGISTRY.find((p) => p.id === id);
}

/** Get all PID definitions sorted by display order. */
export function getSortedPids(): PidDef[] {
  return [...PID_REGISTRY].sort((a, b) => a.displayOrder - b.displayOrder);
}

/** Get default enabled PID ids. */
export function getDefaultEnabledPids(): string[] {
  return PID_REGISTRY.filter((p) => p.defaultEnabled).map((p) => p.id);
}

/** Get PID definitions grouped by their group field. */
export function getPidsByGroup(): Record<PidGroup, PidDef[]> {
  const groups: Record<PidGroup, PidDef[]> = {
    drivetrain: [],
    temperatures: [],
    engine: [],
    informational: [],
  };
  for (const pid of getSortedPids()) {
    groups[pid.group].push(pid);
  }
  return groups;
}

/** Group labels for display. */
export const GROUP_LABELS: Record<PidGroup, string> = {
  drivetrain: 'DRIVETRAIN',
  temperatures: 'TEMPERATURES',
  engine: 'ENGINE',
  informational: 'INFORMATIONAL',
};
