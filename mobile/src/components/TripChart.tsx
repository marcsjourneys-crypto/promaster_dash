/**
 * Trip temperature chart — shows trans temp, coolant temp, and grade over time.
 * Designed for mobile: compact, readable, matches app dark/amber theme.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  useWindowDimensions,
  StyleSheet,
} from 'react-native';
import Svg, {
  Path,
  Line,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import { getTripChartData, type ChartPoint } from '../services/loggingService';
import { colors } from '../config/theme';

// Chart layout (all in points)
const CHART_H = 180;       // total SVG height
const PAD_LEFT = 38;       // y-axis label column
const PAD_RIGHT = 8;
const PAD_TOP = 18;        // legend row at top
const PAD_BOTTOM = 14;     // x-axis label row
const GRADE_H = 18;        // grade bar height
const GRADE_GAP = 4;       // gap between plot and grade bar

// Plot area height = CHART_H - PAD_TOP - PAD_BOTTOM - GRADE_H - GRADE_GAP
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM - GRADE_H - GRADE_GAP;

const TRANS_WARN_F = 230;

// Card padding to subtract from screen width: list (12*2) + card (14*2)
const CARD_INSET = 52;

interface Props {
  tripId: number;
}

export function TripChart({ tripId }: Props) {
  const { width: screenW } = useWindowDimensions();
  const svgW = screenW - CARD_INSET;
  const plotW = svgW - PAD_LEFT - PAD_RIGHT;

  const [points, setPoints] = useState<ChartPoint[] | null>(null);

  useEffect(() => {
    setPoints(null);
    getTripChartData(tripId).then(setPoints);
  }, [tripId]);

  if (points === null) {
    return (
      <View style={[styles.container, { height: CHART_H }]}>
        <ActivityIndicator color={colors.amber} size="small" />
      </View>
    );
  }

  // Need at least 2 points with some temperature data
  const hasAnyTemp = points.some((p) => p.transF !== null || p.coolantF !== null);
  if (points.length < 2 || !hasAnyTemp) {
    return (
      <View style={[styles.container, { height: 40 }]}>
        <Text style={styles.noData}>No chart data for this trip</Text>
      </View>
    );
  }

  // ---- Compute Y scale (temperature) ----
  const transVals = points.map((p) => p.transF).filter((v): v is number => v !== null);
  const coolantVals = points.map((p) => p.coolantF).filter((v): v is number => v !== null);
  const allTemps = [...transVals, ...coolantVals];

  const rawMin = Math.min(...allTemps);
  const rawMax = Math.max(...allTemps);
  // Ensure at least 60°F visible range; snap to 10°F grid
  const center = (rawMin + rawMax) / 2;
  const half = Math.max((rawMax - rawMin) / 2, 30);
  const tempMin = Math.floor((center - half - 10) / 10) * 10;
  const tempMax = Math.ceil((center + half + 10) / 10) * 10;

  // ---- Compute X scale (time) ----
  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const tsDelta = tsMax - tsMin || 1;

  const toX = (ts: number) => PAD_LEFT + ((ts - tsMin) / tsDelta) * plotW;
  const toY = (temp: number) =>
    PAD_TOP + ((tempMax - temp) / (tempMax - tempMin)) * PLOT_H;

  // ---- Build SVG path strings ----
  const buildPath = (key: 'transF' | 'coolantF'): string => {
    let d = '';
    let first = true;
    for (const p of points) {
      const val = p[key];
      if (val === null) { first = true; continue; }
      const x = toX(p.ts);
      const y = toY(val);
      d += first ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      first = false;
    }
    return d;
  };

  const transPath = transVals.length > 0 ? buildPath('transF') : '';
  const coolantPath = coolantVals.length > 0 ? buildPath('coolantF') : '';

  // ---- Warning threshold ----
  const warnY = toY(TRANS_WARN_F);
  const showWarn = TRANS_WARN_F > tempMin && TRANS_WARN_F < tempMax;

  // ---- Y-axis tick labels (4 evenly spaced) ----
  const tickRange = tempMax - tempMin;
  const rawStep = tickRange / 3;
  const tickStep = Math.ceil(rawStep / 10) * 10;
  const yTicks: number[] = [];
  for (let t = tempMin; t <= tempMax + 1; t += tickStep) {
    if (t >= tempMin && t <= tempMax) yTicks.push(t);
  }

  // ---- Grade bar segments ----
  const gradeBarY = PAD_TOP + PLOT_H + GRADE_GAP;
  const gradeRects: { x: number; w: number; color: string }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    const g = p.gradePct;
    if (g === null) continue;
    const x = toX(p.ts);
    const x2 = toX(points[i + 1].ts);
    const w = Math.max(x2 - x, 0.5);
    let color: string;
    if (g > 4)       color = 'rgba(40,160,80,0.75)';
    else if (g > 1)  color = 'rgba(40,160,80,0.35)';
    else if (g < -4) color = 'rgba(60,120,200,0.75)';
    else if (g < -1) color = 'rgba(60,120,200,0.35)';
    else              color = 'rgba(80,70,55,0.25)';
    gradeRects.push({ x, w, color });
  }

  // ---- X-axis time labels ----
  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const xAxisY = CHART_H - 2;

  return (
    <View style={styles.container}>
      <Svg width={svgW} height={CHART_H}>

        {/* Subtle horizontal grid lines */}
        {yTicks.map((t) => {
          const y = toY(t);
          if (y < PAD_TOP || y > PAD_TOP + PLOT_H) return null;
          return (
            <Line
              key={`g${t}`}
              x1={PAD_LEFT} y1={y}
              x2={PAD_LEFT + plotW} y2={y}
              stroke="rgba(255,220,160,0.07)"
              strokeWidth={1}
            />
          );
        })}

        {/* Warning threshold dashed line */}
        {showWarn && (
          <Line
            x1={PAD_LEFT} y1={warnY}
            x2={PAD_LEFT + plotW} y2={warnY}
            stroke="rgba(220,140,35,0.45)"
            strokeWidth={1}
            strokeDasharray="5,4"
          />
        )}

        {/* Grade colour bar */}
        {gradeRects.map((r, i) => (
          <Rect key={i} x={r.x} y={gradeBarY} width={r.w} height={GRADE_H} fill={r.color} />
        ))}

        {/* Coolant line — thinner, muted blue */}
        {coolantPath !== '' && (
          <Path
            d={coolantPath}
            stroke="rgba(100,160,220,0.55)"
            strokeWidth={1.5}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Trans temp line — amber, primary */}
        {transPath !== '' && (
          <Path
            d={transPath}
            stroke="rgba(220,140,35,0.92)"
            strokeWidth={2}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Y-axis tick labels */}
        {yTicks.map((t) => {
          const y = toY(t);
          if (y < PAD_TOP - 2 || y > PAD_TOP + PLOT_H + 2) return null;
          return (
            <SvgText
              key={`l${t}`}
              x={PAD_LEFT - 4}
              y={y + 4}
              fontSize={10}
              fill="rgba(255,235,205,0.55)"
              textAnchor="end"
            >
              {t}°
            </SvgText>
          );
        })}

        {/* WARN label next to threshold */}
        {showWarn && (
          <SvgText
            x={PAD_LEFT + plotW}
            y={warnY - 3}
            fontSize={9}
            fill="rgba(220,140,35,0.55)"
            textAnchor="end"
          >
            WARN
          </SvgText>
        )}

        {/* X-axis time labels */}
        <SvgText x={PAD_LEFT} y={xAxisY} fontSize={10} fill="rgba(255,235,205,0.45)" textAnchor="start">
          {fmtTime(tsMin)}
        </SvgText>
        <SvgText x={PAD_LEFT + plotW / 2} y={xAxisY} fontSize={10} fill="rgba(255,235,205,0.45)" textAnchor="middle">
          {fmtTime((tsMin + tsMax) / 2)}
        </SvgText>
        <SvgText x={PAD_LEFT + plotW} y={xAxisY} fontSize={10} fill="rgba(255,235,205,0.45)" textAnchor="end">
          {fmtTime(tsMax)}
        </SvgText>

        {/* Grade bar label */}
        <SvgText
          x={PAD_LEFT - 4}
          y={gradeBarY + GRADE_H / 2 + 4}
          fontSize={9}
          fill="rgba(255,235,205,0.35)"
          textAnchor="end"
        >
          GRD
        </SvgText>

        {/* Legend row at top */}
        {transPath !== '' && (
          <>
            <Line x1={PAD_LEFT} y1={9} x2={PAD_LEFT + 14} y2={9} stroke="rgba(220,140,35,0.9)" strokeWidth={2} />
            <SvgText x={PAD_LEFT + 18} y={13} fontSize={9} fill="rgba(255,235,205,0.6)">TRANS</SvgText>
          </>
        )}
        {coolantPath !== '' && (
          <>
            <Line x1={PAD_LEFT + 52} y1={9} x2={PAD_LEFT + 66} y2={9} stroke="rgba(100,160,220,0.55)" strokeWidth={1.5} />
            <SvgText x={PAD_LEFT + 70} y={13} fontSize={9} fill="rgba(255,235,205,0.6)">COOL</SvgText>
          </>
        )}
        {gradeRects.length > 0 && (
          <>
            <Rect x={PAD_LEFT + 104} y={4} width={10} height={10} fill="rgba(40,160,80,0.5)" />
            <SvgText x={PAD_LEFT + 118} y={13} fontSize={9} fill="rgba(255,235,205,0.6)">CLIMB</SvgText>
            <Rect x={PAD_LEFT + 152} y={4} width={10} height={10} fill="rgba(60,120,200,0.5)" />
            <SvgText x={PAD_LEFT + 166} y={13} fontSize={9} fill="rgba(255,235,205,0.6)">DESC</SvgText>
          </>
        )}

      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(14, 12, 9, 0.7)',
    borderRadius: 8,
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  noData: {
    color: 'rgba(255,235,205,0.35)',
    fontSize: 11,
    textAlign: 'center',
  },
});
