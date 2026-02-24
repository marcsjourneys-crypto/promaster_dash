"""Data transfer objects for GPS, logging, and trip tracking."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
import time


@dataclass
class GPSData:
    """Data transfer object for GPS readings from gpsd."""

    lat: Optional[float] = None  # Latitude (degrees)
    lon: Optional[float] = None  # Longitude (degrees)
    speed_mph: Optional[float] = None  # Speed (miles per hour)
    heading_deg: Optional[int] = None  # Heading (degrees, 0-359)
    elevation_ft: Optional[int] = None  # Elevation (feet)
    fix_ok: bool = False  # True if GPS has a valid fix
    grade_pct: Optional[float] = None  # Computed grade percentage
    timestamp: float = field(default_factory=time.time)  # Unix timestamp


@dataclass
class BreadcrumbRecord:
    """Single breadcrumb data point for trip logging."""

    trip_id: int
    ts: float  # Unix timestamp
    lat: float
    lon: float
    elevation_ft: Optional[float] = None
    speed_mph: Optional[float] = None
    heading_deg: Optional[int] = None
    trans_f: Optional[float] = None
    coolant_f: Optional[float] = None
    voltage_v: Optional[float] = None
    grade_pct: Optional[float] = None
    obd_speed_mph: Optional[float] = None  # For GPS vs OBD comparison


@dataclass
class EventRecord:
    """Location-tagged event (alerts, DTCs, trip markers)."""

    ts: float  # Unix timestamp
    event_type: str  # 'alert', 'dtc', 'trip_start', 'trip_end'
    severity: str  # 'info', 'warning', 'critical'
    message: str
    trip_id: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


@dataclass
class TripStats:
    """In-memory trip statistics, finalized when trip ends."""

    trip_id: Optional[int] = None
    start_ts: float = 0.0
    end_ts: Optional[float] = None

    # Distance tracking
    distance_mi: float = 0.0
    last_lat: Optional[float] = None
    last_lon: Optional[float] = None

    # Temperature tracking
    max_trans_f: Optional[float] = None
    max_coolant_f: Optional[float] = None
    trans_warn_secs: float = 0.0  # Seconds above warning threshold
    coolant_warn_secs: float = 0.0  # Seconds above warning threshold

    # Speed tracking
    speed_samples: int = 0
    speed_sum: float = 0.0

    @property
    def avg_speed_mph(self) -> float:
        """Calculate average speed in mph."""
        if self.speed_samples == 0:
            return 0.0
        return self.speed_sum / self.speed_samples

    @property
    def duration_secs(self) -> float:
        """Calculate trip duration in seconds."""
        end = self.end_ts or time.time()
        return end - self.start_ts

    def update_distance(self, lat: float, lon: float) -> float:
        """
        Update trip distance with new position.

        Returns the distance delta in miles.
        """
        from promaster_dash.utils.geo import haversine_miles

        if self.last_lat is None or self.last_lon is None:
            self.last_lat = lat
            self.last_lon = lon
            return 0.0

        delta_mi = haversine_miles(self.last_lat, self.last_lon, lat, lon)

        # Filter out GPS jumps (> 0.5 mile in one update = likely error)
        if delta_mi < 0.5:
            self.distance_mi += delta_mi
            self.last_lat = lat
            self.last_lon = lon
            return delta_mi

        # GPS jump detected - update position but don't add to distance
        self.last_lat = lat
        self.last_lon = lon
        return 0.0

    def update_speed(self, speed_mph: float) -> None:
        """Record a speed sample for average calculation."""
        if speed_mph >= 0:
            self.speed_samples += 1
            self.speed_sum += speed_mph

    def update_temps(
        self,
        trans_f: Optional[float],
        coolant_f: Optional[float],
        dt_secs: float,
        trans_warn: float = 230.0,
        coolant_warn: float = 220.0,
    ) -> None:
        """
        Update temperature tracking.

        Args:
            trans_f: Current transmission temperature (F)
            coolant_f: Current coolant temperature (F)
            dt_secs: Time delta since last update
            trans_warn: Transmission warning threshold
            coolant_warn: Coolant warning threshold
        """
        if trans_f is not None:
            if self.max_trans_f is None or trans_f > self.max_trans_f:
                self.max_trans_f = trans_f
            if trans_f >= trans_warn:
                self.trans_warn_secs += dt_secs

        if coolant_f is not None:
            if self.max_coolant_f is None or coolant_f > self.max_coolant_f:
                self.max_coolant_f = coolant_f
            if coolant_f >= coolant_warn:
                self.coolant_warn_secs += dt_secs
