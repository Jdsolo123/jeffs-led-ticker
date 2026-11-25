/* ChuckBuilds-style tape — scroll-only (Vegas mode), same dot-matrix
 * simulation technique as ../webapp/app.js, trimmed to one display mode. */
(function () {
  'use strict';

  const strip = document.getElementById('strip');
  const dotmask = document.getElementById('dotmask');
  const frameEl = document.getElementById('frame');
  const statusText = document.getElementById('statusText');
  const pulse = document.getElementById('pulse');
  const infoBadge = document.getElementById('infoBadge');
  const hint = document.getElementById('hint');
  const ctx = strip.getContext('2d');

  const ROWS = window.TICKERRENDER.ROWS;
  const SCORES_SECS = 60;
  const EXTRAS_SECS = 30 * 60;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  let pps = +(localStorage.getItem('cbt-pps') || 50);
  // Set once the tray preset / wheel / slider moves the speed by hand, so a
  // Settings value can't yank it back mid-session (Phase 4, 2026-08-10).
  let speedTouched = false;
  let src = null;
  let glow = null;
  let mode = 'dot';
  let pitch = 6;
  let viewCols = 0;
  let scrollPos = 0;
  let lastTs = null;
  let rafId = null;
  let lastDraw = 0;
  let healthy = false;
  let lastFetch = 0;
  const data = { games: [], coins: [], news: [], weather: null, stocks: [], indices: [], topCoins: [], standings: [], trivia: [], golf: null, racing: null, ufc: null, michigan: null, leaders: [], top25: null, nowPlaying: null, alerts: [], steam: [], flights: [], twitch: [], draft: null, onThisDay: [] };

  // The tape is chunked (see render.js CHUNK — canvases wider than 16,384 fall
  // off the GPU path and turn every draw ~250x slower), so the glow layer is
  // chunked to match, one blurred twin per tape chunk.
  function rebuildGlow() {
    glow = { width: src.width, chunks: src.chunks.map(function (c) {
      const g2 = document.createElement('canvas');
      g2.width = c.width; g2.height = c.height;
      const g = g2.getContext('2d');
      g.filter = 'blur(0.6px)'; // light LED bloom only; a heavy blur ghosts small text
      g.drawImage(c, 0, 0);
      return g2;
    }) };
  }

  // Their real fonts (PressStart2P + 4x6) must be loaded before the first
  // compose, else masks bake with a fallback font and never refresh.
  let fontsReady = false;
  Promise.all([
    document.fonts.load('8px "PressStart2P"'),
    document.fonts.load('6px "det4x6"'),
  ]).then(function () { fontsReady = true; recompose(); })
    .catch(function () { fontsReady = true; });

  // --- Position is held by SEGMENT, not by pixel (2026-08-11) ----------------
  // The tape recomposes on every 60s score refresh, and a lap is ~62,000px =
  // ~20 minutes at 50px/s. Keeping the raw scrollPos across a recompose meant
  // the same PIXEL of an entirely rebuilt tape, so only the first ~3,000px
  // (4.9% of a lap) was ever reachable and the same handful of cards came round
  // and round. Jeff, watching it: "I feel like I see the same baseball games
  // repeated so often."
  //
  // So the tape now remembers what has actually been ON SCREEN, and a recompose
  // resumes at the first segment the viewer hasn't seen yet. Everything gets
  // its turn; a 20-minute lap no longer needs 20 uninterrupted minutes.
  const seenSegs = new Set();
  const SEEN_MAX = 4000;            // days of distinct cards; clears itself well before this
  // Identity has to reach into the PAYLOAD, not stop at kind+tag: two different
  // headlines are both `news|WORLD|`, two different trivia questions are both
  // `trivia||`. Ided that coarsely, the second one counts as already-seen and
  // the resume skips a card Jeff never saw. So each kind contributes its most
  // identifying field, and anything unlisted falls back to kind+tag (which is
  // right for the singletons -- clock, weather, flights).
  function segSig(p) {
    if (!p) return '';
    return String(p.text || p.q || p.sym || p.label || p.cat || '').slice(0, 48);
  }
  function segId(e) { return e.kind + '|' + e.tag + '|' + e.key + '|' + segSig(e.payload); }
  // Marks every segment currently within the viewport. "Seen" means it was on
  // the panel, not that it was merely composed -- anything else would let the
  // resume skip past cards Jeff never actually saw.
  function markVisible() {
    if (!src || !src._index || !viewCols) return;
    const W = src.width, off = scrollPos;
    for (const e of src._index) {
      const base = (((e.x - off) % W) + W) % W;
      // the tape wraps, so a segment near the seam shows at base OR base - W
      if ((base < viewCols && base + e.w > 0) ||
          (base - W < viewCols && base - W + e.w > 0)) seenSegs.add(segId(e));
    }
  }
  // FORWARD-ONLY, and that is not a detail -- it is what makes this terminate.
  // The first version took the earliest unseen segment anywhere on the tape and
  // it STALLED: `leaders` cards rotate their category on every compose, so each
  // recompose mints genuinely-new segments near the same spot, the resume kept
  // jumping BACK to them, and coverage froze at 76/165 over ten simulated
  // minutes. Measured, not theorised -- the stall showed up as the same pos
  // (14826 -> 11826) cycle after cycle.
  //
  // So: take the first unseen segment AT OR AFTER where we already are, and
  // only wrap to the top when nothing is left ahead. Progress is monotonic,
  // rotating content gets seen when the tape reaches it, and a lap genuinely
  // ends instead of orbiting one neighbourhood.
  function resumeAtUnseen() {
    if (!src._index || !src._index.length) return;
    const W = src.width, from = scrollPos % W;
    let ahead = null, first = null;
    for (const e of src._index) {
      if (seenSegs.has(segId(e))) continue;
      if (!first || e.x < first.x) first = e;
      if (e.x >= from && (!ahead || e.x < ahead.x)) ahead = e;
    }
    const target = ahead || first;
    if (!target) {                  // whole lap seen: start a fresh one
      seenSegs.clear();
      scrollPos = 0;
      return;
    }
    if (seenSegs.size > SEEN_MAX) seenSegs.clear();
    scrollPos = target.x % W;       // that segment lands at the panel's left edge
  }
  function recompose() {
    if (!fontsReady) return; // deferred until fonts resolve
    const had = !!(src && src._index);
    src = window.TICKERRENDER.compose(data);
    rebuildGlow();
    if (had) resumeAtUnseen();
  }

  let logoT = null;
  window.TICKERRENDER.onLogoReady = function () {
    clearTimeout(logoT);
    logoT = setTimeout(recompose, 400);
  };

  const isWidget = document.documentElement.classList.contains('widget');

  function layout() {
    const cssW = frameEl.clientWidth;
    if (isWidget) {
      // Desktop bar: size the dots off the window HEIGHT so the 32 rows fill
      // the bar exactly, and show as many columns as the screen is wide.
      pitch = Math.max(2, Math.floor(frameEl.clientHeight / ROWS));
      dotmask.style.display = '';
      dotmask.style.backgroundSize = pitch + 'px ' + pitch + 'px';
    } else if (mode === 'dot') {
      pitch = Math.max(3, Math.round(cssW / 220)); // wide 384px-equiv panel: smaller dots so more fits on screen
      dotmask.style.display = '';
      dotmask.style.backgroundSize = pitch + 'px ' + pitch + 'px';
    } else {
      pitch = cssW / 384; // matches Jeff's planned 6-panel (384x32) hardware width
      dotmask.style.display = 'none';
    }
    viewCols = Math.ceil(cssW / pitch);
    const cssH = Math.round(ROWS * pitch);
    strip.style.height = cssH + 'px';
    strip.width = Math.round(cssW * DPR);
    strip.height = Math.round(cssH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  // Blit one viewport's worth from a chunked tape, wrapping at the end.
  function drawLayer(tape, offset, alpha) {
    ctx.globalAlpha = alpha;
    let drawn = 0, sx = offset;
    let guard = 0;
    while (drawn < viewCols && guard++ < 64) {
      if (sx >= tape.width) sx = 0;
      const run = Math.min(tape.width - sx, viewCols - drawn);
      const did = window.TICKERRENDER.blit(tape, ctx, sx, run, drawn, pitch);
      if (did <= 0) break;
      drawn += did; sx += did;
    }
  }

  function draw(ts) {
    if (!src) return;
    lastDraw = performance.now();
    // Takeover playback: the tape freezes (scrollPos untouched, lastTs kept
    // current so there's no catch-up jump on resume) while the animation owns
    // the panel.
    if (!TK.active && TK.queue.length && ts - TK.lastEnd > TK_GAP_MS) {
      // Drop anything that waited too long to still feel live. Jeff, 2026-08-14:
      // "by the time the touchdown animation played the team already scored a
      // fieldgoal" -- a queue that never expires will happily replay a score
      // the scoreboard has already moved past.
      while (TK.queue.length && ts - TK.queue[0].at > TK_STALE_MS) TK.queue.shift();
      if (TK.queue.length) TK.active = { ev: TK.queue.shift(), start: ts };
    }
    if (TK.active) {
      const t = ts - TK.active.start;
      if (t <= window.TICKERRENDER.takeover.duration(TK.active.ev)) {
        lastTs = ts;
        drawTakeover(TK.active.ev, t);
        return;
      }
      TK.lastEnd = ts;
      TK.active = null;
    }
    if (lastTs !== null) {
      const dt = Math.min(1, Math.max(0, (ts - lastTs) / 1000));
      scrollPos = (scrollPos + dt * pps) % src.width;
    }
    lastTs = ts;
    const offset = Math.floor(scrollPos);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, strip.width, strip.height);
    drawLayer(glow, offset, 0.35);
    drawLayer(src, offset, 1);
    ctx.globalAlpha = 1;
    drawRedZonePulse(ts);
    drawScoreFlashes(ts);
    markVisible();
  }

  function tick(ts) { rafId = requestAnimationFrame(tick); draw(ts); }

  setInterval(function () {
    if (!document.hidden && performance.now() - lastDraw > 200) draw(performance.now());
  }, 100);

  function fmtAgo(secs) { return secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm'; }

  // Flag any game whose score moved since the last fetch, so the card can flash.
  // Keyed on the matchup rather than array position: the games list is re-fetched
  // and re-ordered every 60s, so index-to-index comparison would compare
  // unrelated games and flash the wrong cards.
  const lastScores = {};
  function markScoreChanges(games) {
    for (const g of games) {
      const key = g.league + '|' + g.awayTeam + '@' + g.homeTeam;
      // A blank/absent score in one poll must NOT be read as 0: that alone
      // manufactures a fake -4 then a fake +4 on the next poll, firing a
      // takeover (and a score flash) on a game whose score never moved. Skip
      // the poll entirely instead, keeping the last known scores (2026-08-10,
      // second half of the "HOME RUN fires 12x while the score stays 4-0" bug).
      if (g.awayScore === '' || g.awayScore == null ||
          g.homeScore === '' || g.homeScore == null) continue;
      const a = +g.awayScore || 0, h = +g.homeScore || 0;
      if (!Number.isFinite(a) || !Number.isFinite(h)) continue;
      const before = lastScores[key];
      const changed = g.state === 'in' && before !== undefined && (before.a !== a || before.h !== h);
      g.scoreChanged = !!changed;
      if (changed) queueTakeover(g, a - before.a, h - before.h, before);
      lastScores[key] = { a, h };
    }
  }

  // --- Glance-style scoring takeovers ---------------------------------------
  // A scoring play pauses the tape and plays a full-panel animation (~5s), then
  // the tape resumes where it stopped. ALL live games fire (Jeff's call), with
  // one guard: basketball scores every trip down the floor, so with 60s polling
  // it would fire on literally every poll — basketball only fires on a LEAD
  // CHANGE. PATs (+1 football) ride the touchdown that preceded them.
  const TK = { queue: [], active: null, lastEnd: 0, panel: null };
  const TK_QUEUE_MAX = 4;    // a busy Saturday keeps only the freshest bursts
  const TK_GAP_MS = 2000;    // breathe between back-to-back takeovers
  const TK_STALE_MS = 90000; // ...and never play one that has waited longer

  // Clock/quarter line for the takeover's phase A (2026-08-10 redesign — the
  // grill made "clock/quarter/inning" one of the four facts phase A owes the
  // viewer). ESPN's shortDetail is already sport-correct ("7:32 - 3rd",
  // "Bot 9th", "90'+3'"), so use it rather than re-deriving a label per sport;
  // the dash is dropped because 8px columns are scarce on the right rail.
  function takeoverClock(g) {
    const d = String(g.detail || '').toUpperCase().replace(/\s*-\s*/g, ' ').trim();
    if (d) return d.slice(0, 12);
    if (g.clock && g.period) return 'P' + g.period + ' ' + g.clock;
    return '';
  }

  // Lead change / go-ahead detection (stage 3). One function so the takeover,
  // the label and the magnitude router all agree on what "took the lead" means.
  // A tie-breaking score counts as GO-AHEAD; overtaking counts as LEAD CHANGE;
  // an equaliser counts as neither (nobody leads after it).
  // Gate for the stages that change TAPE BEHAVIOUR rather than one frame's
  // pixels (the router picks a tier, the flash paints a scrolling card). Same
  // TAKEOVER_ADD table and same __takeoverPreview override phases A and B use,
  // read through render.js so there's one source of truth for what's approved.
  const tkOn = k => {
    const t = window.TICKERRENDER && window.TICKERRENDER.takeover;
    return !!(t && t.on && t.on(k));
  };

  function leadShift(prev, a, h) {
    const before = Math.sign(prev.a - prev.h), after = Math.sign(a - h);
    if (after === 0 || after === before) return null;
    return before === 0 ? 'GO-AHEAD' : 'LEAD CHANGE';
  }

  // --- Magnitude router (stage 5) --------------------------------------------
  // The grill's two tiers: the full takeover is for the big moments, everything
  // routine gets the short in-card flash instead of interrupting the tape.
  // FULL = a big-play type (touchdown, home run, grand slam) OR a lead change /
  // go-ahead score. A field goal, an extra point, a routine basket does not.
  //
  // Two honest gaps, flagged rather than invented:
  //  - HAT TRICK is on the spec's big-play list but ESPN's play text carries a
  //    SEASON goal count ("Goal (12)"), not a per-game one, so there is nothing
  //    to count three of. Hockey goals ride the lead-change rule instead.
  //  - A SOCCER goal is that sport's touchdown-equivalent but the spec's list
  //    doesn't name it, so it also rides the lead-change rule. BIG_PLAY.soccer
  //    flips it to always-full if Jeff wants it that way.
  const BIG_PLAY = { soccer: false };
  function isBigPlay(sport, d, play) {
    const p = String(play || '').toLowerCase();
    if (sport === 'FOOTBALL') return d >= 6;                       // TD (the +1 PAT rides it)
    if (sport === 'BASEBALL') return /home\s*run|homers?\b|grand slam/.test(p);
    if (sport === 'SOCCER') return !!BIG_PLAY.soccer;
    return false;
  }

  function queueTakeover(g, da, dh, prev) {
    if (da <= 0 && dh <= 0) return; // corrections can move a score down — no fanfare
    const sport = window.TICKERRENDER.sportOf(g.league) || '';
    const side = da > dh ? 'away' : 'home';
    const d = Math.max(da, dh);
    const a = +g.awayScore || 0, h = +g.homeScore || 0;
    const leadLabel = leadShift(prev, a, h);
    let kind = 'alert', headline = null, banner = null;
    if (sport === 'FOOTBALL') {
      if (d >= 6) kind = 'td';
      else if (d === 3) { headline = 'FIELD GOAL'; banner = '#0a5c1e'; }
      else if (d === 2) headline = 'SAFETY';
      else return; // +1 = the PAT after a TD we already celebrated
    } else if (sport === 'BASEBALL') {
      kind = /home\s*run|homers?|grand slam/i.test(g.lastPlay || '') ? 'hr' : 'alert';
    }
    // Two tiers, gated. WITH the router (stage 5): a routine score never
    // interrupts the tape, it gets the short in-card flash instead -- which
    // generalises the old basketball-only guard to every sport. WITHOUT it, the
    // pre-stage-5 rule stands exactly as it shipped: every live game fires a
    // full takeover, except basketball, which scores every trip down the floor
    // and so only fires on a lead change.
    if (tkOn('router')) {
      if (!isBigPlay(sport, d, g.lastPlay) && !leadLabel) {
        queueScoreFlash(g, side, prev);
        return;
      }
    } else if (sport === 'BASKETBALL' && !leadLabel) {
      return;
    }
    const leadOn = tkOn('leadChange');
    if (leadOn && leadLabel && !headline && kind === 'alert') headline = leadLabel;
    // situation.lastPlay is whatever was current AT POLL TIME, which after a
    // late poll is the PAT/timeout/kickoff rather than the score. Only trust it
    // when it actually reads like a scoring play; otherwise the card starts as
    // the team-only fallback and the verified play (fetched below) fills it in
    // before phase B is on screen 3s later.
    const provisional = looksLikeScore(g.lastPlay || '', sport) ? (g.lastPlay || '') : '';
    const player = parseScorer(provisional, sport);
    TK.queue.push({
      at: performance.now(),   // for the staleness guard in draw()
      kind, headline, banner, league: g.league, side, sport,
      leadChange: leadOn && !!leadLabel, leadLabel: leadOn ? leadLabel : null,
      team: side === 'home' ? g.homeTeam : g.awayTeam,
      teamName: side === 'home' ? (g.homeName || g.homeTeam) : (g.awayName || g.awayTeam),
      logo: side === 'home' ? g.homeLogo : g.awayLogo,
      color: side === 'home' ? g.homeColor : g.awayColor,
      awayTeam: g.awayTeam, awayScore: g.awayScore,
      homeTeam: g.homeTeam, homeScore: g.homeScore,
      // pre-play scores drive the count-up animation on the scoring side
      oldA: prev.a, oldH: prev.h,
      clockTxt: takeoverClock(g),
      teamId: side === 'home' ? g.homeId : g.awayId,
      play: provisional, michigan: !!g.michigan,
      playerName: player.name, playerStat: player.stat,
      playLine: compressPlay(provisional, sport, player.name),
    });
    while (TK.queue.length > TK_QUEUE_MAX) TK.queue.shift();
    const ev = TK.queue[TK.queue.length - 1];
    enrichScorer(ev);
    enrichScoringPlay(ev, g, a, h);
  }

  // Does this play text describe a score, or is it the timeout/kickoff that
  // followed one? Deliberately narrow -- a false positive here is the exact bug
  // being fixed, and a false negative just falls back to the verified lookup.
  function looksLikeScore(play, sport) {
    const p = String(play || '');
    if (!p) return false;
    if (sport === 'FOOTBALL') return /touchdown|field goal is good|field goal|safety/i.test(p);
    if (sport === 'BASEBALL') return /home\s*run|homers?|grand slam|scores?\b|rbi/i.test(p);
    if (sport === 'HOCKEY') return /\bgoal\b/i.test(p) && !/no goal|goalie/i.test(p);
    if (sport === 'SOCCER') return /\bgoal\b|scores/i.test(p);
    return /\b(goal|scores?|dunk|three point|jumper|layup|free throw)\b/i.test(p);
  }

  // Replace the play text with the one that ACTUALLY scored, identified by the
  // score it produced (see fetchScoringPlay). Async and best-effort, same
  // contract as enrichScorer: phase A owns the first 3s, so a ~400ms lookup
  // lands well before phase B draws. If it never lands, the card stays on the
  // team-only fallback -- Jeff's call, 2026-08-14: a card that states a play we
  // could not verify is worse than one that shows the team and the score.
  function enrichScoringPlay(ev, g, a, h) {
    if (!g.id || !window.TICKERDATA.fetchScoringPlay) return;
    window.TICKERDATA.fetchScoringPlay(g.league, g.id, a, h).then(sp => {
      if (!sp || !sp.text) return;
      const player = parseScorer(sp.text, ev.sport);
      ev.play = sp.text;
      ev.playerName = player.name;
      ev.playerStat = player.stat;
      ev.playLine = compressPlay(sp.text, ev.sport, player.name);
      enrichScorer(ev);   // headshot/jersey for the newly-resolved scorer
    });
  }

  // --- Short in-card score flash (stage 4) -----------------------------------
  // The routine-score tier. Nothing pauses: the scoring game's own card flashes
  // its team colour and ticks its score up in gold, in place, while the tape
  // keeps scrolling. A card can appear on the tape more than once (favourites
  // repeat), so every instance flashes -- whichever one is on screen is the one
  // Jeff sees.
  //
  // Settings: `scoreFlash` is 'all' (default) or 'favorites'. Same convention
  // as every other toggle -- a missing key behaves as on.
  const SF = { active: [], mode: 'all' };
  function queueScoreFlash(g, side, prev) {
    if (!tkOn('scoreFlash')) return;
    if (SF.mode === 'off') return;
    if (SF.mode === 'favorites' && !g.favorite) return;
    const key = g.league + '|' + g.awayTeam + '@' + g.homeTeam;
    // one flash per card at a time: a second score inside the window restarts it
    SF.active = SF.active.filter(f => f.key !== key);
    SF.active.push({
      key, start: performance.now(),
      ev: { oldA: prev.a, oldH: prev.h, color: side === 'home' ? g.homeColor : g.awayColor },
    });
  }
  // Red-zone end zone pulse. The tape is baked, so the card can't animate
  // itself: for every red-zone card currently on screen, repaint its end zone
  // with the pulse colour for this timestamp. Same wrap handling as
  // drawScoreFlashes -- a card near the tape seam is visible at two x's.
  function drawRedZonePulse(ts) {
    const RZP = window.TICKERRENDER.redZonePulse;
    if (!RZP || !src || !src._index) return;
    const offset = Math.floor(scrollPos);
    for (const e of src._index) {
      if (e.kind !== 'rzgame') continue;
      const base = (((e.x - offset) % src.width) + src.width) % src.width;
      for (const sx of [base, base - src.width]) {
        if (sx >= viewCols || sx + e.w <= 0) continue;
        const f = RZP.frame(e.payload, ts);
        if (!f) continue;
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1;
        ctx.drawImage(f.canvas, 0, 0, f.canvas.width, f.canvas.height,
                      (sx + f.x) * pitch, f.y * pitch,
                      f.canvas.width * pitch, f.canvas.height * pitch);
      }
    }
  }

  function drawScoreFlashes(ts) {
    if (!SF.active.length || !src || !src._index) return;
    const dur = window.TICKERRENDER.scoreFlash.duration();
    SF.active = SF.active.filter(f => ts - f.start <= dur);
    if (!SF.active.length) return;
    const offset = Math.floor(scrollPos);
    for (const f of SF.active) {
      const t = ts - f.start;
      for (const e of src._index) {
        if (e.key !== f.key) continue;
        // Where this card currently sits on screen. The tape wraps, so a card
        // near the seam is visible at BOTH a large positive x and a negative
        // one -- draw both candidates and let the viewport clip.
        const base = (((e.x - offset) % src.width) + src.width) % src.width;
        for (const sx of [base, base - src.width]) {
          if (sx >= viewCols || sx + e.w <= 0) continue;
          const card = window.TICKERRENDER.scoreFlash.card(e.kind, e.payload, f.ev, t);
          if (!card) continue;
          ctx.imageSmoothingEnabled = false;
          ctx.globalAlpha = 1;
          ctx.drawImage(card, 0, 0, card.width, ROWS,
                        sx * pitch, 0, card.width * pitch, ROWS * pitch);
        }
      }
    }
  }

  // --- Scorer headshot join (stage 2) ----------------------------------------
  // The play text names the scorer; the scoring team's own roster turns that
  // name into a headshot. Deliberately ASYNC and best-effort: the takeover may
  // already be playing when the roster lands, and phase B is 3s away from the
  // cut, so the event is enriched in place and the renderer just reads
  // ev.headshot if it happens to be there. Nothing waits on the network.
  //
  // Match rules are the grill's, not looser: surname only, inside the SCORING
  // TEAM's roster only, and an ambiguous surname (Michigan currently carries
  // two Browns and two Johnsons) resolves to nothing rather than to a guess --
  // a wrong face is worse than the sport-art fallback.
  const _rosters = {};
  function rosterFor(league, team) {
    const key = league + '|' + team;
    if (!_rosters[key]) {
      _rosters[key] = fetch('/api/roster?league=' + encodeURIComponent(league) +
                            '&team=' + encodeURIComponent(team))
        .then(r => r.json())
        .catch(() => []);
    }
    return _rosters[key];
  }
  function enrichScorer(ev) {
    if (!ev || !ev.playerName || !ev.teamId || !ev.league) return;
    rosterFor(ev.league, ev.teamId).then(rows => {
      if (!Array.isArray(rows) || !rows.length) return;
      const hits = rows.filter(r => r.last === ev.playerName);
      if (hits.length !== 1) return;   // 0 = not on the roster, 2+ = shared surname
      const p = hits[0];
      if (p.headshot) ev.headshot = p.headshot;
      ev.playerFull = p.full;
      ev.playerJersey = p.jersey;
      ev.playerPos = p.pos;
    });
  }

  // --- Compressed play line (stage 2) ----------------------------------------
  // Phase B wants the play DESCRIPTION as a fourth fact, distinct from the stat
  // badge parseScorer already produces. Raw ESPN sentences are 60-90 characters
  // and the panel holds ~38 at 8px, so this pulls the payload out per sport
  // rather than truncating an English sentence into nonsense ("J.J. MCCARTHY
  // PASS DEEP RIGHT TO ROMAN WILSO..." says nothing the card doesn't already).
  function compressPlay(play, sport, scorer) {
    if (!play) return '';
    const raw = String(play).replace(/\s+/g, ' ').trim();
    const up = raw.toUpperCase().replace(/\.$/, '');
    if (sport === 'FOOTBALL') {
      const yd = (raw.match(/(\d+)\s*yds?\b/i) || [])[1];
      const passer = (raw.match(/([A-Z][A-Za-z.'-]+)\s+(?:pass|sacked)/) || [])[1];
      if (/\bpass\b/i.test(raw)) return (yd ? yd + ' YD ' : '') + 'PASS' + (passer ? ' FROM ' + passer.toUpperCase() : '');
      if (/\brun\b|\brush/i.test(raw)) return (yd ? yd + ' YD ' : '') + 'RUN';
      if (/field goal/i.test(raw)) return (yd ? yd + ' YD ' : '') + 'FIELD GOAL';
      if (/kickoff|punt/i.test(raw) && /return/i.test(raw)) return (yd ? yd + ' YD ' : '') + 'RETURN';
      if (/interception|fumble/i.test(raw)) return /interception/i.test(raw) ? 'PICK SIX' : 'FUMBLE RETURN';
    } else if (sport === 'HOCKEY') {
      // "Dylan Larkin Goal (12): Wrist Shot, assists: Raymond, DeBrincat"
      const tail = up.split(':').slice(1).join(':').trim();
      if (tail) {
        const [shot, ...rest] = tail.split(/,?\s*ASSISTS:\s*/);
        const assists = rest.join(' ').trim();
        if (!assists || /^NONE$/.test(assists)) return (shot || '').replace(/,$/, '').trim() || 'UNASSISTED';
        return (shot ? shot.replace(/,$/, '').trim() + ' · ' : '') + 'A: ' + assists;
      }
    } else if (sport === 'BASEBALL') {
      // "...homers (41) on a fly ball to left center field."
      const on = up.split(/\bON A\b/)[1];
      if (on) return on.replace(/\bFIELD\b/g, '').replace(/\s+/g, ' ').trim();
    }
    // Everything else: drop the scorer's own name (the card already prints it)
    // and hand the rest over; the renderer clips it to the real column width.
    let s = up;
    if (scorer) s = s.replace(new RegExp('^.*?' + scorer + '\\b', 'i'), '').trim();
    return s.replace(/^[-:,\s]+/, '') || up;
  }

  // Pull the scorer + a short stat line out of an ESPN lastPlay string for the
  // player-card phase. Not a full bio (no API round-trip per score — flaky live
  // and heavy); the play text itself carries who + a season count, exactly like
  // Glance's "GOAL 1: SHOT, ASSISTS: NONE" card, which is also play-derived.
  //   "Aaron Judge homers (41) on a fly ball..."   -> Judge / HR #41
  //   "Dylan Larkin Goal (12): Wrist Shot, ..."     -> Larkin / GOAL #12
  //   "...pass deep right to Roman Wilson for 24 yds, TD" -> Wilson / TD 24 YDS
  // Grab the SURNAME from the first two adjacent capitalized tokens of a string
  // ("Aaron Judge homers" -> JUDGE, "Roman Wilson for" -> WILSON). Only two
  // tokens so a capitalized stat word after the name ("Larkin Goal") can't be
  // mistaken for the surname.
  function surnameFrom(s) {
    const m = (s || '').match(/([A-Z][A-Za-z.'-]+)\s+([A-Z][A-Za-z.'-]+)/);
    return m ? m[2] : '';
  }
  function parseScorer(play, sport) {
    if (!play) return { name: '', stat: '' };
    const num = (play.match(/\((\d+)\)/) || [])[1];
    // football TD scorer is the receiver/rusher, named AFTER "to"; other sports
    // lead with the scorer.
    let name = '';
    if (sport === 'FOOTBALL') {
      const to = play.split(/\bto\b/i)[1];
      name = surnameFrom(to) || surnameFrom(play);
    } else {
      name = surnameFrom(play);
    }
    let stat = '';
    if (sport === 'BASEBALL') {
      // 2026-08-05 bug (Jeff, watching an Orioles game): the card said HOME RUN
      // on every single scoring play. This line used to hardcode it, so an RBI
      // single, a sac fly, a walk with the bases loaded and a wild pitch all
      // announced a home run. Read the play text instead, and only claim a home
      // run when ESPN actually says one happened. queueTakeover() already gates
      // the HR *animation* on the same test -- this is the card's stat line
      // catching up to it.
      const p = play.toLowerCase();
      if (/grand slam/.test(p)) stat = num ? 'GRAND SLAM #' + num : 'GRAND SLAM';
      else if (/home run|homers?\b/.test(p)) stat = num ? 'HOME RUN #' + num : 'HOME RUN';
      else if (/\bdoubles?\b/.test(p)) stat = 'RBI DOUBLE';
      else if (/\btriples?\b/.test(p)) stat = 'RBI TRIPLE';
      else if (/\bsingles?\b/.test(p)) stat = 'RBI SINGLE';
      else if (/sacrifice fly|sac fly/.test(p)) stat = 'SAC FLY';
      else if (/walk|hit by pitch/.test(p)) stat = 'RBI WALK';
      else if (/wild pitch/.test(p)) stat = 'WILD PITCH';
      else if (/passed ball/.test(p)) stat = 'PASSED BALL';
      else if (/error/.test(p)) stat = 'ON AN ERROR';
      else if (/steals home|steal of home/.test(p)) stat = 'STEALS HOME';
      else stat = 'RUN SCORES';
    }
    else if (sport === 'HOCKEY') stat = num ? 'GOAL #' + num : 'GOAL';
    else if (sport === 'SOCCER') stat = 'GOAL';
    else if (sport === 'FOOTBALL') {
      // 2026-08-10: this hardcoded TOUCHDOWN, so a field goal card read
      // "TOUCHDOWN · 43 YDS" -- the exact bug class as the baseball HOME RUN
      // false-fire fixed on 2026-08-05, just in the other sport. Caught on the
      // phase B proof render. queueTakeover already reads the play text to pick
      // the headline; the stat line now agrees with it.
      const yd = (play.match(/(\d+)\s*yds?/i) || [])[1];
      const p = play.toLowerCase();
      let what = 'TOUCHDOWN';
      if (/field goal/.test(p)) what = 'FIELD GOAL';
      else if (/safety/.test(p)) what = 'SAFETY';
      else if (/two-point|2-point/.test(p)) what = 'TWO-POINT';
      else if (/extra point/.test(p)) what = 'EXTRA POINT';
      stat = yd ? what + ' · ' + yd + ' YDS' : what;
    } else stat = 'SCORE';
    return { name: name.toUpperCase(), stat };
  }

  function drawTakeover(ev, t) {
    const W = viewCols;
    if (!W) return; // hidden/zero-width viewport: keep the freeze, skip the draw
    if (!TK.panel || TK.panel.width !== W) {
      TK.panel = document.createElement('canvas');
      TK.panel.width = W; TK.panel.height = ROWS;
    }
    const g = TK.panel.getContext('2d');
    g.imageSmoothingEnabled = false; // scaled takeover logos stay pixel-crisp
    g.fillStyle = '#000'; g.fillRect(0, 0, W, ROWS);
    window.TICKERRENDER.takeover.frame(g, ev, t, W);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, strip.width, strip.height);
    ctx.imageSmoothingEnabled = false;
    // same two-pass LED bloom as the tape's glow layer
    ctx.filter = 'blur(0.6px)'; ctx.globalAlpha = 0.35;
    ctx.drawImage(TK.panel, 0, 0, W, ROWS, 0, 0, W * pitch, ROWS * pitch);
    ctx.filter = 'none'; ctx.globalAlpha = 1;
    ctx.drawImage(TK.panel, 0, 0, W, ROWS, 0, 0, W * pitch, ROWS * pitch);
  }

  function renderStatus() {
    if (!healthy) {
      pulse.className = 'pulse err';
      statusText.textContent = 'OFFLINE - RETRYING';
      return;
    }
    const live = data.games.filter(g => g.state === 'in').length;
    const ago = Math.max(0, Math.floor((Date.now() - lastFetch) / 1000));
    const bits = [live > 0 ? live + ' LIVE' : data.games.length + ' GAMES', fmtAgo(ago)];
    pulse.className = live > 0 ? 'pulse live' : 'pulse idle';
    statusText.textContent = bits.join(' · ');
    infoBadge.textContent = 'LIVE: SCORES · STOCKS · CRYPTO · NEWS · WX  —  DEMO: CALENDAR · YT · NOW PLAYING';
  }

  // Display settings (Phase 4, 2026-08-10): logo size + card density live in
  // render.js, scroll speed lives here. Applied on every settings read so the
  // 15s watcher below picks changes up without a reload.
  function applyDisplaySettings(settings) {
    if (window.TICKERRENDER.setDisplay) {
      window.TICKERRENDER.setDisplay({ logoSize: settings.logoSize, density: settings.density,
                                      wordmarkSize: settings.wordmarkSize });
    }
    // Stage 4's toggle. Missing key -> 'all', the same missing-key-means-on
    // convention the sport/segment toggles use.
    const sf = settings.scoreFlash;
    SF.mode = (sf === 'favorites' || sf === 'off') ? sf : 'all';
    const sp = +settings.scrollSpeed;
    // Only follow the setting while nothing has been nudged locally this
    // session (tray presets / mouse wheel still win until the next reload).
    if (sp >= 10 && sp <= 400 && !speedTouched && sp !== pps) { pps = sp; if (typeof speedLabel === 'function') speedLabel(); }
  }

  async function refreshScores() {
    try {
      const settings = await window.TICKERDATA.fetchSettings();
      applyDisplaySettings(settings);
      const seg = settings.segments || {}; // missing key -> on, same convention as settings.sports
      const on = k => seg[k] !== false;
      const [games, coins, stocks, indices, golf, racing, ufc, nowPlaying] = await Promise.all([
        window.TICKERDATA.fetchScores(),
        window.TICKERDATA.fetchCrypto(),
        window.TICKERDATA.fetchStocks(),
        window.TICKERDATA.fetchIndices(),
        on('golf') ? window.TICKERDATA.fetchGolf() : Promise.resolve(null),
        on('racing') ? window.TICKERDATA.fetchRacing() : Promise.resolve(null),
        on('ufc') ? window.TICKERDATA.fetchUfc() : Promise.resolve(null),
        window.TICKERDATA.fetchNowPlaying(), // core, always on -- not a segment toggle
      ]);
      if (games.length) { markScoreChanges(games); data.games = games; }
      data.nowPlaying = nowPlaying; // null when nothing's playing — segment drops out
      if (coins.length) data.coins = coins;
      if (stocks.length) data.stocks = stocks;
      if (indices.length) data.indices = indices;
      // Toggled off force-clears rather than just skipping the assign, so
      // flipping the switch drops the segment immediately instead of leaving
      // whatever was fetched last still riding the tape.
      if (on('golf')) { if (golf) data.golf = golf; } else { data.golf = null; }
      if (on('racing')) { if (racing) data.racing = racing; } else { data.racing = null; }
      if (on('ufc')) { if (ufc) data.ufc = ufc; } else { data.ufc = null; }
      healthy = games.length > 0 || coins.length > 0 || data.news.length > 0;
      lastFetch = Date.now();
      recompose();
      renderStatus();
    } catch (e) {
      healthy = false;
      renderStatus();
    }
  }

  async function refreshExtras() {
    const settings = await window.TICKERDATA.fetchSettings();
    const seg = settings.segments || {};
    const on = k => seg[k] !== false;
    const [news, weather, topCoins, standings, trivia, michigan, leaders, top25, teamStats] = await Promise.all([
      window.TICKERDATA.fetchNews(),
      window.TICKERDATA.fetchWeather(),
      window.TICKERDATA.fetchTopCoins(),
      on('standings') ? window.TICKERDATA.fetchStandings() : Promise.resolve([]),
      on('trivia') ? window.TICKERDATA.fetchTrivia() : Promise.resolve([]),
      window.TICKERDATA.fetchMichigan(),
      // Leaders + team stats share one toggle -- they ride the same renderer.
      on('leaders') ? window.TICKERDATA.fetchLeaders() : Promise.resolve([]),
      on('top25') ? window.TICKERDATA.fetchRankings() : Promise.resolve(null),
      on('leaders') ? window.TICKERDATA.fetchTeamStats() : Promise.resolve([]),
    ]);
    const [steam, twitch, draft, onThisDay] = await Promise.all([
      on('steam') ? window.TICKERDATA.fetchSteam() : Promise.resolve([]),
      on('twitch') ? window.TICKERDATA.fetchTwitch() : Promise.resolve([]),
      on('draft') ? window.TICKERDATA.fetchDraft() : Promise.resolve(null),
      on('otd') ? window.TICKERDATA.fetchOnThisDay() : Promise.resolve([]),
    ]);
    if (on('steam')) { if (steam.length) data.steam = steam; } else { data.steam = []; }
    data.twitch = on('twitch') ? twitch : [];   // [] when nobody's live / no key / toggled off
    data.draft = on('draft') ? draft : null;
    if (on('otd')) { if (onThisDay.length) data.onThisDay = onThisDay; } else { data.onThisDay = []; }
    if (news.length) data.news = news;
    if (weather) data.weather = weather;
    if (topCoins.length) data.topCoins = topCoins;
    if (on('standings')) { if (standings.length) data.standings = standings; } else { data.standings = []; }
    if (on('trivia')) { if (trivia.length) data.trivia = trivia; } else { data.trivia = []; }
    if (michigan) data.michigan = michigan;
    // Team stats ride the same queue/renderer as athlete leaders — one card
    // language for both, like the reference ticker's TEAM STATS screens.
    if (on('leaders')) {
      const allLeaders = leaders.concat(teamStats || []);
      if (allLeaders.length) data.leaders = allLeaders;
    } else {
      data.leaders = [];
    }
    if (on('top25')) { if (top25) data.top25 = top25; } else { data.top25 = null; }
    recompose();
    renderStatus();
  }

  frameEl.addEventListener('click', function () {
    mode = mode === 'dot' ? 'fit' : 'dot';
    layout();
    hint.classList.add('fade');
  });

  const speedEl = document.getElementById('speed');
  const speedVal = document.getElementById('speedVal');
  function speedLabel() { speedVal.textContent = pps + ' PX/S'; }
  speedEl.value = pps;
  speedLabel();
  speedEl.addEventListener('input', function () {
    speedTouched = true;
    pps = +speedEl.value;
    speedLabel();
    localStorage.setItem('cbt-pps', pps);
  });

  // Speed control that works in the WIDGET too: the desktop bar has no slider
  // (and Electron's localStorage is a separate profile from the browser's, so
  // the browser slider never affected it). Mouse wheel over the bar nudges the
  // speed; the tray menu calls __setSpeed with presets. A transient toast shows
  // the new value since the widget has no status UI.
  let toastEl = null, toastT = null;
  function speedToast() {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;top:4px;right:10px;z-index:99;' +
        'background:#000;color:#0f0;border:1px solid #0f0;padding:2px 8px;' +
        'font:12px monospace;pointer-events:none;opacity:0;transition:opacity .2s';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = 'SPEED ' + pps + ' PX/S';
    toastEl.style.opacity = '1';
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.style.opacity = '0'; }, 1200);
  }
  function setSpeed(v, quiet) {
    speedTouched = true;
    pps = Math.max(10, Math.min(150, Math.round(v)));
    speedEl.value = pps;
    speedLabel();
    localStorage.setItem('cbt-pps', pps);
    if (!quiet) speedToast();
  }
  window.__setSpeed = setSpeed;
  window.addEventListener('wheel', function (e) {
    // Whole window in the widget; only over the ticker itself in the browser
    // (the browser page still has its slider, and hijacking scroll everywhere
    // there would be obnoxious).
    if (!isWidget && !frameEl.contains(e.target)) return;
    setSpeed(pps + (e.deltaY < 0 ? 5 : -5));
    e.preventDefault();
  }, { passive: false });
  setTimeout(function () { hint.classList.add('fade'); }, 8000);

  let resizeT = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(layout, 120);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(rafId); rafId = null; }
    else if (!rafId) { rafId = requestAnimationFrame(tick); }
  });

  // Weather alerts + overhead flights on their own cadence: 30min is too slow
  // for a tornado warning, 60s would hammer NWS/OpenSky for nothing. Flights
  // are server-cached 5min anyway.
  async function refreshUrgent() {
    const settings = await window.TICKERDATA.fetchSettings();
    const seg = settings.segments || {};
    const [alerts, flights] = await Promise.all([
      seg.alerts !== false ? window.TICKERDATA.fetchAlerts() : Promise.resolve([]),
      seg.flights !== false ? window.TICKERDATA.fetchFlights() : Promise.resolve([]),
    ]);
    data.alerts = alerts;   // [] clears expired alerts off the tape (or toggled off)
    data.flights = flights; // same
    recompose();
  }

  // Settings watcher (2026-08-10). Fixes Jeff's long-standing "sometimes the
  // settings will turn something off and it won't be off": a segment toggle is
  // only re-read when its own refresh cycle next runs, and the extras cycle is
  // 30 MINUTES. Flip Standings/Trivia/Steam/Draft/On-This-Day off in Settings
  // and it could keep scrolling for half an hour, which reads as "the toggle
  // didn't work". The server already busts its caches on save; this is the
  // browser side catching up. Cheap: one local request against a ~1KB file.
  const SETTINGS_WATCH_MS = 15 * 1000;
  let lastSettingsJSON = null;
  async function watchSettings() {
    try {
      const r = await fetch('/api/settings.json', { cache: 'no-store' });
      if (!r.ok) return;
      const txt = await r.text();
      if (lastSettingsJSON === null) { lastSettingsJSON = txt; return; }
      if (txt === lastSettingsJSON) return;
      lastSettingsJSON = txt;
      await Promise.all([refreshScores(), refreshExtras(), refreshUrgent()]);
    } catch (e) { /* server down / mid-write — try again next tick */ }
  }

  // --- Fast live poll ---------------------------------------------------------
  // The 60s score cycle was the whole latency budget: an average 30s blind
  // window before a touchdown is even seen, worst case 60s, before the takeover
  // queue gets a look at it. Jeff, 2026-08-14: "it took a very long time for a
  // touchdown in game to register."
  //
  // This polls scores 4x as often but does NOT recompose: recompose() jumps the
  // scroll to the next unseen segment (resumeAtUnseen), so doing it every 15s
  // would make the tape lurch four times a minute to buy nothing -- the
  // takeover is a full-panel overlay and doesn't need the tape rebuilt. Fresh
  // games are stashed for the 60s cycle to draw with; only score DETECTION is
  // pulled forward. Measured cost: 431ms of network, no layout work.
  const LIVE_POLL_SECS = 15;
  let livePolling = false;
  async function refreshLive() {
    if (livePolling) return;                       // a slow poll must not stack
    if (!data.games.some(g => g.state === 'in')) return;  // nothing live: the 60s cycle finds kickoff
    livePolling = true;
    try {
      const games = await window.TICKERDATA.fetchScores();
      if (games.length) { markScoreChanges(games); data.games = games; }
    } catch (e) { /* transient — the 60s cycle is still running underneath */ }
    livePolling = false;
  }

  setInterval(renderStatus, 1000);
  setInterval(refreshLive, LIVE_POLL_SECS * 1000);
  setInterval(refreshScores, SCORES_SECS * 1000);
  setInterval(refreshExtras, EXTRAS_SECS * 1000);
  setInterval(refreshUrgent, 5 * 60 * 1000);
  setInterval(watchSettings, SETTINGS_WATCH_MS);

  layout();
  refreshScores();
  refreshExtras();
  refreshUrgent();
  watchSettings();
  rafId = requestAnimationFrame(tick);

  // verification hooks (harmless in production) — same contract as ../webapp/app.js
  window.__tick = function (ts) { draw(ts); };
  window.__tape = function () { return src; };            // {width, chunks[], _index}
  // The tape is no longer one canvas, so pull a range back out as one for crops.
  window.__slice = function (x, w) { return window.TICKERRENDER.slice(src, x, w); };
  window.__recompose = function () { recompose(); };
  // Verification hook for the segment-resume: how much of the CURRENT tape has
  // actually been on screen, and where the next recompose would drop you.
  window.__coverage = function () {
    const total = (src && src._index) ? src._index.length : 0;
    let seenHere = 0;
    if (total) for (const e of src._index) if (seenSegs.has(segId(e))) seenHere++;
    return { seenOfThisTape: seenHere, total: total, seenIds: seenSegs.size, pos: Math.round(scrollPos) };
  };
  // Takeover test rig: fake events for each kind, playable live (__takeoverTest)
  // or rendered as one deterministic frame for proof crops (__takeoverPanel —
  // the preview pane throttles rAF, so verification can't rely on playback).
  // Cached per kind (2026-08-10, stage 2): the roster join enriches the event
  // OBJECT asynchronously, so handing every __takeoverPanel call a brand-new
  // object threw the resolved headshot away every frame and the proof could
  // only ever render the fallback.
  const _fakes = {};
  function fakeTakeover(kind) {
    const k = kind || 'td';
    if (_fakes[k]) return _fakes[k];
    const base = {
      // League/team are REAL and self-consistent so the roster join actually
      // runs in a proof instead of being faked: Michigan is NCAAF team 130, and
      // the play names a player on its current roster.
      kind: k, league: 'NCAAF', side: 'home', sport: 'FOOTBALL',
      team: 'MICH', teamName: 'WOLVERINES', teamId: '130',
      logo: 'https://a.espncdn.com/i/teamlogos/ncaa/500/130.png', color: '#00274c',
      awayTeam: 'OSU', awayScore: '17', homeTeam: 'MICH', homeScore: '24',
      oldA: 17, oldH: 18, // count-up rolls 18 -> 24 on the scoring side
      play: 'Bryce Underwood pass deep right to Kendrick Bell for 24 yds, TOUCHDOWN.',
      clockTxt: '7:32 3RD',
      michigan: true,
    };
    if (k === 'hr') Object.assign(base, {
      kind: 'hr', league: 'MLB', sport: 'BASEBALL', team: 'NYY', teamName: 'YANKEES', teamId: 'nyy',
      awayTeam: 'BOS', awayScore: '2', homeTeam: 'NYY', homeScore: '4', oldA: 2, oldH: 3,
      logo: 'https://a.espncdn.com/i/teamlogos/mlb/500/nyy.png',
      // real ESPN team colour: the redesigned phase A floods the panel with it,
      // so a fixture inheriting Michigan's navy renders a convincing LIE (the
      // Red Wings' GOAL came out Michigan blue on the first proof).
      color: '#0c2340',
      play: 'Paul Goldschmidt homers (18) on a fly ball to left center field.',
      clockTxt: 'BOT 7TH',
    });
    if (k === 'goal') Object.assign(base, {
      kind: 'alert', league: 'NHL', sport: 'HOCKEY', team: 'DET', teamName: 'RED WINGS', teamId: 'det',
      awayTeam: 'DET', awayScore: '3', homeTeam: 'CHI', homeScore: '1', side: 'away', oldA: 2, oldH: 1,
      logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/det.png',
      color: '#ce1126',
      play: 'Dylan Larkin Goal (12): Wrist Shot, assists: Raymond, DeBrincat',
      clockTxt: '11:04 2ND',
    });
    // Deliberate NON-match: Moody kicks for the 49ers, so this fixture proves
    // the unresolved path -- sport art, not a wrong face and not the team logo.
    if (k === 'fg') Object.assign(base, {
      kind: 'alert', headline: 'FIELD GOAL', banner: '#0a5c1e', awayScore: '17', homeScore: '20',
      oldA: 17, oldH: 17, play: 'Jake Moody 43 yd Field Goal GOOD.',
      clockTxt: '0:41 4TH',
    });
    // Stage 3 fixtures. The caret's whole job is to MOVE, so the two cases that
    // move it differently both need a proof: 'lead' overtakes (caret slides row
    // 0 -> row 1) and 'goahead' breaks a tie (no caret existed, it appears on
    // the row that just took it). Scores are set so the count-up itself is what
    // crosses the other team's number.
    if (k === 'lead') Object.assign(base, {
      kind: 'alert', league: 'NBA', sport: 'BASKETBALL', team: 'DET', teamName: 'PISTONS', teamId: 'det',
      awayTeam: 'BOS', awayScore: '98', homeTeam: 'DET', homeScore: '99', side: 'home',
      oldA: 98, oldH: 96,                    // BOS led by 2, the 3 flips it
      logo: 'https://a.espncdn.com/i/teamlogos/nba/500/det.png',
      color: '#c8102e',
      play: 'Cade Cunningham makes 26-foot three point jumper',
      clockTxt: '1:12 4TH',
      leadChange: true, leadLabel: 'LEAD CHANGE',
    });
    if (k === 'goahead') Object.assign(base, {
      kind: 'alert', league: 'NHL', sport: 'HOCKEY', team: 'DET', teamName: 'RED WINGS', teamId: 'det',
      awayTeam: 'DET', awayScore: '3', homeTeam: 'CHI', homeScore: '2', side: 'away',
      oldA: 2, oldH: 2,                      // tied, so nobody held the caret
      logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/det.png',
      color: '#ce1126',
      play: 'Dylan Larkin Goal (12): Wrist Shot, assists: Raymond, DeBrincat',
      clockTxt: '4:08 3RD',
      leadChange: true, leadLabel: 'GO-AHEAD',
    });
    const p = parseScorer(base.play, base.sport);
    base.playerName = p.name; base.playerStat = p.stat;
    base.playLine = compressPlay(base.play, base.sport, p.name);
    _fakes[k] = base;
    enrichScorer(base);
    return base;
  }
  window.__takeoverTest = function (kind) { TK.queue.push(fakeTakeover(kind)); };
  // Stage 5's router decides which TIER a score gets, and that decision is pure
  // logic with no pixels to crop -- so it gets a hook that answers the same
  // question queueTakeover asks, instead of a screenshot that can't show it.
  // 'full' = pause the tape, 'flash' = the card flashes in place, 'none' = the
  // pre-router rule dropped it (a basketball basket, a PAT).
  window.__routeTest = function (sport, d, play, prevA, prevH, a, h) {
    const leadLabel = leadShift({ a: prevA, h: prevH }, a, h);
    if (sport === 'FOOTBALL' && d === 1) return 'none';           // PAT rides its TD
    if (tkOn('router')) {
      return (isBigPlay(sport, d, play) || leadLabel) ? 'full' : 'flash';
    }
    return (sport === 'BASKETBALL' && !leadLabel) ? 'none' : 'full';
  };
  window.__takeoverPanel = function (kind, t, w) {
    return window.TICKERRENDER.takeover.debug(fakeTakeover(kind), t == null ? 2000 : t, w || viewCols);
  };
  Object.defineProperty(window, '__state', {
    get: function () {
      return { srcW: src && src.width, pos: Math.round(scrollPos), games: data.games.length, healthy: healthy };
    },
  });
})();
