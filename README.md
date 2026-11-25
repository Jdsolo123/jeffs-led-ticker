# Jeff's Ticker

A 320x32 LED-matrix sports and market ticker, rendered pixel-exact in the
browser and pinned to the bottom of your screen as a desktop bar.

Live scores, stock quotes, weather, headlines, F1 standings and Twitch status
scroll across a simulated 5-panel RGB matrix — the same layout that drives the
physical Raspberry Pi build, so what you see on screen is what the hardware
shows.

## Credit

The original concept and the LED matrix design this project started from are
**Chuck's** — [ChuckBuilds/LEDMatrix](https://github.com/ChuckBuilds/LEDMatrix).
That project is what got me building this in the first place. Everything here
was rewritten from the ground up (browser canvas renderer, Python data server,
Electron desktop shell, settings UI), but the idea and the visual language came
from Chuck's work. Go look at it.

## What it shows

| Source | Data | Key needed |
|---|---|---|
| ESPN | Live + upcoming scores: NFL, NBA, MLB, NHL, WNBA, NCAAF, NCAAB, MLS, EPL | none |
| Jolpica-F1 | Current F1 driver standings | none |
| Open-Meteo | Weather + forecast for any city | none |
| RSS | Headlines, per-category toggles | none |
| Finnhub | Stock + crypto quotes | free tier |
| Twitch | Whether your channels are live | free app |
| Spotify | Now playing | free app |

Everything is optional. Missing a key just turns that card off.

## Setup

Requires Python 3.9+ and [Node](https://nodejs.org) (only for the desktop widget).

```bash
git clone https://github.com/<you>/jeffs-ticker.git
cd jeffs-ticker
pip install requests
cp keys.example.py keys.py
```

Open `keys.py` and paste in whatever keys you want. All of them can be left
blank — scores, weather, news and F1 need no key at all.

### Run it in a browser

```bash
python server.py
```

Then open http://localhost:8491.

### Run it as a desktop bar

```bash
cd widget
npm install
npm start
```

The Electron shell starts `server.py` itself and docks a frameless always-on-top
bar to the bottom edge of your primary display. It lives in the system tray:
show/hide, scroll speed, settings, and start-with-Windows.

On Windows you can double-click `widget/Jeffs Ticker.vbs` to launch it with no
console window, and pin that to your Desktop or Start menu.

## Settings

Tray icon → **Settings**, or http://localhost:8491/settings.html while the
server is running. Pick your leagues and favorite teams, stock symbols, weather
location, news categories, and which cards appear at all.

Settings are written to your local app-data directory, not into the repo, so
pulling updates never clobbers them.

## Layout

```
server.py           Python data server + static host (port 8491)
index.html          The ticker page
render.js           Canvas renderer — every card layout lives here
app.js              Scroll loop, input, card sequencing
data.js             Fetch + cache layer talking to server.py
settings.html/.js   Settings UI
font5x7.js          Bitmap font for the matrix
assets/  fonts/     Card art and font files
keys.example.py     Template for your API keys
widget/             Electron desktop-bar shell
```

## Hardware

The renderer targets a 5-panel chain of Waveshare 64x32 HUB75 RGB LED panels
(320x32) driven by a Raspberry Pi 4 Model B 2GB with the Adafruit RGB Matrix
Bonnet #3211, using
[rpi-rgb-led-matrix](https://github.com/hzeller/rpi-rgb-led-matrix). The browser
version is a pixel-exact preview of that, so you can build and tune the whole
thing before any hardware shows up. Full parts list and order history: [BOM.md](BOM.md).

## License

MIT.
