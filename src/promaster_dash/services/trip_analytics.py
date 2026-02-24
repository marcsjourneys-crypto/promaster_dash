"""Trip analytics and statistics computation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Tuple

from promaster_dash.models.data_records import BreadcrumbRecord
from promaster_dash.models.vehicle_state import TRANS_WARN, COOL_WARN


@dataclass
class TripSummary:
    """Summary statistics for a single trip."""

    trip_id: int
    start_ts: float
    end_ts: Optional[float]
    distance_mi: float
    duration_secs: float
    avg_speed_mph: float

    # Temperature stats
    max_trans_f: Optional[float]
    max_coolant_f: Optional[float]
    avg_trans_f: Optional[float]
    avg_coolant_f: Optional[float]
    trans_warn_secs: float
    coolant_warn_secs: float

    # Elevation
    elevation_gain_ft: float
    elevation_loss_ft: float

    # Status
    had_warning: bool

    @property
    def start_datetime(self) -> datetime:
        return datetime.fromtimestamp(self.start_ts)

    @property
    def duration_formatted(self) -> str:
        """Format duration as 'Xh Ym' or 'Xm'."""
        mins = int(self.duration_secs // 60)
        if mins >= 60:
            hours = mins // 60
            mins = mins % 60
            return f"{hours}h {mins}m"
        return f"{mins}m"


@dataclass
class MonthlyStats:
    """Aggregated statistics for a month."""

    year: int
    month: int
    trip_count: int
    total_miles: float
    total_duration_secs: float
    max_trans_f: Optional[float]
    max_trans_date: Optional[datetime]
    max_coolant_f: Optional[float]
    avg_trans_f: Optional[float]
    avg_coolant_f: Optional[float]
    total_warn_secs: float

    @property
    def month_name(self) -> str:
        return datetime(self.year, self.month, 1).strftime("%B %Y")


@dataclass
class AllTimeStats:
    """All-time aggregated statistics."""

    first_trip_date: Optional[datetime]
    trip_count: int
    total_miles: float
    total_duration_secs: float
    max_trans_f: Optional[float]
    max_trans_date: Optional[datetime]
    max_coolant_f: Optional[float]
    avg_trans_f: Optional[float]
    total_warn_secs: float


@dataclass
class GradeTempCorrelation:
    """Temperature behavior at different grades."""

    flat_avg_trans: Optional[float]  # grade -2% to 2%
    climbing_avg_trans: Optional[float]  # grade > 4%
    steep_climbing_avg_trans: Optional[float]  # grade > 6%
    descending_avg_trans: Optional[float]  # grade < -2%
    temp_increase_per_grade_pct: Optional[float]  # rough slope


@dataclass
class TripInsights:
    """Computed insights about trip patterns."""

    grade_correlation: Optional[GradeTempCorrelation]
    temp_trend_vs_last_month: Optional[float]  # +/- degrees
    coolest_time_of_day: Optional[str]  # "morning", "afternoon", "evening"
    messages: List[str]  # Human-readable insights


def compute_trip_summary(
    trip: dict, breadcrumbs: List[BreadcrumbRecord]
) -> TripSummary:
    """
    Compute detailed summary for a trip from its breadcrumbs.

    Args:
        trip: Trip record from database
        breadcrumbs: List of breadcrumb records for this trip
    """
    # Temperature stats from breadcrumbs
    trans_temps = [b.trans_f for b in breadcrumbs if b.trans_f is not None]
    coolant_temps = [b.coolant_f for b in breadcrumbs if b.coolant_f is not None]

    avg_trans = sum(trans_temps) / len(trans_temps) if trans_temps else None
    avg_coolant = sum(coolant_temps) / len(coolant_temps) if coolant_temps else None

    # Elevation gain/loss
    elevation_gain = 0.0
    elevation_loss = 0.0
    prev_elev = None

    for b in breadcrumbs:
        if b.elevation_ft is not None:
            if prev_elev is not None:
                delta = b.elevation_ft - prev_elev
                if delta > 0:
                    elevation_gain += delta
                else:
                    elevation_loss += abs(delta)
            prev_elev = b.elevation_ft

    # Warning status
    had_warning = (
        (trip.get("trans_warn_secs") or 0) > 0
        or (trip.get("coolant_warn_secs") or 0) > 0
    )

    return TripSummary(
        trip_id=trip["id"],
        start_ts=trip["start_ts"],
        end_ts=trip.get("end_ts"),
        distance_mi=trip.get("distance_mi") or 0,
        duration_secs=trip.get("duration_secs") or 0,
        avg_speed_mph=trip.get("avg_speed_mph") or 0,
        max_trans_f=trip.get("max_trans_f"),
        max_coolant_f=trip.get("max_coolant_f"),
        avg_trans_f=avg_trans,
        avg_coolant_f=avg_coolant,
        trans_warn_secs=trip.get("trans_warn_secs") or 0,
        coolant_warn_secs=trip.get("coolant_warn_secs") or 0,
        elevation_gain_ft=elevation_gain,
        elevation_loss_ft=elevation_loss,
        had_warning=had_warning,
    )


def compute_grade_temp_correlation(
    breadcrumbs: List[BreadcrumbRecord],
) -> Optional[GradeTempCorrelation]:
    """
    Analyze relationship between grade and transmission temperature.

    Args:
        breadcrumbs: All breadcrumbs to analyze (can be from multiple trips)
    """
    if not breadcrumbs:
        return None

    # Group by grade ranges
    flat_temps = []  # -2% to 2%
    climbing_temps = []  # > 4%
    steep_temps = []  # > 6%
    descending_temps = []  # < -2%

    for b in breadcrumbs:
        if b.trans_f is None or b.grade_pct is None:
            continue

        grade = b.grade_pct
        temp = b.trans_f

        if -2 <= grade <= 2:
            flat_temps.append(temp)
        if grade > 4:
            climbing_temps.append(temp)
        if grade > 6:
            steep_temps.append(temp)
        if grade < -2:
            descending_temps.append(temp)

    def avg(lst):
        return sum(lst) / len(lst) if lst else None

    flat_avg = avg(flat_temps)
    climbing_avg = avg(climbing_temps)

    # Rough estimate of temp increase per % grade
    temp_per_grade = None
    if flat_avg is not None and climbing_avg is not None:
        # Assuming avg grade when climbing is ~5%
        temp_per_grade = (climbing_avg - flat_avg) / 5.0

    return GradeTempCorrelation(
        flat_avg_trans=flat_avg,
        climbing_avg_trans=climbing_avg,
        steep_climbing_avg_trans=avg(steep_temps),
        descending_avg_trans=avg(descending_temps),
        temp_increase_per_grade_pct=temp_per_grade,
    )


def generate_insights(
    current_month_stats: Optional[MonthlyStats],
    last_month_stats: Optional[MonthlyStats],
    grade_correlation: Optional[GradeTempCorrelation],
    breadcrumbs: List[BreadcrumbRecord],
) -> TripInsights:
    """
    Generate human-readable insights from trip data.

    Args:
        current_month_stats: Stats for current month
        last_month_stats: Stats for previous month
        grade_correlation: Grade vs temp analysis
        breadcrumbs: Recent breadcrumbs for time-of-day analysis
    """
    messages = []

    # Grade correlation insight
    if grade_correlation:
        if (
            grade_correlation.flat_avg_trans is not None
            and grade_correlation.climbing_avg_trans is not None
        ):
            diff = grade_correlation.climbing_avg_trans - grade_correlation.flat_avg_trans
            if diff > 5:
                messages.append(
                    f"Trans runs {diff:.0f}°F hotter on grades > 4%"
                )

    # Month-over-month trend
    temp_trend = None
    if current_month_stats and last_month_stats:
        if (
            current_month_stats.avg_trans_f is not None
            and last_month_stats.avg_trans_f is not None
        ):
            temp_trend = current_month_stats.avg_trans_f - last_month_stats.avg_trans_f
            if abs(temp_trend) > 2:
                direction = "up" if temp_trend > 0 else "down"
                messages.append(
                    f"Avg temp trending {direction} {abs(temp_trend):.0f}°F vs last month"
                )

    # Time of day analysis
    coolest_time = None
    if breadcrumbs:
        morning_temps = []  # 6am - 10am
        afternoon_temps = []  # 10am - 4pm
        evening_temps = []  # 4pm - 8pm

        for b in breadcrumbs:
            if b.trans_f is None:
                continue
            hour = datetime.fromtimestamp(b.ts).hour
            if 6 <= hour < 10:
                morning_temps.append(b.trans_f)
            elif 10 <= hour < 16:
                afternoon_temps.append(b.trans_f)
            elif 16 <= hour < 20:
                evening_temps.append(b.trans_f)

        def avg(lst):
            return sum(lst) / len(lst) if lst else float("inf")

        avgs = [
            ("morning", avg(morning_temps)),
            ("afternoon", avg(afternoon_temps)),
            ("evening", avg(evening_temps)),
        ]
        avgs = [(t, a) for t, a in avgs if a != float("inf")]

        if avgs:
            coolest = min(avgs, key=lambda x: x[1])
            coolest_time = coolest[0]
            if len(avgs) > 1:
                messages.append(f"Coolest trips: {coolest_time} (before 10am)" if coolest_time == "morning" else f"Coolest trips: {coolest_time}")

    return TripInsights(
        grade_correlation=grade_correlation,
        temp_trend_vs_last_month=temp_trend,
        coolest_time_of_day=coolest_time,
        messages=messages,
    )


def format_duration(secs: float) -> str:
    """Format seconds as human-readable duration."""
    mins = int(secs // 60)
    if mins < 60:
        return f"{mins}m"
    hours = mins // 60
    mins = mins % 60
    if hours < 24:
        return f"{hours}h {mins}m"
    days = hours // 24
    hours = hours % 24
    return f"{days}d {hours}h"


def format_warn_time(secs: float) -> str:
    """Format warning time nicely."""
    if secs < 60:
        return f"{int(secs)}s"
    mins = int(secs // 60)
    secs = int(secs % 60)
    if mins < 60:
        return f"{mins}m {secs}s"
    hours = mins // 60
    mins = mins % 60
    return f"{hours}h {mins}m"
