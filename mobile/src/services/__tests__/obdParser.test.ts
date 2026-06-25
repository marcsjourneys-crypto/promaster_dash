import { bytesToFuelTrimPct } from '../obdParser';

describe('bytesToFuelTrimPct', () => {
  it('0x80 (128) → 0.0%', () => {
    expect(bytesToFuelTrimPct([0x80])).toBeCloseTo(0.0);
  });
  it('0x00 (0) → -100.0%', () => {
    expect(bytesToFuelTrimPct([0x00])).toBeCloseTo(-100.0);
  });
  it('0xFF (255) → +99.2%', () => {
    expect(bytesToFuelTrimPct([0xff])).toBeCloseTo(99.21875, 3);
  });
  it('0x86 (134) → +4.7%', () => {
    expect(bytesToFuelTrimPct([0x86])).toBeCloseTo(4.6875, 3);
  });
});
