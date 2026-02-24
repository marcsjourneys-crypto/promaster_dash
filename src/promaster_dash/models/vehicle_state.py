"""Central vehicle state - single source of truth for all vehicle data."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class VehicleState:
    """
    Central data model representing current vehicle state.

    UI reads from this; services update it via Qt signals.
    Never query hardware directly from UI - always go through VehicleState.
    """

    # Primary gauges (from OBD)
    trans_f: Optional[float] = None  # Transmission temperature (Fahrenheit)
    coolant_f: Optional[float] = None  # Coolant temperature (Fahrenheit)
    voltage_v: Optional[float] = None  # Battery voltage (Volts)

    # Secondary (from OBD)
    rpm: Optional[int] = None  # Engine RPM
    obd_speed_mph: Optional[float] = None  # OBD-reported speed (backup to GPS)

    # GPS primary speed
    speed_mph: Optional[float] = None  # GPS speed (primary source)

    # Status indicators
    dtc_count: int = 0  # Active DTC count (MIL indicator)
    gps_ok: bool = False  # GPS fix status

    # Navigation (from GPS)
    lat: Optional[float] = None  # Latitude (degrees)
    lon: Optional[float] = None  # Longitude (degrees)
    heading_deg: Optional[int] = None  # Compass heading (degrees, 0-359)
    elevation_ft: Optional[int] = None  # Elevation (feet above sea level)

    # Grade/terrain (computed from GPS history)
    grade_pct: Optional[float] = None  # Current grade percentage
    climbing: bool = False  # True if grade > 0.5%

    # Trip tracking
    trip_start_ts: Optional[float] = None  # Unix timestamp of trip start
    current_trip_id: Optional[int] = None  # Database trip ID (None if no active trip)
    trip_distance_mi: float = 0.0  # Current trip distance (miles)
    trip_active: bool = False  # True if trip is in progress


# Threshold constants (used by UI and services)
TRANS_RANGE = (140.0, 280.0)
TRANS_WARN = 230.0
TRANS_CRIT = 250.0

COOL_RANGE = (140.0, 250.0)
COOL_WARN = 220.0
COOL_CRIT = 235.0

VOLT_RANGE = (11.0, 15.5)
VOLT_LOW = 12.0
VOLT_HIGH = 15.0
