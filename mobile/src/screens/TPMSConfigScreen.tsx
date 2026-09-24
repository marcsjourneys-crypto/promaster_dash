/**
 * TPMS admin: pair the receiver, manage the sensor allowlist, identify which
 * sensor is on which wheel, and set the pressure limits.
 *
 * Changes are saved as they are made (no Save button): an identified wheel
 * should survive the user backing out mid-way through the other three.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  StyleSheet,
  Alert,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import { ValueStepper } from '../components/ValueStepper';
import { useVehicleStore } from '../store/vehicleStore';
import {
  POSITION_LABELS,
  TIRE_POSITIONS,
  addSensor,
  assignPosition,
  removeSensor,
  sensorAt,
  type TirePosition,
  type TpmsConfig,
} from '../config/tpmsConfig';
import { MAX_SENSOR_IDS } from '../services/tpmsProtocol';
import {
  forgetReceiver,
  pairReceiver,
  requestReplay,
  scanForReceivers,
  setReceiverLearnMode,
  updateTpmsConfig,
  type FoundReceiver,
} from '../services/tpmsService';
import {
  LEARN_DROP_PSI,
  LEARN_TIMEOUT_MS,
  evaluateLearn,
  startLearn,
  type LearnState,
} from '../utils/tpmsLearn';
import { formatAge } from '../utils/tpmsLayout';

type Tab = 'receiver' | 'sensors' | 'identify' | 'limits';

interface TPMSConfigScreenProps {
  onBack: () => void;
}

const SCAN_MS = 8_000;

export function TPMSConfigScreen({ onBack }: TPMSConfigScreenProps) {
  const config = useVehicleStore((s) => s.tpmsConfig);
  const readings = useVehicleStore((s) => s.tpmsReadings);
  const connected = useVehicleStore((s) => s.tpmsConnected);
  const learnMode = useVehicleStore((s) => s.tpmsLearnMode);
  const status = useVehicleStore((s) => s.tpmsStatus);

  const [tab, setTab] = useState<Tab>(config.receiverId ? 'identify' : 'receiver');

  const save = useCallback((next: TpmsConfig) => {
    updateTpmsConfig(next).catch(() => {});
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>{'←'} Done</Text>
        </Pressable>
        <Text style={styles.title}>TPMS SETUP</Text>
      </View>

      <View style={styles.tabRow}>
        {(['receiver', 'sensors', 'identify', 'limits'] as Tab[]).map((t) => (
          <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {tab === 'receiver' && (
          <ReceiverTab
            config={config}
            connected={connected}
            learnMode={learnMode}
            status={status}
          />
        )}
        {tab === 'sensors' && (
          <SensorsTab config={config} readings={readings} learnMode={learnMode} onChange={save} />
        )}
        {tab === 'identify' && <IdentifyTab config={config} readings={readings} onChange={save} />}
        {tab === 'limits' && <LimitsTab config={config} onChange={save} />}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---- Receiver -------------------------------------------------------------

function ReceiverTab({
  config,
  connected,
  learnMode,
  status,
}: {
  config: TpmsConfig;
  connected: boolean;
  learnMode: boolean;
  status: ReturnType<typeof useVehicleStore.getState>['tpmsStatus'];
}) {
  const [found, setFound] = useState<FoundReceiver[]>([]);
  const [scanning, setScanning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopScan = () => {
    stopRef.current?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setScanning(false);
  };

  useEffect(() => () => {
    stopRef.current?.();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const scan = () => {
    stopScan();
    setFound([]);
    setScanning(true);
    stopRef.current = scanForReceivers((r) => setFound((prev) => [...prev, r]), SCAN_MS);
    timerRef.current = setTimeout(() => setScanning(false), SCAN_MS);
  };

  const pair = (r: FoundReceiver) => {
    stopScan();
    pairReceiver(r).catch(() => {});
  };

  const forget = () =>
    Alert.alert('Forget Receiver', 'Stop connecting to this receiver?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => forgetReceiver().catch(() => {}) },
    ]);

  return (
    <>
      <Text style={styles.sectionHeader}>RECEIVER</Text>
      {config.receiverId ? (
        <>
          <View style={styles.statusRow}>
            <Text style={styles.label}>{config.receiverName ?? 'PM-TPMS'}</Text>
            <Text style={[styles.statusValue, { color: connected ? colors.gpsOk : colors.textMuted }]}>
              {connected ? 'CONNECTED' : 'SEARCHING'}
            </Text>
          </View>
          <Text style={styles.hint}>
            Reconnects on its own whenever the receiver is powered and in range.
          </Text>
        </>
      ) : (
        <Text style={styles.hint}>
          No receiver paired. Power the PM-TPMS box, then scan.
        </Text>
      )}

      <View style={styles.actions}>
        <Pressable style={styles.btn} onPress={scan} disabled={scanning}>
          <Text style={styles.btnText}>{scanning ? 'SCANNING…' : 'SCAN FOR RECEIVER'}</Text>
        </Pressable>
        {found.map((r) => (
          <Pressable key={r.id} style={[styles.btn, styles.btnFound]} onPress={() => pair(r)}>
            <Text style={styles.btnText}>
              PAIR {r.name} {r.rssi !== null ? `(${r.rssi} dBm)` : ''}
            </Text>
          </Pressable>
        ))}
        {!scanning && found.length === 0 && stopRef.current && (
          <Text style={styles.hint}>Nothing found. Is the receiver powered and nearby?</Text>
        )}
        {config.receiverId && (
          <Pressable style={[styles.btn, styles.btnDanger]} onPress={forget}>
            <Text style={styles.btnDangerText}>FORGET RECEIVER</Text>
          </Pressable>
        )}
      </View>

      <Text style={[styles.sectionHeader, { marginTop: 24 }]}>LEARN MODE</Text>
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Show unknown sensors</Text>
          <Text style={styles.hint}>
            Forwards every Schrader sensor the receiver hears, including other
            vehicles'. Use it to find a new sensor after a tire change, then turn it off.
          </Text>
        </View>
        <Switch
          value={learnMode}
          disabled={!connected}
          onValueChange={(v) => { setReceiverLearnMode(v).catch(() => {}); }}
          trackColor={{ false: 'rgba(60, 55, 45, 1)', true: 'rgba(180, 130, 50, 0.6)' }}
          thumbColor={learnMode ? colors.amber : 'rgba(150, 140, 120, 1)'}
        />
      </View>

      {connected && (
        <>
          <Text style={[styles.sectionHeader, { marginTop: 24 }]}>DIAGNOSTICS</Text>
          {status && (
            <>
              <Row label="Uptime" value={formatAge(status.uptimeS * 1000)} />
              <Row label="Frames decoded" value={String(status.decoded)} />
              <Row label="Readings sent" value={String(status.reported)} />
              <Row label="Buffer overflows" value={String(status.overflows)} />
              {status.radio && (
                <>
                  <Row label="Radio edges/s" value={String(status.radio.edgesPerSec)} />
                  <Row
                    label="Bursts heard / decoded"
                    value={`${status.radio.bursts} / ${status.radio.burstsDecoded}`}
                  />
                  <Row
                    label="Last burst"
                    value={
                      status.radio.lastBurstAgeS === null
                        ? 'none since boot'
                        : `${formatAge(status.radio.lastBurstAgeS * 1000)} ago`
                    }
                  />
                  <Row
                    label="Decoder timing"
                    value={`${status.radio.halfUs} µs${status.radio.inverted ? ' · inverted' : ''}`}
                  />
                  <Text style={styles.hint}>
                    A burst is anything shaped like a tire transmission. Bursts heard but
                    not decoded means the receiver hears the sensors but can't read them
                    yet; it re-tunes itself on each one. More detail over USB serial with
                    the bursts and dump commands.
                  </Text>
                </>
              )}
            </>
          )}
          <Pressable style={[styles.btn, { marginTop: 12 }]} onPress={() => requestReplay()}>
            <Text style={styles.btnText}>RESEND LAST READINGS</Text>
          </Pressable>
        </>
      )}
    </>
  );
}

// ---- Sensors --------------------------------------------------------------

function SensorsTab({
  config,
  readings,
  learnMode,
  onChange,
}: {
  config: TpmsConfig;
  readings: ReturnType<typeof useVehicleStore.getState>['tpmsReadings'];
  learnMode: boolean;
  onChange: (c: TpmsConfig) => void;
}) {
  const now = Date.now();
  const listed = new Set(config.sensors.map((s) => s.id));
  const strangers = Object.values(readings).filter((r) => !listed.has(r.id));
  const full = config.sensors.length >= MAX_SENSOR_IDS;

  const remove = (id: string) =>
    Alert.alert('Remove Sensor', `Stop listening for ${id}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onChange(removeSensor(config, id)) },
    ]);

  return (
    <>
      <Text style={styles.sectionHeader}>VAN SENSORS</Text>
      <Text style={styles.hint}>
        The receiver only forwards these IDs. Wheels are matched on the IDENTIFY tab.
      </Text>
      {config.sensors.map((s) => {
        const r = readings[s.id];
        return (
          <View key={s.id} style={styles.sensorRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sensorId}>{s.id}</Text>
              <Text style={styles.hint}>
                {s.position ? POSITION_LABELS[s.position] : 'not on a wheel'}
                {r ? ` · ${r.psi.toFixed(1)} psi · ${formatAge(now - r.ts)} ago` : ' · no reading yet'}
              </Text>
            </View>
            <Pressable style={styles.smallBtn} onPress={() => remove(s.id)}>
              <Text style={styles.btnDangerText}>REMOVE</Text>
            </Pressable>
          </View>
        );
      })}

      <Text style={[styles.sectionHeader, { marginTop: 24 }]}>OTHER SENSORS HEARD</Text>
      {strangers.length === 0 ? (
        <Text style={styles.hint}>
          {learnMode
            ? 'None yet. New sensors transmit when the wheel turns or the pressure changes.'
            : 'Turn on learn mode (RECEIVER tab) to see sensors that are not listed above.'}
        </Text>
      ) : (
        strangers.map((r) => (
          <View key={r.id} style={styles.sensorRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sensorId}>{r.id}</Text>
              <Text style={styles.hint}>{r.psi.toFixed(1)} psi · {formatAge(now - r.ts)} ago</Text>
            </View>
            <Pressable
              style={styles.smallBtn}
              disabled={full}
              onPress={() => onChange(addSensor(config, r.id))}
            >
              <Text style={styles.btnText}>{full ? 'FULL' : 'ADD'}</Text>
            </Pressable>
          </View>
        ))
      )}
    </>
  );
}

// ---- Identify (deflate wizard) --------------------------------------------

function IdentifyTab({
  config,
  readings,
  onChange,
}: {
  config: TpmsConfig;
  readings: ReturnType<typeof useVehicleStore.getState>['tpmsReadings'];
  onChange: (c: TpmsConfig) => void;
}) {
  const [learn, setLearn] = useState<LearnState | null>(null);
  const [now, setNow] = useState(Date.now());

  // Re-evaluate on every new reading and once a second for the countdown.
  useEffect(() => {
    if (!learn || learn.phase !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [learn]);

  useEffect(() => {
    setLearn((s) => (s ? evaluateLearn(s, readings, Date.now()) : s));
  }, [readings, now]);

  const missing = config.sensors.filter((s) => !readings[s.id]);

  if (!learn) {
    return (
      <>
        <Text style={styles.sectionHeader}>WHICH SENSOR IS WHERE?</Text>
        <Text style={styles.hint}>
          Tap a wheel, then let a few psi out of that tire. The sensor transmits
          as soon as its pressure drops, and the one that fell is that wheel.
          Do it with cold tires (parked an hour or more): tires cooling after a
          drive lose pressure too. Reinflate afterwards, and redo this after
          rotating tires.
        </Text>
        {missing.length > 0 && (
          <Text style={[styles.hint, styles.warnText]}>
            No reading yet from {missing.map((s) => s.id).join(', ')}. Drive a few
            minutes first so every sensor has a starting pressure to compare against.
          </Text>
        )}
        <View style={styles.cornerGrid}>
          {TIRE_POSITIONS.map((pos) => {
            const id = sensorAt(config, pos);
            return (
              <Pressable
                key={pos}
                style={styles.cornerBtn}
                onPress={() => setLearn(startLearn(pos, readings, Date.now()))}
              >
                <Text style={styles.cornerLabel}>{POSITION_LABELS[pos].toUpperCase()}</Text>
                <Text style={styles.cornerId}>{id ?? 'not set'}</Text>
              </Pressable>
            );
          })}
        </View>
      </>
    );
  }

  const cornerName = POSITION_LABELS[learn.corner].toUpperCase();
  const cancel = () => setLearn(null);

  if (learn.phase === 'proposed' && learn.proposedId) {
    const id = learn.proposedId;
    const current = config.sensors.find((s) => s.id === id)?.position ?? null;
    const displaced = sensorAt(config, learn.corner);
    const assign = () => {
      onChange(assignPosition(config, id, learn.corner));
      setLearn(null);
    };
    return (
      <>
        <Text style={styles.sectionHeader}>FOUND IT</Text>
        <Text style={styles.bigText}>
          {id} dropped {learn.dropPsi!.toFixed(1)} psi.
        </Text>
        <Text style={styles.label}>Assign it to the {cornerName.toLowerCase()} wheel?</Text>
        {current && current !== learn.corner && (
          <Text style={[styles.hint, styles.warnText]}>
            It is currently on {POSITION_LABELS[current]} and will move.
          </Text>
        )}
        {displaced && displaced !== id && (
          <Text style={[styles.hint, styles.warnText]}>
            {displaced} is on this wheel now and will be unassigned.
          </Text>
        )}
        <View style={styles.actions}>
          <Pressable style={[styles.btn, styles.btnFound]} onPress={assign}>
            <Text style={styles.btnText}>ASSIGN TO {cornerName}</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={cancel}>
            <Text style={styles.btnText}>CANCEL</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Remember to reinflate the tire.</Text>
      </>
    );
  }

  if (learn.phase === 'timeout' || learn.phase === 'ambiguous') {
    return (
      <>
        <Text style={styles.sectionHeader}>
          {learn.phase === 'timeout' ? 'NO DROP SEEN' : 'NOT SURE WHICH'}
        </Text>
        <Text style={styles.hint}>
          {learn.phase === 'timeout'
            ? `No sensor lost ${LEARN_DROP_PSI} psi or more in ${LEARN_TIMEOUT_MS / 60000} minutes. ` +
              'Let out a little more air, and check the receiver is connected.'
            : 'More than one sensor dropped by a similar amount, probably tires cooling ' +
              'after a drive. Let the tires cool, then try again with a bigger drop.'}
        </Text>
        <View style={styles.actions}>
          <Pressable style={styles.btn} onPress={() => setLearn(startLearn(learn.corner, readings, Date.now()))}>
            <Text style={styles.btnText}>TRY AGAIN</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={cancel}>
            <Text style={styles.btnText}>CANCEL</Text>
          </Pressable>
        </View>
      </>
    );
  }

  const leftS = Math.max(0, Math.ceil((learn.startedAt + LEARN_TIMEOUT_MS - now) / 1000));
  return (
    <>
      <Text style={styles.sectionHeader}>{cornerName}</Text>
      <Text style={styles.bigText}>Let 3–5 psi out of the {cornerName.toLowerCase()} tire now.</Text>
      <Text style={styles.hint}>
        Watching for a drop of {LEARN_DROP_PSI} psi or more · {Math.floor(leftS / 60)}:
        {String(leftS % 60).padStart(2, '0')} left
      </Text>
      {Object.entries(learn.baselines).map(([id, base]) => {
        const r = readings[id];
        const live = r && !r.cached && r.ts >= learn.startedAt;
        return (
          <Row
            key={id}
            label={id}
            value={`${base.toFixed(1)} → ${live ? r.psi.toFixed(1) : '…'} psi`}
          />
        );
      })}
      <Pressable style={[styles.btn, { marginTop: 16 }]} onPress={cancel}>
        <Text style={styles.btnText}>CANCEL</Text>
      </Pressable>
    </>
  );
}

// ---- Limits ---------------------------------------------------------------

function LimitsTab({ config, onChange }: { config: TpmsConfig; onChange: (c: TpmsConfig) => void }) {
  const set = (key: keyof TpmsConfig) => (v: number) => onChange({ ...config, [key]: v });
  return (
    <>
      <Text style={styles.sectionHeader}>TARGET PRESSURE (COLD)</Text>
      <Text style={styles.hint}>From the sticker on the driver's door pillar.</Text>
      <ValueStepper label="Front" min={30} max={100} value={config.frontTargetPsi} suffix=" psi" onChange={set('frontTargetPsi')} />
      <ValueStepper label="Rear" min={30} max={100} value={config.rearTargetPsi} suffix=" psi" onChange={set('rearTargetPsi')} />

      <Text style={[styles.sectionHeader, { marginTop: 20 }]}>ALERTS</Text>
      <ValueStepper label="Low warning" min={5} max={30} value={config.lowWarnPct} suffix="% under" onChange={set('lowWarnPct')} />
      <ValueStepper label="Low critical" min={10} max={50} value={config.lowCritPct} suffix="% under" onChange={set('lowCritPct')} />
      <ValueStepper label="High warning" min={5} max={40} value={config.highWarnPct} suffix="% over" onChange={set('highWarnPct')} />
      <ValueStepper label="Tire temp warning" min={120} max={230} step={5} value={config.tempWarnF} suffix="°F" onChange={set('tempWarnF')} />
      <Text style={styles.hint}>
        25% under target is the federal TPMS warning point. Pressure rises as tires
        warm up, so a hot tire can read 10–15% over its cold target.
      </Text>
    </>
  );
}

// ---- Bits -----------------------------------------------------------------

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
  },
  backBtnText: { color: '#fff', fontSize: fonts.sizeSm, fontWeight: '900' },
  title: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900', letterSpacing: 1 },
  tabRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 4, marginBottom: 4 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: 'rgba(35, 32, 26, 0.86)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.18)',
    borderRadius: 6,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: 'rgba(60, 55, 45, 0.94)', borderBottomWidth: 2, borderBottomColor: colors.amber },
  tabText: { color: 'rgba(200, 190, 170, 0.86)', fontSize: 11, fontWeight: '800' },
  tabTextActive: { color: colors.textPrimary },
  content: { flex: 1 },
  contentInner: { paddingHorizontal: 16, paddingVertical: 12, paddingBottom: 40 },
  sectionHeader: {
    color: 'rgba(220, 180, 120, 0.94)',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 8,
  },
  label: { color: 'rgba(220, 210, 195, 0.94)', fontSize: fonts.sizeSm, fontWeight: '700' },
  hint: { color: 'rgba(150, 145, 135, 0.78)', fontSize: fonts.sizeXs, marginTop: 2, marginBottom: 6, lineHeight: 18 },
  warnText: { color: 'rgb(245, 160, 40)' },
  bigText: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '800', marginVertical: 8 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  statusValue: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '700' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  actions: { marginTop: 12, gap: 10 },
  btn: {
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.29)',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnFound: { borderColor: colors.amber, backgroundColor: 'rgba(220, 140, 35, 0.15)' },
  btnText: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800' },
  btnDanger: { borderColor: 'rgba(180, 35, 25, 0.4)' },
  btnDangerText: { color: 'rgba(220, 80, 60, 0.9)', fontSize: fonts.sizeSm, fontWeight: '800' },
  sensorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 220, 160, 0.08)',
    gap: 12,
  },
  sensorId: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '800', letterSpacing: 1 },
  smallBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.29)',
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    minHeight: 40,
    justifyContent: 'center',
  },
  cornerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  cornerBtn: {
    width: '48%',
    paddingVertical: 18,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.amberBorder,
    backgroundColor: colors.bgPill,
    alignItems: 'center',
    gap: 4,
  },
  cornerLabel: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900', letterSpacing: 1 },
  cornerId: { color: colors.textMuted, fontSize: fonts.sizeSm, fontWeight: '700' },
});
