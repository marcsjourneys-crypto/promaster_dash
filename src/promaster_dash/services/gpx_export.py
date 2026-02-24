"""GPX file export for trip breadcrumb data."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from promaster_dash.models.data_records import BreadcrumbRecord
from promaster_dash.utils.geo import feet_to_meters


# GPX namespaces
GPX_NS = "http://www.topografix.com/GPX/1/1"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"
PMAD_NS = "http://promaster-dash/gpx/extensions/1"

# Schema location
SCHEMA_LOC = f"{GPX_NS} http://www.topografix.com/GPX/1/1/gpx.xsd"


def _timestamp_to_iso(ts: float) -> str:
    """Convert Unix timestamp to ISO 8601 format."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _format_trip_name(start_ts: float) -> str:
    """Format a trip name from start timestamp."""
    dt = datetime.fromtimestamp(start_ts)
    return dt.strftime("Trip %Y-%m-%d %H:%M")


class GPXExporter:
    """Export trip breadcrumb data to GPX format."""

    @staticmethod
    def export_trip(
        breadcrumbs: List[BreadcrumbRecord],
        output_path: Path,
        trip_name: Optional[str] = None,
    ) -> bool:
        """
        Export breadcrumbs to a GPX file.

        Args:
            breadcrumbs: List of breadcrumb records for the trip
            output_path: Destination file path (.gpx)
            trip_name: Optional name for the track (auto-generated if None)

        Returns:
            True if export succeeded, False on error
        """
        if not breadcrumbs:
            return False

        try:
            # Determine trip name
            if not trip_name:
                trip_name = _format_trip_name(breadcrumbs[0].ts)

            # Register namespaces
            ET.register_namespace("", GPX_NS)
            ET.register_namespace("xsi", XSI_NS)
            ET.register_namespace("pmad", PMAD_NS)

            # Create root element
            gpx = ET.Element(
                "gpx",
                {
                    "version": "1.1",
                    "creator": "ProMaster Adventure Dash",
                    f"{{{XSI_NS}}}schemaLocation": SCHEMA_LOC,
                },
            )
            gpx.set("xmlns", GPX_NS)
            gpx.set(f"xmlns:pmad", PMAD_NS)

            # Metadata
            metadata = ET.SubElement(gpx, "metadata")
            name_elem = ET.SubElement(metadata, "name")
            name_elem.text = trip_name
            time_elem = ET.SubElement(metadata, "time")
            time_elem.text = _timestamp_to_iso(breadcrumbs[0].ts)

            # Track
            trk = ET.SubElement(gpx, "trk")
            trk_name = ET.SubElement(trk, "name")
            trk_name.text = trip_name

            # Track segment
            trkseg = ET.SubElement(trk, "trkseg")

            # Track points
            for bc in breadcrumbs:
                trkpt = ET.SubElement(
                    trkseg,
                    "trkpt",
                    {"lat": f"{bc.lat:.7f}", "lon": f"{bc.lon:.7f}"},
                )

                # Elevation (convert to meters for GPX standard)
                if bc.elevation_ft is not None:
                    ele = ET.SubElement(trkpt, "ele")
                    ele.text = f"{feet_to_meters(bc.elevation_ft):.1f}"

                # Time
                time_pt = ET.SubElement(trkpt, "time")
                time_pt.text = _timestamp_to_iso(bc.ts)

                # Extensions for vehicle data
                extensions = ET.SubElement(trkpt, "extensions")

                if bc.speed_mph is not None:
                    speed = ET.SubElement(extensions, f"{{{PMAD_NS}}}speed")
                    speed.text = f"{bc.speed_mph:.1f}"

                if bc.heading_deg is not None:
                    heading = ET.SubElement(extensions, f"{{{PMAD_NS}}}heading")
                    heading.text = str(bc.heading_deg)

                if bc.trans_f is not None:
                    trans = ET.SubElement(extensions, f"{{{PMAD_NS}}}trans_temp")
                    trans.text = f"{bc.trans_f:.1f}"

                if bc.coolant_f is not None:
                    coolant = ET.SubElement(extensions, f"{{{PMAD_NS}}}coolant_temp")
                    coolant.text = f"{bc.coolant_f:.1f}"

                if bc.voltage_v is not None:
                    voltage = ET.SubElement(extensions, f"{{{PMAD_NS}}}voltage")
                    voltage.text = f"{bc.voltage_v:.1f}"

                if bc.grade_pct is not None:
                    grade = ET.SubElement(extensions, f"{{{PMAD_NS}}}grade")
                    grade.text = f"{bc.grade_pct:.1f}"

                if bc.obd_speed_mph is not None:
                    obd_speed = ET.SubElement(extensions, f"{{{PMAD_NS}}}obd_speed")
                    obd_speed.text = f"{bc.obd_speed_mph:.1f}"

            # Write to file
            tree = ET.ElementTree(gpx)
            ET.indent(tree, space="  ")

            # Ensure parent directory exists
            output_path.parent.mkdir(parents=True, exist_ok=True)

            with open(output_path, "wb") as f:
                tree.write(f, encoding="UTF-8", xml_declaration=True)

            return True

        except Exception as e:
            print(f"GPX export failed: {e}")
            return False

    @staticmethod
    def generate_filename(trip_id: int, start_ts: float) -> str:
        """
        Generate a filename for a trip export.

        Args:
            trip_id: Database trip ID
            start_ts: Trip start timestamp

        Returns:
            Filename like "trip_20240115_0830_42.gpx"
        """
        dt = datetime.fromtimestamp(start_ts)
        date_str = dt.strftime("%Y%m%d_%H%M")
        return f"trip_{date_str}_{trip_id}.gpx"
