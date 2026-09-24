import {
  base64ToBytes,
  bytesToBase64,
  decodeConfigFrame,
  decodeReadingFrame,
  decodeStatusFrame,
  encodeConfigFrame,
  formatSensorId,
  parseSensorId,
} from '../tpmsProtocol';

/** READING frame as the firmware builds it (sendReading in tpms_receiver.ino). */
function readingFrame(id: number, pressureRaw: number, tempRaw: number, rflags: number, ageS = 0) {
  return Uint8Array.of(
    1,
    id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff,
    pressureRaw, tempRaw, 0x07, rflags,
    ageS & 0xff, (ageS >>> 8) & 0xff,
    0,
  );
}

describe('sensor ids', () => {
  it('formats 28-bit ids the way rtl_433 prints them', () => {
    expect(formatSensorId(0x05e671a)).toBe('05E671A');
    expect(formatSensorId(0xfa4d3)).toBe('00FA4D3');
  });

  it('parses hex ids and rejects anything wider than 28 bits', () => {
    expect(parseSensorId('05e671a')).toBe(0x05e671a);
    expect(parseSensorId(' 00FBFF7 ')).toBe(0xfbff7);
    expect(parseSensorId('105E671A')).toBeNull();
    expect(parseSensorId('xyz')).toBeNull();
    expect(parseSensorId('')).toBeNull();
  });
});

describe('READING frames', () => {
  it('decodes the capture from 2026-09-21 into psi and °F', () => {
    // 447.5 kPa = raw 179; 22 C = raw 72
    const r = decodeReadingFrame(readingFrame(0x05e671a, 179, 72, 0x01), 1_000_000)!;
    expect(r.id).toBe('05E671A');
    expect(r.kPa).toBe(447.5);
    expect(r.psi).toBeCloseTo(64.9, 1);
    expect(r.tempC).toBe(22);
    expect(r.tempF).toBeCloseTo(71.6, 1);
    expect(r.flags).toBe(0x07);
    expect(r.known).toBe(true);
    expect(r.cached).toBe(false);
    expect(r.ts).toBe(1_000_000);
  });

  it('back-dates cached replays by their age', () => {
    const r = decodeReadingFrame(readingFrame(0xfbff7, 187, 73, 0x03, 600), 1_000_000)!;
    expect(r.cached).toBe(true);
    expect(r.ts).toBe(1_000_000 - 600_000);
  });

  it('flags learn-mode sightings as unknown', () => {
    expect(decodeReadingFrame(readingFrame(0x1234567, 180, 70, 0x00), 0)!.known).toBe(false);
  });

  it('handles below-zero temperatures', () => {
    expect(decodeReadingFrame(readingFrame(1, 100, 30, 1), 0)!.tempC).toBe(-20);
  });

  it('rejects short frames and unknown versions', () => {
    expect(decodeReadingFrame(new Uint8Array(11), 0)).toBeNull();
    const f = readingFrame(1, 1, 1, 1);
    f[0] = 2;
    expect(decodeReadingFrame(f, 0)).toBeNull();
  });
});

describe('CONFIG frames', () => {
  it('round-trips the allowlist and learn flag', () => {
    const ids = ['05E671A', '05E670D', '00FA4D3', '00FBFF7'];
    const frame = encodeConfigFrame(ids, true);
    expect(frame.length).toBe(3 + 16);
    expect(Array.from(frame.slice(0, 7))).toEqual([1, 1, 4, 0x1a, 0x67, 0x5e, 0x00]);
    expect(decodeConfigFrame(frame)).toEqual({ ids, learn: true });
  });

  it('drops invalid ids and caps at the firmware limit of 8', () => {
    const ids = ['bogus', ...Array.from({ length: 10 }, (_, i) => formatSensorId(i + 1))];
    const decoded = decodeConfigFrame(encodeConfigFrame(ids, false))!;
    expect(decoded.ids).toHaveLength(8);
    expect(decoded.ids[0]).toBe('0000001');
  });

  it('rejects a length that disagrees with the count', () => {
    expect(decodeConfigFrame(Uint8Array.of(1, 0, 2, 0, 0, 0, 0))).toBeNull();
  });
});

describe('STATUS frames', () => {
  it('decodes counters', () => {
    const b = new Uint8Array(17);
    b[0] = 1;
    b[1] = 100;      // uptime
    b[5] = 12;       // decoded
    b[9] = 4;        // reported
    b[13] = 0;       // overflows
    expect(decodeStatusFrame(b)).toEqual({ uptimeS: 100, decoded: 12, reported: 4, overflows: 0 });
  });

  it('decodes the radio diagnostics appended by newer firmware', () => {
    const b = new Uint8Array(34);
    b[0] = 1;
    b[17] = 0x20; b[18] = 0x03;   // edgesPerSec 800
    b[21] = 3;                    // bursts
    b[25] = 1;                    // burstsDecoded
    b[29] = 40;                   // lastBurstAgeS
    b[31] = 135;                  // halfUs
    b[33] = 1;                    // inverted
    expect(decodeStatusFrame(b)!.radio).toEqual({
      edgesPerSec: 800, bursts: 3, burstsDecoded: 1, lastBurstAgeS: 40, halfUs: 135, inverted: true,
    });
  });

  it('reports no last burst as null', () => {
    const b = new Uint8Array(34);
    b[0] = 1;
    b[29] = 0xff; b[30] = 0xff;
    expect(decodeStatusFrame(b)!.radio!.lastBurstAgeS).toBeNull();
  });
});

it('base64 helpers round-trip binary bytes', () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255);
  expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 127, 128, 255]);
});
