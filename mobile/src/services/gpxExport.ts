/** GPX file export for trip breadcrumb data. */

import { cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { BreadcrumbRecord } from '../models/types';
import { feetToMeters } from '../utils/geo';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const PMAD_NS = 'http://promaster-dash/gpx/extensions/1';

function toISO(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function formatTripName(startTs: number): string {
  const d = new Date(startTs * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `Trip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Generate GPX XML string from breadcrumbs. */
export function generateGPX(
  breadcrumbs: BreadcrumbRecord[],
  tripName?: string,
): string {
  if (breadcrumbs.length === 0) return '';

  const name = tripName ?? formatTripName(breadcrumbs[0].ts);

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ProMaster Dash"
  xmlns="${GPX_NS}"
  xmlns:pmad="${PMAD_NS}">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${toISO(breadcrumbs[0].ts)}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
`;

  for (const bc of breadcrumbs) {
    gpx += `      <trkpt lat="${bc.lat.toFixed(7)}" lon="${bc.lon.toFixed(7)}">
`;
    if (bc.elevationFt !== null) {
      gpx += `        <ele>${feetToMeters(bc.elevationFt).toFixed(1)}</ele>\n`;
    }
    gpx += `        <time>${toISO(bc.ts)}</time>\n`;

    // Extensions for vehicle data
    const exts: string[] = [];
    if (bc.speedMph !== null)
      exts.push(`          <pmad:speed>${bc.speedMph.toFixed(1)}</pmad:speed>`);
    if (bc.headingDeg !== null)
      exts.push(`          <pmad:heading>${bc.headingDeg}</pmad:heading>`);
    if (bc.transF !== null)
      exts.push(`          <pmad:trans_temp>${bc.transF.toFixed(1)}</pmad:trans_temp>`);
    if (bc.coolantF !== null)
      exts.push(`          <pmad:coolant_temp>${bc.coolantF.toFixed(1)}</pmad:coolant_temp>`);
    if (bc.voltageV !== null)
      exts.push(`          <pmad:voltage>${bc.voltageV.toFixed(1)}</pmad:voltage>`);
    if (bc.gradePct !== null)
      exts.push(`          <pmad:grade>${bc.gradePct.toFixed(1)}</pmad:grade>`);

    if (exts.length > 0) {
      gpx += `        <extensions>\n${exts.join('\n')}\n        </extensions>\n`;
    }

    gpx += `      </trkpt>\n`;
  }

  gpx += `    </trkseg>
  </trk>
</gpx>`;

  return gpx;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Generate a filename for a trip export. */
export function generateFilename(tripId: number, startTs: number): string {
  const d = new Date(startTs * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `trip_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${tripId}.gpx`;
}

/** Export breadcrumbs to GPX and open the share sheet. */
export async function exportAndShare(
  breadcrumbs: BreadcrumbRecord[],
  tripId: number,
  startTs: number,
): Promise<boolean> {
  try {
    const gpxContent = generateGPX(breadcrumbs);
    if (!gpxContent) return false;

    const filename = generateFilename(tripId, startTs);
    const filePath = `${cacheDirectory}${filename}`;

    await writeAsStringAsync(filePath, gpxContent, {
      encoding: EncodingType.UTF8,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(filePath, {
        mimeType: 'application/gpx+xml',
        dialogTitle: 'Export Trip GPX',
      });
    }

    return true;
  } catch (e) {
    console.warn('GPX export failed:', e);
    return false;
  }
}
