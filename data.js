/* Live data fetchers — every API called from the browser is keyless and
 * CORS-open. Betting odds were removed 2026-08-10 (no paid data sources). */
(function () {
  'use strict';

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

  // Odds + stocks come from the local server's key-guarded proxies when it's
  // there (/api/...), else from statically baked files (static snapshot mode).
  async function fetchWithFallback(name) {
    for (const base of ['/api/', './']) {
      try {
        const r = await fetch(base + name, { cache: 'no-store' });
        if (r.ok) return r.json();
      } catch (e) { /* try next source */ }
    }
    return null;
  }

  // Settings (2026-07-21): which sports fetch at all + favorite team(s) per
  // sport, picked from the tray's Settings window. Always dynamic (never
  // baked/fallback-static like odds/stocks) -- it's per-user config, not a
  // static-snapshot concern. Keeps the last-known object on a failed fetch
  // rather than falling back to "everything off", so a transient server
  // hiccup can't blank the whole tape.
  let _settings = { sports: {}, favorites: {} };
  async function getSettings() {
    try {
      const r = await fetch('/api/settings.json', { cache: 'no-store' });
      if (r.ok) _settings = await r.json();
    } catch (e) { /* keep last-known settings */ }
    return _settings;
  }
  const SPORTS = [
    ['football/nfl', 'americanfootball_nfl', 'NFL'],
    ['basketball/nba', 'basketball_nba', 'NBA'],
    ['baseball/mlb', 'baseball_mlb', 'MLB'],
    ['hockey/nhl', 'icehockey_nhl', 'NHL'],
    ['football/college-football', 'americanfootball_ncaaf', 'NCAAF'],
    ['basketball/mens-college-basketball', 'basketball_ncaab', 'NCAAB'],
    ['basketball/wnba', 'basketball_wnba', 'WNBA'],
    ['football/ufl', '', 'UFL'],
    ['football/cfl', '', 'CFL'],
    ['soccer/eng.1', '', 'EPL'],
    ['soccer/uefa.champions', '', 'UCL'],
    // Back 2026-07-22 -- Jeff: now that settings can toggle sports off
    // individually, no reason MLS has to be gone entirely. Missing settings
    // key -> defaults ON same as every other sport; toggle off in Settings
    // if not wanted.
    ['soccer/usa.1', '', 'MLS'],
  ];
  const COINS = [
    ['bitcoin', 'BTC', '#F7931A'],
    ['ethereum', 'ETH', '#627EEA'],
    ['solana', 'SOL', '#14F195'],
    ['ripple', 'XRP', '#25A768'],
    ['dogecoin', 'DOGE', '#C2A633'],
    ['cardano', 'ADA', '#0033AD'],
    ['avalanche-2', 'AVAX', '#E84142'],
    ['chainlink', 'LINK', '#2A5ADA'],
  ];
  // Settings-driven location (2026-07-22): a city typed into Settings gets
  // geocoded server-side (Open-Meteo, same provider fetchWeather already
  // uses) and stored as {name,lat,lon}. Falls back to the original hardcoded
  // home whenever nothing's been set, so a fresh settings.json never blanks
  // weather/AQI/alerts.
  const DEFAULT_HOME = { lat: 41.49, lon: -73.49, label: 'NEW FAIRFIELD CT', short: 'NEW FFLD' };
  async function getHome() {
    const settings = await getSettings();
    const loc = settings.location;
    if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
      const label = String(loc.name || '').toUpperCase();
      return { lat: loc.lat, lon: loc.lon, label: label || DEFAULT_HOME.label, short: (label || DEFAULT_HOME.short).slice(0, 12) };
    }
    return DEFAULT_HOME;
  }

  // Team abbreviation -> conference, for grouping the sports run into labeled
  // chunks (Glance-style). Best-effort ESPN abbreviations; unmatched teams fall
  // back to the league name as the group label.
  const CONF = {
    NFL: {
      AFC: 'BUF MIA NE NYJ BAL CIN CLE PIT HOU IND JAX TEN DEN KC LV LAC',
      NFC: 'DAL NYG PHI WSH CHI DET GB MIN ATL CAR NO TB ARI LAR SF SEA',
    },
    NBA: {
      EAST: 'BOS BKN NY PHI TOR CHI CLE DET IND MIL ATL CHA MIA ORL WSH',
      WEST: 'DEN MIN OKC POR UTAH GS LAC LAL PHX SAC DAL HOU MEM NO SA',
    },
    MLB: {
      AL: 'BAL BOS NYY TB TOR CHW CWS CLE DET KC MIN HOU LAA ATH OAK SEA TEX',
      NL: 'ATL MIA NYM PHI WSH CHC CIN MIL PIT STL ARI AZ COL LAD SD SF',
    },
    NHL: {
      EAST: 'BOS BUF DET FLA MTL OTT TB TOR CAR CBJ NJ NYI NYR PHI PIT WSH',
      WEST: 'UTAH CHI COL DAL MIN NSH STL WPG ANA CGY EDM LA SJ SEA VAN VGK',
    },
  };
  // College (FBS football + D1 basketball), current realignment. Big East is
  // basketball-only. Applied to NCAAF + NCAAB; unmatched teams -> league label.
  const COLLEGE = {
    'BIG TEN': 'MICH OSU PSU MSU WIS IOWA MINN ILL IND NW NEB PUR MD RUT ORE WASH USC UCLA',
    'SEC': 'ALA UGA LSU TENN FLA AUB TAMU TA&M TEX OU OKLA ARK MISS OM MSST MIZ SC SCAR KY VAN',
    'ACC': 'CLEM FSU MIA UNC NCST DUKE UVA VT GT BC LOU PITT SYR WAKE CAL STAN SMU ND',
    'BIG 12': 'KU KSU OKST BYU TCU BAY TTU WVU CIN UCF HOU ISU UTAH COLO ARIZ ASU',
    'BIG EAST': 'CONN UCONN VILL CREI MARQ XAV BUTL PROV SJU SHU GTWN DEP',
    'PAC-12': 'ORST WSU OSU-P',
    'AAC': 'MEM TULN USF ECU TEM UAB UTSA FAU RICE NAVY TLSA CLT',
    'MTN WEST': 'BOIS SDSU FRES UNLV AFA CSU NEV WYO NMEX HAW SJSU UTST',
    'SUN BELT': 'JMU APP GASO CCU ODU MRSH TROY USA GAST LA ULM ARST TXST',
    'MAC': 'TOL OHIO MIA-OH BGSU WMU CMU EMU NIU BALL AKR BUFF KENT',
  };
  const _confIdx = {}, _collegeIdx = {};
  for (const lg in CONF) {
    _confIdx[lg] = {};
    for (const cf in CONF[lg]) CONF[lg][cf].split(' ').forEach(a => { _confIdx[lg][a] = cf; });
  }
  for (const cf in COLLEGE) COLLEGE[cf].split(' ').forEach(a => { _collegeIdx[a] = cf; });

  function confOf(league, homeAbbr, awayAbbr) {
    if (league === 'WNBA') return 'WNBA';
    if (league === 'NCAAF' || league === 'NCAAB') {
      return _collegeIdx[homeAbbr] || _collegeIdx[awayAbbr] || league;
    }
    const m = _confIdx[league];
    if (m && homeAbbr && m[homeAbbr]) return league + ' ' + m[homeAbbr];
    return league; // unknown -> league name as the group label
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status);
    return r.json();
  }

  function rankOf(c) {
    const r = c && c.curatedRank && c.curatedRank.current;
    return (r && r <= 25) ? r : null;
  }
  // Compact live-situation string per sport: down&distance+possession (football),
  // count+outs (baseball). Empty for sports without a discrete situation.
  function situationText(comp, league, home, away) {
    const s = comp.situation || {};
    if (league === 'NFL' || league === 'NCAAF') {
      let t = s.shortDownDistanceText || '';
      const posId = s.possession;
      if (posId) {
        const pos = (home.team && home.team.id === posId) ? home : (away.team && away.team.id === posId) ? away : null;
        if (pos) t = (t ? t + ' ' : '') + ((pos.team && pos.team.abbreviation) || '');
      }
      return (s.isRedZone ? 'RZ ' : '') + t.toUpperCase();
    }
    if (league === 'MLB') {
      if (s.balls == null && s.outs == null) return '';
      return (s.balls || 0) + '-' + (s.strikes || 0) + ' ' + (s.outs || 0) + 'OUT';
    }
    return '';
  }

  const MICH_ID = '130'; // ESPN team id, football + basketball both
  function isMichigan(home, away) {
    return [home, away].some(t => t && t.team && String(t.team.id) === MICH_ID);
  }

  // "AUG 5" — the calendar date, not just the weekday. A bare "SAT" doesn't say
  // which Saturday, which is useless for a schedule that runs weeks out.
  function shortDateOf(iso) {
    return iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase() : '';
  }
  function shortTimeOf(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase() : '';
  }

  // Structured live state for the big live card. Each sport exposes a different
  // shape, so this normalises to {bases,outs,count,period,detail,possession}.
  function liveDetail(comp, league) {
    const s = comp.situation || {};
    const st = comp.status || {};
    const period = st.period || 0;
    const out = {
      period,
      detail: ((st.type || {}).shortDetail || '').toUpperCase(),
      clock: st.displayClock || '',
    };
    if (league === 'MLB') {
      // onFirst/onSecond/onThird are `false` when empty, an object when occupied.
      out.bases = [!!s.onFirst, !!s.onSecond, !!s.onThird];
      out.outs = s.outs || 0;
      out.count = (s.balls != null && s.strikes != null) ? s.balls + '-' + s.strikes : '';
      // "End 3rd"/"Bot 9" already lives in shortDetail; that's the inning label.
    } else if (league === 'NFL' || league === 'NCAAF' || league === 'UFL' || league === 'CFL') {
      out.dnd = (s.shortDownDistanceText || '').toUpperCase();
      out.redZone = !!s.isRedZone;
      // Field-position extras for the stacked football card. yardLine is 0-100
      // (100 = opponent goal line for the possessing team); possessionText is
      // the human spot ("ALA 47"). Both only present in-game — code renders
      // without them until ESPN starts sending them each season.
      out.yardLine = (typeof s.yardLine === 'number') ? s.yardLine : null;
      out.spot = (s.possessionText || '').toUpperCase();
      out.possessionId = s.possession || null;
    }
    return out;
  }

  // "47-48" — the overall W-L, for the Glance-style pre-game card.
  function recordOf(t) {
    const rs = t.records || [];
    const r = rs.find(r => r.name === 'overall' || r.type === 'total') || rs[0];
    return (r && r.summary) || '';
  }
  // Live box-score stat off the competitor ("hits"/"errors" for MLB's H/E).
  function statNum(t, name) {
    const s = (t.statistics || []).find(s => s.name === name);
    return s ? s.displayValue : null;
  }
  // National feed first ("FOX", "MLB.TV"), else whatever market ESPN lists.
  //
  // geoBroadcasts fallback (2026-08-10, API-map item 9): `broadcasts` is often
  // empty, which left the card's broadcaster line blank on most games.
  // `geoBroadcasts` is the fuller structure -- one entry per market, each with
  // its own media name and delivery type -- so a Tigers home game yields
  // "FanDuel Sports Detroit" even though nationally there is nothing.
  //
  // Prefer a national TV feed, then the home market's TV feed, then anything.
  // The TV filter matters: MLB lists MLB.TV as the NATIONAL entry with
  // type "Streaming", and labelling every game "MLB.TV" would be worse than
  // the blank it replaced (verified against the live MLB scoreboard).
  function broadcastOf(comp) {
    const bs = comp.broadcasts || [];
    const b = bs.find(b => b.market === 'national') || bs[0];
    const legacy = (((b && b.names) || [])[0] || '').toUpperCase();
    if (legacy) return legacy;
    const geo = comp.geoBroadcasts || [];
    const nameOf = g => (((g.media || {}).shortName) || '').toUpperCase();
    const isTV = g => (((g.type || {}).shortName) || '') === 'TV';
    const mkt = m => g => (((g.market || {}).type) || '') === m;
    const pick = geo.find(g => mkt('National')(g) && isTV(g)) ||
      geo.find(g => mkt('Home')(g) && isTV(g)) ||
      geo.find(isTV) || geo[0];
    return pick ? nameOf(pick) : '';
  }

  // Stadium name (API-map item 1). Replaces the city line at density:full --
  // the city shown there is the home team's city, which is the venue's city
  // anyway, so the venue name is strictly more information in the same pixels.
  function venueOf(comp) {
    return (((comp.venue || {}).fullName) || '').toUpperCase();
  }

  // ESPN's own written game headline (API-map item 3). `shortLinkText` is the
  // editorial one ("Ortiz hits 2nd career homer ... as Nationals beat Reds
  // 7-1"); `description` is a dry stat restatement ("Boston Red Sox (64-53,
  // third in the AL East) vs. ..."), so it is deliberately not the fallback.
  // Present pre-game too, as a "Preview" type.
  function headlineOf(comp) {
    const h = (comp.headlines || [])[0];
    return ((h && h.shortLinkText) || '').toUpperCase();
  }

  // Series / bowl / tournament context (API-map item 8) -- "ALDS GAME 3 OF 5".
  // Empty on almost every regular-season game by design; it's a conditional
  // line, not a segment, and it exists to make the postseason look different.
  function notesOf(comp) {
    const n = (comp.notes || []).find(n => n.headline) || (comp.notes || [])[0];
    return (((n && n.headline) || '')).toUpperCase();
  }

  // Inning-by-inning (API-map item 5, baseball only). ESPN gives each side its
  // own linescores array; a home team that never batted in the 9th has one
  // fewer entry than the visitor, so the column count is the LONGER of the two
  // and the short side renders a blank rather than a zero.
  function linescoreOf(home, away) {
    const hv = (home.linescores || []).map(l => l.value);
    const av = (away.linescores || []).map(l => l.value);
    if (!hv.length && !av.length) return null;
    return {
      innings: Math.max(hv.length, av.length),
      home: hv, away: av,
      homeR: home.score || '', awayR: away.score || '',
      homeH: statNum(home, 'hits'), awayH: statNum(away, 'hits'),
      homeE: statNum(home, 'errors'), awayE: statNum(away, 'errors'),
    };
  }

  // Per-game leaders (API-map item 4) -- who is having a big game in THIS
  // game, as opposed to the season-wide `leaders` segment. `competition.
  // leaders` is populated once a game is under way; before that each
  // competitor carries its own season leaders, which is the closest true
  // equivalent for a pre-game card.
  //
  // Category naming is inconsistent across sports and sometimes useless:
  // MLB returns one category literally called "MLB Rating" whose displayValue
  // is already a full line ("2-3, HR, RBI, R"). Any *Rating category keeps its
  // value and drops its label rather than printing "MLB RATING" on the panel.
  function leaderRows(comp, home, away) {
    // Two shapes, and they differ in a way that matters: competition.leaders
    // entries name their own team, competitor.leaders entries do NOT -- the
    // owning competitor IS the team, implicitly. Carrying the owner through
    // fixes the pre-game card rendering a blank logo slot (caught on a real
    // render, not by reading the code).
    const src = (comp.leaders || []).length
      ? (comp.leaders || []).map(cat => ({ cat, owner: null }))
      : [].concat(
        (away.leaders || []).map(cat => ({ cat, owner: away })),
        (home.leaders || []).map(cat => ({ cat, owner: home })));
    const rows = [];
    for (const entry of src) {
      const cat = entry.cat;
      const top = (cat.leaders || [])[0];
      if (!top || !top.athlete) continue;
      const rating = /rating/i.test(cat.name || '');
      const ownTeam = (entry.owner && entry.owner.team) || null;
      rows.push({
        cat: rating ? '' : (cat.displayName || cat.name || '').toUpperCase(),
        player: (top.athlete.shortName || top.athlete.displayName || '').toUpperCase(),
        jersey: top.athlete.jersey || '',
        pos: ((top.athlete.position || {}).abbreviation || '').toUpperCase(),
        stat: (top.displayValue || '').toUpperCase(),
        headshot: (top.athlete.headshot && (top.athlete.headshot.href || top.athlete.headshot)) || '',
        teamAbbr: (((top.team || {}).abbreviation) || (ownTeam && ownTeam.abbreviation) || '').toUpperCase(),
        logo: (top.team && top.team.logo) || (ownTeam && ownTeam.logo) || '',
      });
      if (rows.length >= 3) break;
    }
    return rows;
  }

  function parseEvent(ev, league) {
    const comp = (ev.competitions || [{}])[0];
    const teams = comp.competitors || [];
    const home = teams.find(t => t.homeAway === 'home') || {};
    const away = teams.find(t => t.homeAway === 'away') || {};
    const st = comp.status || {};
    return {
      name: ev.name || '',
      id: ev.id || null,   // event id — the scoring-play lookup needs it
      // Date and time are separate fields on purpose — the renderer puts them on
      // different rows, and splitting one combined string back apart was fragile.
      shortDate: shortDateOf(ev.date),
      shortTime: shortTimeOf(ev.date),
      ts: ev.date ? new Date(ev.date).getTime() : 0, // raw, for the recency filter
      michigan: isMichigan(home, away),
      state: (st.type && st.type.state) || 'pre',
      period: st.period || 0,
      clock: st.displayClock || '',
      detail: (st.type && st.type.shortDetail) || '',
      homeTeam: (home.team && home.team.abbreviation) || '?',
      awayTeam: (away.team && away.team.abbreviation) || '?',
      // Wordmark names for the intro trail ("LAKERS" not "LAL") — shortDisplayName
      // is the nickname alone; falls back to the abbr for internationals.
      homeName: (home.team && (home.team.shortDisplayName || home.team.abbreviation)) || '',
      awayName: (away.team && (away.team.shortDisplayName || away.team.abbreviation)) || '',
      homeId: (home.team && home.team.id) || null,
      awayId: (away.team && away.team.id) || null,
      homeScore: home.score || '',
      awayScore: away.score || '',
      homeLogo: (home.team && home.team.logo) || '',
      awayLogo: (away.team && away.team.logo) || '',
      homeColor: '#' + ((home.team && home.team.color) || '444444'),
      awayColor: '#' + ((away.team && away.team.color) || '444444'),
      homeRank: rankOf(home),
      awayRank: rankOf(away),
      homeRecord: recordOf(home),
      awayRecord: recordOf(away),
      // City only (not the full "Tampa Bay Rays") for the pre-game card's
      // location line -- the wordmark already carries the team identity.
      homeLocation: (home.team && home.team.location) || '',
      awayLocation: (away.team && away.team.location) || '',
      broadcast: broadcastOf(comp),
      // API-map items 1 / 3 / 8 / 5 / 4 (2026-08-10). All ride the scoreboard
      // response the ticker already fetches -- no extra call, no extra quota.
      venue: venueOf(comp),
      headline: headlineOf(comp),
      notes: notesOf(comp),
      linescore: league === 'MLB' ? linescoreOf(home, away) : null,
      gameLeaders: leaderRows(comp, home, away).map(r => Object.assign(r, {
        // ESPN's leader entries often carry only a team $ref, not a logo. Both
        // teams in the game are right here, so resolve it locally instead of
        // firing a second request per leader.
        logo: r.logo ||
          (r.teamAbbr === ((home.team && home.team.abbreviation) || '') ? (home.team && home.team.logo) : '') ||
          (r.teamAbbr === ((away.team && away.team.abbreviation) || '') ? (away.team && away.team.logo) : '') || '',
      })),
      // MLB H/E flanking columns on the live card (Glance's classic MLB layout)
      homeHE: league === 'MLB' ? { h: statNum(home, 'hits'), e: statNum(home, 'errors') } : null,
      awayHE: league === 'MLB' ? { h: statNum(away, 'hits'), e: statNum(away, 'errors') } : null,
      conference: confOf(league, (home.team && home.team.abbreviation) || '', (away.team && away.team.abbreviation) || ''),
      redZone: !!((comp.situation || {}).isRedZone),
      situation: situationText(comp, league, home, away),
      // Structured live detail for the big live card. ESPN gives onFirst/onSecond/
      // onThird as false when empty and an object (the runner) when occupied, so
      // coerce rather than pass through.
      live: liveDetail(comp, league),
      lastPlay: ((comp.situation || {}).lastPlay || {}).text || '',

      favorite: false, // set in fetchScores() once settings are known -- true if EITHER team is a favorite
      awayFavorite: false, homeFavorite: false, // per-side, set in fetchScores() -- drives which side gets a wordmark
      wordmarkModes: null, // set in fetchScores() once settings are known
      league,
    };
  }

  // ESPN's bare /scoreboard serves ONE WEEK — whichever week that league's own
  // pointer is on — not "what's coming up". That is fine for a league playing
  // daily (MLB serves today's slate) and silently empty for a league between
  // weeks. Measured 2026-08-11, the day Jeff asked why he was seeing no NFL:
  //   /football/nfl/scoreboard              -> 1 event, CAR vs ARI, Aug 7 (played)
  //   /football/nfl/scoreboard?dates=RANGE  -> 32 events, Aug 13 onward
  // The one stale event was then dropped by clipToWindow's 3-day post-game age
  // cap, so NFL contributed exactly zero cards while the whole preseason was
  // days away. The tape claims a 2-week window, so it has to ASK for one.
  function espnRange(days) {
    const fmt = t => {
      const d = new Date(t);
      return String(d.getFullYear()) +
             String(d.getMonth() + 1).padStart(2, '0') +
             String(d.getDate()).padStart(2, '0');
    };
    const now = Date.now();
    return fmt(now) + '-' + fmt(now + days * 86400000);
  }
  // Only applied to the FALLBACK fetch: a range request on a daily league would
  // return every game in a fortnight (MLB ~200), which is not what the tape
  // wants. Capped so a fortnight of one league can't swamp the lap.
  //
  // FAVOURITES ARE EXEMPT, and that exemption is the whole lesson here. The
  // first version was a blind "earliest 8 by kickoff" slice, which is how Jeff
  // lost the Giants hours after I "fixed" NFL: MIN@NYG is the 11th kickoff of
  // the preseason window, so it fell outside the 8 along with the Bears, Chiefs,
  // Cowboys and Commanders — every one of them a favourite. Every other stage of
  // this pipeline protects favourites (clipToWindow keeps them however far out);
  // a cap that doesn't is just a silent truncation wearing a constant's name.
  const RANGE_MAX = 8;
  function usefulNow(games) {
    const now = Date.now();
    const horizon = now + WINDOW_DAYS * 86400000;
    return games.some(g =>
      g.state === 'in' ||
      (g.state === 'pre' && g.ts && g.ts <= horizon) ||
      (g.state === 'post' && g.ts && now - g.ts < 3 * 86400000));
  }
  // `isFave` is passed in by fetchScores so the cap below can protect favourite
  // teams. It has to arrive HERE rather than being applied after the fact: the
  // cap throws games away before fetchScores ever sees them, so a favourite
  // filter downstream would be filtering a list its team was already cut from.
  async function fetchLeague(path, league, isFave) {
    try {
      const d = await getJSON(`${ESPN}/${path}/scoreboard`);
      const games = (d.events || []).map(e => parseEvent(e, league));
      if (usefulNow(games)) return games;
      // Nothing live, nothing upcoming inside the window, nothing recent — this
      // league's week pointer is parked somewhere useless. Ask for the window
      // explicitly instead of accepting the empty answer.
      //
      // Its OWN try/catch, deliberately: the first version let this share the
      // outer one, so when the ranged request failed the whole league returned
      // [] and the perfectly good default games went with it. That cost NCAAB
      // its 2 cards the moment this shipped — caught by re-running fetchScores
      // and diffing the per-league counts against the before, not by reading it
      // back. A failed enrichment must never be worse than not enriching.
      try {
        const r = await getJSON(`${ESPN}/${path}/scoreboard?dates=${espnRange(WINDOW_DAYS)}`);
        const ranged = (r.events || []).map(e => parseEvent(e, league));
        if (!ranged.length) return games;
        ranged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        // Every favourite's game survives, however late in the window it sits;
        // the cap then fills the rest with the earliest kickoffs.
        const fav = isFave ? ranged.filter(g => isFave(g)) : [];
        const rest = ranged.filter(g => fav.indexOf(g) === -1).slice(0, RANGE_MAX);
        return fav.concat(rest).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      } catch (e) { return games; }
    } catch (e) { return []; }
  }


  async function fetchStocks() {
    const d = await fetchWithFallback('stocks.json');
    if (!Array.isArray(d)) return [];
    // Favorite stocks (settings, 2026-07-22): same tagging pattern as favorite
    // teams, checked in render.js's compose() so favorited symbols always
    // survive the rotation window instead of only showing when their turn
    // in the window comes up. Custom-added tickers count as favorited too --
    // the whole point of hand-typing one in is to actually see it, not join a
    // ~90-symbol pool it might rarely rotate into.
    const settings = await getSettings();
    const faves = new Set(
      [...(settings.favoriteStocks || []), ...(settings.customStocks || [])].map(s => String(s).toUpperCase()));
    d.forEach(s => { s.favorite = faves.has(String(s.sym || '').toUpperCase()); });
    return d;
  }

  // Dow/S&P/NASDAQ index cards (settings, 2026-07-22) -- their own segment,
  // not mixed into the stock rotation above.
  async function fetchIndices() {
    const d = await fetchWithFallback('indices.json');
    return Array.isArray(d) ? d : [];
  }


  // Only show games that are actually near-term. ESPN serves each league's
  // current/next scheduled week, which out of season means a wall of games
  // months away: in mid-July, 99 of 135 games were college football scheduled
  // for late Aug/Sep. Clipping to a 2-week window kills that wall — but it would
  // also delete football entirely until mid-August, so two escape hatches keep
  // the tape from going silent:
  //   - the next KEEP_PER_LEAGUE games of every league survive regardless of date
  //   - Michigan always survives, however far out it is
  const WINDOW_DAYS = 14;
  const KEEP_PER_LEAGUE = 2;

  function clipToWindow(games) {
    const now = Date.now();
    const horizon = now + WINDOW_DAYS * 86400000;
    const live = games.filter(g => g.state === 'in');
    // "Just-finished" must mean RECENT: off-season leagues serve their last
    // played week, so without an age cap a April championship final rode the
    // tape in July (CONN@MICH, caught by Jeff on the bar).
    const post = games.filter(g =>
      g.state === 'post' && g.ts && now - g.ts < 3 * 86400000).slice(0, 2);
    const pre = games.filter(g => g.state === 'pre').sort((a, b) => a.ts - b.ts);

    const soon = pre.filter(g => g.ts && g.ts <= horizon);
    const keep = new Set(soon);
    pre.slice(0, KEEP_PER_LEAGUE).forEach(g => keep.add(g)); // next few, however far out
    pre.filter(g => g.michigan).forEach(g => keep.add(g));   // Michigan always
    pre.filter(g => g.favorite).forEach(g => keep.add(g));   // settings favorite team(s) always
    const upcoming = pre.filter(g => keep.has(g));

    return live.concat(upcoming, post);
  }

  async function fetchScores() {
    const settings = await getSettings();
    // Missing key -> on by default, so a settings.json that predates a league
    // (or simply hasn't been touched yet) never silently hides it.
    const enabled = SPORTS.filter(([, , league]) => settings.sports[league] !== false);
    // Wordmarks-optional (settings): off means every pre/post card falls back
    // to the plain round-logo layout EXCEPT favorites, which keep their real
    // wordmark regardless -- that's the whole point of favoriting a team in
    // this mode. Stamped per-game like `favorite`, checked in render.js.
    // Wordmark MODES (2026-08-10): checkboxes that OR together — LIVE games,
    // FAVORITE teams, EVERYWHERE; none ticked means no wordmarks at all.
    // Back-compat with the old single boolean: `wordmarks: true` meant
    // "favorites get their wordmark", which is exactly {favorites: true}.
    const wordmarkModes = settings.wordmarkModes ||
      (settings.wordmarks === false ? {} : { favorites: true });
    const perLeague = await Promise.all(enabled.map(async ([path, , league]) => {
      // Favourites are resolved BEFORE the fetch now, so fetchLeague's range cap
      // can protect them (see RANGE_MAX). Resolving them after meant the cap had
      // already discarded the Giants before anything knew they mattered.
      //
      // Match on abbreviation OR nickname, case-insensitive: the settings
      // button-picker stores abbreviations, but favorites typed by hand
      // before that existed (or migrated from it) are team names/nicknames
      // ("GIANTS", "STANFORD") which never match an ESPN abbreviation --
      // checking both keeps those working instead of silently no-op'ing.
      const faves = ((settings.favorites && settings.favorites[league]) || []).map(f => f.toUpperCase());
      const isFave = t => faves.includes((t.team || '').toUpperCase()) || faves.includes((t.name || '').toUpperCase());
      const gameHasFave = g => isFave({ team: g.awayTeam, name: g.awayName }) ||
                               isFave({ team: g.homeTeam, name: g.homeName });
      const games = await fetchLeague(path, league, faves.length ? gameHasFave : null);
      games.forEach(g => { g.wordmarkModes = wordmarkModes; });
      // Per-side flags (2026-07-22): a favorited team gets its wordmark, the
      // OTHER side doesn't just because it happens to be playing a favorite --
      // Jeff: "only your team with its wordmark not also the team its playing."
      // g.favorite (either side) stays for the extra-repeats budget below.
      if (faves.length) games.forEach(g => {
        g.awayFavorite = isFave({ team: g.awayTeam, name: g.awayName });
        g.homeFavorite = isFave({ team: g.homeTeam, name: g.homeName });
        g.favorite = g.awayFavorite || g.homeFavorite;
      });
      return clipToWindow(games);
    }));
    return perLeague.flat();
  }

  const _sparkCache = {}; // id -> {at, points}; CoinGecko free tier is IP-rate-limited
  async function coinSpark(id) {
    const c = _sparkCache[id];
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.points;
    try {
      const d = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=1`);
      const prices = (d.prices || []).map(p => p[1]);
      const step = Math.max(1, Math.floor(prices.length / 28));
      const points = prices.filter((_, i) => i % step === 0).slice(-28);
      _sparkCache[id] = { at: Date.now(), points };
      return points;
    } catch (e) { return (c && c.points) || []; }
  }

  async function fetchCrypto() {
    try {
      const ids = COINS.map(c => c[0]).join(',');
      // coins/markets gives price + 24h change + logo image + 7d sparkline in one call
      const d = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`);
      const meta = {}, order = {};
      COINS.forEach(([id, sym, color], i) => { meta[id] = { sym, color }; order[id] = i; });
      return (d || [])
        .sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99))
        .map(c => {
          const m = meta[c.id] || { sym: (c.symbol || '').toUpperCase(), color: '#888' };
          const s = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
          const step = Math.max(1, Math.floor(s.length / 28));
          return {
            sym: m.sym, color: m.color,
            price: c.current_price,
            change: c.price_change_percentage_24h || 0,
            spark: s.filter((_, i) => i % step === 0).slice(-28),
            logoUrl: c.image || null,
          };
        });
    } catch (e) { return []; }
  }

  // General news, not just sports — BBC/NPR/NYT/HN/ESPN via the server (RSS has
  // no CORS headers, so it can't be fetched from the page). Each item is
  // {cat, text} so the tape can tag WORLD / US / TECH / BIZ / SPORTS.
  async function fetchNews() {
    try {
      const d = await getJSON('/api/news.json');
      if (Array.isArray(d) && d.length) return d;
    } catch (e) { /* fall through to the sports-only feed */ }
    try {
      const d = await getJSON(`${ESPN}/football/nfl/news`);
      return (d.articles || []).slice(0, 4).map(a => ({ cat: 'SPORTS', text: a.headline })).filter(x => x.text);
    } catch (e) { return []; }
  }

  // Michigan (Jeff's school): next/live game + the block M, for the GO BLUE segment.
  async function fetchMichigan() {
    const out = { logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/130.png', game: null };
    for (const path of ['football/college-football', 'basketball/mens-college-basketball']) {
      try {
        const d = await getJSON(`${ESPN}/${path}/teams/130/schedule`);
        const evs = (d.events || []);
        const now = Date.now();
        const next = evs.find(e => new Date(e.date).getTime() > now) || evs[evs.length - 1];
        if (!next) continue;
        const comp = (next.competitions || [])[0] || {};
        const cs = comp.competitors || [];
        const mich = cs.find(c => (c.team && String(c.team.id)) === '130');
        const opp = cs.find(c => (c.team && String(c.team.id)) !== '130');
        out.game = {
          opp: (opp && opp.team && (opp.team.abbreviation || opp.team.shortDisplayName)) || 'TBD',
          oppLogo: (opp && opp.team && opp.team.logos && opp.team.logos[0] && opp.team.logos[0].href) || '',
          home: !!(mich && mich.homeAway === 'home'),
          date: new Date(next.date).toLocaleDateString([], { month: 'numeric', day: 'numeric' }),
          sport: path.indexOf('football') >= 0 ? 'FOOTBALL' : 'BASKETBALL',
        };
        break;
      } catch (e) { /* try next sport */ }
    }
    return out;
  }

  const WX_CODES = {
    0: 'CLEAR', 1: 'MOSTLY CLEAR', 2: 'PARTLY CLOUDY', 3: 'OVERCAST',
    45: 'FOG', 48: 'FOG', 51: 'DRIZZLE', 53: 'DRIZZLE', 55: 'DRIZZLE',
    61: 'LIGHT RAIN', 63: 'RAIN', 65: 'HEAVY RAIN', 66: 'FREEZING RAIN', 67: 'FREEZING RAIN',
    71: 'LIGHT SNOW', 73: 'SNOW', 75: 'HEAVY SNOW', 77: 'SNOW',
    80: 'SHOWERS', 81: 'SHOWERS', 82: 'HEAVY SHOWERS',
    95: 'T-STORMS', 96: 'T-STORMS', 99: 'T-STORMS',
  };

  // Fraction of the synodic month -> phase name + a 0-7 icon index.
  function moonPhase(date) {
    const synodic = 29.53058867;
    const known = Date.UTC(2000, 0, 6, 18, 14) / 86400000; // known new moon (days)
    const now = date.getTime() / 86400000;
    let age = ((now - known) % synodic + synodic) % synodic;
    const frac = age / synodic;
    const names = ['NEW', 'WAX CRESC', 'FIRST QTR', 'WAX GIB', 'FULL', 'WAN GIB', 'LAST QTR', 'WAN CRESC'];
    const idx = Math.round(frac * 8) % 8;
    return { idx, name: names[idx], illum: Math.round((1 - Math.abs(1 - frac * 2)) * 100) };
  }
  const AQI_BANDS = [
    [50, 'GOOD', '#4ade80'], [100, 'MODERATE', '#e6c832'], [150, 'UNHEALTHY SG', '#f0a030'],
    [200, 'UNHEALTHY', '#f87171'], [300, 'V UNHEALTHY', '#a855f7'], [1e9, 'HAZARDOUS', '#b91c1c'],
  ];
  function aqiBand(v) {
    if (v == null) return null;
    const b = AQI_BANDS.find(x => v <= x[0]) || AQI_BANDS[AQI_BANDS.length - 1];
    return { value: Math.round(v), label: b[1], color: b[2] };
  }

  // WHO UV index bands, as the reference panel labels them (UV:LOW / MOD / ...).
  function uvBand(v) {
    if (v == null) return null;
    const b = v <= 2 ? 'LOW' : v <= 5 ? 'MOD' : v <= 7 ? 'HIGH' : v <= 10 ? 'VHIGH' : 'EXTREME';
    return { value: Math.round(v), label: b };
  }

  async function fetchAqi(home) {
    try {
      const d = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${home.lat}&longitude=${home.lon}&current=us_aqi&timezone=auto`);
      return aqiBand((d.current || {}).us_aqi);
    } catch (e) { return null; }
  }

  function hhmm(iso) {
    // Open-Meteo returns local ISO like 2026-07-15T05:34
    const t = (iso || '').split('T')[1] || '';
    const [h, m] = t.split(':');
    if (h == null) return '';
    let hr = +h, ap = hr >= 12 ? 'P' : 'A';
    hr = hr % 12 || 12;
    return hr + ':' + m + ap;
  }

  async function fetchWeather() {
    try {
      const home = await getHome();
      const [d, aqi] = await Promise.all([
        getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${home.lat}&longitude=${home.lon}&current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature,wind_speed_10m,uv_index&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset&forecast_days=5&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`),
        fetchAqi(home),
      ]);
      const c = d.current || {};
      const dd = d.daily || {};
      // Next 12 hours of temperature, for the weather card's sparkline
      // (API-map item 16). Open-Meteo's hourly array starts at midnight of day
      // 0 regardless of the current time, so seek forward to now rather than
      // slicing from 0 -- otherwise an evening reading would sparkline the
      // morning that already happened. timezone=auto means these stamps are
      // local wall-clock with no offset, which is what new Date() assumes.
      const hh = d.hourly || {};
      const hTimes = hh.time || [], hTemps = hh.temperature_2m || [];
      let i0 = hTimes.findIndex(t => new Date(t).getTime() >= Date.now());
      if (i0 < 0) i0 = 0;
      const hourly = hTemps.slice(i0, i0 + 12)
        .filter(v => typeof v === 'number').map(v => Math.round(v));
      const days = (dd.time || []).map((t, i) => ({
        day: new Date(t + 'T12:00').toLocaleDateString([], { weekday: 'short' }).toUpperCase().slice(0, 3),
        hi: Math.round((dd.temperature_2m_max || [])[i]),
        lo: Math.round((dd.temperature_2m_min || [])[i]),
        code: (dd.weather_code || [])[i],
      }));
      return {
        label: home.label,
        city: home.short,
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        humidity: Math.round(c.relative_humidity_2m),
        wind: Math.round(c.wind_speed_10m),
        desc: WX_CODES[c.weather_code] || '',
        code: c.weather_code,
        hi: days[0] && days[0].hi,
        lo: days[0] && days[0].lo,
        sunrise: hhmm((dd.sunrise || [])[0]),
        sunset: hhmm((dd.sunset || [])[0]),
        moon: moonPhase(new Date()),
        aqi,
        uv: uvBand(c.uv_index),
        hourly,
        days,
      };
    } catch (e) { return null; }
  }

  // Top coins by market cap (Glance "Top Market Cap"). One call = price + 24h
  // change + logo + sparkline, CORS-clean.
  async function fetchTopCoins() {
    try {
      const d = await getJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=8&page=1&sparkline=true&price_change_percentage=24h');
      return (d || []).map(c => {
        const s = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
        const step = Math.max(1, Math.floor(s.length / 28));
        return {
          sym: (c.symbol || '').toUpperCase(), color: '#888',
          price: c.current_price, change: c.price_change_percentage_24h || 0,
          spark: s.filter((_, i) => i % step === 0).slice(-28), logoUrl: c.image || null,
        };
      });
    } catch (e) { return []; }
  }

  // League standings (Glance "Standings"): top teams per division/conference.
  // A sport switched OFF in Settings must be off everywhere, not just on the
  // game cards (2026-08-11). Jeff has MLS off and MLS standings were still
  // riding the tape: only fetchScores consulted settings.sports, so standings,
  // leaders and the AP poll each ran their own hardcoded league list. Missing
  // key still means ON, same convention as everywhere else.
  async function leagueOn(lg) {
    const s = await getSettings();
    return !s.sports || s.sports[lg] !== false;
  }

  async function fetchStandings() {
    const leagues = (await Promise.all(
      [['baseball/mlb', 'MLB'], ['basketball/wnba', 'WNBA'], ['soccer/eng.1', 'EPL'], ['soccer/usa.1', 'MLS']]
        .map(async l => (await leagueOn(l[1])) ? l : null))).filter(Boolean);
    const out = [];
    await Promise.all(leagues.map(async ([path, lg]) => {
      try {
        const d = await getJSON(`https://site.api.espn.com/apis/v2/sports/${path}/standings`);
        const groups = d.children && d.children.length ? d.children : [d];
        groups.slice(0, 4).forEach(grp => {
          const name = (grp.name || lg).replace(/division/i, '').trim().toUpperCase();
          const rows = (((grp.standings || {}).entries) || []).slice(0, 4).map(e => {
            const st = {};
            (e.stats || []).forEach(s => { st[s.name] = (s.displayValue != null ? s.displayValue : s.value); });
            return {
              team: (e.team && e.team.abbreviation) || '?',
              logo: (e.team && e.team.logos && e.team.logos[0] && e.team.logos[0].href) || '',
              wins: st.wins, losses: st.losses,
            };
          });
          if (rows.length) out.push({ league: lg, label: (lg + ' ' + name).slice(0, 12), rows });
        });
      } catch (e) { /* league out of season / no standings */ }
    }));
    return out;
  }

  // Trivia (Glance "Trivia"): Open Trivia DB, free + CORS-open. Entities decoded.
  function decodeEntities(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s || '';
    return t.value;
  }
  // Category toggles (2026-08-10 brain dump: "just like how in the news you can
  // toggle what you want to see you should be able to toggle what trivia
  // categories you want"). OpenTDB has no multi-category query, so pull a wider
  // batch and filter client-side on the category name it returns. Nothing
  // enabled -> everything, same missing-key-means-on convention as sports/news.
  function triviaCatKey(name) {
    return String(name || '').replace(/^[^:]+:\s*/, '').toUpperCase().trim();
  }
  // OpenTDB is a MULTIPLE-CHOICE bank and the tape only ever draws the question
  // and the answer -- there is nowhere to put four options on a 32-row strip.
  // Most of its questions are self-contained ("What is the capital of France?")
  // and read fine, but a chunk of them are written to be answered by picking
  // from a list: "Which of the following is NOT a noble gas?", "Pick the best
  // answer", answers that are literally "All of the above". Those are unreadable
  // on the ticker no matter how well the card is laid out, because the thing
  // they refer to was never on screen. Jeff, 2026-08-14: "make sure those type
  // of questions dont come up again."
  //
  // Dropped rather than rewritten: turning "which of the following" into a
  // standalone question means inventing the missing context, and a trivia card
  // that quietly changes the question is worse than one fewer card.
  const TRIVIA_NEEDS_OPTIONS = [
    /\bwhich (one )?of (the )?(the )?(following|these|those)\b/i,
    /\bof the following\b/i,
    /\b(all|none|both) of the (above|following)\b/i,
    /\b(pick|choose|select|identify) (the|which|one|any|all)\b/i,
    /\bbest answer\b/i,
    /\bthe following (is|are|was|were|statements?|options?|answers?)\b/i,
    /\bfrom the (list|options|choices)\b/i,
    /\bnot listed\b/i,
  ];
  // The answer is checked too: a question can read perfectly well on its own and
  // still have "All of the above" as its correct answer, which is nonsense with
  // no options above it.
  const triviaNeedsOptions = t =>
    TRIVIA_NEEDS_OPTIONS.some(re => re.test(t.q)) ||
    /^\s*(all|none|both) of (the )?(above|these|them)\s*$/i.test(t.a) ||
    /^\s*(a|b|c|d)\s*(and|&)\s*(a|b|c|d)\s*$/i.test(t.a);
  // Same problem, different cause: the card hard-truncates the question at 90
  // characters and the answer at 40, so a longer one renders cut off mid-word
  // ("...what is the name of Clementine's fat") and is exactly as unanswerable
  // as a question missing its options. Measured on 200 live questions: 17% of
  // the option-filtered pool is over 90. The pool is far bigger than the five
  // questions a batch needs, so dropping them costs nothing a viewer can see.
  // Kept in sync with render.js's TRIVIA_Q_MAX/TRIVIA_A_MAX slices.
  const TRIVIA_Q_MAX = 90, TRIVIA_A_MAX = 40;
  const triviaTooLong = t => t.q.length > TRIVIA_Q_MAX || t.a.length > TRIVIA_A_MAX;
  async function fetchTrivia() {
    try {
      const settings = await getSettings();
      const picked = settings.triviaCats || {};
      const wanted = Object.keys(picked).filter(k => picked[k]);
      // 40 not 20: option-dependent AND over-long questions are dropped below
      // (~14% and ~17% of a batch), and the survivors still have to yield five
      // after the category filter too.
      const d = await getJSON('https://opentdb.com/api.php?amount=40&type=multiple');
      const all = (d.results || []).map(q => ({
        q: decodeEntities(q.question), a: decodeEntities(q.correct_answer),
        cat: decodeEntities(q.category),
      })).filter(t => t.q && t.a && !triviaNeedsOptions(t) && !triviaTooLong(t));
      if (!wanted.length) return all.slice(0, 5);
      const want = new Set(wanted.map(triviaCatKey));
      const hit = all.filter(t => want.has(triviaCatKey(t.cat)));
      // A batch with none of the wanted categories would blank the segment;
      // fall back to the unfiltered batch rather than showing nothing. `all` is
      // already option-filtered, so the fallback can't smuggle one back in.
      return (hit.length ? hit : all).slice(0, 5);
    } catch (e) { return []; }
  }

  // --- The play that actually scored ----------------------------------------
  // The scoreboard's situation.lastPlay is the most recent play AT POLL TIME,
  // not the play that produced the score change we just detected. Poll a
  // touchdown up to a minute late and lastPlay has already moved on to the
  // extra point, a timeout, or the kickoff -- which is why the takeover said
  // TOUCHDOWN and then showed "2 POINT RUN" or "TIME OUT" underneath it
  // (2026-08-14, Jeff: "im a little confused on the touchdown animation").
  //
  // The summary endpoint carries scoringPlays[], and every entry states the
  // score AFTER it. Matching on the new score identifies the scoring play
  // exactly -- no guessing from timestamps or play text.
  const LEAGUE_PATH = {};
  SPORTS.forEach(([path, , league]) => { LEAGUE_PATH[league] = path; });
  async function fetchScoringPlay(league, gameId, awayScore, homeScore) {
    const path = LEAGUE_PATH[league];
    if (!path || !gameId) return null;
    try {
      const d = await getJSON(`${ESPN}/${path}/summary?event=${gameId}`);
      const plays = d.scoringPlays || [];
      // Last match, not first: a game can reach the same score twice (3-0 in
      // the 1st, 3-0 again after a reversal), and the one we just detected is
      // the later one.
      let hit = null;
      for (const p of plays) {
        if (String(p.awayScore) === String(awayScore) && String(p.homeScore) === String(homeScore)) hit = p;
      }
      if (!hit) return null;
      return {
        text: hit.text || '',
        type: (hit.type && hit.type.text) || '',
        teamId: (hit.team && hit.team.id) || null,
        period: (hit.period && hit.period.number) || 0,
        clock: (hit.clock && hit.clock.displayValue) || '',
      };
    } catch (e) { return null; }
  }

  function lastName(n) {
    const p = (n || '').trim().split(' ');
    return (p[p.length - 1] || n || '').toUpperCase();
  }

  // Golf (Glance "Golf"): live tournament leaderboard, top players + score.
  async function fetchGolf() {
    try {
      const d = await getJSON('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
      const ev = (d.events || []).find(e => (e.competitions || [])[0] && (e.competitions[0].competitors || []).length) || {};
      const comp = (ev.competitions || [])[0] || {};
      const leaders = (comp.competitors || []).slice()
        .sort((a, b) => (a.order || 99) - (b.order || 99)).slice(0, 5)
        .map(c => ({ pos: c.order, player: lastName(c.athlete && c.athlete.displayName), score: c.score }));
      if (!leaders.length) return null;
      return { name: (ev.shortName || ev.name || 'PGA').toUpperCase(), leaders };
    } catch (e) { return null; }
  }

  // Racing (Glance "Racing"): F1/NASCAR event + top positions when running.
  // Circuit detail for the F1 card (API-map item 14).
  //
  // NOT on the scoreboard. Verified 2026-08-10 against both an upcoming race
  // (Dutch GP) and a completed one (Hungarian GP): the site-API competition has
  // no `circuit` key at all, so the API map's claim that "F1's event carries a
  // circuit object" was wrong about WHERE. It lives on the core API behind a
  // $ref hop -- events/{id} -> circuit.$ref -> the circuit document, which does
  // carry the full spec (Hungaroring / Budapest / Hungary / 4.381 km / 14 turns
  // / 70 laps).
  //
  // Two extra requests, so it's cached by event id for the life of the page: a
  // circuit is a fixed property of an event, and fetchRacing runs on the 60s
  // scores timer. The cache slot is claimed BEFORE the awaits so a failing
  // lookup negative-caches instead of re-firing every minute forever.
  const _circuit = {};
  async function fetchCircuit(eventId) {
    if (!eventId) return null;
    if (Object.prototype.hasOwnProperty.call(_circuit, eventId)) return _circuit[eventId];
    _circuit[eventId] = null;
    try {
      const e = await getJSON(`https://sports.core.api.espn.com/v2/sports/racing/leagues/f1/events/${eventId}`);
      const ref = e.circuit && e.circuit.$ref;
      if (!ref) return null;
      const ci = await getJSON(ref.replace(/^http:/, 'https:'));
      _circuit[eventId] = {
        name: (ci.fullName || '').toUpperCase(),
        city: (((ci.address || {}).city) || '').toUpperCase(),
        country: (((ci.address || {}).country) || '').toUpperCase(),
        length: ci.length || '',
        turns: ci.turns || null,
        laps: ci.laps || null,
      };
    } catch (err) { /* leave the negative cache in place */ }
    return _circuit[eventId];
  }

  async function fetchRacing() {
    for (const [path, label] of [['racing/f1', 'F1'], ['racing/nascar-premier', 'NASCAR']]) {
      try {
        const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
        const ev = (d.events || []).find(e => e.competitions) || (d.events || [])[0];
        if (!ev) continue;
        const comp = (ev.competitions || [])[0] || {};
        const status = (ev.status && ev.status.type && ev.status.type.shortDetail) || '';
        const leaders = (comp.competitors || []).slice()
          .sort((a, b) => (a.order || 99) - (b.order || 99)).slice(0, 5)
          .map(c => ({ pos: c.order, name: lastName((c.athlete && c.athlete.displayName) || (c.team && c.team.displayName)) }));
        // Constructor / car brand: ESPN has none anywhere (its F1 competitor is
        // {id, uid, type, order, winner, athlete, statistics} on the site
        // scoreboard, the core event AND the core competition -- all checked
        // 2026-08-10). Jeff asked for a real source rather than a hardcoded
        // driver->team table, so it comes from Jolpica-F1's current standings
        // via the server proxy; a mid-season seat change corrects itself.
        // Matched on surname, which is all ESPN gives us to key on.
        const circuit = label === 'F1' ? await fetchCircuit(ev.id) : null;
        if (label === 'F1' && leaders.length) {
          try {
            const teams = await fetchWithFallback('f1teams.json');
            if (teams && typeof teams === 'object') {
              leaders.forEach(l => {
                const hit = teams[(l.name || '').toUpperCase()];
                if (hit) { l.team = hit.team; l.code = hit.code; }
              });
            }
          } catch (e) { /* no constructors this lap; names still render */ }
        }
        return {
          series: label,
          name: (ev.shortName || ev.name || '').toUpperCase().slice(0, 18),
          status, leaders, circuit,
        };
      } catch (e) { /* try next series */ }
    }
    return null;
  }

  // "Dricus Du Plessis" -> "DU PLESSIS". lastName() above takes only the final
  // token, which mangles multi-word surnames into "PLESSIS"; fighters have them
  // often enough to matter.
  function surname(n) {
    const p = (n || '').trim().split(/\s+/);
    return (p.length > 1 ? p.slice(1).join(' ') : (p[0] || '')).toUpperCase();
  }

  // UFC — structurally unlike every other league here. ESPN returns ONE event
  // per fight card ("UFC Fight Night: Du Plessis vs. Usman") whose competitions
  // are the individual bouts, ordered prelims-first with the main event LAST
  // (hence the reverse). There are no teams or logos, just two athletes, so it
  // gets its own segment rather than the two-team scoreboard card.
  // A 5-round regulation format is the card's main/title bout; undercards are 3.
  async function fetchUfc() {
    try {
      const d = await getJSON(`${ESPN}/mma/ufc/scoreboard`);
      const ev = (d.events || []).find(e => (e.competitions || []).length);
      if (!ev) return null;
      const recOf = x => (((x.records || [])[0] || {}).summary || '');
      const fights = (ev.competitions || []).slice().reverse().slice(0, 4).map(c => {
        const cs = c.competitors || [];
        const a = cs.find(x => x.order === 1) || cs[0] || {};
        const b = cs.find(x => x.order === 2) || cs[1] || {};
        const st = (c.status || {}).type || {};
        return {
          red: surname((a.athlete || {}).displayName) || 'TBD',
          blue: surname((b.athlete || {}).displayName) || 'TBD',
          redFlag: (((a.athlete || {}).flag) || {}).href || null,
          blueFlag: (((b.athlete || {}).flag) || {}).href || null,
          redRec: recOf(a),
          blueRec: recOf(b),
          weight: ((c.type || {}).abbreviation || '').toUpperCase(),
          broadcast: ((((c.broadcasts || [])[0] || {}).names || [])[0] || '').toUpperCase(),
          title: ((((c.format || {}).regulation) || {}).periods || 3) >= 5,
          state: st.state || 'pre',
          winner: a.winner ? 'red' : b.winner ? 'blue' : null,
        };
      });
      if (!fights.length) return null;
      return {
        name: (ev.shortName || ev.name || 'UFC').toUpperCase(),
        date: shortDateOf(ev.date),
        time: shortTimeOf(ev.date),
        status: (((ev.status || {}).type) || {}).shortDetail || '',
        fights,
      };
    } catch (e) { return null; }
  }

  // --- League stat leaders (the "OFFENSIVE LEADERS" ticker cards) -----------
  // site/v3 leaders returns athlete + team + logos INLINE (the core-api variant
  // is $ref links needing one request per leader — useless here). Off-season
  // leagues return zero categories rather than erroring, so the same list works
  // year-round: fetch all, keep whichever leagues are actually in season.
  // NFL/CFB light up on their own in September.
  const LEADER_LEAGUES = [
    ['football/nfl', 'NFL'], ['baseball/mlb', 'MLB'], ['basketball/nba', 'NBA'],
    ['basketball/wnba', 'WNBA'], ['hockey/nhl', 'NHL'],
    ['football/college-football', 'NCAAF'],
  ];
  // Preferred categories where we know the good ones; otherwise first few.
  //
  // Widened 2026-08-10 (API-map item 12): the endpoint returns ~15 categories
  // per league and the ticker was showing 4, so defensive and pitching
  // categories -- sacks, interceptions, strikeouts, saves, steals, blocks --
  // never appeared at all. This does NOT lengthen the lap: compose() already
  // pulls the leaders queue through rotateWindow(.., 10), so a bigger pool
  // means more VARIETY across laps rather than more segments in one.
  const LEADER_CATS = {
    MLB: ['homeRuns', 'avg', 'RBIs', 'wins', 'ERA', 'strikeouts', 'saves', 'stolenBases'],
    NFL: ['passingYards', 'rushingYards', 'receivingYards', 'passingTouchdowns',
      'sacks', 'interceptions', 'totalTackles'],
    NCAAF: ['passingYards', 'rushingYards', 'receivingYards', 'passingTouchdowns', 'sacks'],
    NBA: ['pointsPerGame', 'reboundsPerGame', 'assistsPerGame',
      'stealsPerGame', 'blocksPerGame', 'threePointFieldGoalsMade'],
    WNBA: ['pointsPerGame', 'reboundsPerGame', 'assistsPerGame',
      'stealsPerGame', 'blocksPerGame'],
    NHL: ['points', 'goals', 'assists', 'saves', 'goalsAgainstAverage', 'plusMinus'],
  };
  const MAX_CATS_PER_LEAGUE = 7;

  // "0.334 AVG" -> ".334 AVG", "32 HR", "271.3 YDS" — the reference-ticker style.
  function fmtStat(value, abbrev) {
    if (value == null) return '';
    let v;
    if (value > 0 && value < 1) v = value.toFixed(3).replace(/^0/, '');
    else if (Number.isInteger(value)) v = String(value);
    else v = value.toFixed(1);
    return v + ' ' + (abbrev || '').toUpperCase();
  }

  function teamLogoOf(t) {
    if (!t) return null;
    if (Array.isArray(t.logos) && t.logos[0]) return t.logos[0].href || null;
    return t.logo || null;
  }

  async function fetchLeaders() {
    const out = [];
    const leagues = (await Promise.all(
      LEADER_LEAGUES.map(async l => (await leagueOn(l[1])) ? l : null))).filter(Boolean);
    await Promise.all(leagues.map(async ([path, lg]) => {
      try {
        const d = await getJSON(`https://site.web.api.espn.com/apis/site/v3/sports/${path}/leaders`);
        const cats = (((d || {}).leaders || {}).categories || [])
          .filter(c => (c.leaders || []).length);
        if (!cats.length) return; // out of season
        const want = LEADER_CATS[lg] || [];
        const picked = want.map(n => cats.find(c => c.name === n)).filter(Boolean);
        for (const c of cats) {
          if (picked.length >= MAX_CATS_PER_LEAGUE) break;
          if (!picked.includes(c)) picked.push(c);
        }
        picked.slice(0, MAX_CATS_PER_LEAGUE).forEach(c => {
          const rows = (c.leaders || []).slice(0, 2).map(l => {
            const ath = l.athlete || {};
            return {
              name: surname(ath.shortName || ath.displayName),
              team: ((l.team || ath.team || {}).abbreviation) || '',
              logo: teamLogoOf(l.team || ath.team),
              // Headshot (API-map item 12). Carried through so the render side
              // can swap it in for the team logo -- Jeff is picking off a real
              // render, since a photographic face at this size is the same
              // legibility risk that broke several wordmark extractions.
              headshot: (ath.headshot && (ath.headshot.href || ath.headshot)) || '',
              jersey: ath.jersey || '',
              value: fmtStat(l.value, c.abbreviation),
            };
          }).filter(r => r.name);
          if (rows.length) {
            out.push({ league: lg, cat: (c.displayName || c.name || '').toUpperCase(), rows });
          }
        });
      } catch (e) { /* league endpoint down — skip */ }
    }));
    return out;
  }

  // --- Team stat leaders ("TEAM STATS: 1. GIANTS 289.5 YDS") ------------------
  // statistics/byteam: a glossary of stat names per category, and per team the
  // parallel values/ranks arrays. We pick a stat, sort teams by it, take two.
  // Same output shape as fetchLeaders so the same renderer draws both.
  // MLB only for now: the stat names differ per sport and can't be verified for
  // football until its byteam data returns in September — don't guess names.
  const TEAM_STATS = {
    'baseball/mlb': { league: 'MLB', picks: [
      ['batting', 'homeRuns', 'TEAM HOME RUNS', 'HR', false, 0],
      ['batting', 'avg', 'TEAM BATTING AVG', 'AVG', false, 3],
      ['pitching', 'ERA', 'TEAM ERA', 'ERA', true, 2],
    ] },
  };

  async function fetchTeamStats() {
    const out = [];
    await Promise.all(Object.keys(TEAM_STATS).map(async path => {
      const cfg = TEAM_STATS[path];
      try {
        const d = await getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/${path}/statistics/byteam`);
        const glossary = d.categories || [];
        const teams = d.teams || [];
        if (!teams.length) return;
        for (const [cat, stat, label, unit, lowerBetter, dec] of cfg.picks) {
          const gc = glossary.find(c => c.name === cat);
          const idx = gc ? (gc.names || []).indexOf(stat) : -1;
          if (idx < 0) continue;
          const rows = teams.map(t => {
            const tc = (t.categories || []).find(c => c.name === cat) || {};
            return { team: t.team, v: ((tc.values || [])[idx]) };
          }).filter(r => r.v != null)
            .sort((a, b) => lowerBetter ? a.v - b.v : b.v - a.v)
            .slice(0, 2)
            .map(r => ({
              name: ((r.team || {}).abbreviation) || '?',
              team: '',
              logo: teamLogoOf(r.team),
              value: fmtTeamStat(r.v, unit, dec),
            }));
          if (rows.length) out.push({ league: cfg.league, cat: label, rows });
        }
      } catch (e) { /* out of season / endpoint down */ }
    }));
    return out;
  }
  function fmtTeamStat(v, unit, dec) {
    let s = dec === 3 ? v.toFixed(3).replace(/^0/, '') : dec ? v.toFixed(dec) : String(Math.round(v));
    return s + (unit && unit !== 'AVG' && unit !== 'ERA' ? ' ' + unit : '');
  }

  // --- College football Top 25 (AP poll) -------------------------------------
  async function fetchRankings() {
    if (!(await leagueOn('NCAAF'))) return null;   // AP poll is college football
    try {
      const d = await getJSON(`${ESPN}/football/college-football/rankings`);
      const poll = (d.rankings || []).find(r => /AP/i.test(r.name || '')) || (d.rankings || [])[0];
      if (!poll) return null;
      const entries = (poll.ranks || []).slice(0, 8).map(e => ({
        rank: e.current,
        abbr: ((e.team || {}).abbreviation) || '',
        logo: teamLogoOf(e.team),
        record: e.recordSummary || '',
      })).filter(e => e.abbr);
      if (!entries.length) return null;
      return { name: (poll.name || 'TOP 25').toUpperCase(), entries };
    } catch (e) { return null; }
  }

  // Spotify now-playing, via the server's proxy — the client secret must never
  // reach the page, and api.spotify.com sends no CORS headers for this endpoint.
  // null when nothing is playing (a normal state, not an error): the segment just
  // drops out of the tape until music comes back.
  // --- Glance-catalog apps (2026-07-17) -------------------------------------

  // Emergency Weather: active NWS alerts for home. api.weather.gov is keyless
  // and CORS-open, so this one skips the server. Empty = the segment drops out
  // (no alert is the normal state).
  async function fetchAlerts() {
    try {
      const home = await getHome();
      const d = await getJSON(`https://api.weather.gov/alerts/active?point=${home.lat},${home.lon}`);
      return (d.features || []).map(f => f.properties || {})
        .filter(p => /warning|watch|advisory/i.test(p.event || ''))
        .slice(0, 3)
        .map(p => ({
          event: (p.event || '').toUpperCase(),
          severe: /Severe|Extreme/.test(p.severity || ''),
          until: p.ends || p.expires || null,
        }));
    } catch (e) { return []; }
  }

  // Steam Top 10 (Glance "Top 10 Steam") — server proxy caches ranks + names.
  async function fetchSteam() {
    const d = await fetchWithFallback('steam.json');
    return Array.isArray(d) ? d : [];
  }

  // Overhead Flights (Glance's newest app) — aircraft near home, nearest first.
  async function fetchFlights() {
    const d = await fetchWithFallback('flights.json');
    return Array.isArray(d) ? d : [];
  }

  // Twitch Tracker — [] until Jeff registers the free dev app (keys.py).
  async function fetchTwitch() {
    const d = await fetchWithFallback('twitch.json');
    return Array.isArray(d) ? d : [];
  }

  // On This Day — Wikipedia's curated daily events (keyless, CORS-open).
  // Same no-grim rule as the news feeds (server GRIM_RE's little sibling —
  // the API's own top picks are routinely plane crashes and wars): filter,
  // keep short ones that fit a tape row, newest-century first for relevance.
  const GRIM_OTD = /\b(war|kill|dead|death|die[sd]?|bomb|missile|attack|shot|shoot|murder|massacre|crash|disaster|sank|sink|earthquake|fire|exploded?|terror|assassin)\b/i;
  async function fetchOnThisDay() {
    try {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const d = await getJSON(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`);
      return (d.selected || [])
        .filter(e => e.text && !GRIM_OTD.test(e.text) && e.text.length < 110)
        .sort((a, b) => (b.year || 0) - (a.year || 0))
        .slice(0, 4)
        .map(e => ({ year: e.year, text: e.text }));
    } catch (e) { return []; }
  }

  // NFL Draft (Glance's DRAFT ROUND card): live picks exist only draft week
  // (late April). ESPN's scoreboard has no draft feed; the renderer is built
  // and verified against mocks (render.js draftSegment) — wire the real feed
  // here when April comes. Until then: null, segment drops out.
  async function fetchDraft() { return null; }

  // Exposes the same settings object fetchScores() already reads internally,
  // so app.js can gate the Glance-catalog segment fetches (settings.segments)
  // without this module fetching /api/settings.json twice per cycle.
  async function fetchSettings() { return getSettings(); }

  async function fetchNowPlaying() {
    try {
      const r = await fetch('/api/nowplaying.json', { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.title ? d : null;
    } catch (e) { return null; }
  }

  window.TICKERDATA = { fetchScoringPlay, fetchScores, fetchCrypto, fetchNews, fetchWeather, fetchStocks, fetchIndices, fetchTopCoins, fetchStandings, fetchTrivia, fetchGolf, fetchRacing, fetchMichigan, fetchUfc, fetchNowPlaying, fetchLeaders, fetchRankings, fetchTeamStats, fetchAlerts, fetchSteam, fetchFlights, fetchTwitch, fetchDraft, fetchOnThisDay, fetchSettings };
})();
