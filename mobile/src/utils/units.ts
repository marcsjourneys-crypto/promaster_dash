/**
 * Display unit conversion and formatting.
 *
 * The store, database, and alert thresholds are always imperial (°F, mph, mi,
 * ft) — this module converts only at render time, so switching units never
 * touches recorded data or alert calibration.
 *
 * Distance and elevation follow `speedUnit`: kph implies km/metres.
 */

import type { TempUnit, SpeedUnit } from '../config/settings';

/** Registry unit string that marks a gauge as a temperature. */
const TEMP_UNIT_F = '°F';

export const PLACEHOLDER = '--';

/** °F -> target temperature unit. */
export function convertTemp(f: number, unit: TempUnit): number {
  return unit === 'C' ? ((f - 32) * 5) / 9 : f;
}

/** mph -> target speed unit. */
export function convertSpeed(mph: number, unit: SpeedUnit): number {
  return unit === 'kph' ? mph * 1.609344 : mph;
}

/** Miles -> km when the speed unit is metric. */
export function convertDistance(mi: number, unit: SpeedUnit): number {
  return unit === 'kph' ? mi * 1.609344 : mi;
}

/** Feet -> metres when the speed unit is metric. */
export function convertElevation(ft: number, unit: SpeedUnit): number {
  return unit === 'kph' ? ft * 0.3048 : ft;
}

export interface UnitPrefs {
  tempUnit: TempUnit;
  speedUnit: SpeedUnit;
}

export interface Units extends UnitPrefs {
  tempLabel: string;
  speedLabel: string;
  distanceLabel: string;
  elevationLabel: string;

  /** Format a °F value in the active unit. */
  temp(f: number | null, decimals?: number): string;
  /** Format an mph value in the active unit. */
  speed(mph: number | null, decimals?: number): string;
  /** Format a miles value in the active unit. */
  distance(mi: number | null, decimals?: number): string;
  /** Format a feet value in the active unit. */
  elevation(ft: number | null, decimals?: number): string;

  /** Map a PID registry unit label to the active unit (non-temps pass through). */
  gaugeUnit(registryUnit: string): string;
  /** Convert a gauge value or threshold when its registry unit is a temperature. */
  gaugeValue(registryUnit: string, value: number | null): number | null;
}

/** Build a formatter bound to the user's unit preferences. */
export function makeUnits({ tempUnit, speedUnit }: UnitPrefs): Units {
  const metricDistance = speedUnit === 'kph';

  const format = (v: number | null, convert: (n: number) => number, decimals: number): string =>
    v === null || !Number.isFinite(v) ? PLACEHOLDER : convert(v).toFixed(decimals);

  return {
    tempUnit,
    speedUnit,

    tempLabel: tempUnit === 'C' ? '°C' : TEMP_UNIT_F,
    speedLabel: metricDistance ? 'KPH' : 'MPH',
    distanceLabel: metricDistance ? 'km' : 'mi',
    elevationLabel: metricDistance ? 'M' : 'FT',

    temp: (f, decimals = 0) => format(f, (n) => convertTemp(n, tempUnit), decimals),
    speed: (mph, decimals = 0) => format(mph, (n) => convertSpeed(n, speedUnit), decimals),
    distance: (mi, decimals = 1) => format(mi, (n) => convertDistance(n, speedUnit), decimals),
    elevation: (ft, decimals = 0) => format(ft, (n) => convertElevation(n, speedUnit), decimals),

    gaugeUnit: (registryUnit) =>
      registryUnit === TEMP_UNIT_F && tempUnit === 'C' ? '°C' : registryUnit,

    gaugeValue: (registryUnit, value) => {
      if (value === null) return null;
      return registryUnit === TEMP_UNIT_F ? convertTemp(value, tempUnit) : value;
    },
  };
}

/** Imperial formatter — the app default, used before settings load. */
export const IMPERIAL_UNITS = makeUnits({ tempUnit: 'F', speedUnit: 'mph' });
