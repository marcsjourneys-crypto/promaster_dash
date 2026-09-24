#include "schrader_decoder.h"

namespace schrader {

uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0xF0;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int b = 0; b < 8; ++b) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

uint8_t halfUnits(uint16_t us, uint8_t rawLevel, const Timing& t) {
  // Undo the slicer's skew, then classify. The split at 1.5 half-bits is the
  // only boundary that matters; the outer bounds just reject noise.
  int32_t c = (int32_t)us + (rawLevel ? -t.skewUs : t.skewUs);
  if (c <= 0) return 0;
  const uint32_t u = (uint32_t)c;
  const uint32_t h = t.halfUs;
  if (u * 2u < h) return 0;           // < 0.5 T
  if (u * 2u < h * 3u) return 1;      // < 1.5 T
  if (u * 5u < h * 13u) return 2;     // < 2.6 T
  return 0;
}

bool parseBytes(const uint8_t b[8], Frame* out) {
  if ((b[0] >> 4) != 0xF) return false;
  if (crc8(b, 7) != b[7]) return false;
  out->flags = (uint8_t)((b[0] & 0x0F) << 4 | b[1] >> 4);
  out->id = (uint32_t)(b[1] & 0x0F) << 24 | (uint32_t)b[2] << 16 |
            (uint32_t)b[3] << 8 | b[4];
  out->pressureRaw = b[5];
  out->tempRaw = b[6];
  return true;
}

namespace {

// Manchester-decode from a rising edge, which is taken as the middle of a 0
// bit. Returns the number of bits recovered before the first invalid symbol.
size_t decodeFrom(const Pulse* p, size_t n, const Timing& t, uint8_t* bits) {
  size_t nb = 0;
  int pending = 0;  // implicit low half before the first rising edge
  bool ok = true;

  auto push = [&](uint8_t level) {
    if (pending < 0) {
      pending = level;
      return;
    }
    if (pending == level) {
      ok = false;  // two equal halves: not Manchester
      return;
    }
    if (nb < kMaxBits) bits[nb++] = (pending == 0) ? 0 : 1;
    pending = -1;
  };

  for (size_t i = 0; i < n && ok; ++i) {
    uint8_t u = halfUnits(p[i].us, p[i].level, t);
    if (u == 0) break;
    uint8_t level = p[i].level ^ (t.inverted ? 1 : 0);
    for (uint8_t k = 0; k < u && ok; ++k) push(level);
  }
  // A frame ending on a high half is completed by the silence after it.
  if (ok && pending == 1) push(0);
  return nb;
}

}  // namespace

// A frame spans at least 68 pulses (every symbol a double-width pulse), so
// after a hit the next frame cannot start sooner than this.
static const size_t kMinFramePulses = 60;

size_t decodeRun(const Pulse* run, size_t n, const Timing& t, Frame* out, size_t maxOut) {
  uint8_t bits[kMaxBits];
  size_t found = 0;
  const uint8_t on = t.inverted ? 0 : 1;
  for (size_t s = 0; s < n && found < maxOut; ++s) {
    if (run[s].level != on) continue;
    size_t nb = decodeFrom(run + s, n - s, t, bits);
    if (nb < kFrameBits) continue;
    bool hit = false;
    for (size_t off = 0; off + kFrameBits <= nb && !hit; ++off) {
      if (bits[off] != 0 || bits[off + 1] != 1 || bits[off + 2] != 1 ||
          bits[off + 3] != 1)
        continue;
      uint8_t b[8] = {0};
      for (size_t i = 0; i < 64; ++i) {
        b[i >> 3] |= (uint8_t)(bits[off + 4 + i] << (7 - (i & 7)));
      }
      hit = parseBytes(b, &out[found]);
    }
    if (hit) {
      ++found;
      s += kMinFramePulses - 1;  // skip past this frame's body
    }
  }
  return found;
}

size_t autotune(const Pulse* p, size_t n, Timing* best, Frame* out, size_t maxOut) {
  Frame tmp[8];
  if (maxOut > 8) maxOut = 8;
  size_t bestN = 0;
  int32_t bestCost = 0;
  for (int inv = 0; inv < 2; ++inv) {
    for (int half = 80; half <= 200; half += 10) {
      for (int skew = -90; skew <= 90; skew += 15) {
        Timing t;
        t.halfUs = (uint16_t)half;
        t.skewUs = (int16_t)skew;
        t.inverted = inv != 0;
        size_t k = decodeRun(p, n, t, tmp, maxOut);
        if (k == 0) continue;
        int32_t cost = 2 * (skew < 0 ? -skew : skew) + (half > 120 ? half - 120 : 120 - half) +
                       50 * inv;
        if (k > bestN || (k == bestN && cost < bestCost)) {
          bestN = k;
          bestCost = cost;
          *best = t;
          for (size_t i = 0; i < k; ++i) out[i] = tmp[i];
        }
      }
    }
  }
  return bestN;
}

size_t encode(const Frame& f, const Timing& t, Pulse* out, size_t max) {
  uint8_t b[8];
  b[0] = (uint8_t)(0xF0 | (f.flags >> 4));
  b[1] = (uint8_t)((f.flags & 0x0F) << 4 | ((f.id >> 24) & 0x0F));
  b[2] = (uint8_t)(f.id >> 16);
  b[3] = (uint8_t)(f.id >> 8);
  b[4] = (uint8_t)f.id;
  b[5] = f.pressureRaw;
  b[6] = f.tempRaw;
  b[7] = crc8(b, 7);

  uint8_t bits[kFrameBits] = {0, 1, 1, 1};
  for (size_t i = 0; i < 64; ++i) bits[4 + i] = (b[i >> 3] >> (7 - (i & 7))) & 1;

  // Half-bit levels: 0 -> low,high ; 1 -> high,low.
  uint8_t halves[kFrameBits * 2];
  for (size_t i = 0; i < kFrameBits; ++i) {
    halves[2 * i] = bits[i] ? 1 : 0;
    halves[2 * i + 1] = bits[i] ? 0 : 1;
  }
  // Drop the leading low (it is the silence before the frame) and the
  // trailing low (the silence after), then run-length encode.
  size_t first = 1, last = kFrameBits * 2;
  if (halves[last - 1] == 0) --last;
  size_t n = 0;
  for (size_t i = first; i < last && n < max;) {
    size_t j = i;
    while (j < last && halves[j] == halves[i]) ++j;
    out[n++] = Pulse{(uint16_t)((j - i) * t.halfUs), halves[i]};
    i = j;
  }
  return n;
}

}  // namespace schrader
