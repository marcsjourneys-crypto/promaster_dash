/** Format a store value for display on a gauge card, in the active units. */

import type { PidDef } from '../config/pidRegistry';
import type { Units } from './units';

export function formatGaugeValue(
  pid: PidDef,
  rawValue: number | null,
  units: Units,
): string {
  const value = units.gaugeValue(pid.unit, rawValue);
  if (value === null) return '--';
  // Fuel trim: signed, 1 decimal
  if (pid.gaugeMode === 'fuel_trim') {
    return (value > 0 ? '+' : '') + value.toFixed(1);
  }
  // Temperatures and pressures: no decimals
  if (pid.gaugeMode === 'temp' || pid.gaugeMode === 'pressure_low') {
    return value.toFixed(0);
  }
  // Voltage: 1 decimal
  if (pid.gaugeMode === 'volt') {
    return value.toFixed(1);
  }
  // Percentages: 1 decimal
  if (pid.gaugeMode === 'percent') {
    return value.toFixed(1);
  }
  // Info gauges: variable
  if (pid.unit === 'g/s') return value.toFixed(1);
  if (pid.unit === '\u00b0') return value.toFixed(1);
  return value.toFixed(0);
}
