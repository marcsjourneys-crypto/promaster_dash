/** Debug log screen — scrolling timestamped log for on-device troubleshooting. */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  SafeAreaView,
  Share,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import { getLogEntries, clearLog, getLogText, onLogChange, type LogEntry } from '../services/debugLog';

interface DebugLogScreenProps {
  onBack: () => void;
}

export function DebugLogScreen({ onBack }: DebugLogScreenProps) {
  const [entries, setEntries] = useState<LogEntry[]>(getLogEntries());
  const flatListRef = useRef<FlatList>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    return onLogChange(() => {
      setEntries([...getLogEntries()]);
    });
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && entries.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 50);
    }
  }, [entries.length, autoScroll]);

  const handleCopy = useCallback(async () => {
    try {
      await Share.share({ message: getLogText() });
    } catch {}
  }, []);

  const handleClear = useCallback(() => {
    clearLog();
  }, []);

  const renderItem = useCallback(({ item }: { item: LogEntry }) => (
    <Text style={styles.logLine}>
      <Text style={styles.logTime}>{item.time}</Text>
      {' '}
      {item.msg}
    </Text>
  ), []);

  const keyExtractor = useCallback((_: LogEntry, i: number) => i.toString(), []);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'< BACK'}</Text>
        </Pressable>
        <Text style={styles.title}>DEBUG LOG</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Log list */}
      <FlatList
        ref={flatListRef}
        data={entries}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScrollBeginDrag={() => setAutoScroll(false)}
      />

      {/* Bottom buttons */}
      <View style={styles.buttonRow}>
        {!autoScroll && (
          <Pressable
            style={styles.btn}
            onPress={() => {
              setAutoScroll(true);
              flatListRef.current?.scrollToEnd({ animated: true });
            }}
          >
            <Text style={styles.btnText}>FOLLOW</Text>
          </Pressable>
        )}
        <Pressable style={styles.btn} onPress={handleCopy}>
          <Text style={styles.btnText}>SHARE</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnDanger]} onPress={handleClear}>
          <Text style={styles.btnText}>CLEAR</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  backBtn: {
    paddingRight: 12,
    paddingVertical: 4,
  },
  backText: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 60,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 8,
  },
  logLine: {
    color: '#c0c0c0',
    fontSize: 11,
    fontFamily: 'Menlo',
    lineHeight: 16,
    paddingVertical: 1,
  },
  logTime: {
    color: '#666',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  btn: {
    flex: 1,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  btnDanger: {
    borderColor: 'rgba(180, 35, 25, 0.5)',
  },
  btnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
