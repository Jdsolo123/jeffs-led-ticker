"""Jeff's Ticker server — serves the static front-end plus the key-guarded
live data proxies (stocks, logos, weather, news, Spotify) that the browser
cannot call directly because of CORS or because they need a secret.

Secrets live in keys.py next to this file. keys.py is gitignored; copy
keys.example.py to keys.py and fill in your own free-tier keys. Betting odds
(the only paid source this project ever had) were removed 2026-08-10;
nothing here costs money now.

Run: python server.py  (port 8491)
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import keys    # FINNHUB_KEY, TWITCH_*, SPOTIFY_* — see keys.example.py
except ImportError:
    sys.exit(
        'keys.py not found.\n'
        'Copy keys.example.py to keys.py and fill in your own API keys.\n'
        'Every key is optional — features whose key is missing just stay off.'
    )

PORT = 8491
STATIC = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
    '/data.js': ('data.js', 'application/javascript; charset=utf-8'),
    '/render.js': ('render.js', 'application/javascript; charset=utf-8'),
    '/font5x7.js': ('font5x7.js', 'application/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
    '/settings.html': ('settings.html', 'text/html; charset=utf-8'),
    '/settings.js': ('settings.js', 'application/javascript; charset=utf-8'),
}

# --------------------------------------------------------------------------
# Settings (2026-07-21): which sports show on the tape + favorite team(s) per
# sport, set from the tray's Settings window (settings.html) and read by
# data.js every fetchScores cycle. Missing keys default to "sport enabled" so
# a stale/missing file never silently hides a sport that used to show.
#
# MOVED OUT OF THE VAULT 2026-08-10. This lived next to the source as
# HERE/settings.json, which is inside the OneDrive-synced Obsidian vault, and
# on 2026-08-10 it was silently rewritten mid-session -- the file's mtime
# jumped and its contents reverted from Jeff's real favourites list to an
# older every-team-favourited state. OneDrive resolving a sync conflict will
# happily overwrite a file the app is actively writing, and settings is the
# one file here that changes from the UI rather than from source control.
# %LOCALAPPDATA% is machine-local and never synced.
#
# The old vault copy is migrated once, on first start, and only when no
# local file exists yet -- so an existing local file always wins and the
# migration can't undo a later change.
def _settings_path():
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    d = os.path.join(base, 'led-ticker')
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        return os.path.join(HERE, 'settings.json')  # fall back to the old spot
    return os.path.join(d, 'settings.json')


SETTINGS_FILE = _settings_path()
LEGACY_SETTINGS_FILE = os.path.join(HERE, 'settings.json')
_settings_lock = threading.Lock()


def _migrate_settings():
    """One-time copy of the vault-resident settings file to the local one."""
    if os.path.exists(SETTINGS_FILE) or SETTINGS_FILE == LEGACY_SETTINGS_FILE:
        return
    try:
        with open(LEGACY_SETTINGS_FILE) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    try:
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(data, f, indent=2)
        print('[settings] migrated %s -> %s' % (LEGACY_SETTINGS_FILE, SETTINGS_FILE))
    except OSError as e:
        print('[settings] migration failed: %s' % e)


def _read_settings():
    with _settings_lock:
        try:
            with open(SETTINGS_FILE) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {'sports': {}, 'favorites': {}}


def _write_settings(data):
    with _settings_lock:
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(data, f, indent=2)


_migrate_settings()


# Team rosters for the settings page's favorite-team button picker (2026-07-22).
# Server-side proxy because ESPN's .../teams endpoint (unlike .../scoreboard,
# which data.js already fetches straight from the browser) sends no CORS
# headers -- confirmed by a direct browser fetch failing with a generic
# "Failed to fetch" while the scoreboard call from the same origin succeeds.
TEAMS_LEAGUES = {
    'NFL': 'football/nfl', 'NBA': 'basketball/nba', 'MLB': 'baseball/mlb',
    'NHL': 'hockey/nhl', 'WNBA': 'basketball/wnba',
    'EPL': 'soccer/eng.1', 'UCL': 'soccer/uefa.champions', 'MLS': 'soccer/usa.1',
    'UFL': 'football/ufl', 'CFL': 'football/cfl',
}
TEAMS_TTL = 24 * 60 * 60  # rosters barely change intra-season
_teams_cache = {}  # league -> (rows, at)


def _fetch_teams(league):
    path = TEAMS_LEAGUES.get(league)
    if not path:
        return []
    try:
        r = requests.get(f'https://site.api.espn.com/apis/site/v2/sports/{path}/teams',
                          params={'limit': 999}, timeout=8)
        r.raise_for_status()
        leagues = (r.json().get('sports') or [{}])[0].get('leagues') or [{}]
        teams = (leagues[0] or {}).get('teams') or []
        # nickname ("Ravens") is separate from the full displayName
        # ("Baltimore Ravens") -- favorites typed into the old free-text box
        # were often nickname-only, so the client needs both to match.
        out = [{'abbr': t['team']['abbreviation'],
                 'name': t['team'].get('displayName') or t['team']['abbreviation'],
                 'nick': t['team'].get('nickname') or t['team'].get('name') or ''}
               for t in teams if (t.get('team') or {}).get('abbreviation')]
        out.sort(key=lambda t: t['name'])
        return out
    except Exception:
        return []


def _teams_for(league):
    hit = _teams_cache.get(league)
    if hit and time.time() - hit[1] < TEAMS_TTL:
        return hit[0]
    data = _fetch_teams(league)
    if data:
        _teams_cache[league] = (data, time.time())
    return data


# Player rosters for the scoring takeover's phase B (2026-08-10, stage 2 of
# [[Scoring Animation Redesign]]): the scorer's surname comes out of ESPN's play
# text, and joining it against the scoring team's own roster turns it into a
# headshot with no new API key.
#
# NOTE the redesign spec says "server.py already caches team rosters for 24h --
# no new API needed." That was WRONG, checked rather than trusted: the 24h cache
# above holds a per-league TEAM LIST (abbr/name/nickname) for the settings
# picker, with no athletes in it at all. This is a genuinely new ESPN endpoint
# (.../teams/<id>/roster). It is still keyless, free and same-host, so the
# "no new API" spirit holds -- but it is a new request, cached per team for 24h.
# Proxied for the same reason /api/teams is: the site.api teams tree sends no
# CORS headers, unlike the scoreboard the browser fetches directly.
ROSTER_LEAGUES = dict(TEAMS_LEAGUES, **{
    'NCAAF': 'football/college-football',
    'NCAAB': 'basketball/mens-college-basketball',
})
ROSTER_TTL = 24 * 60 * 60
_roster_cache = {}  # "LEAGUE|team" -> (rows, at)


def _fetch_roster(league, team):
    path = ROSTER_LEAGUES.get(league)
    if not path or not team:
        return []
    try:
        r = requests.get(
            f'https://site.api.espn.com/apis/site/v2/sports/{path}/teams/{team}/roster',
            timeout=8)
        r.raise_for_status()
        groups = r.json().get('athletes') or []
        # Two shapes in the wild: MLB/NFL group by position ({position, items}),
        # some leagues return a flat athlete list. Handle both rather than
        # assuming -- verified against MLB, NHL and college football.
        flat = []
        for g in groups:
            if isinstance(g, dict) and isinstance(g.get('items'), list):
                flat.extend(g['items'])
            elif isinstance(g, dict):
                flat.append(g)
        out = []
        for a in flat:
            last = (a.get('lastName') or '').strip()
            if not last:
                continue
            out.append({
                'last': last.upper(),
                'full': (a.get('fullName') or a.get('displayName') or last).upper(),
                'jersey': a.get('jersey') or '',
                'pos': ((a.get('position') or {}).get('abbreviation') or ''),
                'headshot': ((a.get('headshot') or {}).get('href') or ''),
            })
        return out
    except Exception:
        return []


def _roster_for(league, team):
    key = f'{league}|{team}'
    hit = _roster_cache.get(key)
    if hit and time.time() - hit[1] < ROSTER_TTL:
        return hit[0]
    data = _fetch_roster(league, team)
    if data:
        _roster_cache[key] = (data, time.time())
    return data


# Location geocoding (2026-07-22): settings.html's location field POSTs a
# typed city name here, resolved via Open-Meteo's free keyless geocoding API
# (same provider fetchWeather() already calls for the forecast itself) so the
# client never needs its own geocoding key/CORS workaround.
def _geocode_city(city):
    r = requests.get('https://geocoding-api.open-meteo.com/v1/search',
                      params={'name': city, 'count': 1}, timeout=8)
    r.raise_for_status()
    results = (r.json() or {}).get('results') or []
    if not results:
        return None
    top = results[0]
    parts = [top.get('name'), top.get('admin1'), top.get('country_code')]
    return {
        'name': ', '.join(p for p in parts if p),
        'lat': top['latitude'], 'lon': top['longitude'],
    }


STOCKS = [
    # symbol, company domain for logo, display color fallback
    # The tape shows a rotating window of ~30 per lap (render.js), so a long
    # list here costs variety-per-lap nothing — it all cycles through.
    # --- big tech / mega caps ---
    ('AAPL', 'apple.com', '#a2aaad'), ('MSFT', 'microsoft.com', '#00a4ef'),
    ('NVDA', 'nvidia.com', '#76b900'), ('GOOGL', 'google.com', '#4285f4'),
    ('AMZN', 'amazon.com', '#ff9900'), ('META', 'meta.com', '#0866ff'),
    ('TSLA', 'tesla.com', '#cc0000'), ('AMD', 'amd.com', '#ed1c24'),
    ('AVGO', 'broadcom.com', '#cc092f'), ('NFLX', 'netflix.com', '#e50914'),
    ('INTC', 'intel.com', '#0068b5'), ('CRM', 'salesforce.com', '#00a1e0'),
    ('ORCL', 'oracle.com', '#f80000'), ('ADBE', 'adobe.com', '#fa0f00'),
    ('QCOM', 'qualcomm.com', '#3253dc'), ('MU', 'micron.com', '#0084c8'),
    ('IBM', 'ibm.com', '#0f62fe'), ('CSCO', 'cisco.com', '#1ba0d7'),
    ('NOW', 'servicenow.com', '#62d84e'), ('SNOW', 'snowflake.com', '#29b5e8'),
    ('SHOP', 'shopify.com', '#96bf48'), ('UBER', 'uber.com', '#e8e8e8'),
    ('ABNB', 'airbnb.com', '#ff5a5f'), ('SPOT', 'spotify.com', '#1db954'),
    ('CRWD', 'crowdstrike.com', '#fc0000'), ('NET', 'cloudflare.com', '#f48120'),
    # --- semis ---
    ('TSM', 'tsmc.com', '#d40000'), ('ASML', 'asml.com', '#0f238c'),
    ('ARM', 'arm.com', '#0091bd'), ('SMCI', 'supermicro.com', '#0a4f9c'),
    ('MRVL', 'marvell.com', '#c8102e'),
    # --- finance / fintech ---
    ('JPM', 'jpmorganchase.com', '#5a6e82'), ('GS', 'goldmansachs.com', '#6b96c3'),
    ('BAC', 'bankofamerica.com', '#e31837'), ('V', 'visa.com', '#1a1f71'),
    ('MA', 'mastercard.com', '#eb001b'), ('AXP', 'americanexpress.com', '#2e77bc'),
    ('PYPL', 'paypal.com', '#00457c'), ('HOOD', 'robinhood.com', '#00c805'),
    ('MSTR', 'microstrategy.com', '#e84e1b'), ('SOFI', 'sofi.com', '#00a8e0'),
    # --- consumer ---
    ('WMT', 'walmart.com', '#0071ce'), ('COST', 'costco.com', '#005daa'),
    ('KO', 'coca-colacompany.com', '#f40009'), ('PEP', 'pepsico.com', '#004b93'),
    ('MCD', 'mcdonalds.com', '#ffc72c'), ('SBUX', 'starbucks.com', '#00704a'),
    ('NKE', 'nike.com', '#e8e8e8'), ('LULU', 'lululemon.com', '#d31334'),
    ('CMG', 'chipotle.com', '#a81612'), ('HD', 'homedepot.com', '#f96302'),
    ('TGT', 'target.com', '#cc0000'), ('DIS', 'disney.com', '#113ccf'),
    ('F', 'ford.com', '#00274e'), ('GM', 'gm.com', '#0170ce'),
    ('RIVN', 'rivian.com', '#efb105'),
    # --- health ---
    ('LLY', 'lilly.com', '#d52b1e'), ('UNH', 'unitedhealthgroup.com', '#0066f5'),
    ('JNJ', 'jnj.com', '#d51900'), ('PFE', 'pfizer.com', '#0093d0'),
    ('NVO', 'novonordisk.com', '#001965'),
    # --- energy / industrial / defense ---
    ('XOM', 'exxonmobil.com', '#fe000c'), ('CVX', 'chevron.com', '#0054a4'),
    ('OXY', 'oxy.com', '#c8102e'), ('BA', 'boeing.com', '#0039a6'),
    ('LMT', 'lockheedmartin.com', '#005288'), ('CAT', 'caterpillar.com', '#ffcd11'),
    ('GE', 'ge.com', '#3874ba'), ('RTX', 'rtx.com', '#cc0000'),
    # --- clean energy (Jeff's focus) ---
    ('ENPH', 'enphase.com', '#f37320'), ('FSLR', 'firstsolar.com', '#ffb500'),
    ('NEE', 'nexteraenergy.com', '#0a7dc2'), ('SEDG', 'solaredge.com', '#ee1c25'),
    ('RUN', 'sunrun.com', '#ffc72c'), ('PLUG', 'plugpower.com', '#00a651'),
    ('BE', 'bloomenergy.com', '#0093d0'), ('GEV', 'gevernova.com', '#00b2a9'),
    ('ICLN', 'ishares.com', '#0f62fe'), ('VST', 'vistracorp.com', '#00b2e3'),
    ('CEG', 'constellationenergy.com', '#78be20'), ('SMR', 'nuscalepower.com', '#00a3e0'),
    ('OKLO', 'oklo.com', '#3dbf7a'), ('TAN', 'invesco.com', '#f5a800'),
    ('NXT', 'nextracker.com', '#ffb500'), ('ARRY', 'arraytechinc.com', '#f26722'),
    # --- indices / popular ---
    ('SPY', 'ssga.com', '#1e56a0'), ('QQQ', 'invesco.com', '#0b2d5c'),
    ('DIA', 'ssga.com', '#c8102e'), ('IWM', 'ishares.com', '#7ab800'),
    ('GLD', 'spdrgoldshares.com', '#c9a227'), ('ARKK', 'ark-funds.com', '#8e5aa8'),
    ('COIN', 'coinbase.com', '#0052ff'), ('PLTR', 'palantir.com', '#6b7280'),
    ('DKNG', 'draftkings.com', '#53d337'), ('GME', 'gamestop.com', '#ee3524'),
    ('CVNA', 'carvana.com', '#00aed9'),
]
STOCKS_TTL = 10 * 60

# Stock index cards (2026-07-22): Dow/S&P/NASDAQ get their own small segment,
# not folded into the stock rotation. Same Yahoo chart endpoint _refresh_stocks
# already uses per-symbol -- index tickers (^DJI etc.) work the same way, so
# this is a separate lightweight fetch (3 symbols, no Finnhub fallback needed)
# rather than a change to that function.
INDICES = [
    ('^DJI', 'DOW', '#4a90d9'),
    ('^GSPC', 'S&P 500', '#50c878'),
    ('^IXIC', 'NASDAQ', '#9b59b6'),
]
INDICES_TTL = 10 * 60
_indices = {'data': None, 'at': 0.0}


def _refresh_indices():
    # Same range/interval as _refresh_stocks()'s per-symbol call (2026-07-22
    # v2) -- Jeff wants these to render exactly like regular stock cards,
    # which need spark-line history, not just a single price+change point.
    out = []
    for sym, label, color in INDICES:
        try:
            c = requests.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}',
                              params={'range': '5d', 'interval': '30m'},
                              headers={'User-Agent': 'Mozilla/5.0'}, timeout=6).json()
            res = c['chart']['result'][0]
            closes = [p for p in res['indicators']['quote'][0]['close'] if p]
            step = max(1, len(closes) // 28)
            spark = closes[::step][-28:]
            meta = res.get('meta') or {}
            price, prev = meta.get('regularMarketPrice'), meta.get('previousClose')
            if price and prev:
                out.append({
                    'sym': sym, 'name': label, 'color': color, 'spark': spark, 'price': price,
                    'change': price - prev, 'changePct': (price / prev - 1.0) * 100.0,
                })
        except Exception:
            pass
    if out:
        _indices['data'] = out
    _indices['at'] = time.time()

_lock = threading.Lock()
_stocks = {'data': None, 'at': 0.0}


def _custom_stock_symbols():
    raw = _read_settings().get('customStocks') or []
    curated = {sym for sym, _domain, _color in STOCKS}
    out = []
    for s in raw:
        sym = str(s).strip().upper()
        if sym and sym not in curated and _TICKER_RE.match(sym) and sym not in out:
            out.append(sym)
    return out


def _refresh_stocks():
    # ONE Yahoo chart call per symbol carries everything: spark closes AND
    # meta.regularMarketPrice / meta.previousClose (verified: previousClose is
    # the prior-day close even at range=5d — chartPreviousClose is the range-
    # relative one, don't use it). Finnhub only backstops symbols Yahoo misses,
    # which keeps us far under its 60-calls/min free ceiling at 90+ tickers.
    # Custom tickers (settings.customStocks) merge in here with no curated
    # domain/color -- _logo()/drawLogoSlot already work from the bare symbol
    # alone (domain is unused by either), so a plain grey fallback is fine.
    all_stocks = STOCKS + [(sym, '', '#888888') for sym in _custom_stock_symbols()]
    out = []
    for sym, domain, color in all_stocks:
        entry = {'sym': sym, 'domain': domain, 'color': color, 'spark': []}
        try:
            c = requests.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}',
                              params={'range': '5d', 'interval': '30m'},
                              headers={'User-Agent': 'Mozilla/5.0'}, timeout=6).json()
            res = c['chart']['result'][0]
            closes = [p for p in res['indicators']['quote'][0]['close'] if p]
            step = max(1, len(closes) // 28)
            entry['spark'] = closes[::step][-28:]
            meta = res.get('meta') or {}
            price, prev = meta.get('regularMarketPrice'), meta.get('previousClose')
            if price and prev:
                entry['price'] = price
                entry['changePct'] = (price / prev - 1.0) * 100.0
        except Exception:
            pass
        if not entry.get('price'):
            try:
                q = requests.get('https://finnhub.io/api/v1/quote',
                                  params={'symbol': sym, 'token': keys.FINNHUB_KEY}, timeout=6).json()
                entry['price'] = q.get('c')
                entry['changePct'] = q.get('dp')
            except Exception:
                entry['price'] = None
        if entry.get('price'):
            out.append(entry)
        time.sleep(0.05)  # politeness spacing; this runs in a background thread
    if out:
        _stocks['data'] = out
    _stocks['at'] = time.time()


_stocks_refreshing = threading.Event()


def _stocks_swr():
    """Stale-while-revalidate for stocks: ~90 tickers take ~30s to refresh, and
    _cached() would block a page request (and the global _lock) for all of it.
    Serve whatever we have and refresh in a daemon thread; only the very first
    request ever (no data at all) blocks."""
    with _lock:
        data = _stocks['data']
        stale = data is None or time.time() - _stocks['at'] > STOCKS_TTL
    if stale and not _stocks_refreshing.is_set():
        _stocks_refreshing.set()

        def run():
            try:
                _refresh_stocks()
            finally:
                _stocks_refreshing.clear()

        threading.Thread(target=run, daemon=True).start()
        # First boot returns [] rather than joining: the client's refresh is a
        # Promise.all, so blocking stocks ~40s would hold games/news/etc.
        # hostage too. It keeps its old (empty) list and picks the full set up
        # on the next 60s cycle.
    return data


# General news — ChuckBuilds' news plugin isn't sports-only, and neither is this.
# RSS is fetched server-side because these feeds send no CORS headers. Keyless.
# AP and Reuters were tried and rejected us (403 / DNS), so they're not here.
# (category, feed url, OUTLET). The outlet rides along with every headline so
# the tape can say where the story came from (2026-08-10 brain dump: "I would
# like news stories to also say what source they're from like BBC CNN").
NEWS_FEEDS = [
    ('WORLD', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'),
    ('US', 'https://feeds.npr.org/1001/rss.xml', 'NPR'),
    ('TOP', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'NYT'),
    ('TECH', 'https://hnrss.org/frontpage', 'HN'),
    ('BIZ', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'BBC'),
    ('SPORTS', 'https://www.espn.com/espn/rss/news', 'ESPN'),
    ('GOOD', 'https://www.goodnewsnetwork.org/feed/', 'GNN'),
]
# Jeff's call (2026-07-17): no war/death/tragedy on a man-cave ticker. Any
# headline matching this never reaches the tape, whatever feed it came from.
GRIM_RE = re.compile(
    r'\b(war|kill(?:s|ed|ing)?|dead(?:ly)?|death(?:s)?|die(?:s|d)?|dying'
    r'|bomb(?:s|ing|ed)?|missile|air ?strike|attack(?:s|ed)?|shoot(?:ing|s)?|shot'
    r'|murder|massacre|hostage|famine|genocide|toll|wounded|casualt|troops'
    r'|gaza|ukraine|execut(?:e|ed|ion)|stabb|terror|crash(?:es|ed)?|victim)\b',
    re.I)
_news = {'data': None, 'at': 0}


def _rss_titles(url: str, limit: int = 4):
    """Pull <item><title> values out of an RSS feed. Regex rather than an XML
    parser: these feeds carry CDATA and occasional malformed entities that make
    strict parsing fail, and we only need the titles."""
    import html as _html
    r = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
    r.raise_for_status()
    # requests guesses latin-1 when a feed omits a charset header, which turns
    # smart quotes into mojibake ("Dad?s"). Prefer the feed's own <?xml
    # encoding=?> / apparent encoding so curly punctuation decodes correctly.
    if 'charset' not in r.headers.get('Content-Type', '').lower():
        r.encoding = r.apparent_encoding or 'utf-8'
    text = r.text
    items = re.findall(r'<item[^>]*>(.*?)</item>', text, re.S | re.I)
    out = []
    for it in items[:limit]:
        m = re.search(r'<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', it, re.S | re.I)
        if not m:
            continue
        t = _html.unescape(re.sub(r'<[^>]+>', '', m.group(1))).strip()
        # Normalise the curly punctuation the panel font can't render to ASCII.
        t = (t.replace('’', "'").replace('‘', "'")
              .replace('“', '"').replace('”', '"')
              .replace('—', '-').replace('–', '-').replace('…', '...'))
        t = re.sub(r'\s+', ' ', t)
        if t:
            out.append(t)
    return out


def _refresh_news():
    # Per-category toggles (settings, 2026-07-22): missing key -> on by
    # default, same convention as sports/segments, so a stale settings.json
    # never silently drops a category that used to show.
    news_settings = _read_settings().get('news') or {}
    enabled = [(cat, url, src) for cat, url, src in NEWS_FEEDS
               if news_settings.get(cat) is not False]
    out = []
    for cat, url, src in enabled:
        try:
            for t in _rss_titles(url):
                if GRIM_RE.search(t):
                    continue
                out.append({'cat': cat, 'text': t, 'src': src})
        except Exception:
            continue  # one dead feed must not blank the whole ticker
    if out:
        # interleave categories so the tape doesn't run 4 WORLD stories in a row
        by_cat = {}
        for item in out:
            by_cat.setdefault(item['cat'], []).append(item)
        mixed, i = [], 0
        while any(by_cat.values()):
            for cat in list(by_cat):
                if by_cat[cat]:
                    mixed.append(by_cat[cat].pop(0))
            i += 1
            if i > 20:
                break
        _news['data'] = mixed
    elif not enabled:
        # Every category is genuinely disabled (2026-07-22 fix) -- that's the
        # correct current state, not a feed outage, so clear rather than keep
        # serving whatever was cached from before the toggle. Previously this
        # `elif` didn't exist, so disabling every category left `out` empty
        # and the bare `if out:` above silently never updated `_news['data']`
        # at all -- stale news kept showing forever no matter what was toggled.
        _news['data'] = []
    # else: some categories are enabled but every one of them failed (a
    # transient outage) -- keep whatever's cached instead of blanking the tape.
    _news['at'] = time.time()


def _cached(cache, ttl, refresher):
    with _lock:
        if cache['data'] is None or time.time() - cache['at'] > ttl:
            refresher()
        return cache['data']


_logo_cache = {}
_logo_lock = threading.Lock()


def _logo(ticker: str):
    ticker = ticker.upper()
    now = time.time()
    with _logo_lock:
        hit = _logo_cache.get(ticker)
        if hit and now - hit[2] < 86400:
            return hit[0], hit[1]
    sources = (
        f'https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/{ticker}.png',
        f'https://financialmodelingprep.com/image-stock/{ticker}.png',
    )
    for url in sources:
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=6)
            if r.ok and r.content and 'image' in r.headers.get('Content-Type', ''):
                ctype = r.headers.get('Content-Type', 'image/png')
                with _logo_lock:
                    _logo_cache[ticker] = (r.content, ctype, now)
                return r.content, ctype
        except Exception:
            pass
    with _logo_lock:
        _logo_cache[ticker] = (None, None, now)
    return None, None


# --------------------------------------------------------------------------
# F1 constructors (2026-08-10). ESPN's racing feed has NO team data on drivers
# at all -- its competitor object is {id, uid, type, order, winner, athlete,
# statistics}, checked against the site scoreboard, the core event and the core
# competition. Jeff asked for the car brand, and rather than hardcode a
# driver->team table (which silently goes wrong on a mid-season seat change)
# this pulls the CURRENT standings from Jolpica-F1, the free keyless successor
# to the retired Ergast API. Seat changes fix themselves.
#
# Keyed on surname because that is what ESPN gives us to match against.
# 24h TTL: constructors change a few times a season, not a few times a day.
_f1teams = {'data': None, 'at': 0.0}
F1TEAMS_TTL = 86400


def _refresh_f1teams():
    r = requests.get('https://api.jolpi.ca/ergast/f1/current/driverstandings.json',
                     params={'limit': 50}, timeout=12)
    d = r.json() or {}
    lists = (((d.get('MRData') or {}).get('StandingsTable') or {})
             .get('StandingsLists') or [])
    rows = (lists[0].get('DriverStandings') if lists else []) or []
    out = {}
    for row in rows:
        drv = row.get('Driver') or {}
        cons = (row.get('Constructors') or [{}])[0]
        surname = (drv.get('familyName') or '').upper()
        if not surname:
            continue
        out[surname] = {
            'team': (cons.get('name') or '').upper(),
            'code': (drv.get('code') or '').upper(),
        }
    _f1teams['data'] = out
    _f1teams['at'] = time.time()


# --------------------------------------------------------------------------
# News outlet logos (2026-08-10). The outlet NAME already renders under the
# category tag; Jeff also asked for "that news teams logo after good / world /
# sports".
#
# Deliberately NOT favicon.ico: a 16px favicon downscaled onto a dot mask is
# mush, which is the same failure mode that killed several photo-sourced
# wordmarks. apple-touch-icon is typically 180x180 and is the same mark, so it
# survives the trip down to ~16px far better. DuckDuckGo's icon service is the
# fallback because it also serves the larger asset where one exists.
NEWS_LOGO_DOMAIN = {
    'BBC': 'bbc.co.uk',
    'NPR': 'npr.org',
    'NYT': 'nytimes.com',
    'HN': 'news.ycombinator.com',
    'ESPN': 'espn.com',
    'GNN': 'goodnewsnetwork.org',
}
_news_logo_cache = {}
_news_logo_lock = threading.Lock()


def _news_logo(src: str):
    src = (src or '').upper()
    domain = NEWS_LOGO_DOMAIN.get(src)
    if not domain:
        return None, None
    now = time.time()
    with _news_logo_lock:
        hit = _news_logo_cache.get(src)
        if hit and now - hit[2] < 86400:
            return hit[0], hit[1]
    sources = (
        f'https://{domain}/apple-touch-icon.png',
        f'https://icons.duckduckgo.com/ip3/{domain}.ico',
        f'https://www.google.com/s2/favicons?sz=128&domain={domain}',
    )
    for url in sources:
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=6)
            if r.ok and r.content and 'image' in r.headers.get('Content-Type', ''):
                ctype = r.headers.get('Content-Type', 'image/png')
                with _news_logo_lock:
                    _news_logo_cache[src] = (r.content, ctype, now)
                return r.content, ctype
        except Exception:
            pass
    with _news_logo_lock:
        _news_logo_cache[src] = (None, None, now)
    return None, None


# --------------------------------------------------------------------------
# Spotify now-playing.
# --------------------------------------------------------------------------
# All of this lives server-side on purpose: the client secret must never reach
# the page, and api.spotify.com sends no CORS headers for this endpoint anyway.
# Flow: /api/spotify/login -> Spotify consent -> /api/spotify/callback exchanges
# the code for a refresh token, which is persisted so the one-time consent
# survives restarts. /api/nowplaying.json then serves the current track.
#
# The redirect URI MUST use 127.0.0.1, not localhost — Spotify stopped accepting
# `localhost` loopback redirects and rejects the whole authorize request.
SPOTIFY_REDIRECT = f'http://127.0.0.1:{PORT}/api/spotify/callback'
SPOTIFY_SCOPE = 'user-read-currently-playing user-read-playback-state'
SPOTIFY_TOKEN_FILE = os.path.join(HERE, '.spotify_token')
_NP_TTL = 5  # now-playing changes constantly; keep it fresh but don't hammer
_np_cache = {'at': 0, 'data': None}
_spotify_lock = threading.Lock()
_access = {'token': None, 'exp': 0}


def _spotify_creds():
    cid = getattr(keys, 'SPOTIFY_CLIENT_ID', None)
    sec = getattr(keys, 'SPOTIFY_CLIENT_SECRET', None)
    return (cid, sec) if cid and sec else (None, None)


def _read_refresh():
    try:
        with open(SPOTIFY_TOKEN_FILE) as f:
            return f.read().strip() or None
    except OSError:
        return None


def _spotify_access_token():
    """Current access token, refreshed as needed. None until Jeff has consented."""
    with _spotify_lock:
        if _access['token'] and time.time() < _access['exp']:
            return _access['token']
        cid, sec = _spotify_creds()
        refresh = _read_refresh()
        if not (cid and sec and refresh):
            return None
        try:
            r = requests.post('https://accounts.spotify.com/api/token', timeout=8, data={
                'grant_type': 'refresh_token', 'refresh_token': refresh,
            }, auth=(cid, sec))
            if not r.ok:
                return None
            j = r.json()
            _access['token'] = j.get('access_token')
            _access['exp'] = time.time() + int(j.get('expires_in', 3600)) - 60
            return _access['token']
        except Exception:
            return None


def _now_playing():
    now = time.time()
    if _np_cache['data'] is not None and now - _np_cache['at'] < _NP_TTL:
        return _np_cache['data']
    tok = _spotify_access_token()
    if not tok:
        return None
    out = None
    try:
        r = requests.get(
            'https://api.spotify.com/v1/me/player/currently-playing',
            headers={'Authorization': f'Bearer {tok}'}, timeout=8)
        # 204 = nothing playing. That's a normal state, not an error.
        if r.status_code == 200 and r.content:
            j = r.json()
            item = j.get('item') or {}
            imgs = ((item.get('album') or {}).get('images') or [])
            # Smallest image that's still >= the 28px we draw; they come big-first.
            art = imgs[-1].get('url') if imgs else None
            out = {
                'title': item.get('name') or '',
                'artist': ', '.join(a.get('name', '') for a in (item.get('artists') or [])) or '',
                'art': art,
                'paused': not j.get('is_playing', False),
            } if item.get('name') else None
    except Exception:
        out = None
    _np_cache['at'] = now
    _np_cache['data'] = out
    return out


# --------------------------------------------------------------------------
# Glance-catalog apps (2026-07-17): Steam Top 10, Overhead Flights, Twitch.
# All proxied here for caching + keys; the page never talks to these hosts.
# --------------------------------------------------------------------------
_steam = {'data': None, 'at': 0.0}
_steam_names: dict = {}  # appid -> (name, price, fetched_at); store lookups are slow


def _refresh_steam():
    """Most-played ranks are one keyless call; names/prices come from the store
    appdetails endpoint one app at a time (cached a day — the top 10 barely
    churns, so after the first fill this is usually zero store calls)."""
    r = requests.get('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/', timeout=10)
    ranks = ((r.json() or {}).get('response') or {}).get('ranks') or []
    out = []
    now = time.time()
    for e in ranks[:10]:
        appid = e.get('appid')
        hit = _steam_names.get(appid)
        if not hit or now - hit[2] > 86400:
            name, price = None, None
            try:
                d = requests.get('https://store.steampowered.com/api/appdetails',
                                 params={'appids': appid, 'filters': 'basic,price_overview'},
                                 timeout=8).json()
                dd = ((d or {}).get(str(appid)) or {}).get('data') or {}
                name = dd.get('name')
                po = dd.get('price_overview') or {}
                price = po.get('final_formatted') or ('FREE' if dd.get('is_free') else None)
                time.sleep(0.3)  # store API rate-limits bursts
            except Exception:
                pass
            hit = (name, price, now)
            if name:
                _steam_names[appid] = hit
        if hit[0]:
            out.append({'rank': e.get('rank'), 'name': hit[0], 'price': hit[1],
                        'peak': e.get('peak_in_game')})
    if out:
        _steam['data'] = out
    _steam['at'] = time.time()


DEFAULT_HOME_LAT, DEFAULT_HOME_LON = 41.49, -73.49  # keep in sync with data.js's DEFAULT_HOME
_flights = {'data': None, 'at': 0.0}
FLIGHTS_TTL = 300  # anonymous OpenSky is credit-limited (~400/day); 5min is safe


def _home_latlon():
    """Settings-driven home location (2026-07-22): falls back to the original
    hardcoded default whenever nothing's been geocoded yet."""
    loc = (_read_settings().get('location') or {})
    lat, lon = loc.get('lat'), loc.get('lon')
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        return lat, lon
    return DEFAULT_HOME_LAT, DEFAULT_HOME_LON


# ---------------------------------------------------------------------------
# Aircraft type (API-map item 21). OpenSky's live feed carries NO aircraft type
# -- a callsign identifies the airline and nothing else -- so the jet-vs-Cessna
# picture Jeff asked for needs a second source keyed on the transponder address
# (icao24). That source is OpenSky's own aircraft database CSV (94.5 MB), which
# is reduced once into a local SQLite index by
# scratchpad/build_aircraft_db.py. Neither the CSV nor the .db goes in the
# vault -- they live under %LOCALAPPDATA%\led-ticker\, same as settings.json.
#
# The useful column is `icaoaircrafttype`, an ICAO designator encoding
# class/engines/engine-type: L2J = landplane, 2 engines, jet (an airliner);
# L1P = landplane, 1 engine, piston (the Cessna case); L*T = turboprop;
# H* = helicopter. That is a real classification rather than a guess off the
# model string.
#
# Missing database is not an error: _aircraft_type returns ('', '') and the
# flights card renders exactly as it did before, callsign + altitude + speed.
AIRCRAFT_DB = os.path.join(os.path.dirname(_settings_path()), 'aircraft.db')
_ac_conn = None
_ac_lock = threading.Lock()
_ac_tried = False


def _aircraft_conn():
    global _ac_conn, _ac_tried
    if _ac_conn is not None or _ac_tried:
        return _ac_conn
    _ac_tried = True
    if not os.path.exists(AIRCRAFT_DB):
        print('[flights] no aircraft.db -- run scratchpad/build_aircraft_db.py '
              'for aircraft types (card still works without it)')
        return None
    try:
        import sqlite3
        _ac_conn = sqlite3.connect('file:%s?mode=ro' % AIRCRAFT_DB,
                                   uri=True, check_same_thread=False)
    except Exception as e:
        print('[flights] aircraft.db unusable: %s' % e)
        _ac_conn = None
    return _ac_conn


def _aircraft_type(icao24):
    """icao24 -> (kind, model). kind is one of jet/prop/turboprop/heli/''."""
    if not icao24:
        return '', ''
    conn = _aircraft_conn()
    if conn is None:
        return '', ''
    try:
        with _ac_lock:
            row = conn.execute(
                'SELECT kind, model FROM aircraft WHERE icao24=?', (icao24,)
            ).fetchone()
        return (row[0] or '', row[1] or '') if row else ('', '')
    except Exception:
        return '', ''


_COMPASS = ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')


def _compass(deg):
    """True track in degrees -> an 8-point compass token (API-map item 21).

    Jeff picked a token over rotating the plane art by heading: pixel art at
    arbitrary angles turns to fuzz, and 'NE' reads at scroll speed where '047'
    does not."""
    if deg is None:
        return ''
    return _COMPASS[int((float(deg) % 360) / 45.0 + 0.5) % 8]


# Below this the aircraft is treated as level. 2.5 m/s ~= 500 ft/min, which is
# roughly where a climb or descent stops being noise in OpenSky's numbers --
# cruising aircraft report small non-zero vertical rates constantly.
LEVEL_FPM = 500


def _refresh_flights():
    """Aircraft in a ~40mi box around home, nearest first. OpenSky state vector:
    [icao24(0), callsign(1), origin_country(2), ..., lon(5), lat(6),
    baro_alt_m(7), on_ground(8), velocity_ms(9), track(10), vert_rate_ms(11)].

    icao24 is the transponder address and is NOT for display -- it is the join
    key into the OpenSky aircraft database (see _aircraft_type), which is the
    only way to get an aircraft TYPE. OpenSky's live feed never carries one."""
    home_lat, home_lon = _home_latlon()
    r = requests.get('https://opensky-network.org/api/states/all',
                     params={'lamin': home_lat - 0.3, 'lomin': home_lon - 0.5,
                             'lamax': home_lat + 0.3, 'lomax': home_lon + 0.5},
                     timeout=12)
    states = (r.json() or {}).get('states') or []
    out = []
    for s in states:
        if s[8] or s[6] is None or s[5] is None:  # on ground / no position
            continue
        cs = (s[1] or '').strip()
        if not cs:
            continue
        icao24 = (s[0] or '').strip().lower()
        vrate_fpm = round((s[11] or 0) * 196.85)
        if vrate_fpm > LEVEL_FPM:
            climb = 'up'
        elif vrate_fpm < -LEVEL_FPM:
            climb = 'down'
        else:
            climb = 'level'
        kind, model = _aircraft_type(icao24)
        out.append({
            'callsign': cs, 'country': s[2],
            'altFt': round((s[7] or 0) * 3.281), 'mph': round((s[9] or 0) * 2.237),
            'track': s[10], 'compass': _compass(s[10]),
            'vrateFpm': vrate_fpm, 'climb': climb,
            'icao24': icao24, 'kind': kind, 'model': model,
            '_d2': (s[6] - home_lat) ** 2 + (s[5] - home_lon) ** 2,
        })
    out.sort(key=lambda f: f['_d2'])
    for f in out:
        del f['_d2']
    _flights['data'] = out[:6]
    _flights['at'] = time.time()


# Twitch Tracker — dormant until Jeff adds TWITCH_CLIENT_ID/SECRET to
# webapp/keys.py (free: dev.twitch.tv -> register app -> client credentials).
TWITCH_CHANNELS = ['caseoh_', 'kaicenat', 'xqc', 'ninja', 'shroud', 'jynxzi']
_twitch = {'data': None, 'at': 0.0}
_tw_tok = {'token': None, 'exp': 0.0}


def _twitch_auth():
    cid = getattr(keys, 'TWITCH_CLIENT_ID', None)
    sec = getattr(keys, 'TWITCH_CLIENT_SECRET', None)
    if not (cid and sec):
        return None, None
    if _tw_tok['token'] and time.time() < _tw_tok['exp']:
        return cid, _tw_tok['token']
    try:
        r = requests.post('https://id.twitch.tv/oauth2/token', timeout=8, data={
            'client_id': cid, 'client_secret': sec, 'grant_type': 'client_credentials'})
        if not r.ok:
            return None, None
        j = r.json()
        _tw_tok['token'] = j.get('access_token')
        _tw_tok['exp'] = time.time() + int(j.get('expires_in', 3600)) - 60
        return cid, _tw_tok['token']
    except Exception:
        return None, None


def _refresh_twitch():
    cid, tok = _twitch_auth()
    if not tok:
        _twitch['data'] = []  # no keys yet: the segment just drops out
        _twitch['at'] = time.time()
        return
    try:
        r = requests.get('https://api.twitch.tv/helix/streams', timeout=8,
                         params=[('user_login', c) for c in TWITCH_CHANNELS],
                         headers={'Client-ID': cid, 'Authorization': f'Bearer {tok}'})
        data = (r.json() or {}).get('data') or []
        out = [{'name': d.get('user_name'), 'game': d.get('game_name'),
                'viewers': d.get('viewer_count')} for d in data]
        out.sort(key=lambda d: -(d['viewers'] or 0))
        _twitch['data'] = out
    except Exception:
        pass
    _twitch['at'] = time.time()


_ASSET_MIME = {
    '.ttf': 'font/ttf', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
}


def _serve_asset(path: str):
    """Serve a file under fonts/ or assets/ (their real TTFs + weather PNGs),
    guarding against path traversal outside this project dir."""
    rel = path.lstrip('/')
    full = os.path.normpath(os.path.join(HERE, rel))
    if not full.startswith(HERE) or not os.path.isfile(full):
        return None, None
    ext = os.path.splitext(full)[1].lower()
    try:
        with open(full, 'rb') as f:
            return f.read(), _ASSET_MIME.get(ext, 'application/octet-stream')
    except OSError:
        return None, None


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        """/api/settings writes the tray Settings window's picks; /api/save-crop
        is dev-only -- lets the page write a rendered canvas crop straight to
        disk (render-proof/<name>.png) so verification doesn't depend on
        shuttling huge base64 strings through the tooling."""
        if self.path == '/api/settings':
            try:
                n = int(self.headers.get('Content-Length', 0))
                data = json.loads(self.rfile.read(n))
                if not isinstance(data, dict):
                    raise ValueError('settings payload must be an object')
                data.setdefault('sports', {})
                data.setdefault('favorites', {})
                # wordmarkModes replaced the single `wordmarks` boolean
                # (2026-08-10); default matches the old True = favorites only.
                data.setdefault('wordmarkModes', {'favorites': True})
                data.setdefault('logoSize', 'medium')
                data.setdefault('density', 'standard')
                data.setdefault('scrollSpeed', 50)
                # stage 4 of the takeover redesign: who gets the short in-card
                # score flash. Missing key behaves as on, like every other
                # toggle here.
                data.setdefault('scoreFlash', 'all')
                data.setdefault('wordmarkSize', 'medium')
                data.setdefault('news', {})
                data.setdefault('segments', {})
                data.setdefault('favoriteStocks', [])
                data.setdefault('customStocks', [])
                _write_settings(data)
                # Bust every settings-dependent cache (2026-07-22 fix): without
                # this, a toggle/custom-ticker change was invisible until its
                # cache's own TTL happened to expire naturally (up to 30min for
                # news, 10min for stocks/indices) -- same root cause as the news
                # "doesn't work" bug above, just latent in these too since they
                # share the identical stale-until-TTL pattern.
                _news['at'] = 0
                _stocks['at'] = 0
                _indices['at'] = 0
                self._send(200, 'application/json', json.dumps({'ok': True}).encode())
            except Exception as e:
                self._send(400, 'application/json', json.dumps({'ok': False, 'err': str(e)}).encode())
            return
        if self.path != '/api/save-crop':
            self._send(404, 'text/plain', b'not found')
            return
        try:
            import base64 as _b64
            import re as _re
            n = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(n))
            name = _re.sub(r'[^a-z0-9_-]', '', str(payload.get('name', 'crop')).lower())[:40] or 'crop'
            blob = _b64.b64decode(payload['png'])
            outdir = os.path.join(HERE, 'render-proof')
            os.makedirs(outdir, exist_ok=True)
            path = os.path.join(outdir, name + '.png')
            with open(path, 'wb') as f:
                f.write(blob)
            self._send(200, 'application/json',
                       json.dumps({'ok': True, 'bytes': len(blob), 'path': path}).encode())
        except Exception as e:
            self._send(500, 'application/json', json.dumps({'ok': False, 'err': str(e)}).encode())

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in STATIC:
            fname, ctype = STATIC[path]
            try:
                with open(os.path.join(HERE, fname), 'rb') as f:
                    self._send(200, ctype, f.read(), no_cache=True)
            except OSError:
                self._send(404, 'text/plain', b'not found')
        elif path.startswith('/fonts/') or path.startswith('/assets/'):
            body, ctype = _serve_asset(path)
            if body is not None:
                self._send(200, ctype, body)
            else:
                self._send(404, 'text/plain', b'not found')
        elif path == '/api/stocks.json':
            data = _stocks_swr() or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/indices.json':
            data = _cached(_indices, INDICES_TTL, _refresh_indices) or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/stock-symbols':
            # Curated list for the settings page's favorite-stocks button picker
            # -- static, no live roster call, same reasoning as the college
            # conference map (no per-team fetch needed for a fixed list).
            out = [{'sym': s, 'domain': d, 'color': c} for s, d, c in STOCKS]
            self._send(200, 'application/json', json.dumps(out).encode(), no_cache=True)
        elif path == '/api/settings.json':
            self._send(200, 'application/json', json.dumps(_read_settings()).encode(), no_cache=True)
        elif path == '/api/teams':
            q = parse_qs(urlparse(self.path).query)
            league = (q.get('league') or [''])[0].upper()
            self._send(200, 'application/json', json.dumps(_teams_for(league)).encode(), no_cache=True)
        elif path == '/api/roster':
            q = parse_qs(urlparse(self.path).query)
            league = (q.get('league') or [''])[0].upper()
            team = (q.get('team') or [''])[0].strip()
            self._send(200, 'application/json',
                       json.dumps(_roster_for(league, team)).encode(), no_cache=True)
        elif path == '/api/geocode':
            q = parse_qs(urlparse(self.path).query)
            city = (q.get('city') or [''])[0].strip()
            if not city:
                self._send(400, 'application/json', json.dumps({'ok': False, 'err': 'city required'}).encode())
                return
            try:
                hit = _geocode_city(city)
                if not hit:
                    self._send(200, 'application/json', json.dumps({'ok': False, 'err': 'not found'}).encode(), no_cache=True)
                else:
                    self._send(200, 'application/json', json.dumps(dict(hit, ok=True)).encode(), no_cache=True)
            except Exception as e:
                self._send(500, 'application/json', json.dumps({'ok': False, 'err': str(e)}).encode())
        elif path == '/api/news.json':
            data = _cached(_news, 1800, _refresh_news) or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/logo':
            q = parse_qs(urlparse(self.path).query)
            ticker = (q.get('t') or [''])[0]
            body, ctype = _logo(ticker) if ticker else (None, None)
            if body:
                self._send(200, ctype, body)
            else:
                self._send(404, 'text/plain', b'no logo')
        elif path == '/api/f1teams.json':
            data = _cached(_f1teams, F1TEAMS_TTL, _refresh_f1teams) or {}
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/newslogo':
            q = parse_qs(urlparse(self.path).query)
            src = (q.get('src') or [''])[0]
            body, ctype = _news_logo(src) if src else (None, None)
            if body:
                self._send(200, ctype, body)
            else:
                self._send(404, 'text/plain', b'no logo')
        elif path == '/api/steam.json':
            data = _cached(_steam, 1800, _refresh_steam) or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/flights.json':
            data = _cached(_flights, FLIGHTS_TTL, _refresh_flights) or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/twitch.json':
            data = _cached(_twitch, 300, _refresh_twitch) or []
            self._send(200, 'application/json', json.dumps(data).encode(), no_cache=True)
        elif path == '/api/nowplaying.json':
            data = _now_playing()
            self._send(200, 'application/json',
                       json.dumps(data if data else None).encode(), no_cache=True)
        elif path == '/api/spotify/login':
            cid, _sec = _spotify_creds()
            if not cid:
                self._send(400, 'text/html; charset=utf-8',
                           b'<h2>No Spotify keys</h2><p>Add SPOTIFY_CLIENT_ID and '
                           b'SPOTIFY_CLIENT_SECRET to webapp/keys.py, then restart this server.</p>')
                return
            from urllib.parse import urlencode
            url = 'https://accounts.spotify.com/authorize?' + urlencode({
                'client_id': cid, 'response_type': 'code',
                'redirect_uri': SPOTIFY_REDIRECT, 'scope': SPOTIFY_SCOPE,
            })
            self.send_response(302)
            self.send_header('Location', url)
            self.end_headers()
        elif path == '/api/spotify/callback':
            q = parse_qs(urlparse(self.path).query)
            code = (q.get('code') or [''])[0]
            err = (q.get('error') or [''])[0]
            cid, sec = _spotify_creds()
            if err or not code or not cid:
                self._send(400, 'text/html; charset=utf-8',
                           f'<h2>Spotify auth failed</h2><p>{err or "no code"}</p>'.encode())
                return
            try:
                r = requests.post('https://accounts.spotify.com/api/token', timeout=8, data={
                    'grant_type': 'authorization_code', 'code': code,
                    'redirect_uri': SPOTIFY_REDIRECT,
                }, auth=(cid, sec))
                tok = r.json().get('refresh_token') if r.ok else None
                if not tok:
                    self._send(400, 'text/html; charset=utf-8',
                               b'<h2>Spotify auth failed</h2><p>No refresh token returned.</p>')
                    return
                with open(SPOTIFY_TOKEN_FILE, 'w') as f:
                    f.write(tok)
                with _spotify_lock:
                    _access['token'] = None
                    _access['exp'] = 0
                self._send(200, 'text/html; charset=utf-8',
                           b'<h2>Spotify connected.</h2><p>Play something and it will '
                           b'show up on the ticker. You can close this tab.</p>')
            except Exception as e:
                self._send(500, 'text/html; charset=utf-8', f'<h2>Error</h2><p>{e}</p>'.encode())
        elif path == '/healthz':
            self._send(200, 'text/plain', b'ok')
        else:
            self._send(404, 'text/plain', b'not found')

    def _send(self, code, ctype, body, no_cache=False):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if no_cache:
            self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    print(f'ChuckBuilds-style tape server: http://localhost:{PORT}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
