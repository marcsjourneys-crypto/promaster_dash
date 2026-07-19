/**
 * Hook that starts GPS, feeds updates to the store and trip manager.
 * Replaces the Qt signal wiring: GPS → VehicleState → TripManager → LoggingService.
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useVehicleStore } from '../store/vehicleStore';
import { startLocationUpdates, stopLocationUpdates } from '../services/gpsService';
import { onGpsUpdate, onVehicleStateUpdate, restoreTrip, persistTripState } from '../services/tripManager';
import { initDatabase } from '../services/loggingService';
import { dlog } from '../services/debugLog';
import type { GPSData } from '../models/types';

/** Initialize GPS + trip tracking pipeline. */
export function useGPS(enabled: boolean) {
  const updateGPS = useVehicleStore((s) => s.updateGPS);
  const lastTickRef = useRef(Date.now() / 1000);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) {
      if (!enabled) dlog('GPS: useGPS mounted with enabled=false — live GPS OFF (demo mode?)');
      return;
    }
    started.current = true;
    dlog('GPS: useGPS pipeline starting (dashboard mounted)');

    let mounted = true;

    async function start() {
      // Initialize database first
      await initDatabase();

      // Restore any persisted trip from a previous session
      await restoreTrip();

      if (!mounted) {
        dlog('GPS: dashboard unmounted during init — watcher NOT started');
        return;
      }

      // Start GPS — each update flows through the pipeline
      const ok = await startLocationUpdates(async (data: GPSData) => {
        if (!mounted) return;

        // 1. Update Zustand store (UI reads from here)
        updateGPS(data);

        // 2. Feed trip manager (handles state machine + breadcrumbs)
        await onGpsUpdate(data);

        // 3. Update temp tracking in trip manager
        const now = Date.now() / 1000;
        const dt = now - lastTickRef.current;
        lastTickRef.current = now;

        const store = useVehicleStore.getState();
        onVehicleStateUpdate(store.transF, store.coolantF, dt);
      });

      if (!ok) {
        dlog('GPS: pipeline start FAILED — no location updates will flow');
        console.warn('GPS failed to start — check permissions');
      }
    }

    start().catch((e: any) => {
      // A throw anywhere in the init chain (db, restore) would previously die
      // silently and leave the watcher unstarted — surface it in the log.
      dlog(`GPS: pipeline start THREW: ${e.message ?? e}`);
    });

    // Persist trip state immediately when app goes to background
    // so minimal data is lost if iOS kills the app
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (nextState === 'background') {
          persistTripState();
        }
      },
    );

    return () => {
      mounted = false;
      stopLocationUpdates();
      subscription.remove();
      started.current = false;
    };
  }, [enabled, updateGPS]);
}
