/**
 * Converts dtc_codes.csv into a TypeScript record for bundling.
 * Run: node scripts/gen-dtc-data.js
 */
const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'src', 'data', 'dtc_codes.csv');
const outPath = path.join(__dirname, '..', 'src', 'data', 'dtcCodesData.ts');

const raw = fs.readFileSync(csvPath, 'utf8');
const lines = raw.split('\n');

const entries = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  // Find first comma that separates code from description
  const idx = trimmed.indexOf(',');
  if (idx <= 0) continue;

  let code = trimmed.substring(0, idx).trim();
  let desc = trimmed.substring(idx + 1).trim();

  // Strip surrounding quotes
  if (code.startsWith('"') && code.endsWith('"')) {
    code = code.slice(1, -1);
  }
  if (desc.startsWith('"') && desc.endsWith('"')) {
    desc = desc.slice(1, -1);
  }

  code = code.toUpperCase();
  if (code && desc) {
    entries.push([code, desc]);
  }
}

let ts = '/** Auto-generated from dtc_codes.csv. Do not edit manually. */\n\n';
ts += 'export const DTC_CODES: Record<string, string> = {\n';

for (const [code, desc] of entries) {
  // JSON.stringify handles all escaping correctly
  ts += `  ${JSON.stringify(code)}: ${JSON.stringify(desc)},\n`;
}

ts += '};\n';

fs.writeFileSync(outPath, ts, 'utf8');
console.log(`Generated ${entries.length} DTC codes -> ${outPath}`);
