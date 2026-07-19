/**
 * GPS service using expo-location.
 * Replaces Python gpsd + u-blox hardware with CoreLocation (built-in).
 */

import * as Location from 'expo-location';
import type { GPSData } from '../models/types';
import { mpsToMph, metersToFeet } from '../utils/geo';
import { dlog } from './debugLog';

const LOCATION_TASK_NAME = 'background-location-task';
const GRADE_HISTORY_SIZE = 15;

// Elevation history for grade computation
let elevationHistory: Array<{ elevFt: number; distM: number }> = [];
let lastLat: number | null = null;
let lastLon: number | null = null;

/** Compute grade from elevation history (same algorithm as Python version). */
function computeGrade(elevFt: number, lat: number, lon: number): number | null {
  // Calculate distance from last point
  let distM = 0;
  if (lastLat !== null && lastLon !== null) {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat - lastLat);
    const dLon = toRad(lon - lastLon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lastLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
    distM = R * 2 * Math.asin(Math.sqrt(a));
  }
  lastLat = lat;
  lastLon = lon;

  if (distM < 1) return null; // Need meaningful movement

  elevationHistory.push({ elevFt, distM });
  if (elevationHistory.length > GRADE_HISTORY_SIZE) {
    elevationHistory.shift();
  }
  if (elevationHistory.length < 3) return null;

  // Compute grade over the history window
  const first = elevationHistory[0];
  const last = elevationHistory[elevationHistory.length - 1];
  const elevChangeFt = last.elevFt - first.elevFt;
  const totalDistM = elevationHistory.reduce((sum, e) => sum + e.distM, 0);

  if (totalDistM < 10) return null; // Need at least 10m of travel

  const elevChangeM = elevChangeFt * 0.3048;
  const grade = (elevChangeM / totalDistM) * 100;
  return Math.round(grade * 10) / 10;
}

/** Reset grade computation state. */
export function resetGradeHistory(): void {
  elevationHistory = [];
  lastLat = null;
  lastLon = null;
}

/** Request location permissions. Returns true if granted. */
export async function requestPermissions(): Promise<boolean> {
  const { status: foreground } =
    await Location.requestForegroundPermissionsAsync();
  if (foreground !== 'granted') {
    dlog(`GPS: foreground permission = ${foreground} — NOT granted, watcher will not start`);
    return false;
  }

  const { status: background } =
    await Location.requestBackgroundPermissionsAsync();
  dlog(`GPS: permissions ok (foreground=${foreground}, background=${background})`);
  // Background is optional for now — foreground works for active use
  return true;
}

/** Convert expo-location LocationObject to our GPSData. */
function locationToGPSData(loc: Location.LocationObject): GPSData {
  const lat = loc.coords.latitude;
  const lon = loc.coords.longitude;
  const speedMph =
    loc.coords.speed !== null && loc.coords.speed >= 0
      ? Math.round(mpsToMph(loc.coords.speed))
      : null;
  const headingDeg =
    loc.coords.heading !== null && loc.coords.heading >= 0
      ? Math.round(loc.coords.heading)
      : null;
  const elevationFt =
    loc.coords.altitude !== null
      ? Math.round(metersToFeet(loc.coords.altitude))
      : null;

  const gradePct =
    elevationFt !== null ? computeGrade(elevationFt, lat, lon) : null;

  return {
    lat,
    lon,
    speedMph,
    headingDeg,
    elevationFt,
    fixOk: true,
    gradePct,
    timestamp: loc.timestamp,
  };
}

type GPSCallback = (data: GPSData) => void;
let locationSubscription: Location.LocationSubscription | null = null;

// Diagnostic fix counter — logs the first 3 fixes then every 30th, so the
// shareable debug log shows whether CoreLocation is actually delivering.
let fixCount = 0;

/** Start watching location updates. Calls onUpdate with each GPS reading. */
export async function startLocationUpdates(
  onUpdate: GPSCallback,
): Promise<boolean> {
  dlog('GPS: startLocationUpdates() called');
  try {
    const hasPermission = await requestPermissions();
    if (!hasPermission) return false;

    resetGradeHistory();
    fixCount = 0;

    // Guard against subscription leak: if a previous watcher is still
    // registered (e.g. rapid unmount/mount race), remove it before replacing
    // the module-level handle so it can't linger unreferenced.
    if (locationSubscription) {
      dlog('GPS: WARNING — replacing an existing live subscription (leak guard)');
      locationSubscription.remove();
      locationSubscription = null;
    }

    locationSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,    // 1 Hz
        distanceInterval: 0,   // Get updates regardless of distance
      },
      (loc) => {
        fixCount++;
        if (fixCount <= 3 || fixCount % 30 === 0) {
          const c = loc.coords;
          dlog(
            `GPS: fix #${fixCount} speed=${c.speed?.toFixed(1) ?? 'null'}m/s alt=${c.altitude?.toFixed(0) ?? 'null'}m acc=${c.accuracy?.toFixed(0) ?? 'null'}m`,
          );
        }
        const data = locationToGPSData(loc);
        onUpdate(data);
      },
    );

    dlog('GPS: watcher started OK');
    return true;
  } catch (e: any) {
    dlog(`GPS: watcher FAILED to start: ${e.message ?? e}`);
    console.warn('Start location updates failed:', e);
    return false;
  }
}

/** Stop watching location updates. */
export function stopLocationUpdates(): void {
  dlog(`GPS: stopLocationUpdates() called (watcher was ${locationSubscription ? 'live' : 'already stopped'}, ${fixCount} fixes delivered)`);
  if (locationSubscription) {
    locationSubscription.remove();
    locationSubscription = null;
  }
}
