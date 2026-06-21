/** Maintenance log screen — schedule overview, history, and log entry sheet. */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  Modal,
  Platform,
  SafeAreaView,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { colors, fonts } from '../config/theme';
import {
  getScheduleWithStatus,
  getLogEntries,
  addLogEntry,
  type ScheduleRow,
  type LogEntry,
  type ServiceStatus,
} from '../services/maintenanceService';
import { MaintenanceWizard } from './MaintenanceWizard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  onBack: () => void;
  severeDuty: boolean;
  wizardComplete: boolean;
  onWizardComplete: (severeDuty: boolean) => void;
}

type Tab = 'SCHEDULE' | 'HISTORY' | 'REFERENCE';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<ServiceStatus, string> = {
  OVERDUE:    '#e05050',
  'DUE SOON': '#e07020',
  UPCOMING:   '#d4aa30',
  OK:         '#50a050',
  UNKNOWN:    '#666666',
};

const SERVICE_TYPES = [
  { value: 'oil',                 label: 'Oil & Filter' },
  { value: 'tires_rotated',       label: 'Tire Rotation' },
  { value: 'cabin_air_filter',    label: 'Cabin Air Filter' },
  { value: 'engine_air_filter',   label: 'Engine Air Filter' },
  { value: 'brake_fluid',         label: 'Brake Fluid' },
  { value: 'transmission_fluid',  label: 'Transmission Fluid (62TE)' },
  { value: 'coolant',             label: 'Coolant (OAT)' },
  { value: 'serpentine_belt',     label: 'Serpentine Belt Inspection' },
  { value: 'spark_plugs',         label: 'Spark Plugs (Iridium)' },
  { value: 'other',               label: 'Other' },
];

const REFERENCE_INTERVALS = [
  { label: 'Oil & Filter',            normalTime: '12 mo',  normalMi: '10,000',  severeTime: '6 mo',  severeMi: '5,000',   notes: 'Synthetic 5W-20; use Oil Life Monitor' },
  { label: 'Tire Rotation',           normalTime: '6 mo',   normalMi: '7,500',   severeTime: '3 mo',  severeMi: '6,000',   notes: 'Rotate at every oil change (FWD)' },
  { label: 'Cabin Air Filter',        normalTime: '24 mo',  normalMi: '30,000',  severeTime: '12 mo', severeMi: '15,000',  notes: '' },
  { label: 'Engine Air Filter',       normalTime: '36 mo',  normalMi: '30,000',  severeTime: '18 mo', severeMi: '15,000',  notes: 'More often in dusty conditions' },
  { label: 'Brake Fluid',             normalTime: '24 mo',  normalMi: '32,000',  severeTime: '24 mo', severeMi: '32,000',  notes: 'DOT 4; time-based, whichever comes first' },
  { label: 'Trans Fluid (62TE)',       normalTime: '72 mo',  normalMi: '60,000',  severeTime: '36 mo', severeMi: '30,000',  notes: 'Mopar ATF+4; factory severe = 6yr / 60k' },
  { label: 'Coolant (OAT)',           normalTime: '120 mo', normalMi: '150,000', severeTime: '60 mo', severeMi: '75,000',  notes: 'Mopar OAT MS-12106; 10yr / 150k per manual' },
  { label: 'Serpentine Belt',         normalTime: '60 mo',  normalMi: '90,000',  severeTime: '36 mo', severeMi: '60,000',  notes: 'Condition-based inspection' },
  { label: 'Spark Plugs (Iridium)',   normalTime: '96 mo',  normalMi: '100,000', severeTime: '96 mo', severeMi: '100,000', notes: 'Mileage-based; iridium tipped' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoToLocalDate(iso: string): Date {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

function formatDisplayDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}/${parts[0]}`;
}

function formatDaysUntil(row: ScheduleRow): string {
  if (row.days_until === null) return '—';
  if (row.days_until < 0) return `${Math.abs(row.days_until)}d overdue`;
  if (row.days_until === 0) return 'Due today';
  return `${row.days_until}d`;
}

function formatMonthYear(iso: string): string {
  const [y, mo] = iso.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[mo - 1]} ${y}`;
}

function serviceLabel(serviceType: string): string {
  return SERVICE_TYPES.find((t) => t.value === serviceType)?.label ?? serviceType;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScheduleItem({ row }: { row: ScheduleRow }) {
  const badgeColor = STATUS_COLORS[row.status];
  const daysText = formatDaysUntil(row);

  const lastText = row.last_service_date
    ? row.last_odometer !== null
      ? `Last: ${formatDisplayDate(row.last_service_date)} @ ${row.last_odometer.toLocaleString()} mi`
      : `Last: ${formatDisplayDate(row.last_service_date)}`
    : 'No record';

  const nextText = row.next_due_date
    ? row.next_due_odometer !== null
      ? `Next: ${formatMonthYear(row.next_due_date)} ~${row.next_due_odometer.toLocaleString()} mi`
      : `Next: ${formatMonthYear(row.next_due_date)}`
    : null;

  return (
    <View style={styles.scheduleRow}>
      <View style={[styles.statusBadge, { backgroundColor: badgeColor }]}>
        <Text style={styles.statusBadgeText}>{row.status}</Text>
      </View>
      <View style={styles.scheduleRowContent}>
        <Text style={styles.scheduleLabel}>{row.label}</Text>
        <Text style={styles.scheduleMeta}>{lastText}</Text>
        {nextText ? <Text style={styles.scheduleMeta}>{nextText}</Text> : null}
      </View>
      <Text style={[styles.daysUntil, row.days_until !== null && row.days_until < 0 && styles.daysUntilOverdue]}>
        {daysText}
      </Text>
    </View>
  );
}

function HistoryItem({ entry }: { entry: LogEntry }) {
  return (
    <View style={styles.historyRow}>
      <View style={styles.historyRowMain}>
        <Text style={styles.historyLabel}>{serviceLabel(entry.service_type)}</Text>
        <Text style={styles.historyDate}>{formatDisplayDate(entry.service_date)}</Text>
      </View>
      {(entry.odometer !== null || entry.cost !== null) && (
        <View style={styles.historyRowMeta}>
          {entry.odometer !== null && (
            <Text style={styles.historyMeta}>{entry.odometer.toLocaleString()} mi</Text>
          )}
          {entry.cost !== null && (
            <Text style={styles.historyMeta}>${entry.cost.toFixed(2)}</Text>
          )}
        </View>
      )}
      {entry.notes ? (
        <Text style={styles.historyNotes}>{entry.notes}</Text>
      ) : null}
    </View>
  );
}

function ReferenceTab() {
  return (
    <ScrollView contentContainerStyle={styles.refContent}>
      <Text style={styles.refTitle}>Ram ProMaster 3.6L Pentastar V6 (2014–2026)</Text>
      <Text style={styles.refSubtitle}>Recommended Maintenance Intervals — Gas models, all years</Text>
      {REFERENCE_INTERVALS.map((item, i) => (
        <View key={i} style={styles.refCard}>
          <Text style={styles.refCardTitle}>{item.label}</Text>
          <View style={styles.refIntervalRow}>
            <Text style={styles.refIntervalLabel}>Normal:</Text>
            <Text style={styles.refIntervalValue}>{item.normalTime}  •  {item.normalMi} mi</Text>
          </View>
          <View style={styles.refIntervalRow}>
            <Text style={styles.refIntervalLabel}>Severe:</Text>
            <Text style={styles.refIntervalValue}>{item.severeTime}  •  {item.severeMi} mi</Text>
          </View>
          {item.notes ? <Text style={styles.refCardNotes}>{item.notes}</Text> : null}
        </View>
      ))}
      <View style={styles.dieselNote}>
        <Text style={styles.dieselNoteText}>
          {'⚠ EcoDiesel (3.0L) models: different oil type, no spark plugs, and a diesel fuel filter interval. Consult your owner\'s manual for diesel-specific service schedules.'}
        </Text>
      </View>
      <Text style={styles.refSource}>
        {'Source: Ram ProMaster Owner\'s Manual (2014–2026).\nNormal = standard use. Severe = commercial/delivery/stop-and-go.'}
      </Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MaintenanceScreen({ onBack, severeDuty, wizardComplete, onWizardComplete }: Props) {
  const [showWizard, setShowWizard] = useState(!wizardComplete);
  const [activeTab, setActiveTab] = useState<Tab>('SCHEDULE');
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Log entry form state
  const [selectedType, setSelectedType] = useState(SERVICE_TYPES[0].value);
  const [entryDate, setEntryDate] = useState<Date>(new Date());
  const [entryDateStr, setEntryDateStr] = useState<string>(toLocalIsoDate(new Date()));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempPickerDate, setTempPickerDate] = useState<Date>(new Date());
  const [odometer, setOdometer] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    const [s, h] = await Promise.all([
      getScheduleWithStatus(severeDuty),
      getLogEntries(),
    ]);
    setSchedule(s);
    setHistory(h);
  }, [severeDuty]);

  useEffect(() => { refresh(); }, [refresh]);

  // -------------------------------------------------------------------------
  // Wizard integration
  // -------------------------------------------------------------------------

  if (showWizard) {
    return (
      <MaintenanceWizard
        onComplete={(duty) => {
          setShowWizard(false);
          onWizardComplete(duty);
          refresh();
        }}
        onSkip={() => {
          setShowWizard(false);
          onWizardComplete(false);
        }}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Log entry modal handlers
  // -------------------------------------------------------------------------

  function openModal() {
    const today = new Date();
    setSelectedType(SERVICE_TYPES[0].value);
    setEntryDate(today);
    setEntryDateStr(toLocalIsoDate(today));
    setTempPickerDate(today);
    setShowDatePicker(false);
    setOdometer('');
    setCost('');
    setNotes('');
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setShowDatePicker(false);
  }

  function handleDatePickerChange(_event: DateTimePickerEvent, selected?: Date) {
    if (!selected) return;
    if (Platform.OS === 'android') {
      setEntryDate(selected);
      setEntryDateStr(toLocalIsoDate(selected));
      setShowDatePicker(false);
    } else {
      setTempPickerDate(selected);
    }
  }

  function handleIosDateSet() {
    setEntryDate(tempPickerDate);
    setEntryDateStr(toLocalIsoDate(tempPickerDate));
    setShowDatePicker(false);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const odomNum = odometer.trim() ? parseFloat(odometer) : undefined;
      const costNum = cost.trim() ? parseFloat(cost) : undefined;
      const id = await addLogEntry({
        service_type: selectedType,
        service_date: entryDateStr,
        odometer: !isNaN(odomNum ?? NaN) ? odomNum : undefined,
        cost: !isNaN(costNum ?? NaN) ? costNum : undefined,
        notes: notes.trim() || undefined,
      });
      if (id === null) {
        Alert.alert('Save Failed', 'Could not save the entry. Please try again.');
        return;
      }
      closeModal();
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>MAINTENANCE</Text>
        <View style={styles.headerRight} />
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {(['SCHEDULE', 'HISTORY', 'REFERENCE'] as Tab[]).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabBtnText, activeTab === tab && styles.tabBtnTextActive]}>
              {tab}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Tab content */}
      <View style={styles.content}>
        {activeTab === 'SCHEDULE' && (
          <FlatList
            data={schedule}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => <ScheduleItem row={item} />}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                  No schedule items found. Tap + to log your first service.
                </Text>
              </View>
            }
          />
        )}

        {activeTab === 'HISTORY' && (
          <FlatList
            data={history}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => <HistoryItem entry={item} />}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                  No service history yet. Tap + to add an entry.
                </Text>
              </View>
            }
          />
        )}

        {activeTab === 'REFERENCE' && <ReferenceTab />}
      </View>

      {/* Floating + button */}
      <Pressable style={styles.fab} onPress={openModal}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      {/* Log entry modal */}
      <Modal
        visible={showModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        <SafeAreaView style={styles.modalContainer}>
          <KeyboardAvoidingView
            style={styles.modalKAV}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>Log Service Entry</Text>

              {/* Service type chips */}
              <Text style={styles.fieldLabel}>Service Type</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipsRow}
              >
                {SERVICE_TYPES.map((t) => (
                  <Pressable
                    key={t.value}
                    style={[styles.chip, selectedType === t.value && styles.chipActive]}
                    onPress={() => setSelectedType(t.value)}
                  >
                    <Text style={[styles.chipText, selectedType === t.value && styles.chipTextActive]}>
                      {t.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              {/* Date picker */}
              <Text style={styles.fieldLabel}>Date</Text>
              <Pressable
                style={[styles.dateField, showDatePicker && styles.dateFieldActive]}
                onPress={() => {
                  setTempPickerDate(entryDate);
                  setShowDatePicker((prev) => !prev);
                }}
              >
                <Text style={styles.dateFieldText}>{formatDisplayDate(entryDateStr)}</Text>
              </Pressable>

              {showDatePicker && (
                <View style={styles.pickerContainer}>
                  <DateTimePicker
                    value={Platform.OS === 'ios' ? tempPickerDate : entryDate}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'inline' : 'default'}
                    maximumDate={new Date()}
                    onChange={handleDatePickerChange}
                    themeVariant="dark"
                  />
                  {Platform.OS === 'ios' && (
                    <View style={styles.pickerActions}>
                      <Pressable
                        style={styles.pickerCancelBtn}
                        onPress={() => setShowDatePicker(false)}
                      >
                        <Text style={styles.pickerCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable style={styles.pickerSetBtn} onPress={handleIosDateSet}>
                        <Text style={styles.pickerSetText}>Set Date</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )}

              {/* Odometer */}
              <Text style={styles.fieldLabel}>Odometer (optional)</Text>
              <TextInput
                style={styles.textInput}
                value={odometer}
                onChangeText={setOdometer}
                keyboardType="number-pad"
                placeholder="e.g. 85000"
                placeholderTextColor={colors.textMuted}
              />

              {/* Cost */}
              <Text style={styles.fieldLabel}>Cost (optional)</Text>
              <TextInput
                style={styles.textInput}
                value={cost}
                onChangeText={setCost}
                keyboardType="decimal-pad"
                placeholder="e.g. 49.99"
                placeholderTextColor={colors.textMuted}
              />

              {/* Notes */}
              <Text style={styles.fieldLabel}>Notes (optional)</Text>
              <TextInput
                style={[styles.textInput, styles.textInputMultiline]}
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={3}
                placeholder="Any notes about this service…"
                placeholderTextColor={colors.textMuted}
              />

              {/* Action buttons */}
              <View style={styles.modalActions}>
                <Pressable style={styles.cancelBtn} onPress={closeModal}>
                  <Text style={styles.cancelBtnText}>CANCEL</Text>
                </Pressable>
                <Pressable style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
                  <Text style={styles.saveBtnText}>{saving ? 'SAVING…' : 'SAVE'}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // ---- Header ----

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },

  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: colors.bg,
  },

  backBtnText: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 2,
  },

  headerRight: {
    width: 68, // mirrors backBtn width to center title
  },

  // ---- Tabs ----

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },

  tabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },

  tabBtnActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.amber,
  },

  tabBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    letterSpacing: 1,
  },

  tabBtnTextActive: {
    color: colors.amber,
  },

  // ---- Content ----

  content: {
    flex: 1,
  },

  listContent: {
    padding: 12,
    paddingBottom: 80, // clear FAB
  },

  separator: {
    height: 1,
    backgroundColor: colors.amberBorder,
    marginVertical: 2,
  },

  // ---- Schedule rows ----

  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 10,
  },

  statusBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    minWidth: 74,
    alignItems: 'center',
  },

  statusBadgeText: {
    color: '#fff',
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  scheduleRowContent: {
    flex: 1,
  },

  scheduleLabel: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  scheduleMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },

  daysUntil: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textAlign: 'right',
    minWidth: 72,
  },

  daysUntilOverdue: {
    color: '#e05050',
  },

  // ---- History rows ----

  historyRow: {
    paddingVertical: 12,
    paddingHorizontal: 4,
  },

  historyRowMain: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },

  historyLabel: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    flex: 1,
  },

  historyDate: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    marginLeft: 8,
  },

  historyRowMeta: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },

  historyMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },

  historyNotes: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 4,
    fontStyle: 'italic',
  },

  // ---- Empty state ----

  emptyState: {
    paddingTop: 48,
    alignItems: 'center',
    paddingHorizontal: 24,
  },

  emptyStateText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    textAlign: 'center',
    lineHeight: 20,
  },

  // ---- FAB ----

  fab: {
    position: 'absolute',
    bottom: 28,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 6,
  },

  fabText: {
    color: colors.bg,
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 36,
    includeFontPadding: false,
  },

  // ---- Modal ----

  modalContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  modalKAV: {
    flex: 1,
  },

  modalScroll: {
    padding: 20,
    paddingBottom: 40,
  },

  modalTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 20,
  },

  fieldLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 14,
    textTransform: 'uppercase',
  },

  // ---- Service type chips ----

  chipsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },

  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
  },

  chipActive: {
    borderColor: colors.amber,
    backgroundColor: 'rgba(220, 140, 35, 0.18)',
  },

  chipText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },

  chipTextActive: {
    color: colors.amber,
  },

  // ---- Date field ----

  dateField: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
  },

  dateFieldActive: {
    borderColor: colors.amber,
  },

  dateFieldText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  // ---- Date picker ----

  pickerContainer: {
    backgroundColor: 'rgba(25, 22, 17, 0.95)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    marginTop: 8,
    overflow: 'hidden',
  },

  pickerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.amberBorder,
  },

  pickerCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },

  pickerCancelText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  pickerSetBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
  },

  pickerSetText: {
    color: '#fff',
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },

  // ---- Text inputs ----

  textInput: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
  },

  textInputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: 11,
  },

  // ---- Modal action buttons ----

  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },

  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    alignItems: 'center',
  },

  cancelBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    letterSpacing: 1,
  },

  saveBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    alignItems: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.45,
  },

  saveBtnText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ---- Reference tab ----

  refContent: {
    padding: 12,
    paddingBottom: 80,
  },

  refTitle: {
    color: colors.amber,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 2,
  },

  refSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginBottom: 12,
  },

  refCard: {
    borderWidth: 1,
    borderColor: colors.amberBorder,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    backgroundColor: 'rgba(35, 32, 26, 0.70)',
  },

  refCardTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    marginBottom: 6,
  },

  refIntervalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },

  refIntervalLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    width: 56,
  },

  refIntervalValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '600',
  },

  refCardNotes: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontStyle: 'italic',
    marginTop: 4,
  },

  refSource: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
    fontStyle: 'italic',
  },

  dieselNote: {
    marginTop: 12,
    marginBottom: 4,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(220, 140, 35, 0.35)',
    backgroundColor: 'rgba(50, 40, 10, 0.50)',
  },

  dieselNoteText: {
    color: colors.amber,
    fontSize: fonts.sizeXs,
    lineHeight: 18,
  },
});
