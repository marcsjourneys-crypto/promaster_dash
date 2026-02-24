# ProMaster Adventure Dash
Raspberry Pi 5 Vehicle Dashboard System  
Vehicle: 2014 Ram ProMaster (Gas, 62TE Transmission)

---

# 1️⃣ PROJECT PURPOSE

Build a rugged, overland-style touchscreen dashboard system that runs fullscreen on a 7" 1024x600 display inside a van.

The system integrates:

- OBD2 vehicle data (USB Vgate vLinker STN adapter)
- GPS data (u-blox NEO-6M via gpsd)
- Trip logging
- Diagnostics
- Alerting
- Future cloud sync (Starlink)

The UI aesthetic is:

- Industrial / adventure
- Matte dark bronze
- Amber highlights
- Segmented bar indicators
- High contrast for sunlight
- Night mode for low glare

---

# 2️⃣ HARDWARE STACK

- Raspberry Pi 5
- 7" HDMI Touchscreen (1024x600)
- Vgate vLinker USB OBD2 adapter (STN chip)
- u-blox NEO-6M GPS module (UART)
- UPS HAT (safe shutdown from 12V vehicle power)
- Future: Starlink internet

---

# 3️⃣ SOFTWARE STACK

- Python 3.12
- PySide6 (Qt UI)
- pyserial (OBD)
- gpsd-py3 (GPS)
- SQLite (trip logging)
- Runs fullscreen on Linux (Raspberry Pi OS)

---

# 4️⃣ PROJECT STRUCTURE

src/promaster_dash/
- main.py
- ui/
    - app.py
- services/
    - obd_service.py (planned)
    - gps_service.py (planned)
    - logging_service.py (planned)
- models/
    - vehicle_state.py (planned)
- diagnostics/
    - dtc_lookup.py (planned)

assets/backgrounds/
scripts/
requirements.txt

---

# 5️⃣ CURRENT UI STATE

Fullscreen 1024x600 layout:

TOP BAR:
- Trip timer
- Heading (cardinal + degrees)
- Elevation
- GPS status
- MIL indicator
- Night toggle

ALERT BANNER:
- Displays warnings/critical alerts
- Clickable → opens alert history

MAIN CARDS:
- TRANS TEMP
- COOLANT
- VOLTAGE
Each:
- Rugged panel style
- Large numeric display
- 14-segment bar
- Threshold coloring
- Status labels (CAUTION / DANGER / LOW)

BOTTOM BAR:
- SPEED (GPS primary)
- RPM
- SCAN CODES button

Mock mode simulates realistic values.

---

# 6️⃣ CENTRAL DATA MODEL

VehicleState (single source of truth):

Fields:
- trans_f
- coolant_f
- voltage_v
- speed_mph
- rpm
- dtc_count
- gps_ok
- heading_deg
- elevation_ft
- trip_start_ts

UI must never directly query hardware.
All updates come via services updating VehicleState via Qt signals.

---

# 7️⃣ THREADING ARCHITECTURE

CRITICAL RULE:
UI must NEVER block.

Services run in worker threads using QThread.

Architecture pattern:

MainWindow
  |
  |--- OBDService (QThread)
  |--- GPSService (QThread)
  |--- LoggingService (QThread)

Each service:
- Polls hardware
- Emits signals with structured data
- Does not touch UI directly

Signals example:

OBDService:
- transTempUpdated(float)
- coolantUpdated(float)
- rpmUpdated(int)
- speedUpdated(float)
- dtcListUpdated(list[str])
- voltageUpdated(float)

GPSService:
- gpsUpdated(speed, heading, elevation, fix_ok)

MainWindow connects signals → updates VehicleState → triggers UI refresh.

---

# 8️⃣ OBD SERVICE SPECIFICATION

File: services/obd_service.py

Responsibilities:
- Open serial connection
- Initialize STN adapter
- Set CAN 29-bit protocol
- Poll at 5–10 Hz max
- Graceful reconnect handling

Must support:

Mode 22:
- Transmission temperature (62TE specific DIDs)

Mode 01:
- PID 05 (coolant)
- PID 0C (RPM)
- PID 0D (vehicle speed backup)

Mode 03:
- Read DTCs

Mode 04:
- Clear DTCs (confirmation required)

ATRV:
- Battery voltage

Must:
- Validate responses
- Handle NO DATA / ERROR
- Recover from disconnect

Never block UI thread.

---

# 9️⃣ GPS SERVICE SPECIFICATION

File: services/gps_service.py

Uses gpsd.

Responsibilities:
- Poll GPS at 1 Hz
- Provide:
    - Speed (mph)
    - Heading (degrees)
    - Elevation (ft)
    - Fix status

GPS speed is PRIMARY source.
OBD speed is fallback.

Must handle:
- No fix
- Partial fix
- gpsd restart

---

# 🔟 DIAGNOSTICS SCREEN

Separate view.

Features:
- List active DTCs
- Show code + short description
- Highlight severity
- Clear Codes button
    - Long press confirm
    - Require engine not running (future safety)

Future:
- Freeze frame
- Historical DTC log

---

# 1️⃣1️⃣ LOGGING SERVICE

File: services/logging_service.py

SQLite database:

Tables:
trip_log:
- timestamp
- lat
- lon
- speed
- trans_temp
- coolant_temp
- voltage

alerts:
- timestamp
- severity
- message

Should:
- Log every 2–5 seconds
- Log when alert changes
- Allow CSV export

---

# 1️⃣2️⃣ ALERT SYSTEM

Priority:

1. DTC present
2. Critical temps
3. Warning temps
4. Voltage abnormal

Alert banner:
- Must not flicker
- Must log changes
- Clickable → alert history

---

# 1️⃣3️⃣ PERFORMANCE CONSTRAINTS

- Must run reliably on Raspberry Pi 5
- CPU usage low
- Avoid heavy animations
- Avoid continuous repaints
- Avoid blocking I/O
- Keep memory footprint low

---

# 1️⃣4️⃣ FUTURE FEATURES

Short Term:
- Full OBD integration
- Full GPS integration
- Diagnostics screen
- Trip logging

Mid Term:
- Trip stats (max temp, avg speed, distance)
- Engine hours
- Maintenance tracker
- Config screen

Long Term (Starlink enabled):
- Cloud sync
- Remote dashboard
- OTA updates
- Weather overlay
- Live map overlay

Advanced UI:
- Analog-style gauges
- Needle animations
- Configurable layout
- Gesture support
- Auto dimming
- Ambient light sensor integration

---

# 1️⃣5️⃣ CODING RULES

- Modular structure
- No UI blocking
- Clear separation of UI and services
- Use Qt signals properly
- Provide full file implementations when requested
- Write production-grade Python
- Comment critical logic
- Keep layout 1024x600 fixed

---

# 1️⃣6️⃣ DESIGN PHILOSOPHY

The system should feel:

- OEM quality
- Rugged
- Intentional
- Not flashy
- Highly readable
- Purpose-built for overland driving

If suggesting UI changes:
- Prioritize clarity over complexity
- Favor subtle design over bright graphics
- Keep touch ergonomics in mind

---

You are assisting in developing a real in-vehicle dashboard system.
Write clean, robust, production-level code.