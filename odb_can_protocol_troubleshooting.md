# OBD CAN-Protocol Troubleshooting Runbook

**Vehicle:** 2014 Ram ProMaster (gas), 62TE transmission
**Symptom class:** gauges show `NO DATA` — especially transmission temp — on some or all
BLE OBD adapters, even though the same adapters/vehicle worked before.

This document exists because we lost a lot of time re-debugging this twice. If trans temp
(or everything) goes to `NO DATA` again, **read this first.**

---

## TL;DR — the one thing to remember

> This van's ELM327 adapters auto-negotiate **29-bit CAN (`ATSP7`)**, not 11-bit.
> In 29-bit mode, **11-bit headers (`7E0`, `7DF`) are invalid.** Trans temp must be read
> with the **29-bit** header `18DA10F1` (DID `B010`), and every header *reset* must go back
> to the **29-bit functional broadcast `18DB33F1`** — never `7DF`.
>
> If a stale **11-bit** trans candidate (`PCM 11-bit B010`, header `7E0`) is saved, trans
> reads `NO DATA` on all adapters, **and** the `7E0/7DF` header it leaves behind poisons
> cheap clones (e.g. **V020**) so that *coolant and fuel trims also die.*
>
> **Fix / recovery:** make sure the saved trans candidate is **`PCM 29-bit B010`
> (`18DA10F1`)**. Clearing storage and letting the app auto-scan will now pick the correct
> one automatically.

---

## What "working" looks like (reference log, 2026-07-01)

All three adapters (VLinker MS, V020, generic "OBDII") after the fix:

```
OBD: Protocol locked = ATSP7
Trans: Loaded saved candidate "PCM 29-bit B010" (header=18DA10F1, DID=B010)
OBD: Trans raw: "62B01014D4"      → bytes=[0x14 0xD4] → Trans = 83.3°F
OBD: Coolant raw: "410564"        → 140.0°F
OBD: stftBank1Pct bytes=[0x7C]    → -3.1
```

- `62 B010 14D4` = Mode 22 positive response (`62`) + DID echo (`B010`) + 2 data bytes
  (`14D4`), parsed by `transTempToF(..., twoByteMode=true)`.
- Cheap clones may log `4-byte ATSH rejected — switching to ATCP + 3-byte split form` and
  still work — that's `sendAtsh()` handling clones that can't take a full 4-byte `ATSH`.

---

## Root cause (why it breaks)

1. **The adapters lock 29-bit CAN.** `initializeAdapter()` uses `ATSP0` (auto). On this van
   the ELM negotiates **protocol 7** (ISO 15765-4, 29-bit, 500 kbaud) and reports it via
   `ATDPN`. You will see `OBD: Protocol locked = ATSP7`. (This has been true across all our
   June/July builds and all three adapters — it is *not* adapter-specific.)

2. **Standard Mode 01 works on the 29-bit broadcast.** Coolant/RPM/fuel trims come back
   with the adapter's default 29-bit header (`18DB33F1`), no `ATSH` needed. That's why those
   gauges can work while trans is dead.

3. **Trans temp needs a width-matched header.** Mode 22 `B010` must be addressed with the
   **29-bit** header `18DA10F1`. The **11-bit** header `7E0` is invalid in 29-bit mode →
   `NO DATA`.

4. **The poison.** If trans runs with an 11-bit header (or "resets" to the 11-bit broadcast
   `7DF`) while the bus is 29-bit, tolerant adapters (VLinker) shrug it off, but **fragile
   clones (V020) stop answering every PID** for the rest of the session. That's how one bad
   trans candidate turned into "all gauges NO DATA" on the generics.

**How the wrong candidate gets saved:** the scan used to try 11-bit candidates first and
could save a false-positive 11-bit entry (`PCM 11-bit B010`) that then fails at poll time.

---

## The fix (what's in the code now)

All in `mobile/src/services/`:

### `obdService.ts`
- **`broadcastHeader()`** — returns the *protocol-correct* functional broadcast:
  `7DF` on 11-bit (protocol 6/8), **`18DB33F1` on 29-bit (protocol 7/9)**. Every header
  reset goes through it, so a reset can never pin a wrong-width header.
- **`pollTransTemp()`** —
  - If the saved candidate's CAN width doesn't match the locked protocol, **auto-switch to
    the same DID at the correct width** (e.g. saved `7E0/B010` → use `18DA10F1/B010`) instead
    of failing. Falls back to skip + "re-run SCAN TRANS TEMP" only if no sibling exists.
  - Reset runs **unconditionally** through `broadcastHeader()` — after a 29-bit trans poll
    the header must return to `18DB33F1`, or the next coolant/fuel-trim poll dies.
- **`pollMode22Pid()` (oil)** — same width guard + protocol-aware reset.
- `pollCoolant` / `pollMode01Pid` / `readDTCsNow` resets routed through `broadcastHeader()`.

### `transTempCandidates.ts`
- **`scanCandidates()` filters by protocol width** — in 29-bit mode it only tries the 29-bit
  candidates, so the scan saves the correct `PCM 29-bit B010` and can't save a false-positive
  11-bit one. (This is what made the VLinker auto-scan land on the right candidate.)

> **Do NOT** re-add a blanket `if (is11BitProtocol()) … else skip` around the trans/oil
> resets, and do **not** reset to a hardcoded `ATSH7DF`. That is exactly the regression that
> poisoned V020. Resets must be unconditional **and** go through `broadcastHeader()`.

---

## Diagnosing a recurrence (log checklist)

1. `OBD: Protocol locked = ATSP?` → expect **`ATSP7`** (29-bit). If `ATSP6`/`ATSP8` the van
   negotiated 11-bit and 11-bit candidates apply instead — the code now adapts either way.
2. `Trans: Loaded saved candidate "..."` → the header must match the protocol width:
   - 29-bit protocol → header must be **`18DA10F1`** (`PCM 29-bit B010`).
   - An `11-bit` candidate (`7E0`) under `ATSP7` is the classic failure.
3. `OBD: Trans raw:` should be `62B010XXXX`, not `NO DATA`.
4. If coolant/fuel trims are also `NO DATA` on a generic clone → suspect a wrong-width `ATSH`
   leaking (the poison). Confirm the trans candidate is 29-bit.

## Recovery steps if it regresses

1. **Clear the saved trans candidate** (BLE screen → clear/re-scan, or wipe app storage) and
   reconnect. The auto-scan now saves `PCM 29-bit B010`.
2. Re-run **SCAN TRANS TEMP** if needed. Confirm the log shows
   `Trans: Saved candidate "PCM 29-bit B010"`.
3. Verify on the **fragile clone (V020)** specifically — it's the canary: if V020 shows
   coolant + trans, the header handling is correct.

---

## Reference facts

**ELM327 CAN protocol numbers (`ATSP`):**

| # | Protocol | Width | Broadcast header | ECU/physical |
|---|----------|-------|------------------|--------------|
| 6 | ISO 15765-4 CAN 500k | 11-bit | `7DF` | `7E0` (ECM) |
| 7 | ISO 15765-4 CAN 500k | **29-bit** | **`18DB33F1`** | **`18DA10F1`** (module 0x10) |
| 8 | ISO 15765-4 CAN 250k | 11-bit | `7DF` | `7E0` |
| 9 | ISO 15765-4 CAN 250k | 29-bit | `18DB33F1` | `18DAxxF1` |

`is11BitProtocol()` = protocol `6` or `8`. Everything else is treated as 29-bit.

**Trans temp candidate mapping (DID `B010`, 2-byte, 62TE):**

| Protocol | Candidate name | Header |
|----------|----------------|--------|
| 11-bit | `PCM 11-bit B010` | `7E0` |
| **29-bit (this van)** | **`PCM 29-bit B010`** | **`18DA10F1`** ✅ confirmed |

**Confirmed working values (idle, warm):** Trans ≈ 83–87 °F, Coolant ramping to ~180 °F,
fuel trims small negative — all three adapters, 2026-07-01.

---

## History

- **2026-07-01** — Regression: an 11-bit trans candidate was saved while adapters were on
  `ATSP7`; trans died on all three adapters and *all* gauges died on the V020 clone (an
  11-bit `ATSH7DF` reset poisoned it). Fixed by making header resets protocol-aware
  (`18DB33F1` in 29-bit), filtering the scan by protocol width, and auto-substituting the
  width-matched trans candidate. Verified on VLinker MS, V020, and generic "OBDII".
