/**
 * Unified OBD transport layer — abstracts BLE vs MFi classic Bluetooth.
 *
 * Both transports expose the same interface: sendCommand(), isConnected(), etc.
 * The OBD service, parser, and polling logic don't care which transport is active.
 *
 * Transport selection:
 *   - MFi (classic BT): Higher throughput, full multi-CAN support, requires protocol string from Vgate
 *   - BLE: Works without MFi string, lower throughput but sufficient for standard OBD polling
 */

import * as BLE from './bleManager';
import * as BTClassic from './btClassicManager';
import { dlog } from './debugLog';

export type TransportType = 'mfi' | 'ble';

let activeTransport: TransportType = 'ble';

/** Set which transport to use. */
export function setTransport(type: TransportType): void {
  dlog(`Transport: switched to ${type}`);
  activeTransport = type;
}

/** Get current transport type. */
export function getTransport(): TransportType {
  return activeTransport;
}

// ---- Unified interface ----

export interface ScannedDevice {
  id: string;
  name: string | null;
  rssi: number | null;
}

/** Scan for OBD adapter devices. */
export async function scanForDevices(
  onFound: (device: ScannedDevice) => void,
  durationMs = 10000,
): Promise<() => void> {
  if (activeTransport === 'mfi') {
    // MFi: paired/connected devices appear via External Accessory
    const devices = await BTClassic.getPairedDevices();
    for (const d of devices) {
      onFound(d);
    }
    // No continuous scan for MFi — devices are either paired or not
    return () => {};
  } else {
    // BLE: active scan
    BLE.initBLE();
    return BLE.scanForDevices(onFound, durationMs);
  }
}

/** Connect to a device by ID. */
export async function connectToDevice(deviceId: string): Promise<boolean> {
  if (activeTransport === 'mfi') {
    return BTClassic.connectToDevice(deviceId);
  } else {
    return BLE.connectToDevice(deviceId);
  }
}

/** Disconnect. */
export async function disconnect(): Promise<void> {
  if (activeTransport === 'mfi') {
    await BTClassic.disconnect();
  } else {
    await BLE.disconnect();
  }
}

/** Check if connected. */
export function isConnected(): boolean {
  if (activeTransport === 'mfi') {
    return BTClassic.isConnected();
  } else {
    return BLE.isConnected();
  }
}

/** Get connected device name. */
export function getConnectedDeviceName(): string | null {
  if (activeTransport === 'mfi') {
    return BTClassic.getConnectedDeviceName();
  } else {
    return BLE.getConnectedDeviceName();
  }
}

/** Send command and wait for response (until '>' prompt). */
export async function sendCommand(
  command: string,
  timeoutMs = 3000,
): Promise<string> {
  if (activeTransport === 'mfi') {
    return BTClassic.sendCommand(command, timeoutMs);
  } else {
    return BLE.sendCommand(command, timeoutMs);
  }
}

/** Register disconnect callback. Returns cleanup function. */
export function onDisconnect(callback: () => void): () => void {
  if (activeTransport === 'mfi') {
    return BTClassic.onDisconnect(callback);
  } else {
    return BLE.onDisconnect(callback);
  }
}
