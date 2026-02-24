"""Trip history and analytics dialogs."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional, List

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QFrame,
    QScrollArea,
    QWidget,
    QTabWidget,
    QMessageBox,
)

from promaster_dash.services.logging_service import LoggingService, get_exports_dir
from promaster_dash.services.gpx_export import GPXExporter
from promaster_dash.services.trip_analytics import (
    compute_trip_summary,
    compute_grade_temp_correlation,
    generate_insights,
    format_duration,
    format_warn_time,
)
from promaster_dash.ui.trip_chart import TempTimelineChart


# Shared styles
DIALOG_STYLE = """
    QDialog {
        background-color: rgb(22, 20, 16);
    }
    QLabel {
        color: rgb(220, 210, 190);
    }
    QPushButton {
        background-color: rgb(45, 40, 32);
        border: 1px solid rgb(100, 90, 70);
        border-radius: 6px;
        color: rgb(220, 210, 190);
        padding: 8px 16px;
        font-weight: bold;
        min-height: 36px;
    }
    QPushButton:pressed {
        background-color: rgb(70, 60, 45);
    }
    QPushButton:disabled {
        background-color: rgb(35, 32, 28);
        color: rgb(120, 110, 100);
    }
    QTabWidget::pane {
        border: 1px solid rgb(80, 70, 55);
        border-radius: 6px;
        background-color: rgb(28, 25, 20);
    }
    QTabBar::tab {
        background-color: rgb(40, 36, 30);
        border: 1px solid rgb(80, 70, 55);
        border-bottom: none;
        border-radius: 4px 4px 0 0;
        padding: 10px 20px;
        color: rgb(200, 190, 170);
        font-weight: bold;
    }
    QTabBar::tab:selected {
        background-color: rgb(55, 50, 40);
        color: rgb(240, 220, 180);
    }
    QScrollArea {
        border: none;
        background-color: transparent;
    }
    QFrame#tripRow {
        background-color: rgb(35, 32, 28);
        border: 1px solid rgb(70, 62, 50);
        border-radius: 6px;
    }
    QFrame#tripRow:hover {
        background-color: rgb(45, 40, 35);
    }
    QFrame#statsBox {
        background-color: rgb(30, 28, 24);
        border: 1px solid rgb(80, 70, 55);
        border-radius: 8px;
        padding: 10px;
    }
"""


class TripRowWidget(QFrame):
    """A single trip row in the history list."""

    clicked = Signal(int)  # trip_id

    def __init__(self, trip: dict):
        super().__init__()
        self.trip_id = trip["id"]
        self.setObjectName("tripRow")
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedHeight(70)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)

        # Date/time
        start_dt = datetime.fromtimestamp(trip["start_ts"])
        date_label = QLabel(start_dt.strftime("%b %d, %Y"))
        date_label.setFont(QFont("", 11, QFont.Bold))
        time_label = QLabel(start_dt.strftime("%I:%M %p"))
        time_label.setStyleSheet("color: rgb(160, 150, 140);")

        date_col = QVBoxLayout()
        date_col.addWidget(date_label)
        date_col.addWidget(time_label)
        layout.addLayout(date_col, 2)

        # Distance / Duration
        dist = trip.get("distance_mi") or 0
        dur = trip.get("duration_secs") or 0
        dist_label = QLabel(f"{dist:.1f} mi")
        dist_label.setFont(QFont("", 12, QFont.Bold))
        dur_label = QLabel(format_duration(dur))
        dur_label.setStyleSheet("color: rgb(160, 150, 140);")

        stats_col = QVBoxLayout()
        stats_col.addWidget(dist_label)
        stats_col.addWidget(dur_label)
        layout.addLayout(stats_col, 1)

        # Max temps
        max_trans = trip.get("max_trans_f")
        max_cool = trip.get("max_coolant_f")
        trans_text = f"{max_trans:.0f}F" if max_trans else "--"
        cool_text = f"{max_cool:.0f}F" if max_cool else "--"

        trans_label = QLabel(f"Trans: {trans_text}")
        cool_label = QLabel(f"Cool: {cool_text}")
        cool_label.setStyleSheet("color: rgb(160, 150, 140);")

        temp_col = QVBoxLayout()
        temp_col.addWidget(trans_label)
        temp_col.addWidget(cool_label)
        layout.addLayout(temp_col, 1)

        # Warning indicator
        had_warn = (trip.get("trans_warn_secs") or 0) > 0 or (trip.get("coolant_warn_secs") or 0) > 0
        if had_warn:
            warn_label = QLabel("!")
            warn_label.setFixedSize(24, 24)
            warn_label.setAlignment(Qt.AlignCenter)
            warn_label.setStyleSheet(
                "background-color: rgb(180, 80, 30); border-radius: 12px; font-weight: bold;"
            )
            layout.addWidget(warn_label)

        # Arrow
        arrow = QLabel(">")
        arrow.setStyleSheet("color: rgb(120, 110, 100); font-size: 18px;")
        layout.addWidget(arrow)

    def mousePressEvent(self, event):
        self.clicked.emit(self.trip_id)


class TripHistoryTab(QWidget):
    """Tab showing trip history list."""

    trip_selected = Signal(int)  # trip_id

    def __init__(self, logging_service: LoggingService):
        super().__init__()
        self.logging_service = logging_service

        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)

        # Scroll area for trips
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        self.list_widget = QWidget()
        self.list_layout = QVBoxLayout(self.list_widget)
        self.list_layout.setSpacing(8)
        self.list_layout.setAlignment(Qt.AlignTop)

        scroll.setWidget(self.list_widget)
        layout.addWidget(scroll)

        self.refresh()

    def refresh(self):
        """Reload trip list from database."""
        # Clear existing
        while self.list_layout.count():
            item = self.list_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        # Load trips
        trips = self.logging_service.get_recent_trips(50)

        if not trips:
            empty_label = QLabel("No trips recorded yet.")
            empty_label.setAlignment(Qt.AlignCenter)
            empty_label.setStyleSheet("color: rgb(140, 130, 120); font-size: 14px;")
            self.list_layout.addWidget(empty_label)
            return

        for trip in trips:
            row = TripRowWidget(trip)
            row.clicked.connect(self.trip_selected.emit)
            self.list_layout.addWidget(row)


class StatsTab(QWidget):
    """Tab showing monthly and all-time statistics."""

    def __init__(self, logging_service: LoggingService):
        super().__init__()
        self.logging_service = logging_service

        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(15)

        # This month
        self.month_box = self._create_stats_box("THIS MONTH")
        layout.addWidget(self.month_box)

        # All time
        self.alltime_box = self._create_stats_box("ALL TIME")
        layout.addWidget(self.alltime_box)

        # Insights
        self.insights_box = self._create_stats_box("INSIGHTS")
        layout.addWidget(self.insights_box)

        layout.addStretch()

        self.refresh()

    def _create_stats_box(self, title: str) -> QFrame:
        """Create a stats box frame."""
        box = QFrame()
        box.setObjectName("statsBox")

        layout = QVBoxLayout(box)
        layout.setContentsMargins(12, 10, 12, 10)

        title_label = QLabel(title)
        title_label.setFont(QFont("", 11, QFont.Bold))
        title_label.setStyleSheet("color: rgb(200, 180, 140);")
        layout.addWidget(title_label)

        content = QLabel("Loading...")
        content.setObjectName("content")
        content.setWordWrap(True)
        layout.addWidget(content)

        return box

    def refresh(self):
        """Reload stats from database."""
        now = datetime.now()

        # This month
        month_stats = self.logging_service.get_monthly_stats(now.year, now.month)
        month_content = self.month_box.findChild(QLabel, "content")
        if month_stats:
            lines = [
                f"Trips: {month_stats.get('trip_count', 0)}",
                f"Miles: {month_stats.get('total_miles', 0):.1f}",
                f"Max Trans: {month_stats.get('max_trans_f', '--')}F",
                f"Avg Trans: {month_stats.get('avg_trans_f', '--'):.0f}F" if month_stats.get('avg_trans_f') else "Avg Trans: --",
                f"Time > Warning: {format_warn_time(month_stats.get('total_warn_secs', 0))}",
            ]
            month_content.setText("\n".join(lines))
        else:
            month_content.setText("No data this month")

        # All time
        alltime_stats = self.logging_service.get_all_time_stats()
        alltime_content = self.alltime_box.findChild(QLabel, "content")
        if alltime_stats and alltime_stats.get("trip_count", 0) > 0:
            first_date = alltime_stats.get("first_trip_date")
            since = first_date.strftime("%b %Y") if first_date else "start"
            lines = [
                f"Since: {since}",
                f"Trips: {alltime_stats.get('trip_count', 0)}",
                f"Miles: {alltime_stats.get('total_miles', 0):.1f}",
                f"Max Trans Ever: {alltime_stats.get('max_trans_f', '--')}F",
                f"Total Warn Time: {format_warn_time(alltime_stats.get('total_warn_secs', 0))}",
            ]
            alltime_content.setText("\n".join(lines))
        else:
            alltime_content.setText("No data yet")

        # Insights
        insights_content = self.insights_box.findChild(QLabel, "content")

        # Compute insights
        breadcrumbs = self.logging_service.get_recent_breadcrumbs(2000)
        correlation = compute_grade_temp_correlation(breadcrumbs)

        # Get last month stats for comparison
        last_month = now.month - 1 if now.month > 1 else 12
        last_year = now.year if now.month > 1 else now.year - 1
        last_month_stats = self.logging_service.get_monthly_stats(last_year, last_month)

        from promaster_dash.services.trip_analytics import MonthlyStats
        current = MonthlyStats(
            year=now.year, month=now.month,
            trip_count=month_stats.get("trip_count", 0),
            total_miles=month_stats.get("total_miles", 0),
            total_duration_secs=month_stats.get("total_duration_secs", 0),
            max_trans_f=month_stats.get("max_trans_f"),
            max_trans_date=month_stats.get("max_trans_date"),
            max_coolant_f=month_stats.get("max_coolant_f"),
            avg_trans_f=month_stats.get("avg_trans_f"),
            avg_coolant_f=month_stats.get("avg_coolant_f"),
            total_warn_secs=month_stats.get("total_warn_secs", 0),
        ) if month_stats else None

        last = MonthlyStats(
            year=last_year, month=last_month,
            trip_count=last_month_stats.get("trip_count", 0),
            total_miles=last_month_stats.get("total_miles", 0),
            total_duration_secs=last_month_stats.get("total_duration_secs", 0),
            max_trans_f=last_month_stats.get("max_trans_f"),
            max_trans_date=last_month_stats.get("max_trans_date"),
            max_coolant_f=last_month_stats.get("max_coolant_f"),
            avg_trans_f=last_month_stats.get("avg_trans_f"),
            avg_coolant_f=last_month_stats.get("avg_coolant_f"),
            total_warn_secs=last_month_stats.get("total_warn_secs", 0),
        ) if last_month_stats else None

        insights = generate_insights(current, last, correlation, breadcrumbs)

        if insights.messages:
            insights_content.setText("\n".join(f"- {m}" for m in insights.messages))
        else:
            insights_content.setText("Not enough data for insights yet")


class TripDetailDialog(QDialog):
    """Dialog showing detailed trip information with chart."""

    def __init__(self, trip_id: int, logging_service: LoggingService, parent=None):
        super().__init__(parent)
        self.trip_id = trip_id
        self.logging_service = logging_service
        self.setWindowTitle("Trip Details")
        self.setFixedSize(900, 550)
        self.setStyleSheet(DIALOG_STYLE)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(12)

        # Load trip data
        trip_data = logging_service.get_trip_with_breadcrumbs(trip_id)
        if not trip_data:
            layout.addWidget(QLabel("Trip not found"))
            return

        # Header
        start_dt = datetime.fromtimestamp(trip_data["start_ts"])
        header = QLabel(start_dt.strftime("%B %d, %Y - %I:%M %p"))
        header.setFont(QFont("", 14, QFont.Bold))
        header.setStyleSheet("color: rgb(240, 220, 180);")
        layout.addWidget(header)

        # Stats row
        stats_row = QHBoxLayout()

        # Left stats
        left_stats = QVBoxLayout()
        dist = trip_data.get("distance_mi") or 0
        dur = trip_data.get("duration_secs") or 0
        avg_spd = trip_data.get("avg_speed_mph") or 0

        left_stats.addWidget(QLabel(f"Distance: {dist:.1f} mi"))
        left_stats.addWidget(QLabel(f"Duration: {format_duration(dur)}"))
        left_stats.addWidget(QLabel(f"Avg Speed: {avg_spd:.0f} mph"))
        stats_row.addLayout(left_stats)

        # Trans stats
        trans_box = QFrame()
        trans_box.setObjectName("statsBox")
        trans_layout = QVBoxLayout(trans_box)
        trans_layout.setContentsMargins(10, 8, 10, 8)

        trans_title = QLabel("TRANS TEMP")
        trans_title.setFont(QFont("", 10, QFont.Bold))
        trans_title.setStyleSheet("color: rgb(220, 140, 35);")
        trans_layout.addWidget(trans_title)

        max_trans = trip_data.get("max_trans_f")
        breadcrumbs = trip_data.get("breadcrumbs", [])
        trans_temps = [b.trans_f for b in breadcrumbs if b.trans_f]
        avg_trans = sum(trans_temps) / len(trans_temps) if trans_temps else None

        trans_layout.addWidget(QLabel(f"Max: {max_trans:.0f}F" if max_trans else "Max: --"))
        trans_layout.addWidget(QLabel(f"Avg: {avg_trans:.0f}F" if avg_trans else "Avg: --"))
        warn_secs = trip_data.get("trans_warn_secs") or 0
        trans_layout.addWidget(QLabel(f"Time > 230F: {format_warn_time(warn_secs)}"))

        stats_row.addWidget(trans_box)

        # Coolant stats
        cool_box = QFrame()
        cool_box.setObjectName("statsBox")
        cool_layout = QVBoxLayout(cool_box)
        cool_layout.setContentsMargins(10, 8, 10, 8)

        cool_title = QLabel("COOLANT")
        cool_title.setFont(QFont("", 10, QFont.Bold))
        cool_title.setStyleSheet("color: rgb(100, 160, 200);")
        cool_layout.addWidget(cool_title)

        max_cool = trip_data.get("max_coolant_f")
        cool_temps = [b.coolant_f for b in breadcrumbs if b.coolant_f]
        avg_cool = sum(cool_temps) / len(cool_temps) if cool_temps else None

        cool_layout.addWidget(QLabel(f"Max: {max_cool:.0f}F" if max_cool else "Max: --"))
        cool_layout.addWidget(QLabel(f"Avg: {avg_cool:.0f}F" if avg_cool else "Avg: --"))
        cool_warn_secs = trip_data.get("coolant_warn_secs") or 0
        cool_layout.addWidget(QLabel(f"Time > 220F: {format_warn_time(cool_warn_secs)}"))

        stats_row.addWidget(cool_box)

        layout.addLayout(stats_row)

        # Chart
        chart = TempTimelineChart()
        chart.setMinimumHeight(200)
        chart.set_data(breadcrumbs, trip_data.get("events", []))
        layout.addWidget(chart)

        # Buttons
        btn_row = QHBoxLayout()

        back_btn = QPushButton("BACK")
        back_btn.clicked.connect(self.accept)
        btn_row.addWidget(back_btn)

        btn_row.addStretch()

        export_btn = QPushButton("EXPORT GPX")
        export_btn.clicked.connect(lambda: self._export_gpx(trip_data))
        btn_row.addWidget(export_btn)

        delete_btn = QPushButton("DELETE")
        delete_btn.setStyleSheet(
            "background-color: rgb(100, 40, 35); border-color: rgb(150, 60, 50);"
        )
        delete_btn.clicked.connect(self._confirm_delete)
        btn_row.addWidget(delete_btn)

        layout.addLayout(btn_row)

    def _export_gpx(self, trip_data: dict):
        """Export trip to GPX file."""
        breadcrumbs = trip_data.get("breadcrumbs", [])
        if not breadcrumbs:
            QMessageBox.warning(self, "Export", "No GPS data to export")
            return

        filename = GPXExporter.generate_filename(self.trip_id, trip_data["start_ts"])
        export_path = get_exports_dir() / filename

        if GPXExporter.export_trip(breadcrumbs, export_path):
            QMessageBox.information(
                self, "Export", f"Exported to:\n{export_path}"
            )
        else:
            QMessageBox.warning(self, "Export", "Export failed")

    def _confirm_delete(self):
        """Confirm and delete trip."""
        reply = QMessageBox.question(
            self,
            "Delete Trip",
            "Are you sure you want to delete this trip?\nThis cannot be undone.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )

        if reply == QMessageBox.Yes:
            if self.logging_service.delete_trip(self.trip_id):
                self.reject()  # Close with rejection to signal deletion
            else:
                QMessageBox.warning(self, "Delete", "Failed to delete trip")


class TripDataDialog(QDialog):
    """Main trip data dialog with History and Stats tabs."""

    def __init__(self, logging_service: LoggingService, parent=None):
        super().__init__(parent)
        self.logging_service = logging_service
        self.setWindowTitle("Trip Data")
        self.setFixedSize(900, 550)
        self.setStyleSheet(DIALOG_STYLE)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)

        # Tab widget
        tabs = QTabWidget()

        # History tab
        self.history_tab = TripHistoryTab(logging_service)
        self.history_tab.trip_selected.connect(self._open_trip_detail)
        tabs.addTab(self.history_tab, "HISTORY")

        # Stats tab
        self.stats_tab = StatsTab(logging_service)
        tabs.addTab(self.stats_tab, "STATS")

        layout.addWidget(tabs)

        # Close button
        close_btn = QPushButton("CLOSE")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)

    def _open_trip_detail(self, trip_id: int):
        """Open trip detail dialog."""
        detail = TripDetailDialog(trip_id, self.logging_service, self)
        result = detail.exec()

        # Refresh list if trip was deleted
        if result == QDialog.Rejected:
            self.history_tab.refresh()
            self.stats_tab.refresh()
