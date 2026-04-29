/** Alert history screen — shows timestamped alerts and DTCs. */

import React from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { colors, fonts } from '../config/theme';
import { useVehicleStore } from '../store/vehicleStore';
import type { EventRecord } from '../models/types';

interface AlertHistoryScreenProps {
  onBack: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function AlertItem({ event }: { event: EventRecord }) {
  const isCrit = event.severity === 'critical';
  return (
    <View style={[styles.alertCard, isCrit && styles.alertCrit]}>
      <View style={styles.alertHeader}>
        <Text style={styles.alertTime}>
          {formatDate(event.ts)} {formatTime(event.ts)}
        </Text>
        <Text style={[styles.alertBadge, isCrit && styles.alertBadgeCrit]}>
          {event.severity.toUpperCase()}
        </Text>
      </View>
      <Text style={styles.alertMessage}>{event.message}</Text>
    </View>
  );
}

export function AlertHistoryScreen({ onBack }: AlertHistoryScreenProps) {
  const alertHistory = useVehicleStore((s) => s.alertHistory);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>ALERT HISTORY</Text>
        <Text style={styles.count}>{alertHistory.length}</Text>
      </View>

      <FlatList
        data={alertHistory}
        keyExtractor={(_, i) => i.toString()}
        renderItem={({ item }) => <AlertItem event={item} />}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No alerts recorded yet.</Text>
        }
        contentContainerStyle={styles.list}
      />
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
    backgroundColor: colors.bgPill,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
  },
  backBtnText: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800' },
  title: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1, flex: 1 },
  count: { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '700' },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  alertCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(230, 120, 25, 0.3)',
    padding: 12,
    marginBottom: 6,
  },
  alertCrit: { borderColor: 'rgba(180, 35, 25, 0.5)' },
  alertHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  alertTime: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '700' },
  alertBadge: { color: 'rgb(230, 120, 25)', fontSize: fonts.sizeXs, fontWeight: '900' },
  alertBadgeCrit: { color: 'rgb(220, 60, 40)' },
  alertMessage: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: fonts.sizeMd, textAlign: 'center', marginTop: 40 },
});
