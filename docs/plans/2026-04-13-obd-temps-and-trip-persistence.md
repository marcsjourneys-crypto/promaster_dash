# OBD Temperature Fixes + Trip Persistence Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix incorrect trans/coolant temperature readings and prevent trips from restarting when the phone locks.

**Architecture:** Three independent fixes: (1) correct the trans temp formula to `(A*256+B)/64` = direct Fahrenheit per ProMaster forum-confirmed ScanGauge codes, reorder candidates to prefer 11-bit; (2) flush the ELM327 receive buffer after CAN header switches to prevent stale coolant reads; (3) persist trip state to AsyncStorage so the trip manager can resume after app background/kill instead of force-ending.

**Tech Stack:** React Native, TypeScript, AsyncStorage, Zustand, ELM327/STN1170 AT commands

---

### Task 1: Fix trans temp formula and candidate list

**Files:**
- Modify: `mobile/src/services/obdParser.ts:204-210` (transTempToF)
- Modify: `mobile/src/services/transTempCandidates.ts:19-62` (CANDIDATES array)

**Step 1: Fix `transTempToF()` two-byte formula**

The confirmed formula for DID B010/9110 on the ProMaster 62TE is `(A*256+B)/64` which yields Fahrenheit directly (no C-to-F conversion). Sources: ScanGauge XGauge code `MTH: 000100400000` (divide by 0x40=64), OBD Fusion community configs.

In `obdParser.ts`, change `transTempToF()`:

```typescript
/**
 * Mode 22 trans temp.
 * B010/9110: (A*256+B)/64 → °F directly (confirmed via ScanGauge XGauge).
 * Fallback single-byte: (A - 40) * 1.8 + 32.
 */
export function transTempToF(bytes: number[], twoByteMode = false): number {
  if (twoByteMode && bytes.length >= 2) {
    return (bytes[0] * 256 + bytes[1]) / 64;
  }
  return ((bytes[0] - 40) * 9) / 5 + 32;
}
```

**Step 2: Update candidates — mark B010/9110 as twoByteMode, reorder to prefer 11-bit**

In `transTempCandidates.ts`, update CANDIDATES:

```typescript
export const CANDIDATES: TransTempCandidate[] = [
  // Prefer 11-bit to avoid 29-bit/11-bit protocol switching issues
  {
    name: 'PCM 11-bit B010',
    header: '7E0',
    did: 'B010',
    twoByteMode: true,
    notes: 'Standard 11-bit CAN — preferred (avoids header switching)',
  },
  {
    name: 'PCM 29-bit B010',
    header: '18DA10F1',
    did: 'B010',
    twoByteMode: true,
    notes: 'PCM via 29-bit extended CAN',
  },
  {
    name: 'TCM 29-bit B010',
    header: '18DA18F1',
    did: 'B010',
    twoByteMode: true,
    notes: 'TCM via 29-bit extended CAN',
  },
  {
    name: 'TCM 29-bit 9110',
    header: '18DA18F1',
    did: '9110',
    twoByteMode: true,
    notes: 'Alternate TCM DID — confirmed via Linear Logic ScanGauge code',
  },
  {
    name: 'PCM 29-bit 1C44',
    header: '18DA10F1',
    did: '1C44',
    twoByteMode: true,
    notes: 'PCM alternate DID, two-byte',
  },
  {
    name: 'PCM 11-bit 08DF',
    header: '7E0',
    did: '08DF',
    twoByteMode: true,
    notes: 'Standard 11-bit, two-byte',
  },
];
```

Key changes:
- **All** candidates now `twoByteMode: true` (research confirms all use 2-byte responses)
- `PCM 11-bit B010` moved to first position (preferred — no 29-bit switching)
- Old saved candidates in AsyncStorage will still work but will use the wrong formula until re-scanned

**Step 3: Clear saved trans candidate to force re-scan with new formula**

In `obdService.ts`, add a migration check. After `loadTransCandidate()`, if the loaded candidate has `twoByteMode === false`, clear it so the user re-scans:

In `BLEScreen.tsx` (or wherever `loadTransCandidate` is called during connect), add after loading:

```typescript
const saved = await loadTransCandidate();
if (saved && saved.twoByteMode === false) {
  // Old formula — clear so user re-scans with corrected twoByteMode
  dlog('Trans: Clearing stale candidate (twoByteMode was false, needs re-scan)');
  await AsyncStorage.removeItem('@promaster/transCandidate');
  setTransCandidate(null);
} else if (saved) {
  setTransCandidate(saved);
}
```

**Step 4: Commit**

```bash
git add mobile/src/services/obdParser.ts mobile/src/services/transTempCandidates.ts mobile/src/screens/BLEScreen.tsx
git commit -m "fix: correct trans temp formula to (A*256+B)/64 direct Fahrenheit

Confirmed via ScanGauge XGauge codes and OBD Fusion configs on ProMaster
forums. All B010/9110 candidates return 2 bytes. Reorder candidates to
prefer 11-bit (7E0) to avoid 29-bit header switching issues."
```

---

### Task 2: Flush adapter buffer after CAN header switches

**Files:**
- Modify: `mobile/src/services/obdService.ts:397-399` (pollTransTemp reset)
- Modify: `mobile/src/services/obdService.ts:461-463` (pollMode22Pid reset)

**Step 1: Add buffer flush after header reset in `pollTransTemp()`**

After resetting the header to `7DF`, send a dummy `AT` command to flush any stale CAN frames from the receive buffer. Replace the reset block:

```typescript
  // Reset header to default and flush adapter receive buffer.
  // Without the flush, the next Mode 01 poll can pick up stale data
  // from the previous 29-bit CAN context.
  await sendCommand('ATSH7DF', 1500);
  await sendCommand('ATAR', 1500);  // Auto-set receive address for new header
```

**Step 2: Same flush in `pollMode22Pid()`**

Apply the same fix to the generic Mode 22 handler:

```typescript
  // Reset header to default + flush
  await sendCommand('ATSH7DF', 1500);
  await sendCommand('ATAR', 1500);
```

**Step 3: Commit**

```bash
git add mobile/src/services/obdService.ts
git commit -m "fix: flush adapter buffer after CAN header switches

Send ATAR after ATSH7DF to reset the receive address filter. Prevents
stale 29-bit CAN frames from contaminating subsequent 11-bit Mode 01
responses (was causing ~30F-too-high coolant readings)."
```

---

### Task 3: Persist trip state across app background/kill

**Files:**
- Modify: `mobile/src/services/tripManager.ts` (add persistence)
- Modify: `mobile/src/hooks/useGPS.ts` (restore trip on mount, don't force-end on background)
- Modify: `mobile/src/services/loggingService.ts` (add query for unfinalized trips)

**Problem:** The `useGPS` hook cleanup calls `forceEndTrip()`, which ends the active trip whenever the component unmounts or the app is killed. When the phone locks, iOS may suspend/kill the app. On relaunch, all in-memory trip state is gone, so a brand new trip starts.

**Solution:** Persist enough trip state to AsyncStorage that the trip manager can resume. On app start, check for an unfinalized trip in the database and restore the trip manager state.

**Step 1: Add trip state persistence to tripManager.ts**

Add save/load functions using AsyncStorage:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

const TRIP_STATE_KEY = '@promaster/activeTripState';

interface PersistedTripState {
  tripId: number;
  startTs: number;
  distanceMi: number;
  maxTransF: number;
  maxCoolantF: number;
  transWarnSecs: number;
  coolantWarnSecs: number;
  speedSamples: number;
  speedSum: number;
  lastLat: number | null;
  lastLon: number | null;
}

/** Save active trip state to AsyncStorage. Called periodically. */
async function persistTripState(): Promise<void> {
  if (!stats || !stats.tripId) return;
  const data: PersistedTripState = {
    tripId: stats.tripId,
    startTs: stats.startTs,
    distanceMi: stats.distanceMi,
    maxTransF: stats.maxTransF,
    maxCoolantF: stats.maxCoolantF,
    transWarnSecs: stats.transWarnSecs,
    coolantWarnSecs: stats.coolantWarnSecs,
    speedSamples: stats.speedSamples,
    speedSum: stats.speedSum,
    lastLat: stats.lastLat,
    lastLon: stats.lastLon,
  };
  try {
    await AsyncStorage.setItem(TRIP_STATE_KEY, JSON.stringify(data));
  } catch {}
}

/** Clear persisted trip state (on normal trip end). */
async function clearPersistedTripState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_STATE_KEY);
  } catch {}
}

/**
 * Try to restore an active trip from AsyncStorage.
 * Call on app startup before GPS begins.
 * Returns true if a trip was restored.
 */
export async function restoreTrip(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_STATE_KEY);
    if (!raw) return false;

    const data: PersistedTripState = JSON.parse(raw);

    // Restore TripStats
    stats = new TripStats();
    stats.tripId = data.tripId;
    stats.startTs = data.startTs;
    stats.distanceMi = data.distanceMi;
    stats.maxTransF = data.maxTransF;
    stats.maxCoolantF = data.maxCoolantF;
    stats.transWarnSecs = data.transWarnSecs;
    stats.coolantWarnSecs = data.coolantWarnSecs;
    stats.speedSamples = data.speedSamples;
    stats.speedSum = data.speedSum;
    stats.lastLat = data.lastLat;
    stats.lastLon = data.lastLon;

    // Resume in active state
    state = 'active';
    stopStartTs = null;
    slowCount = 0;

    // Update store
    const store = useVehicleStore.getState();
    store.setTripState(true, stats.tripId, stats.startTs);
    store.updateTripDistance(stats.distanceMi);

    dlog(`Trip: Restored active trip #${stats.tripId} (started ${new Date(stats.startTs * 1000).toLocaleTimeString()}, ${stats.distanceMi.toFixed(1)} mi)`);
    return true;
  } catch (e: any) {
    dlog(`Trip: Failed to restore: ${e.message}`);
    await clearPersistedTripState();
    return false;
  }
}
```

**Step 2: Call `persistTripState()` periodically**

In the existing `maybeEmitStats()` function (already called every 5 seconds during active trips), add the persist call:

```typescript
function maybeEmitStats(now: number): void {
  if (stats && now - lastStatsEmitTs >= STATS_UPDATE_INTERVAL) {
    const store = useVehicleStore.getState();
    store.updateTripDistance(stats.distanceMi);
    lastStatsEmitTs = now;
    persistTripState(); // fire-and-forget
  }
}
```

Also persist on state transitions — call `persistTripState()` at the end of `startTrip()`.

**Step 3: Call `clearPersistedTripState()` in `endTrip()`**

In the existing `endTrip()` function, add before resetting stats:

```typescript
await clearPersistedTripState();
```

**Step 4: Expose TripStats fields for restoration**

In `mobile/src/models/TripStats.ts`, ensure `lastLat`, `lastLon`, `speedSamples`, and `speedSum` are public (they likely already are as class fields). Verify they exist and are writable.

**Step 5: Update `useGPS` hook — restore trip on mount, don't force-end on background**

Replace the cleanup logic in `useGPS.ts`:

```typescript
import { onGpsUpdate, onVehicleStateUpdate, restoreTrip } from '../services/tripManager';

// In the start() function, after initDatabase():
await initDatabase();
if (!mounted) return;

// Try to restore an active trip from a previous session
await restoreTrip();

// Start GPS...
```

Remove `forceEndTrip()` from the cleanup function. The trip should survive background/kill:

```typescript
return () => {
  mounted = false;
  stopLocationUpdates();
  // Don't force-end trip — it persists to AsyncStorage and resumes on next launch
  subscription.remove();
  started.current = false;
};
```

Remove the `forceEndTrip` import if it's no longer used in this file.

**Step 6: Commit**

```bash
git add mobile/src/services/tripManager.ts mobile/src/hooks/useGPS.ts mobile/src/models/TripStats.ts
git commit -m "fix: persist trip state across app background/kill

Save active trip state to AsyncStorage every 5 seconds. On app restart,
restore the trip manager from persisted state instead of starting a new
trip. Removes forceEndTrip on unmount so trips survive phone lock."
```

---

## Verification

After all three tasks, test by:
1. Connect to VLinker MS, start driving
2. Check debug log: trans temp should now show reasonable values (e.g., 160-200F at operating temp, not wild numbers)
3. Check coolant temp matches another OBD app (e.g., Torque, OBD Fusion)
4. Lock the phone, wait 30 seconds, unlock — trip should continue with accumulated distance/time, not restart
5. Force-kill the app, reopen — trip should resume
