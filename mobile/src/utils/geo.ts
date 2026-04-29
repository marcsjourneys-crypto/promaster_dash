/** Geographic utility functions for distance and unit conversions. */

const EARTH_RADIUS_MI = 3958.8;
const EARTH_RADIUS_M = 6371000;

export const FEET_PER_METER = 3.28084;
export const METERS_PER_FOOT = 0.3048;
export const KPH_TO_MPH = 0.621371;
export const MPS_TO_MPH = 2.23694;

/** Great-circle distance in miles between two lat/lon points. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;

  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));

  return EARTH_RADIUS_MI * c;
}

/** Great-circle distance in meters between two lat/lon points. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;

  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));

  return EARTH_RADIUS_M * c;
}

export function metersToFeet(meters: number): number {
  return meters * FEET_PER_METER;
}

export function feetToMeters(feet: number): number {
  return feet * METERS_PER_FOOT;
}

export function kphToMph(kph: number): number {
  return kph * KPH_TO_MPH;
}

export function mpsToMph(mps: number): number {
  return mps * MPS_TO_MPH;
}
