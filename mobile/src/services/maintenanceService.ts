import { getDb } from './loggingService';

export type ServiceStatus = 'OK' | 'UPCOMING' | 'DUE SOON' | 'OVERDUE' | 'UNKNOWN';

export interface ScheduleItem {
  id: number;
  service_type: string;
  label: string;
  interval_months: number;
  interval_months_severe: number | null;
  interval_miles: number | null;
  interval_miles_severe: number | null;
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
  last_odometer: number | null;
  next_due_date: string | null;
  next_due_odometer: number | null;
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

/** Seed the default ProMaster schedule. Uses INSERT OR IGNORE so re-runs are safe. */
export async function seedDefaultSchedule(): Promise<void> {
  const db = getDb();
  if (!db) return;

  const defaults: Omit<ScheduleItem, 'id' | 'active'>[] = [
    { service_type: 'oil',                label: 'Oil & Filter',               interval_months: 12,  interval_months_severe: 6,  interval_miles: 10000,  interval_miles_severe: 5000   },
    { service_type: 'tires_rotated',      label: 'Tire Rotation',              interval_months: 6,   interval_months_severe: 3,  interval_miles: 7500,   interval_miles_severe: 6000   },
    { service_type: 'cabin_air_filter',   label: 'Cabin Air Filter',           interval_months: 24,  interval_months_severe: 12, interval_miles: 30000,  interval_miles_severe: 15000  },
    { service_type: 'engine_air_filter',  label: 'Engine Air Filter',          interval_months: 36,  interval_months_severe: 18, interval_miles: 30000,  interval_miles_severe: 15000  },
    { service_type: 'brake_fluid',        label: 'Brake Fluid',                interval_months: 24,  interval_months_severe: 24, interval_miles: 32000,  interval_miles_severe: 32000  },
    { service_type: 'transmission_fluid', label: 'Transmission Fluid (62TE)',  interval_months: 72,  interval_months_severe: 36, interval_miles: 60000,  interval_miles_severe: 30000  },
    { service_type: 'coolant',            label: 'Coolant (OAT)',              interval_months: 120, interval_months_severe: 60, interval_miles: 150000, interval_miles_severe: 75000  },
    { service_type: 'serpentine_belt',    label: 'Serpentine Belt Inspection', interval_months: 60,  interval_months_severe: 36, interval_miles: 90000,  interval_miles_severe: 60000  },
    { service_type: 'spark_plugs',        label: 'Spark Plugs (Iridium)',      interval_months: 96,  interval_months_severe: 96, interval_miles: 100000, interval_miles_severe: 100000 },
  ];

  for (const item of defaults) {
    await db.runAsync(
      `INSERT OR IGNORE INTO maintenance_schedule
         (service_type, label, interval_months, interval_months_severe, interval_miles, interval_miles_severe)
       VALUES (?, ?, ?, ?, ?, ?)`,
      item.service_type,
      item.label,
      item.interval_months,
      item.interval_months_severe ?? null,
      item.interval_miles ?? null,
      item.interval_miles_severe ?? null,
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

/** Get most recent log entry (date + odometer) per service type. */
async function getLastServiceInfo(): Promise<Record<string, { date: string; odometer: number | null }>> {
  const db = getDb();
  if (!db) return {};
  const rows = await db.getAllAsync<{ service_type: string; service_date: string; odometer: number | null }>(
    `SELECT service_type, MAX(service_date) as service_date, odometer
     FROM maintenance_log GROUP BY service_type`,
  );
  return Object.fromEntries(rows.map((r) => [r.service_type, { date: r.service_date, odometer: r.odometer }]));
}

/** Get schedule items with computed status, next due date, and mileage projections. */
export async function getScheduleWithStatus(severeDuty: boolean): Promise<ScheduleRow[]> {
  const db = getDb();
  if (!db) return [];

  const schedule = await db.getAllAsync<ScheduleItem>(
    'SELECT * FROM maintenance_schedule WHERE active = 1 ORDER BY label',
  );
  const lastInfo = await getLastServiceInfo();

  const rows: ScheduleRow[] = schedule.map((item) => {
    const effectiveInterval = severeDuty && item.interval_months_severe
      ? item.interval_months_severe
      : item.interval_months;
    const effectiveMiles = severeDuty && item.interval_miles_severe
      ? item.interval_miles_severe
      : (item.interval_miles ?? null);
    const info = lastInfo[item.service_type] ?? null;
    const lastDate = info?.date ?? null;
    const lastOdometer = info?.odometer ?? null;

    let nextDueDate: string | null = null;
    if (lastDate) {
      const [y, mo, d] = lastDate.split('-').map(Number);
      const due = new Date(y, mo - 1, d);
      due.setMonth(due.getMonth() + effectiveInterval);
      nextDueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    }

    const nextDueOdometer = lastOdometer !== null && effectiveMiles !== null
      ? lastOdometer + effectiveMiles
      : null;

    return {
      ...item,
      last_service_date: lastDate,
      last_odometer: lastOdometer,
      next_due_date: nextDueDate,
      next_due_odometer: nextDueOdometer,
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
