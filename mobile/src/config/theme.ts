/** Design tokens ported from the Qt stylesheet. */

export const colors = {
  // Backgrounds
  bg: '#161410',
  bgCard: 'rgba(22, 20, 16, 0.92)',
  bgPill: 'rgba(25, 22, 17, 0.82)',
  bgTrip: 'rgba(25, 45, 35, 0.86)',

  // Text
  textPrimary: 'rgba(245, 235, 215, 0.96)',
  textSecondary: 'rgba(230, 215, 190, 0.90)',
  textMuted: 'rgba(255, 235, 205, 0.86)',

  // Accents
  amber: 'rgb(220, 140, 35)',
  amberBorder: 'rgba(255, 220, 160, 0.22)',

  // Alerts
  warning: 'rgba(160, 70, 20, 0.92)',
  warningText: 'rgba(255, 235, 210, 0.96)',
  critical: 'rgba(140, 30, 20, 0.96)',
  criticalText: 'rgba(255, 235, 210, 0.96)',

  // Segment bar
  segEmpty: 'rgba(80, 70, 55, 0.70)',
  segOk: 'rgba(220, 140, 35, 0.86)',
  segWarn: 'rgba(230, 120, 25, 0.92)',
  segCrit: 'rgba(180, 35, 25, 0.94)',

  // Trip
  tripGreen: 'rgba(100, 220, 140, 0.98)',
  tripBorder: 'rgba(100, 200, 150, 0.33)',
  tripLabel: 'rgba(150, 220, 180, 0.94)',

  // GPS/status
  gpsOk: 'rgb(100, 200, 130)',
  gpsOff: 'rgba(255, 235, 205, 0.5)',

  // MIL
  milDanger: 'rgba(120, 25, 18, 0.90)',
};

export const fonts = {
  mono: undefined, // Uses system default monospace
  sizeXs: 12,
  sizeSm: 14,
  sizeMd: 16,
  sizeLg: 20,
  sizeXl: 26,
  size2xl: 42,
  size3xl: 64,
};
