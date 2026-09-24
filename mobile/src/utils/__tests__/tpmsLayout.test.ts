import {
  DEFAULT_TPMS_CONFIG,
  addSensor,
  assignPosition,
  normalizeTpmsConfig,
  removeSensor,
  sensorAt,
  type TpmsConfig,
} from '../../config/tpmsConfig';
import type { TpmsReading } from '../../services/tpmsProtocol';
import { STALE_MS, formatAge, resolveTires, tireStatus } from '../tpmsLayout';

const NOW = 10_000_000;

function reading(id: string, psi: number, over: Partial<TpmsReading> = {}): TpmsReading {
  return { id, psi, kPa: psi / 0.1450377, tempF: 75, tempC: 24, flags: 7, known: true, cached: false, ts: NOW, ...over };
}

const MAPPED: TpmsConfig = [
  ['05E671A', 'LF'],
  ['05E670D', 'RF'],
  ['00FA4D3', 'LR'],
  ['00FBFF7', 'RR'],
].reduce((c, [id, pos]) => assignPosition(c, id, pos as any), { ...DEFAULT_TPMS_CONFIG, frontTargetPsi: 65, rearTargetPsi: 80 });

describe('config editing', () => {
  it('assigning a taken position unassigns the previous holder', () => {
    const c = assignPosition(MAPPED, '00FBFF7', 'LF');
    expect(sensorAt(c, 'LF')).toBe('00FBFF7');
    expect(sensorAt(c, 'RR')).toBeNull();
    expect(c.sensors.find((s) => s.id === '05E671A')!.position).toBeNull();
  });

  it('assigning an unknown id adds it', () => {
    const c = assignPosition(DEFAULT_TPMS_CONFIG, '1234567', 'RR');
    expect(c.sensors).toHaveLength(5);
    expect(sensorAt(c, 'RR')).toBe('1234567');
  });

  it('add is idempotent and remove drops the sensor', () => {
    expect(addSensor(DEFAULT_TPMS_CONFIG, '05E671A')).toBe(DEFAULT_TPMS_CONFIG);
    expect(removeSensor(MAPPED, '05E671A').sensors).toHaveLength(3);
  });

  it('normalize repairs malformed storage', () => {
    expect(normalizeTpmsConfig(null)).toEqual(DEFAULT_TPMS_CONFIG);
    const c = normalizeTpmsConfig({
      sensors: [{ id: 'A', position: 'LF' }, { id: 'B', position: 'LF' }, { id: 'C', position: 'XX' }, { nope: 1 }],
    });
    expect(c.sensors).toEqual([
      { id: 'A', position: 'LF' },
      { id: 'B', position: null },
      { id: 'C', position: null },
    ]);
    expect(c.frontTargetPsi).toBe(DEFAULT_TPMS_CONFIG.frontTargetPsi);
  });
});

describe('tireStatus', () => {
  const cfg = MAPPED; // warn 10%, crit 25%, high 20%, hot 170°F
  it('classifies against the axle target', () => {
    expect(tireStatus(null, 80, cfg)).toBe('noData');
    expect(tireStatus(reading('x', 80), 80, cfg)).toBe('ok');
    expect(tireStatus(reading('x', 72.1), 80, cfg)).toBe('ok');
    expect(tireStatus(reading('x', 72), 80, cfg)).toBe('lowWarn');
    expect(tireStatus(reading('x', 60), 80, cfg)).toBe('lowCrit');
    expect(tireStatus(reading('x', 96), 80, cfg)).toBe('high');
    expect(tireStatus(reading('x', 80, { tempF: 175 }), 80, cfg)).toBe('hot');
  });

  it('a low tire outranks a hot one', () => {
    expect(tireStatus(reading('x', 55, { tempF: 190 }), 80, cfg)).toBe('lowCrit');
  });
});

describe('resolveTires', () => {
  it('places readings on their wheels with per-axle targets', () => {
    const readings = {
      '05E671A': reading('05E671A', 65),
      '00FA4D3': reading('00FA4D3', 68),
    };
    const { tires, unassigned } = resolveTires(MAPPED, readings, NOW);
    expect(tires.LF.status).toBe('ok');
    expect(tires.LF.targetPsi).toBe(65);
    expect(tires.LR.targetPsi).toBe(80);
    expect(tires.LR.status).toBe('lowWarn'); // 68 is 15% under an 80 psi rear target
    expect(tires.RF.status).toBe('noData');
    expect(unassigned).toEqual([]);
  });

  it('lists readings from sensors without a wheel', () => {
    const readings = { '05E671A': reading('05E671A', 65), '7777777': reading('7777777', 30) };
    const { unassigned } = resolveTires(DEFAULT_TPMS_CONFIG, readings, NOW);
    expect(unassigned.map((r) => r.id)).toEqual(['05E671A', '7777777']);
  });

  it('marks old readings stale but keeps their value and verdict', () => {
    const readings = { '05E671A': reading('05E671A', 40, { ts: NOW - STALE_MS - 1 }) };
    const lf = resolveTires(MAPPED, readings, NOW).tires.LF;
    expect(lf.stale).toBe(true);
    expect(lf.status).toBe('lowCrit');
    expect(lf.reading!.psi).toBe(40);
  });
});

it('formatAge', () => {
  expect(formatAge(null)).toBe('');
  expect(formatAge(2_000)).toBe('now');
  expect(formatAge(45_000)).toBe('45s');
  expect(formatAge(12 * 60_000)).toBe('12m');
  expect(formatAge(3 * 3600_000)).toBe('3h');
  expect(formatAge(2 * 86400_000)).toBe('2d');
});
