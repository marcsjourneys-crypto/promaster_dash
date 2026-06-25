/** Main dashboard screen — the primary driving view. */

import React from 'react';
import { View, Text, StyleSheet, Pressable, SafeAreaView, ScrollView } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useVehicleStore } from '../store/vehicleStore';
import type { OBDData } from '../store/vehicleStore';
import { GaugeCard } from '../components/GaugeCard';
import { AlertBanner } from '../components/AlertBanner';
import { StatusPill } from '../components/StatusPill';
import { useMockData } from '../hooks/useMockData';
import { useGPS } from '../hooks/useGPS';
import { colors, fonts } from '../config/theme';
import { getSortedPids, type PidDef } from '../config/pidRegistry';
import { forceEndTrip } from '../services/tripManager';

function cardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.floor((deg + 22.5) / 45) % 8];
}

function formatTripTime(startTs: number | null): string {
  if (!startTs) return '--:--:--';
  const elapsed = Math.floor(Date.now() / 1000 - startTs);
  if (elapsed < 0) return '00:00:00';
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/** Format a store value for display on a gauge card. */
function formatGaugeValue(pid: PidDef, value: number | null): string {
  if (value === null) return '--';
  // Fuel trim: signed, 1 decimal
  if (pid.gaugeMode === 'fuel_trim') {
    return (value > 0 ? '+' : '') + value.toFixed(1);
  }
  // Temperatures and pressures: no decimals
  if (pid.gaugeMode === 'temp' || pid.gaugeMode === 'pressure_low') {
    return value.toFixed(0);
  }
  // Voltage: 1 decimal
  if (pid.gaugeMode === 'volt') {
    return value.toFixed(1);
  }
  // Percentages: 1 decimal
  if (pid.gaugeMode === 'percent') {
    return value.toFixed(1);
  }
  // Info gauges: variable
  if (pid.unit === 'g/s') return value.toFixed(1);
  if (pid.unit === '\u00b0') return value.toFixed(1);
  return value.toFixed(0);
}

interface DashboardScreenProps {
  onNavigate?: (screen: string) => void;
  useLiveGPS?: boolean;
  enabledPids?: string[];
}

export function DashboardScreen({ onNavigate, useLiveGPS = false, enabledPids = [] }: DashboardScreenProps) {
  useKeepAwake();
  useGPS(useLiveGPS);
  useMockData(!useLiveGPS);

  const store = useVehicleStore();
  const {
    rpm, speedMph,
    headingDeg, elevationFt, gradePct, climbing,
    tripActive, tripStartTs, tripDistanceMi,
    alertMessage, alertPriority,
    bleConnected,
    supportedMode01Pids, mode01DiscoveryDone,
  } = store;

  // Force re-render for trip timer
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const headingStr =
    headingDeg !== null
      ? `${cardinal(headingDeg)} ${headingDeg.toString().padStart(3, '0')}`
      : 'HDG --';
  const elevStr = elevationFt !== null ? `${elevationFt}` : '--';
  const gradeStr =
    gradePct !== null
      ? `${climbing ? '^' : gradePct < -0.5 ? 'v' : ''} ${gradePct > 0 ? '+' : ''}${gradePct.toFixed(1)}%`
      : '-- %';

  // Build list of enabled gauge cards from PID registry
  const enabledSet = new Set(enabledPids);
  const enabledGauges = getSortedPids().filter((pid) => {
    if (!enabledSet.has(pid.id)) return false;
    // Hide fuel-trim gauges for PIDs the ECU reported as unsupported after discovery
    if (pid.gaugeMode === 'fuel_trim' && mode01DiscoveryDone && !supportedMode01Pids.has(pid.pid.toUpperCase())) return false;
    return true;
  });

  return (
    <SafeAreaView style={styles.container}>
      {/* ---- Top status bar ---- */}
      <View style={styles.statusBar}>
        <StatusPill label="TRIP" value={tripActive ? formatTripTime(tripStartTs) : '--:--:--'} />
        <StatusPill label="" value={headingStr} large />
      </View>

      <View style={styles.statusBar}>
        <StatusPill label="ELEV" value={`${elevStr} FT`} />
        <StatusPill label="GRADE" value={gradeStr} />
        <Pressable onPress={() => onNavigate?.('ble')}>
          <StatusPill label="BLE" value={bleConnected ? 'ON' : '--'} />
        </Pressable>
        <Pressable style={styles.iconBtn} onPress={() => onNavigate?.('settings')}>
          <Text style={styles.iconBtnText}>{'\u2699'}</Text>
        </Pressable>
      </View>

      {/* ---- Alert Banner ---- */}
      <AlertBanner message={alertMessage} priority={alertPriority} onPress={() => onNavigate?.('alerts')} />

      {/* ---- Live Trip Bar ---- */}
      {tripActive && (
        <View style={styles.tripBar}>
          <Text style={styles.tripLabel}>TRIP</Text>
          <Text style={styles.tripStat}>{tripDistanceMi.toFixed(1)} mi</Text>
          <Text style={styles.tripSep}>|</Text>
          <Text style={styles.tripStat}>{formatTripTime(tripStartTs)}</Text>
          <Pressable style={styles.tripEndBtn} onPress={() => forceEndTrip()}>
            <Text style={styles.tripEndBtnText}>END</Text>
          </Pressable>
        </View>
      )}

      {/* ---- Speed hero ---- */}
      <View style={styles.speedHero}>
        <Text style={styles.speedValue}>
          {speedMph !== null ? speedMph.toFixed(0) : '--'}
        </Text>
        <Text style={styles.speedUnit}>MPH</Text>
        <View style={styles.rpmChip}>
          <Text style={styles.rpmLabel}>RPM</Text>
          <Text style={styles.rpmValue}>{rpm !== null ? rpm.toString() : '--'}</Text>
        </View>
      </View>

      {/* ---- Gauge cards (dynamic from enabled PIDs) ---- */}
      <ScrollView style={styles.gaugesScroll} contentContainerStyle={styles.gaugesContainer}>
        {enabledGauges.map((pid, idx) => {
          const rawValue = (store as any)[pid.id] as number | null;
          // Check if this is the last item and odd count — stretch full width
          const isLast = idx === enabledGauges.length - 1;
          const isOddTotal = enabledGauges.length % 2 === 1;
          const fullWidth = isLast && isOddTotal;

          return (
            <View key={pid.id} style={fullWidth ? styles.gaugeCardFull : styles.gaugeCardHalf}>
              <GaugeCard
                title={pid.label}
                value={formatGaugeValue(pid, rawValue)}
                unit={pid.unit}
                rawValue={rawValue}
                min={pid.range[0]}
                max={pid.range[1]}
                mode={pid.gaugeMode}
                warn={pid.warn}
                crit={pid.crit}
              />
            </View>
          );
        })}
      </ScrollView>

      {/* ---- Bottom action buttons ---- */}
      <View style={styles.actionRow}>
        <Pressable style={styles.actionBtn} onPress={() => onNavigate?.('trips')}>
          <Text style={styles.actionBtnText}>TRIPS</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => onNavigate?.('codes')}>
          <Text style={styles.actionBtnText}>SCAN CODES</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => onNavigate?.('maintenance')}>
          <Text style={styles.actionBtnText}>MAINT LOG</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
  },

  // ---- Status bars ----
  statusBar: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    marginBottom: 4,
  },
  iconBtn: {
    backgroundColor: colors.bgPill,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  iconBtnText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },

  // ---- Trip bar ----
  tripBar: {
    backgroundColor: colors.bgTrip,
    borderWidth: 1,
    borderColor: colors.tripBorder,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  tripLabel: {
    color: colors.tripLabel,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
  tripStat: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  tripSep: {
    color: colors.tripLabel,
    fontSize: fonts.sizeSm,
  },
  tripEndBtn: {
    marginLeft: 'auto',
    paddingVertical: 2,
    paddingHorizontal: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 25, 0.6)',
  },
  tripEndBtnText: {
    color: 'rgba(200, 50, 35, 0.9)',
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ---- Speed hero ----
  speedHero: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  speedValue: {
    color: colors.textPrimary,
    fontSize: 72,
    fontWeight: '900',
    lineHeight: 76,
  },
  speedUnit: {
    color: colors.textMuted,
    fontSize: fonts.sizeXl,
    fontWeight: '800',
  },
  rpmChip: {
    backgroundColor: colors.bgPill,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 12,
    alignItems: 'center',
  },
  rpmLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
  },
  rpmValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },

  // ---- Gauges ----
  gaugesScroll: {
    flex: 1,
    marginVertical: 4,
  },
  gaugesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  gaugeCardHalf: {
    width: '48.5%',
    minHeight: 120,
  },
  gaugeCardFull: {
    width: '100%',
    minHeight: 120,
  },

  // ---- Action buttons ----
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 4,
    paddingBottom: 2,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 160, 0.33)',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
