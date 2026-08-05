/**
 * OBD service — polling loop that reads vehicle data over BLE.
 *
 * Polling is driven by the PID registry + user-enabled PIDs from settings.
 * RPM, Speed, and DTCs are always polled. All other PIDs are configurable.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendCommand, sendAtsh, isConnected, getConnectedDeviceName, BLE_ONLY_DIAGNOSTIC } from './obdTransport';
import { dlog } from './debugLog';
import {
  parseMode01,
  parseMode03,
  parseMode07,
  parseMode22,
  parseVoltage,
  coolantToF,
  bytesToRPM,
  obdSpeedToMph,
  transTempToF,
  bytesToLoadPct,
  intakeAirToF,
  bytesToFuelLevelPct,
  ambientAirToF,
  bytesToOilPressurePsi,
  bytesToOilTempF,
  bytesToFuelTrimPct,
  isNoData,
} from './obdParser';
import { useVehicleStore } from '../store/vehicleStore';
import type { OBDData } from '../store/vehicleStore';
import { PID_REGISTRY, getPidDef, type PidDef } from '../config/pidRegistry';
import { selectDuePoll, batchIdsForHeader } from './pollScheduler';
import { CANDIDATES, type TransTempCandidate } from './transTempCandidates';
import type { TransTempProvider } from './transTempProvider';

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
// RPM is relaxed to 2s: the van's own dash shows RPM, and in-app it only feeds
// the numeric readout and the oil-pressure alert gate (rpm > 800). At 500ms it
// consumed roughly a third of the BLE bus.
const INTERVAL_RPM = 2000;
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

// Active transmission path provider (set by transPathResolver after connect).
// Type-only import above — providers runtime-import obdService, never the reverse.
let transProvider: TransTempProvider | null = null;

// Mode 01 PIDs reported as supported by this vehicle's ECM (populated at init).
// Empty set means discovery hasn't run yet — don't skip polls in that case.
let supportedMode01Pids: Set<string> = new Set();

// Per-PID first-skip log gate (avoid flooding dlog for every poll cycle)
const pidSkipLogged: Set<string> = new Set();

// Protocol number detected during init (e.g., '6' = 11-bit CAN 500k).
// Captured via ATDPN after first successful 010C so scanCandidates() can
// restore the exact protocol instead of re-negotiating via ATSP0.
let lockedProtocol = '0';

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

/** Set the active transmission path provider (null = trans temp unavailable). */
export function setTransProvider(p: TransTempProvider | null): void {
  transProvider = p;
}

/** Get the active transmission path provider. */
export function getTransProvider(): TransTempProvider | null {
  return transProvider;
}

/** Get the CAN protocol number locked during adapter init (e.g., '6' for 11-bit 500k). */
export function getLockedProtocol(): string {
  return lockedProtocol;
}

/** Get the set of Mode 01 PID hex strings (e.g. '04', '0F') supported by this vehicle. */
export function getSupportedMode01Pids(): Set<string> {
  return supportedMode01Pids;
}

/**
 * Query the vehicle's Mode 01 supported-PID bitmasks (0100, 0120, 0140) and
 * populate `supportedMode01Pids`. Runs once at the end of initializeAdapter().
 *
 * Each query returns 4 bytes encoding which PIDs in that range the ECM supports.
 * Bit 7 of byte A = first PID in range, bit 0 of byte D = last.
 */
async function discoverSupportedMode01Pids(): Promise<void> {
  supportedMode01Pids = new Set();
  pidSkipLogged.clear();

  const ranges: { query: string; responsePid: string; rangeStart: number }[] = [
    { query: '0100', responsePid: '00', rangeStart: 0x01 },
    { query: '0120', responsePid: '20', rangeStart: 0x21 },
    { query: '0140', responsePid: '40', rangeStart: 0x41 },
  ];

  for (const range of ranges) {
    try {
      const raw = await sendCommand(range.query, 2000);
      const bytes = parseMode01(raw, range.responsePid);
      if (!bytes || bytes.length < 4) {
        dlog(`OBD: PID support ${range.query} — no valid response ("${raw}")`);
        continue;
      }
      for (let byteIdx = 0; byteIdx < 4; byteIdx++) {
        const byte = bytes[byteIdx] ?? 0;
        for (let bit = 7; bit >= 0; bit--) {
          if (byte & (1 << bit)) {
            const pid = range.rangeStart + byteIdx * 8 + (7 - bit);
            supportedMode01Pids.add(pid.toString(16).padStart(2, '0').toUpperCase());
          }
        }
      }
    } catch (e: any) {
      dlog(`OBD: PID support query ${range.query} failed: ${e.message}`);
    }
  }

  dlog(`OBD: Supported Mode 01 PIDs: [${[...supportedMode01Pids].join(', ')}]`);
  useVehicleStore.getState().setSupportedMode01Pids(new Set(supportedMode01Pids));
}

/**
 * Returns true when the adapter is on an 11-bit CAN protocol (ELM327 protocol 6 or 8).
 * In 11-bit mode we can target specific ECUs via ATSH7E0/7E1/7DF.
 * In 29-bit mode those 3-digit headers are invalid — use the adapter's default broadcast.
 */
function is11BitProtocol(): boolean {
  return lockedProtocol === '6' || lockedProtocol === '8';
}

/**
 * Functional broadcast header for the locked CAN protocol.
 * 11-bit (protocol 6/8) uses 7DF; 29-bit (protocol 7/9) uses 18DB33F1.
 * Resetting to a wrong-width broadcast leaves fragile clones (e.g. V020) unable
 * to answer any subsequent PID, so every header reset must go through here.
 */
function broadcastHeader(): string {
  return is11BitProtocol() ? '7DF' : '18DB33F1';
}

/** Public accessor for the protocol's functional broadcast header (948TE teardown). */
export function getBroadcastHeader(): string {
  return broadcastHeader();
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
    await sendCommand('ATCAF1', 2000); // CAN auto-formatting on (explicit — some clones default to off)
    await sendCommand('ATAT1', 2000);  // Adaptive timing on (explicit — needed for reliable mode 22 on generic adapters)

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
    if (isNoData(rpmResp) || rpmResp === '') {
      dlog('OBD: No RPM on auto protocol, trying ATSP6 (CAN 11-bit 500k)...');
      await sendCommand('ATSP6', 2000);
      const retry = await sendCommand('010C', 3000);
      if (isNoData(retry) || retry === '') {
        dlog('OBD: No RPM response on any protocol (vehicle may be off)');
      } else {
        dlog('OBD: RPM OK on protocol 6');
      }
    } else {
      dlog('OBD: RPM OK');
    }

    // Capture the auto-detected protocol number so the trans scan cleanup can
    // restore it with ATSP<N> instead of ATSP0 (which forces a full re-negotiation
    // that can fail after 29-bit ATSH commands corrupt the adapter's CAN state).
    // ATDPN returns e.g. "6" (locked) or "A6" (auto-detected as 6) — strip the A.
    try {
      const dpn = await sendCommand('ATDPN', 2000);
      const match = dpn.trim().match(/^A?([0-9A-Fa-f])$/i);
      if (match) {
        lockedProtocol = match[1].toUpperCase();
        dlog(`OBD: Protocol locked = ATSP${lockedProtocol}`);
      } else {
        dlog(`OBD: ATDPN parse failed ("${dpn}") — will use ATSP0 fallback in trans scan`);
      }
    } catch {}

    consecutiveFailures = 0;

    // Discover which Mode 01 PIDs the vehicle ECM actually supports.
    // This runs after protocol lock so bitmask queries use the correct CAN mode.
    await discoverSupportedMode01Pids();

    dlog('OBD: Adapter init complete');

    if (BLE_ONLY_DIAGNOSTIC) {
      // Sample PID: re-read RPM to capture a fresh parsed value for the summary
      dlog('[BLE-DIAG] INIT: Diagnostic sample PID read (010C / RPM)...');
      const sampleRaw = await sendCommand('010C', 3000);
      const sampleBytes = parseMode01(sampleRaw, '0C');
      const sampleRpm =
        sampleBytes && sampleBytes.length >= 2 ? bytesToRPM(sampleBytes) : null;
      const deviceName = getConnectedDeviceName();

      dlog('[BLE-DIAG] ============================================');
      dlog('[BLE-DIAG] DIAGNOSTIC SUMMARY');
      dlog(`[BLE-DIAG]   BLE adapter found:        YES — ${deviceName ?? '(name unavailable)'}`);
      dlog(`[BLE-DIAG]   BLE connected:            ${isConnected() ? 'YES' : 'NO'}`);
      dlog('[BLE-DIAG]   Notify + write chars:     YES (connect succeeded)');
      dlog('[BLE-DIAG]   ELM327 init:              SUCCESS');
      dlog(
        `[BLE-DIAG]   Sample PID (010C / RPM):  ${
          sampleRpm !== null
            ? `SUCCESS — ${sampleRpm} RPM`
            : 'NO DATA (vehicle may be off or key-off)'
        }`,
      );
      dlog('[BLE-DIAG] ============================================');
    }

    return true;
  } catch (e: any) {
    dlog(`OBD: Init failed: ${e.message}`);
    if (BLE_ONLY_DIAGNOSTIC) {
      dlog('[BLE-DIAG] ============================================');
      dlog('[BLE-DIAG] DIAGNOSTIC SUMMARY — INIT FAILED');
      dlog(`[BLE-DIAG]   ELM327 init: FAILED — ${e.message}`);
      dlog('[BLE-DIAG]   See [BLE-DIAG] CMD lines above for last successful command');
      dlog('[BLE-DIAG] ============================================');
    }
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
      // Trans temp needs a resolved path provider
      if (pid.id === 'transF' && !transProvider) continue;
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

/**
 * On-demand DTC read: pauses the poll loop, reads stored (Mode 03) and
 * pending (Mode 07) codes, updates the store, then restarts polling.
 */
export async function readDTCsNow(): Promise<{ stored: string[]; pending: string[] }> {
  const wasRunning = running;
  if (wasRunning) stopPolling();
  try {
    if (is11BitProtocol()) {
      await sendCommand('ATSH7E0', 1500);
    }
    const stored = parseMode03(await sendCommand('03', 5000));
    const pending = parseMode07(await sendCommand('07', 5000));
    useVehicleStore.getState().updateDTCs(stored);
    dlog(`OBD: Manual DTC read — stored: [${stored.join(', ')}], pending: [${pending.join(', ')}]`);
    return { stored, pending };
  } finally {
    if (is11BitProtocol()) {
      await sendCommand(`ATSH${broadcastHeader()}`, 1500).catch(() => {});
    }
    if (wasRunning) startPolling();
  }
}

/**
 * Clear all stored DTCs (Mode 04). Pauses polling, sends clear command,
 * updates store, restarts polling. Returns true if adapter acknowledged.
 */
export async function clearDTCs(): Promise<{ ok: boolean; message: string }> {
  const wasRunning = running;
  if (wasRunning) stopPolling();
  try {
    // Mode 04 is a broadcast command — send without changing the header so the
    // adapter uses its current broadcast address (7DF / 18DB33F1). Targeting
    // a specific ECU (ATSH7E0) can prevent acknowledgment on some vehicles.
    const resp = await sendCommand('04', 5000);
    const upper = resp.toUpperCase().replace(/\s/g, '');
    dlog(`OBD: Clear DTCs (Mode 04) — response: "${resp}"`);

    if (upper.includes('44')) {
      useVehicleStore.getState().updateDTCs([]);
      return { ok: true, message: 'All diagnostic codes have been erased.' };
    }
    // NRC 0x22 = conditionsNotCorrect — Chrysler/FCA requires engine off to clear
    if (upper.includes('7F0422')) {
      return { ok: false, message: 'Turn the engine off (ignition on, engine off) and try again. The PCM requires the engine to be off to clear codes.' };
    }
    return { ok: false, message: 'PCM did not acknowledge the clear command.' };
  } finally {
    if (wasRunning) startPolling();
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

    // Most-overdue due entry wins (schedule order breaks ties). First-due-in-
    // order starved everything below the fast PIDs when the bus saturated.
    const dueId = selectDuePoll(schedule, nextDue, now);
    if (dueId !== null) {
      const entry = schedule.find((e) => e.id === dueId)!;
      await executePoll(dueId);
      nextDue[dueId] = Date.now() + entry.intervalMs; // actual finish time, not tick-start
      polled = true;
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
    case 'transF':       { await transProvider?.read(); return; }
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
  // In 11-bit CAN mode we target the ECM directly (7E0) to avoid multi-ECU ambiguity.
  // In 29-bit CAN mode (e.g. protocol 7) 11-bit headers are invalid; the adapter's
  // default 29-bit broadcast reaches the ECM and returns Mode 01 data correctly.
  if (is11BitProtocol()) {
    const shCoolant = await sendCommand('ATSH7E0', 1500);
    if (shCoolant.includes('?')) {
      dlog('OBD: Coolant SKIPPED — adapter rejected ATSH7E0');
      return;
    }
    await sleep(100); // Let adapter reconfigure CAN filter
  }

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

  // Reset header + flush only when we changed it (11-bit ECM targeting above).
  if (is11BitProtocol()) {
    await sendCommand(`ATSH${broadcastHeader()}`, 1500);
    await sendCommand('ATAR', 1500);
  }
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

export async function pollTransTemp(): Promise<number | null> {
  if (!transCandidate) {
    transNullLogCount++;
    // Log every 10th skip to avoid flooding
    if (transNullLogCount <= 3 || transNullLogCount % 10 === 0) {
      dlog(`OBD: Trans SKIPPED — no candidate set (skip #${transNullLogCount}). Run SCAN TRANS TEMP on BLE screen.`);
    }
    return null;
  }
  transNullLogCount = 0;

  // The saved candidate's CAN header width must match the locked protocol: an
  // 11-bit header (e.g. 7E0) is invalid in 29-bit mode and vice-versa, and
  // sending a wrong-width ATSH then poisons fragile clones (e.g. V020). But the
  // trans DATA is the same on either bus — only the CAN address differs — so
  // auto-switch to the same DID at the correct width rather than failing. Falls
  // back to skip + re-scan only if no matching-width sibling exists.
  const protocolIs29 = !is11BitProtocol();
  if ((transCandidate.header.length > 3) !== protocolIs29) {
    const savedDid = transCandidate.did;
    const sibling = CANDIDATES.find(c => c.did === savedDid && c.is29bit === protocolIs29);
    if (!sibling) {
      dlog(`OBD: Trans SKIPPED — no ${protocolIs29 ? '29' : '11'}-bit candidate for DID ${savedDid} (re-run SCAN TRANS TEMP)`);
      return null;
    }
    dlog(`OBD: Trans — saved candidate wrong CAN width for ATSP${lockedProtocol}; auto-switching to "${sibling.name}" (header ${sibling.header})`);
    transCandidate = sibling;
  }

  // Set header for this candidate (auto-falls back to ATCP+3-byte for generic clones)
  const atshOkTrans = await sendAtsh(transCandidate.header);
  if (!atshOkTrans) {
    dlog(`OBD: Trans SKIPPED — adapter rejected ATSH${transCandidate.header} (re-run SCAN TRANS TEMP)`);
    return null;
  }
  await sleep(100); // Let adapter reconfigure CAN filter

  const resp = await sendCommand(`22${transCandidate.did}`, 2500);
  dlog(`OBD: Trans raw: "${resp}"`);
  const bytes = parseMode22(resp, transCandidate.did);

  let result: number | null = null;
  if (bytes && bytes.length >= 1) {
    const hexBytes = bytes.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    dlog(`OBD: Trans bytes=[${hexBytes}]`);
    const tempF = transTempToF(bytes, transCandidate.twoByteMode);
    dlog(`OBD: Trans = ${tempF.toFixed(1)}\u00b0F`);
    if (tempF >= -40 && tempF <= 400) {
      useVehicleStore.getState().updateOBD({ transF: tempF });
      result = tempF;
    }
  } else {
    dlog(`OBD: Trans parse FAILED for raw: "${resp}"`);
  }

  // Reset the header to the protocol's functional broadcast and flush. Run this
  // unconditionally: after a 29-bit trans poll the header sits on the candidate's
  // physical address (e.g. 18DA10F1), so it must return to 18DB33F1 or the
  // following Mode 01 polls stop reaching the ECM.
  await sendCommand(`ATSH${broadcastHeader()}`, 1500);
  await sendCommand('ATAR', 1500);
  return result;
}

// ---------------------------------------------------------------------------
// Generic Mode 01 polling
// ---------------------------------------------------------------------------

/** PID-to-converter mapping for standard Mode 01 PIDs. */
const MODE01_CONVERTERS: Record<string, { pid: string; minBytes: number; convert: (b: number[]) => number; storeKey: keyof OBDData }> = {
  engineLoadPct: { pid: '04', minBytes: 1, convert: bytesToLoadPct,       storeKey: 'engineLoadPct' },
  intakeAirF:    { pid: '0F', minBytes: 1, convert: intakeAirToF,         storeKey: 'intakeAirF' },
  fuelLevelPct:  { pid: '2F', minBytes: 1, convert: bytesToFuelLevelPct,  storeKey: 'fuelLevelPct' },
  ambientAirF:   { pid: '46', minBytes: 1, convert: ambientAirToF,        storeKey: 'ambientAirF' },
  stftBank1Pct:  { pid: '06', minBytes: 1, convert: bytesToFuelTrimPct,   storeKey: 'stftBank1Pct' },
  ltftBank1Pct:  { pid: '07', minBytes: 1, convert: bytesToFuelTrimPct,   storeKey: 'ltftBank1Pct' },
  stftBank2Pct:  { pid: '08', minBytes: 1, convert: bytesToFuelTrimPct,   storeKey: 'stftBank2Pct' },
  ltftBank2Pct:  { pid: '09', minBytes: 1, convert: bytesToFuelTrimPct,   storeKey: 'ltftBank2Pct' },
};

async function pollMode01Pid(id: string): Promise<void> {
  const conv = MODE01_CONVERTERS[id];
  if (!conv) {
    dlog(`OBD: Unknown PID id "${id}"`);
    return;
  }

  // Skip PIDs the ECM reported as unsupported in the init bitmask scan.
  // Only gate when discovery has run (non-empty set); empty = discovery not done, poll anyway.
  if (supportedMode01Pids.size > 0 && !supportedMode01Pids.has(conv.pid.toUpperCase())) {
    if (!pidSkipLogged.has(id)) {
      dlog(`OBD: ${id} SKIPPED — PID 0x${conv.pid} not in vehicle support bitmask`);
      pidSkipLogged.add(id);
    }
    return;
  }

  // In 11-bit CAN mode, target the ECM directly (ATSH7E0) rather than broadcast (7DF).
  // The ProMaster's PCM responds to optional Mode 01 PIDs only on targeted queries,
  // not on broadcast — the same pattern used by pollCoolant for the same reason.
  // In 29-bit mode, 11-bit headers are invalid; skip the header commands entirely.
  if (is11BitProtocol()) {
    const sh = await sendCommand('ATSH7E0', 1500);
    if (sh.includes('?')) {
      dlog(`OBD: ${id} SKIPPED — adapter rejected ATSH7E0`);
      return;
    }
    await sleep(100);
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

  // Reset header + flush only when we changed it (11-bit ECM targeting above).
  if (is11BitProtocol()) {
    await sendCommand(`ATSH${broadcastHeader()}`, 1500);
    await sendCommand('ATAR', 1500);
  }
}

// ---------------------------------------------------------------------------
// Generic Mode 22 polling (oil pressure, oil temp)
// ---------------------------------------------------------------------------

const MODE22_CONVERTERS: Record<string, { did: string; header: string; minBytes: number; convert: (b: number[]) => number; storeKey: keyof OBDData }> = {
  oilPressurePsi: { did: '022A', header: '18DA10F1', minBytes: 1, convert: bytesToOilPressurePsi, storeKey: 'oilPressurePsi' },
  oilTempF:       { did: '0121', header: '18DA10F1', minBytes: 1, convert: bytesToOilTempF,       storeKey: 'oilTempF' },
};

const MODE22_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(MODE22_CONVERTERS).map(([id, c]) => [id, c.header]),
);

async function pollMode22Pid(primaryId: string): Promise<void> {
  const conv = MODE22_CONVERTERS[primaryId];
  if (!conv) return;

  // The header width must match the locked protocol (see pollTransTemp). Skip
  // rather than send a wrong-width ATSH that corrupts fragile clones.
  const convIs29 = conv.header.length > 3;
  if (convIs29 !== !is11BitProtocol()) {
    dlog(`OBD: ${primaryId} SKIPPED — header ${conv.header} wrong CAN width for ATSP${lockedProtocol}`);
    return;
  }

  const atshOk22 = await sendAtsh(conv.header);
  if (!atshOk22) {
    dlog(`OBD: ${primaryId} SKIPPED — adapter rejected ATSH${conv.header}`);
    return;
  }
  await sleep(100); // Let adapter reconfigure CAN filter

  // Read every enabled PID on this header while the session is open — the
  // set/settle/restore round trips dominate the cost of a Mode 22 poll, so
  // co-located DIDs (oil pressure + oil temp, both ECM 0x10) piggyback.
  for (const id of batchIdsForHeader(primaryId, MODE22_HEADERS, isPidEnabled)) {
    const c = MODE22_CONVERTERS[id];
    const resp = await sendCommand(`22${c.did}`, 2500);
    dlog(`OBD: ${id} raw: "${resp}"`);
    const bytes = parseMode22(resp, c.did);

    if (bytes && bytes.length >= c.minBytes) {
      const value = c.convert(bytes);
      dlog(`OBD: ${id} = ${value.toFixed(1)}`);
      useVehicleStore.getState().updateOBD({ [c.storeKey]: value } as Partial<OBDData>);
    } else {
      dlog(`OBD: ${id} parse FAILED for raw: "${resp}"`);
    }

    // Re-arm the piggybacked PID's schedule slot; the loop re-arms the primary.
    if (id !== primaryId) {
      nextDue[id] = Date.now() + (getPidDef(id)?.intervalMs ?? 1500);
    }
  }

  // Reset header to the protocol's functional broadcast + flush. Unconditional —
  // see pollTransTemp for why leaving a physical header set breaks Mode 01.
  await sendCommand(`ATSH${broadcastHeader()}`, 1500);
  await sendCommand('ATAR', 1500);
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
