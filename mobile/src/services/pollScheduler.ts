/**
 * Pure scheduling decisions for the OBD poll loop.
 *
 * Kept free of transport/store imports so the policy is unit-testable.
 * obdService owns the loop, the nextDue map, and all bus I/O.
 */

export interface ScheduleEntry {
  id: string;
  intervalMs: number;
}

/**
 * Pick the next poll: the most-overdue due entry (earliest nextDue timestamp),
 * with schedule order breaking ties.
 *
 * The previous policy — first due entry in schedule order — starved everything
 * below the fast PIDs once their aggregate service time saturated the BLE bus
 * (2026-08-04 tester log: fuel trims and voltage never polled over a whole
 * drive). Most-overdue-first keeps schedule order as priority for
 * simultaneously-due entries but guarantees every entry ages to the front.
 *
 * An id missing from nextDue is treated as due at `now` (new schedule entry).
 * Returns null when nothing is due.
 */
export function selectDuePoll(
  schedule: ScheduleEntry[],
  nextDue: Record<string, number>,
  now: number,
): string | null {
  let bestId: string | null = null;
  let bestDue = Infinity;
  for (const entry of schedule) {
    const due = nextDue[entry.id] ?? now;
    if (due > now) continue;
    if (due < bestDue) {
      bestId = entry.id;
      bestDue = due;
    }
  }
  return bestId;
}

/**
 * Ids to read in one header session: the primary first, then every other
 * enabled id addressed to the same CAN header. Each ATSH set/settle/restore
 * round trip costs ~600ms of bus time; an extra DID inside an open session
 * costs one request (~200ms), so co-located PIDs always piggyback.
 */
export function batchIdsForHeader(
  primaryId: string,
  headerById: Record<string, string>,
  isEnabled: (id: string) => boolean,
): string[] {
  const header = headerById[primaryId];
  const ids = [primaryId];
  for (const id of Object.keys(headerById)) {
    if (id !== primaryId && headerById[id] === header && isEnabled(id)) {
      ids.push(id);
    }
  }
  return ids;
}
