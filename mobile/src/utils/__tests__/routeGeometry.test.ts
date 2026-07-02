import {
  hasRenderableRoute,
  downsample,
  toLineString,
  toPoint,
  routeBounds,
} from '../routeGeometry';

const pt = (lat: number, lon: number) => ({ lat, lon });

describe('hasRenderableRoute', () => {
  it('is false for 0 or 1 points', () => {
    expect(hasRenderableRoute([])).toBe(false);
    expect(hasRenderableRoute([pt(47, -122)])).toBe(false);
  });

  it('is true for 2+ points', () => {
    expect(hasRenderableRoute([pt(47, -122), pt(47.1, -122.1)])).toBe(true);
  });
});

describe('downsample', () => {
  it('returns input unchanged when already small enough', () => {
    const points = [1, 2, 3];
    expect(downsample(points, 500)).toEqual([1, 2, 3]);
  });

  it('reduces to maxPoints, keeping first and last', () => {
    const points = Array.from({ length: 2000 }, (_, i) => i);
    const result = downsample(points, 500);
    expect(result.length).toBe(500);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(1999);
  });

  it('preserves ascending order (no duplicates from rounding)', () => {
    const points = Array.from({ length: 777 }, (_, i) => i);
    const result = downsample(points, 500);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1]);
    }
  });

  it('handles step just above 1 (501 points to 500) without duplicates', () => {
    const points = Array.from({ length: 501 }, (_, i) => i);
    const result = downsample(points, 500);
    expect(result.length).toBe(500);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(500);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1]);
    }
  });
});

describe('toLineString', () => {
  it('produces GeoJSON coordinates in [lon, lat] order', () => {
    const line = toLineString([pt(47.6, -122.3), pt(47.7, -122.4)]);
    expect(line.type).toBe('Feature');
    expect(line.geometry.type).toBe('LineString');
    expect(line.geometry.coordinates).toEqual([
      [-122.3, 47.6],
      [-122.4, 47.7],
    ]);
  });
});

describe('toPoint', () => {
  it('produces a GeoJSON point in [lon, lat] order', () => {
    const p = toPoint(pt(47.6, -122.3));
    expect(p.geometry.type).toBe('Point');
    expect(p.geometry.coordinates).toEqual([-122.3, 47.6]);
  });
});

describe('routeBounds', () => {
  it('returns a [west, south, east, north] bbox', () => {
    const b = routeBounds([pt(47.6, -122.3), pt(47.8, -122.1), pt(47.7, -122.5)]);
    expect(b).toEqual([-122.5, 47.6, -122.1, 47.8]);
  });

  it('enforces a minimum span for near-stationary routes', () => {
    const b = routeBounds([pt(47.6, -122.3), pt(47.6, -122.3)]);
    expect(b[2] - b[0]).toBeGreaterThanOrEqual(0.002);
    expect(b[3] - b[1]).toBeGreaterThanOrEqual(0.002);
  });
});
