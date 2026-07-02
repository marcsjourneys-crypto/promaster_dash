# Trip Route Map — Design Document

**Date:** 2026-07-02
**Status:** Approved

## Summary

Add a map view to trip history so users can see their recorded routes. A non-interactive map preview appears in the expanded trip card (TripsScreen), drawing the trip's breadcrumb trail as a polyline over a basemap; tapping it opens a full-screen interactive map. Zero recurring cost: MapLibre (open source) + OpenFreeMap public tiles (no API key, no usage cap, commercial use permitted).

## Constraints & Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Recurring cost | $0 — hard requirement | Flat-fee app; no metered tile APIs (Google/Mapbox/MapTiler rejected) |
| Renderer | `@maplibre/maplibre-react-native` | Open source, Expo config plugin, works with existing dev-client flow |
| Tiles | OpenFreeMap public style URLs | Free, keyless, no cap; donation-funded OSM vector tiles |
| Platforms | iOS + Android | Android is a near-term target; same code runs on both |
| Offline | Nice-to-have later, not v1 | MapLibre supports PMTiles later via a style URL swap in one config file |
| Scope | Trip detail only | No live/dashboard map in v1 |

Rejected alternatives:
- **Apple Maps (react-native-maps):** free but iOS-only and no offline path.
- **Google Maps native SDK:** free map loads but requires billing account + API key.
- **SVG route sketch (no basemap):** kept as the implicit offline fallback — the polyline renders even when tiles don't load.

## Architecture

### New files

- `src/config/mapConfig.ts` — exports `MAP_STYLE_URL` (OpenFreeMap style). The **only** place that knows the tile source; future offline PMTiles = swap here.
- `src/utils/routeGeometry.ts` — pure functions: breadcrumbs → GeoJSON LineString, downsample (stride to ~500 points for preview), bounds + padding computation, `hasRenderableRoute()` (≥2 points).
- `src/components/TripMap.tsx` — thin MapLibre wrapper: `ShapeSource` + `LineLayer` (amber trail on dark basemap), start (green) / end (red) markers, camera fitted to bounds. Prop-switched between preview mode (gestures off, ~200px) and fullscreen mode (gestures on).
- Fullscreen presentation: modal from TripsScreen with close button and a trip name + distance overlay chip.

### Data flow

`TripMapSection` self-fetches via the existing `getTripBreadcrumbs(tripId)`, mirroring TripChart's self-contained fetch pattern (TripChart uses its own `getTripChartData` query). No new service functions or schema changes; one extra local SQLite query per card expansion is negligible.

### Placement

TripMap preview sits above TripChart inside the expanded card. Preview is non-interactive (map gestures conflict with FlatList scrolling); tap → fullscreen modal with full pan/zoom. Trips with <2 breadcrumbs show no map (no error state).

## Failure Modes

- **No connectivity / tile server down:** polyline is rendered locally by MapLibre and always draws; basemap degrades to blank. MapLibre's ambient cache keeps previously-viewed areas working offline for free.
- **Short/empty trips:** guarded by `hasRenderableRoute()`; preview hidden.

## Testing

- Unit tests (Jest) for `routeGeometry.ts`: GeoJSON conversion, downsampling, bounds math, <2-point guard.
- Native map view is not Jest-renderable — component stays thin; logic lives in the tested pure module.
- On-device verification with real trips + seeded demo trips.

## Build Impact

- `npx expo install @maplibre/maplibre-react-native`; add its plugin to `app.json`.
- Rebuild dev client via EAS (same flow as the BLE module).
- No new permissions or Info.plist entries.

## Future (explicitly out of scope for v1)

- Offline region packs (PMTiles) — enabled by the mapConfig indirection.
- Custom dark style JSON matching the bronze/amber theme.
- Speed-colored polyline, waypoint scrubbing, live dashboard map.
