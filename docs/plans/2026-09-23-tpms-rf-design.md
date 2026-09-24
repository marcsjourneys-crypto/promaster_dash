# TPMS over 433 MHz — design

**Status:** implemented on `feature/tpms-rf`; not yet run on RF or on the phone.
**Supersedes:** the OBD approach in the vault's `TPMS Hunt` note (BCM `0x40`
live-data DIDs all returned NRC 31).

## Why RF

On 2026-09-21 an RTL-SDR running rtl_433 decoded all four of the van's tire
sensors broadcasting in the clear on 433.92 MHz, with no module in between.
The OBD path needed a session-gated DID nobody has published. Reading the RF
avoids the problem.

| ID | kPa | psi | °C |
|---|---|---|---|
| 05E671A | 442.5–447.5 | ~64–65 | 22 |
| 05E670D | 445–447.5 | ~65 | 25 |
| 00FA4D3 | 465–467.5 | ~67–68 | 24–25 |
| 00FBFF7 | 467.5–470 | ~68 | 23–24 |

## Architecture

```
sensors ──433.92 OOK──▶ RX470C ─DATA─▶ ESP32  (edge ISR → Manchester → CRC
                                               → allowlist → burst dedup)
                                                  │ BLE GATT (PM-TPMS)
                                                  ▼
iPhone  tpmsService ─▶ vehicleStore.tpms* ─▶ TPMSScreen / TPMSConfigScreen
                                          └▶ computeAlert() ─▶ AlertBanner
```

## Protocol (rtl_433 decoder 60, "Schrader TPMS", FCC-ID MRXGG4)

- OOK, Manchester with rising edge = 0, half-bit ~120 µs.
- 68 bits: sync `0111`, then b0..b7.
  - Preamble nibble `F`.
  - `flags = (b0&0F)<<4 | b1>>4`.
  - `id = (b1&0F)<<24 | b2<<16 | b3<<8 | b4`.
  - Pressure `b5 × 2.5 kPa`, gauge.
  - Temperature `b6 − 50 °C`.
  - `b7 = CRC-8(b0..b6, poly 0x07, init 0xF0)`.
- The decoder is written from this description. rtl_433 is GPL, and none of
  its code is used.

## Decisions

- **Receiver: RX470C, with a CC1101 as the fallback.** Every published ESP32
  TPMS project uses a CC1101. The RX470C should work because the signal is
  plain OOK. The one real risk is whether its slicer passes 120 µs pulses
  cleanly. Bring-up is the go/no-go test. The decoder doesn't depend on which
  radio feeds it.
- **The firmware filters by ID.** Other vehicles' sensors never reach the phone
  unless learn mode is on. CRC-8 plus the `F` nibble is not enough to trust
  noise, so an unknown ID has to repeat before it is forwarded.
- **The app is the source of truth for the allowlist.** It pushes the list to
  the receiver on every connect, and the receiver persists it only so it
  filters correctly while the phone is away.
- **Cache replay on connect.** Sensors are silent when parked, so the receiver
  replays its last reading for each ID, back-dated by age. Without it the
  screen would stay empty until the van moves.
- **Convert at ingest.** kPa and °C become psi and °F in `tpmsProtocol`, which
  keeps the store's "imperial inside, convert at render" rule. Pressure gets
  its own display unit (psi, kPa or bar).
- **Wheel mapping by deflation.** Letting air out of one tire makes its sensor
  transmit immediately, and the ID whose pressure falls at least 2 psi is that
  wheel. No tool is needed, and it doubles as a check that the sensor works.
  It has to be redone after a tire rotation.
- **Per-axle targets.** A ProMaster 2500 placard reads 65 front / 80 rear, but
  this van's sensors read 65–68 on all four wheels. Both targets default to
  65 psi and are set from the door placard on the LIMITS tab.
- **Alerts.** Critical at 25% under target (the FMVSS 138 point), placed in
  priority 2 after oil temp. Soft, high and hot tires are warnings in
  priority 3. A sensor that isn't assigned to a wheel never alerts.
- **Stale readings dim, not hide.** After 20 minutes the value stays on screen,
  faded. A stale low tire still alerts, because a flat on a parked van is
  still flat.
- **Shared BLE manager and scan token.** ble-plx allows one `BleManager`, and
  `stopDeviceScan()` is global. The OBD scan's 10-second auto-stop would kill
  a receiver pairing scan, so each scan now holds a token.

## Bring-up checklist

1. Flash `firmware/tpms_receiver`. The Serial log shows `decoder self-test: PASS`.
2. Run the ESP32 side by side with `rtl_433 -R 60 -F json`. IDs, kPa and °C
   should match on every burst. If they don't, tune with `raw on` and
   `half <µs>`.
3. Check the BLE side with nRF Connect: `PM-TPMS` notifies READING.
4. In the app, go to TIRES → ⚙ → RECEIVER → scan and pair. Readings should
   fill in from the replay.
5. On IDENTIFY, run all four wheels. Compare the results against a hand gauge
   (±1 psi).
6. On LIMITS, enter the placard targets. Let one tire down below the warn
   limit and confirm the banner appears.
7. Check that rear tires are received from wherever the ESP32 is mounted.
