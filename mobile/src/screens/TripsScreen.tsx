/** Trip history list screen. */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Alert,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import type { TripRow } from '../models/types';
import { getRecentTrips, deleteTrip, getTripBreadcrumbs, renameTripEntry } from '../services/loggingService';
import { exportAndShare } from '../services/gpxExport';
import { TripChart } from '../components/TripChart';
import { TripMapSection } from '../components/TripMap';

interface TripsScreenProps {
  onBack: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

function TripItem({
  trip,
  expanded,
  onToggle,
  onDelete,
  onExport,
  onRename,
}: {
  trip: TripRow;
  expanded: boolean;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onExport: (trip: TripRow) => void;
  onRename: (trip: TripRow) => void;
}) {
  return (
    <View style={styles.tripCard}>
      {/* Header: name/date taps to rename, chevron indicates expand state */}
      <View style={styles.tripHeader}>
        <Pressable onPress={() => onRename(trip)}>
          {trip.name ? (
            <>
              <Text style={styles.tripName}>{trip.name}</Text>
              <Text style={styles.tripDate}>{formatDate(trip.startTs)}</Text>
            </>
          ) : (
            <Text style={styles.tripDate}>{formatDate(trip.startTs)}</Text>
          )}
        </Pressable>
        <View style={styles.tripHeaderRight}>
          <Text style={styles.tripDistance}>{trip.distanceMi.toFixed(1)} mi</Text>
          <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </View>

      {/* Stats area: tap to expand/collapse */}
      <Pressable onPress={() => onToggle(trip.id)}>
        <View style={styles.tripStats}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Duration</Text>
            <Text style={styles.statValue}>{formatDuration(trip.durationSecs)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Avg Speed</Text>
            <Text style={styles.statValue}>
              {trip.avgSpeedMph > 0 ? `${trip.avgSpeedMph.toFixed(0)} mph` : '--'}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Max Trans</Text>
            <Text
              style={[
                styles.statValue,
                trip.maxTransF !== null && trip.maxTransF >= 230 && styles.statWarn,
              ]}
            >
              {trip.maxTransF !== null ? `${trip.maxTransF.toFixed(0)}°F` : '--'}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Max Cool</Text>
            <Text style={styles.statValue}>
              {trip.maxCoolantF !== null ? `${trip.maxCoolantF.toFixed(0)}°F` : '--'}
            </Text>
          </View>
        </View>

        {(trip.transWarnSecs > 0 || trip.coolantWarnSecs > 0) && (
          <Text style={styles.warnBadge}>
            Temp warnings: {formatDuration(trip.transWarnSecs + trip.coolantWarnSecs)}
          </Text>
        )}
      </Pressable>

      {expanded && (
        <>
          <TripMapSection
            tripId={trip.id}
            tripName={trip.name}
            distanceMi={trip.distanceMi}
          />
          <TripChart tripId={trip.id} />
        </>
      )}

      <View style={styles.tripActions}>
        <Pressable style={styles.exportBtn} onPress={() => onExport(trip)}>
          <Text style={styles.exportBtnText}>Export GPX</Text>
        </Pressable>
        <Pressable
          style={styles.deleteBtn}
          onPress={() => onDelete(trip.id)}
        >
          <Text style={styles.deleteBtnText}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TripsScreen({ onBack }: TripsScreenProps) {
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const handleToggle = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const loadTrips = useCallback(async () => {
    setLoading(true);
    const data = await getRecentTrips(50);
    setTrips(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTrips();
  }, [loadTrips]);

  const handleDelete = useCallback(
    (tripId: number) => {
      Alert.alert('Delete Trip', 'Are you sure?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteTrip(tripId);
            loadTrips();
          },
        },
      ]);
    },
    [loadTrips],
  );

  const handleExport = useCallback(async (trip: TripRow) => {
    const breadcrumbs = await getTripBreadcrumbs(trip.id);
    if (breadcrumbs.length === 0) {
      Alert.alert('No Data', 'This trip has no GPS breadcrumbs to export.');
      return;
    }
    await exportAndShare(breadcrumbs, trip.id, trip.startTs);
  }, []);

  const handleRename = useCallback((trip: TripRow) => {
    // Alert.prompt is iOS-only; on Android this is a no-op
    Alert.prompt(
      'Name This Trip',
      'e.g. Colorado to Washington',
      (text) => {
        if (text !== undefined) {
          renameTripEntry(trip.id, text).then(() => loadTrips());
        }
      },
      'plain-text',
      trip.name ?? '',
    );
  }, [loadTrips]);

  // Compute summary stats
  const totalMiles = trips.reduce((sum, t) => sum + t.distanceMi, 0);
  const totalTrips = trips.length;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>TRIP HISTORY</Text>
      </View>

      {totalTrips > 0 && (
        <View style={styles.summary}>
          <Text style={styles.summaryText}>
            {totalTrips} trips · {totalMiles.toFixed(1)} miles
          </Text>
        </View>
      )}

      <FlatList
        data={trips}
        keyExtractor={(item) => item.id.toString()}
        // RN defaults this to true on Android, detaching offscreen subviews —
        // a known cause of blank/frozen native map surfaces when an expanded
        // card with a MapLibre view is scrolled away and back. The clipping
        // optimization buys nothing for a 50-row list.
        removeClippedSubviews={false}
        renderItem={({ item }) => (
          <TripItem
            trip={item}
            expanded={expandedId === item.id}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onExport={handleExport}
            onRename={handleRename}
          />
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {loading ? 'Loading...' : 'No trips recorded yet.'}
          </Text>
        }
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
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
  backBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 1,
  },
  summary: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  summaryText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  list: {
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  tripCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    padding: 14,
    marginBottom: 10,
  },
  tripHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  tripHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tripName: {
    color: colors.amber,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    marginBottom: 2,
  },
  tripDate: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  tripDistance: {
    color: colors.amber,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 11,
  },
  tripStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  stat: {
    alignItems: 'center',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginBottom: 2,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  statWarn: {
    color: 'rgb(230, 120, 25)',
  },
  warnBadge: {
    color: 'rgb(255, 180, 80)',
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginBottom: 8,
  },
  tripActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  exportBtn: {
    flex: 1,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  exportBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  deleteBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 25, 0.5)',
  },
  deleteBtnText: {
    color: 'rgba(180, 35, 25, 0.9)',
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeMd,
    textAlign: 'center',
    marginTop: 40,
  },
});
