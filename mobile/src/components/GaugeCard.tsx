/** Metal-style gauge card with value display and segment bar. */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SegmentBar } from './SegmentBar';
import { colors, fonts } from '../config/theme';

import type { GaugeMode } from '../config/pidRegistry';

interface GaugeCardProps {
  title: string;
  value: string;        // Formatted display value like "225" or "--"
  unit: string;         // "°F" or "V"
  rawValue: number | null;
  min: number;
  max: number;
  mode: GaugeMode;
  warn: number | null;
  crit: number | null;
}

export function GaugeCard({
  title,
  value,
  unit,
  rawValue,
  min,
  max,
  mode,
  warn,
  crit,
}: GaugeCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.inner}>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.valueRow}>
          <Text style={styles.value}>{value}</Text>
          <Text style={styles.unit}>{unit}</Text>
        </View>
        <View style={styles.barContainer}>
          <SegmentBar
            value={rawValue}
            min={min}
            max={max}
            mode={mode}
            warn={warn}
            crit={crit}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: 'rgba(70, 62, 48, 0.86)',
    padding: 5,
  },
  inner: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: colors.bgCard,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    justifyContent: 'space-between',
  },
  title: {
    color: colors.textSecondary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 4,
  },
  value: {
    color: colors.textPrimary,
    fontSize: fonts.size2xl,
    fontWeight: '900',
  },
  unit: {
    color: colors.textMuted,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
    marginLeft: 4,
  },
  barContainer: {
    marginTop: 8,
  },
});
