from __future__ import annotations

import random
import time
from collections import deque
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QTimer, QRect, QThread, Slot
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

# Import models and services
from promaster_dash.models.vehicle_state import (
    VehicleState,
    TRANS_RANGE,
    TRANS_WARN,
    TRANS_CRIT,
    COOL_RANGE,
    COOL_WARN,
    COOL_CRIT,
    VOLT_RANGE,
    VOLT_LOW,
    VOLT_HIGH,
)
from promaster_dash.models.data_records import GPSData, BreadcrumbRecord, EventRecord
from promaster_dash.services.logging_service import LoggingService
from promaster_dash.services.gps_service import GPSService, MockGPSService
from promaster_dash.services.trip_manager import TripManager
from promaster_dash.ui.trip_dialogs import TripDataDialog
from promaster_dash.ui.settings_dialog import SettingsDialog
from promaster_dash.data.dtc_lookup import DTCLookup
from promaster_dash.config.settings import Settings

# repo root: .../src/promaster_dash/ui/app.py -> parents[3] == repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
ASSETS_DIR = REPO_ROOT / "assets" / "backgrounds"

SEGMENTS = 14  # segment bar segments


# ----------------------------
# Small widgets
# ----------------------------


class SegmentBar(QWidget):
    """
    Draws the segmented bar at the bottom of each card, with threshold colors.
    """

    def __init__(self, segments: int = SEGMENTS):
        super().__init__()
        self._segments = segments
        self._filled = 0
        self._mode = "temp"  # "temp" or "volt"
        self._value = None
        self._label = ""  # e.g., "CAUTION", "HI", "LOW"
        self.setMinimumHeight(34)
        self.setMaximumHeight(34)

    def set_temp(
        self, value: Optional[float], vmin: float, vmax: float, warn: float, crit: float
    ):
        self._mode = "temp"
        self._value = value
        self._label = ""
        if value is None:
            self._filled = 0
            self.update()
            return

        self._filled = self._calc_fill(value, vmin, vmax)
        if value >= crit:
            self._label = "DANGER"
        elif value >= warn:
            self._label = "CAUTION"
        self.update()

    def set_volt(
        self, value: Optional[float], vmin: float, vmax: float, low: float, high: float
    ):
        self._mode = "volt"
        self._value = value
        self._label = ""
        if value is None:
            self._filled = 0
            self.update()
            return

        self._filled = self._calc_fill(value, vmin, vmax)
        if value < low:
            self._label = "LOW"
        elif value > high:
            self._label = "HIGH"
        else:
            self._label = "OK"
        self.update()

    def _calc_fill(self, value: float, vmin: float, vmax: float) -> int:
        value = max(vmin, min(vmax, value))
        t = (value - vmin) / (vmax - vmin)
        return int(round(t * self._segments))

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)

        r = self.rect().adjusted(6, 8, -6, -8)
        seg_gap = 3
        seg_w = int((r.width() - (self._segments - 1) * seg_gap) / self._segments)
        seg_h = r.height()

        # Colors (match mock vibe: amber -> red)
        col_empty = QColor(80, 70, 55, 180)
        col_ok = QColor(220, 140, 35, 220)
        col_warn = QColor(230, 120, 25, 235)
        col_crit = QColor(180, 35, 25, 240)

        # Determine threshold zone for each segment
        def seg_color(i: int) -> QColor:
            # i is 1..segments
            if self._mode == "temp":
                # last ~3 segments red, previous ~3 orange, rest amber
                if i >= self._segments - 2:
                    return col_crit
                if i >= self._segments - 5:
                    return col_warn
                return col_ok
            else:
                # voltage: center "ok" amber, extremes red-ish
                # keep visual simple: filled = amber, label indicates low/high
                return col_ok

        for i in range(self._segments):
            x = r.left() + i * (seg_w + seg_gap)
            seg = QRect(x, r.top(), seg_w, seg_h)

            if i < self._filled:
                p.fillRect(seg, seg_color(i + 1))
            else:
                p.fillRect(seg, col_empty)

        # Center label (CAUTION / LOW etc)
        if self._label:
            p.setPen(QColor(255, 235, 200, 230))
            p.setFont(self.font())
            p.drawText(self.rect(), Qt.AlignCenter, self._label)


class MetalCard(QFrame):
    """
    A rugged "panel" card look like the mock. We paint a bevel + border + inner matte.
    """

    def __init__(self):
        super().__init__()
        self.setObjectName("metalCard")
        self.setMinimumHeight(240)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)

        r = self.rect().adjusted(1, 1, -1, -1)
        radius = 10

        path = QPainterPath()
        path.addRoundedRect(r, radius, radius)
        p.setClipPath(path)

        # Outer frame
        p.fillRect(r, QColor(70, 62, 48, 220))

        # Inner matte
        inner = r.adjusted(6, 6, -6, -6)
        inner_path = QPainterPath()
        inner_path.addRoundedRect(inner, radius - 2, radius - 2)
        p.setClipPath(inner_path)
        p.fillRect(inner, QColor(22, 20, 16, 235))

        # subtle highlight band
        p.setClipping(False)
        pen = QPen(QColor(255, 255, 255, 35), 1)
        p.setPen(pen)
        p.drawRoundedRect(r, radius, radius)

        super().paintEvent(event)


class GaugePanel(MetalCard):
    def __init__(self, title: str):
        super().__init__()

        self._title_text = title

        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 14, 18, 14)
        lay.setSpacing(8)

        self.title = QLabel(title)
        self.title.setObjectName("cardTitle")
        lay.addWidget(self.title)

        # Big value line (we'll include unit inline like "225F" or "11.8v")
        self.value = QLabel("--")
        self.value.setObjectName("cardValue")
        lay.addWidget(self.value)

        # Spacer
        lay.addStretch(1)

        # Segment bar at bottom
        self.bar = SegmentBar(segments=SEGMENTS)
        self.bar.setObjectName("segBar")
        lay.addWidget(self.bar)

    def set_value(self, txt: str):
        self.value.setText(txt)


class LiveTripPanel(QFrame):
    """
    Small panel showing current trip stats during an active trip.

    Displays: distance, duration, max trans temp, status indicator.
    Tappable to open current trip detail.
    """

    clicked = None  # Will be set by parent if needed

    def __init__(self):
        super().__init__()
        self.setObjectName("liveTripPanel")
        self.setFixedHeight(52)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 8, 16, 8)
        lay.setSpacing(20)

        # Title
        title = QLabel("CURRENT TRIP")
        title.setObjectName("liveTripTitle")
        lay.addWidget(title)

        # Distance
        self.distance_lbl = QLabel("0.0 mi")
        self.distance_lbl.setObjectName("liveTripStat")
        lay.addWidget(self.distance_lbl)

        # Separator
        sep1 = QLabel("•")
        sep1.setObjectName("liveTripSep")
        lay.addWidget(sep1)

        # Duration
        self.duration_lbl = QLabel("0 min")
        self.duration_lbl.setObjectName("liveTripStat")
        lay.addWidget(self.duration_lbl)

        # Separator
        sep2 = QLabel("•")
        sep2.setObjectName("liveTripSep")
        lay.addWidget(sep2)

        # Max trans
        self.max_trans_lbl = QLabel("Max Trans: --°F")
        self.max_trans_lbl.setObjectName("liveTripStat")
        lay.addWidget(self.max_trans_lbl)

        # Separator
        sep3 = QLabel("•")
        sep3.setObjectName("liveTripSep")
        lay.addWidget(sep3)

        # Status indicator
        self.status_lbl = QLabel("OK")
        self.status_lbl.setObjectName("liveTripStatusOk")
        lay.addWidget(self.status_lbl)

        lay.addStretch(1)

    def update_stats(self, distance_mi: float, duration_secs: float, max_trans_f: float | None, warn: bool):
        """Update the live trip stats display."""
        self.distance_lbl.setText(f"{distance_mi:.1f} mi")

        mins = int(duration_secs // 60)
        if mins >= 60:
            hours = mins // 60
            mins = mins % 60
            self.duration_lbl.setText(f"{hours}h {mins}m")
        else:
            self.duration_lbl.setText(f"{mins} min")

        if max_trans_f is not None:
            self.max_trans_lbl.setText(f"Max Trans: {max_trans_f:.0f}°F")
        else:
            self.max_trans_lbl.setText("Max Trans: --°F")

        if warn:
            self.status_lbl.setText("WARN")
            self.status_lbl.setObjectName("liveTripStatusWarn")
        else:
            self.status_lbl.setText("OK")
            self.status_lbl.setObjectName("liveTripStatusOk")
        self.status_lbl.style().unpolish(self.status_lbl)
        self.status_lbl.style().polish(self.status_lbl)

    def mousePressEvent(self, event):
        """Handle tap on the panel."""
        if callable(self.clicked):
            self.clicked()


# ----------------------------
# Main Window
# ----------------------------


class MainWindow(QMainWindow):
    def __init__(self, start_night: bool = False, mock: bool = True):
        super().__init__()
        self.setWindowTitle("ProMaster Adventure Dash")
        self.setFixedSize(1024, 600)

        # Load settings
        self.settings = Settings.load()

        self.state = VehicleState(trip_start_ts=time.time())
        self.is_night = start_night or self.settings.start_night_mode
        self.mock = mock

        self.alert_history = deque(maxlen=200)
        self._last_alert_text = ""
        self._last_ui_tick_ts = time.time()
        self.dtc_codes: list[str] = []  # Current DTC codes

        # Services (initialized later)
        self.logging_service: Optional[LoggingService] = None
        self.gps_service: Optional[GPSService] = None
        self.mock_gps_service: Optional[MockGPSService] = None
        self.trip_manager: Optional[TripManager] = None
        self.gps_thread: Optional[QThread] = None

        root = QWidget()
        self.setCentralWidget(root)
        root.setContentsMargins(0, 0, 0, 0)

        # Background
        self.bg = QLabel(root)
        self.bg.setGeometry(0, 0, 1024, 600)
        self.bg.setScaledContents(True)

        # Foreground
        self.fg = QWidget(root)
        self.fg.setGeometry(0, 0, 1024, 600)

        main = QVBoxLayout(self.fg)
        main.setContentsMargins(18, 16, 18, 14)
        main.setSpacing(10)

        # --- Top bar ---
        top = QHBoxLayout()
        top.setSpacing(10)

        self.trip_pill = self._top_pill("TRIP 00:00:00", align=Qt.AlignLeft)
        self.heading_pill = self._top_pill("NE 075", big=True, align=Qt.AlignCenter)
        self.elev_pill = self._top_pill("ELEV: -- FT", align=Qt.AlignCenter)
        self.grade_pill = self._top_pill("GRADE: -- %", align=Qt.AlignCenter)

        self.gps_pill = self._top_pill("GPS: --", align=Qt.AlignCenter)
        self.mil_pill = self._top_pill("MIL", align=Qt.AlignCenter, danger=False)

        top.addWidget(self.trip_pill, 2)
        top.addWidget(self.heading_pill, 3)
        top.addWidget(self.elev_pill, 2)
        top.addWidget(self.grade_pill, 2)
        top.addStretch(1)
        top.addWidget(self.gps_pill, 2)
        top.addWidget(self.mil_pill, 1)

        self.settings_btn = QPushButton("\u2699")  # Gear icon
        self.settings_btn.setObjectName("topBtn")
        self.settings_btn.clicked.connect(self._open_settings)
        top.addWidget(self.settings_btn)

        self.night_btn = QPushButton("Night")
        self.night_btn.setObjectName("topBtn")
        self.night_btn.clicked.connect(self.toggle_night)
        top.addWidget(self.night_btn)

        main.addLayout(top)

        # --- Alert banner ---
        self.alert = QLabel("")
        self.alert.setObjectName("alertBanner")
        self.alert.setVisible(False)
        self.alert.setFixedHeight(62)
        self.alert.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.alert.setAlignment(Qt.AlignVCenter | Qt.AlignLeft)
        self.alert.setIndent(16)
        self.alert.mousePressEvent = self._open_alert_history
        main.addWidget(self.alert)

        # --- Live trip panel (shown during active trip) ---
        self.live_trip_panel = LiveTripPanel()
        self.live_trip_panel.setVisible(False)
        self.live_trip_panel.clicked = self._open_trips_dialog
        main.addWidget(self.live_trip_panel)

        # --- Cards row ---
        cards = QHBoxLayout()
        cards.setSpacing(12)

        self.trans_panel = GaugePanel("TRANS TEMP")
        self.cool_panel = GaugePanel("COOLANT")
        self.volt_panel = GaugePanel("VOLTAGE")

        cards.addWidget(self.trans_panel, 4)
        cards.addWidget(self.cool_panel, 3)
        cards.addWidget(self.volt_panel, 3)

        main.addLayout(cards)

        # --- Bottom bar ---
        bottom = QHBoxLayout()
        bottom.setSpacing(12)

        self.speed_box = self._bottom_box("SPEED", "--", "MPH")
        self.rpm_box = self._bottom_box("RPM", "--", "")

        self.trips_btn = QPushButton("TRIPS")
        self.trips_btn.setObjectName("scanBtn")
        self.trips_btn.setFixedHeight(48)
        self.trips_btn.clicked.connect(self._open_trips_dialog)

        self.scan_btn = QPushButton("SCAN CODES")
        self.scan_btn.setObjectName("scanBtn")
        self.scan_btn.setFixedHeight(48)
        self.scan_btn.clicked.connect(self._open_alert_history)

        bottom.addWidget(self.speed_box, 3)
        bottom.addWidget(self.rpm_box, 3)
        bottom.addStretch(1)
        bottom.addWidget(self.trips_btn, 2)
        bottom.addWidget(self.scan_btn, 3)

        main.addLayout(bottom)

        self._apply_styles()
        self._load_background()

        # Initialize services
        self._init_services()

        # Timers
        self.ui_timer = QTimer(self)
        self.ui_timer.timeout.connect(self._ui_tick)
        self.ui_timer.start(400)

        if self.mock:
            self.mock_timer = QTimer(self)
            self.mock_timer.timeout.connect(self._mock_tick)
            self.mock_timer.start(900)

    def _init_services(self):
        """Initialize logging, GPS, and trip management services."""
        # Logging service (always active)
        self.logging_service = LoggingService()
        self.logging_service.initialize()
        self.logging_service.error_occurred.connect(self._on_logging_error)

        # Run old trip cleanup on startup
        deleted = self.logging_service.cleanup_old_trips()
        if deleted > 0:
            print(f"Cleaned up {deleted} old trips")

        # Trip manager
        self.trip_manager = TripManager(logging_service=self.logging_service)
        self.trip_manager.trip_started.connect(self._on_trip_started)
        self.trip_manager.trip_ended.connect(self._on_trip_ended)
        self.trip_manager.state_changed.connect(self._on_trip_state_changed)

        if self.mock:
            # Mock GPS for development
            self.mock_gps_service = MockGPSService()
            self.mock_gps_service.gps_updated.connect(self._on_gps_update)
            self.mock_gps_service.start()
        else:
            # Real GPS service in thread
            self.gps_service = GPSService()
            self.gps_thread = QThread()
            self.gps_service.moveToThread(self.gps_thread)

            self.gps_service.gps_updated.connect(self._on_gps_update)
            self.gps_service.connection_status.connect(self._on_gps_status)

            self.gps_thread.started.connect(self.gps_service.start)
            self.gps_thread.start()

    def closeEvent(self, event):
        """Handle window close - cleanup services."""
        # Force end any active trip
        if self.trip_manager:
            self.trip_manager.force_end_trip()

        # Stop GPS service
        if self.gps_service:
            self.gps_service.stop()
        if self.gps_thread:
            self.gps_thread.quit()
            self.gps_thread.wait(1000)

        # Close logging
        if self.logging_service:
            self.logging_service.close()

        super().closeEvent(event)

    # ---------- Service slots ----------

    @Slot(object)
    def _on_gps_update(self, data: GPSData):
        """Handle GPS update from service."""
        self.state.gps_ok = data.fix_ok
        self.state.lat = data.lat
        self.state.lon = data.lon
        self.state.speed_mph = data.speed_mph
        self.state.heading_deg = data.heading_deg
        self.state.elevation_ft = data.elevation_ft
        self.state.grade_pct = data.grade_pct
        self.state.climbing = (data.grade_pct or 0) > 0.5

        # Forward to trip manager
        if self.trip_manager:
            self.trip_manager.on_gps_update(data)

        # Log breadcrumb if trip active
        if (
            self.state.current_trip_id is not None
            and data.lat is not None
            and data.lon is not None
            and self.logging_service
        ):
            record = BreadcrumbRecord(
                trip_id=self.state.current_trip_id,
                ts=time.time(),
                lat=data.lat,
                lon=data.lon,
                elevation_ft=data.elevation_ft,
                speed_mph=data.speed_mph,
                heading_deg=data.heading_deg,
                trans_f=self.state.trans_f,
                coolant_f=self.state.coolant_f,
                voltage_v=self.state.voltage_v,
                grade_pct=data.grade_pct,
                obd_speed_mph=self.state.obd_speed_mph,
            )
            self.logging_service.log_breadcrumb(record)

    @Slot(bool, str)
    def _on_gps_status(self, connected: bool, message: str):
        """Handle GPS connection status change."""
        if not connected:
            self.state.gps_ok = False

    @Slot(int)
    def _on_trip_started(self, trip_id: int):
        """Handle trip start."""
        self.state.current_trip_id = trip_id
        self.state.trip_active = True
        self.state.trip_start_ts = time.time()
        self.state.trip_distance_mi = 0.0
        self.live_trip_panel.setVisible(True)

    @Slot(object)
    def _on_trip_ended(self, stats):
        """Handle trip end."""
        self.state.current_trip_id = None
        self.state.trip_active = False
        self.state.trip_distance_mi = stats.distance_mi if stats else 0.0
        self.live_trip_panel.setVisible(False)

    @Slot(str)
    def _on_trip_state_changed(self, state: str):
        """Handle trip state change."""
        pass  # Could update UI indicator

    @Slot(str)
    def _on_logging_error(self, message: str):
        """Handle logging service error."""
        print(f"Logging error: {message}")

    # ---------- UI builders ----------

    def _top_pill(
        self,
        text: str,
        big: bool = False,
        align: Qt.AlignmentFlag = Qt.AlignCenter,
        danger: bool = False,
    ) -> QLabel:
        lbl = QLabel(text)
        lbl.setObjectName(
            "topPillDanger" if danger else ("topPillBig" if big else "topPill")
        )
        lbl.setFixedHeight(44)
        lbl.setAlignment(Qt.AlignVCenter | align)
        return lbl

    def _bottom_box(self, label: str, value: str, unit: str) -> QWidget:
        w = QWidget()
        w.setObjectName("bottomBox")
        lay = QHBoxLayout(w)
        lay.setContentsMargins(14, 8, 14, 8)
        lay.setSpacing(10)

        l = QLabel(label)
        l.setObjectName("bottomLabel")

        v = QLabel(value)
        v.setObjectName("bottomValue")

        u = QLabel(unit)
        u.setObjectName("bottomUnit")

        # store refs for updates
        w._val = v  # type: ignore
        w._unit = u  # type: ignore

        lay.addWidget(l)
        lay.addStretch(1)
        lay.addWidget(v)
        if unit:
            lay.addWidget(u)

        return w

    def _apply_styles(self):
        self.fg.setStyleSheet(
            """
            /* Top bar */
            QLabel#topPill, QLabel#topPillBig, QLabel#topPillDanger {
                background-color: rgba(25, 22, 17, 210);
                border: 1px solid rgba(255, 220, 160, 55);
                border-radius: 8px;
                padding-left: 12px;
                padding-right: 12px;
                color: rgba(255, 235, 205, 235);
                font-size: 16px;
                font-weight: 800;
            }
            QLabel#topPillBig {
                font-size: 22px;
                letter-spacing: 2px;
            }
            QLabel#topPillDanger {
                background-color: rgba(120, 25, 18, 230);
                border: 1px solid rgba(255, 240, 220, 85);
            }

            QPushButton#topBtn {
                background-color: rgba(25, 22, 17, 210);
                border: 1px solid rgba(255, 220, 160, 55);
                border-radius: 8px;
                color: rgba(255, 235, 205, 235);
                font-size: 14px;
                font-weight: 800;
                padding: 6px 10px;
                min-width: 70px;
                min-height: 44px;
            }
            QPushButton#topBtn:pressed { background-color: rgba(255,255,255,35); }

            /* Alert banner */
            QLabel#alertBanner {
                background-color: rgba(160, 70, 20, 235);
                border: 2px solid rgba(255, 210, 150, 90);
                border-radius: 10px;
                color: rgba(255, 235, 210, 245);
                font-size: 26px;
                font-weight: 900;
            }

            /* Card text */
            QLabel#cardTitle {
                color: rgba(230, 215, 190, 230);
                font-size: 20px;
                font-weight: 900;
                letter-spacing: 1px;
            }
            QLabel#cardValue {
                color: rgba(245, 235, 215, 245);
                font-size: 78px;
                font-weight: 950;
            }

            /* Bottom bar */
            QWidget#bottomBox {
                background-color: rgba(25, 22, 17, 210);
                border: 1px solid rgba(255, 220, 160, 55);
                border-radius: 8px;
                min-height: 48px;
            }
            QLabel#bottomLabel {
                color: rgba(255, 235, 205, 220);
                font-size: 18px;
                font-weight: 900;
                letter-spacing: 1px;
            }
            QLabel#bottomValue {
                color: rgba(245, 235, 215, 245);
                font-size: 26px;
                font-weight: 950;
            }
            QLabel#bottomUnit {
                color: rgba(255, 235, 205, 220);
                font-size: 18px;
                font-weight: 900;
            }

            QPushButton#scanBtn {
                background-color: rgba(35, 32, 26, 230);
                border: 2px solid rgba(255, 220, 160, 85);
                border-radius: 10px;
                color: rgba(255, 235, 205, 240);
                font-size: 18px;
                font-weight: 950;
                letter-spacing: 1px;
                padding: 8px 14px;
            }
            QPushButton#scanBtn:pressed { background-color: rgba(255,255,255,35); }

            /* Live Trip Panel */
            QFrame#liveTripPanel {
                background-color: rgba(25, 45, 35, 220);
                border: 1px solid rgba(100, 200, 150, 85);
                border-radius: 8px;
            }
            QLabel#liveTripTitle {
                color: rgba(150, 220, 180, 240);
                font-size: 14px;
                font-weight: 900;
                letter-spacing: 1px;
            }
            QLabel#liveTripStat {
                color: rgba(240, 250, 245, 240);
                font-size: 16px;
                font-weight: 800;
            }
            QLabel#liveTripSep {
                color: rgba(150, 200, 170, 180);
                font-size: 16px;
            }
            QLabel#liveTripStatusOk {
                color: rgba(100, 220, 140, 250);
                font-size: 16px;
                font-weight: 900;
            }
            QLabel#liveTripStatusWarn {
                color: rgba(255, 180, 80, 250);
                font-size: 16px;
                font-weight: 900;
            }
            """
        )

    # ---------- Background ----------

    def _bg_path(self) -> Path:
        return ASSETS_DIR / ("night.png" if self.is_night else "day.png")

    def _load_background(self):
        pix = QPixmap(str(self._bg_path()))
        self.bg.setPixmap(pix)

    def toggle_night(self):
        self.is_night = not self.is_night
        self._load_background()

    # ---------- Alert History ----------

    def _record_alert(self, text: str, critical: bool):
        ts = time.strftime("%H:%M:%S")
        level = "CRIT" if critical else "WARN"
        self.alert_history.appendleft(f"[{ts}] {level}  {text}")

    def _set_alert(self, text: str, critical: bool):
        if text and text != self._last_alert_text:
            self._record_alert(text, critical)
            self._last_alert_text = text

            # Log event with location
            if self.logging_service:
                event = EventRecord(
                    ts=time.time(),
                    event_type="alert",
                    severity="critical" if critical else "warning",
                    message=text,
                    trip_id=self.state.current_trip_id,
                    lat=self.state.lat,
                    lon=self.state.lon,
                )
                self.logging_service.log_event(event)

        if not text:
            self._last_alert_text = ""
            self.alert.setVisible(False)
            return

        self.alert.setVisible(True)
        if critical:
            self.alert.setStyleSheet("background-color: rgba(140, 30, 20, 245);")
        else:
            self.alert.setStyleSheet("background-color: rgba(160, 70, 20, 235);")
        self.alert.setText(text)

    def _open_alert_history(self, event=None):
        dlg = QDialog(self)
        dlg.setWindowTitle("Alert History")
        dlg.setFixedSize(760, 460)

        lay = QVBoxLayout(dlg)
        lst = QListWidget()
        lst.setStyleSheet(
            """
            QListWidget {
                background-color: rgba(15, 14, 12, 240);
                color: rgba(245, 235, 215, 245);
                font-size: 14px;
                border: 1px solid rgba(255, 220, 160, 85);
                border-radius: 10px;
                padding: 8px;
            }
            """
        )
        if not self.alert_history:
            lst.addItem("No alerts yet.")
        else:
            for item in self.alert_history:
                lst.addItem(item)
        lay.addWidget(lst)
        dlg.exec()

    def _open_trips_dialog(self):
        """Open the trips history and stats dialog."""
        if self.logging_service:
            dlg = TripDataDialog(self.logging_service, parent=self)
            dlg.exec()

    def _open_settings(self):
        """Open the settings dialog."""
        if self.logging_service:
            dlg = SettingsDialog(self.settings, self.logging_service, parent=self)
            dlg.settings_changed.connect(self._on_settings_changed)
            dlg.exec()

    @Slot(object)
    def _on_settings_changed(self, new_settings: Settings):
        """Handle settings changes."""
        self.settings = new_settings
        # Update trip manager thresholds
        if self.trip_manager:
            self.trip_manager.START_SPEED_THRESHOLD = self.settings.trip_start_speed_mph
            self.trip_manager.STOP_TIMEOUT_SECS = self.settings.trip_stop_timeout_secs

    # ---------- Updates ----------

    def _ui_tick(self):
        now = time.time()
        dt = now - self._last_ui_tick_ts
        self._last_ui_tick_ts = now

        # Update trip manager with temps
        if self.trip_manager:
            self.trip_manager.on_vehicle_state_update(self.state, dt)

        # Update trip distance from manager
        if self.trip_manager and self.trip_manager.stats:
            self.state.trip_distance_mi = self.trip_manager.stats.distance_mi

        # Trip time
        if self.state.trip_start_ts and self.state.trip_active:
            elapsed = int(now - self.state.trip_start_ts)
            h = elapsed // 3600
            m = (elapsed % 3600) // 60
            s = elapsed % 60
            self.trip_pill.setText(f"TRIP {h:02d}:{m:02d}:{s:02d}")

            # Update live trip panel
            if self.trip_manager and self.trip_manager.stats:
                stats = self.trip_manager.stats
                warn = (stats.max_trans_f or 0) >= self.settings.trans_warn_f
                self.live_trip_panel.update_stats(
                    distance_mi=stats.distance_mi,
                    duration_secs=elapsed,
                    max_trans_f=stats.max_trans_f,
                    warn=warn,
                )
        elif not self.state.trip_active:
            self.trip_pill.setText("TRIP --:--:--")

        # Heading
        if self.state.heading_deg is None:
            self.heading_pill.setText("HDG --")
        else:
            c = self._cardinal(self.state.heading_deg)
            self.heading_pill.setText(f"{c} {self.state.heading_deg:03d}")

        # Elevation
        elev = "--" if self.state.elevation_ft is None else str(self.state.elevation_ft)
        self.elev_pill.setText(f"ELEV: {elev} FT")

        # Grade
        if self.state.grade_pct is not None:
            arrow = "^" if self.state.climbing else ("v" if self.state.grade_pct < -0.5 else "")
            self.grade_pill.setText(f"{arrow} {self.state.grade_pct:+.1f}%")
        else:
            self.grade_pill.setText("GRADE: -- %")

        # GPS / MIL
        self.gps_pill.setText("GPS: OK" if self.state.gps_ok else "GPS: --")

        self.mil_pill.setObjectName(
            "topPillDanger" if self.state.dtc_count > 0 else "topPill"
        )
        self.mil_pill.setText("MIL" if self.state.dtc_count > 0 else "OK")
        self.mil_pill.style().unpolish(self.mil_pill)
        self.mil_pill.style().polish(self.mil_pill)

        # Panels + bars
        self.trans_panel.set_value(
            "--" if self.state.trans_f is None else f"{self.state.trans_f:.0f}F"
        )
        self.cool_panel.set_value(
            "--" if self.state.coolant_f is None else f"{self.state.coolant_f:.0f}F"
        )
        self.volt_panel.set_value(
            "--" if self.state.voltage_v is None else f"{self.state.voltage_v:.1f}v"
        )

        self.trans_panel.bar.set_temp(
            self.state.trans_f, *TRANS_RANGE, TRANS_WARN, TRANS_CRIT
        )
        self.cool_panel.bar.set_temp(
            self.state.coolant_f, *COOL_RANGE, COOL_WARN, COOL_CRIT
        )
        self.volt_panel.bar.set_volt(
            self.state.voltage_v, *VOLT_RANGE, VOLT_LOW, VOLT_HIGH
        )

        # Bottom (speed/rpm)
        self.speed_box._val.setText(
            "--" if self.state.speed_mph is None else f"{self.state.speed_mph:.0f}"
        )  # type: ignore
        self.rpm_box._val.setText(
            "--" if self.state.rpm is None else f"{self.state.rpm}"
        )  # type: ignore

        # Alert logic (using configurable thresholds from settings)
        if self.state.dtc_count > 0:
            alert_text = DTCLookup.format_codes(self.dtc_codes)
            self._set_alert(alert_text, critical=False)
        elif self.state.trans_f is not None and self.state.trans_f >= self.settings.trans_crit_f:
            self._set_alert("TRANS TEMP CRITICAL", critical=True)
        elif self.state.trans_f is not None and self.state.trans_f >= self.settings.trans_warn_f:
            self._set_alert("TRANS TEMP HIGH", critical=False)
        elif self.state.coolant_f is not None and self.state.coolant_f >= self.settings.coolant_crit_f:
            self._set_alert("COOLANT CRITICAL", critical=True)
        elif self.state.coolant_f is not None and self.state.coolant_f >= self.settings.coolant_warn_f:
            self._set_alert("COOLANT HIGH", critical=False)
        elif self.state.voltage_v is not None and (
            self.state.voltage_v < self.settings.volt_low or self.state.voltage_v > self.settings.volt_high
        ):
            self._set_alert("VOLTAGE ABNORMAL", critical=False)
        else:
            self._set_alert("", critical=False)

    @staticmethod
    def _cardinal(deg: int) -> str:
        dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        return dirs[int((deg + 22.5) // 45) % 8]

    # ---------- Mock data ----------

    def _mock_tick(self):
        # Generate mock GPS data via mock service
        if self.mock_gps_service:
            self.mock_gps_service.mock_tick()

        # Simulate OBD data (temps, voltage, RPM)
        self.state.rpm = int(random.uniform(700, 3200))
        self.state.trans_f = random.uniform(170, 265)
        self.state.coolant_f = random.uniform(185, 242)
        self.state.voltage_v = round(random.uniform(11.3, 14.7), 1)

        # Occasionally simulate a code
        if random.random() < 0.10:
            # Pick a random code from common ones
            mock_codes = ["P0300", "P0301", "P0128", "P0217", "P0711", "P1C4F"]
            self.dtc_codes = [random.choice(mock_codes)]
            self.state.dtc_count = 1
        else:
            self.dtc_codes = []
            self.state.dtc_count = 0
