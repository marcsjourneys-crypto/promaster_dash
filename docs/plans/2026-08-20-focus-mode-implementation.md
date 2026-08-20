# Focus Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users pick up to 3 gauges and view them full-screen at 2–3× size, with a one-tap toggle back to the normal dashboard.

**Architecture:** Focus mode is a display *mode*, not a reconfiguration. `DashboardScreen` branches early to `FocusView` when `focusActive` is set; every existing render path is untouched. Selection lives in Settings (`focusPids`), activation on the dashboard. All filtering logic goes in a pure, tested module — the same split used by `bodySweepCore` and `pollScheduler`.

**Tech Stack:** React Native 0.81 + Expo SDK 54, TypeScript, Zustand, Jest (`jest-expo` preset).

**Design doc:** `docs/plans/2026-08-19-focus-mode-design.md`

**Branch:** `feat/focus-mode` (already created off `main`)

---

## STATUS: executed 2026-08-20 — this document is now historical

Tasks 1–8 are implemented and committed. Task 9 (device tuning) is outstanding.

The code diverged from this plan in four places. **Where they disagree, the code is right.**

1. **`resolveFocusGauges` takes three arguments, not two.** Task 2 below still shows the original `(focusPids, discovery)` signature; Task 6 shows the corrected `(focusPids, discovery, enabledPids)`. Review found that a focused-but-disabled gauge is never polled and would render a frozen stale value at 2.4×. See the Correction section in the design doc.
2. **`isFuelTrimSupported` lives in `pidRegistry.ts`, not `focusLayout.ts`.** Having `DashboardScreen` import from a focus-mode module to render its normal view was a backwards dependency.
3. **The focus button keys off the *resolved* gauge list**, not raw `focusPids.length`. The two disagreed when every pick was disabled, producing a button that visibly did nothing.
4. **Test counts here are stale.** The plan predicted 101; the branch has 109, because review added cases for the enabled-subset rule, de-duplication, non-array input, and the shared prop builder. Trust `npm test`, not this document.

---

---

## Before you start

Run these from `mobile/` and confirm the baseline is green:

```sh
cd mobile
npx tsc --noEmit     # expect: no output
npm test             # expect: 8 suites, 88 tests passing
```

If that baseline isn't green, stop — something is wrong before your changes.

**Domain notes you'll need:**

- Values in the store are **always imperial**. `src/utils/units.ts` converts at render only. Never convert in a component; call `units.gaugeValue()` / `units.gaugeUnit()`.
- `PID_REGISTRY` (`src/config/pidRegistry.ts`) is the single source for a gauge's label, unit, range, and thresholds. Never hardcode those.
- A null store value must render as `--`, never `0` and never a stale reading. On a temperature gauge a stale number is worse than no number.
- `gaugeMode: 'pressure_low'` is **inverted** — warn and crit are *below*. Don't write threshold logic yourself; reuse `SegmentBar`.

---

## Task 1: Add focus settings keys

**Files:**
- Modify: `mobile/src/config/settings.ts`

**Step 1: Add the fields to the interface**

In `src/config/settings.ts`, inside `interface Settings`, after the `// Display` block (the `startNightMode` / `tempUnit` / `speedUnit` lines), add:

```ts
  // Focus mode — up to 3 gauges rendered full-screen
  focusPids: string[];
  focusActive: boolean;
```

**Step 2: Add the defaults**

In `DEFAULT_SETTINGS`, after `speedUnit: 'mph',` add:

```ts
  focusPids: [],
  focusActive: false,
```

No migration is needed — `loadSettings` already spreads `DEFAULT_SETTINGS` before stored values, so existing installs get these automatically.

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no output.

**Step 4: Commit**

```sh
git add mobile/src/config/settings.ts
git commit -m "feat: add focusPids and focusActive settings"
```

---

## Task 2: Pure focus-gauge resolution

This is the module that decides *which* gauges focus mode shows. It is pure so it can be tested without a renderer.

**Files:**
- Create: `mobile/src/utils/focusLayout.ts`
- Test: `mobile/src/utils/__tests__/focusLayout.test.ts`

**Step 1: Write the failing test**

Create `mobile/src/utils/__tests__/focusLayout.test.ts`:

```ts
/** Which gauges focus mode actually renders. */

import { resolveFocusGauges, MAX_FOCUS_GAUGES } from '../focusLayout';

const NO_DISCOVERY = { supported: new Set<string>(), done: false };

describe('resolveFocusGauges', () => {
  it('maps ids to registry defs in the user-chosen order', () => {
    const r = resolveFocusGauges(['coolantF', 'transF'], NO_DISCOVERY);
    expect(r.map((p) => p.id)).toEqual(['coolantF', 'transF']);
  });

  it('ignores ids that are not in the registry', () => {
    const r = resolveFocusGauges(['transF', 'nopeNotReal'], NO_DISCOVERY);
    expect(r.map((p) => p.id)).toEqual(['transF']);
  });

  it('returns empty for an empty selection', () => {
    expect(resolveFocusGauges([], NO_DISCOVERY)).toEqual([]);
  });

  it('drops fuel-trim gauges the ECU reported as unsupported', () => {
    const done = { supported: new Set(['06']), done: true };
    // stftBank1Pct is PID 06 (supported); ltftBank1Pct is 07 (not)
    const r = resolveFocusGauges(['stftBank1Pct', 'ltftBank1Pct'], done);
    expect(r.map((p) => p.id)).toEqual(['stftBank1Pct']);
  });

  it('keeps fuel-trim gauges before discovery completes', () => {
    const r = resolveFocusGauges(['ltftBank1Pct'], NO_DISCOVERY);
    expect(r.map((p) => p.id)).toEqual(['ltftBank1Pct']);
  });

  it('keeps non-fuel-trim gauges regardless of discovery', () => {
    const done = { supported: new Set<string>(), done: true };
    const r = resolveFocusGauges(['transF', 'oilPressurePsi'], done);
    expect(r.map((p) => p.id)).toEqual(['transF', 'oilPressurePsi']);
  });

  it('does not cap — a hand-edited 4th degrades to smaller gauges, not a crash', () => {
    const four = ['transF', 'coolantF', 'voltageV', 'oilPressurePsi'];
    expect(resolveFocusGauges(four, NO_DISCOVERY)).toHaveLength(4);
  });

  it('exposes the UI cap as a constant', () => {
    expect(MAX_FOCUS_GAUGES).toBe(3);
  });
});
```

**Step 2: Run it to verify it fails**

Run: `npx jest src/utils/__tests__/focusLayout.test.ts`
Expected: FAIL — `Cannot find module '../focusLayout'`.

**Step 3: Write the implementation**

Create `mobile/src/utils/focusLayout.ts`:

```ts
/**
 * Focus mode gauge resolution — pure, so it is tested without a renderer.
 *
 * Focus mode shows a small number of gauges full-screen. This module decides
 * which of the user's chosen PIDs are actually renderable right now.
 */

import { getPidDef, type PidDef } from '../config/pidRegistry';

/** UI cap on focus gauges. Not enforced here — see resolveFocusGauges. */
export const MAX_FOCUS_GAUGES = 3;

export interface Mode01Discovery {
  /** Mode 01 PIDs the ECU reported as supported (uppercase hex). */
  supported: Set<string>;
  /** Whether discovery has finished — before it has, assume supported. */
  done: boolean;
}

/**
 * Map stored focus PID ids to registry definitions, dropping any that cannot
 * render. Preserves the user's chosen order.
 *
 * Deliberately does NOT enforce MAX_FOCUS_GAUGES: the cap is a UI affordance,
 * and a hand-edited 4th entry should degrade to smaller gauges rather than
 * throw. An empty result tells the caller to fall back to the normal
 * dashboard — never render a blank screen.
 */
export function resolveFocusGauges(
  focusPids: string[],
  discovery: Mode01Discovery,
): PidDef[] {
  const out: PidDef[] = [];
  for (const id of focusPids) {
    const pid = getPidDef(id);
    if (!pid) continue; // stale id from a removed registry entry
    // Same rule the dashboard applies: hide fuel trims the ECU denies.
    if (
      pid.gaugeMode === 'fuel_trim' &&
      discovery.done &&
      !discovery.supported.has(pid.pid.toUpperCase())
    ) {
      continue;
    }
    out.push(pid);
  }
  return out;
}
```

**Step 4: Run the test to verify it passes**

Run: `npx jest src/utils/__tests__/focusLayout.test.ts`
Expected: PASS, 8 tests.

**Step 5: Commit**

```sh
git add mobile/src/utils/focusLayout.ts mobile/src/utils/__tests__/focusLayout.test.ts
git commit -m "feat: add pure focus gauge resolution"
```

---

## Task 3: Extract gauge value formatting

`formatGaugeValue` currently lives inside `DashboardScreen`. `FocusView` needs it too. Extract it rather than copy it — a second copy is a second place for the rules to drift.

**Files:**
- Create: `mobile/src/utils/gaugeFormat.ts`
- Test: `mobile/src/utils/__tests__/gaugeFormat.test.ts`
- Modify: `mobile/src/screens/DashboardScreen.tsx`

**Step 1: Write the failing test**

Create `mobile/src/utils/__tests__/gaugeFormat.test.ts`:

```ts
import { formatGaugeValue } from '../gaugeFormat';
import { getPidDef } from '../../config/pidRegistry';
import { makeUnits } from '../units';

const IMP = makeUnits({ tempUnit: 'F', speedUnit: 'mph' });
const MET = makeUnits({ tempUnit: 'C', speedUnit: 'kph' });

const trans = getPidDef('transF')!;
const volt = getPidDef('voltageV')!;
const stft = getPidDef('stftBank1Pct')!;

it('renders the placeholder for missing data', () => {
  expect(formatGaugeValue(trans, null, IMP)).toBe('--');
});

it('formats temperatures with no decimals', () => {
  expect(formatGaugeValue(trans, 218.7, IMP)).toBe('219');
});

it('converts temperatures before formatting', () => {
  expect(formatGaugeValue(trans, 212, MET)).toBe('100');
});

it('formats voltage with one decimal', () => {
  expect(formatGaugeValue(volt, 14.23, IMP)).toBe('14.2');
});

it('signs fuel trim', () => {
  expect(formatGaugeValue(stft, 3.5, IMP)).toBe('+3.5');
  expect(formatGaugeValue(stft, -3.5, IMP)).toBe('-3.5');
});
```

**Step 2: Run it to verify it fails**

Run: `npx jest src/utils/__tests__/gaugeFormat.test.ts`
Expected: FAIL — `Cannot find module '../gaugeFormat'`.

**Step 3: Move the function**

Create `mobile/src/utils/gaugeFormat.ts` by moving the body of `formatGaugeValue` out of `src/screens/DashboardScreen.tsx` verbatim:

```ts
/** Format a store value for display on a gauge card, in the active units. */

import type { PidDef } from '../config/pidRegistry';
import type { Units } from './units';

export function formatGaugeValue(
  pid: PidDef,
  rawValue: number | null,
  units: Units,
): string {
  const value = units.gaugeValue(pid.unit, rawValue);
  if (value === null) return '--';
  // Fuel trim: signed, 1 decimal
  if (pid.gaugeMode === 'fuel_trim') {
    return (value > 0 ? '+' : '') + value.toFixed(1);
  }
  // Temperatures and pressures: no decimals
  if (pid.gaugeMode === 'temp' || pid.gaugeMode === 'pressure_low') {
    return value.toFixed(0);
  }
  // Voltage: 1 decimal
  if (pid.gaugeMode === 'volt') {
    return value.toFixed(1);
  }
  // Percentages: 1 decimal
  if (pid.gaugeMode === 'percent') {
    return value.toFixed(1);
  }
  // Info gauges: variable
  if (pid.unit === 'g/s') return value.toFixed(1);
  if (pid.unit === '°') return value.toFixed(1);
  return value.toFixed(0);
}
```

Then in `DashboardScreen.tsx`: delete the local `formatGaugeValue` function and add to the imports:

```ts
import { formatGaugeValue } from '../utils/gaugeFormat';
```

**Step 4: Verify**

Run: `npx jest src/utils/__tests__/gaugeFormat.test.ts` → PASS, 5 tests.
Run: `npx tsc --noEmit` → no output.
Run: `npm test` → 10 suites, 101 tests.

**Step 5: Commit**

```sh
git add mobile/src/utils/gaugeFormat.ts mobile/src/utils/__tests__/gaugeFormat.test.ts mobile/src/screens/DashboardScreen.tsx
git commit -m "refactor: extract formatGaugeValue for reuse by focus mode"
```

---

## Task 4: Add a scale prop to SegmentBar and GaugeCard

`GaugeCard` already stretches (`flex: 1`) but its type does not — the value is a fixed `fonts.size2xl` (42). This adds the knob.

**Files:**
- Modify: `mobile/src/components/SegmentBar.tsx`
- Modify: `mobile/src/components/GaugeCard.tsx`

**Step 1: Scale SegmentBar**

In `SegmentBar.tsx`, add `scale` to the props interface:

```ts
interface SegmentBarProps {
  value: number | null;
  min: number;
  max: number;
  mode: GaugeMode;
  warn: number | null;
  crit: number | null;
  /** Display multiplier for focus mode. 1 = normal dashboard. */
  scale?: number;
}
```

Destructure it with a default: `export function SegmentBar({ value, min, max, mode, warn, crit, scale = 1 }: SegmentBarProps) {`

The static styles are `container: { height: 28 }` and `segment: { flex: 1, height: 18 }`. Segments already flex horizontally, so only the heights need scaling. Apply inline overrides at both usage sites (there are two — the `fuel_trim` branch and the main branch):

```tsx
<View style={[styles.container, { height: 28 * scale }]}>
```

and for each segment:

```tsx
style={[
  styles.segment,
  { height: 18 * scale, backgroundColor: /* unchanged */ },
]}
```

Leave all threshold and color logic exactly as-is.

**Step 2: Scale GaugeCard**

In `GaugeCard.tsx`, add to the props interface:

```ts
  /** Display multiplier for focus mode. 1 = normal dashboard. */
  scale?: number;
```

Destructure with `scale = 1`, then apply inline font overrides. The static styles stay as the `scale = 1` case:

```tsx
<Text style={[styles.title, { fontSize: fonts.sizeMd * scale }]}>{title}</Text>
…
<Text style={[styles.value, { fontSize: fonts.size2xl * scale }]}>{value}</Text>
<Text style={[styles.unit, { fontSize: fonts.sizeLg * scale }]}>{unit}</Text>
…
<SegmentBar … scale={scale} />
```

**Step 3: Verify nothing regressed**

Run: `npx tsc --noEmit` → no output.
Run: `npm test` → still 10 suites, 101 tests. The normal dashboard passes no `scale`, so it renders identically.

**Step 4: Commit**

```sh
git add mobile/src/components/SegmentBar.tsx mobile/src/components/GaugeCard.tsx
git commit -m "feat: add optional scale prop to GaugeCard and SegmentBar"
```

---

## Task 5: Build FocusView

**Files:**
- Create: `mobile/src/components/FocusView.tsx`

**Step 1: Write the component**

```tsx
/**
 * Focus mode — up to 3 gauges filling the screen.
 *
 * A flex column with no ScrollView: each gauge takes an equal share of the
 * available height, so overflow is structurally impossible. That guarantee is
 * the whole point of the mode.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable, SafeAreaView } from 'react-native';
import { useVehicleStore } from '../store/vehicleStore';
import { GaugeCard } from './GaugeCard';
import { AlertBanner } from './AlertBanner';
import { colors, fonts } from '../config/theme';
import { formatGaugeValue } from '../utils/gaugeFormat';
import type { PidDef } from '../config/pidRegistry';
import type { Units } from '../utils/units';

/** Multiplier for gauge type in focus mode. Tune on device — see Task 9. */
const FOCUS_SCALE = 2.4;

interface FocusViewProps {
  gauges: PidDef[];
  units: Units;
  onExit: () => void;
  onNavigate?: (screen: string) => void;
}

export function FocusView({ gauges, units, onExit, onNavigate }: FocusViewProps) {
  const store = useVehicleStore();
  const { alertMessage, alertPriority, bleConnected } = store;

  return (
    <SafeAreaView style={styles.container}>
      {/* Adapter dropped — the only signal, since the BLE pill is hidden here */}
      {!bleConnected && (
        <View style={styles.disconnectStrip}>
          <Text style={styles.disconnectText}>ADAPTER DISCONNECTED</Text>
        </View>
      )}

      <AlertBanner
        message={alertMessage}
        priority={alertPriority}
        onPress={() => onNavigate?.('alerts')}
      />

      <View style={styles.gauges}>
        {gauges.map((pid) => {
          const rawValue = (store as any)[pid.id] as number | null;
          return (
            <View key={pid.id} style={styles.gaugeSlot}>
              <GaugeCard
                title={pid.label}
                value={formatGaugeValue(pid, rawValue, units)}
                unit={units.gaugeUnit(pid.unit)}
                rawValue={units.gaugeValue(pid.unit, rawValue)}
                min={units.gaugeValue(pid.unit, pid.range[0])!}
                max={units.gaugeValue(pid.unit, pid.range[1])!}
                mode={pid.gaugeMode}
                warn={units.gaugeValue(pid.unit, pid.warn)}
                crit={units.gaugeValue(pid.unit, pid.crit)}
                scale={FOCUS_SCALE}
              />
            </View>
          );
        })}
      </View>

      <Pressable style={styles.exitBtn} onPress={onExit}>
        <Text style={styles.exitBtnText}>{'▼'} EXIT FOCUS</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
  },
  gauges: {
    flex: 1,
    gap: 6,
  },
  gaugeSlot: {
    flex: 1,
  },
  disconnectStrip: {
    backgroundColor: 'rgba(140, 30, 20, 0.92)',
    borderRadius: 6,
    paddingVertical: 5,
    marginBottom: 4,
    alignItems: 'center',
  },
  disconnectText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
  exitBtn: {
    backgroundColor: 'rgba(35, 32, 26, 0.90)',
    borderWidth: 2,
    borderColor: 'rgba(255, 220, 160, 0.33)',
    borderRadius: 10,
    paddingVertical: 9,
    marginTop: 6,
    alignItems: 'center',
  },
  exitBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
```

Note the gauge props mirror `DashboardScreen` exactly — value, unit label, and `min`/`max`/`warn`/`crit` all go through `units.gaugeValue()` together so the segment bar stays proportional.

**Step 2: Verify**

Run: `npx tsc --noEmit` → no output.

**Step 3: Commit**

```sh
git add mobile/src/components/FocusView.tsx
git commit -m "feat: add FocusView full-screen gauge layout"
```

---

## Task 6: Branch DashboardScreen into focus mode

**Files:**
- Modify: `mobile/src/screens/DashboardScreen.tsx`

**Step 1: Extend the props**

```ts
interface DashboardScreenProps {
  onNavigate?: (screen: string) => void;
  useLiveGPS?: boolean;
  enabledPids?: string[];
  units?: Units;
  focusPids?: string[];
  focusActive?: boolean;
  onSetFocusActive?: (active: boolean) => void;
}
```

Destructure with `focusPids = []`, `focusActive = false`, `onSetFocusActive`.

**Step 2: Resolve and branch**

Add imports:

```ts
import { resolveFocusGauges } from '../utils/focusLayout';
import { FocusView } from '../components/FocusView';
```

After the `store` destructuring and **after** all hook calls (`useKeepAwake`, `useGPS`, `useMockData`, the `useState`/`useEffect` timer) — hooks must not be skipped by an early return:

```tsx
  const focusGauges = React.useMemo(
    () => resolveFocusGauges(
      focusPids,
      { supported: supportedMode01Pids, done: mode01DiscoveryDone },
      enabledPids,
    ),
    [focusPids, enabledPids, supportedMode01Pids, mode01DiscoveryDone],
  );

  // Empty selection falls back to the normal dashboard — never a blank screen
  if (focusActive && focusGauges.length > 0) {
    return (
      <FocusView
        gauges={focusGauges}
        units={units}
        onExit={() => onSetFocusActive?.(false)}
        onNavigate={onNavigate}
      />
    );
  }
```

**Step 3: Add the entry button**

In the second status bar, immediately before the settings `iconBtn` Pressable, add:

```tsx
        {focusPids.length > 0 && (
          <Pressable style={styles.iconBtn} onPress={() => onSetFocusActive?.(true)}>
            <Text style={styles.iconBtnText}>{'◱'}</Text>
          </Pressable>
        )}
```

Hidden when nothing is selected — no route to an empty focus screen.

**Step 4: Verify**

Run: `npx tsc --noEmit` → no output.
Run: `npm test` → 10 suites, 101 tests.

**Step 5: Commit**

```sh
git add mobile/src/screens/DashboardScreen.tsx
git commit -m "feat: branch dashboard into focus mode"
```

---

## Task 7: Focus gauge picker in Settings

**Files:**
- Modify: `mobile/src/screens/SettingsScreen.tsx`

**Step 1: Add the toggle handler**

Near `togglePid`, add:

```ts
  const toggleFocusPid = useCallback((pidId: string) => {
    setSettings((prev) => {
      const current = prev.focusPids;
      if (current.includes(pidId)) {
        return { ...prev, focusPids: current.filter((id) => id !== pidId) };
      }
      if (current.length >= MAX_FOCUS_GAUGES) return prev; // cap
      return { ...prev, focusPids: [...current, pidId] };
    });
    setModified(true);
  }, []);
```

Import the cap: `import { MAX_FOCUS_GAUGES } from '../utils/focusLayout';`

**Step 2: Render the section**

At the top of the `activeTab === 'gauges'` block, above the existing info text:

```tsx
            <Text style={styles.sectionHeader}>FOCUS GAUGES</Text>
            <Text style={styles.infoText}>
              Pick up to {MAX_FOCUS_GAUGES} gauges to show full-screen. Tap the
              focus button on the dashboard to switch. Only gauges enabled below
              can be focused — the app has to be reading a gauge to display it.
            </Text>
            {getSortedPids().filter((p) => enabledSet.has(p.id)).map((pid) => {
              const on = settings.focusPids.includes(pid.id);
              const capped = !on && settings.focusPids.length >= MAX_FOCUS_GAUGES;
              return (
                <View key={`focus-${pid.id}`} style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.switchLabel}>{pid.label}</Text>
                    <Text style={styles.switchHint}>
                      {capped ? `Limit of ${MAX_FOCUS_GAUGES} reached` : pid.unit}
                    </Text>
                  </View>
                  <Switch
                    value={on}
                    disabled={capped}
                    onValueChange={() => toggleFocusPid(pid.id)}
                    trackColor={{ false: 'rgba(60, 55, 45, 1)', true: 'rgba(180, 130, 50, 0.6)' }}
                    thumbColor={on ? colors.amber : 'rgba(150, 140, 120, 1)'}
                  />
                </View>
              );
            })}
            <Text style={[styles.sectionHeader, { marginTop: 20 }]}>DASHBOARD GAUGES</Text>
```

Add `getSortedPids` to the existing `pidRegistry` import.

**Deliberate behavior:** disabling a gauge does *not* remove it from `focusPids`. The picker stops showing it and `resolveFocusGauges` drops it at render, so it is inert and safe — but re-enabling the gauge later restores it as a focus pick. Remembering the choice is friendlier than silently discarding it, and the safety comes from the resolver, not from cleaning the stored list.

**Step 3: Verify**

Run: `npx tsc --noEmit` → no output.

**Step 4: Commit**

```sh
git add mobile/src/screens/SettingsScreen.tsx
git commit -m "feat: add focus gauge picker with a cap of 3"
```

---

## Task 8: Wire it through App

**Files:**
- Modify: `mobile/App.tsx`

**Step 1: Add the activation handler**

Focus activation must persist immediately — the user toggles it on the dashboard, not through the Settings save path:

```tsx
  const handleSetFocusActive = useCallback((active: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, focusActive: active };
      saveSettings(next);
      return next;
    });
  }, []);
```

Add `saveSettings` to the existing `./src/config/settings` import.

**Step 2: Pass the props**

```tsx
            <DashboardScreen
              onNavigate={handleNavigate}
              useLiveGPS={liveMode}
              enabledPids={settings.enabledPids}
              units={units}
              focusPids={settings.focusPids}
              focusActive={settings.focusActive}
              onSetFocusActive={handleSetFocusActive}
            />
```

**Step 3: Verify**

Run: `npx tsc --noEmit` → no output.
Run: `npm test` → 10 suites, 101 tests.

**Step 4: Commit**

```sh
git add mobile/App.tsx
git commit -m "feat: wire focus mode through App"
```

---

## Task 9: Device tuning pass

Everything above is testable at a desk. These are not — they need the phone.

**Step 1: Run it**

```sh
cd mobile
npm start
```

Connect the dev client. Use mock mode (live mode off in Settings) so gauges have moving values without a van.

**Step 2: Walk the checklist**

- Select 1, then 2, then 3 focus gauges — each layout fills the screen with no scrolling
- Select 0 — the focus button disappears from the dashboard
- Enter focus, force-quit, relaunch — still in focus mode (`focusActive` persists)
- Toggle metric in Settings — focus gauges convert too
- Disconnect the adapter — red strip appears; values go to `--`, not stale or zero
- Trigger a mock alert — banner shows above the gauges; **layout does not shift**
- `EXIT FOCUS` returns to the normal dashboard with the speed hero intact

**Step 3: Tune the two unknowns**

- `FOCUS_SCALE = 2.4` in `FocusView.tsx` — adjust until a value is readable at arm's length. With 3 gauges the card is roughly a third of the screen; too large a multiplier will clip.
- `SEGMENT_COUNT = 14` in `SegmentBar.tsx` — at 2–3× the segments may read as chunky. If so, scale the count as well as the height.

**Step 4: Commit any tuning**

```sh
git add mobile/src/components/FocusView.tsx mobile/src/components/SegmentBar.tsx
git commit -m "fix: tune focus mode scale after device testing"
```

---

## Done criteria

- `npx tsc --noEmit` clean
- `npm test` green — expect **10 suites / 101 tests** (88 baseline + 8 focusLayout + 5 gaugeFormat)
- The device checklist in Task 9 passes
- The normal dashboard is visually unchanged when focus mode is off

## Follow-ups for the vault

After merging, update: `[[Screens Overview]]` (new component + UI history), `[[Known Issues]]`, `[[Next Steps]]`, and a daily note. Add a `[[Decision Log]]` entry only if something in the design changed during implementation.
