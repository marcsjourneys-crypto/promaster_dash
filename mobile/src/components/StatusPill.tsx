/** Small pill-shaped status indicator used in top/bottom bars. */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../config/theme';

interface StatusPillProps {
  label: string;
  value: string;
  danger?: boolean;
  large?: boolean;
}

export function StatusPill({ label, value, danger = false, large = false }: StatusPillProps) {
  return (
    <View style={[styles.pill, danger && styles.danger]}>
      {label !== '' && <Text style={styles.label}>{label}</Text>}
      <Text style={[styles.value, large && styles.valueLarge]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: colors.bgPill,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  danger: {
    backgroundColor: colors.milDanger,
    borderColor: 'rgba(255, 240, 220, 0.33)',
  },
  label: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  value: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  valueLarge: {
    fontSize: fonts.sizeMd,
    letterSpacing: 2,
  },
});
