/** SQLite logging service for trips, breadcrumbs, and events. */

import * as SQLite from 'expo-sqlite';
import type { BreadcrumbRecord, EventRecord, TripRow } from '../models/types';
import type { TripStats } from '../models/TripStats';

const DB_NAME = 'promaster_dash.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts REAL NOT NULL,
    end_ts REAL,
    distance_mi REAL DEFAULT 0,
    duration_secs REAL DEFAULT 0,
    max_trans_f REAL,
    max_coolant_f REAL,
    trans_warn_secs REAL DEFAULT 0,
    coolant_warn_secs REAL DEFAULT 0,
    avg_speed_mph REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS breadcrumbs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    ts REAL NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    elevation_ft REAL,
    speed_mph REAL,
    heading_deg INTEGER,
    trans_f REAL,
    coolant_f REAL,
    voltage_v REAL,
    grade_pct REAL,
    obd_speed_mph REAL,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER,
    ts REAL NOT NULL,
    lat REAL,
    lon REAL,
    event_type TEXT NOT NULL,
    severity TEXT,
    message TEXT,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_breadcrumbs_trip ON breadcrumbs(trip_id);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_ts ON breadcrumbs(ts);
CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_ts);
`;

let db: SQLite.SQLiteDatabase | null = null;
let lastBreadcrumbTs = 0;
const BREADCRUMB_INTERVAL = 5; // seconds

/** Initialize database connection and schema. */
export async function initDatabase(): Promise<boolean> {
  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync('PRAGMA foreign_keys = ON;');
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await db.execAsync(SCHEMA);
    return true;
  } catch (e) {
    console.warn('Database init failed:', e);
    return false;
  }
}

/** Close the database. */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.closeAsync();
    db = null;
  }
}

/** Create a new trip record. Returns trip_id or null. */
export async function createTrip(startTs: number): Promise<number | null> {
  if (!db) return null;
  try {
    const result = await db.runAsync(
      'INSERT INTO trips (start_ts) VALUES (?)',
      startTs,
    );
    const tripId = result.lastInsertRowId;

    await logEvent({
      ts: startTs,
      eventType: 'trip_start',
      severity: 'info',
      message: 'Trip started',
      tripId,
      lat: null,
      lon: null,
    });

    return tripId;
  } catch (e) {
    console.warn('Create trip failed:', e);
    return null;
  }
}

/** Finalize a trip with final statistics. */
export async function finalizeTrip(
  tripId: number,
  stats: TripStats,
): Promise<boolean> {
  if (!db) return false;
  try {
    await db.runAsync(
      `UPDATE trips SET
        end_ts = ?, distance_mi = ?, duration_secs = ?,
        max_trans_f = ?, max_coolant_f = ?,
        trans_warn_secs = ?, coolant_warn_secs = ?, avg_speed_mph = ?
      WHERE id = ?`,
      stats.endTs ?? Date.now() / 1000,
      stats.distanceMi,
      stats.durationSecs,
      stats.maxTransF,
      stats.maxCoolantF,
      stats.transWarnSecs,
      stats.coolantWarnSecs,
      stats.avgSpeedMph,
      tripId,
    );

    await logEvent({
      ts: Date.now() / 1000,
      eventType: 'trip_end',
      severity: 'info',
      message: `Trip ended: ${stats.distanceMi.toFixed(1)} mi, ${(stats.durationSecs / 60).toFixed(0)} min`,
      tripId,
      lat: null,
      lon: null,
    });

    return true;
  } catch (e) {
    console.warn('Finalize trip failed:', e);
    return false;
  }
}

/** Log a breadcrumb point (rate-limited to BREADCRUMB_INTERVAL). */
export async function logBreadcrumb(
  record: BreadcrumbRecord,
  force = false,
): Promise<boolean> {
  if (!db) return false;

  const now = Date.now() / 1000;
  if (!force && now - lastBreadcrumbTs < BREADCRUMB_INTERVAL) {
    return true; // Skipped, not an error
  }

  try {
    await db.runAsync(
      `INSERT INTO breadcrumbs (
        trip_id, ts, lat, lon, elevation_ft, speed_mph,
        heading_deg, trans_f, coolant_f, voltage_v, grade_pct, obd_speed_mph
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.tripId,
      record.ts,
      record.lat,
      record.lon,
      record.elevationFt,
      record.speedMph,
      record.headingDeg,
      record.transF,
      record.coolantF,
      record.voltageV,
      record.gradePct,
      record.obdSpeedMph,
    );
    lastBreadcrumbTs = now;
    return true;
  } catch (e) {
    console.warn('Log breadcrumb failed:', e);
    return false;
  }
}

/** Log an event with optional location. */
export async function logEvent(record: EventRecord): Promise<boolean> {
  if (!db) return false;
  try {
    await db.runAsync(
      `INSERT INTO events (trip_id, ts, lat, lon, event_type, severity, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.tripId,
      record.ts,
      record.lat,
      record.lon,
      record.eventType,
      record.severity,
      record.message,
    );
    return true;
  } catch (e) {
    console.warn('Log event failed:', e);
    return false;
  }
}

/** Get recent trip summaries. */
export async function getRecentTrips(limit = 20): Promise<TripRow[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      id: number;
      start_ts: number;
      end_ts: number | null;
      distance_mi: number;
      duration_secs: number;
      max_trans_f: number | null;
      max_coolant_f: number | null;
      trans_warn_secs: number;
      coolant_warn_secs: number;
      avg_speed_mph: number;
    }>(
      `SELECT id, start_ts, end_ts, distance_mi, duration_secs,
              max_trans_f, max_coolant_f, trans_warn_secs, coolant_warn_secs, avg_speed_mph
       FROM trips ORDER BY start_ts DESC LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      startTs: r.start_ts,
      endTs: r.end_ts,
      distanceMi: r.distance_mi,
      durationSecs: r.duration_secs,
      maxTransF: r.max_trans_f,
      maxCoolantF: r.max_coolant_f,
      transWarnSecs: r.trans_warn_secs,
      coolantWarnSecs: r.coolant_warn_secs,
      avgSpeedMph: r.avg_speed_mph,
    }));
  } catch (e) {
    console.warn('Get trips failed:', e);
    return [];
  }
}

/** Get all breadcrumbs for a trip. */
export async function getTripBreadcrumbs(
  tripId: number,
): Promise<BreadcrumbRecord[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      trip_id: number;
      ts: number;
      lat: number;
      lon: number;
      elevation_ft: number | null;
      speed_mph: number | null;
      heading_deg: number | null;
      trans_f: number | null;
      coolant_f: number | null;
      voltage_v: number | null;
      grade_pct: number | null;
      obd_speed_mph: number | null;
    }>(
      `SELECT trip_id, ts, lat, lon, elevation_ft, speed_mph,
              heading_deg, trans_f, coolant_f, voltage_v, grade_pct, obd_speed_mph
       FROM breadcrumbs WHERE trip_id = ? ORDER BY ts`,
      tripId,
    );
    return rows.map((r) => ({
      tripId: r.trip_id,
      ts: r.ts,
      lat: r.lat,
      lon: r.lon,
      elevationFt: r.elevation_ft,
      speedMph: r.speed_mph,
      headingDeg: r.heading_deg,
      transF: r.trans_f,
      coolantF: r.coolant_f,
      voltageV: r.voltage_v,
      gradePct: r.grade_pct,
      obdSpeedMph: r.obd_speed_mph,
    }));
  } catch (e) {
    console.warn('Get breadcrumbs failed:', e);
    return [];
  }
}

/** Get events for a trip. */
export async function getTripEvents(tripId: number): Promise<EventRecord[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      ts: number;
      event_type: string;
      severity: string;
      message: string;
      trip_id: number | null;
      lat: number | null;
      lon: number | null;
    }>(
      `SELECT ts, event_type, severity, message, trip_id, lat, lon
       FROM events WHERE trip_id = ? ORDER BY ts`,
      tripId,
    );
    return rows.map((r) => ({
      ts: r.ts,
      eventType: r.event_type as EventRecord['eventType'],
      severity: r.severity as EventRecord['severity'],
      message: r.message,
      tripId: r.trip_id,
      lat: r.lat,
      lon: r.lon,
    }));
  } catch (e) {
    console.warn('Get trip events failed:', e);
    return [];
  }
}

/** Delete a trip and all its breadcrumbs/events (cascading). */
export async function deleteTrip(tripId: number): Promise<boolean> {
  if (!db) return false;
  try {
    await db.runAsync('DELETE FROM trips WHERE id = ?', tripId);
    return true;
  } catch (e) {
    console.warn('Delete trip failed:', e);
    return false;
  }
}

export interface ChartPoint {
  ts: number;
  transF: number | null;
  coolantF: number | null;
  gradePct: number | null;
  speedMph: number | null;
}

/**
 * Fetch breadcrumb data for the trip chart, downsampled to maxPoints.
 * Only selects the columns needed for charting (no lat/lon/heading etc).
 */
export async function getTripChartData(
  tripId: number,
  maxPoints = 150,
): Promise<ChartPoint[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      ts: number;
      trans_f: number | null;
      coolant_f: number | null;
      grade_pct: number | null;
      speed_mph: number | null;
    }>(
      `SELECT ts, trans_f, coolant_f, grade_pct, speed_mph
       FROM breadcrumbs WHERE trip_id = ? ORDER BY ts`,
      tripId,
    );

    if (rows.length === 0) return [];

    const points: ChartPoint[] = rows.map((r) => ({
      ts: r.ts,
      transF: r.trans_f,
      coolantF: r.coolant_f,
      gradePct: r.grade_pct,
      speedMph: r.speed_mph,
    }));

    if (points.length <= maxPoints) return points;

    // Downsample evenly to maxPoints
    const step = points.length / maxPoints;
    return Array.from({ length: maxPoints }, (_, i) =>
      points[Math.min(Math.round(i * step), points.length - 1)],
    );
  } catch (e) {
    console.warn('Get chart data failed:', e);
    return [];
  }
}

/** Delete trips older than maxAgeDays. Returns count deleted. */
export async function cleanupOldTrips(maxAgeDays = 365): Promise<number> {
  if (!db) return 0;
  const cutoffTs = Date.now() / 1000 - maxAgeDays * 86400;
  try {
    const result = await db.runAsync(
      'DELETE FROM trips WHERE start_ts < ?',
      cutoffTs,
    );
    if (result.changes > 0) {
      await db.execAsync('VACUUM');
    }
    return result.changes;
  } catch (e) {
    console.warn('Cleanup failed:', e);
    return 0;
  }
}
