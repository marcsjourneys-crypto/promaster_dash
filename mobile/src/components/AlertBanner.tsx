/** Alert banner that appears when warnings or critical conditions exist. */

import React from 'react';
import { Text, StyleSheet, Pressable } from 'react-native';
import { colors, fonts } from '../config/theme';
import type { AlertPriority } from '../store/vehicleStore';

interface AlertBannerProps {
  message: string | null;
  priority: AlertPriority;
  onPress?: () => void;
}

export function AlertBanner({ message, priority, onPress }: AlertBannerProps) {
  if (!message || priority === 'none') return null;

  const bgColor = priority === 'critical' ? colors.critical : colors.warning;

  return (
    <Pressable
      style={[styles.banner, { backgroundColor: bgColor }]}
      onPress={onPress}
    >
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'rgba(255, 210, 150, 0.35)',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: {
    color: colors.warningText,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
});
