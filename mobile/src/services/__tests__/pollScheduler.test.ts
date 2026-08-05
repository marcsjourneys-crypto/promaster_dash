import { selectDuePoll, batchIdsForHeader, type ScheduleEntry } from '../pollScheduler';

describe('selectDuePoll', () => {
  const schedule: ScheduleEntry[] = [
    { id: 'rpm', intervalMs: 2000 },
    { id: 'speed', intervalMs: 1000 },
    { id: 'transF', intervalMs: 1500 },
    { id: 'coolantF', intervalMs: 1500 },
    { id: 'oilPressurePsi', intervalMs: 1000 },
    { id: 'stftBank1Pct', intervalMs: 3000 },
  ];

  it('returns null when nothing is due', () => {
    const nextDue = Object.fromEntries(schedule.map((e) => [e.id, 2000]));
    expect(selectDuePoll(schedule, nextDue, 1000)).toBeNull();
  });

  it('breaks ties by schedule order when entries became due at the same time', () => {
    const nextDue = Object.fromEntries(schedule.map((e) => [e.id, 500]));
    expect(selectDuePoll(schedule, nextDue, 1000)).toBe('rpm');
  });

  it('picks the most-overdue entry, not the first due entry in schedule order', () => {
    const nextDue = Object.fromEntries(schedule.map((e) => [e.id, 900]));
    // Fuel trim has been waiting since t=100; rpm only since t=900.
    nextDue.stftBank1Pct = 100;
    expect(selectDuePoll(schedule, nextDue, 1000)).toBe('stftBank1Pct');
  });

  it('treats an entry missing from nextDue as due now', () => {
    const nextDue: Record<string, number> = { rpm: 5000 };
    expect(selectDuePoll(schedule, nextDue, 1000)).toBe('speed');
  });

  it('services every entry under saturation (starvation regression)', () => {
    // Simulate a saturated bus: every poll takes 400ms, so short-interval
    // entries are due again almost immediately. The old first-due-in-order
    // policy never reached the fuel trim entry in this regime.
    const POLL_MS = 400;
    let now = 0;
    const nextDue: Record<string, number> = {};
    for (const e of schedule) nextDue[e.id] = now;

    const polledCounts: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      const id = selectDuePoll(schedule, nextDue, now);
      if (id === null) {
        now += 30;
        continue;
      }
      polledCounts[id] = (polledCounts[id] ?? 0) + 1;
      now += POLL_MS;
      const entry = schedule.find((e) => e.id === id)!;
      nextDue[id] = now + entry.intervalMs;
    }

    for (const e of schedule) {
      expect(polledCounts[e.id]).toBeGreaterThan(0);
    }
    // Long-interval entries still run near their configured rate: 40s of bus
    // time / 3s interval => at least ~10 fuel trim polls.
    expect(polledCounts.stftBank1Pct).toBeGreaterThanOrEqual(10);
  });
});

describe('batchIdsForHeader', () => {
  const headers = {
    oilPressurePsi: '18DA10F1',
    oilTempF: '18DA10F1',
    someOtherEcu: 'DA18F1',
  };

  it('puts the primary id first and appends enabled ids sharing its header', () => {
    expect(batchIdsForHeader('oilPressurePsi', headers, () => true)).toEqual([
      'oilPressurePsi',
      'oilTempF',
    ]);
  });

  it('excludes same-header ids that are not enabled', () => {
    const enabled = (id: string) => id === 'oilPressurePsi';
    expect(batchIdsForHeader('oilPressurePsi', headers, enabled)).toEqual(['oilPressurePsi']);
  });

  it('includes the primary even when not in the enabled set', () => {
    expect(batchIdsForHeader('oilTempF', headers, () => false)).toEqual(['oilTempF']);
  });

  it('never batches across different headers', () => {
    expect(batchIdsForHeader('someOtherEcu', headers, () => true)).toEqual(['someOtherEcu']);
  });
});
