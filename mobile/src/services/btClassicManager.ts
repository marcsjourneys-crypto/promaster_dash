/**
 * Bluetooth Classic (MFi) connection manager for VLinker MS OBD2 adapter.
 *
 * Uses react-native-bluetooth-classic which wraps iOS External Accessory framework.
 * Requires the VLinker MS MFi protocol string in Info.plist under
 * UISupportedExternalAccessoryProtocols.
 *
 * The serial API is stream-based (no BLE packet reassembly needed).
 */

import RNBluetoothClassic, {
  BluetoothDevice,
} from 'react-native-bluetooth-classic';
import { dlog } from './debugLog';

let connectedDevice: BluetoothDevice | null = null;
let readSubscription: any = null;

// Response buffer for collecting data until '>' prompt
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

/** Check if Bluetooth Classic is available on this device. */
export async function isAvailable(): Promise<boolean> {
  try {
    return await RNBluetoothClassic.isBluetoothAvailable();
  } catch {
    return false;
  }
}

/** Check if Bluetooth is enabled. */
export async function isEnabled(): Promise<boolean> {
  try {
    return await RNBluetoothClassic.isBluetoothEnabled();
  } catch {
    return false;
  }
}

/**
 * Get paired/bonded devices (MFi devices show up here after iOS pairs them).
 * On iOS with External Accessory, only connected MFi accessories whose
 * protocol strings match UISupportedExternalAccessoryProtocols will appear.
 */
export async function getPairedDevices(): Promise<ScannedDevice[]> {
  // Log availability/enabled state for diagnostics
  try {
    const avail = await RNBluetoothClassic.isBluetoothAvailable();
    dlog(`MFi: isBluetoothAvailable = ${avail}`);
  } catch (e: any) {
    dlog(`MFi: isBluetoothAvailable threw: ${e.message}`);
  }
  try {
    const enabled = await RNBluetoothClassic.isBluetoothEnabled();
    dlog(`MFi: isBluetoothEnabled = ${enabled}`);
  } catch (e: any) {
    dlog(`MFi: isBluetoothEnabled threw: ${e.message}`);
  }

  // Try to get devices regardless of reported state
  try {
    dlog('MFi: Calling getBondedDevices...');
    const devices = await RNBluetoothClassic.getBondedDevices();
    dlog(`MFi: Found ${devices.length} bonded devices`);
    for (const d of devices) {
      dlog(`MFi:   ${d.name ?? '(unnamed)'} | ${d.address} | ${JSON.stringify(d.extra ?? {})}`);
    }
    return devices.map((d) => ({
      id: d.address,
      name: d.name ?? null,
      rssi: null,
    }));
  } catch (e: any) {
    dlog(`MFi: getBondedDevices failed: ${e.message}`);
  }

  // Fallback: try listing accessories directly
  try {
    dlog('MFi: Trying direct accessory list as fallback...');
    const info = await debugListAccessories();
    dlog(`MFi: Fallback found ${info.length} accessories`);
    return [];
  } catch (e: any) {
    dlog(`MFi: Fallback also failed: ${e.message}`);
    return [];
  }
}

/**
 * Debug helper: List all connected accessories regardless of protocol match.
 * Useful for discovering the correct protocol string.
 */
export async function debugListAccessories(): Promise<string[]> {
  try {
    const devices = await RNBluetoothClassic.getBondedDevices();
    const info = devices.map((d) =>
      `${d.name ?? '(unnamed)'} [${d.address}] extras=${JSON.stringify(d.extra ?? {})}`
    );
    dlog(`MFi: All accessories: ${info.join(', ')}`);
    return info;
  } catch (e: any) {
    dlog(`MFi: Debug list failed: ${e.message}`);
    return [`Error: ${e.message}`];
  }
}

/**
 * Connect to a specific device by address/ID.
 * For MFi devices on iOS, the device must be paired at the OS level first.
 */
export async function connectToDevice(deviceId: string): Promise<boolean> {
  try {
    // Disconnect existing
    if (connectedDevice) {
      try { await connectedDevice.disconnect(); } catch {}
      connectedDevice = null;
    }

    dlog(`MFi: Connecting to ${deviceId}...`);
    const device = await RNBluetoothClassic.connectToDevice(deviceId, {
      // Use '>' as delimiter so the library flushes buffered data when the
      // ELM327 prompt arrives. The library strips '>' before delivering, so
      // onDataReceived resolves immediately on receipt rather than scanning
      // for the prompt character itself.
      delimiter: '>',
    });

    if (!device || !(await device.isConnected())) {
      dlog('MFi: Device not connected after connect call');
      return false;
    }

    connectedDevice = device;
    dlog('MFi: Connected, starting data listener...');

    // Start reading data
    readSubscription = device.onDataReceived((event) => {
      onDataReceived(event.data);
    });

    dlog('MFi: Connection ready');
    return true;
  } catch (e: any) {
    dlog(`MFi: Connect failed: ${e.message}`);
    return false;
  }
}

/** Disconnect from current device. */
export async function disconnect(): Promise<void> {
  if (readSubscription) {
    readSubscription.remove();
    readSubscription = null;
  }
  if (connectedDevice) {
    try { await connectedDevice.disconnect(); } catch {}
    connectedDevice = null;
  }
}

/** Check if currently connected. */
export function isConnected(): boolean {
  return connectedDevice !== null;
}

/** Get connected device name. */
export function getConnectedDeviceName(): string | null {
  return connectedDevice?.name ?? null;
}

/** Send a raw string command to the adapter. */
export async function sendRaw(command: string): Promise<void> {
  if (!connectedDevice) {
    throw new Error('Not connected');
  }
  await connectedDevice.write(command + '\r');
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
        if (partial === '') {
          dlog(`MFi: TIMEOUT "${command}" — no data received`);
        }
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

/**
 * Handle incoming serial data.
 *
 * With delimiter:'>' set on the connection, the library strips '>' and delivers
 * one complete response per call — resolve immediately rather than hunting for '>'.
 */
function onDataReceived(data: string): void {
  responseBuffer += data;
  dlog(`MFi raw: "${data.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);

  if (responseTimeout) {
    clearTimeout(responseTimeout);
    responseTimeout = null;
  }
  if (responseResolve) {
    const response = responseBuffer.trim();
    responseBuffer = '';
    const resolve = responseResolve;
    responseResolve = null;
    resolve(response);
  }
}

/** Register a disconnect listener. Returns cleanup function. */
export function onDisconnect(callback: () => void): () => void {
  if (!connectedDevice) return () => {};

  const subscription = RNBluetoothClassic.onDeviceDisconnected(() => {
    connectedDevice = null;
    readSubscription = null;
    callback();
  });

  return () => subscription.remove();
}
