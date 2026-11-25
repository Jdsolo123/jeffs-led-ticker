# Hardware Build Renders

AI-generated concept renders for the physical 5-panel build (2026-08-19).
**These are concept art, not photographs of a real build.** Read the deviations below.

| File | What it shows |
|---|---|
| `ticker-front-hero.png` | Front view, true 10:1 proportion, maize/navy bezel with MICHIGAN embossed |
| `ticker-rear-wiring-reference.png` | **Rear wiring layout — the useful one.** Panel chain + star-wired power |
| `ticker-in-room.png` | In-context dorm room shot |

## Confirmed specs

| Spec | Value |
|---|---|
| Panels | 5 x Waveshare P4 HUB75 64x32 |
| Resolution | 320 x 32 px (`CHAIN = 5` in `pi/config.py`) |
| Active area | 50.4" x 5.04" (1280 x 128 mm) |
| Backer | 1x8 pine board, 7.25" wide x ~53" |
| Bezel | 3D printed PETG, maize + navy, MICHIGAN embossed |
| Controller | Raspberry Pi 4 Model B 2GB |
| Adapter | Adafruit RGB Matrix Bonnet #3211 (`HW_MAPPING = 'adafruit-hat'`) |
| PSU | 5V 30A 150W open frame (20A load at 4A/panel) |
| Mount | French cleat |

## Wiring rules the rear render gets right

- Panels chain OUT -> IN with short ribbon cables, left to right.
- **Power is star-wired.** Separate red/black pair from the PSU terminals to EACH
  panel. Never daisy-chain panel power - the far end browns out.
- Do NOT run panel current through the Bonnet. The Bonnet gets its own thin
  5V feed for the Pi and logic only.
- PSU sits center-board to minimize average wire run.
- Check polarity with a multimeter before first power-up. Waveshare prints this
  warning on their own listing; reversed polarity kills a panel instantly.

## Where the renders deviate from reality

- **Panel gaps.** Real panels butt edge-to-edge into a continuous display. The
  rear render spaces them so the wiring reads clearly.
- **Wood tone.** Renders show stained walnut; spec is raw pine. Cosmetic.
- **Font.** AI cannot render true bitmap glyphs. Real output uses PressStart2P
  and `font5x7.js` and will be blockier and more pixelated than shown.
- **Ticker content is invented.** "NYSE: $UMICH" in the room shot is not a real
  symbol.

## Config changes when hardware lands

```python
# pi/config.py
CHAIN = 5      # was 6; TOTAL_WIDTH computes to 320
FPS = 30       # was 20; Pi 4 handles it
```

Optional: solder a jumper between pins 4 and 18 on the Bonnet, then set
`HW_MAPPING = 'adafruit-hat-pwm'` for better brightness and less flicker.
