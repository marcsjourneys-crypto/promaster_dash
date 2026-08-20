import { formatGaugeValue, gaugeCardProps } from '../gaugeFormat';
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

// ---- gaugeCardProps ----
//
// warn/crit MUST convert in lockstep with value/min/max. If they ever diverge,
// a critical oil pressure or trans temp renders as healthy.

const oil = getPidDef('oilPressurePsi')!;

describe('gaugeCardProps', () => {
  it('converts warn and crit alongside min and max for a temperature gauge', () => {
    const p = gaugeCardProps(trans, 212, MET);
    expect(p.min).toBeCloseTo(60, 5);      // 140°F
    expect(p.max).toBeCloseTo(137.778, 3); // 280°F
    expect(p.warn).toBeCloseTo(104.444, 3); // 220°F
    expect(p.crit).toBeCloseTo(118.333, 3); // 245°F
    expect(p.rawValue).toBeCloseTo(100, 5);
    expect(p.value).toBe('100');
    expect(p.unit).toBe('°C');
    expect(p.title).toBe('TRANS TEMP');
    expect(p.mode).toBe('temp');
  });

  it('leaves warn, crit, min and max alone for a gauge whose unit never converts', () => {
    const p = gaugeCardProps(oil, 32, MET);
    expect(p.min).toBe(0);
    expect(p.max).toBe(100);
    expect(p.warn).toBe(25);
    expect(p.crit).toBe(7);
    expect(p.rawValue).toBe(32);
    expect(p.value).toBe('32');
    expect(p.unit).toBe('PSI');
  });

  it('reports missing data as the placeholder with a null rawValue', () => {
    const p = gaugeCardProps(trans, null, IMP);
    expect(p.value).toBe('--');
    expect(p.rawValue).toBeNull();
    // Thresholds still resolve, so the bar keeps its zones
    expect(p.warn).toBe(220);
    expect(p.crit).toBe(245);
  });

  it('does not set scale — focus mode owns that', () => {
    expect('scale' in gaugeCardProps(trans, 200, IMP)).toBe(false);
  });
});
