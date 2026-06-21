/**
 * BLE connection manager for VLinker MS OBD2 adapter.
 *
 * The VLinker MS uses SPP-over-BLE (Serial Port Profile emulation).
 * Typical UUIDs: Service FFF0, Write char FFF1, Notify char FFF2.
 * These may vary — we discover them dynamically.
 */

import { BleManager, Device, Characteristic, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { dlog } from './debugLog';

// Known VLinker / ELM327 BLE service UUIDs to scan for
const KNOWN_SERVICE_UUIDS = [
  'FFF0',                                     // VLinker MS typical
  '0000FFF0-0000-1000-8000-00805F9B34FB',    // Full 128-bit form
  'E7810A71-73AE-499D-8C15-FAA9AEF0C3F2',   // Some ELM327 clones
  '18F0',                                     // Alternate
];

// Known name prefixes for OBD adapters
const OBD_NAME_PREFIXES = [
  'VLINK', 'vLinker', 'VLinker',
  'OBD', 'ELM', 'IOS-V',
  'OBDII', 'Vgate',
];

let manager: BleManager | null = null;
let connectedDevice: Device | null = null;
let writeCharacteristic: Characteristic | null = null;
let notifyCharacteristic: Characteristic | null = null;

// Response buffer for reassembling BLE packets
let responseBuffer = '';
let responseResolve: ((value: string) => void) | null = null;
let responseTimeout: ReturnType<typeof setTimeout> | null = null;

// Command mutex — prevents overlapping commands from contaminating responses
let commandLock: Promise<void> = Promise.resolve();

function acquireLock(): { promise: Promise<void>; release: () => void } {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const promise = commandLock;
  commandLock = commandLock.then(() => next);
  return { promise, release: release! };
}

export interface ScannedDevice {
  id: string;
  name: string | null;
  rssi: number | null;
}

/** Initialize BLE manager. */
export function initBLE(): BleManager {
  if (!manager) {
    manager = new BleManager();
  }
  return manager;
}

/** Check if BLE is powered on. */
export async function isBLEReady(): Promise<boolean> {
  const mgr = initBLE();
  const state = await mgr.state();
  return state === State.PoweredOn;
}

/** Wait for BLE to be powered on (up to timeoutMs). */
async function waitForPoweredOn(mgr: BleManager, timeoutMs = 5000): Promise<boolean> {
  const state = await mgr.state();
  dlog(`BLE: Current state = ${state}`);
  if (state === State.PoweredOn) return true;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(false);
    }, timeoutMs);

    const sub = mgr.onStateChange((newState) => {
      dlog(`BLE: State changed to ${newState}`);
      if (newState === State.PoweredOn) {
        clearTimeout(timer);
        sub.remove();
        resolve(true);
      }
    }, true);
  });
}

/**
 * Scan for OBD adapter devices. Returns found devices via callback.
 * diagnostic=true (set by obdTransport when BLE_ONLY_DIAGNOSTIC is active):
 *   - logs every advertising device with full name/UUID/RSSI detail
 *   - surfaces ALL devices via onFound (not just OBD-matching ones)
 */
export function scanForDevices(
  onFound: (device: ScannedDevice) => void,
  durationMs = 10000,
  diagnostic = false,
): () => void {
  const mgr = initBLE();
  const seen = new Set<string>();
  let stopped = false;

  dlog('BLE: Waiting for Bluetooth to be ready...');

  // Wait for powered on, then scan
  waitForPoweredOn(mgr).then((ready) => {
    if (stopped) return;
    if (!ready) {
      dlog('BLE: Bluetooth not powered on after 5s — is Bluetooth enabled in Settings?');
      return;
    }

    if (diagnostic) {
      dlog(`[BLE-DIAG] SCAN: Unfiltered ${durationMs / 1000}s scan — ALL advertising devices will appear`);
    } else {
      dlog('BLE: Starting scan...');
    }

    mgr.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        dlog(`BLE: Scan error: ${error.message}`);
        return;
      }
      if (!device || seen.has(device.id)) return;
      seen.add(device.id);

      const name = device.name || device.localName || null;

      if (diagnostic) {
        // Verbose: log every field, flag VLinker name matches
        const isMatch = name
          ? OBD_NAME_PREFIXES.some((p) => name.toUpperCase().includes(p.toUpperCase()))
          : false;
        const hasMfg = device.manufacturerData != null;
        const svcs = device.serviceUUIDs?.length
          ? device.serviceUUIDs.join(', ')
          : '(none)';
        dlog(
          `[BLE-DIAG] SCAN: name="${name ?? '(none)'}" localName="${device.localName ?? '(none)'}"` +
          ` id=${device.id} rssi=${device.rssi}` +
          ` serviceUUIDs=[${svcs}] mfgData=${hasMfg ? 'YES' : 'NO'}` +
          (isMatch ? ' ← VLINKER MATCH' : ''),
        );
        // Surface ALL devices so the connect list shows everything visible
        onFound({ id: device.id, name, rssi: device.rssi });
      } else {
        // Normal path: log summary, filter to likely OBD adapters before surfacing
        const svcIds = device.serviceUUIDs?.join(',') ?? 'none';
        dlog(`BLE: Saw ${name ?? '(no name)'} [${device.id}] rssi=${device.rssi} svcs=${svcIds}`);

        const isOBD =
          name && OBD_NAME_PREFIXES.some((p) => name.toUpperCase().includes(p.toUpperCase()));

        if (isOBD || (device.serviceUUIDs && device.serviceUUIDs.some(
          (uuid) => KNOWN_SERVICE_UUIDS.some((k) => uuid.toUpperCase().includes(k.toUpperCase())),
        ))) {
          dlog(`BLE: ^^^ Matches OBD filter — adding to list`);
          onFound({ id: device.id, name, rssi: device.rssi });
        }
      }
    });

    // Auto-stop after duration
    setTimeout(() => {
      if (diagnostic) {
        dlog(`[BLE-DIAG] SCAN: Complete (${durationMs / 1000}s). Saw ${seen.size} total devices. Grep log for VLINKER MATCH.`);
      } else {
        dlog(`BLE: Scan complete (${durationMs / 1000}s). Saw ${seen.size} devices total.`);
      }
      mgr.stopDeviceScan();
    }, durationMs);
  });

  // Return cleanup function
  return () => {
    stopped = true;
    mgr.stopDeviceScan();
  };
}

/**
 * Connect to a specific device and discover serial characteristics.
 * diagnostic=true (set by obdTransport when BLE_ONLY_DIAGNOSTIC is active):
 *   - logs every service UUID and every characteristic UUID + properties
 *   - flags which characteristic was selected as write and notify target
 */
export async function connectToDevice(deviceId: string, diagnostic = false): Promise<boolean> {
  const mgr = initBLE();

  try {
    // Disconnect existing
    if (connectedDevice) {
      dlog('BLE: Disconnecting previous device...');
      try { await connectedDevice.cancelConnection(); } catch {}
      connectedDevice = null;
    }

    // Connect
    dlog(`BLE: Connecting to ${deviceId}...`);
    const device = await mgr.connectToDevice(deviceId, {
      requestMTU: 512,
      timeout: 10000,
    });
    dlog('BLE: Connected, discovering services...');
    await device.discoverAllServicesAndCharacteristics();
    connectedDevice = device;

    // Find write + notify characteristics
    // In diagnostic mode: log every service and char with full property detail
    if (diagnostic) {
      dlog(`[BLE-DIAG] CONNECT: Starting service/characteristic discovery for ${deviceId}`);
    }
    const services = await device.services();
    for (const service of services) {
      if (diagnostic) {
        dlog(`[BLE-DIAG] CONNECT: SERVICE ${service.uuid}`);
      }
      const chars = await service.characteristics();
      for (const char of chars) {
        if (diagnostic) {
          dlog(
            `[BLE-DIAG] CONNECT:   CHAR ${char.uuid}` +
            ` [notify=${char.isNotifiable}` +
            ` indicate=${char.isIndicatable}` +
            ` write=${char.isWritableWithResponse}` +
            ` writeNoResp=${char.isWritableWithoutResponse}` +
            ` read=${char.isReadable}]`,
          );
        }
        if (char.isWritableWithResponse || char.isWritableWithoutResponse) {
          if (!writeCharacteristic) {
            writeCharacteristic = char;
            if (diagnostic) dlog(`[BLE-DIAG] CONNECT:   ^^^ Selected as WRITE target`);
          }
        }
        if (char.isNotifiable) {
          if (!notifyCharacteristic) {
            notifyCharacteristic = char;
            if (diagnostic) dlog(`[BLE-DIAG] CONNECT:   ^^^ Selected as NOTIFY target`);
          }
        }
      }
    }

    if (!writeCharacteristic || !notifyCharacteristic) {
      if (diagnostic) {
        dlog(
          `[BLE-DIAG] CONNECT: FAILED — missing ${!writeCharacteristic ? 'WRITE' : 'NOTIFY'} characteristic`,
        );
      }
      dlog('BLE: ERROR — Could not find write/notify characteristics');
      await device.cancelConnection();
      connectedDevice = null;
      return false;
    }

    if (diagnostic) {
      dlog(`[BLE-DIAG] CONNECT: Write char  = ${writeCharacteristic.uuid}`);
      dlog(`[BLE-DIAG] CONNECT: Notify char = ${notifyCharacteristic.uuid}`);
    }
    dlog('BLE: Found characteristics, starting notifications...');

    // Start monitoring notifications
    notifyCharacteristic.monitor((error, char) => {
      if (error) {
        dlog(`BLE: Notify error: ${error.message}`);
        return;
      }
      if (char?.value) {
        // Decode base64 to string
        const decoded = atob(char.value);
        onDataReceived(decoded);
      }
    });

    // Listen for disconnection
    mgr.onDeviceDisconnected(deviceId, () => {
      dlog('BLE: Device disconnected');
      connectedDevice = null;
      writeCharacteristic = null;
      notifyCharacteristic = null;
    });

    dlog('BLE: Connection ready');
    return true;
  } catch (e: any) {
    dlog(`BLE: Connect failed: ${e.message}`);
    return false;
  }
}

/** Disconnect from current device. */
export async function disconnect(): Promise<void> {
  if (connectedDevice) {
    try { await connectedDevice.cancelConnection(); } catch {}
    connectedDevice = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;
  }
}

/** Check if currently connected. */
export function isConnected(): boolean {
  return connectedDevice !== null && writeCharacteristic !== null;
}

/** Get connected device name. */
export function getConnectedDeviceName(): string | null {
  return connectedDevice?.name ?? connectedDevice?.localName ?? null;
}

/** Send a raw string command to the adapter. */
export async function sendRaw(command: string): Promise<void> {
  if (!writeCharacteristic) {
    throw new Error('Not connected');
  }

  // Encode string to base64
  const encoded = btoa(command + '\r');

  if (writeCharacteristic.isWritableWithResponse) {
    await writeCharacteristic.writeWithResponse(encoded);
  } else {
    await writeCharacteristic.writeWithoutResponse(encoded);
  }
}

/**
 * Send a command and wait for a complete response (terminated by '>').
 * Uses a mutex to prevent overlapping commands from contaminating responses.
 */
export async function sendCommand(
  command: string,
  timeoutMs = 3000,
): Promise<string> {
  const lock = acquireLock();
  await lock.promise;

  try {
    responseBuffer = '';

    return await new Promise<string>(async (resolve, reject) => {
      responseResolve = resolve;

      responseTimeout = setTimeout(() => {
        responseResolve = null;
        const partial = responseBuffer;
        responseBuffer = '';
        resolve(partial);
      }, timeoutMs);

      try {
        await sendRaw(command);
      } catch (e) {
        clearTimeout(responseTimeout);
        responseResolve = null;
        reject(e);
      }
    });
  } finally {
    lock.release();
  }
}

/** Handle incoming BLE data — reassemble until '>' prompt. */
function onDataReceived(data: string): void {
  responseBuffer += data;

  // Check for ELM327 prompt character
  if (responseBuffer.includes('>')) {
    if (responseTimeout) {
      clearTimeout(responseTimeout);
      responseTimeout = null;
    }
    if (responseResolve) {
      // Take everything before the first '>' as the response.
      // Discard anything after it (stale data from previous commands).
      const idx = responseBuffer.indexOf('>');
      const response = responseBuffer.substring(0, idx).trim();
      responseBuffer = '';
      const resolve = responseResolve;
      responseResolve = null;
      resolve(response);
    }
  }
}

/** Register a disconnect listener. */
export function onDisconnect(callback: () => void): () => void {
  if (!manager || !connectedDevice) return () => {};

  const subscription = manager.onDeviceDisconnected(connectedDevice.id, () => {
    connectedDevice = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;
    callback();
  });

  return () => subscription.remove();
}
