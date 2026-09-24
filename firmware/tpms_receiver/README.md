# PM-TPMS receiver (ESP32 + RX470C)

Listens for the van's Schrader TPMS sensors on 433.92 MHz and forwards
readings from known sensor IDs to ProMaster Dash over BLE.

## Hardware

| RX470C pin | ESP32 (ELEGOO ESP-WROOM-32) |
|---|---|
| VCC | 3V3 (if your RX470C runs on 5 V only, use VIN/5V **and** put a 10k/20k divider on DATA) |
| GND | GND |
| DATA | GPIO 27 |
| ANT | 17.3 cm straight wire (quarter wave at 433.92 MHz) |

The on-board LED (GPIO 2) blinks once per reported reading.

## Build and flash (Arduino IDE)

1. Boards Manager → install **esp32 by Espressif Systems**.
2. Board: **ESP32 Dev Module**. No extra libraries are needed. BLE and
   Preferences ship with the core.
3. Open `tpms_receiver.ino` and click Upload. Serial Monitor at **115200**.

Boot prints `decoder self-test: PASS`, which means the decoder round-trips
synthetic frames before any RF is involved.

If a future core pushes the sketch past the flash limit, set Tools →
Partition Scheme → **Huge APP**.

## Serial console

| Command | Effect |
|---|---|
| `list` | Show allowlisted IDs and learn mode |
| `add 05E671A` / `del 05E671A` | Edit the allowlist (saved to flash) |
| `learn on` / `learn off` | Also forward unknown Schrader IDs (must repeat twice) |
| `raw on` / `raw off` | Print ignored frames and failed decode runs |
| `half 120` | Manchester half-bit in µs (resets skew; saved). Normally set by autotune |
| `invert on` / `invert off` | Treat DATA low as carrier-on (saved). Normally set by autotune |
| `status` | Uptime, counters, current timing |
| `bursts` | The persistent burst log: what it heard, even across power cycles |
| `dump` | Every pulse width of the last burst, plus a width histogram |
| `clearlog` | Empty the burst log |
| `scope on` / `scope off` | Once a second: edges/s on the DATA pin and its level. The wiring check (see below) |

Output lines mirror rtl_433, so you can run both side by side:

```
TPMS id=05E671A flags=07 pressure=447.5kPa (64.9psi) temp=22C known=1
```

## Wiring check

Type `scope on`. Every second it prints edges/s on GPIO 27 and the pin level.

| What you see | Meaning |
|---|---|
| Hundreds to thousands of edges/s with nothing transmitting | Normal. The RX470C turns noise into pulses. Wired up. |
| Edges jump when you press a key fob near the antenna | Receiver and antenna working |
| `0 edges/s`, pin stuck at 0 or 1 | Nothing reaching GPIO 27: check DATA wire, VCC, GND |
| Edges drop to near 0 when you unplug the DATA wire | Confirms the count came from the receiver |

## Burst detection and autotune

The receiver spots tire transmissions by **edge density**, not by the
decoder's timing. About 60 edges packed into 25 ms is a burst, while noise
runs at roughly 1 edge per ms. So it records a burst even when it can't read
it. For each one it:

1. Tries the current timing.
2. If that fails, sweeps half-bit width, high/low skew and polarity. When one
   decodes, the receiver adopts it and saves it to flash, then prints:
   `autotune: half=…us skew=…us inverted=…`
3. Prints a `burst:` line. If the burst didn't decode, it adds a histogram of
   pulse widths.
4. Appends a summary to a 16-entry log in flash, which survives unplugging.
   After a drive, plug in and type `bursts`. The boot banner also shows the
   last 5 entries.

On the phone, the TIRES screen shows the same thing in one line:
`RX 800 edges/s · 3 bursts · 0 decoded · last 40s ago`. It turns amber when
bursts are heard but none decode.

## First bring-up (go/no-go for the RX470C)

1. Run `rtl_433 -R 60 -F json` on the RTL-SDR next to the ESP32.
2. Wake the sensors by driving, or by letting a little air out of a tire.
3. Every burst rtl_433 prints should also appear on the ESP32 Serial with the
   same ID, kPa and °C.
4. If rtl_433 decodes but the ESP32 only logs `burst: … NOT decoded`, type
   `dump` and paste it next to rtl_433's `-A` pulse analysis for the same
   transmission. The widths show what the RX470C is doing to the signal.
5. If it still fails, the RX470C's slicer can't pass 120 µs pulses. Swap in a
   CC1101 in async OOK mode on GDO0. The decoder is unchanged.

## BLE protocol (v1)

Advertised name `PM-TPMS`, service `7d2a0001-6c1e-4f3b-9a5e-3b1f0c2d8e41`.
All integers are little-endian. The app-side mirror is
`mobile/src/services/tpmsProtocol.ts`. Change both together.

| Char | UUID suffix | Props | Payload |
|---|---|---|---|
| READING | `…0002` | notify | 12 B: `ver u8, id u32, pressureRaw u8 (×2.5 kPa), tempRaw u8 (−50 °C), flags u8, rflags u8 (bit0 known, bit1 cached), age_s u16, reserved u8` |
| CONFIG | `…0003` | read, write | `ver u8, learn u8, n u8, id u32 × n` (n ≤ 8) |
| STATUS | `…0004` | read, notify | 17 B: `ver u8, uptime_s u32, decoded u32, reported u32, overflows u32` |
| CONTROL | `…0005` | write | `0x01` = replay the last reading of every sensor |

The app subscribes to READING and then writes `0x01` to CONTROL. Parked
sensors are silent, so the replay is what fills the screen right away.

## Protocol notes

Schrader, FCC-ID MRXGG4 family (rtl_433 decoder 60). OOK Manchester,
~120 µs half-bit, 68 bits: sync `0111` + `F` preamble nibble, 8-bit flags,
28-bit ID, pressure ×2.5 kPa (gauge), temperature −50 °C, CRC-8 (poly 0x07,
init 0xF0). The decoder is written from this description; no rtl_433 code
is used.

## Host test

The Arduino IDE ignores `test/`. On the Mac:

```sh
cd firmware/tpms_receiver
c++ -std=c++17 -Wall -I. test/decoder_test.cpp schrader_decoder.cpp -o /tmp/dt && /tmp/dt
```
