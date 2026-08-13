import {
  normTarget,
  physicalHeader,
  receiveFilter,
  expandTargetRange,
  expandDidPages,
  classifyResponse,
  isLiveResponse,
  nrcCode,
  nrcNote,
  decodeAscii,
  isSaneVin,
  payloadsEqual,
  buildAddressProbeSequence,
  reassembleUdsPayload,
  parseFingerprint,
  FINGERPRINT_DIDS,
  KNOWN_LIVE_TARGETS,
} from '../bodySweepCore';

describe('address helpers', () => {
  it('normalises target bytes to two upper hex chars', () => {
    expect(normTarget('a')).toBe('0A');
    expect(normTarget('4f')).toBe('4F');
    expect(normTarget(0x18)).toBe('18');
    expect(normTarget(255)).toBe('FF');
  });

  it('builds the 29-bit physical transmit header', () => {
    expect(physicalHeader('10')).toBe('18DA10F1');
    expect(physicalHeader('c6')).toBe('18DAC6F1');
  });

  it('builds the matching receive filter (reply to tester F1 from target)', () => {
    expect(receiveFilter('18')).toBe('18DAF118');
    expect(receiveFilter('40')).toBe('18DAF140');
  });

  it('expands a target range inclusively', () => {
    const full = expandTargetRange(0x00, 0xff);
    expect(full).toHaveLength(256);
    expect(full[0]).toBe('00');
    expect(full[255]).toBe('FF');
    expect(expandTargetRange(0x10, 0x12)).toEqual(['10', '11', '12']);
  });

  it('expands DID pages into 256 DIDs each', () => {
    const dids = expandDidPages(['F1']);
    expect(dids).toHaveLength(256);
    expect(dids[0]).toBe('F100');
    expect(dids[0x90]).toBe('F190');
    expect(expandDidPages(['00', '01'])).toHaveLength(512);
  });
});

describe('classifyResponse', () => {
  it('recognises a positive UDS reply for the requested DID', () => {
    expect(classifyResponse('62F190 1234', 'F190')).toBe('positive');
    // spaces/case-insensitive
    expect(classifyResponse('62 f1 90 12', 'F190')).toBe('positive');
  });

  it('recognises a positive reply without a DID hint via the 62<did> shape', () => {
    expect(classifyResponse('62F18C0102')).toBe('positive');
  });

  it('recognises an NRC negative response', () => {
    expect(classifyResponse('7F2231', 'F190')).toBe('nrc');
    expect(classifyResponse('7F 22 31')).toBe('nrc');
  });

  it('recognises a positive tester-present reply (7E = 3E + 40)', () => {
    // A module answering 3E00 replies 7E00 — a live address, not "other".
    expect(classifyResponse('7E00')).toBe('positive');
    expect(classifyResponse('7E 00')).toBe('positive');
    // A negative 3E (sub-function not supported) is still an NRC, not positive.
    expect(classifyResponse('7F3E12')).toBe('nrc');
  });

  it('distinguishes silence, clone rejection, and emptiness', () => {
    expect(classifyResponse('NO DATA')).toBe('no-data');
    expect(classifyResponse('?')).toBe('rejected');
    expect(classifyResponse('')).toBe('empty');
    expect(classifyResponse('   ')).toBe('empty');
  });

  it('flags bus errors as other', () => {
    expect(classifyResponse('CAN ERROR')).toBe('other');
    expect(classifyResponse('BUFFER FULL')).toBe('other');
  });

  it('does not mistake an NRC for a positive when a DID is given', () => {
    // 7F2231 contains no 62<did>; must not be positive.
    expect(classifyResponse('7F2231', 'F190')).not.toBe('positive');
  });
});

describe('isLiveResponse', () => {
  it('treats a positive or NRC as a live module', () => {
    expect(isLiveResponse('62F19012')).toBe(true);
    expect(isLiveResponse('7F2231')).toBe(true); // module is there, just refused the DID
  });
  it('treats silence and clone rejection as not live', () => {
    expect(isLiveResponse('NO DATA')).toBe(false);
    expect(isLiveResponse('?')).toBe(false);
    expect(isLiveResponse('')).toBe(false);
  });
});

describe('NRC parsing', () => {
  it('extracts the NRC byte', () => {
    expect(nrcCode('7F2231')).toBe('31');
    expect(nrcCode('7F 10 12')).toBe('12');
    expect(nrcCode('62F190')).toBeNull();
  });
  it('names NRC 31 in the note', () => {
    expect(nrcNote('7F2231')).toContain('NRC 31');
    expect(nrcNote('7F2231')).toContain('requestOutOfRange');
    expect(nrcNote('62F190')).toBe('');
  });
});

describe('VIN / ASCII decode', () => {
  it('decodes printable ASCII, dotting non-printables', () => {
    // "3C6" then a control byte
    expect(decodeAscii([0x33, 0x43, 0x36, 0x01])).toBe('3C6.');
  });
  it('accepts a legal 17-char VIN and rejects malformed ones', () => {
    expect(isSaneVin('3C6TRVDG7EE100001')).toBe(true);
    expect(isSaneVin('SHORTVIN')).toBe(false); // too short
    expect(isSaneVin('3C6TRVDG7EE10000I')).toBe(false); // contains I
    expect(isSaneVin('3C6TRVDG7EE10000O')).toBe(false); // contains O
  });
});

describe('payloadsEqual (constant detection)', () => {
  it('is true only for identical payloads', () => {
    expect(payloadsEqual([0x01, 0x02], [0x01, 0x02])).toBe(true);
    expect(payloadsEqual([0x01, 0x02], [0x01, 0x03])).toBe(false);
    expect(payloadsEqual([0x01], [0x01, 0x02])).toBe(false);
    expect(payloadsEqual(null, [0x01])).toBe(false);
    expect(payloadsEqual([0x01], null)).toBe(false);
  });
});

describe('multi-frame reassembly (real fixtures from the 2014 van, 2026-08-13)', () => {
  // Actual ELM RAW captured on the van — VIN F190, split across 3 frames.
  const VIN_RAW = '014\r0:62F190334336\r1:54525644473145\r2:45313136373930';
  const SERIAL_28_RAW = '012\r0:62F18C543030\r1:34463232383330\r2:3836393420';

  it('reassembles frame-indexed lines into one hex string', () => {
    expect(reassembleUdsPayload(VIN_RAW)).toBe('62F1903343365452564447314545313136373930');
  });

  it('passes a single-frame response through untouched', () => {
    expect(reassembleUdsPayload('62F1950207')).toBe('62F1950207');
  });

  it('recovers the full 17-char VIN the line-by-line parser truncated to "3C6"', () => {
    const bytes = parseFingerprint(VIN_RAW, 'F190');
    expect(bytes).not.toBeNull();
    expect(bytes).toHaveLength(17);
    expect(decodeAscii(bytes!)).toBe('3C6TRVDG1EE116790');
  });

  it('recovers a multi-frame serial number', () => {
    const bytes = parseFingerprint(SERIAL_28_RAW, 'F18C');
    expect(bytes).not.toBeNull();
    // "T004F228308694" plus trailing pad
    expect(decodeAscii(bytes!).trim()).toBe('T004F228308694');
  });

  it('parses a single-frame fingerprint like the shipping parser', () => {
    expect(parseFingerprint('62F1950207', 'F195')).toEqual([0x02, 0x07]);
  });

  it('returns null for a negative response', () => {
    expect(parseFingerprint('7F2231', 'F18A')).toBeNull();
  });
});

describe('buildAddressProbeSequence — sequencing & teardown discipline', () => {
  const seq = buildAddressProbeSequence('40', '18DB33F1');

  it('starts by aiming the transmit header at the target module', () => {
    expect(seq[0]).toEqual({ role: 'set-header', cmd: 'ATSH18DA40F1' });
    expect(seq[1]).toEqual({ role: 'set-filter', cmd: 'ATCRA18DAF140' });
  });

  it('tester-presents the target', () => {
    expect(seq.some((s) => s.role === 'tester-present' && s.cmd === '3E00')).toBe(true);
  });

  it('ALWAYS ends by resetting the header to the functional broadcast and flushing', () => {
    const reset = seq[seq.length - 2];
    const flush = seq[seq.length - 1];
    expect(reset).toEqual({ role: 'reset-header', cmd: 'ATSH18DB33F1' });
    expect(flush).toEqual({ role: 'flush', cmd: 'ATAR' });
  });

  it('clears the receive filter before the header reset', () => {
    const clearIdx = seq.findIndex((s) => s.role === 'clear-filter');
    const resetIdx = seq.findIndex((s) => s.role === 'reset-header');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeLessThan(resetIdx);
  });

  it('never emits an 11-bit broadcast (7DF) when on 29-bit', () => {
    // The reset header comes from the caller (getBroadcastHeader); on 29-bit it
    // must be the 29-bit broadcast, never 7DF.
    expect(seq.every((s) => !s.cmd.includes('7DF'))).toBe(true);
  });
});

describe('sweep constants', () => {
  it('fingerprints with F190 first (the VIN sanity anchor)', () => {
    expect(FINGERPRINT_DIDS[0].did).toBe('F190');
  });
  it('carries the prior powertrain census as known-live', () => {
    expect(KNOWN_LIVE_TARGETS).toEqual(['10', '18', '1F', '40', '60', 'C6', 'C7', 'CB']);
  });
});
