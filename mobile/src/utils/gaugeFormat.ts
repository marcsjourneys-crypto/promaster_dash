/** Format a store value for display on a gauge card, in the active units. */

import type { GaugeMode, PidDef } from '../config/pidRegistry';
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

/** Everything a <GaugeCard> needs except `scale`, which the caller owns. */
export interface GaugeCardValues {
  title: string;
  value: string;
  unit: string;
  rawValue: number | null;
  min: number;
  max: number;
  mode: GaugeMode;
  warn: number | null;
  crit: number | null;
}

/**
 * Build the full <GaugeCard> prop set for a PID.
 *
 * The dashboard and focus mode both render the same card, and the thresholds
 * are the reason this is shared rather than copy-pasted: `warn` and `crit` must
 * pass through the same unit conversion as `value`, `min` and `max`. If one
 * side is converted and the other is not, a critical reading renders inside the
 * healthy zone of the segment bar — silently, with no error anywhere.
 *
 * `scale` is deliberately excluded: it is a per-view display choice (focus mode
 * passes FOCUS_SCALE, the dashboard leaves it at 1), not a property of the PID.
 */
export function gaugeCardProps(
  pid: PidDef,
  rawValue: number | null,
  units: Units,
): GaugeCardValues {
  return {
    title: pid.label,
    value: formatGaugeValue(pid, rawValue, units),
    unit: units.gaugeUnit(pid.unit),
    rawValue: units.gaugeValue(pid.unit, rawValue),
    min: units.gaugeValue(pid.unit, pid.range[0])!,
    max: units.gaugeValue(pid.unit, pid.range[1])!,
    mode: pid.gaugeMode,
    warn: units.gaugeValue(pid.unit, pid.warn),
    crit: units.gaugeValue(pid.unit, pid.crit),
  };
}
