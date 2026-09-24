/**
 * TPMS receiver link: a second BLE connection, to the PM-TPMS ESP32, that
 * runs alongside the OBD adapter.
 *
 * Shares bleManager's BleManager (react-native-ble-plx allows one) and never
 * touches the OBD device. The app's TPMS config is the source of truth for
 * the sensor allowlist; it is pushed to the receiver on every connect.
 */

import type { Subscription } from 'react-native-ble-plx';
import { initBLE, waitForPoweredOn, claimScan, stopScanIfOwner } from './bleManager';
import { dlog } from './debugLog';
import { useVehicleStore } from '../store/vehicleStore';
import { loadTpmsConfig, saveTpmsConfig } from '../config/tpmsConfigStorage';
import type { TpmsConfig } from '../config/tpmsConfig';
import {
  TPMS_DEVICE_NAME,
  TPMS_SERVICE_UUID,
  TPMS_READING_UUID,
  TPMS_CONFIG_UUID,
  TPMS_STATUS_UUID,
  TPMS_CONTROL_UUID,
  CTRL_REPLAY,
  base64ToBytes,
  bytesToBase64,
  decodeReadingFrame,
  decodeConfigFrame,
  decodeStatusFrame,
  encodeConfigFrame,
} from './tpmsProtocol';

const CONNECT_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** iOS enables notifications asynchronously; give it a beat before replaying. */
const REPLAY_DELAY_MS = 500;

let started = false;
let connectedId: string | null = null;
/** Receiver a connect attempt is in flight for. */
let pendingId: string | null = null;
/**
 * Bumped by every connect and every disconnect. An in-flight attempt checks it
 * after each await and bails if it has been superseded, so pairing or
 * forgetting mid-connect always wins over the older attempt.
 */
let generation = 0;
let subs: Subscription[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BACKOFF_MIN_MS;

const store = () => useVehicleStore.getState();

export interface FoundReceiver {
  id: string;
  name: string;
  rssi: number | null;
}

/** Load the TPMS config and connect to the paired receiver, if any. */
export async function startTpms(): Promise<void> {
  if (started) return;
  started = true;
  const before = store().tpmsConfig;
  const loaded = await loadTpmsConfig();
  // Don't clobber an edit made while the load was in flight.
  const config = store().tpmsConfig === before ? loaded : store().tpmsConfig;
  store().setTpmsConfig(config);
  if (config.receiverId) void connectReceiver(config.receiverId);
}

/** Persist a config change and push the allowlist if the receiver is up. */
export async function updateTpmsConfig(config: TpmsConfig): Promise<void> {
  const prevIds = store().tpmsConfig.sensors.map((s) => s.id).join(',');
  store().setTpmsConfig(config);
  await saveTpmsConfig(config);
  if (config.sensors.map((s) => s.id).join(',') !== prevIds) await pushAllowlist();
}

/** Scan for PM-TPMS receivers. Returns a stop function. */
export function scanForReceivers(
  onFound: (r: FoundReceiver) => void,
  durationMs = 8_000,
): () => void {
  const mgr = initBLE();
  const token = claimScan();
  const seen = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  waitForPoweredOn(mgr).then((ready) => {
    if (stopped) return;
    if (!ready) {
      dlog('TPMS: Bluetooth not powered on — cannot scan for receiver');
      return;
    }
    dlog('TPMS: scanning for receiver');
    // Unfiltered: the service UUID may sit in the scan response, which some
    // iOS versions do not match against a UUID filter.
    mgr.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        dlog(`TPMS: scan error: ${error.message}`);
        return;
      }
      if (!device || seen.has(device.id)) return;
      const name = device.name || device.localName || '';
      const hasService = device.serviceUUIDs?.some(
        (u) => u.toLowerCase() === TPMS_SERVICE_UUID,
      );
      if (name !== TPMS_DEVICE_NAME && !hasService) return;
      seen.add(device.id);
      dlog(`TPMS: found receiver ${name || '(no name)'} [${device.id}] rssi=${device.rssi}`);
      onFound({ id: device.id, name: name || TPMS_DEVICE_NAME, rssi: device.rssi });
    });
    timer = setTimeout(() => stopScanIfOwner(token), durationMs);
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopScanIfOwner(token);
  };
}

/** Remember this receiver and connect to it. */
export async function pairReceiver(r: FoundReceiver): Promise<void> {
  const config = { ...store().tpmsConfig, receiverId: r.id, receiverName: r.name };
  await disconnectReceiver();
  store().setTpmsConfig(config);
  await saveTpmsConfig(config);
  await connectReceiver(r.id);
}

/** Drop the pairing and the connection. */
export async function forgetReceiver(): Promise<void> {
  const config = { ...store().tpmsConfig, receiverId: null, receiverName: null };
  store().setTpmsConfig(config);
  await saveTpmsConfig(config);
  await disconnectReceiver();
}

/** Learn mode makes the receiver forward unknown Schrader IDs too. */
export async function setReceiverLearnMode(learn: boolean): Promise<boolean> {
  store().setTpmsLearnMode(learn);
  return pushAllowlist();
}

/** Write the allowlist + learn flag to the receiver. */
export async function pushAllowlist(): Promise<boolean> {
  const id = connectedId;
  if (!id) return false;
  const { tpmsConfig, tpmsLearnMode } = store();
  const frame = encodeConfigFrame(tpmsConfig.sensors.map((s) => s.id), tpmsLearnMode);
  try {
    await initBLE().writeCharacteristicWithResponseForDevice(
      id, TPMS_SERVICE_UUID, TPMS_CONFIG_UUID, bytesToBase64(frame),
    );
    dlog(`TPMS: allowlist pushed (${tpmsConfig.sensors.length} ids, learn=${tpmsLearnMode})`);
    return true;
  } catch (e) {
    dlog(`TPMS: allowlist push failed: ${errText(e)}`);
    return false;
  }
}

/** Ask the receiver to resend its last reading for every sensor. */
export async function requestReplay(): Promise<void> {
  const id = connectedId;
  if (!id) return;
  try {
    await initBLE().writeCharacteristicWithResponseForDevice(
      id, TPMS_SERVICE_UUID, TPMS_CONTROL_UUID, bytesToBase64(Uint8Array.of(CTRL_REPLAY)),
    );
  } catch (e) {
    dlog(`TPMS: replay request failed: ${errText(e)}`);
  }
}

async function connectReceiver(id: string): Promise<void> {
  if (connectedId === id || pendingId === id) return;
  const gen = ++generation;
  const superseded = () => gen !== generation;
  // Drop the link this attempt opened — unless a newer attempt now wants the
  // same receiver (forget then re-pair), in which case it is theirs.
  const abandon = () => {
    if (pendingId !== id && connectedId !== id) mgr.cancelDeviceConnection(id).catch(() => {});
  };
  pendingId = id;
  clearReconnect();
  const mgr = initBLE();

  try {
    if (!(await waitForPoweredOn(mgr, 10_000))) throw new Error('Bluetooth is off');
    if (superseded()) return;
    dlog(`TPMS: connecting to receiver [${id}]`);
    const device = await mgr.connectToDevice(id, { timeout: CONNECT_TIMEOUT_MS });
    if (superseded()) return abandon();
    await device.discoverAllServicesAndCharacteristics();
    if (superseded()) return abandon();
    connectedId = id;

    subs.push(mgr.onDeviceDisconnected(id, (err) => handleDisconnect(id, err)));

    subs.push(mgr.monitorCharacteristicForDevice(id, TPMS_SERVICE_UUID, TPMS_READING_UUID, (err, ch) => {
      if (err) {
        dlog(`TPMS: reading notify error: ${err.message}`);
        return;
      }
      if (!ch?.value) return;
      const reading = decodeReadingFrame(base64ToBytes(ch.value), Date.now());
      if (!reading) return;
      dlog(
        `TPMS: ${reading.id} ${reading.psi.toFixed(1)}psi ${reading.tempC}C` +
        ` flags=${reading.flags.toString(16).padStart(2, '0')}` +
        `${reading.cached ? ' (cached)' : ''}${reading.known ? '' : ' (unknown)'}`,
      );
      store().updateTpms(reading);
    }));

    subs.push(mgr.monitorCharacteristicForDevice(id, TPMS_SERVICE_UUID, TPMS_STATUS_UUID, (err, ch) => {
      if (err || !ch?.value) return;
      const status = decodeStatusFrame(base64ToBytes(ch.value));
      if (status) store().setTpmsStatus(status);
    }));

    const cfgChar = await mgr.readCharacteristicForDevice(id, TPMS_SERVICE_UUID, TPMS_CONFIG_UUID);
    if (superseded()) return; // disconnectReceiver already tore this link down
    const receiverCfg = cfgChar.value ? decodeConfigFrame(base64ToBytes(cfgChar.value)) : null;
    if (receiverCfg) store().setTpmsLearnMode(receiverCfg.learn);

    await pushAllowlist();
    if (superseded()) return;
    store().setTpmsConnected(true);
    backoffMs = BACKOFF_MIN_MS;
    dlog('TPMS: receiver connected');

    await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
    if (!superseded()) await requestReplay();
  } catch (e) {
    if (superseded()) return; // a newer connect or a forget owns the state now
    dlog(`TPMS: connect failed: ${errText(e)}`);
    teardown();
    mgr.cancelDeviceConnection(id).catch(() => {}); // a half-set-up link is useless
    scheduleReconnect(id);
  } finally {
    if (gen === generation && pendingId === id) pendingId = null;
  }
}

function handleDisconnect(id: string, err: unknown): void {
  if (connectedId !== id) return;
  dlog(`TPMS: receiver disconnected${err ? `: ${errText(err)}` : ''}`);
  teardown();
  scheduleReconnect(id);
}

async function disconnectReceiver(): Promise<void> {
  generation++; // supersedes any in-flight connect
  clearReconnect();
  const ids = [...new Set([connectedId, pendingId].filter((x): x is string => x !== null))];
  pendingId = null;
  teardown();
  for (const id of ids) {
    try {
      await initBLE().cancelDeviceConnection(id);
    } catch {
      // already gone, or never got that far
    }
  }
}

function teardown(): void {
  subs.forEach((s) => s.remove());
  subs = [];
  connectedId = null;
  store().setTpmsConnected(false);
}

function scheduleReconnect(id: string): void {
  clearReconnect();
  if (store().tpmsConfig.receiverId !== id) return; // forgotten or re-paired
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => void connectReceiver(id), delay);
}

function clearReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
