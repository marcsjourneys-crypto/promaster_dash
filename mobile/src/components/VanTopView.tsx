/**
 * Top-down ProMaster with a pressure callout at each wheel — the layout of
 * the factory cluster's tire page, in the app's palette.
 *
 * Everything is drawn in one SVG viewBox so text and van scale together.
 */

import React from 'react';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { colors } from '../config/theme';
import type { TirePosition } from '../config/tpmsConfig';
import { formatAge, type TireStatus, type TireView } from '../utils/tpmsLayout';
import type { Units } from '../utils/units';

interface VanTopViewProps {
  tires: Record<TirePosition, TireView>;
  units: Units;
}

const W = 320;
const H = 460;
const BODY_X = 112;
const BODY_W = 96;
const FRONT_Y = 92;  // front axle centre
const REAR_Y = 350;  // rear axle centre

const STATUS_COLOR: Record<TireStatus, string> = {
  ok: colors.textPrimary,
  lowWarn: 'rgb(245, 160, 40)',
  high: 'rgb(245, 160, 40)',
  hot: 'rgb(245, 160, 40)',
  lowCrit: 'rgb(240, 80, 60)',
  noData: 'rgba(150, 145, 135, 0.6)',
};

const CORNERS: { position: TirePosition; left: boolean; y: number }[] = [
  { position: 'LF', left: true, y: FRONT_Y },
  { position: 'RF', left: false, y: FRONT_Y },
  { position: 'LR', left: true, y: REAR_Y },
  { position: 'RR', left: false, y: REAR_Y },
];

function subtitle(t: TireView, units: Units): string {
  if (!t.sensorId) return 'not assigned';
  if (!t.reading) return 'waiting';
  return `${units.temp(t.reading.tempF)}${units.tempLabel} · ${formatAge(t.ageMs)}`;
}

export function VanTopView({ tires, units }: VanTopViewProps) {
  // "4.48" in bar is twice as wide as "65" in psi; each callout has ~90 units.
  const valueSize = units.pressureUnit === 'psi' ? 44 : 34;
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {/* Body */}
      <Rect
        x={BODY_X} y={40} width={BODY_W} height={390} rx={24}
        fill="rgba(60, 55, 45, 0.9)" stroke={colors.amberBorder} strokeWidth={2}
      />
      {/* Windshield and cab roof line */}
      <Path d="M122 118 L128 78 L192 78 L198 118 Z" fill="rgba(22, 20, 16, 0.95)" />
      <Line x1={BODY_X + 6} y1={158} x2={BODY_X + BODY_W - 6} y2={158} stroke={colors.amberBorder} strokeWidth={2} />
      {/* Mirrors */}
      <Rect x={98} y={126} width={14} height={10} rx={3} fill="rgba(60, 55, 45, 0.9)" />
      <Rect x={208} y={126} width={14} height={10} rx={3} fill="rgba(60, 55, 45, 0.9)" />
      {/* Rear doors */}
      <Line x1={160} y1={392} x2={160} y2={428} stroke={colors.amberBorder} strokeWidth={2} />

      {CORNERS.map(({ position, left, y }) => {
        const t = tires[position];
        const color = STATUS_COLOR[t.status];
        const opacity = t.stale ? 0.45 : 1;
        const wheelX = left ? BODY_X - 12 : BODY_X + BODY_W;
        const lineX1 = left ? 8 : BODY_X + BODY_W + 14;
        const lineX2 = left ? BODY_X - 14 : W - 8;
        const textX = (lineX1 + lineX2) / 2;
        return (
          <React.Fragment key={position}>
            <Rect
              x={wheelX} y={y - 22} width={12} height={44} rx={3}
              fill={t.status === 'noData' ? 'rgba(80, 70, 55, 0.7)' : color}
              opacity={opacity}
            />
            <Line x1={lineX1} y1={y} x2={lineX2} y2={y} stroke={color} strokeWidth={3} opacity={opacity} />
            <SvgText
              x={textX} y={y - 10} fontSize={valueSize} fontWeight="bold"
              fill={color} textAnchor="middle" opacity={opacity}
            >
              {t.reading ? units.pressure(t.reading.psi) : '--'}
            </SvgText>
            <SvgText
              x={textX} y={y + 24} fontSize={14} fontWeight="bold"
              fill={colors.textMuted} textAnchor="middle" opacity={opacity}
            >
              {subtitle(t, units)}
            </SvgText>
            <SvgText
              x={textX} y={y + 42} fontSize={11}
              fill="rgba(150, 145, 135, 0.78)" textAnchor="middle"
            >
              {position}{t.stale ? ' · STALE' : ''}
            </SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}
