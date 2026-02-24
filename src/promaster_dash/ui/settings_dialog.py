"""Settings dialog with tabbed sections."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

if TYPE_CHECKING:
    from promaster_dash.config.settings import Settings
    from promaster_dash.services.logging_service import LoggingService


class ValueStepper(QWidget):
    """
    Touch-friendly numeric stepper with +/- buttons.

    Layout: [Label]  [ - ]  [Value]  [ + ]

    Features:
    - Large touch-friendly buttons (48x48px)
    - Value prominently displayed in center
    - Auto-repeat on button hold for rapid adjustment
    - Configurable min/max/step
    """

    value_changed = Signal(float)

    def __init__(
        self,
        label: str,
        min_val: float,
        max_val: float,
        value: float,
        suffix: str = "",
        decimals: int = 0,
        step: float = 1.0,
    ):
        super().__init__()
        self.min_val = min_val
        self.max_val = max_val
        self.decimals = decimals
        self.suffix = suffix
        self.step = step
        self._value = value

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 4, 0, 4)
        lay.setSpacing(8)

        # Label
        self.label = QLabel(label)
        self.label.setObjectName("stepperLabel")
        self.label.setFixedWidth(140)
        lay.addWidget(self.label)

        lay.addStretch(1)

        # Minus button
        self.minus_btn = QPushButton("\u2212")  # Proper minus sign
        self.minus_btn.setObjectName("stepperBtn")
        self.minus_btn.setFixedSize(44, 44)
        self.minus_btn.setAutoRepeat(True)
        self.minus_btn.setAutoRepeatDelay(400)
        self.minus_btn.setAutoRepeatInterval(100)
        self.minus_btn.clicked.connect(self._on_minus)
        lay.addWidget(self.minus_btn)

        # Value display - fixed width for consistency
        self.value_label = QLabel()
        self.value_label.setObjectName("stepperValue")
        self.value_label.setFixedWidth(100)
        self.value_label.setFixedHeight(44)
        self.value_label.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.value_label)

        # Plus button
        self.plus_btn = QPushButton("+")
        self.plus_btn.setObjectName("stepperBtn")
        self.plus_btn.setFixedSize(44, 44)
        self.plus_btn.setAutoRepeat(True)
        self.plus_btn.setAutoRepeatDelay(400)
        self.plus_btn.setAutoRepeatInterval(100)
        self.plus_btn.clicked.connect(self._on_plus)
        lay.addWidget(self.plus_btn)

        self._update_value_label()

    def _on_minus(self):
        """Decrement value."""
        new_val = max(self.min_val, self._value - self.step)
        if new_val != self._value:
            self._value = new_val
            self._update_value_label()
            self.value_changed.emit(self._value)

    def _on_plus(self):
        """Increment value."""
        new_val = min(self.max_val, self._value + self.step)
        if new_val != self._value:
            self._value = new_val
            self._update_value_label()
            self.value_changed.emit(self._value)

    def _update_value_label(self):
        """Update the value display label."""
        if self.decimals == 0:
            text = f"{int(self._value)}{self.suffix}"
        else:
            text = f"{self._value:.{self.decimals}f}{self.suffix}"
        self.value_label.setText(text)

    def value(self) -> float:
        """Get current value."""
        return self._value

    def setValue(self, value: float):
        """Set current value."""
        self._value = max(self.min_val, min(self.max_val, value))
        self._update_value_label()


# Alias for backward compatibility during refactor
LabeledSlider = ValueStepper


class SettingsDialog(QDialog):
    """
    Settings dialog with tabbed sections.

    Tabs: THRESHOLDS, TRIP, DISPLAY, DATA
    """

    settings_changed = Signal(object)  # Emit Settings when saved

    def __init__(
        self,
        settings: "Settings",
        logging_service: "LoggingService",
        parent=None,
    ):
        super().__init__(parent)
        self.settings = settings
        self.logging_service = logging_service
        self._modified = False

        self.setWindowTitle("Settings")
        self.setFixedSize(900, 550)

        self._setup_ui()
        self._apply_styles()

    def _setup_ui(self):
        """Build the dialog UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # Tab widget
        self.tabs = QTabWidget()
        self.tabs.addTab(self._create_thresholds_tab(), "THRESHOLDS")
        self.tabs.addTab(self._create_trip_tab(), "TRIP")
        self.tabs.addTab(self._create_display_tab(), "DISPLAY")
        self.tabs.addTab(self._create_data_tab(), "DATA")
        layout.addWidget(self.tabs)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.reset_btn = QPushButton("RESET DEFAULTS")
        self.reset_btn.setObjectName("settingsBtn")
        self.reset_btn.setFixedHeight(48)
        self.reset_btn.clicked.connect(self._reset_defaults)
        btn_layout.addWidget(self.reset_btn)

        self.close_btn = QPushButton("CLOSE")
        self.close_btn.setObjectName("settingsBtnPrimary")
        self.close_btn.setFixedHeight(48)
        self.close_btn.clicked.connect(self._save_and_close)
        btn_layout.addWidget(self.close_btn)

        layout.addLayout(btn_layout)

    def _create_thresholds_tab(self) -> QWidget:
        """Create the thresholds settings tab."""
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        # Match the tab pane background color
        scroll.setStyleSheet(
            "QScrollArea { background: rgba(25, 22, 17, 230); border: none; }"
            "QScrollArea > QWidget > QWidget { background: rgba(25, 22, 17, 230); }"
        )

        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(4)

        # Trans temp section
        trans_header = QLabel("TRANS TEMP")
        trans_header.setObjectName("sectionHeader")
        layout.addWidget(trans_header)

        self.trans_warn_slider = LabeledSlider(
            "Warning:", 200, 260, self.settings.trans_warn_f, "°F"
        )
        self.trans_warn_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.trans_warn_slider)

        self.trans_crit_slider = LabeledSlider(
            "Critical:", 220, 280, self.settings.trans_crit_f, "°F"
        )
        self.trans_crit_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.trans_crit_slider)

        layout.addSpacing(16)

        # Coolant temp section
        cool_header = QLabel("COOLANT TEMP")
        cool_header.setObjectName("sectionHeader")
        layout.addWidget(cool_header)

        self.coolant_warn_slider = LabeledSlider(
            "Warning:", 200, 240, self.settings.coolant_warn_f, "°F"
        )
        self.coolant_warn_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.coolant_warn_slider)

        self.coolant_crit_slider = LabeledSlider(
            "Critical:", 210, 250, self.settings.coolant_crit_f, "°F"
        )
        self.coolant_crit_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.coolant_crit_slider)

        layout.addSpacing(16)

        # Voltage section
        volt_header = QLabel("VOLTAGE")
        volt_header.setObjectName("sectionHeader")
        layout.addWidget(volt_header)

        self.volt_low_slider = LabeledSlider(
            "Low:", 10.0, 12.5, self.settings.volt_low, "V", decimals=1, step=0.1
        )
        self.volt_low_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.volt_low_slider)

        self.volt_high_slider = LabeledSlider(
            "High:", 14.0, 16.0, self.settings.volt_high, "V", decimals=1, step=0.1
        )
        self.volt_high_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.volt_high_slider)

        layout.addStretch()
        scroll.setWidget(widget)
        return scroll

    def _create_trip_tab(self) -> QWidget:
        """Create the trip settings tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(8)

        header = QLabel("TRIP DETECTION")
        header.setObjectName("sectionHeader")
        layout.addWidget(header)

        self.start_speed_slider = LabeledSlider(
            "Start Speed:", 3, 10, self.settings.trip_start_speed_mph, " mph"
        )
        self.start_speed_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.start_speed_slider)

        self.stop_timeout_slider = LabeledSlider(
            "Stop Timeout:", 2, 15, self.settings.trip_stop_timeout_min, " min"
        )
        self.stop_timeout_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.stop_timeout_slider)

        self.breadcrumb_slider = LabeledSlider(
            "Breadcrumb Interval:", 1, 30, self.settings.breadcrumb_interval_sec, " sec"
        )
        self.breadcrumb_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.breadcrumb_slider)

        layout.addSpacing(16)

        # Info text
        info = QLabel(
            "Trip starts when speed exceeds the start threshold.\n"
            "Trip ends after vehicle is stationary for the timeout period.\n"
            "Breadcrumbs record position at the specified interval."
        )
        info.setObjectName("infoText")
        info.setWordWrap(True)
        layout.addWidget(info)

        layout.addStretch()
        return widget

    def _create_display_tab(self) -> QWidget:
        """Create the display settings tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)

        header = QLabel("DISPLAY OPTIONS")
        header.setObjectName("sectionHeader")
        layout.addWidget(header)

        # Night mode checkbox
        self.night_mode_check = QCheckBox("Start in Night Mode")
        self.night_mode_check.setObjectName("settingsCheck")
        self.night_mode_check.setChecked(self.settings.start_night_mode)
        self.night_mode_check.stateChanged.connect(self._on_value_changed)
        layout.addWidget(self.night_mode_check)

        layout.addSpacing(16)

        # Future: temperature units toggle
        future_label = QLabel("Temperature units (°F/°C) - coming soon")
        future_label.setObjectName("infoText")
        layout.addWidget(future_label)

        layout.addStretch()
        return widget

    def _create_data_tab(self) -> QWidget:
        """Create the data management tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)

        header = QLabel("DATA MANAGEMENT")
        header.setObjectName("sectionHeader")
        layout.addWidget(header)

        # Stats frame
        stats_frame = QFrame()
        stats_frame.setObjectName("statsFrame")
        stats_layout = QVBoxLayout(stats_frame)
        stats_layout.setContentsMargins(16, 16, 16, 16)
        stats_layout.setSpacing(8)

        # Database size
        db_size = self.logging_service.get_database_size_mb()
        self.db_size_label = QLabel(f"Database Size: {db_size:.2f} MB")
        self.db_size_label.setObjectName("statsLabel")
        stats_layout.addWidget(self.db_size_label)

        # Trip count
        all_time = self.logging_service.get_all_time_stats()
        trip_count = all_time.get("trip_count", 0)
        self.trip_count_label = QLabel(f"Total Trips: {trip_count}")
        self.trip_count_label.setObjectName("statsLabel")
        stats_layout.addWidget(self.trip_count_label)

        layout.addWidget(stats_frame)

        # Retention slider
        layout.addSpacing(8)
        self.retention_slider = LabeledSlider(
            "Data Retention:", 30, 730, self.settings.data_retention_days, " days"
        )
        self.retention_slider.value_changed.connect(self._on_value_changed)
        layout.addWidget(self.retention_slider)

        layout.addSpacing(16)

        # Action buttons
        btn_layout = QHBoxLayout()

        self.cleanup_btn = QPushButton("CLEANUP OLD TRIPS")
        self.cleanup_btn.setObjectName("settingsBtn")
        self.cleanup_btn.setFixedHeight(48)
        self.cleanup_btn.clicked.connect(self._cleanup_trips)
        btn_layout.addWidget(self.cleanup_btn)

        self.export_btn = QPushButton("EXPORT ALL GPX")
        self.export_btn.setObjectName("settingsBtn")
        self.export_btn.setFixedHeight(48)
        self.export_btn.clicked.connect(self._export_all_gpx)
        btn_layout.addWidget(self.export_btn)

        layout.addLayout(btn_layout)

        layout.addStretch()
        return widget

    def _on_value_changed(self, *args):
        """Mark settings as modified."""
        self._modified = True

    def _reset_defaults(self):
        """Reset all settings to defaults."""
        reply = QMessageBox.question(
            self,
            "Reset Settings",
            "Reset all settings to defaults?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            self.settings.reset_to_defaults()
            self._update_ui_from_settings()
            self._modified = True

    def _update_ui_from_settings(self):
        """Update all UI controls from current settings."""
        self.trans_warn_slider.setValue(self.settings.trans_warn_f)
        self.trans_crit_slider.setValue(self.settings.trans_crit_f)
        self.coolant_warn_slider.setValue(self.settings.coolant_warn_f)
        self.coolant_crit_slider.setValue(self.settings.coolant_crit_f)
        self.volt_low_slider.setValue(self.settings.volt_low)
        self.volt_high_slider.setValue(self.settings.volt_high)
        self.start_speed_slider.setValue(self.settings.trip_start_speed_mph)
        self.stop_timeout_slider.setValue(self.settings.trip_stop_timeout_min)
        self.breadcrumb_slider.setValue(self.settings.breadcrumb_interval_sec)
        self.night_mode_check.setChecked(self.settings.start_night_mode)
        self.retention_slider.setValue(self.settings.data_retention_days)

    def _collect_settings(self):
        """Collect settings from UI controls."""
        self.settings.trans_warn_f = self.trans_warn_slider.value()
        self.settings.trans_crit_f = self.trans_crit_slider.value()
        self.settings.coolant_warn_f = self.coolant_warn_slider.value()
        self.settings.coolant_crit_f = self.coolant_crit_slider.value()
        self.settings.volt_low = self.volt_low_slider.value()
        self.settings.volt_high = self.volt_high_slider.value()
        self.settings.trip_start_speed_mph = self.start_speed_slider.value()
        self.settings.trip_stop_timeout_min = int(self.stop_timeout_slider.value())
        self.settings.breadcrumb_interval_sec = int(self.breadcrumb_slider.value())
        self.settings.start_night_mode = self.night_mode_check.isChecked()
        self.settings.data_retention_days = int(self.retention_slider.value())

    def _save_and_close(self):
        """Save settings and close dialog."""
        if self._modified:
            self._collect_settings()
            self.settings.save()
            self.settings_changed.emit(self.settings)
        self.accept()

    def _cleanup_trips(self):
        """Delete trips older than retention period."""
        days = int(self.retention_slider.value())
        reply = QMessageBox.question(
            self,
            "Cleanup Trips",
            f"Delete trips older than {days} days?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            deleted = self.logging_service.cleanup_old_trips(max_age_days=days)
            self._refresh_data_stats()
            QMessageBox.information(
                self, "Cleanup Complete", f"Deleted {deleted} old trips."
            )

    def _export_all_gpx(self):
        """Export all trips to GPX files."""
        from promaster_dash.services.gpx_export import GPXExporter

        trips = self.logging_service.get_recent_trips(limit=1000)
        if not trips:
            QMessageBox.information(self, "Export", "No trips to export.")
            return

        # Get export directory
        export_dir = self.settings._default_path().parent / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)

        exported = 0
        for trip in trips:
            trip_id = trip["id"]
            start_ts = trip["start_ts"]
            breadcrumbs = self.logging_service.get_trip_breadcrumbs(trip_id)
            if breadcrumbs:
                filename = GPXExporter.generate_filename(trip_id, start_ts)
                output_path = export_dir / filename
                if GPXExporter.export_trip(breadcrumbs, output_path):
                    exported += 1

        QMessageBox.information(
            self,
            "Export Complete",
            f"Exported {exported} trips to:\n{export_dir}",
        )

    def _refresh_data_stats(self):
        """Refresh the data statistics display."""
        db_size = self.logging_service.get_database_size_mb()
        self.db_size_label.setText(f"Database Size: {db_size:.2f} MB")

        all_time = self.logging_service.get_all_time_stats()
        trip_count = all_time.get("trip_count", 0)
        self.trip_count_label.setText(f"Total Trips: {trip_count}")

    def _apply_styles(self):
        """Apply dialog styles."""
        self.setStyleSheet(
            """
            QDialog {
                background-color: rgba(20, 18, 15, 250);
            }
            QTabWidget::pane {
                border: 1px solid rgba(255, 220, 160, 55);
                border-radius: 8px;
                background-color: rgba(25, 22, 17, 230);
            }
            QTabBar::tab {
                background-color: rgba(35, 32, 26, 220);
                color: rgba(200, 190, 170, 220);
                border: 1px solid rgba(255, 220, 160, 45);
                padding: 12px 24px;
                margin-right: 4px;
                font-size: 14px;
                font-weight: 800;
            }
            QTabBar::tab:selected {
                background-color: rgba(60, 55, 45, 240);
                color: rgba(255, 235, 205, 250);
                border-bottom: 2px solid rgba(220, 160, 60, 200);
            }
            QLabel#sectionHeader {
                color: rgba(220, 180, 120, 240);
                font-size: 16px;
                font-weight: 900;
                letter-spacing: 1px;
                padding-bottom: 8px;
            }
            QLabel#stepperLabel {
                color: rgba(200, 190, 170, 230);
                font-size: 14px;
                font-weight: 700;
            }
            QLabel#stepperValue {
                color: rgba(255, 235, 205, 255);
                font-size: 18px;
                font-weight: 900;
                background-color: rgba(45, 40, 32, 255);
                border: 1px solid rgba(255, 220, 160, 80);
                border-radius: 6px;
            }
            QPushButton#stepperBtn {
                background-color: rgba(70, 65, 55, 255);
                border: 1px solid rgba(255, 220, 160, 120);
                border-radius: 6px;
                color: rgba(255, 235, 205, 255);
                font-size: 24px;
                font-weight: 900;
            }
            QPushButton#stepperBtn:pressed {
                background-color: rgba(110, 100, 80, 255);
            }
            QPushButton#stepperBtn:disabled {
                background-color: rgba(40, 36, 30, 150);
                color: rgba(150, 140, 120, 150);
            }
            QScrollArea {
                background: transparent;
                border: none;
            }
            QScrollArea > QWidget > QWidget {
                background: transparent;
            }
            QLabel#infoText {
                color: rgba(150, 145, 135, 200);
                font-size: 12px;
            }
            QLabel#statsLabel {
                color: rgba(220, 210, 195, 240);
                font-size: 15px;
                font-weight: 700;
            }
            QCheckBox#settingsCheck {
                color: rgba(220, 210, 195, 240);
                font-size: 15px;
                font-weight: 700;
                spacing: 12px;
            }
            QCheckBox#settingsCheck::indicator {
                width: 24px;
                height: 24px;
                border: 2px solid rgba(255, 220, 160, 100);
                border-radius: 4px;
                background-color: rgba(40, 36, 30, 200);
            }
            QCheckBox#settingsCheck::indicator:checked {
                background-color: rgba(180, 130, 50, 220);
            }
            QFrame#statsFrame {
                background-color: rgba(35, 32, 26, 200);
                border: 1px solid rgba(255, 220, 160, 55);
                border-radius: 8px;
            }
            QPushButton#settingsBtn {
                background-color: rgba(45, 42, 36, 230);
                border: 1px solid rgba(255, 220, 160, 75);
                border-radius: 8px;
                color: rgba(220, 210, 195, 240);
                font-size: 14px;
                font-weight: 800;
                padding: 8px 20px;
                min-width: 140px;
            }
            QPushButton#settingsBtn:pressed {
                background-color: rgba(80, 75, 65, 230);
            }
            QPushButton#settingsBtnPrimary {
                background-color: rgba(160, 120, 40, 230);
                border: 1px solid rgba(255, 220, 160, 100);
                border-radius: 8px;
                color: rgba(255, 250, 240, 250);
                font-size: 14px;
                font-weight: 900;
                padding: 8px 24px;
                min-width: 100px;
            }
            QPushButton#settingsBtnPrimary:pressed {
                background-color: rgba(200, 150, 50, 230);
            }
            """
        )
