"""Application settings with persistence."""

from __future__ import annotations

import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional


@dataclass
class Settings:
    """
    Application settings with defaults and JSON persistence.

    All temperature values are in Fahrenheit.
    All speed values are in MPH.
    """

    # Temperature thresholds (°F)
    trans_warn_f: float = 230.0
    trans_crit_f: float = 250.0
    coolant_warn_f: float = 220.0
    coolant_crit_f: float = 230.0

    # Voltage thresholds
    volt_low: float = 11.5
    volt_high: float = 15.0

    # Trip detection
    trip_start_speed_mph: float = 5.0
    trip_stop_timeout_min: int = 5
    breadcrumb_interval_sec: int = 5

    # Display
    start_night_mode: bool = False

    # Data management
    data_retention_days: int = 365

    @classmethod
    def load(cls, path: Optional[Path] = None) -> Settings:
        """
        Load settings from JSON file.

        Args:
            path: Optional custom path. Uses default if None.

        Returns:
            Settings instance (defaults if file doesn't exist or fails)
        """
        if path is None:
            path = cls._default_path()

        try:
            if path.exists():
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                # Filter to only known fields (ignore obsolete settings)
                known_fields = {f.name for f in cls.__dataclass_fields__.values()}
                filtered = {k: v for k, v in data.items() if k in known_fields}
                return cls(**filtered)
        except Exception as e:
            print(f"Failed to load settings: {e}")

        return cls()

    def save(self, path: Optional[Path] = None) -> bool:
        """
        Save settings to JSON file.

        Args:
            path: Optional custom path. Uses default if None.

        Returns:
            True if saved successfully
        """
        if path is None:
            path = self._default_path()

        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(asdict(self), f, indent=2)
            return True
        except Exception as e:
            print(f"Failed to save settings: {e}")
            return False

    @staticmethod
    def _default_path() -> Path:
        """Get default settings file location."""
        if platform.system() == "Windows":
            base = Path.home() / ".promaster_dash"
        else:
            base = Path.home() / ".local" / "share" / "promaster_dash"
        return base / "settings.json"

    def reset_to_defaults(self) -> None:
        """Reset all settings to their default values."""
        defaults = Settings()
        for field_name in self.__dataclass_fields__:
            setattr(self, field_name, getattr(defaults, field_name))

    @property
    def trip_stop_timeout_secs(self) -> int:
        """Get stop timeout in seconds (for trip_manager)."""
        return self.trip_stop_timeout_min * 60
