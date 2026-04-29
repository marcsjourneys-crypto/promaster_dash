/** Touch-friendly numeric stepper with +/- buttons. */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../config/theme';

interface ValueStepperProps {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix?: string;
  decimals?: number;
  step?: number;
  onChange: (value: number) => void;
}

export function ValueStepper({
  label,
  min,
  max,
  value,
  suffix = '',
  decimals = 0,
  step = 1,
  onChange,
}: ValueStepperProps) {
  const formatted =
    decimals === 0
      ? `${Math.round(value)}${suffix}`
      : `${value.toFixed(decimals)}${suffix}`;

  const onMinus = () => {
    const next = Math.max(min, value - step);
    if (next !== value) onChange(Math.round(next * 100) / 100);
  };
  const onPlus = () => {
    const next = Math.min(max, value + step);
    if (next !== value) onChange(Math.round(next * 100) / 100);
  };

  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.controls}>
        <Pressable style={styles.btn} onPress={onMinus}>
          <Text style={styles.btnText}>-</Text>
        </Pressable>
        <View style={styles.valueBox}>
          <Text style={styles.valueText}>{formatted}</Text>
        </View>
        <Pressable style={styles.btn} onPress={onPlus}>
          <Text style={styles.btnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  label: {
    color: 'rgba(200, 190, 170, 0.90)',
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    flex: 1,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  btn: {
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: 'rgba(70, 65, 55, 1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.47)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '900',
  },
  valueBox: {
    width: 80,
    height: 44,
    borderRadius: 6,
    backgroundColor: 'rgba(45, 40, 32, 1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.31)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  valueText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
});
