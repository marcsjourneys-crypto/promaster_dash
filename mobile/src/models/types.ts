/** Data transfer objects for GPS, logging, and trip tracking. */

export interface GPSData {
  lat: number | null;
  lon: number | null;
  speedMph: number | null;
  headingDeg: number | null;
  elevationFt: number | null;
  fixOk: boolean;
  gradePct: number | null;
  timestamp: number; // Unix timestamp (ms)
}

export interface BreadcrumbRecord {
  tripId: number;
  ts: number;
  lat: number;
  lon: number;
  elevationFt: number | null;
  speedMph: number | null;
  headingDeg: number | null;
  transF: number | null;
  coolantF: number | null;
  voltageV: number | null;
  gradePct: number | null;
  obdSpeedMph: number | null;
}

export interface EventRecord {
  ts: number;
  eventType: 'alert' | 'dtc' | 'trip_start' | 'trip_end';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  tripId: number | null;
  lat: number | null;
  lon: number | null;
}

export interface TripRow {
  id: number;
  startTs: number;
  endTs: number | null;
  distanceMi: number;
  durationSecs: number;
  maxTransF: number | null;
  maxCoolantF: number | null;
  transWarnSecs: number;
  coolantWarnSecs: number;
  avgSpeedMph: number;
}

/** Threshold constants for gauges and alerts. */
export const TRANS_RANGE: [number, number] = [140, 280];
export const TRANS_WARN = 230;
export const TRANS_CRIT = 250;

export const COOL_RANGE: [number, number] = [140, 250];
export const COOL_WARN = 220;
export const COOL_CRIT = 235;

export const VOLT_RANGE: [number, number] = [11, 15.5];
export const VOLT_LOW = 12;
export const VOLT_HIGH = 15;
