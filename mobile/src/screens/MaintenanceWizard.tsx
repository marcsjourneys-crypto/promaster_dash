/** First-run wizard for seeding maintenance dates and choosing severe duty. */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Platform,
  SafeAreaView,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { colors, fonts } from '../config/theme';
import { loadSettings, saveSettings } from '../config/settings';
import { seedWizardDates } from '../services/maintenanceService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  onComplete: (severeDuty: boolean) => void;
  onSkip: () => void;
}

// ---------------------------------------------------------------------------
// Wizard items — hard-coded, do NOT import from maintenanceService
// ---------------------------------------------------------------------------

const WIZARD_ITEMS = [
  { service_type: 'oil',                label: 'Oil & Filter' },
  { service_type: 'tires_rotated',      label: 'Tire Rotation' },
  { service_type: 'cabin_air_filter',   label: 'Cabin Air Filter' },
  { service_type: 'engine_air_filter',  label: 'Engine Air Filter' },
  { service_type: 'brake_fluid',        label: 'Brake Fluid' },
  { service_type: 'transmission_fluid', label: 'Transmission Fluid (62TE)' },
  { service_type: 'coolant',            label: 'Coolant (OAT)' },
  { service_type: 'serpentine_belt',    label: 'Serpentine Belt Inspection' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// new Date('YYYY-MM-DD') parses as midnight UTC, shifting date for non-UTC zones.
// Parse into local-time components instead.
function isoToLocalDate(iso: string): Date {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

function formatDisplay(iso: string): string {
  // iso is YYYY-MM-DD; display as M/D/YYYY
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}/${parts[0]}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MaintenanceWizard({ onComplete, onSkip }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [severeDuty, setSevereDuty] = useState(false);

  // dates: service_type -> YYYY-MM-DD string (empty = unknown/skipped)
  const [dates, setDates] = useState<Record<string, string>>({});

  // Which row's picker is currently open (null = none)
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Temporary picker date state (before user confirms on iOS inline picker)
  const [pickerDate, setPickerDate] = useState<Date>(new Date());

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleDone() {
    await seedWizardDates(dates);
    const settings = await loadSettings();
    const ok = await saveSettings({ ...settings, severeDuty, maintenanceWizardComplete: true });
    if (!ok) return;
    onComplete(severeDuty);
  }

  async function handleSkip() {
    const settings = await loadSettings();
    const ok = await saveSettings({ ...settings, maintenanceWizardComplete: true });
    if (!ok) return;
    onSkip();
  }

  function openPicker(serviceType: string) {
    const existing = dates[serviceType];
    setPickerDate(existing ? isoToLocalDate(existing) : new Date());
    setPickerFor(serviceType);
  }

  function closePicker() {
    setPickerFor(null);
  }

  function handlePickerChange(_event: DateTimePickerEvent, selected?: Date) {
    if (!selected || !pickerFor) return;
    if (Platform.OS === 'android') {
      // On Android the picker closes itself; commit immediately
      setDates((prev) => ({ ...prev, [pickerFor]: toIsoDate(selected) }));
      setPickerFor(null);
    } else {
      // On iOS inline picker — update temp state; user taps "Set" to commit
      setPickerDate(selected);
    }
  }

  function handleIosSet() {
    if (!pickerFor) return;
    setDates((prev) => ({ ...prev, [pickerFor]: toIsoDate(pickerDate) }));
    setPickerFor(null);
  }

  function clearDate(serviceType: string) {
    setDates((prev) => {
      const next = { ...prev };
      delete next[serviceType];
      return next;
    });
    if (pickerFor === serviceType) setPickerFor(null);
  }

  const filledCount = Object.values(dates).filter(Boolean).length;

  // -------------------------------------------------------------------------
  // Render steps
  // -------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      {/* ------------------------------------------------------------------ */}
      {/* STEP 1 — Severe Duty                                                */}
      {/* ------------------------------------------------------------------ */}
      {step === 1 && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepLabel}>STEP 1 OF 3</Text>
          <Text style={styles.heading}>Maintenance Setup</Text>
          <Text style={styles.body}>
            Is this vehicle used for heavy hauling, commercial work, or camper duty?
            {'\n\n'}
            <Text style={styles.bodyMuted}>
              Severe duty halves all maintenance intervals — oil every 6 months instead of 12, etc.
            </Text>
          </Text>

          <View style={styles.choiceRow}>
            <Pressable
              style={[styles.choiceBtn, severeDuty && styles.choiceBtnActive]}
              onPress={() => { setSevereDuty(true); setStep(2); }}
            >
              <Text style={[styles.choiceBtnText, severeDuty && styles.choiceBtnTextActive]}>
                YES — Severe Duty
              </Text>
            </Pressable>

            <Pressable
              style={[styles.choiceBtn, !severeDuty && styles.choiceBtnActive]}
              onPress={() => { setSevereDuty(false); setStep(2); }}
            >
              <Text style={[styles.choiceBtnText, !severeDuty && styles.choiceBtnTextActive]}>
                NO — Normal Use
              </Text>
            </Pressable>
          </View>

          <Pressable style={styles.skipLink} onPress={handleSkip}>
            <Text style={styles.skipLinkText}>Skip setup</Text>
          </Pressable>
        </View>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* STEP 2 — Service dates                                              */}
      {/* ------------------------------------------------------------------ */}
      {step === 2 && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepLabel}>STEP 2 OF 3</Text>
          <Text style={styles.heading}>Last Service Dates</Text>
          <Text style={styles.body}>
            When was each service last done? Leave blank if unknown — you can always add it later.
          </Text>

          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {WIZARD_ITEMS.map((item) => {
              const dateStr = dates[item.service_type];
              const isOpen = pickerFor === item.service_type;

              return (
                <View key={item.service_type}>
                  <View style={styles.serviceRow}>
                    <View style={styles.serviceLabel}>
                      <Text style={styles.serviceName}>{item.label}</Text>
                      {dateStr ? (
                        <Text style={styles.serviceDateText}>{formatDisplay(dateStr)}</Text>
                      ) : (
                        <Text style={styles.serviceDateUnknown}>Unknown</Text>
                      )}
                    </View>

                    <View style={styles.serviceActions}>
                      <Pressable
                        style={[styles.dateBtn, isOpen && styles.dateBtnActive]}
                        onPress={() => (isOpen ? closePicker() : openPicker(item.service_type))}
                      >
                        <Text style={[styles.dateBtnText, isOpen && styles.dateBtnTextActive]}>
                          {dateStr ? 'Change' : 'Set Date'}
                        </Text>
                      </Pressable>

                      {dateStr ? (
                        <Pressable style={styles.clearBtn} onPress={() => clearDate(item.service_type)}>
                          <Text style={styles.clearBtnText}>X</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>

                  {/* Inline date picker (iOS shows inline, Android is a dialog) */}
                  {isOpen && (
                    <View style={styles.pickerContainer}>
                      <DateTimePicker
                        value={pickerDate}
                        mode="date"
                        display={Platform.OS === 'ios' ? 'inline' : 'default'}
                        maximumDate={new Date()}
                        onChange={handlePickerChange}
                        themeVariant="dark"
                      />
                      {Platform.OS === 'ios' && (
                        <View style={styles.pickerActions}>
                          <Pressable style={styles.pickerCancelBtn} onPress={closePicker}>
                            <Text style={styles.pickerCancelText}>Cancel</Text>
                          </Pressable>
                          <Pressable style={styles.pickerSetBtn} onPress={handleIosSet}>
                            <Text style={styles.pickerSetText}>Set Date</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.navRow}>
            <Pressable style={styles.backBtn} onPress={() => setStep(1)}>
              <Text style={styles.backBtnText}>BACK</Text>
            </Pressable>
            <Pressable style={styles.nextBtn} onPress={() => setStep(3)}>
              <Text style={styles.nextBtnText}>NEXT</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* STEP 3 — Summary                                                    */}
      {/* ------------------------------------------------------------------ */}
      {step === 3 && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepLabel}>STEP 3 OF 3</Text>
          <Text style={styles.heading}>Summary</Text>

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Duty Cycle</Text>
              <Text style={[styles.summaryValue, severeDuty && styles.summaryValueAmber]}>
                {severeDuty ? 'Severe Duty' : 'Normal Use'}
              </Text>
            </View>

            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Dates Recorded</Text>
              <Text style={styles.summaryValue}>
                {filledCount} / {WIZARD_ITEMS.length}
              </Text>
            </View>

            {filledCount === 0 && (
              <Text style={styles.summaryNote}>
                No dates entered — all items will show as Unknown until you log a service.
              </Text>
            )}
          </View>

          <Text style={styles.body}>
            You can update any of this in Settings at any time.
          </Text>

          <View style={styles.navRow}>
            <Pressable style={styles.backBtn} onPress={() => setStep(2)}>
              <Text style={styles.backBtnText}>BACK</Text>
            </Pressable>
            <Pressable style={styles.doneBtn} onPress={handleDone}>
              <Text style={styles.doneBtnText}>DONE</Text>
            </Pressable>
          </View>
        </View>
      )}
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

  stepContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 16,
  },

  stepLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },

  heading: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginBottom: 16,
  },

  body: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    lineHeight: 22,
    marginBottom: 24,
  },

  bodyMuted: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
  },

  // ---- Step 1: choice buttons ----

  choiceRow: {
    gap: 12,
    marginBottom: 32,
  },

  choiceBtn: {
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    alignItems: 'center',
  },

  choiceBtnActive: {
    borderColor: colors.amber,
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
  },

  choiceBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },

  choiceBtnTextActive: {
    color: colors.amber,
  },

  // ---- Navigation buttons ----

  nextBtn: {
    flex: 2,
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
    paddingVertical: 14,
    alignItems: 'center',
  },

  nextBtnText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },

  skipLink: {
    alignItems: 'center',
    paddingVertical: 10,
  },

  skipLinkText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    textDecorationLine: 'underline',
  },

  navRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },

  backBtn: {
    flex: 1,
    backgroundColor: 'rgba(45, 42, 36, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    paddingVertical: 14,
    alignItems: 'center',
  },

  backBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    letterSpacing: 1,
  },

  doneBtn: {
    flex: 2,
    backgroundColor: 'rgba(160, 120, 40, 0.90)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 220, 160, 0.39)',
    paddingVertical: 14,
    alignItems: 'center',
  },

  doneBtnText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ---- Step 2: service list ----

  listScroll: {
    flex: 1,
    marginBottom: 8,
  },

  listContent: {
    gap: 2,
    paddingBottom: 8,
  },

  serviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },

  serviceLabel: {
    flex: 1,
  },

  serviceName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  serviceDateText: {
    color: colors.amber,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },

  serviceDateUnknown: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
    opacity: 0.6,
  },

  serviceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  dateBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
  },

  dateBtnActive: {
    borderColor: colors.amber,
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
  },

  dateBtnText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },

  dateBtnTextActive: {
    color: colors.amber,
  },

  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 25, 0.35)',
    backgroundColor: 'rgba(140, 30, 20, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  clearBtnText: {
    color: 'rgba(220, 80, 60, 0.9)',
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },

  pickerContainer: {
    backgroundColor: 'rgba(25, 22, 17, 0.95)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    marginVertical: 8,
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

  // ---- Step 3: summary card ----

  summaryCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 20,
  },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },

  summaryDivider: {
    height: 1,
    backgroundColor: colors.amberBorder,
  },

  summaryLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },

  summaryValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },

  summaryValueAmber: {
    color: colors.amber,
  },

  summaryNote: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginBottom: 8,
    lineHeight: 18,
  },
});
