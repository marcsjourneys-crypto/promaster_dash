/** Diagnostic trouble codes screen — view, read, clear, and search OBD DTCs. */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Linking,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import { useVehicleStore } from '../store/vehicleStore';
import { readDTCsNow, clearDTCs } from '../services/obdService';
import { getAllCodes } from '../data/dtcLookup';
import { isConnected } from '../services/obdTransport';
import { CLEAR_CODES_WARNING } from '../config/legalConfig';

interface Props {
  onBack: () => void;
}

interface CodeEntry {
  code: string;
  description: string;
  pending: boolean;
}

function CodeRow({ entry }: { entry: CodeEntry }) {
  const handleSearch = useCallback(() => {
    const query = encodeURIComponent(`${entry.code} OBD code Ram ProMaster`);
    Linking.openURL(`https://www.google.com/search?q=${query}`).catch(() => {});
  }, [entry.code]);

  return (
    <View style={styles.codeRow}>
      <View style={styles.codeMain}>
        <View style={styles.codeHeader}>
          <Text style={styles.codeLabel}>{entry.code}</Text>
          {entry.pending && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingBadgeText}>PENDING</Text>
            </View>
          )}
        </View>
        <Text style={styles.codeDesc}>{entry.description}</Text>
      </View>
      <Pressable style={styles.searchBtn} onPress={handleSearch}>
        <Text style={styles.searchBtnText}>SEARCH</Text>
      </Pressable>
    </View>
  );
}

export function CodesScreen({ onBack }: Props) {
  const activeDtcs = useVehicleStore((s) => s.activeDtcs);
  const bleConnected = useVehicleStore((s) => s.bleConnected);
  const [pendingCodes, setPendingCodes] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const connected = bleConnected && isConnected();

  // Merge stored + pending into a single display list (pending tagged)
  const storedEntries: CodeEntry[] = getAllCodes(activeDtcs).map((c) => ({ ...c, pending: false }));
  const pendingSet = new Set(activeDtcs.map((c) => c.toUpperCase()));
  const pendingEntries: CodeEntry[] = getAllCodes(
    pendingCodes.filter((c) => !pendingSet.has(c.toUpperCase())),
  ).map((c) => ({ ...c, pending: true }));
  const allEntries = [...storedEntries, ...pendingEntries];

  const handleRead = useCallback(async () => {
    if (!connected || reading) return;
    setReading(true);
    try {
      const result = await readDTCsNow();
      setPendingCodes(result.pending);
    } catch (e: any) {
      Alert.alert('Read Failed', e.message ?? 'Could not read diagnostic codes.');
    } finally {
      setReading(false);
    }
  }, [connected, reading]);

  const handleClear = useCallback(() => {
    if (!connected || clearing) return;
    Alert.alert(
      'Clear Codes',
      CLEAR_CODES_WARNING,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Codes',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            try {
              const ok = await clearDTCs();
              setPendingCodes([]);
              Alert.alert(
                ok ? 'Codes Cleared' : 'Clear Failed',
                ok
                  ? 'All diagnostic codes have been erased.'
                  : 'Adapter did not acknowledge the clear command.',
              );
            } catch (e: any) {
              Alert.alert('Clear Failed', e.message ?? 'Could not clear codes.');
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  }, [connected, clearing]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>DIAGNOSTIC CODES</Text>
        <View style={[styles.connPill, connected ? styles.connPillOn : styles.connPillOff]}>
          <Text style={styles.connPillText}>{connected ? 'CONNECTED' : 'DISCONNECTED'}</Text>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actionsRow}>
        <Pressable
          style={[styles.actionBtn, (!connected || reading) && styles.actionBtnDisabled]}
          onPress={handleRead}
          disabled={!connected || reading}
        >
          {reading ? (
            <ActivityIndicator color={colors.textPrimary} size="small" />
          ) : (
            <Text style={styles.actionBtnText}>READ CODES</Text>
          )}
        </Pressable>
        <Pressable
          style={[
            styles.actionBtn,
            styles.clearBtn,
            (!connected || clearing || allEntries.length === 0) && styles.actionBtnDisabled,
          ]}
          onPress={handleClear}
          disabled={!connected || clearing || allEntries.length === 0}
        >
          {clearing ? (
            <ActivityIndicator color="#e05050" size="small" />
          ) : (
            <Text style={[styles.actionBtnText, styles.clearBtnText]}>CLEAR CODES</Text>
          )}
        </Pressable>
      </View>

      {/* Code list */}
      <FlatList
        data={allEntries}
        keyExtractor={(item) => item.code + (item.pending ? '-p' : '-s')}
        renderItem={({ item }) => <CodeRow entry={item} />}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✓</Text>
            <Text style={styles.emptyTitle}>No Codes Detected</Text>
            <Text style={styles.emptySubtitle}>
              {connected
                ? 'Tap READ CODES to scan for diagnostic trouble codes.'
                : 'Connect an OBD adapter to read codes.'}
            </Text>
          </View>
        }
        ListHeaderComponent={
          allEntries.length > 0 ? (
            <Text style={styles.listHeader}>
              {allEntries.length} code{allEntries.length !== 1 ? 's' : ''} found
              {pendingEntries.length > 0 ? ` (${pendingEntries.length} pending)` : ''}
            </Text>
          ) : null
        }
      />

      {/* Info footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Stored codes trigger the check engine light. Pending codes are detected but not yet confirmed.
        </Text>
      </View>
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
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
    gap: 10,
  },

  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amberBorder,
  },

  backBtnText: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1.5,
  },

  connPill: {
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },

  connPillOn: {
    backgroundColor: 'rgba(25, 45, 35, 0.86)',
  },

  connPillOff: {
    backgroundColor: 'rgba(45, 25, 20, 0.86)',
  },

  connPillText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },

  actionBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },

  actionBtnDisabled: {
    opacity: 0.35,
  },

  actionBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 0.8,
  },

  clearBtn: {
    borderColor: 'rgba(180, 35, 25, 0.4)',
  },

  clearBtnText: {
    color: 'rgba(220, 80, 60, 0.9)',
  },

  listContent: {
    padding: 12,
    paddingBottom: 20,
  },

  listHeader: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },

  separator: {
    height: 1,
    backgroundColor: colors.amberBorder,
    marginVertical: 4,
  },

  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 10,
  },

  codeMain: {
    flex: 1,
  },

  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },

  codeLabel: {
    color: colors.amber,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },

  pendingBadge: {
    backgroundColor: 'rgba(180, 120, 20, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(220, 140, 35, 0.4)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },

  pendingBadgeText: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  codeDesc: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },

  searchBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
  },

  searchBtnText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  emptyState: {
    paddingTop: 60,
    alignItems: 'center',
    paddingHorizontal: 32,
  },

  emptyIcon: {
    fontSize: 40,
    color: '#50a050',
    marginBottom: 12,
  },

  emptyTitle: {
    color: '#50a050',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 8,
  },

  emptySubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    textAlign: 'center',
    lineHeight: 20,
  },

  footer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.amberBorder,
  },

  footerText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    textAlign: 'center',
    lineHeight: 16,
    fontStyle: 'italic',
  },
});
