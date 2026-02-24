"""Geographic utility functions for distance and unit conversions."""

from __future__ import annotations

import math

# Earth radius constants
EARTH_RADIUS_MI = 3958.8  # miles
EARTH_RADIUS_M = 6371000  # meters

# Conversion constants
METERS_PER_FOOT = 0.3048
FEET_PER_METER = 3.28084
KPH_TO_MPH = 0.621371


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points in miles.

    Args:
        lat1: Latitude of first point (degrees)
        lon1: Longitude of first point (degrees)
        lat2: Latitude of second point (degrees)
        lon2: Longitude of second point (degrees)

    Returns:
        Distance in miles
    """
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))

    return EARTH_RADIUS_MI * c


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points in meters.

    Args:
        lat1: Latitude of first point (degrees)
        lon1: Longitude of first point (degrees)
        lat2: Latitude of second point (degrees)
        lon2: Longitude of second point (degrees)

    Returns:
        Distance in meters
    """
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))

    return EARTH_RADIUS_M * c


def meters_to_feet(meters: float) -> float:
    """Convert meters to feet."""
    return meters * FEET_PER_METER


def feet_to_meters(feet: float) -> float:
    """Convert feet to meters."""
    return feet * METERS_PER_FOOT


def kph_to_mph(kph: float) -> float:
    """Convert kilometers per hour to miles per hour."""
    return kph * KPH_TO_MPH


def mps_to_mph(mps: float) -> float:
    """Convert meters per second to miles per hour."""
    return mps * 2.23694
