# Trip Fixes and Naming

**Date:** 2026-05-16

## Problem

1. Multiple trips created for a single drive (race condition on app restore)
2. Trips never end when GPS/OBD goes quiet (state machine freezes)
3. No way to manually end a trip or give trips a meaningful name

## Design

### Bug Fix 1: Restore Race Condition

`restoreTrip()` is async. If `onGpsUpdate` fires before it completes, `handleIdle` sees state as `idle`, detects speed > 5 mph, and creates a duplicate trip on top of the restored one.

**Fix:** Add `isRestoring: boolean` flag in `tripManager.ts`. Set to `true` before `restoreTrip()` runs, `false` when it completes. Guard `onGpsUpdate` to return early while `isRestoring` is true.

### Bug Fix 2: Staleness Watchdog

The 10-minute stop timer only ticks inside `handleEnding`, which only runs on GPS updates. If OBD/GPS goes quiet, state freezes and the trip duration grows unbounded.

**Fix:** Export a `tickWatchdog()` function from `tripManager.ts` that callers invoke on a 60-second interval (via `setInterval` in the app). Inside: if state is not `idle` and `Date.now()/1000 - lastUpdateTs > 900` (15 minutes), call `forceEndTrip()`.

The 60s interval should start after `restoreTrip()` completes and be cleared on app teardown.

### Feature: Dashboard "End Trip" Button

Add a small **"END"** button to the right side of the trip stats bar on the dashboard. Visible only when a trip is active (`vehicleStore.tripActive === true`).

- Tap → calls `forceEndTrip()` → store updates → button disappears
- Styled with `rgba(180, 35, 25, 0.9)` border/text (matches existing delete button style)
- No confirmation dialog (button is small, low accident risk)

### Feature: Trip Naming

**Schema:** Add `name TEXT` column to the `trips` table.

```sql
ALTER TABLE trips ADD COLUMN name TEXT;
```

Run in `initDatabase()` wrapped in try/catch (safe re-run: SQLite errors if column already exists, we swallow it).

**Data layer:**
- Add `name?: string | null` to `TripRow` type in `types.ts`
- Include `name` in `getRecentTrips()` SELECT and mapping
- Add `renameTripEntry(tripId: number, name: string): Promise<boolean>` to `loggingService.ts`

**UI:** In `TripsScreen`, each trip card shows:
- If name is set: name in amber above the date
- If no name: date only (current behavior)
- Tapping the name/date opens `Alert.prompt` (iOS native) to enter/edit name
- On confirm: calls `renameTripEntry`, updates local state

## Files Changed

| File | Change |
|------|--------|
| `mobile/src/services/tripManager.ts` | `isRestoring` flag, `tickWatchdog()` export |
| `mobile/src/services/loggingService.ts` | ALTER TABLE migration, `renameTripEntry()`, name in getRecentTrips |
| `mobile/src/models/types.ts` | `name` field on `TripRow` |
| `mobile/src/screens/TripsScreen.tsx` | Name display + Alert.prompt rename UI |
| App startup file | Start watchdog interval after restore |
| Dashboard screen/component | "END" button in trip stats bar |
