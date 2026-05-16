/**
 * Automatic trip detection and statistics tracking.
 * Direct port of Python TripManager state machine.
 *
 * State machine:
 *   IDLE ──(speed > 5 mph)──> ACTIVE
 *   ACTIVE ──(speed < 1 mph)──> ENDING
 *   ENDING ──(speed > 5 mph)──> ACTIVE
 *   ENDING ──(5 min elapsed)──> IDLE (trip ends)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GPSData } from '../models/types';
import { TRANS_WARN, COOL_WARN } from '../models/types';
import { TripStats } from '../models/TripStats';
import {
  createTrip,
  finalizeTrip,
  logBreadcrumb,
} from './loggingService';
import { useVehicleStore } from '../store/vehicleStore';
import { dlog } from './debugLog';

export type TripState = 'idle' | 'active' | 'ending';

// Configuration
let START_SPEED_THRESHOLD = 5.0;
let STOP_SPEED_THRESHOLD = 1.0;
let STOP_TIMEOUT_SECS = 600; // 10 minutes (was 5 — increased to prevent fragmentation at traffic stops)

// How many consecutive slow readings required before entering ENDING state
const SLOW_COUNT_REQUIRED = 3;

// State
let state: TripState = 'idle';
let stats: TripStats | null = null;
let stopStartTs: number | null = null;
let lastUpdateTs = 0;
let lastStatsEmitTs = 0;
let slowCount = 0; // consecutive below-threshold readings
let isRestoring = false;

const STATS_UPDATE_INTERVAL = 5.0;

// --- Trip state persistence ---

const TRIP_STATE_KEY = '@promaster/activeTripState';

interface PersistedTripState {
  tripId: number;
  startTs: number;
  distanceMi: number;
  maxTransF: number | null;
  maxCoolantF: number | null;
  transWarnSecs: number;
  coolantWarnSecs: number;
  speedSamples: number;
  speedSum: number;
  lastLat: number | null;
  lastLon: number | null;
}

/** Save active trip state to AsyncStorage. Called periodically. */
export async function persistTripState(): Promise<void> {
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
  } catch (e: any) {
    dlog(`Trip: Failed to persist state: ${e.message}`);
  }
}

/** Clear persisted trip state (on normal trip end). */
async function clearPersistedTripState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_STATE_KEY);
  } catch (e: any) {
    dlog(`Trip: Failed to clear persisted state: ${e.message}`);
  }
}

/**
 * Try to restore an active trip from AsyncStorage.
 * Call on app startup before GPS begins.
 * Returns true if a trip was restored.
 */
export async function restoreTrip(): Promise<boolean> {
  isRestoring = true;
  try {
    const raw = await AsyncStorage.getItem(TRIP_STATE_KEY);
    if (!raw) return false;

    const data: PersistedTripState = JSON.parse(raw);

    // Discard trips older than 24 hours — clearly not an ongoing drive.
    const ageHours = (Date.now() / 1000 - data.startTs) / 3600;
    if (ageHours > 24) {
      dlog(`Trip: Persisted trip is ${ageHours.toFixed(0)}h old, discarding`);
      await clearPersistedTripState();
      return false;
    }

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
  } finally {
    isRestoring = false;
  }
}

/** Get current trip state. */
export function getTripState(): TripState {
  return state;
}

/** Get current trip stats. */
export function getTripStats(): TripStats | null {
  return stats;
}

/** Update configuration thresholds. */
export function setTripConfig(config: {
  startSpeed?: number;
  stopTimeout?: number;
}): void {
  if (config.startSpeed !== undefined) START_SPEED_THRESHOLD = config.startSpeed;
  if (config.stopTimeout !== undefined) STOP_TIMEOUT_SECS = config.stopTimeout;
}

/** Process a GPS update — drives the state machine. */
export async function onGpsUpdate(data: GPSData): Promise<void> {
  if (isRestoring) return;
  if (!data.fixOk) return;

  const now = Date.now() / 1000;
  const dt = lastUpdateTs > 0 ? now - lastUpdateTs : 0;
  lastUpdateTs = now;

  const speed = data.speedMph ?? 0;

  if (state === 'idle') {
    await handleIdle(speed, now);
  } else if (state === 'active') {
    await handleActive(data, speed, now);
  } else if (state === 'ending') {
    await handleEnding(data, speed, now);
  }
}

/** Update trip stats with OBD temperature data. Call periodically. */
export function onVehicleStateUpdate(
  transF: number | null,
  coolantF: number | null,
  dt: number,
): void {
  if (!stats) return;
  stats.updateTemps(transF, coolantF, dt, TRANS_WARN, COOL_WARN);
}

async function handleIdle(speed: number, now: number): Promise<void> {
  if (speed >= START_SPEED_THRESHOLD) {
    await startTrip(now);
  }
}

async function handleActive(
  data: GPSData,
  speed: number,
  now: number,
): Promise<void> {
  if (!stats) return;

  // Update distance
  if (data.lat !== null && data.lon !== null) {
    stats.updateDistance(data.lat, data.lon);
  }

  if (speed >= 0) {
    stats.updateSpeed(speed);
  }

  // Log breadcrumb
  await maybeBreadcrumb(data);

  // Require SLOW_COUNT_REQUIRED consecutive slow readings before entering ENDING
  // This prevents brief GPS glitches or traffic light stops from fragmenting trips
  if (speed < STOP_SPEED_THRESHOLD) {
    slowCount++;
    if (slowCount >= SLOW_COUNT_REQUIRED) {
      transitionTo('ending');
      stopStartTs = now;
      slowCount = 0;
    }
  } else {
    slowCount = 0;
    maybeEmitStats(now);
  }
}

async function handleEnding(
  data: GPSData,
  speed: number,
  now: number,
): Promise<void> {
  if (!stats) return;

  // Still update distance
  if (data.lat !== null && data.lon !== null) {
    stats.updateDistance(data.lat, data.lon);
  }

  // Log breadcrumb
  await maybeBreadcrumb(data);

  if (speed >= START_SPEED_THRESHOLD) {
    // Resumed driving
    transitionTo('active');
    stopStartTs = null;
    slowCount = 0;
  } else if (stopStartTs && now - stopStartTs >= STOP_TIMEOUT_SECS) {
    // Been stopped long enough — end trip
    await endTrip(now);
  } else {
    maybeEmitStats(now);
  }
}

async function startTrip(now: number): Promise<void> {
  stats = new TripStats();
  stats.startTs = now;

  const tripId = await createTrip(now);
  if (tripId) {
    stats.tripId = tripId;
  }

  transitionTo('active');
  stopStartTs = null;

  // Update store
  const store = useVehicleStore.getState();
  store.setTripState(true, stats.tripId, now);

  persistTripState(); // fire-and-forget
}

async function endTrip(now: number): Promise<void> {
  await clearPersistedTripState();

  if (!stats) {
    transitionTo('idle');
    return;
  }

  stats.endTs = now;

  if (stats.tripId) {
    await finalizeTrip(stats.tripId, stats);
  }

  // Update store
  const store = useVehicleStore.getState();
  store.updateTripDistance(stats.distanceMi);
  store.setTripState(false, null, null);

  stats = null;
  stopStartTs = null;
  transitionTo('idle');
}

/** Force-end trip (e.g., on app shutdown). */
export async function forceEndTrip(): Promise<void> {
  if (state !== 'idle' && stats) {
    await endTrip(Date.now() / 1000);
  }
}

/** Reset to idle without logging. */
export function reset(): void {
  stats = null;
  stopStartTs = null;
  state = 'idle';
  clearPersistedTripState();
}

function transitionTo(newState: TripState): void {
  state = newState;
}

function maybeEmitStats(now: number): void {
  if (stats && now - lastStatsEmitTs >= STATS_UPDATE_INTERVAL) {
    // Update store with latest trip distance
    const store = useVehicleStore.getState();
    store.updateTripDistance(stats.distanceMi);
    lastStatsEmitTs = now;
    persistTripState(); // fire-and-forget
  }
}

async function maybeBreadcrumb(data: GPSData): Promise<void> {
  if (!stats?.tripId || data.lat === null || data.lon === null) return;

  const store = useVehicleStore.getState();
  await logBreadcrumb({
    tripId: stats.tripId,
    ts: Date.now() / 1000,
    lat: data.lat,
    lon: data.lon,
    elevationFt: data.elevationFt,
    speedMph: data.speedMph,
    headingDeg: data.headingDeg,
    transF: store.transF,
    coolantF: store.coolantF,
    voltageV: store.voltageV,
    gradePct: data.gradePct,
    obdSpeedMph: store.obdSpeedMph,
  });
}
