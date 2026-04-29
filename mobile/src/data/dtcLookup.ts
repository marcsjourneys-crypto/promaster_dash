/** DTC code lookup service for OBD-II diagnostic trouble codes. */

import { DTC_CODES } from './dtcCodesData';

/** Ram ProMaster / Chrysler specific codes not in generic database. */
const RAM_SPECIFIC_CODES: Record<string, string> = {
  P1C4F: 'DPF Regeneration Failure',
  P1797: 'Manual Shift Overheat',
  P0944: 'Hydraulic Pressure Unit Loss of Pressure',
  P2610: 'ECM/PCM Internal Engine Off Timer Performance',
  P0562: 'System Voltage Low',
  P0563: 'System Voltage High',
  P2172: 'High Airflow/Vacuum Leak Detected (Instantaneous)',
  P2173: 'High Airflow/Vacuum Leak Detected (Slow Accumulation)',
  P0128: 'Coolant Thermostat Below Regulating Temperature',
  P0217: 'Engine Coolant Over Temperature Condition',
  P0218: 'Transmission Fluid Over Temperature Condition',
  P0711: 'Transmission Fluid Temperature Sensor A Circuit Range/Performance',
  P0713: 'Transmission Fluid Temperature Sensor A Circuit High',
  P0714: 'Transmission Fluid Temperature Sensor A Circuit Intermittent',
};

let codes: Record<string, string> = {};
let loaded = false;

/** Load bundled codes and add manufacturer-specific codes. */
function loadCodes(): void {
  if (loaded) return;

  // Copy all generic OBD-II codes
  Object.assign(codes, DTC_CODES);

  // Add manufacturer-specific codes (overrides generic if duplicate)
  for (const [code, desc] of Object.entries(RAM_SPECIFIC_CODES)) {
    codes[code.toUpperCase()] = desc;
  }

  loaded = true;
}

/** Get description for a DTC code. */
export function getDescription(code: string): string | null {
  loadCodes();
  return codes[code.toUpperCase()] ?? null;
}

/** Format a code with its description. */
export function formatCode(code: string): string {
  const desc = getDescription(code);
  if (desc) {
    const truncated = desc.length > 40 ? desc.substring(0, 37) + '...' : desc;
    return `${code.toUpperCase()}: ${truncated}`;
  }
  return code.toUpperCase();
}

/** Format multiple codes for alert display. */
export function formatCodes(dtcCodes: string[]): string {
  if (dtcCodes.length === 0) return 'CHECK ENGINE CODE DETECTED';

  const first = formatCode(dtcCodes[0]);
  if (dtcCodes.length > 1) {
    return `${first} (+${dtcCodes.length - 1} more)`;
  }
  return first;
}

/** Get details for multiple codes. */
export function getAllCodes(
  dtcCodes: string[],
): Array<{ code: string; description: string }> {
  loadCodes();
  return dtcCodes.map((code) => ({
    code: code.toUpperCase(),
    description: codes[code.toUpperCase()] ?? 'Unknown code',
  }));
}

/** Return the number of codes in the database. */
export function codeCount(): number {
  loadCodes();
  return Object.keys(codes).length;
}
