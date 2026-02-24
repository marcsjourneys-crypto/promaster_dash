# OBD Deep Dive
ProMaster Adventure Dash — OBD2/UDS Integration Notes  
Target vehicle: 2014 Ram ProMaster (gas), 62TE transmission  
Adapter: Vgate vLinker (STN-based) USB serial (ELM-compatible + STN extensions)

---

## 0) Goals

We want a robust OBD layer that can:

- Connect reliably (auto-reconnect)
- Read:
  - Coolant temp (Mode 01 PID 05)
  - RPM (Mode 01 PID 0C)
  - Vehicle speed (Mode 01 PID 0D) as backup to GPS
  - Battery voltage (ATRV)
  - DTCs (Mode 03, optional UDS Mode 19 if needed)
  - Clear DTCs (Mode 04)
- Read **Transmission Temperature** using Mode 22 (UDS ReadDataByIdentifier) for ProMaster/62TE
- Provide a “PID Lab / Scanner” to discover working headers/DIDs on this exact van

Constraints:
- Never block UI
- Handle NO DATA, SEARCHING…, BUS ERROR, STOPPED, etc.
- Support 29-bit CAN addressing used on this platform for many modules

---

## 1) Key Concepts

### 1.1 ELM327/STN adapters
Adapters speak “AT commands” + OBD requests over a serial port (USB CDC/COM).

- ELM327 commands start with `AT...`
- STN chips support ELM commands and add ST commands (often `ST...`) and better CAN handling.

### 1.2 CAN 11-bit vs 29-bit
- Standard OBD on many vehicles uses 11-bit IDs (e.g., request to 0x7DF or 0x7E0).
- ProMaster (Ducato-based) frequently uses **29-bit extended CAN** for module addressing (TCM/PCM requests like `18DAxxF1` etc).

Your discovery plan:
- Try 29-bit headers first (e.g., `18DA10F1`), then fallback 11-bit (`7E0`).

### 1.3 OBD Mode vs UDS
- “Mode 01/03/04” are classic OBD services (current data, DTCs, clear DTCs).
- “Mode 22” is commonly used as UDS ReadDataByIdentifier (UDS service 0x22).  
  Responses are typically:
  - Request: `22 <DID>`
  - Response: `62 <DID> <data...>`

### 1.4 Multi-frame (ISO-TP)
Some responses exceed 7 bytes and arrive as multi-frame ISO-TP.
Adapters may:
- auto-handle ISO-TP (common)
- need explicit flow control settings (ATFC… commands often help)

We should support both:
- simple single-frame parsing
- multi-line parsing with headers + data extraction

---

## 2) Recommended Serial Configuration

- Baud: typically 115200 for vLinker; some use 38400 (allow override)
- Timeout: ~1–2 seconds for reads
- Write timeout: ~1–2 seconds

Connection approach:
- Open port
- Send init commands
- Validate with `ATI` and `ATRV`

---

## 3) Robust Adapter Initialization (AT Commands)

### 3.1 Baseline init sequence
This is a good starting set:

- `ATZ`           (reset)
- `ATE0`          (echo off)
- `ATL0`          (linefeeds off)
- `ATS0`          (spaces off)
- `ATH1`          (headers on)  ← useful during discovery; may turn off later
- `ATSP0`         (auto protocol) or `ATSP6` for ISO15765 CAN 29/500
- `ATSTxx`        (timeout; often `ATST7D` ~ 500ms-ish)
- `ATCAF0`        (CAN auto-format off) often improves raw parsing for Mode 22
- `ATCFC1`        (CAN flow control on) default is often on, but explicit helps

Optional:
- `ATDP`          (describe protocol)
- `ATRV`          (voltage)
- `ATCSM0/1`      (CAN silent mode) typically not needed

### 3.2 Protocol selection notes
Try in this order:
1) `ATSP0` (auto) and see if basic Mode 01 works
2) If not stable, force:
   - `ATSP6` (ISO 15765-4 CAN 29-bit 500k)
3) Some adapters use “A/B” codes for user-defined CAN. Only do this if 6 fails.

### 3.3 29-bit addressing essentials
For 29-bit, you will likely set request header via:
- `ATSH18DA10F1` (example)

Then send:
- `22B010`

Response often includes header bytes + data; parse out `62B010...`

Flow control may need:
- `ATFCSH...`
- `ATFCSD...`
- `ATFCSM1`

But many STN chips handle it automatically—still good to have a fallback.

---

## 4) Sending Requests & Parsing Responses

### 4.1 Sending
Always send:
- command + `\r`
- read until prompt `>` or until timeout
- strip noise lines like `SEARCHING...`

Make sure to:
- flush input buffer before request (helps avoid stale reads)
- throttle requests (OBD bus can be sensitive)

### 4.2 Common response patterns
Examples:

**Mode 01 coolant (PID 05)**  
Request: `0105`  
Response: `41 05 7B` (spaces may be removed)

**UDS Mode 22**  
Request: `22B010`  
Response: `62B010 0A 7F ...` (might include headers, multi-lines)

**NO DATA**: literal `NO DATA`  
**BUS ERROR**: wiring/bus issue, wrong protocol, wrong header  
**7F** negative response: `7F 22 <code>` (service not supported, etc)

### 4.3 Parsing strategy (important)
Parsing should:
- Work with headers on/off
- Work with multi-line
- Extract the *service response* (e.g. `62<DID>`)

Algorithm:
1) Split response into lines
2) For each line:
   - keep only hex chars
   - locate marker `62<DID>`
   - take bytes following it
3) If found, parse A/B bytes (or more if needed)
4) Validate sanity ranges before accepting

---

## 5) PID Map (What we read)

### 5.1 Standard Mode 01 PIDs
- Coolant temp:
  - Request: `0105`
  - Response: `41 05 A`
  - °C = A - 40
  - °F = (A - 40) * 9/5 + 32

- RPM:
  - Request: `010C`
  - Response: `41 0C A B`
  - RPM = (256*A + B) / 4

- Speed:
  - Request: `010D`
  - Response: `41 0D A`
  - km/h = A
  - mph = A * 0.621371

- Intake air temp (optional):
  - `010F` (A - 40)

- Engine load (optional):
  - `0104` = A * 100/255

### 5.2 Voltage
- `ATRV` returns something like `14.2V`
- Parse float; if missing, treat as None

### 5.3 DTCs
- Mode 03: `03`
- Response: `43 ...` followed by 2-byte encoded DTCs

DTC decoding:
Two bytes: `A B`
- First two bits of A define prefix:
  - 00 = P, 01 = C, 10 = B, 11 = U
- Next two bits define first digit
- remaining bits form the last digits

We should build:
- `decode_dtc_bytes(bytes) -> list[str]`

### 5.4 Clear Codes
- Mode 04: `04`
- MUST have explicit user confirmation:
  - long-press or “hold 2 seconds” button
  - show warning: clears readiness monitors

Also: only allow when parked (future: check speed==0 and RPM low)

---

## 6) Transmission Temperature (The Big One)

We will use Mode 22 DIDs. Candidate list (ordered likely):

1) Header `18DA10F1` DID `B010` equation:
   - raw = A*256 + B
   - temp_C = raw / 64
   - temp_F = temp_C * 9/5 + 32
   - (some sources list direct C; we’ll compute F)

2) Header `18DA10F1` DID `9110` equation:
   - temp_C = (A*256 + B)/64

3) Header `18DA18F1` DID `1C44` equation:
   - uses signed A only
   - temp_F = signed(A) * 1.8 + 32

4) Header `7E0` DID `B010` (fallback 11-bit)

5) Header `18DA10F1` DID `08DF` (FIAT-ish)
   - temp_C = (A*256 + B)/64
   - temp_F = temp_C*9/5 + 32

Discovery:
- implement `scan_trans_temp_candidates()`:
  - for each candidate:
    - ATSH header
    - maybe flow control setup
    - send `22<DID>`
    - parse `62<DID>`
    - convert + sanity check (-40°F..400°F)
    - report working

Operational note:
Some transmissions only report correct temp in DRIVE/REVERSE (not P/N).
We should:
- display a “shift to D/R for temp” hint if we get implausible values.

---

## 7) Polling Rates & Scheduling

We have different update frequencies:

Fast (4–10 Hz):
- RPM (0C)
- (OBD speed as backup) (0D)

Medium (1–2 Hz):
- coolant
- voltage
- trans temp

Slow (0.2–0.5 Hz):
- DTC scan (03) → don’t spam bus

Recommended schedule:
- a single OBD worker loop with timestamps:
  - every 200ms: RPM
  - every 500ms: trans/coolant/voltage (round-robin)
  - every 5–10s: DTC scan

Include jitter tolerance and reconnect handling.

---

## 8) Threading Model (Qt)

OBD must run in a worker thread.

Implementation recommendation:
- `OBDService(QObject)` moved to a `QThread`
- Signals:
  - `transTempUpdated(float)`
  - `coolantUpdated(float)`
  - `voltageUpdated(float)`
  - `rpmUpdated(int)`
  - `speedUpdated(float)`
  - `dtcUpdated(list[str])`
  - `connectionStatus(bool, str)`  # connected + message

MainWindow:
- updates VehicleState on signals
- UI timer renders state (keeps paint stable)

---

## 9) Error Handling & Reconnect

Handle:
- unplug adapter
- ignition off / bus sleep
- intermittent NO DATA
- protocol mismatch

Strategy:
- On failure N times:
  - mark disconnected
  - close serial
  - wait 2 seconds
  - retry init sequence

When disconnected:
- UI values show `--`
- show top-right indicator “OBD --”

---

## 10) Security / Safety / UX

- Clearing codes should require:
  - long press
  - second confirmation dialog
  - (future) only when speed == 0

- PID lab scan should show:
  - header + DID + raw bytes + computed value
  - allow user to pin a working candidate

- Provide “OBD debug log” toggle:
  - saves raw requests/responses to a log file for diagnosis

---

## 11) Implementation Checklist (OBDService)

- [ ] Port auto-detect (COM ports on Windows; /dev/ttyUSB* on Pi)
- [ ] Serial wrapper: send command, read response until `>`
- [ ] Adapter init (ATZ, ATE0, ATL0, ATS0, ATH1, ATSP0/6, ATCAF0)
- [ ] Basic Mode 01 polling
- [ ] DTC read + decode
- [ ] Clear codes
- [ ] Mode 22 trans temp scan
- [ ] Store working trans temp method for normal polling
- [ ] Thread-safe stop/restart

---

## 12) Helpful Debug Commands

- `ATI`  (adapter ID)
- `ATRV` (battery voltage)
- `ATDP` (current protocol)
- `ATSP0` (auto protocol)
- `ATSP6` (force CAN 29/500)
- `ATSHxxxx` (set header)
- `ATCAF0` (CAN auto formatting off)
- `ATDPN` (protocol number)
- `ATIGN` (ignition sense, if supported by adapter)

---

## 13) Notes about ProMaster specifics

- Expect 29-bit traffic for module-specific requests
- Transmission temperature may be under TCM module addressing
- We will validate by:
  - scanning candidates
  - ensuring temperature responds plausibly and changes with driving

---

## 14) Future Extensions

- Add support for:
  - O2 sensors
  - fuel trims
  - engine load
  - intake temp
  - boost (if turbo in future)
- Add UDS Mode 19 (if Mode 03 is incomplete)
- Add freeze frame (Mode 02 or UDS equivalents)

---

End of document.