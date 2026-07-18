/**
 * In-app debug log — a simple ring buffer of timestamped messages.
 * Subscribe from UI to show real-time scrolling log on-device.
 * Persists to AsyncStorage so logs survive app close/reopen.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const LOG_STORAGE_KEY = '@promaster/debugLog';

export interface LogEntry {
  ts: number;
  time: string;
  msg: string;
}

// 3000 keeps ~20+ min of polling history so a [948TE-PROBE] sweep block can't
// scroll out of the ring before the user opens Settings → Data and shares it.
const MAX_ENTRIES = 3000;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

function formatTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Load persisted entries on startup (fire-and-forget)
AsyncStorage.getItem(LOG_STORAGE_KEY).then((raw) => {
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as LogEntry[];
    if (Array.isArray(saved) && saved.length > 0) {
      entries.push(...saved.slice(-MAX_ENTRIES));
      for (const fn of listeners) fn();
    }
  } catch {}
}).catch(() => {});

// Debounced persist — write at most once per second to avoid churn
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    AsyncStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(entries)).catch(() => {});
  }, 1000);
}

/** Append a line to the debug log. Also forwards to console. */
export function dlog(msg: string): void {
  const now = new Date();
  entries.push({ ts: now.getTime(), time: formatTime(now), msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.log(`[DBG] ${msg}`);
  for (const fn of listeners) fn();
  schedulePersist();
}

/** Get all current log entries (newest last). */
export function getLogEntries(): LogEntry[] {
  return entries;
}

/** Clear all log entries and erase persisted copy. */
export function clearLog(): void {
  entries.length = 0;
  AsyncStorage.removeItem(LOG_STORAGE_KEY).catch(() => {});
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
