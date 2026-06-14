/* =============================================================================
   2026 World Cup Fantasy — live tracker engine + UI
   Reads: window.LEAGUE (config), window.RESULTS (scores), window.CONFIG (feed)
   ========================================================================== */
(function () {
  "use strict";

  const L = window.LEAGUE;
  const CFG = window.CONFIG || { refreshSeconds: 60, live: { enabled: false } };
  const STORE_KEY = "wc2026.results.v1";
  const BASELINE_KEY = "wc2026.baseline.v1";

  /* ---------- small helpers ------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // canonical team name (absorbs spreadsheet typos + API spellings)
  function canon(name) {
    if (name == null) return name;
    const key = String(name).trim().toLowerCase();
    return (L.aliases && L.aliases[key]) || String(name).trim();
  }
  const ALL_TEAMS = Object.values(L.groups).flat();
  const GROUP_OF = {};
  Object.entries(L.groups).forEach(([g, teams]) => teams.forEach((t) => (GROUP_OF[t] = g)));
  const OWNER_OF = {};
  L.managers.forEach((m) => m.teams.forEach((t) => (OWNER_OF[canon(t)] = m.name)));
  const MANAGER = Object.fromEntries(L.managers.map((m) => [m.name, m]));

  /* ---------- working results (seed file + browser edits) ------------------ */
  function loadResults() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(window.RESULTS));
  }
  function saveResults(r) {
    state.results = r;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch (e) {}
  }

  const state = {
    results: loadResults(),
    live: !!(CFG.live && CFG.live.enabled),
    lastFetch: null,
    lastError: null
  };

  /* =========================================================================
     ENGINE — turn scores into team points, then manager standings.
     ====================================================================== */
  const SG = L.scoring.group;
  const SK = L.scoring.knockout;
  const KO_BONUS = { r32: 0, r16: SK.r16, qf: SK.qf, sf: SK.sf, final: SK.final, third: SK.final, champion: SK.champion };
  const KO_ORDER = ["r32", "r16", "qf", "sf", "final", "third", "champion"];

  function blankTeam() {
    return { gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, stand: 0, fpts: 0, fromMatch: false,
             groupBonus: 0, koBonus: 0, place: null };
  }

  function computeState() {
    const R = state.results;
    const team = {};
    ALL_TEAMS.forEach((t) => (team[t] = blankTeam()));

    // ----- process matches: ONLY finished games score points. A game must
    //       END before it counts — this matches the league spreadsheet, where
    //       points are awarded "as games end". Live games are shown in the
    //       games log / ticker but don't move the standings until final. -----
    const matches = Array.isArray(R.matches) ? R.matches : [];
    const groupPlayed = {}; // group -> count of finished group matches
    Object.keys(L.groups).forEach((g) => (groupPlayed[g] = 0));

    matches.forEach((m) => {
      if (!m || m.status !== "finished") return;
      const home = canon(m.home), away = canon(m.away);
      if (!team[home] || !team[away]) return;            // unknown team, skip
      const hs = Number(m.homeScore) || 0, as = Number(m.awayScore) || 0;
      const stage = m.stage || "group";
      const isGroup = stage === "group";

      [[home, hs, as], [away, as, hs]].forEach(([t, gf, ga]) => {
        const ts = team[t];
        ts.fromMatch = true;
        ts.gp += 1; ts.gf += gf; ts.ga += ga;
        if (gf > ga) ts.w += 1; else if (gf === ga) ts.d += 1; else ts.l += 1;
        ts.stand += gf > ga ? 3 : gf === ga ? 1 : 0;     // real 3/1/0 for ranking

        if (isGroup) {
          ts.fpts += gf > ga ? SG.win : gf === ga ? SG.draw : 0;
          ts.fpts += gf * SG.goalEach;
          if (ga === 0) ts.fpts += SG.shutout;
        } else {
          ts.fpts += gf * SK.goalEach;
          if (ga === 0) ts.fpts += SK.shutout;
        }
      });

      if (isGroup && m.status === "finished") {
        const g = m.group || GROUP_OF[home];
        if (g != null) groupPlayed[g] += 1;
      }
    });

    // ----- seed fallback: teams with no match use manual quick-points --------
    const manual = R.manualTeamPoints || {};
    Object.keys(manual).forEach((raw) => {
      const t = canon(raw);
      if (team[t] && !team[t].fromMatch) team[t].fpts = Number(manual[raw]) || 0;
    });

    // ----- group standings + winner / runner-up bonuses ----------------------
    const groupTables = {};
    Object.entries(L.groups).forEach(([g, teams]) => {
      const rows = teams.map((t) => team[t]);
      const order = teams.slice().sort((a, b) => {
        const A = team[a], B = team[b];
        return B.stand - A.stand || (B.gf - B.ga) - (A.gf - A.ga) || B.gf - A.gf || a.localeCompare(b);
      });
      const complete = groupPlayed[g] >= 6; // 4 teams → 6 matches total
      order.forEach((t, i) => {
        team[t].place = i + 1;
        if (complete) {
          if (i === 0) { team[t].groupBonus = SG.groupWinner; team[t].fpts += SG.groupWinner; }
          else if (i === 1) { team[t].groupBonus = SG.groupRunnerUp; team[t].fpts += SG.groupRunnerUp; }
        }
      });
      groupTables[g] = { order, complete };
    });

    // ----- knockout appearance bonuses (explicit map or derived) -------------
    const koMap = Object.assign({}, R.knockout || {});
    matches.forEach((m) => {
      if (!m || m.stage === "group" || m.status !== "finished") return;
      [canon(m.home), canon(m.away)].forEach((t) => {
        if (!team[t]) return;
        const cur = koMap[t];
        if (!cur || KO_ORDER.indexOf(m.stage) > KO_ORDER.indexOf(cur)) koMap[t] = m.stage;
      });
    });
    Object.entries(koMap).forEach(([raw, round]) => {
      const t = canon(raw);
      if (team[t] && KO_BONUS[round]) { team[t].koBonus = KO_BONUS[round]; team[t].fpts += KO_BONUS[round]; }
    });

    // ----- group games played / left per team (3 group games per team) -------
    const liveTeams = new Set();
    matches.forEach((m) => { if (m && m.status === "live") { liveTeams.add(canon(m.home)); liveTeams.add(canon(m.away)); } });
    ALL_TEAMS.forEach((t) => { team[t].live = liveTeams.has(t); team[t].left = Math.max(0, 3 - team[t].gp); });

    // ----- manager totals + ranking ------------------------------------------
    const managers = L.managers.map((m) => {
      const teamPts = m.teams.map((t) => ({ team: canon(t), pts: team[canon(t)].fpts }));
      const total = teamPts.reduce((s, x) => s + x.pts, 0);
      const gamesPlayed = m.teams.reduce((s, t) => s + team[canon(t)].gp, 0);
      const gamesLeft = m.teams.reduce((s, t) => s + team[canon(t)].left, 0);   // group games remaining
      const gamesLive = m.teams.reduce((s, t) => s + (team[canon(t)].live ? 1 : 0), 0);
      return { name: m.name, emoji: m.emoji, teams: teamPts, total, gamesPlayed, gamesLeft, gamesLive };
    });
    managers.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    let rank = 0, prev = null, seen = 0;
    managers.forEach((m) => { seen += 1; if (m.total !== prev) { rank = seen; prev = m.total; } m.rank = rank; });

    // ----- $50 side pool among the remaining 8 -------------------------------
    const eight = L.remainingEight.map((t) => ({ team: canon(t), pts: team[canon(t)].fpts }))
      .sort((a, b) => b.pts - a.pts || a.team.localeCompare(b.team));
    const actualTop = eight[0], actualRU = eight[1];
    const sidePool = (L.sidePool || []).map((p) => ({
      manager: p.manager, top: canon(p.top), runnerUp: canon(p.runnerUp), team: canon(p.team),
      topHit: actualTop && canon(p.top) === actualTop.team,
      ruHit: actualRU && canon(p.runnerUp) === actualRU.team
    }));
    sidePool.sort((a, b) => (b.topHit + b.ruHit) - (a.topHit + a.ruHit) || a.manager.localeCompare(b.manager));

    // ----- games log (finished) + live-now (in progress) for display ---------
    const known = (m) => m && team[canon(m.home)] && team[canon(m.away)];
    const fmt = (m) => ({
      home: canon(m.home), away: canon(m.away),
      hs: Number(m.homeScore) || 0, as: Number(m.awayScore) || 0,
      group: GROUP_OF[canon(m.home)] || null, stage: m.stage || "group"
    });
    const log = matches.filter((m) => known(m) && m.status === "finished").map(fmt);
    const liveNow = matches.filter((m) => known(m) && m.status === "live").map(fmt);

    return { team, managers, groupTables, eight, actualTop, actualRU, sidePool, log, liveNow };
  }

  /* =========================================================================
     MOVEMENT — compare each refresh to the previous one (NYSE-style arrows).
     ====================================================================== */
  function getBaseline() {
    try { return JSON.parse(localStorage.getItem(BASELINE_KEY)) || {}; } catch (e) { return {}; }
  }
  function setBaseline(managers) {
    const snap = {};
    managers.forEach((m) => (snap[m.name] = { rank: m.rank, total: m.total }));
    try { localStorage.setItem(BASELINE_KEY, JSON.stringify(snap)); } catch (e) {}
  }
  function applyMovement(managers, baseline) {
    managers.forEach((m) => {
      const b = baseline[m.name];
      m.deltaRank = b ? b.rank - m.rank : 0;       // + = climbed
      m.deltaPts = b ? m.total - b.total : 0;
      m.isNew = !b;
    });
  }

  /* =========================================================================
     RENDER
     ====================================================================== */
  function arrow(d) {
    if (d > 0) return `<span class="mv up">▲ ${d}</span>`;
    if (d < 0) return `<span class="mv down">▼ ${-d}</span>`;
    return `<span class="mv flat">—</span>`;
  }

  function renderTicker(managers) {
    const track = $("#ticker-track");
    const leader = managers[0];
    const chips = managers.map((m) => {
      const lead = m.rank === 1;
      const ptsCls = m.deltaPts > 0 ? "up" : m.deltaPts < 0 ? "down" : "flat";
      const delta = m.deltaPts ? ` <span class="t-delta ${ptsCls}">${m.deltaPts > 0 ? "+" : ""}${m.deltaPts}</span>` : "";
      return `<span class="t-chip${lead ? " t-leader" : ""}">${lead ? "👑 " : ""}${m.emoji}
        <b>${esc(m.name.toUpperCase())}</b> <span class="t-pts">${m.total}</span>${delta}
        ${arrow(m.deltaRank)}</span><span class="t-sep">◆</span>`;
    }).join("");
    // marquee spotlight for the current leader, then full standings tape (x2 for seamless loop)
    const spotlight = `<span class="t-chip t-spot">👑 ${leader.emoji} <b>${esc(leader.name.toUpperCase())}</b>
      LEADS WITH ${leader.total} PTS</span><span class="t-sep">◆</span>`;
    const tape = spotlight + chips;
    track.innerHTML = tape + tape;
    // speed scales with content so it always reads at a steady pace
    const secs = Math.max(18, Math.round(managers.length * 4.2));
    track.style.animationDuration = secs + "s";
  }

  function renderLeaderboard(managers) {
    const box = $("#leaderboard");
    box.innerHTML = "";
    managers.forEach((m) => {
      const card = el("div", "lb-row" + (m.rank === 1 ? " lb-leader" : ""));
      const teams = m.teams.map((t) => {
        const ts = state.computed.team[t.team];
        const tag = ts.groupBonus === SG.groupWinner ? `<span class="tg win">GW +${SG.groupWinner}</span>`
          : ts.groupBonus === SG.groupRunnerUp ? `<span class="tg ru">RU +${SG.groupRunnerUp}</span>` : "";
        return `<span class="lb-team"><span class="lb-team-name">${esc(t.team)}</span>
          <span class="lb-team-pts">${t.pts}</span>${tag}</span>`;
      }).join("");
      card.innerHTML = `
        <div class="lb-rank">${m.rank === 1 ? "👑" : "#" + m.rank}</div>
        <div class="lb-emoji">${m.emoji}</div>
        <div class="lb-main">
          <div class="lb-name">${esc(m.name)} ${m.isNew ? "" : arrow(m.deltaRank)}
            <span class="lb-left" title="group games left for this squad (of 12)">${m.gamesLeft} left${m.gamesLive ? ` <span class="lb-livedot">🔴${m.gamesLive}</span>` : ""}</span></div>
          <div class="lb-teams">${teams}</div>
        </div>
        <div class="lb-total">
          <div class="lb-total-pts">${m.total}</div>
          <div class="lb-total-lbl">PTS</div>
        </div>`;
      box.appendChild(card);
    });
  }

  function renderGroups(computed) {
    const box = $("#groups");
    box.innerHTML = "";
    Object.entries(L.groups).forEach(([g, teams]) => {
      const gt = computed.groupTables[g];
      const card = el("div", "grp");
      const rows = gt.order.map((t, i) => {
        const ts = computed.team[t];
        const owner = OWNER_OF[t];
        const mgr = owner ? MANAGER[owner] : null;
        const place = gt.complete && i === 0 ? "🥇" : gt.complete && i === 1 ? "🥈" : (i + 1);
        return `<tr class="${i < 2 ? "qual" : ""}">
          <td class="g-pos">${place}</td>
          <td class="g-team">${esc(t)} ${mgr ? `<span class="g-own" title="${esc(owner)}">${mgr.emoji}</span>` : `<span class="g-own g-free" title="Undrafted (side pool)">·</span>`}</td>
          <td class="g-n">${ts.gp}</td>
          <td class="g-n">${ts.gf}-${ts.ga}</td>
          <td class="g-fpts">${ts.fpts}</td></tr>`;
      }).join("");
      card.innerHTML = `<div class="grp-h">Group ${g} ${gt.complete ? "" : '<span class="grp-live">in play</span>'}</div>
        <table class="grp-t"><thead><tr><th></th><th>Team</th><th>GP</th><th>GF-GA</th><th>Pts</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
      box.appendChild(card);
    });
  }

  function renderSidePool(computed) {
    const box = $("#sidepool");
    const eight = computed.eight.map((e, i) =>
      `<span class="sp-team${i === 0 ? " sp-top" : i === 1 ? " sp-ru" : ""}">${i === 0 ? "🏆 " : i === 1 ? "🥈 " : ""}${esc(e.team)} <b>${e.pts}</b></span>`
    ).join("");
    const picks = computed.sidePool.map((p) =>
      `<tr><td>${esc(p.manager)}</td>
        <td class="${p.topHit ? "hit" : ""}">${esc(p.top)}${p.topHit ? " ✓" : ""}</td>
        <td class="${p.ruHit ? "hit" : ""}">${esc(p.runnerUp)}${p.ruHit ? " ✓" : ""}</td>
        <td>${esc(p.team)}</td></tr>`
    ).join("");
    const leader = computed.sidePool.find((p) => p.topHit) || null;
    box.innerHTML = `
      <div class="panel-h">💰 Remaining 8 — $${L.pots.sidePool} Side Pool</div>
      <div class="sp-standings">${eight}</div>
      <table class="sp-t"><thead><tr><th>Manager</th><th>Top winner</th><th>Runner-up</th><th>Team</th></tr></thead>
        <tbody>${picks}</tbody></table>
      <div class="sp-note">${leader
        ? `Projected pool winner: <b>${esc(leader.manager)}</b> (called ${esc(computed.actualTop.team)} on top)`
        : `No one has the current top team (${esc(computed.actualTop ? computed.actualTop.team : "—")}) yet.`}</div>`;
  }

  function renderPots(computed) {
    const box = $("#pots");
    const leader = computed.managers[0];
    const runner = computed.managers[1];
    box.innerHTML = `
      <div class="panel-h">🏆 Money Pots</div>
      <div class="pot-grid">
        <div class="pot">
          <div class="pot-amt">$${L.pots.main}</div>
          <div class="pot-lbl">Main pot · Group stage</div>
          <div class="pot-line">Leader: <b>${leader.emoji} ${esc(leader.name)}</b></div>
          <div class="pot-line dim">Runner-up gets buy-in back: ${runner ? esc(runner.name) : "—"}</div>
        </div>
        <div class="pot">
          <div class="pot-amt">$${L.pots.sidePool}</div>
          <div class="pot-lbl">Remaining-8 side pool</div>
          <div class="pot-line">Top team: <b>${computed.actualTop ? esc(computed.actualTop.team) : "—"}</b></div>
          <div class="pot-line dim">Buy-in $${L.pots.buyIn}/manager</div>
        </div>
      </div>`;
  }

  function renderGames(computed) {
    const box = $("#games");
    if (!box) return;
    const ownerTag = (t) => {
      const o = OWNER_OF[t]; const mgr = o ? MANAGER[o] : null;
      return mgr ? `<span class="lg-own" title="${esc(o)}">${mgr.emoji}</span>` : "";
    };
    const row = (m, live) => `<div class="lg-row${live ? " lg-live" : ""}">
      <span class="lg-g">${live ? "🔴" : (m.group || m.stage)}</span>
      <span class="lg-m">${esc(m.home)} ${ownerTag(m.home)} <b>${m.hs}–${m.as}</b> ${ownerTag(m.away)} ${esc(m.away)}</span></div>`;
    const live = computed.liveNow.map((m) => row(m, true)).join("");
    const finished = computed.log.slice().reverse();   // newest first
    const done = finished.length ? finished.map((m) => row(m, false)).join("")
      : `<div class="lg-empty">No games have finished yet.</div>`;
    box.innerHTML = `
      <div class="panel-h">📋 Games Played
        <span class="dim">${finished.length} final${computed.liveNow.length ? ` · ${computed.liveNow.length} live` : ""}</span></div>
      ${live ? `<div class="lg-livewrap">${live}</div>` : ""}
      <div class="lg-list">${done}</div>`;
  }

  // Manager's Clubs — each manager's 4 drafted teams with live points (mirrors the sheet block)
  function renderClubs(computed) {
    const box = $("#clubs"); if (!box) return;
    box.innerHTML = L.managers.map((m) => {
      const teams = m.teams.map((t) => {
        const ct = canon(t), ts = computed.team[ct];
        const tag = ts.groupBonus === SG.groupWinner ? '<span class="tg win">GW</span>'
          : ts.groupBonus === SG.groupRunnerUp ? '<span class="tg ru">RU</span>' : "";
        return `<div class="club-team"><span class="ct-name">${esc(ct)}</span>
          <span class="ct-gp" title="group games played">${ts.gp}/3${ts.live ? ' <span class="ct-live">●LIVE</span>' : ""}</span>
          <span class="club-pts">${ts.fpts}${tag}</span></div>`;
      }).join("");
      const total = m.teams.reduce((s, t) => s + computed.team[canon(t)].fpts, 0);
      const left = m.teams.reduce((s, t) => s + computed.team[canon(t)].left, 0);
      return `<div class="club"><div class="club-h">${m.emoji} <b>${esc(m.name)}</b>
        <span class="club-left" title="group games left (of 12)">${left} left</span>
        <span class="club-total">${total}</span></div>${teams}</div>`;
    }).join("");
  }

  // Preseason rank (from the sheet) vs current live rank, with movement since preseason
  function renderPreseason(computed) {
    const box = $("#preseason"); if (!box) return;
    const pr = L.preseasonRank || {};
    const liveRank = Object.fromEntries(computed.managers.map((m) => [m.name, m.rank]));
    const rows = Object.entries(pr).sort((a, b) => a[1] - b[1]).map(([name, rank]) => {
      const lr = liveRank[name] || "—", d = (typeof lr === "number") ? rank - lr : 0;
      const mv = d > 0 ? `<span class="mv up">▲ ${d}</span>` : d < 0 ? `<span class="mv down">▼ ${-d}</span>` : `<span class="mv flat">—</span>`;
      const m = MANAGER[name];
      return `<tr><td class="g-pos">${rank}</td><td class="ps-name">${m ? m.emoji : ""} ${esc(name)}</td>
        <td class="g-n">#${lr}</td><td class="ps-mv">${mv}</td></tr>`;
    }).join("");
    box.innerHTML = `<div class="panel-h">📊 Preseason Rank <span class="dim">vs live</span></div>
      <table class="ps-t"><thead><tr><th>Pre</th><th>Manager</th><th>Now</th><th>±</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Scoring rules reference (static, from the sheet)
  function renderRules() {
    const box = $("#rules"); if (!box) return;
    const g = L.scoring.group, k = L.scoring.knockout;
    const r = (label, val, plus) => `<div class="rule"><span>${label}</span><b>${plus ? "+" : ""}${val}</b></div>`;
    box.innerHTML = `<div class="panel-h">📏 Scoring Rules</div>
      <div class="rules-wrap">
        <div class="rules-col"><div class="rules-h">Group Stage</div>
          ${r("Win", g.win)}${r("Draw", g.draw)}${r("Goal (each)", g.goalEach)}${r("Shutout", g.shutout)}
          ${r("Wins group", g.groupWinner, true)}${r("Group runner-up", g.groupRunnerUp, true)}</div>
        <div class="rules-col"><div class="rules-h">Round of 32 → Final</div>
          ${r("Goal (each)", k.goalEach)}${r("Shutout", k.shutout)}${r("Reach R16", k.r16, true)}
          ${r("Quarterfinal", k.qf, true)}${r("Semifinal", k.sf, true)}${r("Final", k.final, true)}${r("Champion", k.champion, true)}</div>
      </div>`;
  }

  /* ---------- full board render -------------------------------------------- */
  function renderBoard(advanceBaseline) {
    const computed = computeState();
    const baseline = getBaseline();
    applyMovement(computed.managers, baseline);
    state.computed = computed;

    renderTicker(computed.managers);
    renderLeaderboard(computed.managers);
    renderGroups(computed);
    renderSidePool(computed);
    renderPots(computed);
    renderGames(computed);
    renderClubs(computed);
    renderPreseason(computed);
    renderRules();

    const lu = state.lastFetch || state.results.lastUpdated;
    $("#last-updated").textContent = lu ? new Date(lu).toLocaleString() : "—";
    $("#live-state").innerHTML = state.live
      ? (state.lastError ? `<span class="warn">⚠ feed error — using manual</span>` : `<span class="ok">● LIVE feed</span>`)
      : `<span class="man">✎ manual mode</span>`;

    if (advanceBaseline) setBaseline(computed.managers);
  }

  /* =========================================================================
     LIVE FEED ADAPTERS (optional). Always falls back to manual on failure.
     ====================================================================== */
  async function fetchLive() {
    const live = CFG.live || {};
    try {
      let matches = [];
      if (live.provider === "custom") {
        const base = (live.proxyUrl || "") + (live.customUrl || "");
        if (!base) throw new Error("customUrl not set");
        const url = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now(); // bust CDN/browser cache
        const data = await (await fetch(url, { cache: "no-store" })).json();
        matches = (data.matches || data).map(normalizeCustom);
      } else if (live.provider === "football-data") {
        const base = `https://api.football-data.org/v4/competitions/${live.competition || "WC"}/matches`;
        const url = (live.proxyUrl || "") + base;
        const data = await (await fetch(url, { headers: live.apiKey ? { "X-Auth-Token": live.apiKey } : {} })).json();
        matches = (data.matches || []).map(normalizeFootballData);
      } else if (live.provider === "api-football") {
        const base = `https://v3.football.api-sports.io/fixtures?league=1&season=2026`;
        const url = (live.proxyUrl || "") + base;
        const data = await (await fetch(url, { headers: { "x-apisports-key": live.apiKey || "" } })).json();
        matches = (data.response || []).map(normalizeApiFootball);
      }
      // merge: live matches replace manual for teams they cover
      const r = state.results;
      r.matches = matches;
      saveResults(r);
      state.lastFetch = new Date().toISOString();
      state.lastError = null;
    } catch (e) {
      state.lastError = e.message || String(e);
      console.warn("[live feed] falling back to manual:", e);
    }
  }
  function normalizeCustom(m) {
    return { stage: m.stage || "group", group: m.group, home: m.home, away: m.away,
             homeScore: m.homeScore, awayScore: m.awayScore, status: m.status || "finished" };
  }
  function normalizeFootballData(m) {
    const st = { GROUP_STAGE: "group", LAST_16: "r16", QUARTER_FINALS: "qf", SEMI_FINALS: "sf",
                 FINAL: "final", THIRD_PLACE: "third" }[m.stage] || "group";
    const status = m.status === "FINISHED" ? "finished" : (m.status === "IN_PLAY" || m.status === "PAUSED") ? "live" : "scheduled";
    return { stage: st, group: (m.group || "").replace("GROUP_", "") || undefined,
             home: m.homeTeam && m.homeTeam.name, away: m.awayTeam && m.awayTeam.name,
             homeScore: m.score && m.score.fullTime ? m.score.fullTime.home : 0,
             awayScore: m.score && m.score.fullTime ? m.score.fullTime.away : 0, status };
  }
  function normalizeApiFootball(x) {
    const f = x.fixture || {}, t = x.teams || {}, g = x.goals || {};
    const status = ["FT", "AET", "PEN"].includes(f.status && f.status.short) ? "finished"
      : ["1H", "2H", "HT", "ET", "LIVE"].includes(f.status && f.status.short) ? "live" : "scheduled";
    return { stage: "group", home: t.home && t.home.name, away: t.away && t.away.name,
             homeScore: g.home || 0, awayScore: g.away || 0, status };
  }

  /* =========================================================================
     REFRESH LOOP + CLOCK
     ====================================================================== */
  let countdown = CFG.refreshSeconds;
  async function refreshCycle() {
    if (state.live) await fetchLive();
    renderBoard(true);              // advance the movement baseline each cycle
    countdown = CFG.refreshSeconds;
  }
  function tick() {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString();
    countdown -= 1;
    if (countdown <= 0) { refreshCycle(); }
    else $("#refresh-countdown").textContent = countdown + "s";
  }

  /* =========================================================================
     EDIT SCORES MODAL (quick per-team points + match entry) + export
     ====================================================================== */
  function openModal() {
    const r = JSON.parse(JSON.stringify(state.results));
    const modal = $("#modal");
    const teamInputs = ALL_TEAMS.map((t) => {
      const cur = (r.manualTeamPoints && r.manualTeamPoints[t] != null) ? r.manualTeamPoints[t] : "";
      return `<label class="qp"><span>${MANAGER[OWNER_OF[t]] ? MANAGER[OWNER_OF[t]].emoji : "·"} ${esc(t)}</span>
        <input type="number" data-team="${esc(t)}" value="${cur}" placeholder="0"></label>`;
    }).join("");
    const teamOpts = ALL_TEAMS.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    const matchRows = (r.matches || []).map((m, i) => `
      <tr><td>${esc(m.home)} vs ${esc(m.away)}</td>
      <td>${m.homeScore}-${m.awayScore}</td><td>${esc(m.status)}</td>
      <td><button data-del="${i}" class="mini">✕</button></td></tr>`).join("");

    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-h">Edit scores
          <button id="modal-close" class="mini">✕</button></div>
        <div class="modal-tabs">
          <button class="tab active" data-tab="quick">Quick points</button>
          <button class="tab" data-tab="match">Match entry</button>
        </div>

        <div class="tab-body" data-body="quick">
          <p class="hint">Set each team's running point total (fastest hand-update — exactly like your old sheet, but everything else recalculates for you).</p>
          <div class="qp-grid">${teamInputs}</div>
        </div>

        <div class="tab-body hidden" data-body="match">
          <p class="hint">Add a finished or in-play match; the app computes win/draw/goals/shutout and group bonuses automatically.</p>
          <div class="match-form">
            <select id="m-group">${Object.keys(L.groups).map((g) => `<option>${g}</option>`).join("")}</select>
            <select id="m-home">${teamOpts}</select>
            <input id="m-hs" type="number" placeholder="0" class="score">
            <span>–</span>
            <input id="m-as" type="number" placeholder="0" class="score">
            <select id="m-away">${teamOpts}</select>
            <select id="m-status"><option value="finished">finished</option><option value="live">live</option></select>
            <button id="m-add" class="btn">Add</button>
          </div>
          <table class="match-t"><tbody>${matchRows || '<tr><td class="dim">No matches entered yet.</td></tr>'}</tbody></table>
        </div>

        <div class="modal-foot">
          <button id="m-reset" class="btn ghost">Reset to file</button>
          <div class="grow"></div>
          <button id="m-export" class="btn ghost">Export results.js</button>
          <button id="m-save" class="btn primary">Save</button>
        </div>
      </div>`;
    modal.classList.add("open");

    // tab switching
    modal.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
      modal.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      modal.querySelectorAll(".tab-body").forEach((b) =>
        b.classList.toggle("hidden", b.dataset.body !== t.dataset.tab));
    });
    $("#modal-close").onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    // add match
    $("#m-add").onclick = () => {
      const home = $("#m-home").value, away = $("#m-away").value;
      if (home === away) return alert("Pick two different teams.");
      r.matches = r.matches || [];
      r.matches.push({ stage: "group", group: $("#m-group").value, home, away,
        homeScore: Number($("#m-hs").value) || 0, awayScore: Number($("#m-as").value) || 0,
        status: $("#m-status").value });
      // re-render the match list cheaply
      saveResults(r); closeModal(); openModal();
      modal.querySelector('[data-tab="match"]').click();
    };
    modal.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
      r.matches.splice(Number(b.dataset.del), 1); saveResults(r); closeModal(); openModal();
      modal.querySelector('[data-tab="match"]').click();
    });

    // save quick points
    $("#m-save").onclick = () => {
      r.manualTeamPoints = r.manualTeamPoints || {};
      modal.querySelectorAll("input[data-team]").forEach((inp) => {
        const v = inp.value.trim();
        if (v === "") delete r.manualTeamPoints[inp.dataset.team];
        else r.manualTeamPoints[inp.dataset.team] = Number(v) || 0;
      });
      r.lastUpdated = new Date().toISOString();
      saveResults(r); closeModal(); refreshCycle();
    };
    $("#m-reset").onclick = () => {
      if (!confirm("Discard browser edits and reload data/results.js?")) return;
      localStorage.removeItem(STORE_KEY); state.results = JSON.parse(JSON.stringify(window.RESULTS));
      closeModal(); refreshCycle();
    };
    $("#m-export").onclick = () => exportResults(r);
  }
  function closeModal() { const m = $("#modal"); m.classList.remove("open"); m.innerHTML = ""; }

  function exportResults(r) {
    const body = `/* Exported ${new Date().toISOString()} from the live tracker. */\n` +
      `window.RESULTS = ${JSON.stringify(r, null, 2)};\n`;
    const blob = new Blob([body], { type: "text/javascript" });
    const a = el("a"); a.href = URL.createObjectURL(blob); a.download = "results.js"; a.click();
    URL.revokeObjectURL(a.href);
  }

  /* =========================================================================
     INIT
     ====================================================================== */
  function init() {
    $("#season").textContent = L.season;
    $("#edit-btn").onclick = openModal;
    refreshCycle();
    setInterval(tick, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
