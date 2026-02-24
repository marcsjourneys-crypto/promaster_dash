"""Automatic trip detection and statistics tracking."""

from __future__ import annotations

import time
from enum import Enum
from typing import Optional

from PySide6.QtCore import QObject, Signal, Slot

from promaster_dash.models.data_records import GPSData, TripStats
from promaster_dash.models.vehicle_state import VehicleState, TRANS_WARN, COOL_WARN
from promaster_dash.services.logging_service import LoggingService


class TripState(Enum):
    """Trip state machine states."""

    IDLE = "idle"  # No active trip
    ACTIVE = "active"  # Trip in progress
    ENDING = "ending"  # Vehicle stopped, waiting to confirm trip end


class TripManager(QObject):
    """
    Manages automatic trip detection and statistics.

    State machine:
        IDLE ──(speed > 5 mph)──> ACTIVE
        ACTIVE ──(speed < 1 mph)──> ENDING
        ENDING ──(speed > 5 mph)──> ACTIVE
        ENDING ──(5 min elapsed)──> IDLE (emit trip_ended)
    """

    # Signals
    trip_started = Signal(int)  # trip_id
    trip_ended = Signal(object)  # TripStats
    trip_stats_updated = Signal(object)  # TripStats (periodic updates)
    state_changed = Signal(str)  # TripState value

    # Configuration
    START_SPEED_THRESHOLD = 5.0  # mph to start trip
    STOP_SPEED_THRESHOLD = 1.0  # mph considered stopped
    STOP_TIMEOUT_SECS = 300  # 5 minutes stationary to end trip
    STATS_UPDATE_INTERVAL = 5.0  # seconds between stats updates

    def __init__(
        self,
        logging_service: Optional[LoggingService] = None,
    ):
        super().__init__()
        self._logging_service = logging_service
        self._state = TripState.IDLE
        self._stats: Optional[TripStats] = None

        # Timing
        self._stop_start_ts: Optional[float] = None  # When vehicle first stopped
        self._last_update_ts = 0.0
        self._last_stats_emit_ts = 0.0

    @property
    def state(self) -> TripState:
        """Current trip state."""
        return self._state

    @property
    def stats(self) -> Optional[TripStats]:
        """Current trip statistics (None if no active trip)."""
        return self._stats

    @property
    def is_active(self) -> bool:
        """True if a trip is currently active or ending."""
        return self._state in (TripState.ACTIVE, TripState.ENDING)

    @Slot(object)
    def on_gps_update(self, data: GPSData) -> None:
        """
        Process a GPS update.

        Args:
            data: GPS data from GPSService
        """
        if not data.fix_ok:
            return

        now = time.time()
        dt = now - self._last_update_ts if self._last_update_ts > 0 else 0
        self._last_update_ts = now

        speed = data.speed_mph or 0

        if self._state == TripState.IDLE:
            self._handle_idle(speed, now)
        elif self._state == TripState.ACTIVE:
            self._handle_active(data, speed, now, dt)
        elif self._state == TripState.ENDING:
            self._handle_ending(data, speed, now, dt)

    def on_vehicle_state_update(self, vehicle_state: VehicleState, dt: float) -> None:
        """
        Update trip stats with vehicle telemetry.

        Call this periodically (e.g., every UI tick) to track temperatures.

        Args:
            vehicle_state: Current vehicle state
            dt: Time delta since last call
        """
        if self._stats is None:
            return

        self._stats.update_temps(
            vehicle_state.trans_f,
            vehicle_state.coolant_f,
            dt,
            TRANS_WARN,
            COOL_WARN,
        )

    def _handle_idle(self, speed: float, now: float) -> None:
        """Handle state transitions from IDLE."""
        if speed >= self.START_SPEED_THRESHOLD:
            self._start_trip(now)

    def _handle_active(self, data: GPSData, speed: float, now: float, dt: float) -> None:
        """Handle state transitions and updates in ACTIVE state."""
        # Update trip stats
        if data.lat is not None and data.lon is not None:
            self._stats.update_distance(data.lat, data.lon)

        if speed >= 0:
            self._stats.update_speed(speed)

        # Check for stop
        if speed < self.STOP_SPEED_THRESHOLD:
            self._transition_to(TripState.ENDING)
            self._stop_start_ts = now
        else:
            # Still moving, emit periodic stats
            self._maybe_emit_stats(now)

    def _handle_ending(self, data: GPSData, speed: float, now: float, dt: float) -> None:
        """Handle state transitions in ENDING state."""
        # Still update stats while ending
        if data.lat is not None and data.lon is not None:
            self._stats.update_distance(data.lat, data.lon)

        if speed >= self.START_SPEED_THRESHOLD:
            # Resumed moving
            self._transition_to(TripState.ACTIVE)
            self._stop_start_ts = None
        elif self._stop_start_ts and (now - self._stop_start_ts) >= self.STOP_TIMEOUT_SECS:
            # Been stopped long enough, end trip
            self._end_trip(now)
        else:
            # Still waiting
            self._maybe_emit_stats(now)

    def _start_trip(self, now: float) -> None:
        """Start a new trip."""
        self._stats = TripStats(start_ts=now)

        # Create database record
        if self._logging_service:
            trip_id = self._logging_service.create_trip(now)
            if trip_id:
                self._stats.trip_id = trip_id

        self._transition_to(TripState.ACTIVE)
        self._stop_start_ts = None

        if self._stats.trip_id:
            self.trip_started.emit(self._stats.trip_id)

    def _end_trip(self, now: float) -> None:
        """End the current trip."""
        if self._stats is None:
            self._transition_to(TripState.IDLE)
            return

        self._stats.end_ts = now

        # Finalize database record
        if self._logging_service and self._stats.trip_id:
            self._logging_service.finalize_trip(self._stats.trip_id, self._stats)

        # Emit final stats
        self.trip_ended.emit(self._stats)

        # Reset
        self._stats = None
        self._stop_start_ts = None
        self._transition_to(TripState.IDLE)

    def _transition_to(self, new_state: TripState) -> None:
        """Transition to a new state."""
        if new_state != self._state:
            self._state = new_state
            self.state_changed.emit(new_state.value)

    def _maybe_emit_stats(self, now: float) -> None:
        """Emit stats update if interval has passed."""
        if self._stats and (now - self._last_stats_emit_ts) >= self.STATS_UPDATE_INTERVAL:
            self.trip_stats_updated.emit(self._stats)
            self._last_stats_emit_ts = now

    def force_end_trip(self) -> None:
        """Force-end the current trip (e.g., on app shutdown)."""
        if self._state != TripState.IDLE and self._stats:
            self._end_trip(time.time())

    def reset(self) -> None:
        """Reset to idle state without logging."""
        self._stats = None
        self._stop_start_ts = None
        self._state = TripState.IDLE
        self.state_changed.emit(TripState.IDLE.value)
