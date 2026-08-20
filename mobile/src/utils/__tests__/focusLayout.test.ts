/** Which gauges focus mode actually renders. */

import { resolveFocusGauges, MAX_FOCUS_GAUGES } from '../focusLayout';
import { getPidDef, isFuelTrimSupported } from '../../config/pidRegistry';

const NO_DISCOVERY = { supported: new Set<string>(), done: false };

/** Every id the tests reference, so enablement never masks the case under test. */
const ALL_ENABLED = [
  'transF',
  'coolantF',
  'voltageV',
  'oilPressurePsi',
  'stftBank1Pct',
  'ltftBank1Pct',
];

describe('resolveFocusGauges', () => {
  it('maps ids to registry defs in the user-chosen order', () => {
    const r = resolveFocusGauges(['coolantF', 'transF'], NO_DISCOVERY, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['coolantF', 'transF']);
  });

  it('ignores ids that are not in the registry', () => {
    const r = resolveFocusGauges(['transF', 'nopeNotReal'], NO_DISCOVERY, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['transF']);
  });

  it('returns empty for an empty selection', () => {
    expect(resolveFocusGauges([], NO_DISCOVERY, ALL_ENABLED)).toEqual([]);
  });

  it('drops fuel-trim gauges the ECU reported as unsupported', () => {
    const done = { supported: new Set(['06']), done: true };
    // stftBank1Pct is PID 06 (supported); ltftBank1Pct is 07 (not)
    const r = resolveFocusGauges(['stftBank1Pct', 'ltftBank1Pct'], done, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['stftBank1Pct']);
  });

  it('keeps fuel-trim gauges before discovery completes', () => {
    const r = resolveFocusGauges(['ltftBank1Pct'], NO_DISCOVERY, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['ltftBank1Pct']);
  });

  it('keeps non-fuel-trim gauges regardless of discovery', () => {
    const done = { supported: new Set<string>(), done: true };
    const r = resolveFocusGauges(['transF', 'oilPressurePsi'], done, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['transF', 'oilPressurePsi']);
  });

  it('does not cap — a hand-edited 4th degrades to smaller gauges, not a crash', () => {
    const four = ['transF', 'coolantF', 'voltageV', 'oilPressurePsi'];
    expect(resolveFocusGauges(four, NO_DISCOVERY, ALL_ENABLED)).toHaveLength(4);
  });

  // ---- enabled-subset rule ----

  it('drops a focused gauge that is not enabled — it is never polled, so it would freeze', () => {
    const r = resolveFocusGauges(['transF', 'coolantF'], NO_DISCOVERY, ['transF']);
    expect(r.map((p) => p.id)).toEqual(['transF']);
  });

  it('returns empty when every focused gauge is disabled, so the caller falls back', () => {
    const r = resolveFocusGauges(['transF', 'coolantF'], NO_DISCOVERY, ['voltageV']);
    expect(r).toEqual([]);
  });

  // ---- hygiene ----

  it('collapses duplicate ids to a single gauge', () => {
    const r = resolveFocusGauges(['transF', 'transF'], NO_DISCOVERY, ALL_ENABLED);
    expect(r.map((p) => p.id)).toEqual(['transF']);
  });

  it('returns empty for a corrupted non-array focusPids instead of throwing', () => {
    const bad = null as unknown as string[];
    expect(resolveFocusGauges(bad, NO_DISCOVERY, ALL_ENABLED)).toEqual([]);
  });

  it('returns empty for a corrupted non-array enabledPids instead of throwing', () => {
    const bad = undefined as unknown as string[];
    expect(resolveFocusGauges(['transF'], NO_DISCOVERY, bad)).toEqual([]);
  });
});

describe('isFuelTrimSupported', () => {
  it('is true for gauges that are not fuel trims', () => {
    const transF = getPidDef('transF')!;
    const done = { supported: new Set<string>(), done: true };
    expect(isFuelTrimSupported(transF, done)).toBe(true);
  });

  it('is true for a fuel trim before discovery completes', () => {
    const ltft = getPidDef('ltftBank1Pct')!;
    expect(isFuelTrimSupported(ltft, NO_DISCOVERY)).toBe(true);
  });

  it('is false for a fuel trim the ECU denied after discovery', () => {
    const ltft = getPidDef('ltftBank1Pct')!;
    const done = { supported: new Set(['06']), done: true };
    expect(isFuelTrimSupported(ltft, done)).toBe(false);
  });
});

it('still exports the UI cap for the settings screen', () => {
  expect(typeof MAX_FOCUS_GAUGES).toBe('number');
});
