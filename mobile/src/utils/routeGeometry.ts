/**
 * Pure geometry helpers for rendering trip routes on a map.
 * No react-native or MapLibre imports — fully unit-testable.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** Minimal GeoJSON shapes (avoids a @types/geojson dependency). */
export interface LineStringFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: Record<string, never>;
}

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, never>;
}

/** A route needs at least 2 points to draw a line. */
export function hasRenderableRoute(points: LatLon[]): boolean {
  return points.length >= 2;
}

/**
 * Evenly stride-downsample to at most maxPoints, always keeping the first
 * and last points. Uses index interpolation, so output stays in order and
 * duplicate-free as long as maxPoints <= points.length.
 */
export function downsample<T>(points: T[], maxPoints: number): T[] {
  if (maxPoints < 2 || points.length <= maxPoints) return points;
  const result: T[] = [];
  const step = (points.length - 1) / (maxPoints - 1);
  let prevIdx = -1;
  for (let i = 0; i < maxPoints; i++) {
    let idx = Math.round(i * step);
    if (idx <= prevIdx) idx = prevIdx + 1; // guard against rounding collisions
    result.push(points[idx]);
    prevIdx = idx;
  }
  return result;
}

/** Breadcrumbs → GeoJSON LineString. GeoJSON is [lon, lat] order. */
export function toLineString(points: LatLon[]): LineStringFeature {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [p.lon, p.lat] as [number, number]),
    },
    properties: {},
  };
}

/** Single breadcrumb → GeoJSON Point (for start/end markers). */
export function toPoint(p: LatLon): PointFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: {},
  };
}

// Minimum bounds span (degrees, ≈220 m) so a near-stationary trip doesn't
// make the camera zoom into a zero-area box.
const MIN_SPAN_DEG = 0.002;

// Half-span used when widening a too-small axis. The 1.0001 safety factor
// absorbs double-precision rounding at earth-coordinate magnitudes (e.g.
// 47.601 - 47.599 === 0.001999999999995339), guaranteeing the widened span
// still measures >= MIN_SPAN_DEG.
const HALF_SPAN_DEG = (MIN_SPAN_DEG / 2) * 1.0001;

/**
 * Bounding box of a route as [west, south, east, north] — GeoJSON bbox order,
 * which is also MapLibre v11's LngLatBounds shape.
 */
export function routeBounds(points: LatLon[]): [number, number, number, number] {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  if (maxLat - minLat < MIN_SPAN_DEG) {
    const mid = (maxLat + minLat) / 2;
    minLat = mid - HALF_SPAN_DEG;
    maxLat = mid + HALF_SPAN_DEG;
  }
  if (maxLon - minLon < MIN_SPAN_DEG) {
    const mid = (maxLon + minLon) / 2;
    minLon = mid - HALF_SPAN_DEG;
    maxLon = mid + HALF_SPAN_DEG;
  }

  return [minLon, minLat, maxLon, maxLat];
}
