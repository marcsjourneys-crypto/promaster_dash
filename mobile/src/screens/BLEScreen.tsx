/** OBD connection screen — supports MFi (classic BT) and BLE transports. */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Alert,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import { useVehicleStore } from '../store/vehicleStore';
import {
  scanForDevices,
  connectToDevice,
  disconnect,
  isConnected,
  getConnectedDeviceName,
  setTransport,
  getTransport,
  type ScannedDevice,
  type TransportType,
} from '../services/obdTransport';
import { initializeAdapter, startPolling, stopPolling, setTransCandidate, getTransCandidate, saveTransCandidate, loadTransCandidate, clearTransCandidate, getLockedProtocol } from '../services/obdService';
import { scanCandidates, selectBestCandidate, type CandidateResult } from '../services/transTempCandidates';

import { dlog } from '../services/debugLog';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_DEVICE_KEY = '@promaster/lastDevice';

interface BLEScreenProps {
  onBack: () => void;
}

export function BLEScreen({ onBack }: BLEScreenProps) {
  const [transport, setTransportState] = useState<TransportType>(getTransport());
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedDevice[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(isConnected());
  const [connectedName, setConnectedName] = useState(getConnectedDeviceName());
  const [scanningTrans, setScanningTrans] = useState(false);
  const [transResults, setTransResults] = useState<CandidateResult[]>([]);
  const [adapterSupports29bit, setAdapterSupports29bit] = useState<boolean | null>(null);
  const [savedDevice, setSavedDevice] = useState<ScannedDevice | null>(null);
  const setBleConnected = useVehicleStore((s) => s.setBleConnected);

  // Check connection on mount and load saved device
  useEffect(() => {
    setConnected(isConnected());
    setConnectedName(getConnectedDeviceName());
    AsyncStorage.getItem(LAST_DEVICE_KEY).then((raw) => {
      if (raw) {
        try { setSavedDevice(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const handleToggleTransport = useCallback(() => {
    const next: TransportType = transport === 'mfi' ? 'ble' : 'mfi';
    setTransport(next);
    setTransportState(next);
    setDevices([]);
  }, [transport]);

  const handleScan = useCallback(async () => {
    setDevices([]);
    setScanning(true);
    dlog(`Scan: Starting (transport=${transport})...`);

    const stopScan = await scanForDevices((device) => {
      setDevices((prev) => {
        if (prev.some((d) => d.id === device.id)) return prev;
        return [...prev, device];
      });
    }, 10000);

    setTimeout(() => {
      setScanning(false);
    }, 10000);

    return stopScan;
  }, []);

  const handleConnect = useCallback(async (device: ScannedDevice) => {
    setConnecting(true);
    dlog(`Connect: Tapped ${device.name ?? device.id}`);
    const ok = await connectToDevice(device.id);

    if (ok) {
      // Save this device for future quick-reconnect
      AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device)).catch(() => {});

      dlog('Connect: Transport connected, initializing ELM327...');
      const initOk = await initializeAdapter();
      if (initOk) {
        setConnected(true);
        setConnectedName(device.name);
        setBleConnected(true);

        // Load saved trans candidate or auto-scan for one
        const saved = await loadTransCandidate();
        if (saved && saved.twoByteMode === false) {
          dlog('Trans: Clearing stale candidate (twoByteMode was false, needs re-scan)');
          await clearTransCandidate();
          setTransCandidate(null);
        } else if (saved) {
          setTransCandidate(saved);
          dlog(`Trans: Using saved candidate "${saved.name}"`);
        }
        if (!saved || saved.twoByteMode === false) {
          dlog('Trans: No saved candidate — scanning...');
          try {
            const { results, supports29bit } = await scanCandidates(getLockedProtocol());
            setAdapterSupports29bit(supports29bit);
            const best = selectBestCandidate(results);
            if (best) {
              setTransCandidate(best);
              await saveTransCandidate(best);
              dlog(`Trans: Auto-found "${best.name}" (DID ${best.did})`);
            } else {
              dlog('Trans: Auto-scan found no valid candidates');
            }
          } catch (e: any) {
            dlog(`Trans: Auto-scan error: ${e.message}`);
          }
        }

        startPolling();
        dlog('Connect: SUCCESS — polling started');
        Alert.alert('Connected', `Connected to ${device.name ?? device.id}. OBD polling started.`);
      } else {
        dlog('Connect: ELM327 init FAILED');
        Alert.alert('Init Failed', 'Connected to adapter but ELM327 initialization failed.');
        await disconnect();
      }
    } else {
      dlog('Connect: Transport connect FAILED');
      Alert.alert('Connection Failed', `Could not connect to ${device.name ?? device.id}`);
    }
    setConnecting(false);
  }, [setBleConnected]);

  const handleDisconnect = useCallback(async () => {
    stopPolling();
    await disconnect();
    setConnected(false);
    setConnectedName(null);
    setBleConnected(false);
    setTransCandidate(null);
    setTransResults([]);
    setAdapterSupports29bit(null);
  }, [setBleConnected]);

  const handleScanTrans = useCallback(async () => {
    setScanningTrans(true);
    stopPolling();
    try {
      const { results, supports29bit } = await scanCandidates(getLockedProtocol());
      setTransResults(results);
      setAdapterSupports29bit(supports29bit);

      const best = selectBestCandidate(results);
      if (best) {
        setTransCandidate(best);
        await saveTransCandidate(best);
        Alert.alert(
          'Trans Temp Found',
          `Working: ${best.name}\nHeader: ${best.header}\nDID: ${best.did}`,
        );
      } else {
        Alert.alert('No Trans Temp', 'None of the candidate DIDs returned valid data.');
      }
    } catch (e: any) {
      Alert.alert('Scan Error', e.message);
    } finally {
      startPolling();
      setScanningTrans(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>OBD2 CONNECTION</Text>
      </View>

      {/* Transport Toggle */}
      <View style={styles.transportRow}>
        <Pressable
          style={[styles.transportBtn, transport === 'mfi' && styles.transportActive]}
          onPress={handleToggleTransport}
          disabled={connected}
        >
          <Text style={[styles.transportBtnText, transport === 'mfi' && styles.transportActiveText]}>
            MFi (Classic BT)
          </Text>
        </Pressable>
        <Pressable
          style={[styles.transportBtn, transport === 'ble' && styles.transportActive]}
          onPress={handleToggleTransport}
          disabled={connected}
        >
          <Text style={[styles.transportBtnText, transport === 'ble' && styles.transportActiveText]}>
            BLE
          </Text>
        </Pressable>
      </View>
      {transport === 'mfi' && (
        <Text style={styles.transportNote}>
          MFi mode: Full multi-CAN support (HS/MS/SW/CH/LS-CAN). VLinker MS must be in MFi mode and paired in iOS Settings → Bluetooth.
        </Text>
      )}
      {transport === 'ble' && (
        <Text style={styles.transportNote}>
          BLE mode: Use VgateFwUpdater app to switch VLinker MS to BLE+BT mode first.
        </Text>
      )}

      {/* Connection Status */}
      <View style={[styles.statusCard, connected ? styles.statusConnected : styles.statusDisconnected]}>
        <Text style={styles.statusTitle}>
          {connected ? 'CONNECTED' : 'DISCONNECTED'}
        </Text>
        {connected && connectedName && (
          <Text style={styles.statusDetail}>{connectedName}</Text>
        )}
        {connected && getTransCandidate() && (
          <Text style={styles.statusDetail}>
            Trans temp: {getTransCandidate()!.name}
          </Text>
        )}
        {connected && adapterSupports29bit === true && (
          <Text style={styles.capabilityOk}>29-bit CAN: supported</Text>
        )}
        {connected && adapterSupports29bit === false && (
          <Text style={styles.capabilityWarning}>
            29-bit CAN: not supported — trans temp may be unavailable
          </Text>
        )}
      </View>

      {/* Actions */}
      {/* Quick reconnect to last device */}
      {!connected && savedDevice && (
        <Pressable
          style={styles.reconnectBtn}
          onPress={() => handleConnect(savedDevice)}
          disabled={connecting}
        >
          <Text style={styles.reconnectBtnText}>
            {connecting ? 'CONNECTING...' : `RECONNECT TO ${savedDevice.name ?? savedDevice.id}`}
          </Text>
        </Pressable>
      )}

      {connected ? (
        <View style={styles.actionsRow}>
          <Pressable style={styles.actionBtn} onPress={handleScanTrans} disabled={scanningTrans || connecting}>
            {scanningTrans ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.actionBtnText}>SCAN TRANS TEMP</Text>
            )}
          </Pressable>
          <Pressable style={[styles.actionBtn, styles.disconnectBtn]} onPress={handleDisconnect}>
            <Text style={styles.disconnectBtnText}>DISCONNECT</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          style={styles.scanBtn}
          onPress={handleScan}
          disabled={scanning || connecting}
        >
          {scanning ? (
            <View style={styles.scanningRow}>
              <ActivityIndicator color={colors.textPrimary} />
              <Text style={styles.scanBtnText}>Scanning...</Text>
            </View>
          ) : (
            <Text style={styles.scanBtnText}>SCAN FOR OBD ADAPTERS</Text>
          )}
        </Pressable>
      )}

      {/* Scanned Devices List */}
      {!connected && (
        <FlatList
          data={devices}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              style={styles.deviceCard}
              onPress={() => handleConnect(item)}
              disabled={connecting}
            >
              <View style={styles.deviceInfo}>
                <Text style={styles.deviceName}>
                  {item.name || 'Unknown Device'}
                </Text>
                <Text style={styles.deviceId}>{item.id}</Text>
              </View>
              <View style={styles.deviceRssi}>
                <Text style={styles.rssiText}>
                  {item.rssi !== null ? `${item.rssi} dBm` : ''}
                </Text>
              </View>
              {connecting && (
                <ActivityIndicator color={colors.amber} />
              )}
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {scanning
                ? 'Searching for OBD adapters...'
                : 'Tap SCAN to find your VLinker MS adapter'}
            </Text>
          }
          contentContainerStyle={styles.list}
        />
      )}

      {/* Trans Temp Scan Results */}
      {transResults.length > 0 && (
        <View style={styles.transSection}>
          <Text style={styles.transSectionTitle}>TRANS TEMP CANDIDATES</Text>
          {adapterSupports29bit === false && (
            <Text style={styles.transCapabilityNote}>
              Adapter lacks 29-bit CAN — 29-bit candidates skipped. If no 11-bit candidate worked, trans temp is not available on this adapter/vehicle combination.
            </Text>
          )}
          {transResults.map((r, i) => (
            <View key={i} style={[
              styles.transRow,
              r.success && styles.transRowSuccess,
              r.skipped && styles.transRowSkipped,
            ]}>
              <Text style={[styles.transName, r.skipped && styles.transNameDim]}>
                {r.candidate.name}
              </Text>
              <Text style={[styles.transResult, r.success && styles.transResultSuccess]}>
                {r.skipped ? '—' : r.success ? `${r.tempF?.toFixed(0)}°F` : 'No data'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.bgPill,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
  },
  backBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 1,
  },
  statusCard: {
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 10,
    borderWidth: 2,
    marginBottom: 12,
  },
  statusConnected: {
    backgroundColor: 'rgba(25, 45, 35, 0.86)',
    borderColor: colors.tripBorder,
  },
  statusDisconnected: {
    backgroundColor: 'rgba(45, 25, 20, 0.86)',
    borderColor: 'rgba(180, 35, 25, 0.3)',
  },
  statusTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },
  statusDetail: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    marginTop: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 160, 0.33)',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
  disconnectBtn: {
    borderColor: 'rgba(180, 35, 25, 0.5)',
  },
  disconnectBtnText: {
    color: 'rgba(220, 80, 60, 0.9)',
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  reconnectBtn: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
    borderWidth: 2,
    borderColor: colors.amber,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  reconnectBtnText: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
  scanBtn: {
    marginHorizontal: 16,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 2,
    borderColor: colors.amber,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  scanningRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  scanBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },
  list: {
    paddingHorizontal: 16,
  },
  deviceCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  deviceId: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },
  deviceRssi: {
    marginLeft: 10,
  },
  rssiText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    textAlign: 'center',
    marginTop: 30,
  },
  transSection: {
    paddingHorizontal: 16,
    marginTop: 12,
  },
  transSectionTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 8,
  },
  transRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.bgCard,
    borderRadius: 6,
    marginBottom: 4,
  },
  transRowSuccess: {
    backgroundColor: 'rgba(25, 45, 35, 0.86)',
    borderWidth: 1,
    borderColor: colors.tripBorder,
  },
  transName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  transportRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  transportBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 160, 0.2)',
    backgroundColor: colors.bgCard,
    alignItems: 'center',
  },
  transportActive: {
    borderColor: colors.amber,
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
  },
  transportBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  transportActiveText: {
    color: colors.amber,
  },
  transportNote: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    paddingHorizontal: 16,
    marginBottom: 10,
    lineHeight: 16,
  },
  transResult: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  transResultSuccess: {
    color: colors.tripGreen,
    fontWeight: '900',
  },
  transRowSkipped: {
    opacity: 0.35,
  },
  transNameDim: {
    color: colors.textMuted,
  },
  transCapabilityNote: {
    color: colors.amber,
    fontSize: fonts.sizeXs,
    marginBottom: 8,
    lineHeight: 16,
  },
  capabilityOk: {
    color: colors.tripGreen,
    fontSize: fonts.sizeXs,
    marginTop: 6,
  },
  capabilityWarning: {
    color: colors.amber,
    fontSize: fonts.sizeXs,
    marginTop: 6,
  },
});
