# Bill of Materials

Hardware ordered 2026-08-19 for the physical 5-panel build. This is the
current source of truth for parts — `README.md` and `pi/config.py` describe
the code/renderer, this file describes what's actually being bolted together.

## Ordered

| Source | Contents | Total |
|---|---|---|
| Amazon (#112-0082694-5533049) | 5x Waveshare P4 HUB75 64x32 RGB panel, 5V 30A (150W) open-frame PSU, 32GB microSD, 18AWG DC pigtails, M3 standoff kit, 3x screw packs | $238.99 |
| Adafruit | RGB Matrix Bonnet #3211, Raspberry Pi 4 Model B 2GB, aluminum heat sink | $80.15 |

Amazon order arriving Saturday 2026-08-23.

## Confirmed specs

| Spec | Value |
|---|---|
| Panels | 5x Waveshare P4 HUB75 64x32 |
| Resolution | 320 x 32 px (`CHAIN = 5` in `pi/config.py`, pending — see below) |
| Active area | 50.4" x 5.04" (1280 x 128 mm) |
| Controller | Raspberry Pi 4 Model B 2GB |
| Adapter | Adafruit RGB Matrix Bonnet #3211 (`HW_MAPPING = 'adafruit-hat'`) |
| PSU | 5V 30A 150W open frame (20A load at 4A/panel, star-wired) |
| Backer | 1x8 pine board, 7.25" wide x ~53" (not yet bought) |
| Bezel | 3D printed PETG, maize + navy, MICHIGAN embossed (not yet printed) |
| Mount | French cleat |

## Not yet in code

`pi/config.py` still reads `CHAIN = 6` / `FPS = 20` (the original Pi Zero WH /
6-panel plan). Per the 2026-08-19 decision, this flips to `CHAIN = 5` /
`FPS = 30` **once hardware physically lands** — not before, since the code
was never re-verified against the actual arrived panels. Don't flip it early.

Optional once running: solder a jumper between Bonnet pins 4 and 18, then
switch `HW_MAPPING` to `'adafruit-hat-pwm'` for better brightness/less flicker.

## What changed from the original plan, and why

An auto-generated BOM (Blueprint.am, `led_sports_ticker_PARTS.csv`) was
audited against vendor specs and the repo's actual code before ordering. Four
errors were caught:

1. **PSU undersized.** BOM specced 5V 10A; a 6-panel chain draws 24A at 4A/panel
   (Waveshare requires a standalone supply per panel when chained). Replaced
   with 5V 30A 150W.
2. **Wrong adapter board.** BOM pointed at a generic 5V/8A HUB75 board with a
   non-Adafruit pinout, but `pi/config.py` hardcodes `HW_MAPPING =
   'adafruit-hat'`. Replaced with the real Adafruit RGB Matrix Bonnet #3211.
3. **Raspberry Pi Zero WH too weak.** `hzeller/rpi-rgb-led-matrix` (the library
   `pi/ticker.py` imports) and ChuckBuilds both call the Zero underpowered for
   this, compounded by `disable_hardware_pulsing = True` in `ticker.py` forcing
   CPU-bound software PWM. Upgraded to Pi 4 Model B 2GB.
4. **No microSD card in the original BOM.** Added a 32GB card.

Also dropped 6 redundant panel-mount barrel jacks (each Waveshare panel ships
with its own power cable/jack) and added 18AWG DC pigtails for the PSU-to-Bonnet
connection, which was the actual missing connector.

Panel count was separately cut from 6 to 5 (384px -> 320px) — logged as a
2026-08-19 decision in the second brain (Notion): a dorm desk is 48" wide,
50.4" (5 panels) sits over it properly where 60.5" (6 panels) overhangs; also
saves $30 and drops power draw from 24A to 20A.

## Do not

- Cut the pine backer or print the bezel until panels arrive and the
  assembled 5-panel array is physically measured — panel width tolerance
  accumulates across 5 butted panels.
- Daisy-chain panel power. Power is star-wired: separate red/black pair from
  the PSU straight to each panel. The Bonnet gets its own thin 5V feed for
  logic only, never panel current.
