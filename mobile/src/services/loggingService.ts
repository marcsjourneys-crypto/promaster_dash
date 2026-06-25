/** SQLite logging service for trips, breadcrumbs, and events. */

import * as SQLite from 'expo-sqlite';
import type { BreadcrumbRecord, EventRecord, TripRow } from '../models/types';
import type { TripStats } from '../models/TripStats';
import { haversineMiles } from '../utils/geo';

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

CREATE TABLE IF NOT EXISTS maintenance_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT    NOT NULL,
    service_date TEXT    NOT NULL,
    odometer     INTEGER,
    cost         REAL,
    notes        TEXT,
    created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_schedule (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type           TEXT    NOT NULL UNIQUE,
    label                  TEXT    NOT NULL,
    interval_months        INTEGER NOT NULL,
    interval_months_severe INTEGER,
    active                 INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_mlog_type ON maintenance_log(service_type);
CREATE INDEX IF NOT EXISTS idx_mlog_date ON maintenance_log(service_date);
`;

let db: SQLite.SQLiteDatabase | null = null;

/** Expose DB instance for other services that share this database. */
export function getDb(): SQLite.SQLiteDatabase | null {
  return db;
}

let lastBreadcrumbTs = 0;
const BREADCRUMB_INTERVAL = 5; // seconds

/** Initialize database connection and schema. */
export async function initDatabase(): Promise<boolean> {
  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync('PRAGMA foreign_keys = ON;');
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await db.execAsync(SCHEMA);
    // Add name column if it doesn't exist (safe migration — fails silently if already present)
    try {
      await db.execAsync('ALTER TABLE trips ADD COLUMN name TEXT');
    } catch (_) {}
    // Add mileage interval columns to maintenance_schedule (safe migration)
    try {
      await db.execAsync('ALTER TABLE maintenance_schedule ADD COLUMN interval_miles INTEGER');
    } catch (_) {}
    try {
      await db.execAsync('ALTER TABLE maintenance_schedule ADD COLUMN interval_miles_severe INTEGER');
    } catch (_) {}
    // Backfill researched mileage values and correct wrong month intervals for existing installs
    await db.execAsync(`
      UPDATE maintenance_schedule SET
        interval_miles = CASE service_type
          WHEN 'oil'                THEN 10000
          WHEN 'tires_rotated'      THEN 7500
          WHEN 'cabin_air_filter'   THEN 30000
          WHEN 'engine_air_filter'  THEN 30000
          WHEN 'brake_fluid'        THEN 32000
          WHEN 'transmission_fluid' THEN 60000
          WHEN 'coolant'            THEN 150000
          WHEN 'serpentine_belt'    THEN 90000
          WHEN 'spark_plugs'        THEN 100000
          ELSE interval_miles END,
        interval_miles_severe = CASE service_type
          WHEN 'oil'                THEN 5000
          WHEN 'tires_rotated'      THEN 6000
          WHEN 'cabin_air_filter'   THEN 15000
          WHEN 'engine_air_filter'  THEN 15000
          WHEN 'brake_fluid'        THEN 32000
          WHEN 'transmission_fluid' THEN 30000
          WHEN 'coolant'            THEN 75000
          WHEN 'serpentine_belt'    THEN 60000
          WHEN 'spark_plugs'        THEN 100000
          ELSE interval_miles_severe END,
        interval_months = CASE service_type
          WHEN 'cabin_air_filter'   THEN 24
          WHEN 'brake_fluid'        THEN 24
          WHEN 'transmission_fluid' THEN 72
          ELSE interval_months END,
        interval_months_severe = CASE service_type
          WHEN 'cabin_air_filter'   THEN 12
          WHEN 'brake_fluid'        THEN 24
          WHEN 'transmission_fluid' THEN 36
          WHEN 'serpentine_belt'    THEN 36
          ELSE interval_months_severe END
    `);
    try {
      await repairUnfinalizedTrips();
    } catch (_) {}
    return true;
  } catch (e) {
    console.warn('Database init failed:', e);
    return false;
  }
}

/**
 * Repair trips that were never finalized (app killed mid-trip).
 * Computes duration, distance, avg speed, and max temps from breadcrumbs.
 * Only touches trips older than 2 hours to avoid the current active trip.
 */
export async function repairUnfinalizedTrips(): Promise<void> {
  if (!db) return;

  const cutoff = Date.now() / 1000 - 7200;
  const tripIds = await db.getAllAsync<{ id: number }>(
    `SELECT id FROM trips WHERE end_ts IS NULL AND start_ts < ?`,
    cutoff,
  );

  if (tripIds.length === 0) return;

  for (const { id } of tripIds) {
    const agg = await db.getFirstAsync<{
      first_ts: number;
      last_ts: number;
      avg_speed: number | null;
      max_trans: number | null;
      max_coolant: number | null;
      count: number;
    }>(
      `SELECT MIN(ts) as first_ts, MAX(ts) as last_ts,
              AVG(CASE WHEN speed_mph >= 0 THEN speed_mph END) as avg_speed,
              MAX(trans_f) as max_trans, MAX(coolant_f) as max_coolant,
              COUNT(*) as count
       FROM breadcrumbs WHERE trip_id = ?`,
      id,
    );

    if (!agg || agg.count === 0) {
      // No breadcrumbs — mark as a zero-length trip so it stops showing as active
      await db.runAsync(`UPDATE trips SET end_ts = start_ts WHERE id = ?`, id);
      continue;
    }

    // Compute distance from breadcrumb positions
    const crumbs = await db.getAllAsync<{ lat: number; lon: number }>(
      `SELECT lat, lon FROM breadcrumbs WHERE trip_id = ? ORDER BY ts`,
      id,
    );

    let distanceMi = 0;
    for (let i = 1; i < crumbs.length; i++) {
      const d = haversineMiles(
        crumbs[i - 1].lat, crumbs[i - 1].lon,
        crumbs[i].lat, crumbs[i].lon,
      );
      if (d < 0.5) distanceMi += d;
    }

    await db.runAsync(
      `UPDATE trips SET
         end_ts = ?, duration_secs = ?, avg_speed_mph = ?,
         max_trans_f = ?, max_coolant_f = ?, distance_mi = ?
       WHERE id = ?`,
      agg.last_ts,
      agg.last_ts - agg.first_ts,
      agg.avg_speed ?? 0,
      agg.max_trans,
      agg.max_coolant,
      distanceMi,
      id,
    );
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
      name: string | null;
    }>(
      `SELECT id, start_ts, end_ts, distance_mi, duration_secs,
              max_trans_f, max_coolant_f, trans_warn_secs, coolant_warn_secs, avg_speed_mph, name
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
      name: r.name,
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

/** Set or update a trip's user-defined name. */
export async function renameTripEntry(tripId: number, name: string): Promise<boolean> {
  if (!db) return false;
  try {
    await db.runAsync('UPDATE trips SET name = ? WHERE id = ?', name.trim() || null, tripId);
    return true;
  } catch (e) {
    console.warn('Rename trip failed:', e);
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

/**
 * Seed the database with realistic demo trips for App Store review / demo mode.
 * No-ops immediately if any trips already exist.
 */
export async function seedDemoTrips(): Promise<boolean> {
  if (!db) return false;
  try {
    const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM trips');
    if (row && row.count > 0) return false;

    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;

    // Helper: insert a trip and return its id
    async function insertTrip(
      startTs: number, endTs: number, distMi: number, durationSecs: number,
      maxTransF: number, maxCoolantF: number, avgSpeedMph: number,
    ): Promise<number> {
      const r = await db!.runAsync(
        `INSERT INTO trips (start_ts, end_ts, distance_mi, duration_secs, max_trans_f, max_coolant_f, avg_speed_mph)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [startTs, endTs, distMi, durationSecs, maxTransF, maxCoolantF, avgSpeedMph],
      );
      return r.lastInsertRowId;
    }

    async function insertCrumb(
      tripId: number, ts: number, lat: number, lon: number,
      elevFt: number, speedMph: number, headingDeg: number,
      transF: number, coolantF: number, voltageV: number, gradePct: number,
    ): Promise<void> {
      await db!.runAsync(
        `INSERT INTO breadcrumbs (trip_id, ts, lat, lon, elevation_ft, speed_mph, heading_deg, trans_f, coolant_f, voltage_v, grade_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tripId, ts, lat, lon, elevFt, speedMph, headingDeg, transF, coolantF, voltageV, gradePct],
      );
    }

    // Trip 1: Yesterday — 45 min city/highway mix, 22 miles
    {
      const t = now - DAY - 3600;
      const id = await insertTrip(t, t + 2700, 22.4, 2700, 218, 197, 29.9);
      let lat = 47.606, lon = -122.332;
      const speeds = [18, 28, 42, 55, 58, 52, 44, 32, 22, 15];
      for (let i = 0; i < speeds.length; i++) {
        lat += 0.0025; lon += 0.0012;
        await insertCrumb(id, t + i * 270, lat, lon, 415 + i * 4, speeds[i], 48,
          208 + i * 1.1, 192 + i * 0.5, 14.2, (i % 3 - 1) * 1.5);
      }
    }

    // Trip 2: 3 days ago — 72 min highway, 48 miles
    {
      const t = now - 3 * DAY - 7200;
      const id = await insertTrip(t, t + 4320, 48.1, 4320, 226, 203, 40.1);
      let lat = 47.606, lon = -122.332;
      const speeds = [25, 45, 62, 68, 70, 72, 65, 58, 48, 35, 22, 15];
      for (let i = 0; i < speeds.length; i++) {
        lat += 0.003; lon -= 0.002;
        await insertCrumb(id, t + i * 360, lat, lon, 378 + i * 6, speeds[i], 275,
          216 + i * 0.9, 197 + i * 0.5, 14.1, (i % 4 - 1.5) * 1.2);
      }
    }

    // Trip 3: Last week — 28 min short errand, 9 miles
    {
      const t = now - 7 * DAY - 1800;
      const id = await insertTrip(t, t + 1680, 9.2, 1680, 211, 195, 19.7);
      let lat = 47.606, lon = -122.332;
      const speeds = [12, 22, 28, 30, 26, 18, 10, 8];
      for (let i = 0; i < speeds.length; i++) {
        lat -= 0.002; lon += 0.0018;
        await insertCrumb(id, t + i * 210, lat, lon, 345 + i * 3, speeds[i], 138,
          203 + i * 0.8, 191 + i * 0.4, 14.0, (i % 3 - 1) * 0.9);
      }
    }

    console.log('Demo: seeded 3 demo trips');
    return true;
  } catch (e) {
    console.warn('seedDemoTrips failed:', e);
    return false;
  }
}

/**
 * Seed the maintenance_log with realistic demo entries for demo mode.
 * No-ops immediately if any log entries already exist.
 */
export async function seedDemoMaintenance(): Promise<boolean> {
  if (!db) return false;
  try {
    const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM maintenance_log');
    if (row && row.count > 0) return false;

    const now = new Date();
    const dateAgo = (days: number): string => {
      const d = new Date(now);
      d.setDate(d.getDate() - days);
      return d.toISOString().slice(0, 10);
    };

    const entries: {
      service_type: string;
      service_date: string;
      odometer: number;
      cost: number | null;
      notes: string | null;
    }[] = [
      // Oil changes — multiple entries to show history; last ~4 months ago → DUE SOON
      { service_type: 'oil', service_date: dateAgo(118), odometer: 87450, cost: 74.99, notes: 'Full synthetic 5W-20, Mopar filter' },
      { service_type: 'oil', service_date: dateAgo(303), odometer: 81200, cost: 69.99, notes: null },
      { service_type: 'oil', service_date: dateAgo(488), odometer: 74800, cost: 72.50, notes: 'Used Pennzoil Platinum' },
      // Tire rotation — last ~5 months ago → UPCOMING
      { service_type: 'tires_rotated', service_date: dateAgo(152), odometer: 86100, cost: 29.99, notes: null },
      { service_type: 'tires_rotated', service_date: dateAgo(335), odometer: 79900, cost: 29.99, notes: null },
      // Cabin air filter — last ~14 months ago → OVERDUE (12-month interval)
      { service_type: 'cabin_air_filter', service_date: dateAgo(427), odometer: 78300, cost: 24.95, notes: 'OEM replacement' },
      // Engine air filter — last ~8 months ago → UPCOMING
      { service_type: 'engine_air_filter', service_date: dateAgo(248), odometer: 83500, cost: 34.99, notes: null },
      // Transmission fluid — last ~20 months ago → UPCOMING (24-month interval)
      { service_type: 'transmission_fluid', service_date: dateAgo(608), odometer: 65000, cost: 189.00, notes: 'ATF+4, dealer service' },
      // Coolant — last ~3.5 years ago → still within 60-month interval
      { service_type: 'coolant', service_date: dateAgo(1280), odometer: 42000, cost: 145.00, notes: 'Full flush at dealer' },
      // Serpentine belt — inspected ~4 years ago
      { service_type: 'serpentine_belt', service_date: dateAgo(1460), odometer: 35000, cost: null, notes: 'Inspected, no replacement needed' },
    ];

    for (const e of entries) {
      await db.runAsync(
        `INSERT INTO maintenance_log (service_type, service_date, odometer, cost, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [e.service_type, e.service_date, e.odometer, e.cost, e.notes, new Date().toISOString()],
      );
    }

    console.log('Demo: seeded maintenance log entries');
    return true;
  } catch (e) {
    console.warn('seedDemoMaintenance failed:', e);
    return false;
  }
}

/** Remove all trips, breadcrumbs, and maintenance records (cleans up demo data on live mode restore). */
export async function clearDemoData(): Promise<void> {
  if (!db) return;
  try {
    await db.execAsync('DELETE FROM breadcrumbs; DELETE FROM trips; DELETE FROM maintenance_log');
    console.log('Demo: cleared demo data');
  } catch (e) {
    console.warn('clearDemoData failed:', e);
  }
}
