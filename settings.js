/* Settings window — plain fetch()/POST to the same server data.js/render.js
 * already talk to (no Electron IPC needed; this page works standalone in any
 * browser too). Leagues here must match data.js's SPORTS array exactly.
 *
 * Favorite-team picker (2026-07-22): real team buttons instead of a free-text
 * box. Pro-league rosters come from the server's /api/teams proxy (ESPN's
 * teams endpoint has no CORS for a direct browser fetch, unlike scoreboard --
 * confirmed, not assumed) and load lazily on first expand, so opening
 * Settings doesn't fire 12 roster requests up front. College teams don't need
 * a fetch -- COLLEGE_CONFS below mirrors data.js's own COLLEGE map so the
 * button picker groups by the exact same conferences the tape itself uses
 * for separator labels. Keep the two in sync if that map ever changes. */
(function () {
  'use strict';

  const LEAGUES = [
    ['NFL', 'NFL', 'pro'],
    ['NBA', 'NBA', 'pro'],
    ['MLB', 'MLB', 'pro'],
    ['NHL', 'NHL', 'pro'],
    ['NCAAF', 'College Football', 'college'],
    ['NCAAB', 'College Basketball', 'college'],
    ['WNBA', 'WNBA', 'pro'],
    ['MLS', 'MLS', 'pro'],
    ['UFL', 'UFL', 'pro'],
    ['CFL', 'CFL', 'pro'],
    ['EPL', 'Premier League', 'pro'],
    ['UCL', 'Champions League', 'pro'],
  ];

  const COLLEGE_CONFS = {
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

  // Settings expansion (2026-07-22): wordmarks toggle, location picker, news
  // category toggles, Glance-app segment toggles. All staged locally the same
  // way the sports/favorites rows already are -- nothing persists until SAVE.
  const NEWS_CATS = [
    ['WORLD', 'World'], ['US', 'US'], ['TOP', 'Top Stories'], ['TECH', 'Tech'],
    ['BIZ', 'Business'], ['SPORTS', 'Sports'], ['GOOD', 'Good News'],
  ];
  // OpenTDB categories, prefix-stripped to match render/data's triviaCatKey.
  // Curated rather than the full 24 -- these are the ones worth a ticker slot.
  const TRIVIA_CATS = [
    'GENERAL KNOWLEDGE', 'SPORTS', 'HISTORY', 'GEOGRAPHY', 'SCIENCE & NATURE',
    'COMPUTERS', 'FILM', 'MUSIC', 'VIDEO GAMES', 'TELEVISION', 'BOOKS',
    'MYTHOLOGY', 'ANIMALS', 'VEHICLES', 'POLITICS',
  ];
  const SEGMENTS = [
    ['flights', 'Overhead Flights'], ['twitch', 'Twitch Tracker'], ['steam', 'Steam Top 10'],
    ['leaders', 'League Leaders + Team Stats'], ['standings', 'Standings'], ['trivia', 'Trivia'],
    ['golf', 'Golf'], ['racing', 'Racing'], ['ufc', 'UFC'], ['top25', 'College Top 25'],
    ['alerts', 'Weather Alerts'], ['draft', 'NFL Draft'], ['otd', 'On This Day'],
  ];

  const sportsEl = document.getElementById('sports');
  const displayEl = document.getElementById('display');
  const locationEl = document.getElementById('location');
  const newsEl = document.getElementById('news');
  const segmentsEl = document.getElementById('segments');
  const stocksEl = document.getElementById('stocks');
  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('saveBtn');
  const rows = {}; // league -> { cb, panel, expandBtn, selected: Set(raw upper strings), loaded }
  let wordmarkModes = {};   // key -> checkbox element
  let logoSize = 'medium';
  let density = 'standard';
  let scrollSpeed = 50;
  let scoreFlash = 'all';
  let wordmarkSize = 'medium';
  const LOGO_SCALE_KEYS = ['small', 'medium', 'large'];
  const DENSITY_KEYS = ['minimal', 'standard', 'full'];
  const SCORE_FLASH_KEYS = ['all', 'favorites', 'off'];
  let location = null; // {name, lat, lon} or null (falls back to the hardcoded default)
  const newsRow = {}; // cat -> checkbox el
  const segRow = {};  // key -> checkbox el
  const triviaRow = {}; // trivia category -> checkbox el
  const stockFavSelected = new Set(); // uppercase symbols, favorited off the curated list
  let customStocksSet = new Set();    // uppercase custom-added symbols

  // Display block (Phase 4, 2026-08-10). Wordmarks went from one on/off box to
  // three OR-ed checkboxes -- Jeff: "no wordmarks at all, wordmarks only for
  // live games, wordmarks only for favorite teams, wordmarks everywhere" as
  // "checkboxes that OR together". Nothing ticked IS the "no wordmarks" case,
  // so there's no separate Off box to keep in sync.
  const WM_MODES = [
    ['live', 'Live games'],
    ['favorites', 'Favorite teams'],
    ['everywhere', 'Everywhere (every team, every card)'],
  ];
  const LOGO_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
  // Wordmark height, its own control (2026-08-11). Sizes shifted up one notch
  // after Jeff compared them: LARGE is the uncapped pre-audit look, where the
  // ~58 marks taller than the 32-row panel bleed off the top and bottom. That
  // crop is the point of the setting, not a bug in it -- medium (32) is the
  // biggest every mark stays whole at, and it's the default.
  const WM_SIZES = [
    ['small', 'Small — 28px'],
    ['medium', 'Medium — 32px, fills the panel'],
    ['large', 'Large — original art size, tall marks bleed off the panel'],
  ];
  const DENSITIES = [
    ['minimal', 'Minimal — date/time + teams'],
    ['standard', 'Standard — + city and record'],
    ['full', 'Full — + national broadcaster'],
  ];
  // Stage 4 of the scoring-animation redesign. A routine score doesn't pause
  // the tape any more -- its own card flashes in place. Jeff's addition at the
  // grill was the choice of who that applies to, same shape as every other
  // toggle here (a missing key behaves as on = every team).
  const SCORE_FLASH = [
    ['all', 'Every team'],
    ['favorites', 'Favorite teams only'],
    ['off', 'Off'],
  ];

  function labelledRow(parent, input, textStr) {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.appendChild(input);
    const span = document.createElement('span');
    span.textContent = textStr;
    l.appendChild(span);
    row.appendChild(l);
    parent.appendChild(row);
    return row;
  }

  function hintLine(parent, textStr) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = textStr;
    parent.appendChild(h);
  }

  function selectRow(parent, labelStr, options, current, onChange) {
    const row = document.createElement('div');
    row.className = 'text-row';
    const span = document.createElement('span');
    span.textContent = labelStr;
    row.appendChild(span);
    const sel = document.createElement('select');
    options.forEach(([val, text]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = text;
      if (val === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    row.appendChild(sel);
    parent.appendChild(row);
  }

  function buildDisplay(settings) {
    // Back-compat: the old boolean meant "favorites get their wordmark".
    const modes = settings.wordmarkModes ||
      (settings.wordmarks === false ? {} : { favorites: true });
    wordmarkModes = {};
    logoSize = LOGO_SCALE_KEYS.indexOf(settings.logoSize) >= 0 ? settings.logoSize : 'medium';
    density = DENSITY_KEYS.indexOf(settings.density) >= 0 ? settings.density : 'standard';
    scrollSpeed = +settings.scrollSpeed >= 10 ? +settings.scrollSpeed : 50;
    scoreFlash = SCORE_FLASH_KEYS.indexOf(settings.scoreFlash) >= 0 ? settings.scoreFlash : 'all';
    wordmarkSize = LOGO_SCALE_KEYS.indexOf(settings.wordmarkSize) >= 0 ? settings.wordmarkSize : 'medium';
    displayEl.innerHTML = '';

    hintLine(displayEl, 'WORDMARKS — tick any combination. A team gets its real wordmark if ANY ticked rule matches it. Nothing ticked = no wordmarks anywhere.');
    WM_MODES.forEach(([key, text]) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!modes[key];
      wordmarkModes[key] = cb;
      labelledRow(displayEl, cb, text);
    });

    selectRow(displayEl, 'Wordmark size', WM_SIZES, wordmarkSize, v => { wordmarkSize = v; });
    selectRow(displayEl, 'Team logo size', LOGO_SIZES, logoSize, v => { logoSize = v; });
    selectRow(displayEl, 'Game card detail', DENSITIES, density, v => { density = v; });
    selectRow(displayEl, 'Score flash', SCORE_FLASH, scoreFlash, v => { scoreFlash = v; });
    hintLine(displayEl, 'SCORE FLASH — a routine score (a basket, a field goal) flashes its own card in place instead of pausing the tape. Big plays and lead changes still take over the whole panel.');

    const speedRow = document.createElement('div');
    speedRow.className = 'text-row';
    const sLabel = document.createElement('span');
    sLabel.textContent = 'Scroll speed';
    speedRow.appendChild(sLabel);
    const sInput = document.createElement('input');
    sInput.type = 'range';
    sInput.min = '20'; sInput.max = '150'; sInput.step = '5';
    sInput.value = String(scrollSpeed);
    const sVal = document.createElement('span');
    sVal.textContent = scrollSpeed + ' PX/S';
    sInput.addEventListener('input', () => {
      scrollSpeed = +sInput.value;
      sVal.textContent = scrollSpeed + ' PX/S';
    });
    speedRow.appendChild(sInput);
    speedRow.appendChild(sVal);
    displayEl.appendChild(speedRow);
    hintLine(displayEl, 'Speed applies on the next settings save. The tray presets and the mouse wheel still override it until the widget reloads.');
  }

  // Trivia category picker (2026-08-10 brain dump). Nothing ticked = every
  // category, matching how the news categories and sports toggles behave.
  function buildTriviaCats(settings) {
    const picked = settings.triviaCats || {};
    const wrap = document.createElement('div');
    hintLine(wrap, 'TRIVIA CATEGORIES — tick the ones you want. None ticked = all of them.');
    TRIVIA_CATS.forEach(cat => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!picked[cat];
      triviaRow[cat] = cb;
      labelledRow(wrap, cb, cat);
    });
    segmentsEl.appendChild(wrap);
  }

  function buildLocation(settings) {
    const loc = settings.location;
    location = (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') ? loc : null;
    locationEl.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'text-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'City name';
    input.value = (location && location.name) || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'geo-btn';
    btn.textContent = 'SET';
    const status = document.createElement('span');
    status.className = 'location-status' + (location ? ' ok' : '');
    status.textContent = location ? ('Current: ' + location.name) : 'Using default (New Fairfield CT)';
    btn.addEventListener('click', () => {
      const city = input.value.trim();
      if (!city) return;
      btn.disabled = true;
      status.className = 'location-status';
      status.textContent = 'Looking up...';
      fetch('/api/geocode?city=' + encodeURIComponent(city))
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            location = { name: d.name, lat: d.lat, lon: d.lon };
            status.textContent = 'Set: ' + d.name + ' (click SAVE below to persist)';
            status.className = 'location-status ok';
          } else {
            status.textContent = 'Not found: "' + city + '"';
            status.className = 'location-status err';
          }
        })
        .catch(() => {
          status.textContent = 'Lookup failed';
          status.className = 'location-status err';
        })
        .finally(() => { btn.disabled = false; });
    });
    row.appendChild(input);
    row.appendChild(btn);
    locationEl.appendChild(row);
    locationEl.appendChild(status);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Drives weather, AQI, weather alerts, and overhead flights.';
    locationEl.appendChild(hint);
  }

  function buildToggleList(container, defs, settingsObj, store) {
    container.innerHTML = '';
    Object.keys(store).forEach(k => delete store[k]);
    defs.forEach(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settingsObj[key] !== false;
      const l = document.createElement('label');
      l.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = label;
      l.appendChild(span);
      row.appendChild(l);
      container.appendChild(row);
      store[key] = cb;
    });
  }

  // Favorite-stocks picker + custom-ticker add (2026-07-22). Buttons off the
  // curated STOCKS list (server's /api/stock-symbols -- static, no per-symbol
  // fetch needed, same reasoning as the college conference map). Custom
  // tickers always show on the tape (treated like a favorite in data.js), so
  // adding one doesn't need its own separate favorite toggle.
  function buildStocks(settings, stockSymbols) {
    customStocksSet = new Set((settings.customStocks || []).map(s => String(s).toUpperCase()));
    stockFavSelected.clear();
    (settings.favoriteStocks || []).forEach(s => stockFavSelected.add(String(s).toUpperCase()));

    stocksEl.innerHTML = '';

    const addRow = document.createElement('div');
    addRow.className = 'text-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Custom ticker (e.g. RKLB)';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'geo-btn';
    addBtn.textContent = 'ADD';
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    stocksEl.appendChild(addRow);

    const chipHint = document.createElement('div');
    chipHint.className = 'hint';
    chipHint.textContent = 'Custom tickers always show on the tape. Click a chip to remove it.';
    stocksEl.appendChild(chipHint);

    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'team-grid';
    stocksEl.appendChild(chipsWrap);

    function renderChips() {
      chipsWrap.innerHTML = '';
      Array.from(customStocksSet).sort().forEach(sym => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'team-btn on';
        chip.textContent = sym + ' ×';
        chip.title = 'Click to remove';
        chip.addEventListener('click', () => { customStocksSet.delete(sym); renderChips(); });
        chipsWrap.appendChild(chip);
      });
    }
    renderChips();

    addBtn.addEventListener('click', () => {
      const sym = input.value.trim().toUpperCase();
      if (!sym) return;
      customStocksSet.add(sym);
      input.value = '';
      renderChips();
    });

    const favHint = document.createElement('div');
    favHint.className = 'hint';
    favHint.textContent = 'Click any ticker to favorite it -- favorited stocks always show instead of only cycling in with the rotation.';
    stocksEl.appendChild(favHint);

    const grid = document.createElement('div');
    grid.className = 'team-grid';
    stockSymbols.slice().sort((a, b) => a.sym.localeCompare(b.sym)).forEach(s => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'team-btn' + (stockFavSelected.has(s.sym) ? ' on' : '');
      b.textContent = s.sym;
      b.addEventListener('click', () => {
        if (stockFavSelected.has(s.sym)) { stockFavSelected.delete(s.sym); b.classList.remove('on'); }
        else { stockFavSelected.add(s.sym); b.classList.add('on'); }
      });
      grid.appendChild(b);
    });
    stocksEl.appendChild(grid);
  }

  // A button can match an existing favorite by abbreviation, full name, OR
  // nickname alone -- favorites typed into the old free-text box were often
  // just the nickname ("RAVENS", not "Baltimore Ravens" or "BAL"). Returns
  // the exact raw key(s) in `selected` this button corresponds to, so
  // toggling off removes the right entry even in its loose typed form.
  function keysFor(selected, abbr, name, nick) {
    const keys = [abbr, name, nick].filter(Boolean).map(s => s.toUpperCase());
    return keys.filter(k => selected.has(k));
  }

  function makeTeamButton(label, abbr, name, nick, row) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'team-btn';
    b.textContent = label;
    const on = keysFor(row.selected, abbr, name, nick).length > 0;
    if (on) b.classList.add('on');
    b.addEventListener('click', () => {
      const existingKeys = keysFor(row.selected, abbr, name, nick);
      if (existingKeys.length) {
        existingKeys.forEach(k => row.selected.delete(k));
        b.classList.remove('on');
      } else {
        row.selected.add(abbr.toUpperCase());
        b.classList.add('on');
      }
    });
    return b;
  }

  function renderCollegePanel(row) {
    row.panel.innerHTML = '';
    Object.keys(COLLEGE_CONFS).sort().forEach(conf => {
      const h = document.createElement('div');
      h.className = 'conf-label';
      h.textContent = conf;
      row.panel.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'team-grid';
      COLLEGE_CONFS[conf].split(' ').slice().sort().forEach(abbr => {
        grid.appendChild(makeTeamButton(abbr, abbr, '', '', row));
      });
      row.panel.appendChild(grid);
    });
  }

  function renderProPanel(row, teams) {
    row.panel.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'team-grid';
    teams.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(t => {
      grid.appendChild(makeTeamButton(t.name, t.abbr, t.name, t.nick, row));
    });
    row.panel.appendChild(grid);
  }

  async function ensureLoaded(lg, kind, row) {
    if (row.loaded) return;
    row.loaded = true;
    if (kind === 'college') {
      renderCollegePanel(row);
      return;
    }
    row.panel.innerHTML = '<div class="loading">Loading teams...</div>';
    try {
      const r = await fetch('/api/teams?league=' + lg);
      const teams = await r.json();
      if (!teams.length) { row.panel.innerHTML = '<div class="loading">No roster available.</div>'; return; }
      renderProPanel(row, teams);
    } catch (e) {
      row.panel.innerHTML = '<div class="loading">Failed to load teams.</div>';
    }
  }

  function build(settings, stockSymbols) {
    buildDisplay(settings);
    buildLocation(settings);
    buildToggleList(newsEl, NEWS_CATS, settings.news || {}, newsRow);
    buildToggleList(segmentsEl, SEGMENTS, settings.segments || {}, segRow);
    buildTriviaCats(settings);
    buildStocks(settings, stockSymbols || []);

    const sportsSettings = settings.sports || {};
    const favorites = settings.favorites || {};

    LEAGUES.forEach(([lg, label, kind]) => {
      const wrap = document.createElement('div');
      wrap.className = 'league';

      const head = document.createElement('div');
      head.className = 'league-head';

      const l = document.createElement('label');
      l.className = 'name';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sportsSettings[lg] !== false;
      const span = document.createElement('span');
      span.textContent = label;
      l.appendChild(cb);
      l.appendChild(span);

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = 'TEAMS ▾';

      head.appendChild(l);
      head.appendChild(expandBtn);
      wrap.appendChild(head);

      const panel = document.createElement('div');
      panel.className = 'team-panel';
      panel.hidden = true;
      wrap.appendChild(panel);

      // Pre-seed `selected` with whatever's already stored, RAW, before any
      // panel is ever rendered -- so a league the user never expands still
      // round-trips its existing favorites unchanged on Save instead of
      // silently coming back empty.
      const row = { cb, panel, expandBtn, selected: new Set((favorites[lg] || []).map(s => String(s).toUpperCase())), loaded: false };
      rows[lg] = row;

      cb.addEventListener('change', () => wrap.classList.toggle('disabled', !cb.checked));
      wrap.classList.toggle('disabled', !cb.checked);

      expandBtn.addEventListener('click', () => {
        const opening = panel.hidden;
        panel.hidden = !opening;
        expandBtn.classList.toggle('open', opening);
        expandBtn.textContent = opening ? 'TEAMS ▴' : 'TEAMS ▾';
        if (opening) ensureLoaded(lg, kind, row);
      });

      sportsEl.appendChild(wrap);
    });
  }

  function collectSettings() {
    const sports = {}, favorites = {};
    LEAGUES.forEach(([lg]) => {
      const row = rows[lg];
      sports[lg] = row.cb.checked;
      favorites[lg] = Array.from(row.selected);
    });
    const news = {};
    NEWS_CATS.forEach(([key]) => { news[key] = newsRow[key].checked; });
    const segments = {};
    SEGMENTS.forEach(([key]) => { segments[key] = segRow[key].checked; });
    // location stays undefined (dropped by JSON.stringify) until a lookup has
    // actually resolved -- the server/client both fall back to the hardcoded
    // default whenever the key is simply absent.
    return {
      sports, favorites, news, segments, location: location || undefined,
      wordmarkModes: { live: wordmarkModes.live.checked, favorites: wordmarkModes.favorites.checked,
                       everywhere: wordmarkModes.everywhere.checked },
      logoSize, density, scrollSpeed, scoreFlash, wordmarkSize,
      triviaCats: TRIVIA_CATS.reduce((o, c) => { o[c] = triviaRow[c].checked; return o; }, {}),
      favoriteStocks: Array.from(stockFavSelected), customStocks: Array.from(customStocksSet),
    };
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  Promise.all([
    fetch('/api/settings.json').then(r => r.json()),
    fetch('/api/stock-symbols').then(r => r.json()).catch(() => []),
  ]).then(([settings, stockSymbols]) => build(settings, stockSymbols))
    .catch(() => setStatus('LOAD FAILED', 'err'));

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    setStatus('SAVING...');
    fetch('/api/settings', { method: 'POST', body: JSON.stringify(collectSettings()) })
      .then(r => r.json())
      .then(d => setStatus(d.ok ? 'SAVED' : 'SAVE FAILED', d.ok ? 'ok' : 'err'))
      .catch(() => setStatus('SAVE FAILED', 'err'))
      .finally(() => { saveBtn.disabled = false; });
  });
})();
