"""GPS service using gpsd for location, speed, heading, and elevation."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional, Tuple

from PySide6.QtCore import QObject, Signal, Slot

from promaster_dash.models.data_records import GPSData
from promaster_dash.utils.geo import haversine_meters, meters_to_feet, feet_to_meters, mps_to_mph


@dataclass
class PositionSample:
    """A position sample for grade calculation."""

    lat: float
    lon: float
    elevation_m: float
    timestamp: float


class GPSService(QObject):
    """
    GPS service that polls gpsd at 1 Hz.

    Emits gps_updated signal with GPSData containing:
    - lat, lon, speed_mph, heading_deg, elevation_ft
    - fix_ok (True if valid GPS fix)
    - grade_pct (computed from rolling position history)

    Handles connection failures with automatic retry.
    """

    # Signals
    gps_updated = Signal(object)  # GPSData
    connection_status = Signal(bool, str)  # connected, message

    # Configuration
    POLL_INTERVAL = 1.0  # seconds
    RECONNECT_DELAY = 5.0  # seconds
    POSITION_HISTORY_SIZE = 15  # samples for grade calculation
    MIN_GRADE_DISTANCE_M = 20  # minimum travel for grade calculation
    MAX_GRADE_PCT = 30.0  # clamp grade to +/- this value

    def __init__(self, host: str = "localhost", port: int = 2947):
        super().__init__()
        self._host = host
        self._port = port
        self._running = False
        self._connected = False
        self._gpsd = None
        self._position_history: Deque[PositionSample] = deque(maxlen=self.POSITION_HISTORY_SIZE)

    @Slot()
    def start(self) -> None:
        """Start the GPS polling loop."""
        self._running = True
        self._run_loop()

    @Slot()
    def stop(self) -> None:
        """Stop the GPS polling loop."""
        self._running = False
        self._disconnect()

    def _connect(self) -> bool:
        """Connect to gpsd."""
        try:
            import gps

            self._gpsd = gps.gps(host=self._host, port=self._port, mode=gps.WATCH_ENABLE)
            self._connected = True
            self.connection_status.emit(True, "Connected to gpsd")
            return True
        except ImportError:
            self.connection_status.emit(False, "gpsd-py3 not installed")
            return False
        except Exception as e:
            self.connection_status.emit(False, f"gpsd connection failed: {e}")
            self._connected = False
            return False

    def _disconnect(self) -> None:
        """Disconnect from gpsd."""
        if self._gpsd:
            try:
                self._gpsd.close()
            except Exception:
                pass
            self._gpsd = None
        self._connected = False

    def _run_loop(self) -> None:
        """Main polling loop."""
        while self._running:
            try:
                if not self._connected:
                    if not self._connect():
                        time.sleep(self.RECONNECT_DELAY)
                        continue

                # Read next GPS report
                report = self._gpsd.next()

                if report.get("class") == "TPV":
                    data = self._parse_tpv(report)
                    if data.fix_ok and data.lat is not None and data.lon is not None:
                        self._update_position_history(data)
                        data.grade_pct = self._compute_grade()
                    self.gps_updated.emit(data)

                # Small sleep to prevent tight loop
                time.sleep(0.05)

            except StopIteration:
                # No data available, wait briefly
                time.sleep(0.1)
            except Exception as e:
                self.connection_status.emit(False, f"GPS error: {e}")
                self._disconnect()
                if self._running:
                    time.sleep(self.RECONNECT_DELAY)

    def _parse_tpv(self, report: dict) -> GPSData:
        """
        Parse a TPV (Time-Position-Velocity) report from gpsd.

        Args:
            report: The gpsd TPV report dictionary

        Returns:
            GPSData object
        """
        mode = report.get("mode", 0)

        # Mode: 0=unknown, 1=no fix, 2=2D fix, 3=3D fix
        fix_ok = mode >= 2

        data = GPSData(
            fix_ok=fix_ok,
            timestamp=time.time(),
        )

        if not fix_ok:
            return data

        # Position (always present with fix)
        data.lat = report.get("lat")
        data.lon = report.get("lon")

        # Speed (m/s from gpsd, convert to mph)
        speed_mps = report.get("speed")
        if speed_mps is not None:
            data.speed_mph = mps_to_mph(speed_mps)

        # Heading/track (degrees)
        track = report.get("track")
        if track is not None:
            data.heading_deg = int(track) % 360

        # Elevation (meters from gpsd, convert to feet)
        # Only available with 3D fix
        if mode >= 3:
            alt_m = report.get("alt")
            if alt_m is not None:
                data.elevation_ft = int(meters_to_feet(alt_m))

        return data

    def _update_position_history(self, data: GPSData) -> None:
        """Add position to history for grade calculation."""
        if data.lat is None or data.lon is None:
            return

        # Need elevation for grade calculation
        elevation_m = 0.0
        if data.elevation_ft is not None:
            elevation_m = feet_to_meters(data.elevation_ft)

        sample = PositionSample(
            lat=data.lat,
            lon=data.lon,
            elevation_m=elevation_m,
            timestamp=data.timestamp,
        )
        self._position_history.append(sample)

    def _compute_grade(self) -> Optional[float]:
        """
        Compute grade percentage from position history.

        Grade = (elevation_change / horizontal_distance) * 100

        Returns:
            Grade percentage, or None if insufficient data
        """
        if len(self._position_history) < 5:
            return None

        oldest = self._position_history[0]
        newest = self._position_history[-1]

        # Need elevation data
        if oldest.elevation_m == 0.0 and newest.elevation_m == 0.0:
            return None

        # Calculate horizontal distance
        dist_m = haversine_meters(oldest.lat, oldest.lon, newest.lat, newest.lon)

        # Require minimum distance for meaningful grade
        if dist_m < self.MIN_GRADE_DISTANCE_M:
            return None

        # Calculate grade
        elev_delta_m = newest.elevation_m - oldest.elevation_m
        grade = (elev_delta_m / dist_m) * 100

        # Clamp to reasonable range
        return max(-self.MAX_GRADE_PCT, min(self.MAX_GRADE_PCT, grade))


class MockGPSService(QObject):
    """
    Mock GPS service for development/testing without real GPS hardware.

    Simulates movement around a starting point with realistic values.
    """

    # Signals (same as real service)
    gps_updated = Signal(object)  # GPSData
    connection_status = Signal(bool, str)  # connected, message

    def __init__(self):
        super().__init__()
        self._running = False

        # Starting position (Los Angeles area)
        self._lat = 34.0522
        self._lon = -118.2437
        self._elevation_ft = 300.0
        self._heading = 45
        self._speed_mph = 0.0

        # Movement simulation
        self._time_counter = 0

    @Slot()
    def start(self) -> None:
        """Start the mock GPS (no-op, updates come from mock_tick)."""
        self._running = True
        self.connection_status.emit(True, "Mock GPS active")

    @Slot()
    def stop(self) -> None:
        """Stop the mock GPS."""
        self._running = False

    def mock_tick(self) -> None:
        """
        Generate a mock GPS update.

        Call this from MainWindow's mock timer.
        """
        if not self._running:
            return

        import random

        self._time_counter += 1

        # Simulate realistic movement
        # Speed varies between 0-65 mph with occasional stops
        if self._time_counter % 30 < 5:
            # Stopped at light
            self._speed_mph = random.uniform(0, 2)
        else:
            self._speed_mph = random.uniform(25, 65)

        # Update position based on speed and heading
        if self._speed_mph > 1:
            import math

            # Convert mph to degrees per second (very rough)
            speed_deg = self._speed_mph * 0.000004

            # Move in heading direction
            self._lat += speed_deg * math.cos(math.radians(self._heading))
            self._lon += speed_deg * math.sin(math.radians(self._heading))

            # Slowly vary heading (simulates turns)
            self._heading = (self._heading + random.uniform(-5, 5)) % 360

        # Vary elevation (simulates hills)
        self._elevation_ft += random.uniform(-10, 15)
        self._elevation_ft = max(0, min(9000, self._elevation_ft))

        # Compute simulated grade
        grade = random.uniform(-6, 8) if self._speed_mph > 5 else 0

        data = GPSData(
            lat=self._lat,
            lon=self._lon,
            speed_mph=self._speed_mph,
            heading_deg=int(self._heading),
            elevation_ft=int(self._elevation_ft),
            fix_ok=True,
            grade_pct=grade,
            timestamp=time.time(),
        )

        self.gps_updated.emit(data)
