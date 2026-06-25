# Trip Fixes and Naming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix trip fragmentation and infinite-duration bugs, add a dashboard End Trip button, and allow naming trips from history.

**Architecture:** Fix the race condition in `tripManager.ts` with an `isRestoring` flag; add a `tickWatchdog()` export called via `setInterval` in `App.tsx`; add `name` column via try/catch ALTER TABLE in `loggingService.ts`; wire the End button into the existing trip bar in `DashboardScreen.tsx`; add inline rename via `Alert.prompt` in `TripsScreen.tsx`.

**Tech Stack:** React Native (Expo), TypeScript, SQLite (expo-sqlite), Zustand (vehicleStore), AsyncStorage

---

### Task 1: Fix restore race condition in tripManager.ts

**Files:**
- Modify: `mobile/src/services/tripManager.ts`

**Step 1: Add `isRestoring` flag**

At the top of the file, after the existing state variables (around line 35), add:

```typescript
let isRestoring = false;
```

**Step 2: Guard `onGpsUpdate`**

In the `onGpsUpdate` function (line 181), add an early return at the very top of the function body:

```typescript
export async function onGpsUpdate(data: GPSData): Promise<void> {
  if (isRestoring) return;
  if (!data.fixOk) return;
  // ... rest unchanged
```

**Step 3: Wrap `restoreTrip` with the flag**

In `restoreTrip()` (line 99), set and clear the flag:

```typescript
export async function restoreTrip(): Promise<boolean> {
  isRestoring = true;
  try {
    // ... existing body unchanged ...
  } catch (e: any) {
    dlog(`Trip: Failed to restore: ${e.message}`);
    await clearPersistedTripState();
    return false;
  } finally {
    isRestoring = false;
  }
}
```

The existing try/catch becomes try/catch/finally. Move `isRestoring = false` into `finally` so it always clears even on error.

**Step 4: Commit**

```
git add mobile/src/services/tripManager.ts
git commit -m "fix: block GPS updates during trip restore to prevent duplicate trips"
```

---

### Task 2: Add staleness watchdog to tripManager.ts

**Files:**
- Modify: `mobile/src/services/tripManager.ts`

**Step 1: Export `tickWatchdog`**

Add this function at the bottom of `tripManager.ts` (after `reset()`):

```typescript
const WATCHDOG_STALE_SECS = 900; // 15 minutes

/**
 * Call on a ~60s interval. If a trip is active but GPS has gone silent
 * for 15+ minutes, force-end it so duration doesn't grow unbounded.
 */
export function tickWatchdog(): void {
  if (state === 'idle') return;
  const now = Date.now() / 1000;
  if (lastUpdateTs > 0 && now - lastUpdateTs > WATCHDOG_STALE_SECS) {
    dlog(`Trip: Watchdog ending stale trip (no GPS for ${((now - lastUpdateTs) / 60).toFixed(0)} min)`);
    forceEndTrip();
  }
}
```

**Step 2: Commit**

```
git add mobile/src/services/tripManager.ts
git commit -m "fix: add watchdog to force-end trips when GPS goes silent for 15+ min"
```

---

### Task 3: Wire watchdog and restoreTrip into App.tsx

**Files:**
- Modify: `mobile/App.tsx`

**Step 1: Import new exports**

Add to the existing import from `loggingService`:

```typescript
import { restoreTrip, tickWatchdog } from './src/services/tripManager';
```

**Step 2: Start watchdog after DB init and trip restore**

Replace the existing `initDatabase().then(...)` block (lines 27-30) with:

```typescript
useEffect(() => {
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  initDatabase().then(async () => {
    await restoreTrip();
    setDbReady(true);
    seedDefaultSchedule().catch(() => {});

    watchdogTimer = setInterval(() => tickWatchdog(), 60_000);
  });

  loadSettings().then((s) => {
    setSettings(s);
    setEnabledPids(s.enabledPids);
  });

  return () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
  };
}, []);
```

Note: `restoreTrip` is already imported from `tripManager` — make sure the import is added at the top. Also `seedDefaultSchedule` stays in the same place.

**Step 3: Commit**

```
git add mobile/App.tsx
git commit -m "feat: restore active trip on startup and run staleness watchdog"
```

---

### Task 4: Add `name` column to trips table in loggingService.ts

**Files:**
- Modify: `mobile/src/services/loggingService.ts`

**Step 1: Run ALTER TABLE migration in `initDatabase`**

After the `await db.execAsync(SCHEMA)` line (line 99) and before `await repairUnfinalizedTrips()`, add:

```typescript
// Add name column if it doesn't exist (safe migration — fails silently if already present)
try {
  await db.execAsync('ALTER TABLE trips ADD COLUMN name TEXT');
} catch (_) {}
```

**Step 2: Add `renameTripEntry` function**

Add after `deleteTrip` (after line 441):

```typescript
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
```

**Step 3: Include `name` in `getRecentTrips`**

In the `getRecentTrips` function, update the SELECT query and type annotation:

The `db.getAllAsync<{...}>` generic type — add `name: string | null` to the object type.

Update the SELECT:
```sql
SELECT id, start_ts, end_ts, distance_mi, duration_secs,
       max_trans_f, max_coolant_f, trans_warn_secs, coolant_warn_secs, avg_speed_mph, name
FROM trips ORDER BY start_ts DESC LIMIT ?
```

Update the `.map()` to include:
```typescript
name: r.name,
```

**Step 4: Commit**

```
git add mobile/src/services/loggingService.ts
git commit -m "feat: add trip name column and renameTripEntry to logging service"
```

---

### Task 5: Add `name` to TripRow type

**Files:**
- Modify: `mobile/src/models/types.ts`

**Step 1: Add field to interface**

In the `TripRow` interface (line 39), add after `avgSpeedMph`:

```typescript
name?: string | null;
```

**Step 2: Commit**

```
git add mobile/src/models/types.ts
git commit -m "feat: add optional name field to TripRow type"
```

---

### Task 6: Add "END" button to dashboard trip bar

**Files:**
- Modify: `mobile/src/screens/DashboardScreen.tsx`

**Step 1: Import `forceEndTrip`**

Add to imports at the top:

```typescript
import { forceEndTrip } from '../services/tripManager';
```

**Step 2: Replace the trip bar JSX**

Find the trip bar block (lines 115-123):

```tsx
{/* ---- Live Trip Bar ---- */}
{tripActive && (
  <View style={styles.tripBar}>
    <Text style={styles.tripLabel}>TRIP</Text>
    <Text style={styles.tripStat}>{tripDistanceMi.toFixed(1)} mi</Text>
    <Text style={styles.tripSep}>|</Text>
    <Text style={styles.tripStat}>{formatTripTime(tripStartTs)}</Text>
  </View>
)}
```

Replace with:

```tsx
{/* ---- Live Trip Bar ---- */}
{tripActive && (
  <View style={styles.tripBar}>
    <Text style={styles.tripLabel}>TRIP</Text>
    <Text style={styles.tripStat}>{tripDistanceMi.toFixed(1)} mi</Text>
    <Text style={styles.tripSep}>|</Text>
    <Text style={styles.tripStat}>{formatTripTime(tripStartTs)}</Text>
    <Pressable style={styles.tripEndBtn} onPress={() => forceEndTrip()}>
      <Text style={styles.tripEndBtnText}>END</Text>
    </Pressable>
  </View>
)}
```

**Step 3: Add styles**

In the StyleSheet, after the `tripSep` style, add:

```typescript
tripEndBtn: {
  marginLeft: 'auto',
  paddingVertical: 2,
  paddingHorizontal: 10,
  borderRadius: 5,
  borderWidth: 1,
  borderColor: 'rgba(180, 35, 25, 0.6)',
},
tripEndBtnText: {
  color: 'rgba(200, 50, 35, 0.9)',
  fontSize: fonts.sizeXs,
  fontWeight: '900',
  letterSpacing: 1,
},
```

**Step 4: Commit**

```
git add mobile/src/screens/DashboardScreen.tsx
git commit -m "feat: add END button to dashboard trip bar"
```

---

### Task 7: Add trip naming to TripsScreen

**Files:**
- Modify: `mobile/src/screens/TripsScreen.tsx`

**Step 1: Import `renameTripEntry` and `Alert`**

`Alert` is already imported. Add `renameTripEntry` to the logging service import:

```typescript
import { getRecentTrips, deleteTrip, getTripBreadcrumbs, renameTripEntry } from '../services/loggingService';
```

**Step 2: Add `handleRename` in `TripsScreen`**

After `handleExport`, add:

```typescript
const handleRename = useCallback((trip: TripRow) => {
  Alert.prompt(
    'Name This Trip',
    'e.g. Colorado to Washington',
    (text) => {
      if (text !== undefined) {
        renameTripEntry(trip.id, text).then(() => loadTrips());
      }
    },
    'plain-text',
    trip.name ?? '',
  );
}, [loadTrips]);
```

**Step 3: Pass `onRename` to `TripItem`**

Update the `TripItem` props interface to include:

```typescript
onRename: (trip: TripRow) => void;
```

Update `TripItem` render in the FlatList to pass the handler:

```tsx
<TripItem
  trip={item}
  expanded={expandedId === item.id}
  onToggle={handleToggle}
  onDelete={handleDelete}
  onExport={handleExport}
  onRename={handleRename}
/>
```

**Step 4: Update `TripItem` component**

Add `onRename` to the destructured props. Replace the trip header `Pressable` wrapper (which currently wraps the whole card for expand/collapse) to show the name or date as tappable:

In the `tripHeader` View, replace the date Text:

```tsx
<Pressable onPress={() => onRename(trip)}>
  {trip.name ? (
    <>
      <Text style={styles.tripName}>{trip.name}</Text>
      <Text style={styles.tripDate}>{formatDate(trip.startTs)}</Text>
    </>
  ) : (
    <Text style={styles.tripDate}>{formatDate(trip.startTs)}</Text>
  )}
</Pressable>
```

The outer `Pressable` for expand/collapse (line 58) stays wrapping the stats area — just not the header date.

**Step 5: Add `tripName` style**

```typescript
tripName: {
  color: colors.amber,
  fontSize: fonts.sizeMd,
  fontWeight: '900',
  marginBottom: 2,
},
```

**Step 6: Commit**

```
git add mobile/src/screens/TripsScreen.tsx
git commit -m "feat: add trip naming via Alert.prompt in trip history"
```

---

### Verification Checklist

- [ ] Fresh app launch: only one trip created when driving starts
- [ ] Kill app mid-trip, relaunch: trip resumes, no duplicate
- [ ] Stop vehicle for 15+ minutes with GPS silent: trip auto-ends (watchdog)
- [ ] Stop vehicle for 10+ minutes with GPS active: trip auto-ends (existing logic)
- [ ] Dashboard trip bar shows END button during active trip
- [ ] Tapping END immediately ends trip, button disappears
- [ ] Trip history: tapping date opens name prompt
- [ ] Entering a name shows it in amber above the date
- [ ] Re-tapping the name pre-fills current name for editing
- [ ] Existing trips without names show date as before (no regression)
