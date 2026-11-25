ROWS = 32
COLS = 64
CHAIN = 6          # STALE: hardware ordered 2026-08-19 is 5 panels. Flip to
                   # CHAIN = 5 (FPS -> 30) once panels physically arrive and
                   # are measured — see BOM.md. Don't flip early.
PARALLEL = 1
HW_MAPPING = 'adafruit-hat'
GPIO_SLOWDOWN = 2
TOTAL_WIDTH = COLS * CHAIN   # 384px for 6 panels, 256px for 4 panels
SCROLL_SPEED_PPS = 50
FPS = 20           # 20fps on Pi Zero WH, 30fps on Pi Zero 2W
UPDATE_SECS = 30
# Betting odds are off by default — leave blank and data_fetcher skips them.
# A free-tier key from the-odds-api.com turns the odds line back on.
ODDS_API_KEY = ''
SPORTS = [
    ('football/nfl',   'americanfootball_nfl', 'NFL'),
    ('basketball/nba', 'basketball_nba',       'NBA'),
    ('baseball/mlb',   'baseball_mlb',         'MLB'),
    ('hockey/nhl',     'icehockey_nhl',        'NHL'),
]
LOGO_SIZE = 28
DIVIDER_W = 14
FONT_DIR = '/home/pi/rpi-rgb-led-matrix/fonts'
