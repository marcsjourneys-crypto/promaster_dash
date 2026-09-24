/** Tire alerts: fed by the TPMS receiver, judged against per-axle targets. */

import { useVehicleStore } from '../vehicleStore';
import { DEFAULT_TPMS_CONFIG, assignPosition, type TpmsConfig } from '../../config/tpmsConfig';
import type { TpmsReading } from '../../services/tpmsProtocol';

const MAPPED: TpmsConfig = assignPosition(
  assignPosition({ ...DEFAULT_TPMS_CONFIG, frontTargetPsi: 65, rearTargetPsi: 80 }, '05E671A', 'LF'),
  '00FA4D3',
  'LR',
);

function reading(id: string, psi: number, over: Partial<TpmsReading> = {}): TpmsReading {
  return { id, psi, kPa: psi / 0.1450377, tempF: 75, tempC: 24, flags: 7, known: true, cached: false, ts: Date.now(), ...over };
}

beforeEach(() => {
  useVehicleStore.setState({
    transF: null,
    coolantF: null,
    oilTempF: null,
    intakeAirF: null,
    voltageV: null,
    oilPressurePsi: null,
    rpm: null,
    dtcCount: 0,
    activeDtcs: [],
    alertMessage: null,
    alertPriority: 'none',
    alertHistory: [],
    tempUnit: 'F',
    pressureUnit: 'psi',
    tpmsReadings: {},
    tpmsConfig: MAPPED,
  });
});

const state = () => useVehicleStore.getState();

it('stays silent for tires at pressure', () => {
  state().updateTpms(reading('05E671A', 65));
  state().updateTpms(reading('00FA4D3', 80));
  expect(state().alertPriority).toBe('none');
});

it('warns on a soft tire and names the wheel', () => {
  state().updateTpms(reading('00FA4D3', 70)); // 12.5% under the 80 psi rear target
  expect(state().alertPriority).toBe('warning');
  expect(state().alertMessage).toBe('Tire low: Left Rear 70 PSI');
});

it('goes critical at 25% under target, ahead of other warnings', () => {
  useVehicleStore.setState({ transF: 225 }); // a trans warning is already live
  state().updateTpms(reading('05E671A', 48));
  expect(state().alertPriority).toBe('critical');
  expect(state().alertMessage).toBe('TIRE LOW: LEFT FRONT 48 PSI');
});

it('formats the alert in the chosen pressure unit', () => {
  state().setPressureUnit('kPa');
  state().updateTpms(reading('00FA4D3', 70));
  expect(state().alertMessage).toBe('Tire low: Left Rear 483 kPa');
});

it('warns on high pressure and on a hot tire', () => {
  state().updateTpms(reading('05E671A', 80)); // > 20% over 65
  expect(state().alertMessage).toBe('Tire pressure high: Left Front 80 PSI');

  state().updateTpms(reading('05E671A', 65, { tempF: 180 }));
  expect(state().alertMessage).toBe('Tire hot: Left Front 180°F');
});

it('never alerts for a sensor that is not on a wheel', () => {
  state().updateTpms(reading('00FBFF7', 20));
  expect(state().alertPriority).toBe('none');
});

it('a cache replay never overwrites a newer reading', () => {
  const now = Date.now();
  state().updateTpms(reading('05E671A', 64, { ts: now }));
  state().updateTpms(reading('05E671A', 40, { ts: now - 60_000, cached: true }));
  expect(state().tpmsReadings['05E671A'].psi).toBe(64);
  expect(state().alertPriority).toBe('none');
});

it('re-evaluates when the config changes', () => {
  state().updateTpms(reading('00FA4D3', 70));
  expect(state().alertPriority).toBe('warning');
  state().setTpmsConfig({ ...MAPPED, rearTargetPsi: 70 });
  expect(state().alertPriority).toBe('none');
});
