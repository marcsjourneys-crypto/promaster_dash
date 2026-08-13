> **SUPERSEDED 2026-08-12** — this content now lives in the Obsidian vault:
> **ProMaster / Pi Power & Shutdown (09 Archive)**.
> Kept for history. Edit the vault note, not this file.

---

# Power System & Soft Shutdown Design
ProMaster Adventure Dash  
Raspberry Pi 5 + UPS HAT + Vehicle 12V System

Vehicle: 2014 Ram ProMaster  
Power Source: 12V automotive (engine running 13.5–14.4V)

---

# 1️⃣ OBJECTIVES

The power system must:

- Power Raspberry Pi 5 reliably from vehicle 12V
- Protect against voltage spikes and crank dips
- Prevent SD card corruption
- Gracefully shut down when ignition turns off
- Survive automotive noise
- Auto boot when ignition turns on
- Handle short crank voltage drops without rebooting

---

# 2️⃣ HIGH LEVEL ARCHITECTURE

Vehicle 12V (Ignition-switched or Always-on)
        |
        v
    DC Buck Converter (12V → 5V 5A+)
        |
        v
   UPS HAT (battery-backed 5V rail)
        |
        v
   Raspberry Pi 5 (USB-C or 5V GPIO input)

Optional:
- Inline fuse (HIGHLY recommended)
- TVS diode or automotive surge protection module

---

# 3️⃣ POWER SOURCING OPTIONS

You have two main strategies:

## Option A – Ignition Switched 12V (Recommended)

Use a fuse tap from:
- Radio fuse
- ACC circuit
- Cigarette lighter circuit (if switched)

Behavior:
- Ignition ON → Pi boots
- Ignition OFF → UPS triggers graceful shutdown

This is ideal for a dashboard device.

## Option B – Always-On 12V

Use constant 12V:
- Requires voltage sensing to detect ignition
- More complex
- Risk of draining starter battery

Not recommended unless needed.

---

# 4️⃣ REQUIRED HARDWARE

Minimum:

- Automotive fuse tap (Add-A-Circuit)
- 3A–5A fuse for Pi circuit
- 12V → 5V buck converter (rated 5A+)
- UPS HAT compatible with Pi 5
- 18650 battery (if UPS requires)
- 18–20 AWG wiring

Recommended:

- Automotive-rated buck converter
- TVS diode (transient suppression)
- Inline fuse near tap
- Ferrite bead or noise filter

---

# 5️⃣ WHY A UPS HAT IS REQUIRED

Automotive power is dirty.

Events:
- Engine crank → voltage drops to 9V briefly
- Alternator spikes
- Load dumps
- Ignition off abrupt cutoff

Without UPS:
- Pi loses power instantly
- SD card corruption risk
- OS filesystem damage

With UPS:
- Pi receives shutdown signal
- Pi executes `sudo shutdown now`
- UPS cuts power only after safe halt

This is critical.

---

# 6️⃣ WIRING DIAGRAM (TEXT VERSION)

FUSE TAP (ACC)
   |
   |--- 5A fuse
   |
   +----> Buck Converter IN+
   |
Vehicle Ground --------------> Buck Converter IN-

Buck Converter OUT+ (5V) ----> UPS HAT 5V IN
Buck Converter OUT- ---------> UPS GND

UPS HAT → Raspberry Pi via header

DO NOT power Pi directly and UPS at same time via separate sources.

---

# 7️⃣ SOFT SHUTDOWN LOGIC

UPS HAT behavior (typical Geekworm style):

When 12V input disappears:
- UPS battery supplies Pi
- UPS pulls GPIO pin low (or high depending config)
- Pi detects signal
- Pi executes shutdown
- UPS waits N seconds
- UPS cuts power fully

You must:

1) Install UPS driver script
2) Configure GPIO shutdown pin
3) Enable shutdown daemon/service

---

# 8️⃣ RASPBERRY PI CONFIGURATION

On Pi:

## 8.1 Enable Safe Shutdown Script

Typical Geekworm instructions:

Install script:


Or manually configure:

Monitor GPIO pin via Python daemon:
- Detect falling edge
- Run `sudo shutdown -h now`

Add to `/boot/firmware/config.txt` if needed:


(Pin number depends on UPS board.)

## 8.2 Test Shutdown

- Boot Pi
- Pull 12V input
- Confirm:
  - UPS LED indicates battery mode
  - Pi begins shutdown
  - System fully halts
  - UPS cuts 5V after delay

---

# 9️⃣ ENGINE CRANK PROTECTION

During crank:
- Voltage may drop below 10V briefly

UPS should:
- Seamlessly switch to battery
- Prevent reboot

If Pi reboots during crank:
- Buck converter insufficient
- UPS battery weak
- Wiring too thin
- Need higher current buck

---

# 🔟 POWER BUDGET

Pi 5 typical draw:
- Idle: 700–900mA
- With screen: 1.2–1.8A
- Under load: up to 3A+

Use:
- 5V 5A buck converter minimum
- Good quality wiring

---

# 1️⃣1️⃣ AUTO BOOT CONFIG

Ensure Pi auto boots when powered:

In `/boot/firmware/config.txt`:


Disable login prompt if using kiosk mode.

---

# 1️⃣2️⃣ KIOSK MODE (Auto Launch Dash)

Create systemd service:

`/etc/systemd/system/promaster_dash.service`

Example:
[Unit]
Description=ProMaster Dash
After=network.target

[Service]
User=pi
Environment=PYTHONPATH=/home/pi/promaster_dash/src
ExecStart=/home/pi/promaster_dash/.venv/bin/python -m promaster_dash.main --fullscreen
Restart=always

[Install]
WantedBy=multi-user.target


Enable:

sudo systemctl enable promaster_dash.service


Now:
Ignition ON → Pi boots → Dash launches fullscreen  
Ignition OFF → Soft shutdown → Power cut

OEM behavior achieved.

---

# 1️⃣3️⃣ SAFETY NOTES

- Always fuse near power tap
- Do not rely on cigarette lighter for permanent install unless verified switched
- Keep grounds solid
- Use heat shrink + proper crimps
- Secure wiring behind dash
- Avoid routing near airbag wiring

---

# 1️⃣4️⃣ OPTIONAL ADVANCED FEATURES

Future improvements:

- Read ignition state via GPIO
- Read battery voltage directly via ADC
- Monitor shutdown events in software
- Detect improper shutdowns
- Display “Shutting down…” splash screen

---

# 1️⃣5️⃣ TEST PLAN

Before permanent install:

Bench Test:
- Power with 12V supply
- Cut power abruptly
- Confirm graceful shutdown
- Confirm auto reboot on restore

Vehicle Test:
- Start engine
- Watch for reboot during crank
- Turn ignition off
- Confirm graceful shutdown

---

# 1️⃣6️⃣ SUMMARY

Correct architecture:

Ignition-switched 12V  
→ Fused tap  
→ 5V 5A buck converter  
→ UPS HAT  
→ Raspberry Pi 5  
→ systemd auto-launch dash  

This ensures:
- No SD corruption
- No surprise reboots
- OEM-style operation
- Reliable in automotive environment

---

End of document.