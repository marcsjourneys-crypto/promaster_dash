# Trip Route Map Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a trip's GPS route on a map — a non-interactive preview in the expanded trip card, tap to open a fullscreen interactive map. Zero recurring cost.

**Architecture:** MapLibre renderer (`@maplibre/maplibre-react-native`) + OpenFreeMap keyless tile URLs. Tile source isolated in `mapConfig.ts` (future offline swap point). Pure geometry logic (downsample, GeoJSON, bounds) in a tested utils module; the map component stays thin and untested-by-Jest (native view). Data comes from the existing `getTripBreadcrumbs()` — no schema or query changes.

**Tech Stack:** Expo SDK 54 / RN 0.81 / TypeScript, `@maplibre/maplibre-react-native`, Jest (jest-expo), existing `expo-sqlite` data layer.

**Design doc:** `docs/plans/2026-07-02-trip-map-design.md`

**Working directory:** all commands run from `mobile/` inside the worktree (`.worktrees/trip-map/mobile`). All file paths below are relative to `mobile/`.

**Verification commands:**
- Tests: `npx jest --silent`
- Types: `npx tsc --noEmit`

---

### Task 1: Install MapLibre and register its config plugin

**Files:**
- Modify: `package.json` (via expo install)
- Modify: `app.json` (plugins array)

**Step 1: Install the package**

Run: `npx expo install @maplibre/maplibre-react-native`

Expected: package added to `package.json` dependencies without errors.

**Step 2: Verify the package's actual exports and Camera API**

The code in Tasks 4–5 assumes the v10+ named-export API. Confirm before writing component code:

Run: `ls node_modules/@maplibre/maplibre-react-native/` then read the package's type entry point (check `package.json` `types` field, typically `lib/typescript/index.d.ts` or similar).

Confirm these exports exist: `MapView`, `Camera`, `ShapeSource`, `LineLayer`, `CircleLayer`. Confirm `Camera` accepts bounds (either a `bounds` prop or `defaultSettings={{ bounds: { ne, sw, ... } }}`) and note the exact padding field names. Confirm `MapView` props: `mapStyle`, `zoomEnabled`, `scrollEnabled`, `rotateEnabled`, `pitchEnabled`, `attributionEnabled`.

**If the API differs** (e.g. older default-export namespace `MapLibreGL.MapView`), adapt the Task 4 code accordingly — the structure stays identical.

**Step 3: Add the config plugin to app.json**

In `app.json`, add to the existing `expo.plugins` array (check the package README for the exact plugin name — normally the bare package name):

```json
"plugins": [
  ["react-native-ble-plx", { "isBackgroundEnabled": true, "neverForLocation": true }],
  ["expo-location", { ... existing ... }],
  "expo-sqlite",
  "@maplibre/maplibre-react-native"
]
```

(Leave existing entries untouched; append the new one.)

**Step 4: Verify nothing broke**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npx jest --silent` — Expected: 9 tests pass (baseline).

**Step 5: Commit**

```bash
git add package.json package-lock.json app.json
git commit -m "feat: add @maplibre/maplibre-react-native dependency and plugin"
```

---

### Task 2: Map configuration module (the offline-swap indirection)

**Files:**
- Create: `src/config/mapConfig.ts`

**Step 1: Create the file**

```ts
/**
 * Map tile/style configuration — the ONLY place in the app that knows where
 * basemap tiles come from.
 *
 * Current source: OpenFreeMap (https://openfreemap.org) — keyless, no usage
 * cap, commercial use permitted, donation-funded OSM vector tiles.
 *
 * Future offline support (PMTiles region packs) or a custom dark style JSON
 * matching the app theme should change this constant and nothing else.
 */

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
```

Note: `liberty` is OpenFreeMap's default full style. Optionally check https://openfreemap.org for a dark style variant (e.g. `/styles/dark` or `/styles/fiord`) — if one exists, prefer it (the app is dark-themed). Verify any URL you pick loads in a browser before committing.

**Step 2: Verify**

Run: `npx tsc --noEmit` — Expected: no errors.

**Step 3: Commit**

```bash
git add src/config/mapConfig.ts
git commit -m "feat: add map style config (OpenFreeMap, keyless)"
```

---

### Task 3: Route geometry utils (TDD)

**Files:**
- Create: `src/utils/__tests__/routeGeometry.test.ts`
- Create: `src/utils/routeGeometry.ts`

**Step 1: Write the failing tests**

Create `src/utils/__tests__/routeGeometry.test.ts`:

```ts
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
  it('returns sw/ne corners in [lon, lat] order', () => {
    const b = routeBounds([pt(47.6, -122.3), pt(47.8, -122.1), pt(47.7, -122.5)]);
    expect(b.sw).toEqual([-122.5, 47.6]);
    expect(b.ne).toEqual([-122.1, 47.8]);
  });

  it('enforces a minimum span for near-stationary routes', () => {
    const b = routeBounds([pt(47.6, -122.3), pt(47.6, -122.3)]);
    expect(b.ne[0] - b.sw[0]).toBeGreaterThanOrEqual(0.002);
    expect(b.ne[1] - b.sw[1]).toBeGreaterThanOrEqual(0.002);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest routeGeometry --silent`
Expected: FAIL — "Cannot find module '../routeGeometry'"

**Step 3: Write the implementation**

Create `src/utils/routeGeometry.ts`:

```ts
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

/** Bounding box of a route as sw/ne corners in [lon, lat] order. */
export function routeBounds(points: LatLon[]): {
  sw: [number, number];
  ne: [number, number];
} {
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
    minLat = mid - MIN_SPAN_DEG / 2;
    maxLat = mid + MIN_SPAN_DEG / 2;
  }
  if (maxLon - minLon < MIN_SPAN_DEG) {
    const mid = (maxLon + minLon) / 2;
    minLon = mid - MIN_SPAN_DEG / 2;
    maxLon = mid + MIN_SPAN_DEG / 2;
  }

  return { sw: [minLon, minLat], ne: [maxLon, maxLat] };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx jest routeGeometry --silent`
Expected: PASS (8 tests)

Run: `npx jest --silent` — Expected: all suites pass (9 baseline + 8 new).

**Step 5: Commit**

```bash
git add src/utils/routeGeometry.ts src/utils/__tests__/routeGeometry.test.ts
git commit -m "feat: add route geometry utils (downsample, GeoJSON, bounds)"
```

---

### Task 4: TripMap component (preview + fullscreen modal)

**Files:**
- Create: `src/components/TripMap.tsx`

No Jest test — this renders a native map view. All logic it consumes was tested in Task 3. Verification is `tsc` here and on-device in Task 6.

**Step 1: Create the component**

Adjust MapLibre import/prop names if Task 1 Step 2 found a different API shape.

```tsx
/**
 * Trip route map — preview (non-interactive, in the expanded trip card)
 * plus a fullscreen interactive modal.
 *
 * The route polyline renders locally even when tiles can't load (offline),
 * so there is no hard network dependency. Basemap source: see mapConfig.ts.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, SafeAreaView } from 'react-native';
import {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  CircleLayer,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE_URL } from '../config/mapConfig';
import { getTripBreadcrumbs } from '../services/loggingService';
import { colors, fonts } from '../config/theme';
import {
  hasRenderableRoute,
  downsample,
  toLineString,
  toPoint,
  routeBounds,
  type LatLon,
} from '../utils/routeGeometry';

const PREVIEW_HEIGHT = 200;
const PREVIEW_MAX_POINTS = 500;
const CAMERA_PADDING = 40;

/** Shared presentational map: basemap + route line + start/end markers. */
function RouteMap({ points, interactive }: { points: LatLon[]; interactive: boolean }) {
  const bounds = routeBounds(points);
  return (
    <MapView
      style={StyleSheet.absoluteFill}
      mapStyle={MAP_STYLE_URL}
      zoomEnabled={interactive}
      scrollEnabled={interactive}
      rotateEnabled={interactive}
      pitchEnabled={false}
      attributionEnabled={true}
    >
      <Camera
        defaultSettings={{
          bounds: {
            ne: bounds.ne,
            sw: bounds.sw,
            paddingTop: CAMERA_PADDING,
            paddingBottom: CAMERA_PADDING,
            paddingLeft: CAMERA_PADDING,
            paddingRight: CAMERA_PADDING,
          },
        }}
      />
      <ShapeSource id="route" shape={toLineString(points)}>
        <LineLayer
          id="routeLine"
          style={{
            lineColor: colors.amber,
            lineWidth: 3,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      </ShapeSource>
      <ShapeSource id="routeStart" shape={toPoint(points[0])}>
        <CircleLayer
          id="routeStartCircle"
          style={{
            circleColor: colors.gpsOk,
            circleRadius: 6,
            circleStrokeWidth: 2,
            circleStrokeColor: '#ffffff',
          }}
        />
      </ShapeSource>
      <ShapeSource id="routeEnd" shape={toPoint(points[points.length - 1])}>
        <CircleLayer
          id="routeEndCircle"
          style={{
            circleColor: colors.segCrit,
            circleRadius: 6,
            circleStrokeWidth: 2,
            circleStrokeColor: '#ffffff',
          }}
        />
      </ShapeSource>
    </MapView>
  );
}

interface TripMapSectionProps {
  tripId: number;
  tripName: string | null | undefined;
  distanceMi: number;
}

/**
 * Fetches breadcrumbs itself (same self-contained pattern as TripChart) and
 * renders nothing while loading or when the trip has fewer than 2 points.
 */
export function TripMapSection({ tripId, tripName, distanceMi }: TripMapSectionProps) {
  const [crumbs, setCrumbs] = useState<LatLon[] | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setCrumbs(null);
    getTripBreadcrumbs(tripId).then((rows) =>
      setCrumbs(rows.map((r) => ({ lat: r.lat, lon: r.lon }))),
    );
  }, [tripId]);

  if (crumbs === null || !hasRenderableRoute(crumbs)) return null;

  const previewPoints = downsample(crumbs, PREVIEW_MAX_POINTS);

  return (
    <>
      <Pressable style={styles.preview} onPress={() => setFullscreen(true)}>
        {/* pointerEvents=none so the Pressable gets the tap, not the map */}
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <RouteMap points={previewPoints} interactive={false} />
        </View>
        <View style={styles.expandHint}>
          <Text style={styles.expandHintText}>TAP TO EXPAND</Text>
        </View>
      </Pressable>

      <Modal
        visible={fullscreen}
        animationType="slide"
        onRequestClose={() => setFullscreen(false)}
      >
        <View style={styles.fullscreen}>
          <RouteMap points={crumbs} interactive={true} />
          <SafeAreaView style={styles.overlay} pointerEvents="box-none">
            <View style={styles.overlayRow} pointerEvents="box-none">
              <View style={styles.chip}>
                <Text style={styles.chipText}>
                  {tripName || 'TRIP'} · {distanceMi.toFixed(1)} mi
                </Text>
              </View>
              <Pressable style={styles.closeBtn} onPress={() => setFullscreen(false)}>
                <Text style={styles.closeBtnText}>✕ CLOSE</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  preview: {
    height: PREVIEW_HEIGHT,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.amberBorder,
    marginBottom: 10,
    backgroundColor: colors.bg,
  },
  expandHint: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    backgroundColor: colors.bgPill,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  expandHintText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  fullscreen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  overlayRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  chip: {
    backgroundColor: colors.bgPill,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexShrink: 1,
  },
  chipText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  closeBtn: {
    backgroundColor: colors.bgPill,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amberBorder,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginLeft: 10,
  },
  closeBtnText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
});
```

**Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If MapLibre prop names differ (e.g. `styleURL` instead of `mapStyle`, or `Camera bounds` shape), fix per the types you confirmed in Task 1 Step 2.

**Step 3: Run full test suite (regression check)**

Run: `npx jest --silent` — Expected: all pass.

**Step 4: Commit**

```bash
git add src/components/TripMap.tsx
git commit -m "feat: add TripMap component (route preview + fullscreen modal)"
```

---

### Task 5: Integrate into TripsScreen

**Files:**
- Modify: `src/screens/TripsScreen.tsx` (import block ~line 17; expanded-card render at line 117)

**Step 1: Add the import**

After the existing `TripChart` import (line 17):

```ts
import { TripMapSection } from '../components/TripMap';
```

**Step 2: Render the map above the chart in the expanded card**

Replace line 117:

```tsx
      {expanded && <TripChart tripId={trip.id} />}
```

with:

```tsx
      {expanded && (
        <>
          <TripMapSection
            tripId={trip.id}
            tripName={trip.name}
            distanceMi={trip.distanceMi}
          />
          <TripChart tripId={trip.id} />
        </>
      )}
```

**Step 3: Verify**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npx jest --silent` — Expected: all pass.

**Step 4: Commit**

```bash
git add src/screens/TripsScreen.tsx
git commit -m "feat: show route map in expanded trip card"
```

---

### Task 6: Dev-client rebuild and on-device verification

MapLibre is a native module: the map will NOT appear in the existing dev client. A rebuild is required (same flow as when BLE was added). This task needs Marc (EAS account, physical iPhone).

**Step 1: Rebuild the iOS dev client**

Run: `eas build --profile development --platform ios`
Install the resulting build on the iPhone.

**Step 2: On-device checklist**

1. Settings → enable demo mode (seeds demo trips with Seattle-area breadcrumbs).
2. Trips → expand a demo trip → map preview renders: dark card, basemap, amber route line, green start / red end dots, camera fitted to route.
3. Scroll the trips list with a finger starting on the preview — list must scroll (preview gestures disabled).
4. Tap preview → fullscreen modal: pinch/zoom/pan work; chip shows name + distance; CLOSE returns.
5. Expand a trip, collapse, expand another — no crash, correct route per trip.
6. Airplane mode → expand a trip: route line still renders (blank/cached basemap is acceptable); app never blocks.
7. Real trip with GPS off (0–1 breadcrumbs) → no map section, no error.
8. Switch demo mode back off → verify real trips list intact.

**Step 3: Commit any device-found fixes, then wrap up**

Use superpowers:finishing-a-development-branch — merge `feature/trip-map` to main only after on-device verification passes.

---

## Out of Scope (per design doc)

- Offline PMTiles region packs (future: swap `MAP_STYLE_URL`)
- Custom dark style JSON matching the bronze/amber theme
- Speed-colored polyline, waypoint scrubbing, live dashboard map
