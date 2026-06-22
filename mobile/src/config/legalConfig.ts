/** Legal copy, version tracking, and AsyncStorage helpers for the disclaimer gate. */

import AsyncStorage from '@react-native-async-storage/async-storage';

// Bump this number whenever the disclaimer text changes in a material way.
// Any user whose stored version is lower will be re-prompted on next launch.
export const DISCLAIMER_VERSION = 1;

export const DISCLAIMER_ACCEPTED_KEY = '@promaster/disclaimerAccepted';

// ---- URLs ---------------------------------------------------------------
// Replace PLACEHOLDER_URL with real URLs before App Store submission.

export const PRIVACY_POLICY_URL = 'PLACEHOLDER_URL';
export const LICENSE_URL = 'PLACEHOLDER_URL';

// ---- Disclaimer text ----------------------------------------------------
// Paste final legal copy here before App Store submission.
// This is the full body shown on the first-launch gate screen.

export const DISCLAIMER_TEXT =
  '[PLACEHOLDER — paste final disclaimer text here before submitting to the App Store.]';

// ---- Clear-codes warning ------------------------------------------------
// Shown every time the user taps CLEAR CODES, independent of the disclaimer gate.
// Edit this string to adjust the wording without changing CodesScreen logic.

export const CLEAR_CODES_WARNING =
  'Clearing codes resets emissions readiness monitors and can hide active problems. ' +
  'Only clear codes after the underlying issue has been diagnosed and repaired. ' +
  'Proceed at your own risk.';

// ---- Storage helpers ----------------------------------------------------

interface DisclaimerRecord {
  version: number;
  acceptedAt: string; // ISO 8601
}

/**
 * Returns { accepted: true } if the stored record version matches or exceeds
 * DISCLAIMER_VERSION. Returns { accepted: false } on any read or parse failure
 * (fail-safe: missing or corrupt record always shows the gate).
 */
export async function loadDisclaimerStatus(): Promise<{ accepted: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(DISCLAIMER_ACCEPTED_KEY);
    if (!raw) return { accepted: false };
    const record = JSON.parse(raw) as DisclaimerRecord;
    return { accepted: record.version >= DISCLAIMER_VERSION };
  } catch {
    return { accepted: false };
  }
}

/** Persist acceptance at the current DISCLAIMER_VERSION with a timestamp. */
export async function saveDisclaimerAccepted(): Promise<void> {
  const record: DisclaimerRecord = {
    version: DISCLAIMER_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(DISCLAIMER_ACCEPTED_KEY, JSON.stringify(record));
}
