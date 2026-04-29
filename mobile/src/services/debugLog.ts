/**
 * In-app debug log — a simple ring buffer of timestamped messages.
 * Subscribe from UI to show real-time scrolling log on-device.
 */

export interface LogEntry {
  ts: number;
  time: string;
  msg: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

function formatTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Append a line to the debug log. Also forwards to console. */
export function dlog(msg: string): void {
  const now = new Date();
  entries.push({ ts: now.getTime(), time: formatTime(now), msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.log(`[DBG] ${msg}`);
  for (const fn of listeners) fn();
}

/** Get all current log entries (newest last). */
export function getLogEntries(): LogEntry[] {
  return entries;
}

/** Clear all log entries. */
export function clearLog(): void {
  entries.length = 0;
  for (const fn of listeners) fn();
}

/** Get full log as a copyable string. */
export function getLogText(): string {
  return entries.map((e) => `${e.time} ${e.msg}`).join('\n');
}

/** Subscribe to log changes. Returns unsubscribe function. */
export function onLogChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
