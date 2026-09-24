// Lives in a header because the Arduino IDE inserts auto-generated function
// prototypes above any struct defined in the .ino.
#pragma once

#include "schrader_decoder.h"

struct CacheEntry {
  bool used;
  schrader::Frame frame;
  uint32_t atMs;
  bool known;
};
