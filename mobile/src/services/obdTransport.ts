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

// =============================================================================
// TEMPORARY DIAGNOSTIC — remove before App Store release.
//
// BLE_ONLY_DIAGNOSTIC = true:
//   • Blocks transport switching to MFi; BLE path only.
//   • Forces unfiltered 15-second BLE scan (all advertising devices visible).
//   • Logs every OBD command sent and every raw response with [BLE-DIAG] prefix.
//   • Enables verbose service/characteristic discovery logging on connect.
//   • Emits a DIAGNOSTIC SUMMARY block after ELM327 init.
//
// To revert: flip this constant to false.  All diagnostic behaviour disappears.
// =============================================================================
export const BLE_ONLY_DIAGNOSTIC = false;

import * as BLE from './bleManager';
import * as BTClassic from './btClassicManager';
import { dlog } from './debugLog';

export type TransportType = 'mfi' | 'ble';

let activeTransport: TransportType = 'ble';

// Tracks whether this adapter needs ATCP + 3-byte ATSH instead of 4-byte ATSH.
// Cheap ELM327 clones reject "ATSH18DA10F1" with '?' but accept the split form.
// Reset on each new connection so swapping adapters re-probes.
let shortAtsh = false;

/** Set which transport to use. */
export function setTransport(type: TransportType): void {
  if (BLE_ONLY_DIAGNOSTIC) {
    dlog('[BLE-DIAG] setTransport() blocked — BLE_ONLY_DIAGNOSTIC forces BLE-only mode');
    return;
  }
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
  if (BLE_ONLY_DIAGNOSTIC) {
    // DIAGNOSTIC: force BLE, 15s window, verbose logging, all devices visible
    BLE.initBLE();
    return BLE.scanForDevices(onFound, 15000, true);
  }
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
    return BLE.scanForDevices(onFound, durationMs, false);
  }
}

/** Connect to a device by ID. */
export async function connectToDevice(deviceId: string): Promise<boolean> {
  shortAtsh = false; // re-probe ATSH format on each new connection
  if (BLE_ONLY_DIAGNOSTIC) {
    return BLE.connectToDevice(deviceId, true);
  }
  if (activeTransport === 'mfi') {
    return BTClassic.connectToDevice(deviceId);
  } else {
    return BLE.connectToDevice(deviceId, false);
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
  if (BLE_ONLY_DIAGNOSTIC) {
    // Log every command + full response so the init sequence is fully visible
    dlog(`[BLE-DIAG] CMD → ${command}`);
    const resp = await BLE.sendCommand(command, timeoutMs);
    const safe = resp.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    dlog(`[BLE-DIAG] CMD ← "${safe}"`);
    return resp;
  }
  if (activeTransport === 'mfi') {
    return BTClassic.sendCommand(command, timeoutMs);
  } else {
    return BLE.sendCommand(command, timeoutMs);
  }
}

/**
 * Send ATSH to set the CAN header and return whether it was accepted.
 * For 8-char (4-byte) 29-bit headers: tries the full form first; on first '?'
 * rejection, falls back to ATCP + 3-byte ATSH and remembers for this connection.
 * 3-char (3-byte, 11-bit) headers pass through to a plain sendCommand.
 */
export async function sendAtsh(header: string): Promise<boolean> {
  if (header.length === 8 && shortAtsh) {
    await sendCommand(`ATCP${header.substring(0, 2)}`, 1500);
    const r = await sendCommand(`ATSH${header.substring(2)}`, 1500);
    return !r.includes('?');
  }
  const r = await sendCommand(`ATSH${header}`, 1500);
  if (!r.includes('?')) return true;
  if (header.length === 8) {
    dlog('OBD: 4-byte ATSH rejected — switching to ATCP + 3-byte split form for this connection');
    shortAtsh = true;
    await sendCommand(`ATCP${header.substring(0, 2)}`, 1500);
    const r2 = await sendCommand(`ATSH${header.substring(2)}`, 1500);
    return !r2.includes('?');
  }
  return false;
}

/** Register disconnect callback. Returns cleanup function. */
export function onDisconnect(callback: () => void): () => void {
  if (activeTransport === 'mfi') {
    return BTClassic.onDisconnect(callback);
  } else {
    return BLE.onDisconnect(callback);
  }
}
