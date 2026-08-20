/** Segmented gauge bar with threshold-colored fill. */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../config/theme';
import type { GaugeMode } from '../config/pidRegistry';

const SEGMENT_COUNT = 14;

interface SegmentBarProps {
  value: number | null;
  min: number;
  max: number;
  mode: GaugeMode;
  warn: number | null;  // warn threshold (or null for info-only gauges)
  crit: number | null;  // crit threshold (or null for info-only gauges)
  /** Display multiplier for focus mode. 1 = normal dashboard. */
  scale?: number;
}

export function SegmentBar({ value, min, max, mode, warn, crit, scale = 1 }: SegmentBarProps) {
  // --- fuel_trim: bipolar center-zero rendering ---
  if (mode === 'fuel_trim') {
    const half = SEGMENT_COUNT / 2; // 7
    const rangeHalf = (max - min) / 2; // 25 for range [-25, 25]
    const clampedV = value === null ? 0 : Math.min(max, Math.max(min, value));
    const leftFill = Math.round(Math.max(0, -clampedV) / rangeHalf * half);
    const rightFill = Math.round(Math.max(0, clampedV) / rangeHalf * half);
    const warnSeg = warn !== null ? Math.round(warn / rangeHalf * half) : half;

    const fuelSegColor = (i: number): string => {
      const dist = i < half ? (half - 1 - i) : (i - half);
      if (dist >= warnSeg) return colors.segCrit;
      if (dist >= Math.max(0, warnSeg - 1)) return colors.segWarn;
      return colors.segOk;
    };
    const fuelIsFilled = (i: number): boolean =>
      i < half ? (half - 1 - i) < leftFill : (i - half) < rightFill;

    const trimLabel =
      value !== null && warn !== null && Math.abs(value) > warn
        ? value > 0 ? 'LEAN' : 'RICH'
        : '';

    return (
      <View style={[styles.container, { height: 28 * scale }]}>
        <View style={styles.barRow}>
          {Array.from({ length: SEGMENT_COUNT }, (_, i) => (
            <View
              key={i}
              style={[
                styles.segment,
                { height: 18 * scale, backgroundColor: fuelIsFilled(i) ? fuelSegColor(i) : colors.segEmpty },
              ]}
            />
          ))}
        </View>
        {trimLabel !== '' && <Text style={styles.label}>{trimLabel}</Text>}
      </View>
    );
  }
  // --- end fuel_trim ---

  const filled = value === null
    ? 0
    : Math.round(
        (Math.min(max, Math.max(min, value)) - min) / (max - min) * SEGMENT_COUNT,
      );

  let label = '';
  if (value !== null) {
    if (mode === 'temp') {
      if (crit !== null && value >= crit) label = 'DANGER';
      else if (warn !== null && value >= warn) label = 'CAUTION';
    } else if (mode === 'volt') {
      if (warn !== null && value < warn) label = 'LOW';
      else if (crit !== null && value > crit) label = 'HIGH';
      else label = 'OK';
    } else if (mode === 'pressure_low') {
      // Low pressure is bad (inverted logic)
      if (crit !== null && value <= crit) label = 'DANGER';
      else if (warn !== null && value <= warn) label = 'CAUTION';
    }
    // 'percent' and 'info' modes have no threshold labels
  }

  function segColor(i: number): string {
    if (mode === 'temp') {
      if (i >= SEGMENT_COUNT - 3) return colors.segCrit;
      if (i >= SEGMENT_COUNT - 6) return colors.segWarn;
      return colors.segOk;
    }
    if (mode === 'pressure_low') {
      // Low segments are danger (inverted from temp)
      if (i < 3) return colors.segCrit;
      if (i < 6) return colors.segWarn;
      return colors.segOk;
    }
    // volt, percent, info — all amber
    return colors.segOk;
  }

  return (
    <View style={[styles.container, { height: 28 * scale }]}>
      <View style={styles.barRow}>
        {Array.from({ length: SEGMENT_COUNT }, (_, i) => (
          <View
            key={i}
            style={[
              styles.segment,
              { height: 18 * scale, backgroundColor: i < filled ? segColor(i) : colors.segEmpty },
            ]}
          />
        ))}
      </View>
      {label !== '' && <Text style={styles.label}>{label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 28,
    justifyContent: 'center',
  },
  barRow: {
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 4,
  },
  segment: {
    flex: 1,
    height: 18,
    borderRadius: 2,
  },
  label: {
    position: 'absolute',
    alignSelf: 'center',
    color: 'rgba(255, 235, 200, 0.90)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
