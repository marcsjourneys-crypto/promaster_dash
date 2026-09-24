// Schrader TPMS decoder (FCC-ID MRXGG4 family) for the 2014 ProMaster sensors.
//
// Pure C++ with no Arduino dependencies, so the same file builds into the
// sketch and into the host test (test/decoder_test.cpp).
//
// Written from the protocol description, not from rtl_433 source:
//   OOK, Manchester (rising edge = 0, falling edge = 1), half-bit ~120 us.
//   68 bits on air: sync nibble 0111, then 8 bytes b0..b7:
//     b0 hi nibble  preamble, always 0xF
//     flags         (b0 & 0x0F) << 4 | b1 >> 4
//     id (28 bit)   (b1 & 0x0F) << 24 | b2 << 16 | b3 << 8 | b4
//     pressure      b5 * 2.5 kPa (gauge)
//     temperature   b6 - 50 C
//     crc           b7 == crc8(b0..b6, poly 0x07, init 0xF0)
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace schrader {

constexpr size_t kFrameBits = 68;
constexpr size_t kMaxBits = 160;

struct Frame {
  uint32_t id;          // 28-bit sensor id, printed as %07X
  uint8_t flags;
  uint8_t pressureRaw;  // 2.5 kPa per count
  uint8_t tempRaw;      // degrees C + 50

  float kPa() const { return pressureRaw * 2.5f; }
  int tempC() const { return (int)tempRaw - 50; }
  bool samePayload(const Frame& o) const {
    return id == o.id && flags == o.flags && pressureRaw == o.pressureRaw &&
           tempRaw == o.tempRaw;
  }
};

// One stretch of constant line level, as timed by the edge ISR.
struct Pulse {
  uint16_t us;
  uint8_t level;  // 1 = carrier on (DATA high), 0 = off
};

// How the receiver's output maps onto the nominal protocol timing. A
// superhet's data slicer typically stretches carrier-on pulses and shrinks
// the gaps by the same amount; `skewUs` undoes that before classifying.
struct Timing {
  uint16_t halfUs = 120;  // nominal Manchester half-bit
  int16_t skewUs = 0;     // subtracted from highs, added to lows (raw levels)
  bool inverted = false;  // DATA low = carrier on
};

uint8_t crc8(const uint8_t* data, size_t len);

// 1 or 2 half-bits for a duration within tolerance, 0 if out of range.
// `rawLevel` is the pin level during the pulse, before any inversion.
uint8_t halfUnits(uint16_t us, uint8_t rawLevel, const Timing& t);

// Validate preamble + CRC on the 8 bytes after the sync nibble.
bool parseBytes(const uint8_t b[8], Frame* out);

// Decode every valid frame in a run of in-tolerance pulses (two sensors can
// land in one run). Returns how many were written to `out`.
size_t decodeRun(const Pulse* run, size_t n, const Timing& t, Frame* out, size_t maxOut);

// Sweep half-bit width, skew and polarity over a captured burst and return
// how many frames the best timing decodes (0 if none). The best timing is
// the one decoding the most frames, preferring small skew, a half-bit near
// 120 us and normal polarity. Fills `*best` and `out` on success.
size_t autotune(const Pulse* p, size_t n, Timing* best, Frame* out, size_t maxOut);

// Build the on-air pulse sequence for a frame. Used by the self-test and the
// host test; the leading and trailing silence is not emitted.
size_t encode(const Frame& f, const Timing& t, Pulse* out, size_t max);

}  // namespace schrader
