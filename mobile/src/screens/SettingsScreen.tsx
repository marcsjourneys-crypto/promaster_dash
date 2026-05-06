/** Settings screen with tabbed sections — port of Python SettingsDialog. */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  StyleSheet,
  Alert,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import { ValueStepper } from '../components/ValueStepper';
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type Settings,
} from '../config/settings';
import {
  getPidsByGroup,
  GROUP_LABELS,
  type PidGroup,
  type PidDef,
} from '../config/pidRegistry';
import { cleanupOldTrips } from '../services/loggingService';
import { useVehicleStore } from '../store/vehicleStore';

type Tab = 'thresholds' | 'trip' | 'display' | 'gauges' | 'data' | 'vehicle';

interface SettingsScreenProps {
  onBack: () => void;
  liveMode: boolean;
  onLiveModeChange: (live: boolean) => void;
  onNavigate?: (screen: string) => void;
}

export function SettingsScreen({ onBack, liveMode, onLiveModeChange, onNavigate }: SettingsScreenProps) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [activeTab, setActiveTab] = useState<Tab>('gauges');
  const [modified, setModified] = useState(false);
  const { gpsOk, dtcCount } = useVehicleStore((s) => ({ gpsOk: s.gpsOk, dtcCount: s.dtcCount }));

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const update = useCallback((key: keyof Settings, value: number | boolean | string[]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setModified(true);
  }, []);

  const togglePid = useCallback((pidId: string) => {
    setSettings((prev) => {
      const current = prev.enabledPids;
      const next = current.includes(pidId)
        ? current.filter((id) => id !== pidId)
        : [...current, pidId];
      return { ...prev, enabledPids: next };
    });
    setModified(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (modified) {
      await saveSettings(settings);
    }
    onBack();
  }, [modified, settings, onBack]);

  const handleReset = useCallback(() => {
    Alert.alert('Reset Settings', 'Reset all settings to defaults?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          setSettings({ ...DEFAULT_SETTINGS });
          setModified(true);
        },
      },
    ]);
  }, []);

  const handleCleanup = useCallback(() => {
    Alert.alert(
      'Cleanup Trips',
      `Delete trips older than ${settings.dataRetentionDays} days?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const deleted = await cleanupOldTrips(settings.dataRetentionDays);
            Alert.alert('Cleanup Complete', `Deleted ${deleted} old trips.`);
          },
        },
      ],
    );
  }, [settings.dataRetentionDays]);

  const pidGroups = getPidsByGroup();
  const enabledSet = new Set(settings.enabledPids);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={handleSave}>
          <Text style={styles.backBtnText}>\u2190 Save</Text>
        </Pressable>
        <Text style={styles.title}>SETTINGS</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(['gauges', 'thresholds', 'trip', 'display', 'vehicle', 'data'] as Tab[]).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {activeTab === 'gauges' && (
          <>
            <Text style={styles.infoText}>
              Toggle which gauges appear on the dashboard. RPM and Speed are always shown.
            </Text>
            {(Object.keys(pidGroups) as PidGroup[]).map((group) => {
              const pids = pidGroups[group];
              if (pids.length === 0) return null;
              return (
                <View key={group}>
                  <Text style={[styles.sectionHeader, { marginTop: 16 }]}>{GROUP_LABELS[group]}</Text>
                  {pids.map((pid) => (
                    <View key={pid.id} style={styles.switchRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.switchLabel}>{pid.label}</Text>
                        <Text style={styles.switchHint}>{pid.unit}</Text>
                      </View>
                      <Switch
                        value={enabledSet.has(pid.id)}
                        onValueChange={() => togglePid(pid.id)}
                        trackColor={{ false: 'rgba(60, 55, 45, 1)', true: 'rgba(180, 130, 50, 0.6)' }}
                        thumbColor={enabledSet.has(pid.id) ? colors.amber : 'rgba(150, 140, 120, 1)'}
                      />
                    </View>
                  ))}
                </View>
              );
            })}
          </>
        )}

        {activeTab === 'thresholds' && (
          <>
            {enabledSet.has('transF') && (
              <>
                <Text style={styles.sectionHeader}>TRANS TEMP</Text>
                <ValueStepper
                  label="Warning"
                  min={200} max={260} value={settings.transWarnF} suffix="\u00b0F"
                  onChange={(v) => update('transWarnF', v)}
                />
                <ValueStepper
                  label="Critical"
                  min={220} max={280} value={settings.transCritF} suffix="\u00b0F"
                  onChange={(v) => update('transCritF', v)}
                />
              </>
            )}

            {enabledSet.has('coolantF') && (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 20 }]}>COOLANT TEMP</Text>
                <ValueStepper
                  label="Warning"
                  min={200} max={240} value={settings.coolantWarnF} suffix="\u00b0F"
                  onChange={(v) => update('coolantWarnF', v)}
                />
                <ValueStepper
                  label="Critical"
                  min={210} max={250} value={settings.coolantCritF} suffix="\u00b0F"
                  onChange={(v) => update('coolantCritF', v)}
                />
              </>
            )}

            {enabledSet.has('voltageV') && (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 20 }]}>VOLTAGE</Text>
                <ValueStepper
                  label="Low"
                  min={10} max={12.5} value={settings.voltLow} suffix="V" decimals={1} step={0.1}
                  onChange={(v) => update('voltLow', v)}
                />
                <ValueStepper
                  label="High"
                  min={14} max={16} value={settings.voltHigh} suffix="V" decimals={1} step={0.1}
                  onChange={(v) => update('voltHigh', v)}
                />
              </>
            )}

            {enabledSet.has('oilPressurePsi') && (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 20 }]}>OIL PRESSURE</Text>
                <ValueStepper
                  label="Warning (below)"
                  min={10} max={30} value={settings.oilPressureWarnPsi} suffix=" PSI"
                  onChange={(v) => update('oilPressureWarnPsi', v)}
                />
                <ValueStepper
                  label="Critical (below)"
                  min={5} max={20} value={settings.oilPressureCritPsi} suffix=" PSI"
                  onChange={(v) => update('oilPressureCritPsi', v)}
                />
              </>
            )}

            {enabledSet.has('oilTempF') && (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 20 }]}>OIL TEMP</Text>
                <ValueStepper
                  label="Warning"
                  min={220} max={270} value={settings.oilTempWarnF} suffix="\u00b0F"
                  onChange={(v) => update('oilTempWarnF', v)}
                />
                <ValueStepper
                  label="Critical"
                  min={240} max={300} value={settings.oilTempCritF} suffix="\u00b0F"
                  onChange={(v) => update('oilTempCritF', v)}
                />
              </>
            )}

            {enabledSet.has('intakeAirF') && (
              <>
                <Text style={[styles.sectionHeader, { marginTop: 20 }]}>INTAKE AIR TEMP</Text>
                <ValueStepper
                  label="Warning"
                  min={140} max={180} value={settings.intakeAirWarnF} suffix="\u00b0F"
                  onChange={(v) => update('intakeAirWarnF', v)}
                />
                <ValueStepper
                  label="Critical"
                  min={160} max={200} value={settings.intakeAirCritF} suffix="\u00b0F"
                  onChange={(v) => update('intakeAirCritF', v)}
                />
              </>
            )}

            {!enabledSet.has('transF') && !enabledSet.has('coolantF') && !enabledSet.has('voltageV') &&
             !enabledSet.has('oilPressurePsi') && !enabledSet.has('oilTempF') && !enabledSet.has('intakeAirF') && (
              <Text style={styles.infoText}>
                No gauges with configurable thresholds are enabled.{'\n'}
                Enable gauges in the GAUGES tab first.
              </Text>
            )}
          </>
        )}

        {activeTab === 'trip' && (
          <>
            <Text style={styles.sectionHeader}>TRIP DETECTION</Text>
            <ValueStepper
              label="Start Speed"
              min={3} max={10} value={settings.tripStartSpeedMph} suffix=" mph"
              onChange={(v) => update('tripStartSpeedMph', v)}
            />
            <ValueStepper
              label="Stop Timeout"
              min={2} max={15} value={settings.tripStopTimeoutMin} suffix=" min"
              onChange={(v) => update('tripStopTimeoutMin', v)}
            />
            <ValueStepper
              label="Breadcrumb Interval"
              min={1} max={30} value={settings.breadcrumbIntervalSec} suffix=" sec"
              onChange={(v) => update('breadcrumbIntervalSec', v)}
            />
            <Text style={styles.infoText}>
              Trip starts when speed exceeds the start threshold.{'\n'}
              Trip ends after vehicle is stationary for the timeout period.{'\n'}
              Breadcrumbs record position at the specified interval.
            </Text>
          </>
        )}

        {activeTab === 'display' && (
          <>
            <Text style={styles.sectionHeader}>MODE</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Live Mode</Text>
                <Text style={styles.switchHint}>
                  {liveMode ? 'Using real GPS + OBD data' : 'Using simulated demo data'}
                </Text>
              </View>
              <Switch
                value={liveMode}
                onValueChange={onLiveModeChange}
                trackColor={{ false: 'rgba(60, 55, 45, 1)', true: 'rgba(100, 180, 100, 0.6)' }}
                thumbColor={liveMode ? 'rgb(100, 200, 130)' : 'rgba(150, 140, 120, 1)'}
              />
            </View>

            <Text style={[styles.sectionHeader, { marginTop: 20 }]}>UNITS</Text>
            <View style={styles.unitRow}>
              <Text style={styles.switchLabel}>Temperature</Text>
              <View style={styles.unitToggle}>
                <Pressable
                  style={[styles.unitBtn, settings.tempUnit === 'F' && styles.unitBtnActive]}
                  onPress={() => update('tempUnit', 'F' as any)}
                >
                  <Text style={[styles.unitBtnText, settings.tempUnit === 'F' && styles.unitBtnTextActive]}>\u00b0F</Text>
                </Pressable>
                <Pressable
                  style={[styles.unitBtn, settings.tempUnit === 'C' && styles.unitBtnActive]}
                  onPress={() => update('tempUnit', 'C' as any)}
                >
                  <Text style={[styles.unitBtnText, settings.tempUnit === 'C' && styles.unitBtnTextActive]}>\u00b0C</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.unitRow}>
              <Text style={styles.switchLabel}>Speed</Text>
              <View style={styles.unitToggle}>
                <Pressable
                  style={[styles.unitBtn, settings.speedUnit === 'mph' && styles.unitBtnActive]}
                  onPress={() => update('speedUnit', 'mph' as any)}
                >
                  <Text style={[styles.unitBtnText, settings.speedUnit === 'mph' && styles.unitBtnTextActive]}>MPH</Text>
                </Pressable>
                <Pressable
                  style={[styles.unitBtn, settings.speedUnit === 'kph' && styles.unitBtnActive]}
                  onPress={() => update('speedUnit', 'kph' as any)}
                >
                  <Text style={[styles.unitBtnText, settings.speedUnit === 'kph' && styles.unitBtnTextActive]}>KPH</Text>
                </Pressable>
              </View>
            </View>

          </>
        )}

        {activeTab === 'vehicle' && (
          <>
            <Text style={styles.sectionHeader}>DUTY CYCLE</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Severe Duty</Text>
                <Text style={styles.switchHint}>
                  Heavy hauling / camper use. Halves all maintenance intervals.
                </Text>
              </View>
              <Switch
                value={settings.severeDuty}
                onValueChange={(v) => update('severeDuty', v)}
                trackColor={{ false: 'rgba(60, 55, 45, 1)', true: 'rgba(180, 130, 50, 0.6)' }}
                thumbColor={settings.severeDuty ? colors.amber : 'rgba(150, 140, 120, 1)'}
              />
            </View>
          </>
        )}

        {activeTab === 'data' && (
          <>
            <Text style={styles.sectionHeader}>CONNECTION STATUS</Text>
            <View style={styles.statusRow}>
              <Text style={styles.switchLabel}>GPS</Text>
              <Text style={[styles.statusValue, { color: gpsOk ? '#50a050' : colors.textMuted }]}>
                {gpsOk ? 'OK' : 'NO SIGNAL'}
              </Text>
            </View>
            <View style={styles.statusRow}>
              <Text style={styles.switchLabel}>CHECK ENGINE</Text>
              <Text style={[styles.statusValue, { color: dtcCount > 0 ? '#e05050' : '#50a050' }]}>
                {dtcCount > 0 ? `${dtcCount} CODE${dtcCount > 1 ? 'S' : ''}` : 'OK'}
              </Text>
            </View>

            <Text style={[styles.sectionHeader, { marginTop: 20 }]}>DATA MANAGEMENT</Text>
            <ValueStepper
              label="Data Retention"
              min={30} max={730} value={settings.dataRetentionDays} suffix=" days"
              onChange={(v) => update('dataRetentionDays', v)}
            />
            <View style={styles.dataActions}>
              <Pressable style={styles.dataBtn} onPress={handleCleanup}>
                <Text style={styles.dataBtnText}>CLEANUP OLD TRIPS</Text>
              </Pressable>
              <Pressable style={styles.dataBtn} onPress={() => onNavigate?.('debug')}>
                <Text style={styles.dataBtnText}>VIEW DEBUG LOG</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>

      {/* Bottom buttons */}
      <View style={styles.bottomRow}>
        <Pressable style={styles.resetBtn} onPress={handleReset}>
          <Text style={styles.resetBtnText}>RESET DEFAULTS</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
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
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
  },
  backBtnText: { color: '#fff', fontSize: fonts.sizeSm, fontWeight: '900' },
  title: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1 },
  tabRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 4, marginBottom: 4 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: 'rgba(35, 32, 26, 0.86)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.18)',
    borderRadius: 6,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: 'rgba(60, 55, 45, 0.94)',
    borderBottomWidth: 2,
    borderBottomColor: colors.amber,
  },
  tabText: { color: 'rgba(200, 190, 170, 0.86)', fontSize: 11, fontWeight: '800' },
  tabTextActive: { color: colors.textPrimary },
  content: { flex: 1 },
  contentInner: { paddingHorizontal: 16, paddingVertical: 12 },
  sectionHeader: {
    color: 'rgba(220, 180, 120, 0.94)',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 8,
  },
  infoText: { color: 'rgba(150, 145, 135, 0.78)', fontSize: fonts.sizeXs, marginTop: 16, lineHeight: 18 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  switchLabel: { color: 'rgba(220, 210, 195, 0.94)', fontSize: fonts.sizeSm, fontWeight: '700' },
  switchHint: { color: 'rgba(150, 145, 135, 0.78)', fontSize: fonts.sizeXs, marginTop: 2 },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  unitToggle: { flexDirection: 'row', gap: 4 },
  unitBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.2)',
    backgroundColor: colors.bgCard,
  },
  unitBtnActive: {
    borderColor: colors.amber,
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
  },
  unitBtnText: { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '800' },
  unitBtnTextActive: { color: colors.amber },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  statusValue: { fontSize: fonts.sizeSm, fontWeight: '700' },
  dataActions: { marginTop: 20, gap: 10 },
  dataBtn: {
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.29)',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dataBtnText: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800' },
  bottomRow: { paddingHorizontal: 16, paddingBottom: 12 },
  resetBtn: {
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 25, 0.4)',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  resetBtnText: { color: 'rgba(220, 80, 60, 0.9)', fontSize: fonts.sizeSm, fontWeight: '800' },
});
