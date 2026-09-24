// Persistent burst log records. In a header because the Arduino IDE inserts
// auto-generated function prototypes above any struct defined in the .ino.
#pragma once

#include <stddef.h>
#include <stdint.h>

static const size_t LOG_LEN = 16;

struct BurstRec {
  uint32_t uptimeS;
  uint16_t pulses;
  uint16_t durMs;
  uint16_t hiUs;       // dominant carrier-on width
  uint16_t loUs;       // dominant gap width
  uint8_t boot;        // boot number (low byte) it happened in
  uint8_t decoded;     // 0 no, 1 current timing, 2 after autotune
  uint8_t pressureRaw;
  uint8_t pad;
  uint32_t id;
};

struct StoredLog {
  uint32_t boots;
  uint32_t bursts;
  uint32_t decoded;
  uint8_t head;
  uint8_t count;
  uint8_t pad[2];
  BurstRec recs[LOG_LEN];
};
