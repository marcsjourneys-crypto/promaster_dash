/** Application settings with AsyncStorage persistence. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDefaultEnabledPids } from './pidRegistry';

const STORAGE_KEY = 'promaster_dash_settings';

export type TempUnit = 'F' | 'C';
export type SpeedUnit = 'mph' | 'kph';
export type TransMode = 'auto' | '62TE' | '948TE';

export interface Settings {
  // Temperature thresholds (°F)
  transWarnF: number;
  transCritF: number;
  coolantWarnF: number;
  coolantCritF: number;

  // Voltage thresholds
  voltLow: number;
  voltHigh: number;

  // Oil pressure thresholds (PSI) — low is dangerous
  oilPressureWarnPsi: number;
  oilPressureCritPsi: number;

  // Oil temp thresholds (°F)
  oilTempWarnF: number;
  oilTempCritF: number;

  // Intake air temp thresholds (°F)
  intakeAirWarnF: number;
  intakeAirCritF: number;

  // Fuel trim threshold (%, absolute value)
  fuelTrimWarnPct: number;

  // Trip detection
  tripStartSpeedMph: number;
  tripStopTimeoutMin: number;
  breadcrumbIntervalSec: number;

  // Display
  startNightMode: boolean;
  tempUnit: TempUnit;
  speedUnit: SpeedUnit;

  // Focus mode — up to 3 gauges rendered full-screen
  focusPids: string[];
  focusActive: boolean;

  // Data management
  dataRetentionDays: number;

  // Enabled gauges (PID ids from pidRegistry)
  enabledPids: string[];

  // Maintenance
  severeDuty: boolean;
  maintenanceWizardComplete: boolean;

  // Transmission path: auto-detect or force 62TE (6-spd) / 948TE (9-spd)
  transMode: TransMode;
}

export const DEFAULT_SETTINGS: Settings = {
  transWarnF: 220,
  transCritF: 245,
  coolantWarnF: 240,
  coolantCritF: 255,
  voltLow: 12.2,
  voltHigh: 15,
  oilPressureWarnPsi: 25,
  oilPressureCritPsi: 7,
  oilTempWarnF: 230,
  oilTempCritF: 250,
  intakeAirWarnF: 160,
  intakeAirCritF: 200,
  fuelTrimWarnPct: 10,
  tripStartSpeedMph: 5,
  tripStopTimeoutMin: 5,
  breadcrumbIntervalSec: 5,
  startNightMode: false,
  tempUnit: 'F',
  speedUnit: 'mph',
  focusPids: [],
  focusActive: false,
  dataRetentionDays: 365,
  enabledPids: getDefaultEnabledPids(),
  severeDuty: false,
  maintenanceWizardComplete: false,
  transMode: 'auto',
};

/** Load settings from AsyncStorage, returning defaults for missing keys. */
export async function loadSettings(): Promise<Settings> {
  try {
    const json = await AsyncStorage.getItem(STORAGE_KEY);
    if (json) {
      const stored = JSON.parse(json);
      // Merge with defaults so new keys get default values
      return { ...DEFAULT_SETTINGS, ...stored };
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

/** Save settings to AsyncStorage. */
export async function saveSettings(settings: Settings): Promise<boolean> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    console.warn('Failed to save settings:', e);
    return false;
  }
}

/** Get stop timeout in seconds. */
export function tripStopTimeoutSecs(settings: Settings): number {
  return settings.tripStopTimeoutMin * 60;
}
