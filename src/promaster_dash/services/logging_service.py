"""SQLite logging service for trips, breadcrumbs, and events."""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path
from queue import Queue, Empty
from typing import List, Optional

from PySide6.QtCore import QObject, Signal

from promaster_dash.models.data_records import BreadcrumbRecord, EventRecord, TripStats


def get_data_dir() -> Path:
    """Get the data directory, creating if needed."""
    if sys.platform.startswith("linux"):
        # Raspberry Pi / Linux - use XDG standard
        data_dir = Path.home() / ".local" / "share" / "promaster_dash"
    else:
        # Windows/Mac development
        data_dir = Path.home() / ".promaster_dash"

    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_exports_dir() -> Path:
    """Get the exports directory for GPX files."""
    exports_dir = get_data_dir() / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    return exports_dir


# SQL schema
SCHEMA = """
-- Trip summary records
CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts REAL NOT NULL,
    end_ts REAL,
    distance_mi REAL DEFAULT 0,
    duration_secs REAL DEFAULT 0,
    max_trans_f REAL,
    max_coolant_f REAL,
    trans_warn_secs REAL DEFAULT 0,
    coolant_warn_secs REAL DEFAULT 0,
    avg_speed_mph REAL DEFAULT 0
);

-- GPS breadcrumb trail with vehicle telemetry
CREATE TABLE IF NOT EXISTS breadcrumbs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    ts REAL NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    elevation_ft REAL,
    speed_mph REAL,
    heading_deg INTEGER,
    trans_f REAL,
    coolant_f REAL,
    voltage_v REAL,
    grade_pct REAL,
    obd_speed_mph REAL,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- Location-tagged events (alerts, DTCs, etc.)
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER,
    ts REAL NOT NULL,
    lat REAL,
    lon REAL,
    event_type TEXT NOT NULL,
    severity TEXT,
    message TEXT,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_trip ON breadcrumbs(trip_id);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_ts ON breadcrumbs(ts);
CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_ts);
"""


class LoggingService(QObject):
    """
    SQLite logging service for trips, breadcrumbs, and events.

    Runs in a dedicated thread. Use signals/slots for thread-safe access.
    """

    # Signals
    trip_created = Signal(int)  # new trip_id
    trip_finalized = Signal(int)  # trip_id
    error_occurred = Signal(str)  # error message

    # Configuration
    BREADCRUMB_INTERVAL = 5.0  # seconds between breadcrumbs
    MAX_TRIP_AGE_DAYS = 365  # auto-cleanup threshold

    def __init__(self, db_path: Optional[Path] = None):
        super().__init__()
        self._db_path = db_path or (get_data_dir() / "promaster_dash.db")
        self._conn: Optional[sqlite3.Connection] = None
        self._last_breadcrumb_ts = 0.0
        self._initialized = False

    def initialize(self) -> bool:
        """Initialize the database connection and schema."""
        try:
            self._conn = sqlite3.connect(
                str(self._db_path),
                check_same_thread=False,  # We handle threading via Qt
                isolation_level=None,  # Autocommit mode
            )
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute("PRAGMA journal_mode = WAL")  # Write-ahead logging
            self._conn.executescript(SCHEMA)
            self._initialized = True
            return True
        except Exception as e:
            self.error_occurred.emit(f"Database init failed: {e}")
            return False

    def close(self) -> None:
        """Close the database connection."""
        if self._conn:
            self._conn.close()
            self._conn = None
            self._initialized = False

    def create_trip(self, start_ts: float) -> Optional[int]:
        """
        Create a new trip record.

        Args:
            start_ts: Unix timestamp of trip start

        Returns:
            New trip_id or None on error
        """
        if not self._initialized:
            if not self.initialize():
                return None

        try:
            cursor = self._conn.execute(
                "INSERT INTO trips (start_ts) VALUES (?)",
                (start_ts,),
            )
            trip_id = cursor.lastrowid
            self.trip_created.emit(trip_id)

            # Log trip start event
            self.log_event(
                EventRecord(
                    ts=start_ts,
                    event_type="trip_start",
                    severity="info",
                    message="Trip started",
                    trip_id=trip_id,
                )
            )

            return trip_id
        except Exception as e:
            self.error_occurred.emit(f"Create trip failed: {e}")
            return None

    def finalize_trip(self, trip_id: int, stats: TripStats) -> bool:
        """
        Update trip with final statistics.

        Args:
            trip_id: The trip to finalize
            stats: Final trip statistics

        Returns:
            True if successful
        """
        if not self._initialized:
            return False

        try:
            self._conn.execute(
                """
                UPDATE trips SET
                    end_ts = ?,
                    distance_mi = ?,
                    duration_secs = ?,
                    max_trans_f = ?,
                    max_coolant_f = ?,
                    trans_warn_secs = ?,
                    coolant_warn_secs = ?,
                    avg_speed_mph = ?
                WHERE id = ?
                """,
                (
                    stats.end_ts or time.time(),
                    stats.distance_mi,
                    stats.duration_secs,
                    stats.max_trans_f,
                    stats.max_coolant_f,
                    stats.trans_warn_secs,
                    stats.coolant_warn_secs,
                    stats.avg_speed_mph,
                    trip_id,
                ),
            )
            self.trip_finalized.emit(trip_id)

            # Log trip end event
            self.log_event(
                EventRecord(
                    ts=time.time(),
                    event_type="trip_end",
                    severity="info",
                    message=f"Trip ended: {stats.distance_mi:.1f} mi, {stats.duration_secs/60:.0f} min",
                    trip_id=trip_id,
                )
            )

            return True
        except Exception as e:
            self.error_occurred.emit(f"Finalize trip failed: {e}")
            return False

    def log_breadcrumb(self, record: BreadcrumbRecord, force: bool = False) -> bool:
        """
        Log a breadcrumb point.

        Rate-limited to BREADCRUMB_INTERVAL unless force=True.

        Args:
            record: The breadcrumb data
            force: Bypass rate limiting

        Returns:
            True if logged (or skipped due to rate limit)
        """
        if not self._initialized:
            if not self.initialize():
                return False

        # Rate limiting
        now = time.time()
        if not force and (now - self._last_breadcrumb_ts) < self.BREADCRUMB_INTERVAL:
            return True  # Skipped, but not an error

        try:
            self._conn.execute(
                """
                INSERT INTO breadcrumbs (
                    trip_id, ts, lat, lon, elevation_ft, speed_mph,
                    heading_deg, trans_f, coolant_f, voltage_v, grade_pct, obd_speed_mph
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.trip_id,
                    record.ts,
                    record.lat,
                    record.lon,
                    record.elevation_ft,
                    record.speed_mph,
                    record.heading_deg,
                    record.trans_f,
                    record.coolant_f,
                    record.voltage_v,
                    record.grade_pct,
                    record.obd_speed_mph,
                ),
            )
            self._last_breadcrumb_ts = now
            return True
        except Exception as e:
            self.error_occurred.emit(f"Log breadcrumb failed: {e}")
            return False

    def log_event(self, record: EventRecord) -> bool:
        """
        Log an event with optional location.

        Args:
            record: The event data

        Returns:
            True if successful
        """
        if not self._initialized:
            if not self.initialize():
                return False

        try:
            self._conn.execute(
                """
                INSERT INTO events (trip_id, ts, lat, lon, event_type, severity, message)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.trip_id,
                    record.ts,
                    record.lat,
                    record.lon,
                    record.event_type,
                    record.severity,
                    record.message,
                ),
            )
            return True
        except Exception as e:
            self.error_occurred.emit(f"Log event failed: {e}")
            return False

    def get_trip_breadcrumbs(self, trip_id: int) -> List[BreadcrumbRecord]:
        """
        Retrieve all breadcrumbs for a trip.

        Args:
            trip_id: The trip to query

        Returns:
            List of breadcrumb records
        """
        if not self._initialized:
            return []

        try:
            cursor = self._conn.execute(
                """
                SELECT trip_id, ts, lat, lon, elevation_ft, speed_mph,
                       heading_deg, trans_f, coolant_f, voltage_v, grade_pct, obd_speed_mph
                FROM breadcrumbs
                WHERE trip_id = ?
                ORDER BY ts
                """,
                (trip_id,),
            )
            return [
                BreadcrumbRecord(
                    trip_id=row[0],
                    ts=row[1],
                    lat=row[2],
                    lon=row[3],
                    elevation_ft=row[4],
                    speed_mph=row[5],
                    heading_deg=row[6],
                    trans_f=row[7],
                    coolant_f=row[8],
                    voltage_v=row[9],
                    grade_pct=row[10],
                    obd_speed_mph=row[11],
                )
                for row in cursor.fetchall()
            ]
        except Exception as e:
            self.error_occurred.emit(f"Get breadcrumbs failed: {e}")
            return []

    def get_recent_trips(self, limit: int = 20) -> List[dict]:
        """
        Get recent trip summaries.

        Args:
            limit: Maximum number of trips to return

        Returns:
            List of trip dictionaries
        """
        if not self._initialized:
            if not self.initialize():
                return []

        try:
            cursor = self._conn.execute(
                """
                SELECT id, start_ts, end_ts, distance_mi, duration_secs,
                       max_trans_f, max_coolant_f, trans_warn_secs, coolant_warn_secs, avg_speed_mph
                FROM trips
                ORDER BY start_ts DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [
                {
                    "id": row[0],
                    "start_ts": row[1],
                    "end_ts": row[2],
                    "distance_mi": row[3],
                    "duration_secs": row[4],
                    "max_trans_f": row[5],
                    "max_coolant_f": row[6],
                    "trans_warn_secs": row[7],
                    "coolant_warn_secs": row[8],
                    "avg_speed_mph": row[9],
                }
                for row in cursor.fetchall()
            ]
        except Exception as e:
            self.error_occurred.emit(f"Get trips failed: {e}")
            return []

    def delete_trip(self, trip_id: int) -> bool:
        """
        Delete a trip and all its breadcrumbs/events.

        Args:
            trip_id: The trip to delete

        Returns:
            True if successful
        """
        if not self._initialized:
            return False

        try:
            # Foreign key cascades handle breadcrumbs and events
            self._conn.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
            return True
        except Exception as e:
            self.error_occurred.emit(f"Delete trip failed: {e}")
            return False

    def cleanup_old_trips(self, max_age_days: Optional[int] = None) -> int:
        """
        Delete trips older than max_age_days.

        Args:
            max_age_days: Maximum age in days (default: MAX_TRIP_AGE_DAYS)

        Returns:
            Number of trips deleted
        """
        if not self._initialized:
            if not self.initialize():
                return 0

        max_age_days = max_age_days or self.MAX_TRIP_AGE_DAYS
        cutoff_ts = time.time() - (max_age_days * 24 * 60 * 60)

        try:
            cursor = self._conn.execute(
                "DELETE FROM trips WHERE start_ts < ?",
                (cutoff_ts,),
            )
            deleted = cursor.rowcount
            if deleted > 0:
                # Vacuum to reclaim space
                self._conn.execute("VACUUM")
            return deleted
        except Exception as e:
            self.error_occurred.emit(f"Cleanup failed: {e}")
            return 0

    def get_database_size_mb(self) -> float:
        """Get the current database file size in MB."""
        if self._db_path.exists():
            return self._db_path.stat().st_size / (1024 * 1024)
        return 0.0

    # ---------- Analytics Queries ----------

    def get_trip_with_breadcrumbs(self, trip_id: int) -> Optional[dict]:
        """
        Get trip summary with all breadcrumbs for detail view.

        Args:
            trip_id: The trip to query

        Returns:
            Dict with trip info and breadcrumbs list, or None
        """
        if not self._initialized:
            return None

        try:
            cursor = self._conn.execute(
                """
                SELECT id, start_ts, end_ts, distance_mi, duration_secs,
                       max_trans_f, max_coolant_f, trans_warn_secs, coolant_warn_secs, avg_speed_mph
                FROM trips WHERE id = ?
                """,
                (trip_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None

            trip = {
                "id": row[0],
                "start_ts": row[1],
                "end_ts": row[2],
                "distance_mi": row[3],
                "duration_secs": row[4],
                "max_trans_f": row[5],
                "max_coolant_f": row[6],
                "trans_warn_secs": row[7],
                "coolant_warn_secs": row[8],
                "avg_speed_mph": row[9],
            }

            trip["breadcrumbs"] = self.get_trip_breadcrumbs(trip_id)
            trip["events"] = self.get_trip_events(trip_id)

            return trip
        except Exception as e:
            self.error_occurred.emit(f"Get trip with breadcrumbs failed: {e}")
            return None

    def get_trip_events(self, trip_id: int) -> List[EventRecord]:
        """
        Get all events for a trip.

        Args:
            trip_id: The trip to query

        Returns:
            List of event records
        """
        if not self._initialized:
            return []

        try:
            cursor = self._conn.execute(
                """
                SELECT ts, event_type, severity, message, trip_id, lat, lon
                FROM events
                WHERE trip_id = ?
                ORDER BY ts
                """,
                (trip_id,),
            )
            return [
                EventRecord(
                    ts=row[0],
                    event_type=row[1],
                    severity=row[2],
                    message=row[3],
                    trip_id=row[4],
                    lat=row[5],
                    lon=row[6],
                )
                for row in cursor.fetchall()
            ]
        except Exception as e:
            self.error_occurred.emit(f"Get trip events failed: {e}")
            return []

    def get_monthly_stats(self, year: int, month: int) -> dict:
        """
        Get aggregated stats for a specific month.

        Args:
            year: Year (e.g., 2024)
            month: Month (1-12)

        Returns:
            Dict with monthly statistics
        """
        if not self._initialized:
            if not self.initialize():
                return {}

        from datetime import datetime
        import calendar

        # Calculate month boundaries
        start_ts = datetime(year, month, 1).timestamp()
        last_day = calendar.monthrange(year, month)[1]
        end_ts = datetime(year, month, last_day, 23, 59, 59).timestamp()

        try:
            cursor = self._conn.execute(
                """
                SELECT
                    COUNT(*) as trip_count,
                    COALESCE(SUM(distance_mi), 0) as total_miles,
                    COALESCE(SUM(duration_secs), 0) as total_duration,
                    MAX(max_trans_f) as max_trans,
                    MAX(max_coolant_f) as max_coolant,
                    COALESCE(SUM(trans_warn_secs), 0) + COALESCE(SUM(coolant_warn_secs), 0) as total_warn_secs
                FROM trips
                WHERE start_ts >= ? AND start_ts <= ?
                """,
                (start_ts, end_ts),
            )
            row = cursor.fetchone()

            # Get average temps from breadcrumbs
            avg_cursor = self._conn.execute(
                """
                SELECT AVG(trans_f), AVG(coolant_f)
                FROM breadcrumbs b
                JOIN trips t ON b.trip_id = t.id
                WHERE t.start_ts >= ? AND t.start_ts <= ?
                AND trans_f IS NOT NULL
                """,
                (start_ts, end_ts),
            )
            avg_row = avg_cursor.fetchone()

            # Get date of max trans temp
            max_date = None
            if row[3]:
                date_cursor = self._conn.execute(
                    """
                    SELECT start_ts FROM trips
                    WHERE start_ts >= ? AND start_ts <= ?
                    AND max_trans_f = ?
                    LIMIT 1
                    """,
                    (start_ts, end_ts, row[3]),
                )
                date_row = date_cursor.fetchone()
                if date_row:
                    max_date = datetime.fromtimestamp(date_row[0])

            return {
                "year": year,
                "month": month,
                "trip_count": row[0] or 0,
                "total_miles": row[1] or 0,
                "total_duration_secs": row[2] or 0,
                "max_trans_f": row[3],
                "max_trans_date": max_date,
                "max_coolant_f": row[4],
                "total_warn_secs": row[5] or 0,
                "avg_trans_f": avg_row[0] if avg_row else None,
                "avg_coolant_f": avg_row[1] if avg_row else None,
            }
        except Exception as e:
            self.error_occurred.emit(f"Get monthly stats failed: {e}")
            return {}

    def get_all_time_stats(self) -> dict:
        """
        Get all-time aggregated statistics.

        Returns:
            Dict with all-time stats
        """
        if not self._initialized:
            if not self.initialize():
                return {}

        from datetime import datetime

        try:
            cursor = self._conn.execute(
                """
                SELECT
                    COUNT(*) as trip_count,
                    MIN(start_ts) as first_trip,
                    COALESCE(SUM(distance_mi), 0) as total_miles,
                    COALESCE(SUM(duration_secs), 0) as total_duration,
                    MAX(max_trans_f) as max_trans,
                    MAX(max_coolant_f) as max_coolant,
                    COALESCE(SUM(trans_warn_secs), 0) + COALESCE(SUM(coolant_warn_secs), 0) as total_warn_secs
                FROM trips
                """
            )
            row = cursor.fetchone()

            # Get average temps from breadcrumbs
            avg_cursor = self._conn.execute(
                "SELECT AVG(trans_f), AVG(coolant_f) FROM breadcrumbs WHERE trans_f IS NOT NULL"
            )
            avg_row = avg_cursor.fetchone()

            # Get date of max trans temp
            max_date = None
            if row[4]:
                date_cursor = self._conn.execute(
                    "SELECT start_ts FROM trips WHERE max_trans_f = ? LIMIT 1",
                    (row[4],),
                )
                date_row = date_cursor.fetchone()
                if date_row:
                    max_date = datetime.fromtimestamp(date_row[0])

            first_trip = None
            if row[1]:
                first_trip = datetime.fromtimestamp(row[1])

            return {
                "trip_count": row[0] or 0,
                "first_trip_date": first_trip,
                "total_miles": row[2] or 0,
                "total_duration_secs": row[3] or 0,
                "max_trans_f": row[4],
                "max_trans_date": max_date,
                "max_coolant_f": row[5],
                "total_warn_secs": row[6] or 0,
                "avg_trans_f": avg_row[0] if avg_row else None,
                "avg_coolant_f": avg_row[1] if avg_row else None,
            }
        except Exception as e:
            self.error_occurred.emit(f"Get all-time stats failed: {e}")
            return {}

    def get_recent_breadcrumbs(self, limit: int = 1000) -> List[BreadcrumbRecord]:
        """
        Get recent breadcrumbs for correlation analysis.

        Args:
            limit: Maximum breadcrumbs to return

        Returns:
            List of breadcrumb records
        """
        if not self._initialized:
            return []

        try:
            cursor = self._conn.execute(
                """
                SELECT trip_id, ts, lat, lon, elevation_ft, speed_mph,
                       heading_deg, trans_f, coolant_f, voltage_v, grade_pct, obd_speed_mph
                FROM breadcrumbs
                ORDER BY ts DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [
                BreadcrumbRecord(
                    trip_id=row[0],
                    ts=row[1],
                    lat=row[2],
                    lon=row[3],
                    elevation_ft=row[4],
                    speed_mph=row[5],
                    heading_deg=row[6],
                    trans_f=row[7],
                    coolant_f=row[8],
                    voltage_v=row[9],
                    grade_pct=row[10],
                    obd_speed_mph=row[11],
                )
                for row in cursor.fetchall()
            ]
        except Exception as e:
            self.error_occurred.emit(f"Get recent breadcrumbs failed: {e}")
            return []
