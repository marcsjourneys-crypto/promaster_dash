import { formatGaugeValue } from '../gaugeFormat';
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
