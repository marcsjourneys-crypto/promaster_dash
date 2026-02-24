"""DTC code lookup service for OBD-II diagnostic trouble codes."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Dict, List, Optional


# Ram ProMaster / Chrysler specific codes not in generic database
RAM_SPECIFIC_CODES = {
    "P1C4F": "DPF Regeneration Failure",
    "P1797": "Manual Shift Overheat",
    "P0944": "Hydraulic Pressure Unit Loss of Pressure",
    "P2610": "ECM/PCM Internal Engine Off Timer Performance",
    "P0562": "System Voltage Low",
    "P0563": "System Voltage High",
    "P2172": "High Airflow/Vacuum Leak Detected (Instantaneous)",
    "P2173": "High Airflow/Vacuum Leak Detected (Slow Accumulation)",
    "P0128": "Coolant Thermostat Below Regulating Temperature",
    "P0217": "Engine Coolant Over Temperature Condition",
    "P0218": "Transmission Fluid Over Temperature Condition",
    "P0711": "Transmission Fluid Temperature Sensor A Circuit Range/Performance",
    "P0713": "Transmission Fluid Temperature Sensor A Circuit High",
    "P0714": "Transmission Fluid Temperature Sensor A Circuit Intermittent",
}


class DTCLookup:
    """
    Lookup service for OBD-II diagnostic trouble codes.

    Loads codes from bundled CSV on first use (lazy loading).
    Includes manufacturer-specific codes for Ram/Chrysler vehicles.
    """

    _codes: Dict[str, str] = {}
    _loaded: bool = False

    @classmethod
    def get_description(cls, code: str) -> Optional[str]:
        """
        Get description for a DTC code.

        Args:
            code: DTC code like "P0301"

        Returns:
            Description string or None if not found
        """
        if not cls._loaded:
            cls._load_codes()
        return cls._codes.get(code.upper())

    @classmethod
    def format_code(cls, code: str) -> str:
        """
        Format a code with its description.

        Args:
            code: DTC code like "P0301"

        Returns:
            Formatted string like "P0301: Cylinder 1 Misfire"
        """
        desc = cls.get_description(code)
        if desc:
            # Truncate long descriptions for display
            if len(desc) > 40:
                desc = desc[:37] + "..."
            return f"{code.upper()}: {desc}"
        return code.upper()

    @classmethod
    def format_codes(cls, codes: List[str]) -> str:
        """
        Format multiple codes for alert display.

        Args:
            codes: List of DTC codes

        Returns:
            Formatted string for alert banner
        """
        if not codes:
            return "CHECK ENGINE CODE DETECTED"

        first_formatted = cls.format_code(codes[0])
        if len(codes) > 1:
            return f"{first_formatted} (+{len(codes)-1} more)"
        return first_formatted

    @classmethod
    def get_all_codes(cls, codes: List[str]) -> List[Dict[str, str]]:
        """
        Get details for multiple codes.

        Args:
            codes: List of DTC codes

        Returns:
            List of dicts with 'code' and 'description' keys
        """
        if not cls._loaded:
            cls._load_codes()

        result = []
        for code in codes:
            desc = cls._codes.get(code.upper())
            result.append({
                "code": code.upper(),
                "description": desc or "Unknown code",
            })
        return result

    @classmethod
    def _load_codes(cls) -> None:
        """Load codes from bundled CSV file and add manufacturer codes."""
        # Load generic OBD-II codes from CSV
        csv_path = Path(__file__).parent / "dtc_codes.csv"
        try:
            with open(csv_path, newline="", encoding="utf-8") as f:
                reader = csv.reader(f)
                for row in reader:
                    if len(row) >= 2:
                        cls._codes[row[0].upper()] = row[1]
        except Exception as e:
            print(f"Failed to load DTC codes: {e}")

        # Add manufacturer-specific codes
        for code, desc in RAM_SPECIFIC_CODES.items():
            cls._codes[code.upper()] = desc

        cls._loaded = True

    @classmethod
    def add_custom_code(cls, code: str, description: str) -> None:
        """
        Add a custom/manufacturer-specific code.

        Useful for adding codes discovered during use.

        Args:
            code: DTC code like "P1C4F"
            description: Human-readable description
        """
        if not cls._loaded:
            cls._load_codes()
        cls._codes[code.upper()] = description

    @classmethod
    def code_count(cls) -> int:
        """Return the number of codes in the database."""
        if not cls._loaded:
            cls._load_codes()
        return len(cls._codes)
