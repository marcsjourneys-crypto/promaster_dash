/**
 * Hook that starts GPS, feeds updates to the store and trip manager.
 * Replaces the Qt signal wiring: GPS → VehicleState → TripManager → LoggingService.
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useVehicleStore } from '../store/vehicleStore';
import { startLocationUpdates, stopLocationUpdates } from '../services/gpsService';
import { onGpsUpdate, onVehicleStateUpdate, restoreTrip } from '../services/tripManager';
import { initDatabase } from '../services/loggingService';
import type { GPSData } from '../models/types';

/** Initialize GPS + trip tracking pipeline. */
export function useGPS(enabled: boolean) {
  const updateGPS = useVehicleStore((s) => s.updateGPS);
  const lastTickRef = useRef(Date.now() / 1000);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;

    let mounted = true;

    async function start() {
      // Initialize database first
      await initDatabase();

      // Restore any persisted trip from a previous session
      await restoreTrip();

      if (!mounted) return;

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
        console.warn('GPS failed to start — check permissions');
      }
    }

    start();

    // Handle app going to background — force end trip if needed
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (nextState === 'inactive' || nextState === 'background') {
          // Trip manager will continue via background location updates
          // but if the app is killed, we lose in-memory state
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
