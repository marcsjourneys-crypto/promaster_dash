/**
 * OBD service — polling loop that reads vehicle data over BLE.
 *
 * Polling is driven by the PID registry + user-enabled PIDs from settings.
 * RPM, Speed, and DTCs are always polled. All other PIDs are configurable.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendCommand, isConnected } from './obdTransport';
import { dlog } from './debugLog';
import {
  parseMode01,
  parseMode03,
  parseMode22,
  parseVoltage,
  coolantToF,
  bytesToRPM,
  obdSpeedToMph,
  transTempToF,
  bytesToLoadPct,
  bytesToMapKpa,
  bytesToTimingAdv,
  intakeAirToF,
  bytesToMafGps,
  bytesToThrottlePct,
  bytesToFuelLevelPct,
  ambientAirToF,
  bytesToAccelPedalPct,
  bytesToOilPressurePsi,
  bytesToOilTempF,
  isNoData,
} from './obdParser';
import { useVehicleStore } from '../store/vehicleStore';
import type { OBDData } from '../store/vehicleStore';
import { PID_REGISTRY, type PidDef } from '../config/pidRegistry';
import type { TransTempCandidate } from './transTempCandidates';

const TRANS_CANDIDATE_KEY = '@promaster/transCandidate';

/** Persist the winning trans temp candidate to AsyncStorage. */
export async function saveTransCandidate(candidate: TransTempCandidate): Promise<void> {
  try {
    await AsyncStorage.setItem(TRANS_CANDIDATE_KEY, JSON.stringify(candidate));
    dlog(`Trans: Saved candidate "${candidate.name}" to storage`);
  } catch (e: any) {
    dlog(`Trans: Failed to save candidate: ${e.message}`);
  }
}

/** Clear saved trans candidate (e.g., when migration requires re-scan). */
export async function clearTransCandidate(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRANS_CANDIDATE_KEY);
    dlog('Trans: Cleared saved candidate from storage');
  } catch (e: any) {
    dlog(`Trans: Failed to clear candidate: ${e.message}`);
  }
}

/** Load the previously saved trans temp candidate from AsyncStorage. */
export async function loadTransCandidate(): Promise<TransTempCandidate | null> {
  try {
    const raw = await AsyncStorage.getItem(TRANS_CANDIDATE_KEY);
    if (!raw) {
      dlog('Trans: No saved candidate in AsyncStorage');
      return null;
    }
    const c = JSON.parse(raw) as TransTempCandidate;
    dlog(`Trans: Loaded saved candidate "${c.name}" (header=${c.header}, DID=${c.did}) from storage`);
    return c;
  } catch (e: any) {
    dlog(`Trans: Failed to load candidate from storage: ${e.message}`);
    return null;
  }
}

// Always-polled intervals (ms)
const INTERVAL_RPM = 500;
const INTERVAL_SPEED = 1000;
const INTERVAL_DTC = 15000;

// Reconnect tracking
const MAX_CONSECUTIVE_FAILURES = 15;
let consecutiveFailures = 0;

// Schedule state
let nextDue: Record<string, number> = {};
let running = false;
let pollingTimer: ReturnType<typeof setTimeout> | null = null;

// Working trans temp candidate (set after discovery)
let transCandidate: TransTempCandidate | null = null;

// Enabled PIDs (set from settings before polling starts)
let enabledPidIds: Set<string> = new Set();

// Stale-response detection for coolant
let lastCoolantRaw = '';
let coolantSameCount = 0;

/** Set the working trans temp candidate after discovery. */
export function setTransCandidate(candidate: TransTempCandidate | null): void {
  transCandidate = candidate;
}

/** Get the current trans candidate. */
export function getTransCandidate(): TransTempCandidate | null {
  return transCandidate;
}

/** Set the enabled PID list (call before startPolling). */
export function setEnabledPids(pidIds: string[]): void {
  enabledPidIds = new Set(pidIds);
  dlog(`OBD: Enabled PIDs: [${pidIds.join(', ')}]`);
}

/** Check if a PID is enabled for polling. */
function isPidEnabled(pidId: string): boolean {
  return enabledPidIds.has(pidId);
}

/** Initialize the ELM327 adapter over BLE. */
export async function initializeAdapter(): Promise<boolean> {
  try {
    dlog('OBD: Sending ATZ (reset)...');
    await sendCommand('ATZ', 5000);
    await sleep(500);

    dlog('OBD: Configuring adapter...');
    await sendCommand('ATE0', 2000);  // Echo off
    await sendCommand('ATL0', 2000);  // Linefeeds off
    await sendCommand('ATS0', 2000);  // Spaces off
    await sendCommand('ATH0', 2000);  // Headers off (simpler parsing)
    await sendCommand('ATSP0', 2000); // Auto protocol
    await sendCommand('ATST7D', 2000); // Timeout ~500ms
    await sendCommand('ATAR', 2000);   // Reset adaptive timing

    // Validate connection
    dlog('OBD: Reading voltage (ATRV)...');
    const voltage = await sendCommand('ATRV', 2000);
    const v = parseVoltage(voltage);
    if (v !== null) {
      dlog(`OBD: Voltage = ${v.toFixed(1)}V`);
      const store = useVehicleStore.getState();
      store.updateOBD({ voltageV: v });
    } else {
      dlog(`OBD: Voltage parse failed, raw: "${voltage}"`);
    }

    // Test Mode 01 with RPM
    dlog('OBD: Testing RPM (010C)...');
    const rpmResp = await sendCommand('010C', 3000);
    if (isNoData(rpmResp)) {
      dlog('OBD: No RPM on auto protocol, trying ATSP6 (CAN 11-bit 500k)...');
      await sendCommand('ATSP6', 2000);
      const retry = await sendCommand('010C', 3000);
      if (isNoData(retry)) {
        dlog('OBD: No RPM response on any protocol (vehicle may be off)');
      } else {
        dlog('OBD: RPM OK on protocol 6');
      }
    } else {
      dlog('OBD: RPM OK');
    }

    consecutiveFailures = 0;
    dlog('OBD: Adapter init complete');
    return true;
  } catch (e: any) {
    dlog(`OBD: Init failed: ${e.message}`);
    return false;
  }
}

/** Build the polling schedule from the PID registry + enabled PIDs. */
function buildSchedule(): { id: string; intervalMs: number }[] {
  const schedule: { id: string; intervalMs: number }[] = [
    { id: 'rpm', intervalMs: INTERVAL_RPM },
    { id: 'speed', intervalMs: INTERVAL_SPEED },
  ];

  // Add enabled PIDs from registry, sorted by display order (priority)
  const sorted = [...PID_REGISTRY].sort((a, b) => a.displayOrder - b.displayOrder);
  for (const pid of sorted) {
    if (isPidEnabled(pid.id)) {
      // Trans temp needs a discovered candidate
      if (pid.id === 'transF' && !transCandidate) continue;
      schedule.push({ id: pid.id, intervalMs: pid.intervalMs });
    }
  }

  // DTCs always last
  schedule.push({ id: 'dtc', intervalMs: INTERVAL_DTC });
  return schedule;
}

/** Start the polling loop. */
export function startPolling(): void {
  if (running) return;
  running = true;

  const now = Date.now();
  const schedule = buildSchedule();
  nextDue = {};
  for (const entry of schedule) {
    nextDue[entry.id] = now;
  }

  pollTick();
}

/** Stop the polling loop. */
export function stopPolling(): void {
  running = false;
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

/** Single poll iteration — send one request per tick. */
async function pollTick(): Promise<void> {
  if (!running || !isConnected()) {
    running = false;
    return;
  }

  const now = Date.now();
  let polled = false;

  try {
    const schedule = buildSchedule();

    for (const entry of schedule) {
      if (nextDue[entry.id] === undefined) {
        nextDue[entry.id] = now;
      }
      if (now >= nextDue[entry.id]) {
        await executePoll(entry.id);
        nextDue[entry.id] = now + entry.intervalMs;
        polled = true;
        break; // One poll per tick
      }
    }

    if (polled) {
      consecutiveFailures = 0;
    }
  } catch (e: any) {
    consecutiveFailures++;
    dlog(`OBD: Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      dlog('OBD: Too many failures, stopping polling');
      stopPolling();
      const store = useVehicleStore.getState();
      store.setBleConnected(false);
      return;
    }
  }

  // Schedule next tick — ~60ms between requests for BLE
  if (running) {
    pollingTimer = setTimeout(pollTick, polled ? 60 : 30);
  }
}

// ---------------------------------------------------------------------------
// Poll dispatching
// ---------------------------------------------------------------------------

/** Execute a single poll by PID id. */
async function executePoll(id: string): Promise<void> {
  switch (id) {
    case 'rpm':          return pollRPM();
    case 'speed':        return pollSpeed();
    case 'dtc':          return pollDTCs();
    case 'transF':       return pollTransTemp();
    case 'coolantF':     return pollCoolant();
    case 'voltageV':     return pollVoltage();
    case 'oilPressurePsi': return pollMode22Pid('oilPressurePsi');
    case 'oilTempF':     return pollMode22Pid('oilTempF');
    default:             return pollMode01Pid(id);
  }
}

// ---------------------------------------------------------------------------
// Always-polled: RPM, Speed, DTCs
// ---------------------------------------------------------------------------

async function pollRPM(): Promise<void> {
  const resp = await sendCommand('010C', 2000);
  const bytes = parseMode01(resp, '0C');
  if (bytes && bytes.length >= 2) {
    const rpm = bytesToRPM(bytes);
    useVehicleStore.getState().updateOBD({ rpm });
  }
}

async function pollSpeed(): Promise<void> {
  const resp = await sendCommand('010D', 2000);
  const bytes = parseMode01(resp, '0D');
  if (bytes && bytes.length >= 1) {
    const speed = obdSpeedToMph(bytes);
    useVehicleStore.getState().updateOBD({ obdSpeedMph: speed });
  }
}

// Track last two DTC results for debounce (only report when 2 consecutive polls agree)
let lastDtcCodes: string[] = [];
let dtcConfirmCount = 0;

async function pollDTCs(): Promise<void> {
  const resp = await sendCommand('03', 3000);
  dlog(`OBD: DTC raw: "${resp}"`);
  const codes = parseMode03(resp);
  if (codes.length > 0) {
    dlog(`OBD: DTC parsed: [${codes.join(', ')}]`);
  }

  // Debounce: require 2 consecutive polls with same non-empty result before reporting
  const codesKey = codes.sort().join(',');
  const lastKey = lastDtcCodes.sort().join(',');

  if (codesKey === lastKey && codes.length > 0) {
    dtcConfirmCount++;
    if (dtcConfirmCount >= 2) {
      useVehicleStore.getState().updateDTCs(codes);
    }
  } else {
    lastDtcCodes = codes;
    dtcConfirmCount = codes.length > 0 ? 1 : 0;
    if (codes.length === 0) {
      useVehicleStore.getState().updateDTCs([]);
    }
  }
}

// ---------------------------------------------------------------------------
// Special handlers: Coolant (stale detection), Trans (header switch), Voltage
// ---------------------------------------------------------------------------

async function pollCoolant(): Promise<void> {
  // Direct to ECM to avoid multi-ECU response ambiguity on 7DF broadcast
  await sendCommand('ATSH7E0', 1500);

  const resp = await sendCommand('0105', 2000);
  dlog(`OBD: Coolant raw: "${resp}"`);
  const bytes = parseMode01(resp, '05');
  if (bytes && bytes.length >= 1) {
    const tempF = coolantToF(bytes);
    dlog(`OBD: Coolant bytes[0]=0x${bytes[0].toString(16).padStart(2, '0').toUpperCase()} \u2192 ${tempF.toFixed(1)}\u00b0F`);
    if (resp === lastCoolantRaw) {
      coolantSameCount++;
      if (coolantSameCount >= 5) {
        dlog(`OBD: WARNING \u2014 coolant raw unchanged for ${coolantSameCount} polls (possible adapter cache)`);
      }
    } else {
      coolantSameCount = 0;
      lastCoolantRaw = resp;
    }
    useVehicleStore.getState().updateOBD({ coolantF: tempF });
  } else {
    dlog(`OBD: Coolant parse FAILED for raw: "${resp}"`);
  }

  // Reset header to broadcast default + flush
  await sendCommand('ATSH7DF', 1500);
  await sendCommand('ATAR', 1500);
}

async function pollVoltage(): Promise<void> {
  const resp = await sendCommand('ATRV', 2000);
  dlog(`OBD: Voltage raw: "${resp}"`);
  const v = parseVoltage(resp);
  if (v !== null) {
    dlog(`OBD: Voltage = ${v.toFixed(1)}V`);
    useVehicleStore.getState().updateOBD({ voltageV: v });
  } else {
    dlog(`OBD: Voltage parse failed`);
  }
}

let transNullLogCount = 0;

async function pollTransTemp(): Promise<void> {
  if (!transCandidate) {
    transNullLogCount++;
    // Log every 10th skip to avoid flooding
    if (transNullLogCount <= 3 || transNullLogCount % 10 === 0) {
      dlog(`OBD: Trans SKIPPED — no candidate set (skip #${transNullLogCount}). Run SCAN TRANS TEMP on BLE screen.`);
    }
    return;
  }
  transNullLogCount = 0;

  // Set header for this candidate
  await sendCommand(`ATSH${transCandidate.header}`, 1500);

  const resp = await sendCommand(`22${transCandidate.did}`, 2500);
  dlog(`OBD: Trans raw: "${resp}"`);
  const bytes = parseMode22(resp, transCandidate.did);

  if (bytes && bytes.length >= 1) {
    const hexBytes = bytes.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    dlog(`OBD: Trans bytes=[${hexBytes}]`);
    const tempF = transTempToF(bytes, transCandidate.twoByteMode);
    dlog(`OBD: Trans = ${tempF.toFixed(1)}\u00b0F`);
    if (tempF >= -40 && tempF <= 400) {
      useVehicleStore.getState().updateOBD({ transF: tempF });
    }
  } else {
    dlog(`OBD: Trans parse FAILED for raw: "${resp}"`);
  }

  // Reset header to default and flush adapter receive buffer.
  // Without the flush, the next Mode 01 poll can pick up stale data
  // from the previous 29-bit CAN context.
  await sendCommand('ATSH7DF', 1500);
  await sendCommand('ATAR', 1500);
}

// ---------------------------------------------------------------------------
// Generic Mode 01 polling
// ---------------------------------------------------------------------------

/** PID-to-converter mapping for standard Mode 01 PIDs. */
const MODE01_CONVERTERS: Record<string, { pid: string; minBytes: number; convert: (b: number[]) => number; storeKey: keyof OBDData }> = {
  engineLoadPct:  { pid: '04', minBytes: 1, convert: bytesToLoadPct,      storeKey: 'engineLoadPct' },
  intakeMapKpa:   { pid: '0B', minBytes: 1, convert: bytesToMapKpa,       storeKey: 'intakeMapKpa' },
  timingAdvDeg:   { pid: '0E', minBytes: 1, convert: bytesToTimingAdv,    storeKey: 'timingAdvDeg' },
  intakeAirF:     { pid: '0F', minBytes: 1, convert: intakeAirToF,        storeKey: 'intakeAirF' },
  mafGps:         { pid: '10', minBytes: 2, convert: bytesToMafGps,       storeKey: 'mafGps' },
  throttlePct:    { pid: '11', minBytes: 1, convert: bytesToThrottlePct,  storeKey: 'throttlePct' },
  fuelLevelPct:   { pid: '2F', minBytes: 1, convert: bytesToFuelLevelPct, storeKey: 'fuelLevelPct' },
  ambientAirF:    { pid: '46', minBytes: 1, convert: ambientAirToF,       storeKey: 'ambientAirF' },
  accelPedalPct:  { pid: '49', minBytes: 1, convert: bytesToAccelPedalPct, storeKey: 'accelPedalPct' },
};

async function pollMode01Pid(id: string): Promise<void> {
  const conv = MODE01_CONVERTERS[id];
  if (!conv) {
    dlog(`OBD: Unknown PID id "${id}"`);
    return;
  }

  const resp = await sendCommand(`01${conv.pid}`, 2000);
  const bytes = parseMode01(resp, conv.pid);
  if (bytes && bytes.length >= conv.minBytes) {
    const value = conv.convert(bytes);
    const hexBytes = bytes.slice(0, conv.minBytes).map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    dlog(`OBD: ${id} bytes=[${hexBytes}] → ${value.toFixed(1)}`);
    useVehicleStore.getState().updateOBD({ [conv.storeKey]: value } as Partial<OBDData>);
  } else {
    dlog(`OBD: ${id} parse FAILED for raw: "${resp}"`);
  }
}

// ---------------------------------------------------------------------------
// Generic Mode 22 polling (oil pressure, oil temp)
// ---------------------------------------------------------------------------

const MODE22_CONVERTERS: Record<string, { did: string; header: string; minBytes: number; convert: (b: number[]) => number; storeKey: keyof OBDData }> = {
  oilPressurePsi: { did: '022A', header: '18DA10F1', minBytes: 1, convert: bytesToOilPressurePsi, storeKey: 'oilPressurePsi' },
  oilTempF:       { did: '0121', header: '7E0',      minBytes: 1, convert: bytesToOilTempF,       storeKey: 'oilTempF' },
};

async function pollMode22Pid(id: string): Promise<void> {
  const conv = MODE22_CONVERTERS[id];
  if (!conv) return;

  // Set header
  await sendCommand(`ATSH${conv.header}`, 1500);

  const resp = await sendCommand(`22${conv.did}`, 2500);
  dlog(`OBD: ${id} raw: "${resp}"`);
  const bytes = parseMode22(resp, conv.did);

  if (bytes && bytes.length >= conv.minBytes) {
    const value = conv.convert(bytes);
    dlog(`OBD: ${id} = ${value.toFixed(1)}`);
    useVehicleStore.getState().updateOBD({ [conv.storeKey]: value } as Partial<OBDData>);
  } else {
    dlog(`OBD: ${id} parse FAILED for raw: "${resp}"`);
  }

  // Reset header to default + flush receive buffer
  await sendCommand('ATSH7DF', 1500);
  await sendCommand('ATAR', 1500);
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
