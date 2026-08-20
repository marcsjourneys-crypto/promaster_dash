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
