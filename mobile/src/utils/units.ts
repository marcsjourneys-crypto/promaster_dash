/**
 * Display unit conversion and formatting.
 *
 * The store, database, and alert thresholds are always imperial (°F, mph, mi,
 * ft) — this module converts only at render time, so switching units never
 * touches recorded data or alert calibration.
 *
 * Distance and elevation follow `speedUnit`: kph implies km/metres.
 * Pressure (tires) is stored in psi and has its own unit preference.
 */

import type { TempUnit, SpeedUnit, PressureUnit } from '../config/settings';

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

/** psi -> target pressure unit. */
export function convertPressure(psi: number, unit: PressureUnit): number {
  if (unit === 'kPa') return psi * 6.894757;
  if (unit === 'bar') return psi * 0.06894757;
  return psi;
}

export interface UnitPrefs {
  tempUnit: TempUnit;
  speedUnit: SpeedUnit;
  /** Defaults to psi — only the tire screens and tire alerts use it. */
  pressureUnit?: PressureUnit;
}

export interface Units extends UnitPrefs {
  pressureUnit: PressureUnit;
  tempLabel: string;
  speedLabel: string;
  distanceLabel: string;
  elevationLabel: string;
  pressureLabel: string;

  /** Format a °F value in the active unit. */
  temp(f: number | null, decimals?: number): string;
  /** Format an mph value in the active unit. */
  speed(mph: number | null, decimals?: number): string;
  /** Format a miles value in the active unit. */
  distance(mi: number | null, decimals?: number): string;
  /** Format a feet value in the active unit. */
  elevation(ft: number | null, decimals?: number): string;
  /** Format a psi value in the active unit (bar gets 2 decimals by default). */
  pressure(psi: number | null, decimals?: number): string;

  /** Map a PID registry unit label to the active unit (non-temps pass through). */
  gaugeUnit(registryUnit: string): string;
  /** Convert a gauge value or threshold when its registry unit is a temperature. */
  gaugeValue(registryUnit: string, value: number | null): number | null;
}

/** Build a formatter bound to the user's unit preferences. */
export function makeUnits({ tempUnit, speedUnit, pressureUnit = 'psi' }: UnitPrefs): Units {
  const metricDistance = speedUnit === 'kph';

  const format = (v: number | null, convert: (n: number) => number, decimals: number): string =>
    v === null || !Number.isFinite(v) ? PLACEHOLDER : convert(v).toFixed(decimals);

  return {
    tempUnit,
    speedUnit,
    pressureUnit,

    tempLabel: tempUnit === 'C' ? '°C' : TEMP_UNIT_F,
    speedLabel: metricDistance ? 'KPH' : 'MPH',
    distanceLabel: metricDistance ? 'km' : 'mi',
    elevationLabel: metricDistance ? 'M' : 'FT',
    pressureLabel: pressureUnit === 'psi' ? 'PSI' : pressureUnit,

    temp: (f, decimals = 0) => format(f, (n) => convertTemp(n, tempUnit), decimals),
    speed: (mph, decimals = 0) => format(mph, (n) => convertSpeed(n, speedUnit), decimals),
    distance: (mi, decimals = 1) => format(mi, (n) => convertDistance(n, speedUnit), decimals),
    elevation: (ft, decimals = 0) => format(ft, (n) => convertElevation(n, speedUnit), decimals),
    pressure: (psi, decimals = pressureUnit === 'bar' ? 2 : 0) =>
      format(psi, (n) => convertPressure(n, pressureUnit), decimals),

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
