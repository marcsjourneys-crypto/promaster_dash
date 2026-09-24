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
static const uint32_t STATUS_PERIOD_MS = 5000;

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

static void drainEdges() {
  while (ringTail != ringHead) {
    uint32_t v = ring[ringTail];
    ringTail = (ringTail + 1) & (RING - 1);
    schrader::Pulse p{(uint16_t)(v & 0xFFFF), (uint8_t)(v >> 16)};
    if (schrader::halfUnits(p.us, timing) == 0) {
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

// STATUS frame, 17 bytes LE:
//   ver u8 | uptime_s u32 | framesDecoded u32 | framesReported u32 | overflows u32
static void publishStatus() {
  uint8_t b[17];
  b[0] = PROTO_VERSION;
  uint32_t vals[4] = {millis() / 1000, framesDecoded, framesReported, ringOverflows};
  memcpy(b + 1, vals, sizeof(vals));
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
                 " raw on|off | half <us> | status | scope on|off");
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
      Serial.printf("half-bit = %u us\n", timing.halfUs);
    } else if (cmd == "scope on" || cmd == "scope off") {
      scopeOn = cmd == "scope on";
    } else if (cmd == "status") {
      Serial.printf("up %lus decoded=%lu reported=%lu runs=%lu overflows=%lu ble=%d\n",
                    (unsigned long)(millis() / 1000), (unsigned long)framesDecoded,
                    (unsigned long)framesReported, (unsigned long)runsTried,
                    (unsigned long)ringOverflows, clientConnected ? 1 : 0);
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
  selfTest();
  setupBle();

  lastEdgeUs = micros();
  attachInterrupt(digitalPinToInterrupt(RX_PIN), onEdge, CHANGE);
  Serial.printf("listening on GPIO %d, %u ids allowlisted, learn=%d\n", RX_PIN,
                (unsigned)allowCount, learnMode);
  printHelp();
}

void loop() {
  drainEdges();
  handleSerial();
  applyPendingConfig();
  serviceReplay();

  if (advertiseRequested) {
    advertiseRequested = false;
    delay(50);  // let the stack finish tearing the link down
    BLEDevice::startAdvertising();
  }

  // Wiring check: edges per second on the DATA pin and its current level.
  // A connected RX470C chatters hundreds to thousands of edges/s on noise
  // alone; 0 means nothing is reaching the pin.
  static uint32_t lastScope = 0, lastEdges = 0;
  if (scopeOn && millis() - lastScope >= 1000) {
    uint32_t e = edgeCount;
    Serial.printf("scope: %lu edges/s, pin=%d, runs=%lu, decoded=%lu\n",
                  (unsigned long)(e - lastEdges), digitalRead(RX_PIN),
                  (unsigned long)runsTried, (unsigned long)framesDecoded);
    lastEdges = e;
    lastScope = millis();
  }

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > STATUS_PERIOD_MS) {
    lastStatus = millis();
    publishStatus();
  }
}
