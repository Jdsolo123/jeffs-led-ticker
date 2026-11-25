import requests, config
from difflib import SequenceMatcher

ESPN_BASE = 'http://site.api.espn.com/apis/site/v2/sports'
ODDS_BASE = 'https://api.the-odds-api.com/v4/sports'

def _similarity(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

def _fetch_espn(sport_path):
    url = f'{ESPN_BASE}/{sport_path}/scoreboard'
    try:
        r = requests.get(url, timeout=5)
        r.raise_for_status()
        return r.json().get('events', [])
    except Exception:
        return []

def _fetch_odds(odds_key):
    if not config.ODDS_API_KEY or config.ODDS_API_KEY == 'YOUR_KEY_HERE':
        return []
    url = f'{ODDS_BASE}/{odds_key}/odds'
    params = {
        'apiKey': config.ODDS_API_KEY,
        'regions': 'us',
        'markets': 'spreads,totals,h2h',
        'oddsFormat': 'american',
    }
    try:
        r = requests.get(url, params=params, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception:
        return []

def _parse_espn_event(event):
    comp = event.get('competitions', [{}])[0]
    teams = comp.get('competitors', [])
    home = next((t for t in teams if t.get('homeAway') == 'home'), {})
    away = next((t for t in teams if t.get('homeAway') == 'away'), {})
    status = comp.get('status', {})
    state = status.get('type', {}).get('state', 'pre')  # pre / in / post
    return {
        'id': event.get('id'),
        'name': event.get('name', ''),
        'state': state,
        'period': status.get('period', 0),
        'clock': status.get('displayClock', ''),
        'home_team': home.get('team', {}).get('abbreviation', '?'),
        'away_team': away.get('team', {}).get('abbreviation', '?'),
        'home_score': home.get('score', ''),
        'away_score': away.get('score', ''),
        'home_logo': home.get('team', {}).get('logo', ''),
        'away_logo': away.get('team', {}).get('logo', ''),
        'home_color': home.get('team', {}).get('color', '003087'),
        'away_color': away.get('team', {}).get('color', '003087'),
        'spread': None, 'total': None, 'home_ml': None, 'away_ml': None,
        'league': '',
    }

def _merge_odds(games, odds_list):
    # Odds API v4: events carry home_team/away_team full names (no 'teams' array).
    # ESPN's event 'name' is "Away Full Name at Home Full Name" — match on that,
    # since ESPN abbreviations ("SF") never fuzzy-match full names.
    for game in games:
        gname = game.get('name', '').lower()
        best = None
        best_score = 0.0
        for o in odds_list:
            home, away = o.get('home_team', ''), o.get('away_team', '')
            if not home or not away:
                continue
            if home.lower() in gname and away.lower() in gname:
                best = o
                break
            score = _similarity(f'{away} at {home}', game.get('name', ''))
            if score > best_score:
                best_score = score
                best = o if score > 0.75 else best
        if not best:
            continue
        home_name = best.get('home_team', '')
        for bm in best.get('bookmakers', [])[:1]:
            for market in bm.get('markets', []):
                key = market.get('key')
                outcomes = market.get('outcomes', [])
                if key == 'spreads':
                    for out in outcomes:
                        if out.get('name') == home_name:
                            game['spread'] = out.get('point')
                elif key == 'totals':
                    game['total'] = next((x.get('point') for x in outcomes if x.get('name') == 'Over'), None)
                elif key == 'h2h':
                    for out in outcomes:
                        if out.get('name') == home_name:
                            game['home_ml'] = out.get('price')
                        else:
                            game['away_ml'] = out.get('price')

def fetch_all():
    results = []
    for espn_path, odds_key, league in config.SPORTS:
        events = _fetch_espn(espn_path)
        odds = _fetch_odds(odds_key)
        games = [_parse_espn_event(e) for e in events]
        for g in games:
            g['league'] = league
        _merge_odds(games, odds)
        live = [g for g in games if g['state'] == 'in']
        pre = [g for g in games if g['state'] == 'pre']
        post = [g for g in games if g['state'] == 'post'][:2]
        results.extend(live + pre + post)
    return results
