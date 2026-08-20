/**
 * Focus mode — up to 3 gauges filling the screen.
 *
 * A flex column with no ScrollView: each gauge takes an equal share of the
 * available height, so overflow is structurally impossible. That guarantee is
 * the whole point of the mode.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable, SafeAreaView } from 'react-native';
import { useVehicleStore } from '../store/vehicleStore';
import { GaugeCard } from './GaugeCard';
import { AlertBanner } from './AlertBanner';
import { colors, fonts } from '../config/theme';
import { formatGaugeValue } from '../utils/gaugeFormat';
import type { PidDef } from '../config/pidRegistry';
import type { Units } from '../utils/units';

/** Multiplier for gauge type in focus mode. Tune on device — see Task 9. */
const FOCUS_SCALE = 2.4;

interface FocusViewProps {
  gauges: PidDef[];
  units: Units;
  onExit: () => void;
  onNavigate?: (screen: string) => void;
}

export function FocusView({ gauges, units, onExit, onNavigate }: FocusViewProps) {
  const store = useVehicleStore();
  const { alertMessage, alertPriority, bleConnected } = store;

  return (
    <SafeAreaView style={styles.container}>
      {/* Adapter dropped — the only signal, since the BLE pill is hidden here */}
      {!bleConnected && (
        <View style={styles.disconnectStrip}>
          <Text style={styles.disconnectText}>ADAPTER DISCONNECTED</Text>
        </View>
      )}

      <AlertBanner
        message={alertMessage}
        priority={alertPriority}
        onPress={() => onNavigate?.('alerts')}
      />

      <View style={styles.gauges}>
        {gauges.map((pid) => {
          const rawValue = (store as any)[pid.id] as number | null;
          return (
            <View key={pid.id} style={styles.gaugeSlot}>
              <GaugeCard
                title={pid.label}
                value={formatGaugeValue(pid, rawValue, units)}
                unit={units.gaugeUnit(pid.unit)}
                rawValue={units.gaugeValue(pid.unit, rawValue)}
                min={units.gaugeValue(pid.unit, pid.range[0])!}
                max={units.gaugeValue(pid.unit, pid.range[1])!}
                mode={pid.gaugeMode}
                warn={units.gaugeValue(pid.unit, pid.warn)}
                crit={units.gaugeValue(pid.unit, pid.crit)}
                scale={FOCUS_SCALE}
              />
            </View>
          );
        })}
      </View>

      <Pressable style={styles.exitBtn} onPress={onExit}>
        <Text style={styles.exitBtnText}>{'▼'} EXIT FOCUS</Text>
      </Pressable>
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
  gauges: {
    flex: 1,
    gap: 6,
  },
  gaugeSlot: {
    flex: 1,
  },
  disconnectStrip: {
    backgroundColor: 'rgba(140, 30, 20, 0.92)',
    borderRadius: 6,
    paddingVertical: 5,
    marginBottom: 4,
    alignItems: 'center',
  },
  disconnectText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
  exitBtn: {
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 160, 0.33)',
    borderRadius: 10,
    paddingVertical: 9,
    marginTop: 6,
    alignItems: 'center',
  },
  exitBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
