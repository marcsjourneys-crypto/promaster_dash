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
  Map as MapLibreMap, // aliased: 'Map' would shadow the JS global
  Camera,
  GeoJSONSource,
  Layer,
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
  const bounds = routeBounds(points); // [west, south, east, north]
  return (
    <MapLibreMap
      style={StyleSheet.absoluteFill}
      mapStyle={MAP_STYLE_URL}
      dragPan={interactive}
      touchZoom={interactive}
      doubleTapZoom={interactive}
      touchRotate={interactive}
      touchPitch={false}
      attribution={true}
    >
      <Camera
        initialViewState={{
          bounds,
          padding: {
            top: CAMERA_PADDING,
            right: CAMERA_PADDING,
            bottom: CAMERA_PADDING,
            left: CAMERA_PADDING,
          },
        }}
      />
      <GeoJSONSource id="route" data={toLineString(points)}>
        <Layer
          type="line"
          id="routeLine"
          paint={{ 'line-color': colors.amber, 'line-width': 3 }}
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="routeStart" data={toPoint(points[0])}>
        <Layer
          type="circle"
          id="routeStartCircle"
          paint={{
            'circle-color': colors.gpsOk,
            'circle-radius': 6,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="routeEnd" data={toPoint(points[points.length - 1])}>
        <Layer
          type="circle"
          id="routeEndCircle"
          paint={{
            'circle-color': colors.segCrit,
            'circle-radius': 6,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          }}
        />
      </GeoJSONSource>
    </MapLibreMap>
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
