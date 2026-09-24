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
static uint32_t ringTail = 0;
static volatile uint32_t lastEdgeUs = 0;
static volatile uint32_t ringOverflows = 0;

void IRAM_ATTR onEdge() {
  uint32_t now = micros();
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

static BLEServer* server = nullptr;
static BLECharacteristic* readingChar = nullptr;
static BLECharacteristic* configChar = nullptr;
static BLECharacteristic* statusChar = nullptr;
static volatile bool clientConnected = false;
static volatile bool replayRequested = false;

// ---- Allowlist persistence ------------------------------------------------

// putBytes() refuses zero-length values, so the count is stored separately
// and an intentionally empty allowlist survives a reboot.
static void saveConfig() {
  prefs.putUChar("count", (uint8_t)allowCount);
  if (allowCount) prefs.putBytes("ids", allowIds, allowCount * sizeof(uint32_t));
  prefs.putUChar("learn", learnMode ? 1 : 0);
}

static void loadConfig() {
  if (prefs.getUChar("count", 0xFF) == 0xFF) {
    allowCount = sizeof(DEFAULT_IDS) / sizeof(DEFAULT_IDS[0]);
    memcpy(allowIds, DEFAULT_IDS, sizeof(DEFAULT_IDS));
    saveConfig();
  } else {
    size_t count = prefs.getUChar("count", 0);
    allowCount = count > MAX_IDS ? MAX_IDS : count;
    if (allowCount) prefs.getBytes("ids", allowIds, allowCount * sizeof(uint32_t));
  }
  learnMode = prefs.getUChar("learn", 0) != 0;
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
  // Forget cached readings from IDs that are no longer wanted.
  for (auto& c : cache)
    if (c.used) c.known = isAllowed(c.frame.id);
  return true;
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

static void replayCache() {
  for (auto& c : cache)
    if (c.used && (c.known || learnMode)) sendReading(c, true);
}

// ---- Pulse processing -----------------------------------------------------

static void tryDecode() {
  runsTried++;
  schrader::Frame f;
  if (schrader::decodeRun(run, runLen, timing, &f)) handleFrame(f);
  else if (rawDebug) Serial.printf("run of %u pulses, no frame\n", (unsigned)runLen);
}

static void endRun() {
  if (runLen >= MIN_RUN) tryDecode();
  runLen = 0;
}

// The RX470C's AGC turns silence into in-range noise, so a run can grow
// without bound. When the buffer fills, decode it and keep the tail, which
// may hold the start of a frame. Duplicate decodes are absorbed by the
// burst dedup.
static void slideRun() {
  tryDecode();
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
    BLEDevice::startAdvertising();
  }
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (applyConfigFrame(c->getData(), c->getLength())) {
      Serial.printf("config: %u ids, learn=%d\n", (unsigned)allowCount, learnMode);
    } else {
      Serial.println("config: rejected malformed write");
    }
    publishConfig();
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
    ok &= schrader::decodeRun(p, n, timing, &out) && out.samePayload(in);
  }
  Serial.printf("decoder self-test: %s\n", ok ? "PASS" : "FAIL");
  return ok;
}

// ---- Serial console -------------------------------------------------------

static void printHelp() {
  Serial.println("commands: list | add <hex id> | del <hex id> | learn on|off |"
                 " raw on|off | half <us> | status");
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

  if (replayRequested) {
    replayRequested = false;
    replayCache();
  }

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > STATUS_PERIOD_MS) {
    lastStatus = millis();
    publishStatus();
  }
}
