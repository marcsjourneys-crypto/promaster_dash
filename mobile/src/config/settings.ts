/** Application settings with AsyncStorage persistence. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDefaultEnabledPids } from './pidRegistry';

const STORAGE_KEY = 'promaster_dash_settings';

export type TempUnit = 'F' | 'C';
export type SpeedUnit = 'mph' | 'kph';

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

  // Trip detection
  tripStartSpeedMph: number;
  tripStopTimeoutMin: number;
  breadcrumbIntervalSec: number;

  // Display
  startNightMode: boolean;
  tempUnit: TempUnit;
  speedUnit: SpeedUnit;

  // Data management
  dataRetentionDays: number;

  // Enabled gauges (PID ids from pidRegistry)
  enabledPids: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  transWarnF: 230,
  transCritF: 250,
  coolantWarnF: 220,
  coolantCritF: 230,
  voltLow: 11.5,
  voltHigh: 15,
  oilPressureWarnPsi: 20,
  oilPressureCritPsi: 10,
  oilTempWarnF: 250,
  oilTempCritF: 270,
  intakeAirWarnF: 160,
  intakeAirCritF: 180,
  tripStartSpeedMph: 5,
  tripStopTimeoutMin: 5,
  breadcrumbIntervalSec: 5,
  startNightMode: false,
  tempUnit: 'F',
  speedUnit: 'mph',
  dataRetentionDays: 365,
  enabledPids: getDefaultEnabledPids(),
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
