/**
 * Zustand store — single source of truth for vehicle state.
 * Replaces Python VehicleState dataclass + Qt signals.
 */

import { create } from 'zustand';
import type { GPSData, EventRecord } from '../models/types';
import {
  TRANS_WARN,
  TRANS_CRIT,
  COOL_WARN,
  COOL_CRIT,
  VOLT_LOW,
  VOLT_HIGH,
} from '../models/types';
import { formatCodes } from '../data/dtcLookup';

export type AlertPriority = 'none' | 'warning' | 'critical';

/** All OBD gauge fields that can be updated via updateOBD. */
export interface OBDData {
  transF: number | null;
  coolantF: number | null;
  voltageV: number | null;
  rpm: number | null;
  obdSpeedMph: number | null;
  oilPressurePsi: number | null;
  oilTempF: number | null;
  engineLoadPct: number | null;
  intakeAirF: number | null;
  fuelLevelPct: number | null;
  ambientAirF: number | null;
  stftBank1Pct: number | null;
  ltftBank1Pct: number | null;
  stftBank2Pct: number | null;
  ltftBank2Pct: number | null;
}

export interface VehicleStore extends OBDData {
  // GPS
  speedMph: number | null;
  gpsOk: boolean;
  lat: number | null;
  lon: number | null;
  headingDeg: number | null;
  elevationFt: number | null;
  gradePct: number | null;
  climbing: boolean;

  // Trip
  tripActive: boolean;
  currentTripId: number | null;
  tripStartTs: number | null;
  tripDistanceMi: number;

  // DTC
  dtcCount: number;
  activeDtcs: string[];

  // Alerts
  alertMessage: string | null;
  alertPriority: AlertPriority;
  alertHistory: EventRecord[];

  // Connection status
  bleConnected: boolean;

  // Night mode
  nightMode: boolean;

  // Mode 01 PID discovery (for hiding unsupported gauge cards)
  supportedMode01Pids: Set<string>;
  mode01DiscoveryDone: boolean;

  // Actions
  updateGPS: (data: GPSData) => void;
  updateOBD: (data: Partial<OBDData>) => void;
  updateDTCs: (codes: string[]) => void;
  setTripState: (active: boolean, tripId: number | null, startTs: number | null) => void;
  updateTripDistance: (distanceMi: number) => void;
  setBleConnected: (connected: boolean) => void;
  toggleNightMode: () => void;
  pushAlert: (event: EventRecord) => void;
  clearAlert: () => void;
  computeAlert: () => void;
  setSupportedMode01Pids: (pids: Set<string>) => void;
}

export const useVehicleStore = create<VehicleStore>((set, get) => ({
  // Initial state — OBD gauges
  transF: null,
  coolantF: null,
  voltageV: null,
  rpm: null,
  obdSpeedMph: null,
  oilPressurePsi: null,
  oilTempF: null,
  engineLoadPct: null,
  intakeAirF: null,
  fuelLevelPct: null,
  ambientAirF: null,
  stftBank1Pct: null,
  ltftBank1Pct: null,
  stftBank2Pct: null,
  ltftBank2Pct: null,

  // GPS
  speedMph: null,
  gpsOk: false,
  lat: null,
  lon: null,
  headingDeg: null,
  elevationFt: null,
  gradePct: null,
  climbing: false,
  tripActive: false,
  currentTripId: null,
  tripStartTs: null,
  tripDistanceMi: 0,
  dtcCount: 0,
  activeDtcs: [],
  alertMessage: null,
  alertPriority: 'none',
  alertHistory: [],
  bleConnected: false,
  nightMode: false,
  supportedMode01Pids: new Set<string>(),
  mode01DiscoveryDone: false,

  updateGPS: (data: GPSData) =>
    set({
      lat: data.lat,
      lon: data.lon,
      speedMph: data.speedMph,
      headingDeg: data.headingDeg,
      elevationFt: data.elevationFt,
      gpsOk: data.fixOk,
      gradePct: data.gradePct,
      climbing: (data.gradePct ?? 0) > 0.5,
    }),

  updateOBD: (data) => {
    set(data);
    // Recompute alert after OBD update
    get().computeAlert();
  },

  updateDTCs: (codes: string[]) => {
    set({ dtcCount: codes.length, activeDtcs: codes });
    get().computeAlert();
  },

  setTripState: (active, tripId, startTs) =>
    set({
      tripActive: active,
      currentTripId: tripId,
      tripStartTs: startTs,
      tripDistanceMi: active ? 0 : get().tripDistanceMi,
    }),

  updateTripDistance: (distanceMi: number) => set({ tripDistanceMi: distanceMi }),

  setBleConnected: (connected: boolean) => set({ bleConnected: connected }),

  toggleNightMode: () => set((s) => ({ nightMode: !s.nightMode })),

  pushAlert: (event: EventRecord) =>
    set((s) => ({
      alertHistory: [event, ...s.alertHistory].slice(0, 100),
    })),

  clearAlert: () => set({ alertMessage: null, alertPriority: 'none' }),

  /** Recompute the current alert based on priority: DTC > critical temps > warnings > voltage. */
  computeAlert: () => {
    const s = get();

    const fireAlert = (message: string, priority: AlertPriority, severity: 'warning' | 'critical') => {
      // Push to history only when the message changes (avoid duplicate entries)
      if (s.alertMessage !== message) {
        get().pushAlert({
          ts: Date.now() / 1000,
          eventType: 'alert',
          severity,
          message,
          tripId: s.currentTripId,
          lat: s.lat,
          lon: s.lon,
        });
      }
      set({ alertMessage: message, alertPriority: priority });
    };

    // Priority 1: DTCs
    if (s.dtcCount > 0) {
      fireAlert(`CHECK ENGINE: ${formatCodes(s.activeDtcs)}`, 'critical', 'critical');
      return;
    }

    // Priority 2: Critical conditions
    if (s.transF !== null && s.transF >= TRANS_CRIT) {
      fireAlert(`TRANS TEMP CRITICAL: ${s.transF.toFixed(0)}°F`, 'critical', 'critical');
      return;
    }
    if (s.coolantF !== null && s.coolantF >= COOL_CRIT) {
      fireAlert(`COOLANT CRITICAL: ${s.coolantF.toFixed(0)}°F`, 'critical', 'critical');
      return;
    }
    // Oil pressure critical — only when engine running (RPM > 800) to avoid idle false alarms
    if (s.oilPressurePsi !== null && s.rpm !== null && s.rpm > 800 && s.oilPressurePsi <= 10) {
      fireAlert(`OIL PRESSURE CRITICAL: ${s.oilPressurePsi.toFixed(0)} PSI`, 'critical', 'critical');
      return;
    }
    if (s.oilTempF !== null && s.oilTempF >= 270) {
      fireAlert(`OIL TEMP CRITICAL: ${s.oilTempF.toFixed(0)}°F`, 'critical', 'critical');
      return;
    }

    // Priority 3: Warnings
    if (s.transF !== null && s.transF >= TRANS_WARN) {
      fireAlert(`Trans temp warning: ${s.transF.toFixed(0)}°F`, 'warning', 'warning');
      return;
    }
    if (s.coolantF !== null && s.coolantF >= COOL_WARN) {
      fireAlert(`Coolant warning: ${s.coolantF.toFixed(0)}°F`, 'warning', 'warning');
      return;
    }
    if (s.oilPressurePsi !== null && s.rpm !== null && s.rpm > 800 && s.oilPressurePsi <= 20) {
      fireAlert(`Oil pressure low: ${s.oilPressurePsi.toFixed(0)} PSI`, 'warning', 'warning');
      return;
    }
    if (s.oilTempF !== null && s.oilTempF >= 250) {
      fireAlert(`Oil temp warning: ${s.oilTempF.toFixed(0)}°F`, 'warning', 'warning');
      return;
    }
    if (s.intakeAirF !== null && s.intakeAirF >= 180) {
      fireAlert(`INTAKE AIR CRITICAL: ${s.intakeAirF.toFixed(0)}°F`, 'critical', 'critical');
      return;
    }
    if (s.intakeAirF !== null && s.intakeAirF >= 160) {
      fireAlert(`Intake air temp warning: ${s.intakeAirF.toFixed(0)}°F`, 'warning', 'warning');
      return;
    }

    // Priority 4: Voltage abnormal
    if (s.voltageV !== null && s.voltageV < VOLT_LOW) {
      fireAlert(`Battery low: ${s.voltageV.toFixed(1)}V`, 'warning', 'warning');
      return;
    }
    if (s.voltageV !== null && s.voltageV > VOLT_HIGH) {
      fireAlert(`Voltage high: ${s.voltageV.toFixed(1)}V`, 'warning', 'warning');
      return;
    }

    // No alerts
    set({ alertMessage: null, alertPriority: 'none' });
  },

  setSupportedMode01Pids: (pids) => set({ supportedMode01Pids: pids, mode01DiscoveryDone: true }),
}));
