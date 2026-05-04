# Maintenance Log — Design Document
**Date:** 2026-05-03
**Scope:** v1 — Log + Schedule + First-run wizard + Severe duty toggle. No push notifications.

---

## Context

Add a vehicle maintenance log and schedule to the ProMaster dashboard app. Replace the
dashboard's `LOG` button (debug log) with `MAINT LOG`. Move the debug log button into
Settings → DATA tab. The feature tracks service history, computes due/overdue status against
ProMaster-specific schedule defaults, and guides the user through a first-run wizard to seed
their service dates.

---

## Storage & Data Layer

**Database:** SQLite via existing `expo-sqlite` — no new dependency.
**Service file:** `mobile/src/services/maintenanceService.ts`

### Schema

```sql
maintenance_log (
  id           INTEGER PRIMARY KEY,
  service_type TEXT    NOT NULL,        -- 'oil', 'tires_rotated', etc.
  service_date TEXT    NOT NULL,        -- ISO date 'YYYY-MM-DD'
  odometer     INTEGER,                 -- miles at service (optional)
  cost         REAL,                    -- optional
  notes        TEXT,                    -- shop, parts used, etc.
  created_at   TEXT    NOT NULL
)

maintenance_schedule (
  id                     INTEGER PRIMARY KEY,
  service_type           TEXT    NOT NULL UNIQUE,
  label                  TEXT    NOT NULL,   -- "Oil & Filter"
  interval_months        INTEGER NOT NULL,
  interval_months_severe INTEGER,            -- halved for severe duty
  active                 BOOLEAN DEFAULT 1
)
```

**Severe duty flag:** `severeDuty: boolean` stored in existing `settings.ts` / AsyncStorage
key `promaster_dash_settings`. Schedule queries use `interval_months_severe` when set.

### Status Logic (pure function in `maintenanceService.ts`)

```
OVERDUE   → days_until < 0
DUE SOON  → 0 ≤ days_until ≤ 14
UPCOMING  → 15 ≤ days_until ≤ 30
OK        → days_until > 30
UNKNOWN   → no log entry exists yet
```

---

## ProMaster Schedule Defaults

Pre-populated on first DB init. Spark plugs omitted from v1 (mileage-only, no reliable odo).

| service_type          | label                      | Normal (mo) | Severe (mo) |
|-----------------------|----------------------------|-------------|-------------|
| oil                   | Oil & Filter               | 12          | 6           |
| tires_rotated         | Tire Rotation              | 6           | 3           |
| cabin_air_filter      | Cabin Air Filter           | 12          | 6           |
| engine_air_filter     | Engine Air Filter          | 36          | 18          |
| brake_fluid           | Brake Fluid                | 36          | 18          |
| transmission_fluid    | Transmission Fluid (62TE)  | 24          | 12          |
| coolant               | Coolant (OAT)              | 120         | 60          |
| serpentine_belt       | Serpentine Belt Inspection | 60          | 30          |

---

## Navigation Changes

- **`App.tsx`**: Add `'maintenance'` to `Screen` type.
- **Dashboard bottom row**: `TRIPS | SCAN CODES | LOG` → `TRIPS | SCAN CODES | MAINT LOG`
- **Settings → DATA tab**: Add debug log button where it currently lives on dashboard.
- **New screen**: `mobile/src/screens/MaintenanceScreen.tsx`

---

## MaintenanceScreen Layout

```
┌─────────────────────────────────────┐
│ ← Back          MAINTENANCE         │
├──────────────┬──────────────────────┤
│  SCHEDULE    │  HISTORY             │  ← tab strip
├─────────────────────────────────────┤
│                                     │
│  [OVERDUE]  Oil & Filter    3d ago  │
│  [DUE SOON] Tire Rotation   6d      │
│  [UPCOMING] Cabin Air Filter 22d    │
│  [OK]       Brake Fluid     8mo     │
│  [UNKNOWN]  Coolant         —       │
│                                     │
│                                     │
│                               [ + ] │  ← floating log-entry button
└─────────────────────────────────────┘
```

Schedule tab sorted: OVERDUE → DUE SOON → UPCOMING → OK → UNKNOWN.
Each row: label, status badge (color-coded), days until/since due.

HISTORY tab: chronological list of log entries, filterable by service type.

**Log entry bottom sheet** (triggered by `+`):
- Service type dropdown
- Date picker (default: today)
- Odometer field
- Notes field (optional)
- Cost field (optional)
- SAVE button

---

## Settings Changes

- **New VEHICLE tab** added to SettingsScreen tab strip:
  `GAUGES | THRESHOLDS | TRIP | DISPLAY | VEHICLE | DATA`
- Contents: severe duty toggle + explanation of what it does to intervals.

---

## First-Run Wizard

Triggers once when the user first opens MaintenanceScreen.
Completion tracked via `maintenanceWizardComplete: boolean` in settings AsyncStorage.

**Step 1 — Severe duty:**
> "Is your ProMaster used for heavy hauling or as a camper?"
> [ YES — SEVERE INTERVALS ]  [ NO — STANDARD INTERVALS ]

**Step 2 — Seed service dates (scrollable list):**
> "Enter your last known service dates. Skip anything you don't know."
- One row per active schedule item: label + date picker (blank default)
- "Skip all" link at top to bail immediately

**Step 3 — Summary:**
- Shows computed status for every item
- DONE lands on main schedule view

**Rules:**
- Skipped items → `UNKNOWN` (never `OVERDUE` until user logs a real entry)
- Wizard never re-triggers after `maintenanceWizardComplete = true`
- Back navigation works between all steps

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `mobile/src/services/maintenanceService.ts` | New — all DB ops + status logic |
| `mobile/src/screens/MaintenanceScreen.tsx` | New — schedule, history, log entry sheet |
| `mobile/src/screens/MaintenanceWizard.tsx` | New — 3-step first-run wizard |
| `mobile/src/config/settings.ts` | Add `severeDuty`, `maintenanceWizardComplete` fields |
| `mobile/src/screens/SettingsScreen.tsx` | Add VEHICLE tab with severe duty toggle |
| `mobile/src/screens/DashboardScreen.tsx` | Rename LOG → MAINT LOG, update navigate target |
| `App.tsx` | Add `'maintenance'` to Screen type + render MaintenanceScreen |

---

## Out of Scope (v1)

- Push notifications
- PDF export
- Mileage-based intervals (spark plugs)
- Multi-vehicle support
- vehicle_id in schema
