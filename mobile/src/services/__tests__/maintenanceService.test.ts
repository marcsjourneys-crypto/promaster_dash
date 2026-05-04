import { getServiceStatus } from '../maintenanceService';

describe('getServiceStatus', () => {
  const today = '2026-05-03';

  it('returns UNKNOWN when no last date', () => {
    expect(getServiceStatus(null, 12, today)).toBe('UNKNOWN');
  });

  it('returns OK when due in > 30 days', () => {
    // 2025-07-01 + 12mo = 2026-07-01 → 59 days from 2026-05-03 → OK
    expect(getServiceStatus('2025-07-01', 12, today)).toBe('OK');
  });

  it('returns UPCOMING when due in 15-30 days', () => {
    // 2025-05-23 + 12mo = 2026-05-23 → 20 days from 2026-05-03 → UPCOMING
    expect(getServiceStatus('2025-05-23', 12, today)).toBe('UPCOMING');
  });

  it('returns DUE SOON when due in 0-14 days', () => {
    // 2025-05-10 + 12mo = 2026-05-10 → 7 days from 2026-05-03 → DUE SOON
    expect(getServiceStatus('2025-05-10', 12, today)).toBe('DUE SOON');
  });

  it('returns OVERDUE when past due', () => {
    expect(getServiceStatus('2024-01-01', 12, today)).toBe('OVERDUE');
  });
});
