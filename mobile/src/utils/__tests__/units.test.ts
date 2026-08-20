/** Unit conversion + display formatting. */

import {
  convertTemp,
  convertSpeed,
  convertDistance,
  convertElevation,
  makeUnits,
} from '../units';

describe('raw conversions', () => {
  it('converts Fahrenheit to Celsius', () => {
    expect(convertTemp(32, 'C')).toBeCloseTo(0, 5);
    expect(convertTemp(212, 'C')).toBeCloseTo(100, 5);
    expect(convertTemp(-40, 'C')).toBeCloseTo(-40, 5);
  });

  it('passes Fahrenheit through unchanged', () => {
    expect(convertTemp(225, 'F')).toBe(225);
  });

  it('converts mph to kph', () => {
    expect(convertSpeed(60, 'kph')).toBeCloseTo(96.5606, 3);
    expect(convertSpeed(60, 'mph')).toBe(60);
  });

  it('converts miles to kilometres', () => {
    expect(convertDistance(1, 'kph')).toBeCloseTo(1.609344, 5);
    expect(convertDistance(1, 'mph')).toBe(1);
  });

  it('converts feet to metres', () => {
    expect(convertElevation(1000, 'kph')).toBeCloseTo(304.8, 3);
    expect(convertElevation(1000, 'mph')).toBe(1000);
  });
});

describe('makeUnits — imperial', () => {
  const u = makeUnits({ tempUnit: 'F', speedUnit: 'mph' });

  it('exposes imperial labels', () => {
    expect(u.tempLabel).toBe('°F');
    expect(u.speedLabel).toBe('MPH');
    expect(u.distanceLabel).toBe('mi');
    expect(u.elevationLabel).toBe('FT');
  });

  it('formats values unchanged', () => {
    expect(u.temp(225)).toBe('225');
    expect(u.speed(65)).toBe('65');
    expect(u.distance(12.34)).toBe('12.3');
    expect(u.elevation(5280)).toBe('5280');
  });
});

describe('makeUnits — metric', () => {
  const u = makeUnits({ tempUnit: 'C', speedUnit: 'kph' });

  it('exposes metric labels', () => {
    expect(u.tempLabel).toBe('°C');
    expect(u.speedLabel).toBe('KPH');
    expect(u.distanceLabel).toBe('km');
    expect(u.elevationLabel).toBe('M');
  });

  it('converts before formatting', () => {
    expect(u.temp(212)).toBe('100');
    expect(u.speed(60)).toBe('97');
    expect(u.distance(10)).toBe('16.1');
    expect(u.elevation(1000)).toBe('305');
  });
});

describe('makeUnits — null handling', () => {
  const u = makeUnits({ tempUnit: 'C', speedUnit: 'kph' });

  it('renders the placeholder for missing data', () => {
    expect(u.temp(null)).toBe('--');
    expect(u.speed(null)).toBe('--');
    expect(u.distance(null)).toBe('--');
    expect(u.elevation(null)).toBe('--');
  });
});

describe('gauge helpers', () => {
  const metric = makeUnits({ tempUnit: 'C', speedUnit: 'kph' });
  const imperial = makeUnits({ tempUnit: 'F', speedUnit: 'mph' });

  it('relabels only temperature gauges', () => {
    expect(metric.gaugeUnit('°F')).toBe('°C');
    expect(metric.gaugeUnit('PSI')).toBe('PSI');
    expect(metric.gaugeUnit('V')).toBe('V');
    expect(metric.gaugeUnit('%')).toBe('%');
    expect(imperial.gaugeUnit('°F')).toBe('°F');
  });

  it('converts only temperature gauge values and thresholds', () => {
    expect(metric.gaugeValue('°F', 212)).toBeCloseTo(100, 5);
    expect(metric.gaugeValue('PSI', 40)).toBe(40);
    expect(metric.gaugeValue('V', 14.2)).toBe(14.2);
    expect(metric.gaugeValue('°F', null)).toBeNull();
    expect(imperial.gaugeValue('°F', 212)).toBe(212);
  });

  it('keeps the segment bar proportional after conversion', () => {
    // 140-280°F range, value 210 sits at 50%
    const min = metric.gaugeValue('°F', 140)!;
    const max = metric.gaugeValue('°F', 280)!;
    const val = metric.gaugeValue('°F', 210)!;
    expect((val - min) / (max - min)).toBeCloseTo(0.5, 6);
  });
});
