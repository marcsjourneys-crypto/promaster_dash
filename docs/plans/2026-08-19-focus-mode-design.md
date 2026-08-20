# Focus Mode — Design Document

**Date:** 2026-08-19
**Status:** Approved

## Summary

Let users pick up to 3 gauges and view them at 2–3× size, filling the screen, with everything else hidden. Requested by users who want trans temp and oil pressure readable at a glance from a bouncing driver's seat, without scrolling past speed, RPM, and elevation to reach them.

Focus mode is a **display mode, not a reconfiguration.** The normal dashboard is untouched and one tap away. Nothing about the existing render path changes.

## Constraints & Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Nature of the feature | A toggleable mode | User wants to "go back to default when needed" — not a permanent layout change |
| Max focus gauges | 3 | Beyond 3 the cards stop being dramatically larger, defeating the point |
| Selection vs activation | Selection in Settings, activation on dashboard | Choosing is a parked decision; toggling happens at 65 mph and must be one tap |
| `focusPids` vs `enabledPids` | `focusPids` is a **subset** of `enabledPids` | See "Correction" below. Entering focus must not rewrite the normal dashboard — but focus also cannot show a gauge the app is not polling |
| `focusActive` persistence | Persisted | Someone who drives in focus mode wants it every drive; exiting is one tap |
| Critical alert in focus mode | Banner only, layout never changes | Gauge positions stay memorable; the driver's deliberate choice isn't overridden. `AlertBanner` already carries the parameter and value (`COOLANT CRITICAL: 255°F`) |
| Chrome retained | None but exit + alert banner | Maximum gauge size was the explicit goal |
| Scaling approach | `scale` prop on `GaugeCard` | A parallel component would duplicate threshold logic; `pressure_low` inversion drifting out of sync would render a critical oil pressure as healthy |

Rejected alternatives:

- **Long-press a card to enlarge it.** Direct and needs no settings, but awkward for selecting 3, and long-press is a hard gesture to land on a rough road.
- **Everything in Settings.** Consistent with existing preferences, but a 4-tap menu round trip to change modes mid-drive.
- **Auto-promote an alarming gauge into the focus view.** Rejected: the layout shifts under the driver's eyes at the worst moment, and gauge positions stop being memorable.
- **Auto-exit focus on a critical alert.** Rejected: yanks away the large readout exactly when the driver may be watching one closely.

## Correction — 2026-08-20, during implementation

The original decision read *"`focusPids` independent of `enabledPids`."* Code review caught that this is unsafe as written.

`obdService.ts:345` builds the poll schedule from enabled PIDs only, so **a disabled PID is never polled**, and `SettingsScreen.tsx:58` `togglePid` rewrites `enabledPids` without clearing the store. Focusing a disabled gauge therefore renders either a permanent `--` or a **frozen last-known reading at 2.4× size** — violating the standing rule that a stale number on a temperature gauge is worse than no number.

The intent behind "independent" was that entering focus mode must not silently rewrite the normal dashboard. That still holds. What does not hold is showing a gauge the app isn't reading.

**Corrected rule:** `focusPids` is a subset of `enabledPids`. `resolveFocusGauges` drops anything not enabled, and the Settings picker offers only enabled gauges. To focus a gauge you must first enable it — a real constraint of the polling architecture, not a UX preference.

## Architecture

### Settings

Two new keys in `src/config/settings.ts`:

```ts
focusPids: string[];      // up to 3 PID ids, default []
focusActive: boolean;     // default false
```

Both ride the existing `loadSettings`/`saveSettings` path. `DEFAULT_SETTINGS` merging gives existing installs `[]` / `false` with no migration.

The cap of 3 is enforced in the Settings UI, not the type. A `string[]` holding 3 is simpler than a tuple, and the dashboard renders whatever it receives — a hand-edited 4th degrades to smaller gauges rather than crashing.

### New files

- `src/utils/focusLayout.ts` — pure logic. `resolveFocusGauges(focusPids, supportedMode01Pids, discoveryDone): PidDef[]` maps stored ids to registry defs, drops unsupported and unknown ones, preserves the user's chosen order. Same pure-core pattern as `bodySweepCore` and `pollScheduler`.
- `src/components/FocusView.tsx` — flex column, no `ScrollView`. Each gauge `flex: 1`, so 2 gauges take half the screen and 3 take a third. **Overflow is structurally impossible**, which is the guarantee users are asking for.

### Changed files

- `GaugeCard` — optional `scale?: number` (default 1) multiplying the value, unit, and title font sizes plus bar height. Normal dashboard unaffected.
- `DashboardScreen` — early branch: `if (focusActive && focusGauges.length > 0) return <FocusView … />`. Everything below is untouched.
- `SettingsScreen` — `FOCUS GAUGES (up to 3)` section at the top of the Gauges tab, reusing the existing `switchRow` pattern. At 3 selected, remaining switches disable with a hint.
- `App.tsx` — passes `focusPids` / `focusActive` down alongside `units` and `enabledPids`.

### Entry and exit

**Entry:** icon button in a status bar rather than the action row. The action row already holds three `flex: 1` buttons; a fourth squeezes every label. The status bar already hosts an `iconBtn`, so this costs nothing structurally.

Hidden whenever no picked gauge can actually render — keyed off the *resolved* list, not the raw `focusPids`. Those differ when every pick is currently disabled, and keying off the raw list produced a button that visibly did nothing. No route to an empty screen.

**Exit:** a full-width ~36px bottom strip, `▼ EXIT FOCUS`. Large target that can be hit without aiming, and unlike tap-anywhere it can't fire from a stray thumb on a bump.

### Disconnect strip

With the BLE pill gone, a dropped adapter would show only as `--` values, and `computeAlert` does not currently fire on disconnect — so the banner won't catch it either. A thin red strip renders **only** when `bleConnected` is false. Zero cost when the adapter is working.

## Failure Modes

- **Focused PID unsupported by this ECU** — filtered out by `resolveFocusGauges`, same rule the dashboard already applies to fuel trims. Prevents a permanent `--` occupying a third of the screen.
- **Stale PID id in `focusPids`** (PID removed from the registry) — ignored, not crashed on.
- **All focus gauges filtered out** — falls back to the normal dashboard. Never a blank screen; a blank screen would read as a hard crash.
- **Trans temp path unresolved** — renders `--`, which is correct: the path may resolve mid-drive.
- **Adapter disconnects** — disconnect strip, per above.

## Testing

Unit tests (Jest) for `focusLayout.ts`:

- unsupported PID dropped after discovery completes
- unknown/stale id ignored
- empty result signals fallback to the normal dashboard
- user-chosen order preserved
- 3-cap holds; a 4th degrades gracefully rather than throwing

`FocusView` stays thin so the logic lives in the tested pure module — same split as `TripMap` / `routeGeometry`.

Not unit-testable, needs the device:

- whether 2.4× is the right multiplier
- how `SEGMENT_COUNT = 14` in `SegmentBar` reads at 2–3× width; segments may look chunky and need the count scaled too

Build with a placeholder scale and tune on the phone.

## Build Impact

None. No new dependencies, no native modules, no permissions, no `app.json` changes. Pure JS/TS — ships over Metro to the existing dev client, no Mac rebuild needed to develop it.

## Out of scope for v1

- Saved layout presets ("Towing", "City") — revisit if users ask to switch between more than one focus set
- Per-gauge individual sizing (2×1, 2×2 tiles) — the flex split covers the stated need
- Making speed/RPM/elevation toggleable in the *normal* dashboard — focus mode addresses the request without touching the default layout
- Landscape layout

## Links

- Vault: `[[Screens Overview]]`, `[[Display Units]]`, `[[PID Index]]`
