"""Temperature timeline chart widget using QPainter."""

from __future__ import annotations

from typing import List, Optional, Tuple

from PySide6.QtCore import Qt, QRectF, QPointF
from PySide6.QtGui import QColor, QPainter, QPen, QBrush, QFont, QPainterPath
from PySide6.QtWidgets import QWidget

from promaster_dash.models.data_records import BreadcrumbRecord, EventRecord
from promaster_dash.models.vehicle_state import TRANS_WARN, COOL_WARN


class TempTimelineChart(QWidget):
    """
    Custom chart widget showing temperature over time with grade overlay.

    Features:
    - Trans temp line (amber)
    - Coolant temp line (blue)
    - Grade % as subtle background shading
    - Warning threshold dashed line
    - Event markers (red dots for alerts)
    """

    # Colors matching dashboard theme
    COLOR_BG = QColor(22, 20, 16, 240)
    COLOR_GRID = QColor(60, 55, 45, 150)
    COLOR_TRANS = QColor(220, 140, 35, 230)
    COLOR_COOLANT = QColor(100, 160, 200, 200)
    COLOR_GRADE_POS = QColor(80, 120, 80, 60)  # Climbing
    COLOR_GRADE_NEG = QColor(80, 80, 120, 60)  # Descending
    COLOR_WARN = QColor(230, 120, 25, 180)
    COLOR_EVENT = QColor(200, 50, 40, 220)
    COLOR_TEXT = QColor(200, 190, 170, 220)

    # Layout
    MARGIN_LEFT = 55
    MARGIN_RIGHT = 15
    MARGIN_TOP = 20
    MARGIN_BOTTOM = 35

    def __init__(self):
        super().__init__()
        self.breadcrumbs: List[BreadcrumbRecord] = []
        self.events: List[EventRecord] = []
        self.show_coolant = True
        self.show_grade = True

        # Temperature range
        self.temp_min = 140.0
        self.temp_max = 280.0

        self.setMinimumSize(400, 180)

    def set_data(
        self,
        breadcrumbs: List[BreadcrumbRecord],
        events: Optional[List[EventRecord]] = None,
    ):
        """Set the data to display."""
        self.breadcrumbs = breadcrumbs
        self.events = events or []

        # Auto-scale temperature range
        if breadcrumbs:
            temps = []
            for b in breadcrumbs:
                if b.trans_f is not None:
                    temps.append(b.trans_f)
                if b.coolant_f is not None:
                    temps.append(b.coolant_f)

            if temps:
                self.temp_min = max(100, min(temps) - 20)
                self.temp_max = min(320, max(temps) + 20)

        self.update()

    def paintEvent(self, event):
        if not self.breadcrumbs:
            self._paint_empty()
            return

        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)

        rect = self.rect()
        chart_rect = QRectF(
            self.MARGIN_LEFT,
            self.MARGIN_TOP,
            rect.width() - self.MARGIN_LEFT - self.MARGIN_RIGHT,
            rect.height() - self.MARGIN_TOP - self.MARGIN_BOTTOM,
        )

        # Background
        p.fillRect(rect, self.COLOR_BG)

        # Time range
        start_ts = self.breadcrumbs[0].ts
        end_ts = self.breadcrumbs[-1].ts
        duration = max(end_ts - start_ts, 1)

        # Draw grade background
        if self.show_grade:
            self._draw_grade_background(p, chart_rect, start_ts, duration)

        # Draw grid
        self._draw_grid(p, chart_rect, start_ts, duration)

        # Draw warning threshold
        self._draw_threshold(p, chart_rect, TRANS_WARN, "Trans Warn")

        # Draw temperature lines
        self._draw_temp_line(p, chart_rect, start_ts, duration, "trans")
        if self.show_coolant:
            self._draw_temp_line(p, chart_rect, start_ts, duration, "coolant")

        # Draw event markers
        self._draw_events(p, chart_rect, start_ts, duration)

        # Draw axes
        self._draw_axes(p, chart_rect, start_ts, duration)

    def _paint_empty(self):
        """Paint empty state."""
        p = QPainter(self)
        p.fillRect(self.rect(), self.COLOR_BG)
        p.setPen(self.COLOR_TEXT)
        p.setFont(QFont("", 12))
        p.drawText(self.rect(), Qt.AlignCenter, "No data")

    def _ts_to_x(self, ts: float, chart_rect: QRectF, start_ts: float, duration: float) -> float:
        """Convert timestamp to X coordinate."""
        t = (ts - start_ts) / duration
        return chart_rect.left() + t * chart_rect.width()

    def _temp_to_y(self, temp: float, chart_rect: QRectF) -> float:
        """Convert temperature to Y coordinate."""
        t = (temp - self.temp_min) / (self.temp_max - self.temp_min)
        return chart_rect.bottom() - t * chart_rect.height()

    def _draw_grade_background(
        self, p: QPainter, chart_rect: QRectF, start_ts: float, duration: float
    ):
        """Draw grade as background shading."""
        for i, b in enumerate(self.breadcrumbs):
            if b.grade_pct is None:
                continue

            x = self._ts_to_x(b.ts, chart_rect, start_ts, duration)

            # Width to next point or small default
            if i + 1 < len(self.breadcrumbs):
                next_x = self._ts_to_x(self.breadcrumbs[i + 1].ts, chart_rect, start_ts, duration)
                width = next_x - x
            else:
                width = 5

            # Color based on grade
            if b.grade_pct > 1:
                color = self.COLOR_GRADE_POS
                alpha = min(100, int(abs(b.grade_pct) * 10))
                color.setAlpha(alpha)
            elif b.grade_pct < -1:
                color = self.COLOR_GRADE_NEG
                alpha = min(100, int(abs(b.grade_pct) * 10))
                color.setAlpha(alpha)
            else:
                continue

            p.fillRect(QRectF(x, chart_rect.top(), width, chart_rect.height()), color)

    def _draw_grid(
        self, p: QPainter, chart_rect: QRectF, start_ts: float, duration: float
    ):
        """Draw grid lines."""
        p.setPen(QPen(self.COLOR_GRID, 1, Qt.DotLine))

        # Horizontal lines every 50 degrees
        for temp in range(int(self.temp_min), int(self.temp_max) + 1, 50):
            if temp <= self.temp_min or temp >= self.temp_max:
                continue
            y = self._temp_to_y(temp, chart_rect)
            p.drawLine(QPointF(chart_rect.left(), y), QPointF(chart_rect.right(), y))

        # Vertical lines every ~10 minutes
        interval = 600  # 10 minutes
        t = start_ts + interval
        while t < start_ts + duration:
            x = self._ts_to_x(t, chart_rect, start_ts, duration)
            p.drawLine(QPointF(x, chart_rect.top()), QPointF(x, chart_rect.bottom()))
            t += interval

    def _draw_threshold(self, p: QPainter, chart_rect: QRectF, threshold: float, label: str):
        """Draw warning threshold line."""
        if threshold < self.temp_min or threshold > self.temp_max:
            return

        y = self._temp_to_y(threshold, chart_rect)
        p.setPen(QPen(self.COLOR_WARN, 1, Qt.DashLine))
        p.drawLine(QPointF(chart_rect.left(), y), QPointF(chart_rect.right(), y))

    def _draw_temp_line(
        self,
        p: QPainter,
        chart_rect: QRectF,
        start_ts: float,
        duration: float,
        temp_type: str,
    ):
        """Draw temperature line."""
        color = self.COLOR_TRANS if temp_type == "trans" else self.COLOR_COOLANT
        p.setPen(QPen(color, 2))

        path = QPainterPath()
        first = True

        for b in self.breadcrumbs:
            temp = b.trans_f if temp_type == "trans" else b.coolant_f
            if temp is None:
                continue

            x = self._ts_to_x(b.ts, chart_rect, start_ts, duration)
            y = self._temp_to_y(temp, chart_rect)

            if first:
                path.moveTo(x, y)
                first = False
            else:
                path.lineTo(x, y)

        p.drawPath(path)

    def _draw_events(
        self, p: QPainter, chart_rect: QRectF, start_ts: float, duration: float
    ):
        """Draw event markers."""
        for ev in self.events:
            if ev.event_type not in ("alert",):
                continue

            # Find Y position from nearest breadcrumb
            x = self._ts_to_x(ev.ts, chart_rect, start_ts, duration)

            # Default to middle of chart
            y = chart_rect.center().y()

            # Find nearest breadcrumb for temp
            nearest = None
            nearest_dist = float("inf")
            for b in self.breadcrumbs:
                dist = abs(b.ts - ev.ts)
                if dist < nearest_dist:
                    nearest_dist = dist
                    nearest = b

            if nearest and nearest.trans_f is not None:
                y = self._temp_to_y(nearest.trans_f, chart_rect)

            # Draw marker
            p.setBrush(QBrush(self.COLOR_EVENT))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x, y), 5, 5)

    def _draw_axes(
        self, p: QPainter, chart_rect: QRectF, start_ts: float, duration: float
    ):
        """Draw axis labels."""
        p.setPen(self.COLOR_TEXT)
        font = QFont("", 9)
        p.setFont(font)

        # Y-axis labels (temperature)
        for temp in range(int(self.temp_min), int(self.temp_max) + 1, 50):
            y = self._temp_to_y(temp, chart_rect)
            p.drawText(
                QRectF(0, y - 10, self.MARGIN_LEFT - 5, 20),
                Qt.AlignRight | Qt.AlignVCenter,
                f"{temp}F",
            )

        # X-axis labels (time)
        # Show start and end, plus some intermediate
        from datetime import datetime

        def format_time(ts):
            return datetime.fromtimestamp(ts).strftime("%H:%M")

        # Start
        x = chart_rect.left()
        p.drawText(
            QRectF(x - 20, chart_rect.bottom() + 5, 50, 20),
            Qt.AlignCenter,
            format_time(start_ts),
        )

        # End
        x = chart_rect.right()
        p.drawText(
            QRectF(x - 30, chart_rect.bottom() + 5, 50, 20),
            Qt.AlignCenter,
            format_time(start_ts + duration),
        )

        # Duration label
        mins = int(duration // 60)
        if mins >= 60:
            dur_text = f"{mins // 60}h {mins % 60}m"
        else:
            dur_text = f"{mins}m"

        p.drawText(
            QRectF(chart_rect.center().x() - 30, chart_rect.bottom() + 5, 60, 20),
            Qt.AlignCenter,
            dur_text,
        )

        # Legend
        legend_x = chart_rect.left() + 10
        legend_y = chart_rect.top() + 5

        # Trans temp
        p.setPen(QPen(self.COLOR_TRANS, 2))
        p.drawLine(QPointF(legend_x, legend_y + 5), QPointF(legend_x + 20, legend_y + 5))
        p.setPen(self.COLOR_TEXT)
        p.drawText(QPointF(legend_x + 25, legend_y + 10), "Trans")

        # Coolant
        if self.show_coolant:
            legend_x += 70
            p.setPen(QPen(self.COLOR_COOLANT, 2))
            p.drawLine(QPointF(legend_x, legend_y + 5), QPointF(legend_x + 20, legend_y + 5))
            p.setPen(self.COLOR_TEXT)
            p.drawText(QPointF(legend_x + 25, legend_y + 10), "Coolant")
