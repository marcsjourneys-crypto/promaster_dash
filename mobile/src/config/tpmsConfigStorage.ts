/** AsyncStorage persistence for the TPMS config (model in tpmsConfig.ts). */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeTpmsConfig, DEFAULT_TPMS_CONFIG, type TpmsConfig } from './tpmsConfig';

const STORAGE_KEY = '@promaster/tpmsConfig';

export async function loadTpmsConfig(): Promise<TpmsConfig> {
  try {
    const json = await AsyncStorage.getItem(STORAGE_KEY);
    if (json) return normalizeTpmsConfig(JSON.parse(json));
  } catch (e) {
    console.warn('Failed to load TPMS config:', e);
  }
  return { ...DEFAULT_TPMS_CONFIG };
}

export async function saveTpmsConfig(config: TpmsConfig): Promise<boolean> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    console.warn('Failed to save TPMS config:', e);
    return false;
  }
}
