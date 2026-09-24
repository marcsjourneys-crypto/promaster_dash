/** Tire pressures from the PM-TPMS receiver, on a top-down van. */

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import { colors, fonts } from '../config/theme';
import { StatusPill } from '../components/StatusPill';
import { VanTopView } from '../components/VanTopView';
import { useVehicleStore } from '../store/vehicleStore';
import { receiverHealth, resolveTires, type HealthTone } from '../utils/tpmsLayout';
import type { Units } from '../utils/units';

interface TPMSScreenProps {
  onBack: () => void;
  onConfigure: () => void;
  units: Units;
}

const HEALTH_COLOR: Record<HealthTone, string> = {
  ok: colors.gpsOk,
  warn: 'rgb(245, 160, 40)',
  bad: 'rgb(240, 80, 60)',
  muted: 'rgba(150, 145, 135, 0.78)',
};

/** Ages and staleness are time-based, so re-render even with no new data. */
const TICK_MS = 10_000;

export function TPMSScreen({ onBack, onConfigure, units }: TPMSScreenProps) {
  const config = useVehicleStore((s) => s.tpmsConfig);
  const readings = useVehicleStore((s) => s.tpmsReadings);
  const connected = useVehicleStore((s) => s.tpmsConnected);
  const status = useVehicleStore((s) => s.tpmsStatus);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const { tires, unassigned } = useMemo(
    () => resolveTires(config, readings, now),
    [config, readings, now],
  );

  const noneMapped = config.sensors.every((s) => s.position === null);
  let notice: string | null = null;
  if (!config.receiverId) {
    notice = 'No receiver paired. Tap ⚙ → RECEIVER to pair the PM-TPMS box.';
  } else if (noneMapped) {
    notice = 'Wheels not identified yet. Tap ⚙ → IDENTIFY to match each sensor to its wheel.';
  } else if (unassigned.length > 0) {
    notice = `${unassigned.length} sensor${unassigned.length > 1 ? 's' : ''} heard but not on a wheel.`;
  }

  const receiverValue = connected ? 'ON' : config.receiverId ? '--' : 'NOT PAIRED';
  const health = receiverHealth(status, connected);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>{'←'} Back</Text>
        </Pressable>
        <Text style={styles.title}>TIRE PRESSURE</Text>
        <Pressable style={styles.iconBtn} onPress={onConfigure}>
          <Text style={styles.iconBtnText}>{'⚙'}</Text>
        </Pressable>
      </View>

      <View style={styles.pillRow}>
        <StatusPill label="RECEIVER" value={receiverValue} />
        <StatusPill label="UNIT" value={units.pressureLabel} />
      </View>

      {config.receiverId && (
        <Text style={[styles.health, { color: HEALTH_COLOR[health.tone] }]} numberOfLines={1} adjustsFontSizeToFit>
          {health.text}
        </Text>
      )}

      <View style={styles.van}>
        <VanTopView tires={tires} units={units} />
      </View>

      <Text style={styles.targets}>
        TARGET  FRONT {units.pressure(config.frontTargetPsi)} · REAR {units.pressure(config.rearTargetPsi)} {units.pressureLabel}
      </Text>
      {notice && <Text style={styles.notice}>{notice}</Text>}
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
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
  },
  backBtnText: { color: '#fff', fontSize: fonts.sizeSm, fontWeight: '900' },
  title: { flex: 1, color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1 },
  iconBtn: {
    backgroundColor: colors.bgPill,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: { color: colors.textPrimary, fontSize: fonts.sizeLg },
  pillRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 16 },
  health: {
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  van: { flex: 1, paddingHorizontal: 8, paddingVertical: 8 },
  targets: {
    color: 'rgba(150, 145, 135, 0.78)',
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 1,
  },
  notice: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    textAlign: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
});
