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
import { gaugeCardProps } from '../utils/gaugeFormat';
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
      {/*
        Fixed-height header slot. Both children below are conditional, and the
        gauge stack is flex:1 — so if this space were not reserved, an alert
        firing mid-drive would silently shrink all three gauges at once. The
        approved design is "banner only, layout never changes". Keep the height
        even when nothing is showing; do NOT collapse it to save pixels.
      */}
      <View style={styles.headerSlot}>
        {!bleConnected ? (
          /*
            Adapter dropped — the only signal, since the BLE pill is hidden
            here. Deliberately REPLACES the alert banner rather than stacking
            above it: with no adapter every gauge value is stale, so an alert
            computed from those values may be minutes old. "no live data" is
            the more actionable message, and one child always fits the slot.
          */
          <View style={styles.disconnectStrip}>
            <Text style={styles.disconnectText}>ADAPTER DISCONNECTED</Text>
          </View>
        ) : (
          <AlertBanner
            message={alertMessage}
            priority={alertPriority}
            onPress={() => onNavigate?.('alerts')}
          />
        )}
      </View>

      <View style={styles.gauges}>
        {gauges.map((pid) => {
          const rawValue = (store as any)[pid.id] as number | null;
          return (
            <View key={pid.id} style={styles.gaugeSlot}>
              <GaugeCard {...gaugeCardProps(pid, rawValue, units)} scale={FOCUS_SCALE} />
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
  /**
   * Reserved header space — always present, alert or not.
   *
   * Height = one AlertBanner at its natural size:
   *   borderWidth 2 x 2 (top + bottom)      =  4
   *   paddingVertical 12 x 2                = 24
   *   one line of fonts.sizeLg (20) text    = 24   (~1.2x line box)
   *                                          ----
   *                                            52
   *
   * `overflow: 'hidden'` is the guarantee, not a cosmetic choice: if both the
   * disconnect strip and a two-line banner are showing, the surplus is clipped
   * here rather than pushing into the gauge stack. Gauges never resize.
   */
  headerSlot: {
    // 52 = AlertBanner's borderWidth 2*2 + paddingVertical 12*2 + one 20pt
    // line box (~24). Exactly one child ever renders, so nothing clips.
    height: 52,
    overflow: 'hidden',
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
