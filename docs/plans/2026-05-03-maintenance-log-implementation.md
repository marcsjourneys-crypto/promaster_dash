# Maintenance Log Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a vehicle maintenance log and schedule screen to the ProMaster dashboard app, replacing the dashboard's LOG button with MAINT LOG and moving the debug log into Settings.

**Architecture:** New `maintenanceService.ts` adds two tables to the existing SQLite database (`promaster_dash.db`) and exports all DB ops + pure status logic. A new `MaintenanceScreen` with SCHEDULE/HISTORY tabs and a log-entry sheet handles all UI. A first-run `MaintenanceWizard` seeds service dates on first open. Severe duty toggle lives in Settings → VEHICLE tab and halves all time intervals.

**Tech Stack:** expo-sqlite (existing), Zustand (existing), AsyncStorage via settings.ts (existing), React Native (StyleSheet, Pressable, Modal, FlatList)

**Worktree:** `c:/GitHub/promaster_dash/.worktrees/feature/maintenance-log`
**All commands run from:** `c:/GitHub/promaster_dash/.worktrees/feature/maintenance-log/mobile`

---

## Task 1: Extend Settings — add severeDuty and maintenanceWizardComplete

**Files:**
- Modify: `src/config/settings.ts`

**Step 1: Add fields to Settings interface and DEFAULT_SETTINGS**

In `src/config/settings.ts`, add to the `Settings` interface (after `enabledPids`):
```typescript
  // Maintenance
  severeDuty: boolean;
  maintenanceWizardComplete: boolean;
```

Add to `DEFAULT_SETTINGS` (after `enabledPids`):
```typescript
  severeDuty: false,
  maintenanceWizardComplete: false,
```

The existing `loadSettings` already merges with defaults (`{ ...DEFAULT_SETTINGS, ...stored }`),
so existing installs automatically get `false` for both new fields on next load.

**Step 2: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors

**Step 3: Commit**
```bash
git add src/config/settings.ts
git commit -m "feat(maintenance): add severeDuty and maintenanceWizardComplete to settings"
```

---

## Task 2: Database schema — maintenance tables + seed data

**Files:**
- Modify: `src/services/loggingService.ts`

**Step 1: Add maintenance tables to SCHEMA string**

In `src/services/loggingService.ts`, append to the `SCHEMA` const (after the existing `idx_trips_start` index):

```sql
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
```

**Step 2: Export getDb() from loggingService**

After the `let db` line, add and export:
```typescript
/** Expose DB instance for other services that share this database. */
export function getDb(): SQLite.SQLiteDatabase | null {
  return db;
}
```

**Step 3: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors

**Step 4: Commit**
```bash
git add src/services/loggingService.ts
git commit -m "feat(maintenance): add maintenance tables to SQLite schema"
```

---

## Task 3: maintenanceService — status logic (pure, testable)

**Files:**
- Create: `src/services/maintenanceService.ts`

**Step 1: Write the failing test**

Create `src/services/__tests__/maintenanceService.test.ts`:
```typescript
import { getServiceStatus } from '../maintenanceService';

describe('getServiceStatus', () => {
  const today = '2026-05-03';

  it('returns UNKNOWN when no last date', () => {
    expect(getServiceStatus(null, 12, today)).toBe('UNKNOWN');
  });

  it('returns OK when due in > 30 days', () => {
    expect(getServiceStatus('2025-06-01', 12, today)).toBe('OK'); // due 2026-06-01, 29d away — wait
    // 2025-06-01 + 12mo = 2026-06-01, days from 2026-05-03 = 29 days → DUE SOON
    // Use a date further back for OK: 2025-05-01 + 12mo = 2026-05-01 → 2 days ago = OVERDUE
    // Use 2025-01-01 + 12mo = 2026-01-01 → OVERDUE
    // Use 2025-07-01 + 12mo = 2026-07-01 → 59 days away → OK
    expect(getServiceStatus('2025-07-01', 12, today)).toBe('OK');
  });

  it('returns UPCOMING when due in 15-30 days', () => {
    // 2026-05-03 + 20 days = 2026-05-23. So last service = 2026-05-23 - 12mo = 2025-05-23
    expect(getServiceStatus('2025-05-23', 12, today)).toBe('UPCOMING');
  });

  it('returns DUE SOON when due in 0-14 days', () => {
    // due in 7 days = 2026-05-10. last = 2026-05-10 - 12mo = 2025-05-10
    expect(getServiceStatus('2025-05-10', 12, today)).toBe('DUE SOON');
  });

  it('returns OVERDUE when past due', () => {
    expect(getServiceStatus('2024-01-01', 12, today)).toBe('OVERDUE');
  });
});
```

**Step 2: Run test — verify it fails**
```bash
npx jest src/services/__tests__/maintenanceService.test.ts --no-coverage
```
Expected: FAIL — `maintenanceService` not found

**Step 3: Create maintenanceService.ts with status logic and types**

Create `src/services/maintenanceService.ts`:
```typescript
import * as SQLite from 'expo-sqlite';
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
  service_date: string;   // 'YYYY-MM-DD'
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

  // Compute next due date by adding intervalMonths
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
    { service_type: 'oil',               label: 'Oil & Filter',               interval_months: 12,  interval_months_severe: 6  },
    { service_type: 'tires_rotated',     label: 'Tire Rotation',              interval_months: 6,   interval_months_severe: 3  },
    { service_type: 'cabin_air_filter',  label: 'Cabin Air Filter',           interval_months: 12,  interval_months_severe: 6  },
    { service_type: 'engine_air_filter', label: 'Engine Air Filter',          interval_months: 36,  interval_months_severe: 18 },
    { service_type: 'brake_fluid',       label: 'Brake Fluid',                interval_months: 36,  interval_months_severe: 18 },
    { service_type: 'transmission_fluid',label: 'Transmission Fluid (62TE)',  interval_months: 24,  interval_months_severe: 12 },
    { service_type: 'coolant',           label: 'Coolant (OAT)',              interval_months: 120, interval_months_severe: 60 },
    { service_type: 'serpentine_belt',   label: 'Serpentine Belt Inspection', interval_months: 60,  interval_months_severe: 30 },
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

  // Sort: OVERDUE → DUE SOON → UPCOMING → OK → UNKNOWN
  const order: Record<ServiceStatus, number> = {
    OVERDUE: 0, 'DUE SOON': 1, UPCOMING: 2, OK: 3, UNKNOWN: 4,
  };
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

/** Seed wizard dates — called from first-run wizard on step 2 completion. */
export async function seedWizardDates(
  dates: Record<string, string>,  // service_type → 'YYYY-MM-DD'
): Promise<void> {
  for (const [service_type, service_date] of Object.entries(dates)) {
    if (!service_date) continue;
    await addLogEntry({ service_type, service_date });
  }
}
```

**Step 4: Run test — verify it passes**
```bash
npx jest src/services/__tests__/maintenanceService.test.ts --no-coverage
```
Expected: PASS (5 tests)

**Step 5: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors

**Step 6: Commit**
```bash
git add src/services/maintenanceService.ts src/services/__tests__/maintenanceService.test.ts
git commit -m "feat(maintenance): add maintenanceService with status logic and DB ops"
```

---

## Task 4: Wire maintenance DB init into app startup

**Files:**
- Modify: `App.tsx`

**Step 1: Import and call seedDefaultSchedule on startup**

In `App.tsx`, add import:
```typescript
import { seedDefaultSchedule } from './src/services/maintenanceService';
```

In the existing `useEffect` that calls `loadSettings`, chain the DB seed after settings load:
```typescript
useEffect(() => {
  loadSettings().then((s) => {
    setSettings(s);
    setEnabledPids(s.enabledPids);
    // Seed maintenance schedule defaults if first run
    seedDefaultSchedule().catch(() => {});
  });
}, []);
```

Note: `seedDefaultSchedule` already checks for existing rows and is idempotent — safe to call every startup.

**Step 2: Add 'maintenance' to Screen type and render**

Change:
```typescript
type Screen = 'dashboard' | 'trips' | 'ble' | 'settings' | 'alerts' | 'debug';
```
To:
```typescript
type Screen = 'dashboard' | 'trips' | 'ble' | 'settings' | 'alerts' | 'debug' | 'maintenance';
```

Add import (after other screen imports):
```typescript
import { MaintenanceScreen } from './src/screens/MaintenanceScreen';
```

Add render (after the `debug` block):
```tsx
{screen === 'maintenance' && (
  <MaintenanceScreen
    onBack={() => setScreen('dashboard')}
    severeDuty={settings.severeDuty}
    wizardComplete={settings.maintenanceWizardComplete}
    onWizardComplete={() => {
      loadSettings().then((s) => setSettings(s));
    }}
  />
)}
```

**Step 3: TypeScript check (will fail until MaintenanceScreen exists — that's OK)**

Skip for now — TypeScript check runs after Task 6.

**Step 4: Commit**
```bash
git add App.tsx
git commit -m "feat(maintenance): wire maintenance screen into app nav"
```

---

## Task 5: Dashboard — rename LOG → MAINT LOG

**Files:**
- Modify: `src/screens/DashboardScreen.tsx`

**Step 1: Change bottom action button**

At line ~177 in `src/screens/DashboardScreen.tsx`, change:
```tsx
<Pressable style={styles.actionBtn} onPress={() => onNavigate?.('debug')}>
  <Text style={styles.actionBtnText}>LOG</Text>
</Pressable>
```
To:
```tsx
<Pressable style={styles.actionBtn} onPress={() => onNavigate?.('maintenance')}>
  <Text style={styles.actionBtnText}>MAINT LOG</Text>
</Pressable>
```

**Step 2: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: error about MaintenanceScreen not found — expected, will clear in Task 6.

**Step 3: Commit**
```bash
git add src/screens/DashboardScreen.tsx
git commit -m "feat(maintenance): replace LOG with MAINT LOG in dashboard action row"
```

---

## Task 6: Settings — add VEHICLE tab with severe duty toggle + LOG button in DATA tab

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

**Step 1: Read current tabs**

The current tab strip is: `GAUGES | THRESHOLDS | TRIP | DISPLAY | DATA`
Tab state is a string like `'gauges' | 'thresholds' | 'trip' | 'display' | 'data'`.

**Step 2: Add 'vehicle' to tab type and strip**

Find the tab type definition (look for `'gauges'`) and add `| 'vehicle'`.

Add `VEHICLE` button to the tab strip JSX between `DISPLAY` and `DATA`:
```tsx
<Pressable
  style={[styles.tab, activeTab === 'vehicle' && styles.tabActive]}
  onPress={() => setActiveTab('vehicle')}
>
  <Text style={[styles.tabText, activeTab === 'vehicle' && styles.tabTextActive]}>
    VEHICLE
  </Text>
</Pressable>
```

**Step 3: Add VEHICLE tab content**

Add a content block (matching the style of other tab content blocks):
```tsx
{activeTab === 'vehicle' && (
  <ScrollView style={styles.tabContent}>
    <Text style={styles.sectionHeader}>DUTY CYCLE</Text>
    <View style={styles.row}>
      <View style={styles.rowLabel}>
        <Text style={styles.label}>Severe Duty</Text>
        <Text style={styles.hint}>
          Heavy hauling / camper use. Halves all maintenance intervals.
        </Text>
      </View>
      <Switch
        value={local.severeDuty}
        onValueChange={(v) => setLocal((s) => ({ ...s, severeDuty: v }))}
        trackColor={{ false: colors.bgCard, true: colors.amber }}
        thumbColor={colors.textPrimary}
      />
    </View>
  </ScrollView>
)}
```

Note: `local` is the local settings state copy that gets saved when the user taps SAVE.
`Switch` is from `react-native`.

**Step 4: Add LOG button to DATA tab**

Find the DATA tab content and add a "Debug Log" button at the bottom (above or below the
existing "Clean Up Old Trips" button). Pass `onNavigateToDebug` prop or use a navigation
callback. 

The simplest approach: pass an `onNavigate` prop to `SettingsScreen` and call it with `'debug'`.

In `SettingsScreen.tsx`, add to props interface:
```typescript
onNavigate?: (screen: string) => void;
```

In DATA tab content, add:
```tsx
<Pressable style={styles.dangerBtn} onPress={() => onNavigate?.('debug')}>
  <Text style={styles.dangerBtnText}>VIEW DEBUG LOG</Text>
</Pressable>
```

In `App.tsx`, update the `SettingsScreen` render to pass `onNavigate`:
```tsx
<SettingsScreen
  onBack={handleSettingsBack}
  liveMode={liveMode}
  onLiveModeChange={setLiveMode}
  onNavigate={handleNavigate}
/>
```

**Step 5: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: errors only about missing MaintenanceScreen — all others clean.

**Step 6: Commit**
```bash
git add src/screens/SettingsScreen.tsx App.tsx
git commit -m "feat(maintenance): add VEHICLE tab (severe duty toggle) and debug LOG to settings"
```

---

## Task 7: MaintenanceWizard screen (3-step first-run flow)

**Files:**
- Create: `src/screens/MaintenanceWizard.tsx`

**Step 1: Create the wizard**

```tsx
/**
 * First-run wizard — seeds service dates and sets severe duty preference.
 * Shows once, tracked by maintenanceWizardComplete in settings.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, SafeAreaView,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, fonts } from '../config/theme';
import { CANDIDATES as SCHEDULE_LABELS } from '../services/maintenanceService';
import { seedWizardDates } from '../services/maintenanceService';
import { loadSettings, saveSettings } from '../config/settings';
import { seedDefaultSchedule } from '../services/maintenanceService';

// The 8 service types from our schedule
const WIZARD_ITEMS = [
  { service_type: 'oil',                label: 'Oil & Filter' },
  { service_type: 'tires_rotated',      label: 'Tire Rotation' },
  { service_type: 'cabin_air_filter',   label: 'Cabin Air Filter' },
  { service_type: 'engine_air_filter',  label: 'Engine Air Filter' },
  { service_type: 'brake_fluid',        label: 'Brake Fluid' },
  { service_type: 'transmission_fluid', label: 'Transmission Fluid (62TE)' },
  { service_type: 'coolant',            label: 'Coolant (OAT)' },
  { service_type: 'serpentine_belt',    label: 'Serpentine Belt Inspection' },
];

interface Props {
  onComplete: (severeDuty: boolean) => void;
  onSkip: () => void;
}

export function MaintenanceWizard({ onComplete, onSkip }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [severeDuty, setSevereDuty] = useState(false);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  async function handleDone() {
    await seedWizardDates(dates);
    const settings = await loadSettings();
    await saveSettings({ ...settings, severeDuty, maintenanceWizardComplete: true });
    onComplete(severeDuty);
  }

  if (step === 1) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>MAINTENANCE SETUP</Text>
        <Text style={styles.question}>
          Is your ProMaster used for heavy hauling or as a camper?
        </Text>
        <Text style={styles.hint}>
          This halves all maintenance intervals for more frequent service reminders.
        </Text>
        <Pressable style={styles.choiceBtn} onPress={() => { setSevereDuty(true); setStep(2); }}>
          <Text style={styles.choiceBtnText}>YES — USE SEVERE INTERVALS</Text>
        </Pressable>
        <Pressable style={[styles.choiceBtn, styles.choiceBtnSecondary]}
          onPress={() => { setSevereDuty(false); setStep(2); }}>
          <Text style={styles.choiceBtnText}>NO — USE STANDARD INTERVALS</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={onSkip}>
          <Text style={styles.skipText}>Skip setup</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (step === 2) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>LAST SERVICE DATES</Text>
        <Text style={styles.hint}>Leave blank for anything you don't know.</Text>
        <ScrollView style={styles.list}>
          {WIZARD_ITEMS.map((item) => (
            <View key={item.service_type} style={styles.dateRow}>
              <Text style={styles.dateLabel}>{item.label}</Text>
              <Pressable
                style={styles.datePicker}
                onPress={() => setPickerFor(item.service_type)}
              >
                <Text style={styles.dateValue}>
                  {dates[item.service_type] ?? 'Unknown'}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
        {pickerFor && (
          <DateTimePicker
            value={dates[pickerFor] ? new Date(dates[pickerFor]) : new Date()}
            mode="date"
            maximumDate={new Date()}
            onChange={(_, d) => {
              if (d) setDates((prev) => ({
                ...prev,
                [pickerFor]: d.toISOString().slice(0, 10),
              }));
              setPickerFor(null);
            }}
          />
        )}
        <View style={styles.navRow}>
          <Pressable style={styles.navBtn} onPress={() => setStep(1)}>
            <Text style={styles.navBtnText}>BACK</Text>
          </Pressable>
          <Pressable style={[styles.navBtn, styles.navBtnPrimary]} onPress={() => setStep(3)}>
            <Text style={styles.navBtnText}>NEXT</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Step 3: summary (shown before save)
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>READY</Text>
      <Text style={styles.hint}>
        {severeDuty ? 'Severe duty intervals enabled.' : 'Standard intervals enabled.'}
        {'\n'}
        {Object.keys(dates).length} service date(s) entered.
      </Text>
      <View style={styles.navRow}>
        <Pressable style={styles.navBtn} onPress={() => setStep(2)}>
          <Text style={styles.navBtnText}>BACK</Text>
        </Pressable>
        <Pressable style={[styles.navBtn, styles.navBtnPrimary]} onPress={handleDone}>
          <Text style={styles.navBtnText}>DONE</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: colors.bg, padding: 20 },
  title:            { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1, marginBottom: 24 },
  question:         { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '700', marginBottom: 12 },
  hint:             { color: colors.textMuted, fontSize: fonts.sizeSm, marginBottom: 24 },
  choiceBtn:        { backgroundColor: 'rgba(220,140,35,0.15)', borderWidth: 2, borderColor: colors.amber, borderRadius: 10, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  choiceBtnSecondary: { borderColor: 'rgba(255,220,160,0.3)', backgroundColor: colors.bgCard },
  choiceBtnText:    { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900', letterSpacing: 1 },
  skipBtn:          { alignItems: 'center', marginTop: 12 },
  skipText:         { color: colors.textMuted, fontSize: fonts.sizeSm },
  list:             { flex: 1 },
  dateRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,220,160,0.1)' },
  dateLabel:        { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '700', flex: 1 },
  datePicker:       { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.bgCard, borderRadius: 6, borderWidth: 1, borderColor: colors.amberBorder },
  dateValue:        { color: colors.amber, fontSize: fonts.sizeSm, fontWeight: '700' },
  navRow:           { flexDirection: 'row', gap: 12, marginTop: 24 },
  navBtn:           { flex: 1, backgroundColor: colors.bgCard, borderWidth: 2, borderColor: 'rgba(255,220,160,0.3)', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  navBtnPrimary:    { borderColor: colors.amber, backgroundColor: 'rgba(220,140,35,0.15)' },
  navBtnText:       { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900', letterSpacing: 1 },
});
```

**Step 2: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: errors only for missing MaintenanceScreen — wizard itself should be clean.

**Step 3: Commit**
```bash
git add src/screens/MaintenanceWizard.tsx
git commit -m "feat(maintenance): add first-run wizard (3-step date seeding + severe duty)"
```

---

## Task 8: MaintenanceScreen — schedule + history + log entry sheet

**Files:**
- Create: `src/screens/MaintenanceScreen.tsx`

**Step 1: Create the screen**

```tsx
/**
 * Maintenance log and schedule screen.
 * Two tabs: SCHEDULE (due/overdue list) and HISTORY (chronological log).
 * Floating + button opens a log entry sheet.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, FlatList, Modal, ScrollView,
  TextInput, StyleSheet, SafeAreaView, Alert,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, fonts } from '../config/theme';
import { MaintenanceWizard } from './MaintenanceWizard';
import {
  getScheduleWithStatus,
  getLogEntries,
  addLogEntry,
  type ScheduleRow,
  type LogEntry,
  type ServiceStatus,
} from '../services/maintenanceService';
import { loadSettings, saveSettings } from '../config/settings';

const SERVICE_TYPES = [
  { value: 'oil',                 label: 'Oil & Filter' },
  { value: 'tires_rotated',       label: 'Tire Rotation' },
  { value: 'cabin_air_filter',    label: 'Cabin Air Filter' },
  { value: 'engine_air_filter',   label: 'Engine Air Filter' },
  { value: 'brake_fluid',         label: 'Brake Fluid' },
  { value: 'transmission_fluid',  label: 'Transmission Fluid (62TE)' },
  { value: 'coolant',             label: 'Coolant (OAT)' },
  { value: 'serpentine_belt',     label: 'Serpentine Belt Inspection' },
  { value: 'other',               label: 'Other' },
];

const STATUS_COLORS: Record<ServiceStatus, string> = {
  OVERDUE:    '#e05050',
  'DUE SOON': '#e07020',
  UPCOMING:   '#d4aa30',
  OK:         '#50a050',
  UNKNOWN:    '#666666',
};

interface Props {
  onBack: () => void;
  severeDuty: boolean;
  wizardComplete: boolean;
  onWizardComplete: (severeDuty: boolean) => void;
}

export function MaintenanceScreen({ onBack, severeDuty, wizardComplete, onWizardComplete }: Props) {
  const [activeTab, setActiveTab] = useState<'schedule' | 'history'>('schedule');
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showWizard, setShowWizard] = useState(!wizardComplete);

  // Log entry form state
  const [formType, setFormType] = useState(SERVICE_TYPES[0].value);
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10));
  const [formOdo, setFormOdo] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formCost, setFormCost] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);

  const refresh = useCallback(async () => {
    const [s, h] = await Promise.all([
      getScheduleWithStatus(severeDuty),
      getLogEntries(),
    ]);
    setSchedule(s);
    setHistory(h);
  }, [severeDuty]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSaveEntry() {
    if (!formType) { Alert.alert('Select a service type'); return; }
    await addLogEntry({
      service_type: formType,
      service_date: formDate,
      odometer: formOdo ? parseInt(formOdo, 10) : undefined,
      cost: formCost ? parseFloat(formCost) : undefined,
      notes: formNotes || undefined,
    });
    setShowAddSheet(false);
    setFormOdo(''); setFormNotes(''); setFormCost('');
    await refresh();
  }

  async function handleWizardComplete(duty: boolean) {
    setShowWizard(false);
    onWizardComplete(duty);
    await refresh();
  }

  if (showWizard) {
    return (
      <MaintenanceWizard
        onComplete={handleWizardComplete}
        onSkip={async () => {
          const s = await loadSettings();
          await saveSettings({ ...s, maintenanceWizardComplete: true });
          setShowWizard(false);
          onWizardComplete(s.severeDuty);
        }}
      />
    );
  }

  function formatDaysUntil(row: ScheduleRow): string {
    if (row.days_until === null) return '—';
    if (row.days_until < 0) return `${Math.abs(row.days_until)}d overdue`;
    if (row.days_until === 0) return 'Due today';
    return `${row.days_until}d`;
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>MAINTENANCE</Text>
      </View>

      {/* Tab strip */}
      <View style={styles.tabs}>
        {(['schedule', 'history'] as const).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* SCHEDULE tab */}
      {activeTab === 'schedule' && (
        <FlatList
          data={schedule}
          keyExtractor={(item) => item.service_type}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.scheduleRow}>
              <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[item.status] }]}>
                <Text style={styles.statusText}>{item.status}</Text>
              </View>
              <View style={styles.scheduleInfo}>
                <Text style={styles.scheduleLabel}>{item.label}</Text>
                <Text style={styles.scheduleDetail}>
                  {item.last_service_date
                    ? `Last: ${item.last_service_date}`
                    : 'Never recorded'}
                </Text>
              </View>
              <Text style={styles.daysUntil}>{formatDaysUntil(item)}</Text>
            </View>
          )}
        />
      )}

      {/* HISTORY tab */}
      {activeTab === 'history' && (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.historyRow}>
              <View>
                <Text style={styles.historyLabel}>
                  {SERVICE_TYPES.find((t) => t.value === item.service_type)?.label ?? item.service_type}
                </Text>
                <Text style={styles.historyDetail}>
                  {item.service_date}
                  {item.odometer ? ` · ${item.odometer.toLocaleString()} mi` : ''}
                  {item.cost ? ` · $${item.cost.toFixed(2)}` : ''}
                </Text>
                {item.notes ? <Text style={styles.historyNotes}>{item.notes}</Text> : null}
              </View>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No service history yet. Tap + to add an entry.</Text>
          }
        />
      )}

      {/* Floating + button */}
      <Pressable style={styles.fab} onPress={() => setShowAddSheet(true)}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      {/* Log entry modal sheet */}
      <Modal visible={showAddSheet} animationType="slide" transparent presentationStyle="overFullScreen">
        <View style={styles.sheetOverlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>LOG SERVICE</Text>

            {/* Service type selector */}
            <Text style={styles.fieldLabel}>SERVICE TYPE</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeScroll}>
              {SERVICE_TYPES.map((t) => (
                <Pressable
                  key={t.value}
                  style={[styles.typeChip, formType === t.value && styles.typeChipActive]}
                  onPress={() => setFormType(t.value)}
                >
                  <Text style={[styles.typeChipText, formType === t.value && styles.typeChipTextActive]}>
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Date */}
            <Text style={styles.fieldLabel}>DATE</Text>
            <Pressable style={styles.input} onPress={() => setShowDatePicker(true)}>
              <Text style={styles.inputText}>{formDate}</Text>
            </Pressable>
            {showDatePicker && (
              <DateTimePicker
                value={new Date(formDate)}
                mode="date"
                maximumDate={new Date()}
                onChange={(_, d) => {
                  if (d) setFormDate(d.toISOString().slice(0, 10));
                  setShowDatePicker(false);
                }}
              />
            )}

            {/* Odometer */}
            <Text style={styles.fieldLabel}>ODOMETER (optional)</Text>
            <TextInput
              style={styles.input}
              value={formOdo}
              onChangeText={setFormOdo}
              keyboardType="number-pad"
              placeholder="miles"
              placeholderTextColor={colors.textMuted}
            />

            {/* Cost */}
            <Text style={styles.fieldLabel}>COST (optional)</Text>
            <TextInput
              style={styles.input}
              value={formCost}
              onChangeText={setFormCost}
              keyboardType="decimal-pad"
              placeholder="$0.00"
              placeholderTextColor={colors.textMuted}
            />

            {/* Notes */}
            <Text style={styles.fieldLabel}>NOTES (optional)</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={formNotes}
              onChangeText={setFormNotes}
              multiline
              placeholder="Shop name, parts used..."
              placeholderTextColor={colors.textMuted}
            />

            <View style={styles.sheetBtns}>
              <Pressable style={styles.sheetCancel} onPress={() => setShowAddSheet(false)}>
                <Text style={styles.sheetCancelText}>CANCEL</Text>
              </Pressable>
              <Pressable style={styles.sheetSave} onPress={handleSaveEntry}>
                <Text style={styles.sheetSaveText}>SAVE</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: colors.bg },
  header:             { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backBtn:            { paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.bgPill, borderRadius: 8, borderWidth: 1, borderColor: colors.amberBorder },
  backBtnText:        { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800' },
  title:              { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1 },
  tabs:               { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  tab:                { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 2, borderColor: 'rgba(255,220,160,0.2)', backgroundColor: colors.bgCard, alignItems: 'center' },
  tabActive:          { borderColor: colors.amber, backgroundColor: 'rgba(220,140,35,0.15)' },
  tabText:            { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '800' },
  tabTextActive:      { color: colors.amber },
  list:               { paddingHorizontal: 16, paddingBottom: 80 },
  scheduleRow:        { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, borderRadius: 10, borderWidth: 1, borderColor: colors.amberBorder, padding: 12, marginBottom: 8, gap: 10 },
  statusBadge:        { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, minWidth: 72, alignItems: 'center' },
  statusText:         { color: '#fff', fontSize: fonts.sizeXs, fontWeight: '900', letterSpacing: 0.5 },
  scheduleInfo:       { flex: 1 },
  scheduleLabel:      { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '700' },
  scheduleDetail:     { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: 2 },
  daysUntil:          { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '700', minWidth: 60, textAlign: 'right' },
  historyRow:         { backgroundColor: colors.bgCard, borderRadius: 10, borderWidth: 1, borderColor: colors.amberBorder, padding: 12, marginBottom: 8 },
  historyLabel:       { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '700' },
  historyDetail:      { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: 2 },
  historyNotes:       { color: colors.textMuted, fontSize: fonts.sizeXs, marginTop: 4, fontStyle: 'italic' },
  emptyText:          { color: colors.textMuted, fontSize: fonts.sizeSm, textAlign: 'center', marginTop: 40 },
  fab:                { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.amber, alignItems: 'center', justifyContent: 'center', elevation: 4 },
  fabText:            { color: '#000', fontSize: 28, fontWeight: '900', lineHeight: 32 },
  sheetOverlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:              { backgroundColor: colors.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 40 },
  sheetTitle:         { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900', letterSpacing: 1, marginBottom: 16 },
  fieldLabel:         { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '900', letterSpacing: 1, marginBottom: 4, marginTop: 12 },
  typeScroll:         { marginBottom: 4 },
  typeChip:           { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,220,160,0.2)', backgroundColor: colors.bgCard, marginRight: 8 },
  typeChipActive:     { borderColor: colors.amber, backgroundColor: 'rgba(220,140,35,0.15)' },
  typeChipText:       { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '700' },
  typeChipTextActive: { color: colors.amber },
  input:              { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.amberBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: colors.textPrimary, fontSize: fonts.sizeSm },
  inputText:          { color: colors.textPrimary, fontSize: fonts.sizeSm },
  inputMultiline:     { height: 72, textAlignVertical: 'top' },
  sheetBtns:          { flexDirection: 'row', gap: 12, marginTop: 20 },
  sheetCancel:        { flex: 1, backgroundColor: colors.bgCard, borderWidth: 2, borderColor: 'rgba(255,220,160,0.3)', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  sheetCancelText:    { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '900' },
  sheetSave:          { flex: 1, backgroundColor: 'rgba(220,140,35,0.15)', borderWidth: 2, borderColor: colors.amber, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  sheetSaveText:      { color: colors.amber, fontSize: fonts.sizeSm, fontWeight: '900' },
});
```

**Step 2: Full TypeScript check — should be clean**
```bash
npx tsc --noEmit
```
Expected: **0 errors**

**Step 3: Commit**
```bash
git add src/screens/MaintenanceScreen.tsx
git commit -m "feat(maintenance): add MaintenanceScreen with schedule, history, and log entry sheet"
```

---

## Task 9: Final integration check and push

**Step 1: Full TypeScript check**
```bash
npx tsc --noEmit
```
Expected: 0 errors

**Step 2: Run test suite**
```bash
npx jest --no-coverage
```
Expected: all tests pass including the new `maintenanceService.test.ts`

**Step 3: Push feature branch**
```bash
git push -u origin feature/maintenance-log
```

**Step 4: Verify git log looks clean**
```bash
git log --oneline -12
```
Expected: 8 commits from this feature, each with `feat(maintenance):` prefix

---

## Verification (Manual)

1. Build and run on device/simulator
2. Tap MAINT LOG from dashboard → wizard appears on first open
3. Complete wizard: set severe duty, enter 1-2 service dates, tap DONE
4. Schedule tab shows correct status badges (OK, UPCOMING etc.)
5. Tap + → log entry sheet → fill in service type + date → SAVE → history tab shows entry
6. Open Settings → VEHICLE tab → toggle severe duty → intervals update on schedule
7. Open Settings → DATA tab → LOG button present → taps through to debug log screen
8. Dashboard bottom row shows MAINT LOG (not LOG)
