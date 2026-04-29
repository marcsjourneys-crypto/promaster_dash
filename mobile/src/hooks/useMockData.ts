/** Mock data generator for development — replaces Python mock_tick(). */

import { useEffect, useRef } from 'react';
import { useVehicleStore } from '../store/vehicleStore';
import type { GPSData } from '../models/types';

/** Simulate realistic driving data at ~1Hz. */
export function useMockData(enabled: boolean) {
  const updateGPS = useVehicleStore((s) => s.updateGPS);
  const updateOBD = useVehicleStore((s) => s.updateOBD);
  const updateDTCs = useVehicleStore((s) => s.updateDTCs);

  const lat = useRef(40.7128);
  const lon = useRef(-74.006);
  const heading = useRef(45);
  const elevation = useRef(150);
  const speed = useRef(35);

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      // Drift position
      const speedMps = speed.current * 0.44704;
      const headingRad = (heading.current * Math.PI) / 180;
      lat.current += (speedMps * Math.cos(headingRad)) / 111320;
      lon.current +=
        (speedMps * Math.sin(headingRad)) /
        (111320 * Math.cos((lat.current * Math.PI) / 180));

      // Vary heading gently
      heading.current = (heading.current + (Math.random() - 0.5) * 8 + 360) % 360;

      // Vary speed (25-65 mph)
      speed.current = Math.max(0, Math.min(75, speed.current + (Math.random() - 0.48) * 5));

      // Vary elevation
      elevation.current = Math.max(
        0,
        elevation.current + (Math.random() - 0.5) * 10,
      );

      const grade = (Math.random() - 0.5) * 6;

      const gps: GPSData = {
        lat: lat.current,
        lon: lon.current,
        speedMph: Math.round(speed.current),
        headingDeg: Math.round(heading.current),
        elevationFt: Math.round(elevation.current),
        fixOk: true,
        gradePct: Math.round(grade * 10) / 10,
        timestamp: Date.now(),
      };
      updateGPS(gps);

      // Mock OBD data
      const mockRpm = Math.round(700 + Math.random() * 2500);
      updateOBD({
        transF: 170 + Math.random() * 95,
        coolantF: 185 + Math.random() * 57,
        voltageV: Math.round((11.3 + Math.random() * 3.4) * 10) / 10,
        rpm: mockRpm,
        obdSpeedMph: speed.current + (Math.random() - 0.5) * 3,
        oilPressurePsi: 15 + (mockRpm / 3500) * 75 + (Math.random() - 0.5) * 8,
        oilTempF: 180 + Math.random() * 50,
        engineLoadPct: 20 + Math.random() * 60,
        intakeMapKpa: 30 + Math.random() * 70,
        timingAdvDeg: 5 + Math.random() * 25,
        intakeAirF: 70 + Math.random() * 60,
        mafGps: 5 + Math.random() * 80,
        throttlePct: Math.random() * 80,
        fuelLevelPct: 30 + Math.random() * 50,
        ambientAirF: 65 + Math.random() * 30,
        accelPedalPct: Math.random() * 80,
      });

      // Occasionally simulate a DTC
      if (Math.random() < 0.05) {
        const codes = ['P0300', 'P0301', 'P0128', 'P0217', 'P0711', 'P1C4F'];
        updateDTCs([codes[Math.floor(Math.random() * codes.length)]]);
      } else {
        updateDTCs([]);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [enabled, updateGPS, updateOBD, updateDTCs]);
}
