import type { TpmsReading } from '../../services/tpmsProtocol';
import { LEARN_TIMEOUT_MS, evaluateLearn, startLearn } from '../tpmsLearn';

const T0 = 5_000_000;

function r(id: string, psi: number, ts: number, cached = false): TpmsReading {
  return { id, psi, ts, cached, kPa: 0, tempF: 70, tempC: 21, flags: 7, known: true };
}

const BEFORE = {
  A: r('A', 65, T0 - 60_000),
  B: r('B', 65, T0 - 60_000),
  C: r('C', 68, T0 - 60_000),
};

it('proposes the sensor whose pressure dropped', () => {
  let s = startLearn('LR', BEFORE, T0);
  expect(s.baselines).toEqual({ A: 65, B: 65, C: 68 });

  s = evaluateLearn(s, { ...BEFORE, C: r('C', 64.5, T0 + 20_000) }, T0 + 20_000);
  expect(s.phase).toBe('proposed');
  expect(s.proposedId).toBe('C');
  expect(s.dropPsi).toBeCloseTo(3.5);
});

it('ignores drift under the threshold', () => {
  let s = startLearn('LF', BEFORE, T0);
  s = evaluateLearn(s, { ...BEFORE, A: r('A', 63.6, T0 + 5_000) }, T0 + 5_000);
  expect(s.phase).toBe('waiting');
});

it('ignores cache replays and readings from before the start', () => {
  let s = startLearn('LF', BEFORE, T0);
  s = evaluateLearn(s, { ...BEFORE, A: r('A', 50, T0 + 5_000, true) }, T0 + 5_000);
  expect(s.phase).toBe('waiting');
  s = evaluateLearn(s, { ...BEFORE, A: r('A', 50, T0 - 1) }, T0 + 5_000);
  expect(s.phase).toBe('waiting');
});

it('a sensor first heard after the start becomes its own baseline', () => {
  let s = startLearn('RF', {}, T0);
  s = evaluateLearn(s, { A: r('A', 65, T0 + 1_000) }, T0 + 1_000);
  expect(s.phase).toBe('waiting');
  expect(s.baselines.A).toBe(65);
  s = evaluateLearn(s, { A: r('A', 61, T0 + 9_000) }, T0 + 9_000);
  expect(s.proposedId).toBe('A');
});

it('picks the biggest drop when two sensors fall', () => {
  let s = startLearn('RR', BEFORE, T0);
  s = evaluateLearn(
    s,
    { A: r('A', 62.5, T0 + 3_000), B: r('B', 59, T0 + 3_000), C: BEFORE.C },
    T0 + 3_000,
  );
  expect(s.proposedId).toBe('B');
});

it('times out and then stays put', () => {
  let s = startLearn('LF', BEFORE, T0);
  s = evaluateLearn(s, BEFORE, T0 + LEARN_TIMEOUT_MS + 1);
  expect(s.phase).toBe('timeout');
  const again = evaluateLearn(s, { A: r('A', 40, T0 + LEARN_TIMEOUT_MS + 2) }, T0 + LEARN_TIMEOUT_MS + 2);
  expect(again).toBe(s);
});

it('returns the same object when nothing changed', () => {
  const s = startLearn('LF', BEFORE, T0);
  expect(evaluateLearn(s, BEFORE, T0 + 1_000)).toBe(s);
});
