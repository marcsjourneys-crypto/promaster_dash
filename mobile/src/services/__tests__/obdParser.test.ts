import { bytesToFuelTrimPct, transTempToF, signedCelsiusToF } from '../obdParser';

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

describe('transTempToF two-byte ÷64 (62TE B010/9110 and 948TE div64 candidates)', () => {
  it('0x2D 0x00 → 180.0°F', () => {
    expect(transTempToF([0x2d, 0x00], true)).toBeCloseTo(180.0);
  });
});

describe('signedCelsiusToF (948TE DID 1C44)', () => {
  it('0x50 = 80°C → 176°F', () => {
    expect(signedCelsiusToF([0x50])).toBeCloseTo(176.0);
  });
  it('0xF6 = −10°C → 14°F', () => {
    expect(signedCelsiusToF([0xf6])).toBeCloseTo(14.0);
  });
});
