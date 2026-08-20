/**
 * Focus mode gauge resolution — pure, so it is tested without a renderer.
 *
 * Focus mode shows a small number of gauges full-screen. This module decides
 * which of the user's chosen PIDs are actually renderable right now.
 */

import { getPidDef, type PidDef } from '../config/pidRegistry';

/** UI cap on focus gauges. Not enforced here — see resolveFocusGauges. */
export const MAX_FOCUS_GAUGES = 3;

export interface Mode01Discovery {
  /** Mode 01 PIDs the ECU reported as supported (uppercase hex). */
  supported: Set<string>;
  /** Whether discovery has finished — before it has, assume supported. */
  done: boolean;
}

/**
 * Map stored focus PID ids to registry definitions, dropping any that cannot
 * render. Preserves the user's chosen order.
 *
 * Deliberately does NOT enforce MAX_FOCUS_GAUGES: the cap is a UI affordance,
 * and a hand-edited 4th entry should degrade to smaller gauges rather than
 * throw. An empty result tells the caller to fall back to the normal
 * dashboard — never render a blank screen.
 */
export function resolveFocusGauges(
  focusPids: string[],
  discovery: Mode01Discovery,
): PidDef[] {
  const out: PidDef[] = [];
  for (const id of focusPids) {
    const pid = getPidDef(id);
    if (!pid) continue; // stale id from a removed registry entry
    // Same rule the dashboard applies: hide fuel trims the ECU denies.
    if (
      pid.gaugeMode === 'fuel_trim' &&
      discovery.done &&
      !discovery.supported.has(pid.pid.toUpperCase())
    ) {
      continue;
    }
    out.push(pid);
  }
  return out;
}
