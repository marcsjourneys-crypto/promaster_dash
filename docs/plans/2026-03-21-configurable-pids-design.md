# Configurable PIDs — Design Document

**Date:** 2026-03-21
**Status:** Approved

## Summary

Add 11 new OBD-II PIDs to the ProMaster dashboard app. Users toggle which PIDs are active in a new GAUGES settings tab. The dashboard dynamically renders enabled gauges in a 2-column flex-wrap grid using the existing segment bar style.

## New PIDs

### Standard Mode 01 (header 7DF, no ATSH needed)

| PID    | Name              | Formula              | Unit | Default |
|--------|-------------------|----------------------|------|---------|
| `0104` | Engine Load       | `A * 100 / 255`     | %    | off     |
| `010B` | Intake MAP        | `A`                  | kPa  | off     |
| `010E` | Timing Advance    | `A / 2 - 64`        | deg  | off     |
| `010F` | Intake Air Temp   | `A - 40` C -> F     | F    | off     |
| `0110` | MAF Flow Rate     | `(A*256+B) / 100`   | g/s  | off     |
| `0111` | Throttle Position | `A * 100 / 255`     | %    | off     |
| `012F` | Fuel Tank Level   | `A * 100 / 255`     | %    | off     |
| `0146` | Ambient Air Temp  | `A - 40` C -> F     | F    | off     |
| `0149` | Accel Pedal Pos   | `A * 100 / 255`     | %    | off     |

### Manufacturer Mode 22 (require ATSH header switch)

| DID      | Name         | Header       | Formula            | Unit | Default |
|----------|--------------|--------------|--------------------|------|---------|
| `022A`   | Oil Pressure | `18DA10F1`   | `A * 29 / 50`     | PSI  | off     |
| `0121`   | Oil Temp     | `7E0`        | `(A - 64) * 1.8 + 32` | F | off  |

### Existing PIDs (always in toggle list)

| PID/DID  | Name        | Default |
|----------|-------------|---------|
| trans    | Trans Temp  | on      |
| `0105`   | Coolant     | on      |
| voltage  | Voltage     | on      |

RPM and Speed are always polled (not toggleable) — RPM shows as a chip on the speed hero, speed is the main display.

## Settings Changes

### New GAUGES tab (5th tab)

- List of all PIDs with toggle switches
- Each row shows: PID name, unit, on/off toggle
- Grouped: "Engine", "Temperatures", "Drivetrain", "Informational"
- Enabled state persisted in AsyncStorage as `enabledPids: string[]`

### Threshold configuration

Only PIDs with meaningful warn/crit values get threshold steppers:

| PID           | Warn     | Crit     | Direction |
|---------------|----------|----------|-----------|
| Trans Temp    | 230 F    | 250 F    | high      |
| Coolant       | 220 F    | 235 F    | high      |
| Voltage       | 11.5 / 15 V | -    | range     |
| Oil Pressure  | < 20 PSI | < 10 PSI | low       |
| Oil Temp      | 250 F    | 270 F    | high      |
| Intake Air    | 160 F    | 180 F    | high      |

Others (load, throttle, MAP, MAF, fuel level, ambient, accel pedal) are display-only with no thresholds.

### THRESHOLDS tab update

Thresholds tab dynamically shows only the enabled PIDs that have warn/crit values. If oil pressure is disabled, its thresholds don't appear.

## Dashboard Layout

- Speed hero section: fixed at top (always visible, not configurable)
- Below speed hero: scrollable flex-wrap container
- Gauge cards: 2 per row (half-width), last card stretches full-width if odd count
- Fixed display order (not user-reorderable):
  1. Trans Temp
  2. Coolant
  3. Oil Pressure
  4. Oil Temp
  5. Voltage
  6. Engine Load
  7. Intake Air Temp
  8. Ambient Air Temp
  9. Throttle Position
  10. Accel Pedal Pos
  11. Intake MAP
  12. MAF Flow Rate
  13. Timing Advance
  14. Fuel Tank Level
- Only enabled PIDs render cards

## Polling Changes

### Priority queue update

Current priority: RPM > Speed > Coolant > Trans > Voltage > DTCs

New priority (only enabled PIDs are queued):
1. RPM (always)
2. Speed (always)
3. Coolant (if enabled)
4. Trans Temp (if enabled + candidate found)
5. Oil Pressure (if enabled) — Mode 22
6. Oil Temp (if enabled) — Mode 22
7. Voltage (if enabled)
8. Engine Load (if enabled)
9. Intake Air Temp (if enabled)
10. Throttle Position (if enabled)
11. Accel Pedal Pos (if enabled)
12. Intake MAP (if enabled)
13. MAF Flow Rate (if enabled)
14. Ambient Air Temp (if enabled)
15. Fuel Tank Level (if enabled)
16. Timing Advance (if enabled)
17. DTCs (always, 15s interval)

### Interval assignments

- Fast (500ms): RPM
- Medium-fast (1s): Speed, Oil Pressure
- Medium (1.5s): Coolant, Trans Temp, Oil Temp
- Slow (3s): Voltage, Engine Load, Throttle, Accel Pedal
- Very slow (5s): Intake Air, Ambient Air, Intake MAP, MAF, Timing Advance, Fuel Tank Level

### Mode 22 header management

Oil Pressure and Oil Temp require ATSH header switches. Group them together in the polling queue to minimize header switching:
1. Switch to `18DA10F1`, poll oil pressure
2. Switch to `7E0`, poll oil temp
3. Switch back to `ATSH7DF` for standard PIDs

Trans temp already does its own header switch/reset.

## Parser Changes

- Add `parseMode22` support for 4-char DIDs (e.g. `022A` -> marker `62022A`)
- Existing `parseMode22` already handles variable DID length via `indexOf`
- Add conversion helpers: `bytesToOilPressurePSI`, `bytesToOilTempF`
- Add Mode 01 conversion helpers for new PIDs (load%, MAP kPa, etc.)

## Store Changes

### New fields in vehicleStore OBD data

```typescript
engineLoadPct: number | null
intakeMapKpa: number | null
timingAdvDeg: number | null
intakeAirF: number | null
mafGps: number | null
throttlePct: number | null
fuelLevelPct: number | null
ambientAirF: number | null
accelPedalPct: number | null
oilPressurePsi: number | null
oilTempF: number | null
```

### Alert system updates

Add alerts for:
- Oil pressure low: warn < 20 PSI, crit < 10 PSI (when RPM > 800, to avoid false alarms at idle)
- Oil temp high: warn 250 F, crit 270 F
- Intake air temp high: warn 160 F, crit 180 F

## Files to Create/Modify

### New files
- `src/config/pidRegistry.ts` — Central PID definition registry (id, name, unit, group, formula, interval, default enabled, warn/crit thresholds, header if Mode 22)

### Modified files
- `src/config/settings.ts` — Add `enabledPids: string[]` to Settings interface and defaults
- `src/store/vehicleStore.ts` — Add new OBD fields, update alert logic
- `src/services/obdService.ts` — Dynamic polling queue based on enabled PIDs, new poll functions, Mode 22 grouping
- `src/services/obdParser.ts` — New conversion helpers
- `src/screens/SettingsScreen.tsx` — Add GAUGES tab
- `src/screens/DashboardScreen.tsx` — Dynamic gauge card rendering from enabled PIDs
- `src/components/GaugeCard.tsx` — Support "low is bad" mode for oil pressure (green at top, red at bottom)
