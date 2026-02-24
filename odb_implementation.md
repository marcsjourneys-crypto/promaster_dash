# OBD Service Implementation Plan
ProMaster Adventure Dash — Implementation blueprint for `services/obd_service.py`  
Target: 2014 Ram ProMaster (gas), 62TE trans  
Adapter: Vgate vLinker USB (STN, ELM-compatible)

This file is a code-first plan: class skeletons, signals, polling schedule, parsing helpers, and integration steps.

---

## 1) Design Goals

- Robust on Raspberry Pi 5 in a vehicle
- Non-blocking UI (OBD runs in worker thread)
- Auto-reconnect on disconnect / ignition off / NO DATA storms
- Support standard OBD (Mode 01/03/04) + UDS Mode 22 for trans temp
- Support discovery/scanning of candidate trans-temp DIDs/headers

---

## 2) File Layout

Create:

- `src/promaster_dash/services/obd_service.py`
- `src/promaster_dash/services/trans_temp_candidates.py`
- `src/promaster_dash/services/obd_protocol.py` (optional helpers)
- `src/promaster_dash/services/dtc_decode.py`

Recommended minimal approach:
- Put candidates + conversion in `trans_temp_candidates.py`
- Put core adapter wrapper in `obd_service.py`
- Put DTC decode in `dtc_decode.py`

---

## 3) Threading Model (Qt)

### Pattern
- `OBDService(QObject)` is moved to its own `QThread`
- `OBDService` owns the serial port and polling loop
- It emits Qt signals with values
- UI subscribes and updates VehicleState

### Signals (proposal)
- `connectionStatusChanged(connected: bool, message: str)`
- `coolantUpdated(temp_f: float)`
- `rpmUpdated(rpm: int)`
- `obdSpeedUpdated(speed_mph: float)`  # backup to GPS speed
- `voltageUpdated(volts: float)`
- `transTempUpdated(temp_f: float)`
- `dtcListUpdated(codes: list[str])`
- `rawTraffic(debug_line: str)`  # only if debug enabled

### Slots / commands
- `start()` / `stop()`
- `requestScanTransCandidates()`   # run candidate DID scan
- `requestClearCodes()`            # clear DTCs (Mode 04)
- `setDebug(enabled: bool)`

UI integration:
- UI calls these via queued connections (signals/slots) not direct thread calls.

---

## 4) Polling Schedule

Vehicle-safe schedule (single loop with timers):

Fast:
- RPM (010C): every 250 ms (4 Hz)
- OBD speed backup (010D): every 500 ms (2 Hz)

Medium:
- Coolant (0105): every 1.0 s
- Voltage (ATRV): every 2.0 s
- Trans temp (Mode 22): every 1.0 s once working DID known

Slow:
- DTC list (03): every 10–15 s (and on connect)

Pseudo schedule:
- maintain `next_due` timestamps for each metric
- each loop iteration checks what’s due, sends 1 request, then sleeps ~30–60ms
- never burst too many requests at once

---

## 5) OBD Adapter Wrapper (Serial + AT)

### Responsibilities
- Open/close COM port
- Send AT commands and OBD requests
- Read response until `>` prompt or timeout
- Normalize response text (strip prompt, spaces, SEARCHING..., etc)

### Recommended init sequence
Send with small delays:

- `ATZ` (reset, longer wait)
- `ATE0`
- `ATL0`
- `ATS0`
- `ATH1` (headers on during dev; can turn off later)
- `ATCAF0` (critical for raw parsing stability with Mode 22)
- `ATCFC1` (flow control on)
- `ATSP0` (auto) OR `ATSP6` (CAN 29/500) for ProMaster modules
- `ATST7D` (timeout ~500ms-ish)
- `ATI` and `ATRV` to validate

Protocol strategy:
1) Connect using `ATSP0` (auto)
2) Verify Mode 01 works (010C, 0105)
3) If Mode 22 fails, switch to `ATSP6` and retry Mode 22 reads

---

## 6) Trans Temp Candidate Discovery

File: `trans_temp_candidates.py`

Create a dataclass:

- name
- header (e.g. `18DA10F1` or `7E0`)
- did (e.g. `B010`)
- parser/convert function (A,B -> °F)
- notes

Implement:
- `scan_candidates(adapter) -> list[CandidateResult]`
- `select_first_working(candidates) -> Candidate | None`

Sanity checks:
- -40°F to 400°F
- ignore static values that never change (optional later)

Operational note:
Some vehicles report incorrect temp in P/N. Provide hint if values look like coolant temp.

---

## 7) Parsing Helpers

### 7.1 General response cleanup
- Split lines
- Remove non-hex characters
- Optionally keep headers for debugging

### 7.2 Mode 01 parsing
Expected:
- `41 0C A B` for RPM
- `41 05 A` for coolant
- `41 0D A` for speed

Implement:
- `parse_mode01_pid(resp: str, pid_hex: str) -> list[int] | None`
Returns bytes after the PID (A,B,...)

### 7.3 Mode 22 parsing (UDS)
Look for marker:
- `62<DID>`

Implement:
- `parse_mode22(resp: str, did: str) -> bytes | None`
Return data bytes after DID.

### 7.4 DTC parsing
Mode 03 response:
- `43 <A><B> <A><B> ...`

Implement:
- `parse_mode03_dtcs(resp: str) -> list[str]`

Also handle:
- `NO DATA` -> empty list
- DTC count changes should trigger UI banner

---

## 8) Reconnect Strategy

Maintain counters:
- `consecutive_failures`
- `last_success_time`

Rules:
- Any successful parsed value resets `consecutive_failures`
- If failures exceed threshold (e.g. 15 in a row), mark disconnected:
  - emit `connectionStatusChanged(False, "reconnecting")`
  - close serial
  - sleep 2 seconds
  - reconnect + re-init
- If adapter missing (COM port gone), backoff longer (5s)

UI should show `--` values when disconnected.

---

## 9) Clear Codes Safety UX

Implement as a queued request:
- UI triggers `requestClearCodes()` only after long-press confirm
- OBD thread executes:
  - send `04`
  - verify response contains `OK` or `44`
  - then re-scan DTCs after 2 seconds

Future safety:
- require speed == 0 and rpm < 1000

---

## 10) Concrete Skeleton (What to Implement)

### 10.1 `OBDAdapter` class
Methods:
- `open(port, baud)`
- `close()`
- `send(cmd, timeout=...) -> str`
- `initialize() -> bool`
- `set_protocol_29bit() -> None`
- `set_header(header_hex: str) -> None`
- `request_mode01(pid: str) -> str`
- `request_mode03() -> str`
- `request_clear_codes() -> str`
- `request_mode22(did: str) -> str`

### 10.2 `OBDService(QObject)`
Fields:
- config: port, baud
- adapter: OBDAdapter
- working_trans_candidate: Candidate | None
- debug_enabled: bool
- running: bool
- schedule timestamps

Core loop:
- `run()` called inside QThread
- each iteration:
  - if not connected, attempt connect/init
  - poll due items (one request per tick)
  - emit signals on new values
  - sleep short

### 10.3 UI Hook
In MainWindow:
- start OBD thread only on Pi / or when `--obd` flag is enabled
- connect signals to update VehicleState fields

---

## 11) Minimal “MVP” Build Order (Recommended)

1) Implement OBDAdapter init + Mode 01 RPM/Coolant
2) Add Voltage (`ATRV`)
3) Add DTC scan (Mode 03) + decode
4) Add trans candidate scan + pick working
5) Add continuous trans polling using selected candidate
6) Add clear codes with confirmation

---

## 12) Testing Strategy

### Windows (no vehicle)
- Keep mock mode for UI
- Unit test parsing functions with recorded response strings

### Pi in vehicle (real test)
- Add debug log option:
  - write all requests/responses to `logs/obd_raw.log`
- Test:
  - connect with ignition on
  - unplug adapter mid-run (should reconnect)
  - shift P->D to verify trans temp changes

---

## 13) Reference Implementation Notes

- Use `ATCAF0` for Mode 22 reliability
- Keep `ATH1` during development to confirm module responses; later can disable for simpler parsing
- Throttle requests; don’t exceed ~10 req/sec sustained
- Avoid `SEARCHING...` loops by forcing protocol once discovered

---

## 14) Deliverables Checklist

- [ ] `services/obd_service.py` implemented with QThread run loop
- [ ] `services/trans_temp_candidates.py` with candidate list + conversion
- [ ] `services/dtc_decode.py` (decode two-byte DTCs)
- [ ] UI integrates OBDService behind feature flag
- [ ] Debug logging option for raw OBD traffic

---

End of plan.