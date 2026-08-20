/**
 * Diagnostics must default to OFF. This is the guard that keeps in-vehicle
 * sweep tooling out of TestFlight and App Store builds.
 */

describe('DIAGNOSTICS_ENABLED', () => {
  const original = process.env.EXPO_PUBLIC_DIAGNOSTICS;

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
    else process.env.EXPO_PUBLIC_DIAGNOSTICS = original;
    jest.resetModules();
  });

  function load() {
    let value: boolean | undefined;
    jest.isolateModules(() => {
      value = require('../diagnostics').DIAGNOSTICS_ENABLED;
    });
    return value;
  }

  it('is off when the build sets nothing', () => {
    delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
    expect(load()).toBe(false);
  });

  it('is on only for the exact opt-in value', () => {
    process.env.EXPO_PUBLIC_DIAGNOSTICS = '1';
    expect(load()).toBe(true);
  });

  it('is off for near-miss values', () => {
    for (const v of ['0', '', 'true', 'yes', 'false']) {
      process.env.EXPO_PUBLIC_DIAGNOSTICS = v;
      expect(load()).toBe(false);
    }
  });
});
