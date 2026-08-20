/**
 * Focus mode gauge resolution — pure, so it is tested without a renderer.
 *
 * Focus mode shows a small number of gauges full-screen. This module decides
 * which of the user's chosen PIDs are actually renderable right now.
 */

import {
  getPidDef,
  isFuelTrimSupported,
  type Mode01Discovery,
  type PidDef,
} from '../config/pidRegistry';

/** UI cap on focus gauges. Not enforced here — see resolveFocusGauges. */
export const MAX_FOCUS_GAUGES = 3;

/**
 * Map stored focus PID ids to registry definitions, dropping any that cannot
 * render. Preserves the user's chosen order and de-duplicates.
 *
 * A focused PID must also be enabled. Polling is driven off `enabledPids`, so
 * a disabled gauge is never requested from the vehicle and the store keeps its
 * last value — focusing one would blow up a stale reading to 2.4x, or show a
 * permanent `--`. A stale number on a temperature gauge is worse than no
 * number, so focus is restricted to the subset the app is actually polling.
 *
 * Deliberately does NOT enforce MAX_FOCUS_GAUGES: the cap is a UI affordance,
 * and a hand-edited 4th entry should degrade to smaller gauges rather than
 * throw. An empty result tells the caller to fall back to the normal
 * dashboard — never render a blank screen.
 *
 * Both id lists are array-guarded: settings are merged from disk without
 * validation, and this screen's contract is that it cannot fail mid-render.
 */
export function resolveFocusGauges(
  focusPids: string[],
  discovery: Mode01Discovery,
  enabledPids: string[],
): PidDef[] {
  if (!Array.isArray(focusPids) || !Array.isArray(enabledPids)) return [];

  const enabled = new Set(enabledPids);
  const seen = new Set<string>();
  const out: PidDef[] = [];

  for (const id of focusPids) {
    if (seen.has(id)) continue; // duplicates collide on React keys
    const pid = getPidDef(id);
    if (!pid) continue; // stale id from a removed registry entry
    if (!enabled.has(pid.id)) continue; // not polled — would render stale
    if (!isFuelTrimSupported(pid, discovery)) continue;
    seen.add(id);
    out.push(pid);
  }
  return out;
}
