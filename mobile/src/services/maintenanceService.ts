import { getDb } from './loggingService';

export type ServiceStatus = 'OK' | 'UPCOMING' | 'DUE SOON' | 'OVERDUE' | 'UNKNOWN';

export interface ScheduleItem {
  id: number;
  service_type: string;
  label: string;
  interval_months: number;
  interval_months_severe: number | null;
  active: boolean;
}

export interface LogEntry {
  id: number;
  service_type: string;
  service_date: string;
  odometer: number | null;
  cost: number | null;
  notes: string | null;
  created_at: string;
}

export interface ScheduleRow extends ScheduleItem {
  last_service_date: string | null;
  status: ServiceStatus;
  days_until: number | null;
  effective_interval: number;
}

/**
 * Pure status function — no side effects, easy to test.
 * todayStr is optional (defaults to today) to allow testing.
 */
export function getServiceStatus(
  lastDate: string | null,
  intervalMonths: number,
  todayStr?: string,
): ServiceStatus {
  if (!lastDate) return 'UNKNOWN';

  const today = todayStr ? new Date(todayStr) : new Date();
  const last = new Date(lastDate);

  const due = new Date(last);
  due.setMonth(due.getMonth() + intervalMonths);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntil = Math.round((due.getTime() - today.getTime()) / msPerDay);

  if (daysUntil < 0) return 'OVERDUE';
  if (daysUntil <= 14) return 'DUE SOON';
  if (daysUntil <= 30) return 'UPCOMING';
  return 'OK';
}

export function getDaysUntil(lastDate: string | null, intervalMonths: number): number | null {
  if (!lastDate) return null;
  const last = new Date(lastDate);
  const due = new Date(last);
  due.setMonth(due.getMonth() + intervalMonths);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((due.getTime() - Date.now()) / msPerDay);
}

/** Seed the default ProMaster schedule if the table is empty. */
export async function seedDefaultSchedule(): Promise<void> {
  const db = getDb();
  if (!db) return;

  const existing = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM maintenance_schedule',
  );
  if (existing && existing.count > 0) return;

  const defaults: Omit<ScheduleItem, 'id' | 'active'>[] = [
    { service_type: 'oil',                label: 'Oil & Filter',               interval_months: 12,  interval_months_severe: 6  },
    { service_type: 'tires_rotated',      label: 'Tire Rotation',              interval_months: 6,   interval_months_severe: 3  },
    { service_type: 'cabin_air_filter',   label: 'Cabin Air Filter',           interval_months: 12,  interval_months_severe: 6  },
    { service_type: 'engine_air_filter',  label: 'Engine Air Filter',          interval_months: 36,  interval_months_severe: 18 },
    { service_type: 'brake_fluid',        label: 'Brake Fluid',                interval_months: 36,  interval_months_severe: 18 },
    { service_type: 'transmission_fluid', label: 'Transmission Fluid (62TE)',  interval_months: 24,  interval_months_severe: 12 },
    { service_type: 'coolant',            label: 'Coolant (OAT)',              interval_months: 120, interval_months_severe: 60 },
    { service_type: 'serpentine_belt',    label: 'Serpentine Belt Inspection', interval_months: 60,  interval_months_severe: 30 },
  ];

  for (const item of defaults) {
    await db.runAsync(
      `INSERT OR IGNORE INTO maintenance_schedule
         (service_type, label, interval_months, interval_months_severe)
       VALUES (?, ?, ?, ?)`,
      item.service_type,
      item.label,
      item.interval_months,
      item.interval_months_severe ?? null,
    );
  }
}

/** Add a service log entry. Returns new row id. */
export async function addLogEntry(entry: {
  service_type: string;
  service_date: string;
  odometer?: number;
  cost?: number;
  notes?: string;
}): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const result = await db.runAsync(
    `INSERT INTO maintenance_log (service_type, service_date, odometer, cost, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    entry.service_type,
    entry.service_date,
    entry.odometer ?? null,
    entry.cost ?? null,
    entry.notes ?? null,
    new Date().toISOString(),
  );
  return result.lastInsertRowId;
}

/** Get all log entries, newest first. Optional filter by service_type. */
export async function getLogEntries(serviceType?: string): Promise<LogEntry[]> {
  const db = getDb();
  if (!db) return [];
  if (serviceType) {
    return db.getAllAsync<LogEntry>(
      'SELECT * FROM maintenance_log WHERE service_type = ? ORDER BY service_date DESC',
      serviceType,
    );
  }
  return db.getAllAsync<LogEntry>(
    'SELECT * FROM maintenance_log ORDER BY service_date DESC',
  );
}

/** Get most recent log entry per service type (for schedule status). */
export async function getLastServiceDates(): Promise<Record<string, string>> {
  const db = getDb();
  if (!db) return {};
  const rows = await db.getAllAsync<{ service_type: string; service_date: string }>(
    `SELECT service_type, MAX(service_date) as service_date
     FROM maintenance_log GROUP BY service_type`,
  );
  return Object.fromEntries(rows.map((r) => [r.service_type, r.service_date]));
}

/** Get schedule items with computed status. */
export async function getScheduleWithStatus(severeDuty: boolean): Promise<ScheduleRow[]> {
  const db = getDb();
  if (!db) return [];

  const schedule = await db.getAllAsync<ScheduleItem>(
    'SELECT * FROM maintenance_schedule WHERE active = 1 ORDER BY label',
  );
  const lastDates = await getLastServiceDates();

  const rows: ScheduleRow[] = schedule.map((item) => {
    const effectiveInterval = severeDuty && item.interval_months_severe
      ? item.interval_months_severe
      : item.interval_months;
    const lastDate = lastDates[item.service_type] ?? null;
    return {
      ...item,
      last_service_date: lastDate,
      status: getServiceStatus(lastDate, effectiveInterval),
      days_until: getDaysUntil(lastDate, effectiveInterval),
      effective_interval: effectiveInterval,
    };
  });

  const order: Record<ServiceStatus, number> = {
    OVERDUE: 0, 'DUE SOON': 1, UPCOMING: 2, OK: 3, UNKNOWN: 4,
  };
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

/** Seed wizard dates — called from first-run wizard on step 2 completion. */
export async function seedWizardDates(
  dates: Record<string, string>,
): Promise<void> {
  for (const [service_type, service_date] of Object.entries(dates)) {
    if (!service_date) continue;
    await addLogEntry({ service_type, service_date });
  }
}
