// ProMaster Dash — TPMS receiver
//
// ESP32 + RX470C (433.92 MHz OOK superhet) listening for the van's Schrader
// TPMS sensors. Frames from allowlisted IDs are forwarded to the ProMaster
// Dash app over BLE. See README.md for wiring and the BLE protocol.
//
// Board: "ESP32 Dev Module" (ELEGOO ESP-WROOM-32). No extra libraries.

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>

#include "burst_log.h"
#include "cache_entry.h"
#include "schrader_decoder.h"

// ---- Hardware -------------------------------------------------------------

static const int RX_PIN = 27;   // RX470C DATA
static const int LED_PIN = 2;   // on-board LED, blinks per reported frame

// ---- BLE protocol (mirror of mobile/src/services/tpmsProtocol.ts) ---------

#define SERVICE_UUID "7d2a0001-6c1e-4f3b-9a5e-3b1f0c2d8e41"
#define READING_UUID "7d2a0002-6c1e-4f3b-9a5e-3b1f0c2d8e41"  // notify
#define CONFIG_UUID  "7d2a0003-6c1e-4f3b-9a5e-3b1f0c2d8e41"  // read / write
#define STATUS_UUID  "7d2a0004-6c1e-4f3b-9a5e-3b1f0c2d8e41"  // read / notify
#define CONTROL_UUID "7d2a0005-6c1e-4f3b-9a5e-3b1f0c2d8e41"  // write
static const char* DEVICE_NAME = "PM-TPMS";

static const uint8_t PROTO_VERSION = 1;
static const uint8_t CTRL_REPLAY = 0x01;
static const uint8_t RFLAG_KNOWN = 0x01;
static const uint8_t RFLAG_CACHED = 0x02;

// ---- Tuning ---------------------------------------------------------------

static const size_t MAX_IDS = 8;
static const size_t MIN_RUN = 60;              // pulses; a frame is ~70-136
static const uint32_t BURST_DEDUP_MS = 5000;   // one report per burst
static const uint32_t LEARN_CONFIRM_MS = 2000; // unknown IDs must repeat
static const uint32_t STATUS_PERIOD_MS = 2000;

// Burst detection is independent of decoder timing: a tire burst packs ~100
// edges into ~16 ms, while the RX470C's noise runs at ~1 edge/ms. 60 edges
// inside 25 ms is a burst no matter how the slicer distorts the widths.
static const size_t BURST_EDGES = 60;
static const uint32_t BURST_WINDOW_US = 25000;
static const size_t CAPTURE_CAP = 400;     // pulses kept per burst
static const size_t CAPTURE_PRE = 40;      // pulses kept from before the trigger
static const uint32_t LOG_SAVE_MS = 10000; // NVS write rate limit


// Seeded from the RTL-SDR capture on 2026-09-21. Editable from the app.
static const uint32_t DEFAULT_IDS[] = {0x05E671A, 0x05E670D, 0x00FA4D3, 0x00FBFF7};

// ---- Edge capture ---------------------------------------------------------

static const size_t RING = 2048;  // power of two
static volatile uint32_t ring[RING];  // (level << 16) | duration_us
static volatile uint32_t ringHead = 0;
static volatile uint32_t ringTail = 0;  // read by the ISR's full check
static volatile uint32_t lastEdgeUs = 0;
static volatile uint32_t ringOverflows = 0;
static volatile uint32_t edgeCount = 0;  // every edge, for the `scope` check

void IRAM_ATTR onEdge() {
  uint32_t now = micros();
  edgeCount++;
  uint32_t dur = now - lastEdgeUs;
  lastEdgeUs = now;
  // The level that just ended is the opposite of the level now on the pin.
  uint32_t endedLevel = digitalRead(RX_PIN) ? 0 : 1;
  if (dur > 0xFFFF) dur = 0xFFFF;
  uint32_t next = (ringHead + 1) & (RING - 1);
  if (next == ringTail) {
    ringOverflows++;
    return;
  }
  ring[ringHead] = (endedLevel << 16) | dur;
  ringHead = next;
}

// ---- State ----------------------------------------------------------------

static Preferences prefs;
static uint32_t allowIds[MAX_IDS];
static size_t allowCount = 0;
static bool learnMode = false;

static CacheEntry cache[16];           // last report per sensor
static schrader::Frame lastUnknown;    // learn-mode repeat confirmation
static uint32_t lastUnknownMs = 0;

static schrader::Timing timing;
static const size_t RUN_CAP = 320;
static const size_t RUN_KEEP = 150;  // > one frame (<= 136 pulses)
static schrader::Pulse run[RUN_CAP];
static size_t runLen = 0;

static uint32_t framesDecoded = 0, framesReported = 0, runsTried = 0;
static bool rawDebug = false;

// ---- Burst capture (see BURST_EDGES) ----
static uint16_t winDur[BURST_EDGES];       // last N pulse widths, for density
static size_t winIdx = 0;
static uint32_t winSum = 0;
static schrader::Pulse hist[CAPTURE_PRE];  // pre-trigger history
static size_t histIdx = 0;
static schrader::Pulse capture[CAPTURE_CAP];
static size_t captureLen = 0;
static bool capturing = false;
static bool captureReady = false;
static uint32_t lastBurstMs = 0;
static bool haveLastBurst = false;
static uint32_t edgesPerSec = 0;

// Kept for `dump` after analysis.
static schrader::Pulse lastCapture[CAPTURE_CAP];
static size_t lastCaptureLen = 0;

// ---- Persistent log (survives power cycles) ----
static StoredLog blog;
static bool logDirty = false;
static uint32_t lastLogSave = 0;
static uint32_t sessionBursts = 0, sessionBurstsDecoded = 0;
static bool scopeOn = false;  // print edges/second: is the RX470C wired up?

static BLEServer* server = nullptr;
static BLECharacteristic* readingChar = nullptr;
static BLECharacteristic* configChar = nullptr;
static BLECharacteristic* statusChar = nullptr;
static volatile bool clientConnected = false;
static volatile bool replayRequested = false;
static volatile bool advertiseRequested = false;

// BLE callbacks run on the Bluedroid task (core 0) while loop() runs on core
// 1. They only hand data over; every change to the allowlist, the cache or a
// characteristic value happens in loop(), so there is one writer.
static portMUX_TYPE cfgMux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t pendingCfg[3 + 4 * MAX_IDS];
static size_t pendingCfgLen = 0;
static volatile bool pendingCfgValid = false;
static volatile bool pendingCfgRejected = false;

// Replay one cached reading per loop pass, spaced out, re-checking the link
// each time: back-to-back notifies race a disconnect on the BLE task.
static const uint32_t REPLAY_SPACING_MS = 30;
static size_t replayIndex = SIZE_MAX;
static uint32_t lastReplayMs = 0;

// ---- Allowlist persistence ------------------------------------------------

// Stored as one fixed-size blob so a power cut mid-save can never pair a new
// count with old IDs: NVS writes each key atomically.
struct StoredConfig {
  uint8_t count;
  uint8_t learn;
  uint8_t reserved[2];
  uint32_t ids[MAX_IDS];
};

static void saveConfig() {
  StoredConfig c = {};
  c.count = (uint8_t)allowCount;
  c.learn = learnMode ? 1 : 0;
  memcpy(c.ids, allowIds, allowCount * sizeof(uint32_t));
  prefs.putBytes("cfg", &c, sizeof(c));
}

static void loadConfig() {
  StoredConfig c = {};
  if (prefs.getBytesLength("cfg") == sizeof(c) &&
      prefs.getBytes("cfg", &c, sizeof(c)) == sizeof(c) && c.count <= MAX_IDS) {
    allowCount = c.count;
    memcpy(allowIds, c.ids, allowCount * sizeof(uint32_t));
    learnMode = c.learn != 0;
    return;
  }
  // First boot, or unreadable: seed from the RTL-SDR capture.
  allowCount = sizeof(DEFAULT_IDS) / sizeof(DEFAULT_IDS[0]);
  memcpy(allowIds, DEFAULT_IDS, sizeof(DEFAULT_IDS));
  learnMode = false;
  saveConfig();
}

// Timing learned by autotune, kept separately from the allowlist so the two
// can change independently.
struct StoredTiming {
  uint16_t halfUs;
  int16_t skewUs;
  uint8_t inverted;
  uint8_t pad[3];
};

static void saveTiming() {
  StoredTiming st = {};
  st.halfUs = timing.halfUs;
  st.skewUs = timing.skewUs;
  st.inverted = timing.inverted ? 1 : 0;
  prefs.putBytes("timing", &st, sizeof(st));
}

static void loadTiming() {
  StoredTiming st = {};
  if (prefs.getBytesLength("timing") == sizeof(st) &&
      prefs.getBytes("timing", &st, sizeof(st)) == sizeof(st) && st.halfUs >= 60 &&
      st.halfUs <= 400) {
    timing.halfUs = st.halfUs;
    timing.skewUs = st.skewUs;
    timing.inverted = st.inverted != 0;
  }
}

static void loadLog() {
  if (!(prefs.getBytesLength("blog") == sizeof(blog) &&
        prefs.getBytes("blog", &blog, sizeof(blog)) == sizeof(blog) &&
        blog.head < LOG_LEN && blog.count <= LOG_LEN)) {
    memset(&blog, 0, sizeof(blog));
  }
  blog.boots++;
  prefs.putBytes("blog", &blog, sizeof(blog));
}

static void saveLogIfDue(bool force) {
  if (!logDirty) return;
  if (!force && millis() - lastLogSave < LOG_SAVE_MS) return;
  prefs.putBytes("blog", &blog, sizeof(blog));
  logDirty = false;
  lastLogSave = millis();
}

static void printLogRec(const BurstRec& r) {
  Serial.printf("  boot %3u  +%6lus  %3u pulses in %3u ms  hi~%3uus lo~%3uus  ", r.boot,
                (unsigned long)r.uptimeS, r.pulses, r.durMs, r.hiUs, r.loUs);
  if (r.decoded) {
    Serial.printf("DECODED%s id=%07lX %.1fpsi\n", r.decoded == 2 ? " (autotune)" : "",
                  (unsigned long)r.id, r.pressureRaw * 2.5f * 0.1450377f);
  } else {
    Serial.println("not decoded");
  }
}

static void printLog(size_t maxRecs) {
  Serial.printf("log: %lu boots, %lu bursts heard, %lu decoded (lifetime)\n",
                (unsigned long)blog.boots, (unsigned long)blog.bursts, (unsigned long)blog.decoded);
  size_t n = blog.count < maxRecs ? blog.count : maxRecs;
  if (n == 0) {
    Serial.println("  no bursts recorded yet");
    return;
  }
  Serial.printf("  last %u burst(s), oldest first:\n", (unsigned)n);
  for (size_t i = 0; i < n; ++i) {
    size_t idx = (blog.head + LOG_LEN - n + i) % LOG_LEN;
    printLogRec(blog.recs[idx]);
  }
}

static bool isAllowed(uint32_t id) {
  for (size_t i = 0; i < allowCount; ++i)
    if (allowIds[i] == id) return true;
  return false;
}

// CONFIG frame: ver u8, learn u8, n u8, id u32 LE x n
static size_t buildConfigFrame(uint8_t* out) {
  out[0] = PROTO_VERSION;
  out[1] = learnMode ? 1 : 0;
  out[2] = (uint8_t)allowCount;
  for (size_t i = 0; i < allowCount; ++i) memcpy(out + 3 + 4 * i, &allowIds[i], 4);
  return 3 + 4 * allowCount;
}

static void publishConfig() {
  uint8_t buf[3 + 4 * MAX_IDS];
  size_t n = buildConfigFrame(buf);
  configChar->setValue(buf, n);
}

static bool applyConfigFrame(const uint8_t* p, size_t n) {
  if (n < 3 || p[0] != PROTO_VERSION) return false;
  size_t count = p[2];
  if (count > MAX_IDS || n != 3 + 4 * count) return false;
  learnMode = p[1] != 0;
  allowCount = count;
  for (size_t i = 0; i < count; ++i) memcpy(&allowIds[i], p + 3 + 4 * i, 4);
  saveConfig();
  // Re-flag cached readings against the new list.
  for (auto& c : cache)
    if (c.used) c.known = isAllowed(c.frame.id);
  return true;
}

// Apply a CONFIG write handed over by the BLE task.
static void applyPendingConfig() {
  if (pendingCfgRejected) {
    pendingCfgRejected = false;
    Serial.println("config: rejected oversized write");
  }
  if (!pendingCfgValid) return;
  uint8_t buf[sizeof(pendingCfg)];
  size_t n;
  portENTER_CRITICAL(&cfgMux);
  n = pendingCfgLen;
  memcpy(buf, pendingCfg, n);
  pendingCfgValid = false;
  portEXIT_CRITICAL(&cfgMux);

  if (applyConfigFrame(buf, n)) {
    Serial.printf("config: %u ids, learn=%d\n", (unsigned)allowCount, learnMode);
  } else {
    Serial.println("config: rejected malformed write");
  }
  publishConfig();
}

// ---- Reporting ------------------------------------------------------------

// READING frame, 12 bytes LE:
//   ver u8 | id u32 | pressureRaw u8 | tempRaw u8 | flags u8 | rflags u8 |
//   age_s u16 | reserved u8
static void sendReading(const CacheEntry& c, bool cached) {
  if (!clientConnected || !readingChar) return;
  uint8_t b[12] = {0};
  b[0] = PROTO_VERSION;
  memcpy(b + 1, &c.frame.id, 4);
  b[5] = c.frame.pressureRaw;
  b[6] = c.frame.tempRaw;
  b[7] = c.frame.flags;
  b[8] = (c.known ? RFLAG_KNOWN : 0) | (cached ? RFLAG_CACHED : 0);
  uint32_t age = (millis() - c.atMs) / 1000;
  uint16_t age16 = age > 0xFFFF ? 0xFFFF : (uint16_t)age;
  memcpy(b + 9, &age16, 2);
  readingChar->setValue(b, sizeof(b));
  readingChar->notify();
}

static CacheEntry* cacheSlot(uint32_t id) {
  CacheEntry* oldest = &cache[0];
  for (auto& c : cache) {
    if (c.used && c.frame.id == id) return &c;
    if (!c.used) return &c;
    if (c.atMs < oldest->atMs) oldest = &c;
  }
  return oldest;
}

static void printFrame(const schrader::Frame& f, bool known, const char* tag) {
  Serial.printf("%s id=%07X flags=%02x pressure=%.1fkPa (%.1fpsi) temp=%dC known=%d\n",
                tag, f.id, f.flags, f.kPa(), f.kPa() * 0.1450377f, f.tempC(),
                known ? 1 : 0);
}

static void handleFrame(const schrader::Frame& f) {
  framesDecoded++;
  uint32_t now = millis();
  bool known = isAllowed(f.id);

  if (!known) {
    if (!learnMode) {
      if (rawDebug) printFrame(f, false, "ignored");
      return;
    }
    // Unknown IDs need the same payload twice within a burst: CRC-8 plus
    // the preamble nibble alone is not enough to trust noise.
    bool confirmed = lastUnknown.samePayload(f) && now - lastUnknownMs < LEARN_CONFIRM_MS;
    lastUnknown = f;
    lastUnknownMs = now;
    if (!confirmed) return;
  }

  CacheEntry* c = cacheSlot(f.id);
  if (c->used && c->frame.id == f.id && c->frame.samePayload(f) &&
      now - c->atMs < BURST_DEDUP_MS) {
    return;  // repeat inside the same burst
  }
  c->used = true;
  c->frame = f;
  c->atMs = now;
  c->known = known;

  framesReported++;
  printFrame(f, known, "TPMS");
  digitalWrite(LED_PIN, HIGH);
  sendReading(*c, false);
  digitalWrite(LED_PIN, LOW);
}

static void serviceReplay() {
  if (replayRequested) {
    replayRequested = false;
    replayIndex = 0;
  }
  if (replayIndex >= sizeof(cache) / sizeof(cache[0])) return;
  if (!clientConnected) {
    replayIndex = SIZE_MAX;
    return;
  }
  if (millis() - lastReplayMs < REPLAY_SPACING_MS) return;
  const CacheEntry& c = cache[replayIndex++];
  if (c.used && (c.known || learnMode)) {
    sendReading(c, true);
    lastReplayMs = millis();
  }
}

// ---- Pulse processing -----------------------------------------------------

static size_t tryDecode() {
  runsTried++;
  schrader::Frame f[4];
  size_t n = schrader::decodeRun(run, runLen, timing, f, 4);
  for (size_t i = 0; i < n; ++i) handleFrame(f[i]);
  if (n == 0 && rawDebug) Serial.printf("run of %u pulses, no frame\n", (unsigned)runLen);
  return n;
}

static void endRun() {
  if (runLen >= MIN_RUN) tryDecode();
  runLen = 0;
}

// The RX470C's AGC turns silence into in-range noise, so a run can grow
// without bound. When the buffer fills, decode it and keep the tail, which
// may hold the start of a frame. If this pass decoded something, drop the
// whole buffer instead: the tail would hand the same frame back a second
// time, which learn mode would mistake for a confirming repeat.
static void slideRun() {
  if (tryDecode() > 0) {
    runLen = 0;
    return;
  }
  memmove(run, run + (RUN_CAP - RUN_KEEP), RUN_KEEP * sizeof(run[0]));
  runLen = RUN_KEEP;
}

// Timing-independent burst capture. Feeds every pulse through a density
// window; on a burst, snapshots the recent history and records until the
// density falls back to noise.
static void feedBurstDetector(const schrader::Pulse& p) {
  winSum -= winDur[winIdx];
  winDur[winIdx] = p.us;
  winSum += p.us;
  winIdx = (winIdx + 1) % BURST_EDGES;
  bool dense = winSum < BURST_WINDOW_US;

  if (capturing) {
    if (captureLen < CAPTURE_CAP) capture[captureLen++] = p;
    // Stop once the window has been sparse for a while, or when full.
    if (captureLen >= CAPTURE_CAP || (!dense && p.us > 2000)) {
      capturing = false;
      captureReady = true;
    }
  } else if (dense && !captureReady) {
    capturing = true;
    captureLen = 0;
    for (size_t i = 0; i < CAPTURE_PRE; ++i) {
      const schrader::Pulse& h = hist[(histIdx + i) % CAPTURE_PRE];
      if (h.us) capture[captureLen++] = h;
    }
    capture[captureLen++] = p;
  }
  hist[histIdx] = p;
  histIdx = (histIdx + 1) % CAPTURE_PRE;
}

// Most common width among pulses of one level, in 20 us bins (< 1 ms).
static uint16_t dominantWidth(const schrader::Pulse* p, size_t n, uint8_t level) {
  uint16_t bins[50] = {0};
  for (size_t i = 0; i < n; ++i) {
    if (p[i].level != level || p[i].us >= 1000) continue;
    bins[p[i].us / 20]++;
  }
  size_t best = 0;
  for (size_t b = 1; b < 50; ++b)
    if (bins[b] > bins[best]) best = b;
  return bins[best] ? (uint16_t)(best * 20 + 10) : 0;
}

static void printHistogram(const schrader::Pulse* p, size_t n) {
  uint16_t hi[25] = {0}, lo[25] = {0};
  for (size_t i = 0; i < n; ++i) {
    if (p[i].us >= 500) continue;
    (p[i].level ? hi : lo)[p[i].us / 20]++;
  }
  Serial.println("  width(us)   high  low");
  for (size_t b = 0; b < 25; ++b) {
    if (!hi[b] && !lo[b]) continue;
    Serial.printf("  %3u-%3u    %4u %4u\n", (unsigned)(b * 20), (unsigned)(b * 20 + 19), hi[b], lo[b]);
  }
}

static void analyzeBurst() {
  if (!captureReady) return;
  captureReady = false;
  size_t n = captureLen;
  memcpy(lastCapture, capture, n * sizeof(capture[0]));
  lastCaptureLen = n;

  uint32_t durUs = 0;
  for (size_t i = 0; i < n; ++i) durUs += lastCapture[i].us;
  sessionBursts++;
  lastBurstMs = millis();
  haveLastBurst = true;

  BurstRec r = {};
  r.uptimeS = millis() / 1000;
  r.pulses = (uint16_t)n;
  r.durMs = (uint16_t)(durUs / 1000);
  r.hiUs = dominantWidth(lastCapture, n, 1);
  r.loUs = dominantWidth(lastCapture, n, 0);
  r.boot = (uint8_t)blog.boots;

  schrader::Frame f[4];
  size_t k = schrader::decodeRun(lastCapture, n, timing, f, 4);
  if (k) {
    r.decoded = 1;
  } else {
    schrader::Timing tuned;
    k = schrader::autotune(lastCapture, n, &tuned, f, 4);
    if (k) {
      r.decoded = 2;
      Serial.printf("autotune: half=%uus skew=%dus inverted=%d (was half=%u skew=%d inv=%d) - saved\n",
                    tuned.halfUs, tuned.skewUs, tuned.inverted, timing.halfUs, timing.skewUs,
                    timing.inverted);
      timing = tuned;
      saveTiming();
    }
  }
  if (k) {
    r.id = f[0].id;
    r.pressureRaw = f[0].pressureRaw;
    sessionBurstsDecoded++;
    // With the current timing the live decoder already saw these frames;
    // handing them over again would count as a confirming repeat in learn
    // mode. Only frames that took autotune to recover are new.
    if (r.decoded == 2)
      for (size_t i = 0; i < k; ++i) handleFrame(f[i]);
  }

  Serial.printf("burst: %u pulses in %lu ms, high~%uus low~%uus -> %s\n", (unsigned)n,
                (unsigned long)(durUs / 1000), r.hiUs, r.loUs,
                r.decoded == 1 ? "decoded" : r.decoded == 2 ? "decoded after autotune" : "NOT decoded");
  if (!r.decoded) {
    printHistogram(lastCapture, n);
    Serial.println("  (type `dump` for every width; compare with rtl_433 -A)");
  }

  blog.recs[blog.head] = r;
  blog.head = (blog.head + 1) % LOG_LEN;
  if (blog.count < LOG_LEN) blog.count++;
  blog.bursts++;
  if (r.decoded) blog.decoded++;
  logDirty = true;
}

static void drainEdges() {
  while (ringTail != ringHead) {
    uint32_t v = ring[ringTail];
    ringTail = (ringTail + 1) & (RING - 1);
    schrader::Pulse p{(uint16_t)(v & 0xFFFF), (uint8_t)(v >> 16)};
    feedBurstDetector(p);
    if (schrader::halfUnits(p.us, p.level, timing) == 0) {
      endRun();
      continue;
    }
    if (runLen == RUN_CAP) slideRun();
    run[runLen++] = p;
  }
  // A frame followed by true silence produces no closing edge; flush it.
  if (runLen && micros() - lastEdgeUs > 3000) endRun();
}

// ---- BLE ------------------------------------------------------------------

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { clientConnected = true; }
  void onDisconnect(BLEServer*) override {
    clientConnected = false;
    advertiseRequested = true;  // restarted from loop()
  }
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    size_t n = c->getLength();
    if (n > sizeof(pendingCfg)) {
      pendingCfgRejected = true;
      return;
    }
    portENTER_CRITICAL(&cfgMux);
    memcpy(pendingCfg, c->getData(), n);
    pendingCfgLen = n;
    pendingCfgValid = true;
    portEXIT_CRITICAL(&cfgMux);
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (c->getLength() >= 1 && c->getData()[0] == CTRL_REPLAY) replayRequested = true;
  }
};

static void setupBle() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(185);  // STATUS is 34 bytes; the default MTU carries 20
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* svc = server->createService(SERVICE_UUID);

  readingChar = svc->createCharacteristic(READING_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  readingChar->addDescriptor(new BLE2902());

  configChar = svc->createCharacteristic(
      CONFIG_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  configChar->setCallbacks(new ConfigCallbacks());

  statusChar = svc->createCharacteristic(
      STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());

  BLECharacteristic* control =
      svc->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new ControlCallbacks());

  publishConfig();
  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// STATUS frame, 34 bytes LE (the first 17 are the original v1 layout):
//   ver u8 | uptime_s u32 | framesDecoded u32 | framesReported u32 | overflows u32
//   | edgesPerSec u32 | bursts u32 | burstsDecoded u32 | lastBurstAgeS u16
//   | halfUs u16 | inverted u8
static const size_t STATUS_LEN = 34;
static void publishStatus() {
  uint8_t b[STATUS_LEN];
  b[0] = PROTO_VERSION;
  uint32_t vals[7] = {millis() / 1000, framesDecoded, framesReported, ringOverflows,
                      edgesPerSec, sessionBursts, sessionBurstsDecoded};
  memcpy(b + 1, vals, sizeof(vals));
  uint32_t age = haveLastBurst ? (millis() - lastBurstMs) / 1000 : 0xFFFF;
  uint16_t age16 = age > 0xFFFF ? 0xFFFF : (uint16_t)age;
  memcpy(b + 29, &age16, 2);
  uint16_t half = timing.halfUs;
  memcpy(b + 31, &half, 2);
  b[33] = timing.inverted ? 1 : 0;
  statusChar->setValue(b, sizeof(b));
  if (clientConnected) statusChar->notify();
}

// ---- Self-test ------------------------------------------------------------

// Runs the decoder over synthetic frames at boot; proves the build is sane
// before any RF is involved.
static bool selfTest() {
  schrader::Pulse p[140];
  bool ok = true;
  for (uint32_t id : DEFAULT_IDS) {
    schrader::Frame in{id, 0x07, 179, 72};
    size_t n = schrader::encode(in, timing, p, 140);
    schrader::Frame out{};
    ok &= schrader::decodeRun(p, n, timing, &out, 1) == 1 && out.samePayload(in);
  }
  Serial.printf("decoder self-test: %s\n", ok ? "PASS" : "FAIL");
  return ok;
}

// ---- Serial console -------------------------------------------------------

static void printHelp() {
  Serial.println("commands: list | add <hex id> | del <hex id> | learn on|off |"
                 " raw on|off | half <us> | invert on|off | status | scope on|off |"
                 " bursts | dump | clearlog");
}

static void handleSerial() {
  static String line;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch != '\n' && ch != '\r') {
      line += ch;
      continue;
    }
    line.trim();
    if (line.length() == 0) continue;
    String cmd = line;
    line = "";

    if (cmd == "list") {
      for (size_t i = 0; i < allowCount; ++i) Serial.printf("  %07X\n", allowIds[i]);
      Serial.printf("learn=%d\n", learnMode);
    } else if (cmd.startsWith("add ") && allowCount < MAX_IDS) {
      uint32_t id = strtoul(cmd.substring(4).c_str(), nullptr, 16);
      if (!isAllowed(id)) allowIds[allowCount++] = id;
      saveConfig();
      publishConfig();
    } else if (cmd.startsWith("del ")) {
      uint32_t id = strtoul(cmd.substring(4).c_str(), nullptr, 16);
      for (size_t i = 0; i < allowCount; ++i) {
        if (allowIds[i] == id) {
          allowIds[i] = allowIds[--allowCount];
          break;
        }
      }
      saveConfig();
      publishConfig();
    } else if (cmd == "learn on" || cmd == "learn off") {
      learnMode = cmd == "learn on";
      saveConfig();
      publishConfig();
    } else if (cmd == "raw on" || cmd == "raw off") {
      rawDebug = cmd == "raw on";
    } else if (cmd.startsWith("half ")) {
      timing.halfUs = (uint16_t)cmd.substring(5).toInt();
      timing.skewUs = 0;
      saveTiming();
      Serial.printf("half-bit = %u us, skew reset to 0 (saved)\n", timing.halfUs);
    } else if (cmd == "invert on" || cmd == "invert off") {
      timing.inverted = cmd == "invert on";
      saveTiming();
      Serial.printf("inverted = %d (saved)\n", timing.inverted);
    } else if (cmd == "bursts") {
      printLog(LOG_LEN);
    } else if (cmd == "dump") {
      if (!lastCaptureLen) {
        Serial.println("no burst captured since boot");
      } else {
        Serial.printf("last burst, %u pulses (H=carrier on, L=gap), us:\n", (unsigned)lastCaptureLen);
        for (size_t i = 0; i < lastCaptureLen; ++i) {
          Serial.printf("%c%u%s", lastCapture[i].level ? 'H' : 'L', lastCapture[i].us,
                        (i % 16 == 15) ? "\n" : " ");
        }
        Serial.println();
        printHistogram(lastCapture, lastCaptureLen);
      }
    } else if (cmd == "clearlog") {
      uint32_t boots = blog.boots;
      memset(&blog, 0, sizeof(blog));
      blog.boots = boots;
      logDirty = true;
      saveLogIfDue(true);
      Serial.println("log cleared");
    } else if (cmd == "scope on" || cmd == "scope off") {
      scopeOn = cmd == "scope on";
    } else if (cmd == "status") {
      Serial.printf("up %lus decoded=%lu reported=%lu runs=%lu bursts=%lu/%lu overflows=%lu ble=%d\n",
                    (unsigned long)(millis() / 1000), (unsigned long)framesDecoded,
                    (unsigned long)framesReported, (unsigned long)runsTried,
                    (unsigned long)sessionBurstsDecoded, (unsigned long)sessionBursts,
                    (unsigned long)ringOverflows, clientConnected ? 1 : 0);
      Serial.printf("timing: half=%uus skew=%dus inverted=%d\n", timing.halfUs, timing.skewUs,
                    timing.inverted);
    } else {
      printHelp();
    }
  }
}

// ---- Main -----------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nPM-TPMS receiver");
  pinMode(LED_PIN, OUTPUT);
  pinMode(RX_PIN, INPUT);

  prefs.begin("tpms", false);
  loadConfig();
  selfTest();  // nominal timing, before any learned timing is applied
  loadTiming();
  loadLog();
  printLog(5);
  Serial.println("  (type `bursts` for the full log)");
  setupBle();

  // Start the density window "sparse" so boot is not mistaken for a burst.
  for (size_t i = 0; i < BURST_EDGES; ++i) winDur[i] = 0xFFFF;
  winSum = (uint32_t)BURST_EDGES * 0xFFFF;
  lastEdgeUs = micros();
  attachInterrupt(digitalPinToInterrupt(RX_PIN), onEdge, CHANGE);
  Serial.printf("listening on GPIO %d, %u ids allowlisted, learn=%d, half=%uus skew=%dus inv=%d\n",
                RX_PIN, (unsigned)allowCount, learnMode, timing.halfUs, timing.skewUs,
                timing.inverted);
  printHelp();
}

void loop() {
  drainEdges();
  analyzeBurst();
  handleSerial();
  applyPendingConfig();
  serviceReplay();
  saveLogIfDue(false);

  if (advertiseRequested) {
    advertiseRequested = false;
    delay(50);  // let the stack finish tearing the link down
    BLEDevice::startAdvertising();
  }

  // Wiring check: edges per second on the DATA pin and its current level.
  // A connected RX470C chatters hundreds to thousands of edges/s on noise
  // alone; 0 means nothing is reaching the pin.
  static uint32_t lastScope = 0, lastEdges = 0;
  if (millis() - lastScope >= 1000) {
    uint32_t e = edgeCount;
    edgesPerSec = e - lastEdges;
    lastEdges = e;
    lastScope = millis();
    if (scopeOn) {
      Serial.printf("scope: %lu edges/s, pin=%d, runs=%lu, bursts=%lu, decoded=%lu\n",
                    (unsigned long)edgesPerSec, digitalRead(RX_PIN), (unsigned long)runsTried,
                    (unsigned long)sessionBursts, (unsigned long)framesDecoded);
    }
  }

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > STATUS_PERIOD_MS) {
    lastStatus = millis();
    publishStatus();
  }
}
