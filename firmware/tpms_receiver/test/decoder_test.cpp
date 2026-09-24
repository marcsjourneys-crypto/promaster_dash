// Host test for the Schrader decoder. Arduino IDE ignores this folder.
//
//   cd firmware/tpms_receiver
//   c++ -std=c++17 -Wall -I. test/decoder_test.cpp schrader_decoder.cpp -o /tmp/dt && /tmp/dt

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "schrader_decoder.h"

using namespace schrader;

static int failures = 0;
#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

static Frame make(uint32_t id, float kPa, int tempC, uint8_t flags = 0x07) {
  return Frame{id, flags, (uint8_t)(kPa / 2.5f + 0.5f), (uint8_t)(tempC + 50)};
}

static std::vector<Pulse> air(const Frame& f, const Timing& t) {
  std::vector<Pulse> p(kFrameBits * 2);
  p.resize(encode(f, t, p.data(), p.size()));
  return p;
}

static void test_crc_reference_frame() {
  // Example frame from the protocol description: f6 70 3a 38 b2 00 49 | 49
  const uint8_t b[8] = {0xf6, 0x70, 0x3a, 0x38, 0xb2, 0x00, 0x49, 0x49};
  CHECK(crc8(b, 7) == 0x49);
  Frame f{};
  CHECK(parseBytes(b, &f));
  CHECK(f.id == 0x03a38b2);
  CHECK(f.flags == 0x67);
  CHECK(f.pressureRaw == 0);
  CHECK(f.tempC() == 23);
}

static void test_bad_crc_and_preamble_rejected() {
  uint8_t b[8] = {0xf6, 0x70, 0x3a, 0x38, 0xb2, 0x00, 0x49, 0x48};
  Frame f{};
  CHECK(!parseBytes(b, &f));
  uint8_t c[8] = {0xe6, 0x70, 0x3a, 0x38, 0xb2, 0x00, 0x49, 0x00};
  c[7] = crc8(c, 7);
  CHECK(!parseBytes(c, &f));  // preamble nibble must be F
}

static void test_roundtrip_van_sensors() {
  Timing t;
  const Frame sensors[] = {make(0x05E671A, 447.5f, 22), make(0x05E670D, 445.0f, 25),
                           make(0x00FA4D3, 467.5f, 25), make(0x00FBFF7, 470.0f, 23)};
  for (const Frame& s : sensors) {
    auto p = air(s, t);
    Frame got{};
    CHECK(decodeRun(p.data(), p.size(), t, &got, 1) == 1);
    CHECK(got.samePayload(s));
  }
  Frame got{};
  auto p = air(sensors[0], t);
  decodeRun(p.data(), p.size(), t, &got, 1);
  CHECK(got.kPa() == 447.5f);
  CHECK(got.tempC() == 22);
}

static void test_slicer_skew_tolerated() {
  // Superhet receivers stretch highs and shrink lows.
  Timing t;
  Frame s = make(0x05E671A, 447.5f, 22);
  for (int skew : {-35, 35}) {
    auto p = air(s, t);
    for (auto& x : p) x.us = (uint16_t)(x.us + (x.level ? skew : -skew));
    Frame got{};
    CHECK(decodeRun(p.data(), p.size(), t, &got, 1) == 1);
    CHECK(got.samePayload(s));
  }
}

static void test_noise_prefix_and_suffix() {
  Timing t;
  Frame s = make(0x00FBFF7, 467.5f, 24);
  std::vector<Pulse> run = {{130, 1}, {250, 0}, {110, 1}, {130, 0}};
  // A frame always starts after silence, but the receiver may emit in-range
  // junk right before it; the leading low of the frame then merges with it.
  run.push_back({400, 0});  // out of range: ends the junk run
  auto p = air(s, t);
  run.insert(run.end(), p.begin(), p.end());
  run.push_back({120, 1});
  run.push_back({240, 0});
  Frame got{};
  CHECK(decodeRun(run.data(), run.size(), t, &got, 1) == 1);
  CHECK(got.samePayload(s));
}

static void test_random_noise_never_decodes() {
  Timing t;
  std::srand(1234);
  int hits = 0;
  for (int trial = 0; trial < 2000; ++trial) {
    std::vector<Pulse> run(140);
    for (size_t i = 0; i < run.size(); ++i) {
      run[i] = Pulse{(uint16_t)(70 + std::rand() % 230), (uint8_t)((i + 1) & 1)};
    }
    Frame got{};
    if (decodeRun(run.data(), run.size(), t, &got, 1)) ++hits;
  }
  CHECK(hits == 0);
}

static void test_truncated_frame_rejected() {
  Timing t;
  auto p = air(make(0x05E671A, 447.5f, 22), t);
  p.resize(p.size() - 6);
  Frame got{};
  CHECK(decodeRun(p.data(), p.size(), t, &got, 1) == 0);
}

static void test_two_sensors_in_one_run() {
  // Two bursts separated by an in-range gap arrive as one run.
  Timing t;
  Frame a = make(0x05E671A, 447.5f, 22), b = make(0x00FBFF7, 467.5f, 24);
  auto run = air(a, t);
  run.push_back({240, 0});
  auto pb = air(b, t);
  run.insert(run.end(), pb.begin(), pb.end());
  Frame got[4]{};
  CHECK(decodeRun(run.data(), run.size(), t, got, 4) == 2);
  CHECK(got[0].samePayload(a));
  CHECK(got[1].samePayload(b));
}

int main() {
  test_crc_reference_frame();
  test_bad_crc_and_preamble_rejected();
  test_roundtrip_van_sensors();
  test_slicer_skew_tolerated();
  test_noise_prefix_and_suffix();
  test_random_noise_never_decodes();
  test_truncated_frame_rejected();
  test_two_sensors_in_one_run();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("all decoder tests passed\n");
  return 0;
}
