/** Alert text follows the display temperature unit; thresholds stay in °F. */

import { useVehicleStore } from '../vehicleStore';

function reset() {
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
  });
}

beforeEach(reset);

it('renders alert temperatures in °F by default', () => {
  useVehicleStore.setState({ transF: 250 });
  useVehicleStore.getState().computeAlert();
  expect(useVehicleStore.getState().alertMessage).toBe('TRANS TEMP CRITICAL: 250°F');
});

it('renders alert temperatures in °C when metric is selected', () => {
  useVehicleStore.getState().setTempUnit('C');
  useVehicleStore.setState({ transF: 250 });
  useVehicleStore.getState().computeAlert();
  expect(useVehicleStore.getState().alertMessage).toBe('TRANS TEMP CRITICAL: 121°C');
});

it('fires on the same °F thresholds regardless of display unit', () => {
  // 219°F is below TRANS_WARN (220) — must stay silent in either unit
  useVehicleStore.getState().setTempUnit('C');
  useVehicleStore.setState({ transF: 219 });
  useVehicleStore.getState().computeAlert();
  expect(useVehicleStore.getState().alertPriority).toBe('none');

  useVehicleStore.setState({ transF: 220 });
  useVehicleStore.getState().computeAlert();
  expect(useVehicleStore.getState().alertPriority).toBe('warning');
  expect(useVehicleStore.getState().alertMessage).toBe('Trans temp warning: 104°C');
});

it('leaves non-temperature alerts untouched', () => {
  useVehicleStore.getState().setTempUnit('C');
  useVehicleStore.setState({ voltageV: 11.5 });
  useVehicleStore.getState().computeAlert();
  expect(useVehicleStore.getState().alertMessage).toBe('Battery low: 11.5V');
});
