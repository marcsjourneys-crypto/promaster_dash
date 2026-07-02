/**
 * Map tile/style configuration — the ONLY place in the app that knows where
 * basemap tiles come from.
 *
 * Current source: OpenFreeMap (https://openfreemap.org) — keyless, no usage
 * cap, commercial use permitted, donation-funded OSM vector tiles.
 *
 * Using OpenFreeMap's official `dark` style (near-black background,
 * rgb(12,12,12)) to match the app's dark matte bronze/amber theme.
 * Their default full style is `liberty` (light).
 *
 * Future offline support (PMTiles region packs) or a custom dark style JSON
 * matching the app theme should change this constant and nothing else.
 */

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
