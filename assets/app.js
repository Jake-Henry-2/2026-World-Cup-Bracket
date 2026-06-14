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
    lastError: null,
    news: [],
    newsUpdated: null
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

    // ----- $50 side pool: bets (Top Point Winner / Runner-Up) vs actual points
    const eight = L.remainingEight.map((t) => {
      const ct = canon(t), ts = team[ct];
      return { team: ct, pts: ts.fpts, gp: ts.gp, live: ts.live };
    }).sort((a, b) => b.pts - a.pts || b.gp - a.gp || a.team.localeCompare(b.team));
    const anyPlayed = eight.some((e) => e.gp > 0);            // a remaining-8 team has finished a match
    const actualTop = anyPlayed ? eight[0] : null;
    const actualRU = anyPlayed ? eight[1] : null;
    const ptsOf = (name) => { const e = eight.find((x) => x.team === name); return e ? e.pts : 0; };
    const sidePool = (L.sidePool || []).map((p) => {
      const top = canon(p.top), ru = canon(p.runnerUp);
      return {
        manager: p.manager, top, runnerUp: ru, topPts: ptsOf(top), ruPts: ptsOf(ru),
        topHit: !!(actualTop && top === actualTop.team),
        ruHit: !!(actualRU && ru === actualRU.team)
      };
    });
    // lead the side board by correct bets, then by how their picked teams are doing
    sidePool.sort((a, b) => (b.topHit + b.ruHit) - (a.topHit + a.ruHit)
      || (b.topPts + b.ruPts) - (a.topPts + a.ruPts) || a.manager.localeCompare(b.manager));

    // ----- games: finished log + live (with clock) + upcoming (next 24h) -----
    const known = (m) => m && team[canon(m.home)] && team[canon(m.away)];
    const fmt = (m) => ({
      home: canon(m.home), away: canon(m.away),
      hs: Number(m.homeScore) || 0, as: Number(m.awayScore) || 0,
      group: GROUP_OF[canon(m.home)] || null, stage: m.stage || "group",
      status: m.status || "scheduled", id: m.id || null, venue: m.venue || "",
      date: m.date || null, clock: m.clock, displayClock: m.displayClock, detail: m.detail
    });
    const log = matches.filter((m) => known(m) && m.status === "finished").map(fmt);
    const liveNow = matches.filter((m) => known(m) && m.status === "live").map(fmt);
    const nowMs = Date.now();
    const upcoming = matches.filter((m) => known(m) && m.status === "scheduled" && m.date).map(fmt)
      .filter((m) => { const t = Date.parse(m.date); return t > nowMs && t < nowMs + 24 * 3600 * 1000; })
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const dataMs = R.lastUpdated ? (Date.parse(R.lastUpdated) || nowMs) : nowMs;
    const allGames = matches.filter(known).map(fmt);                 // every fixture (for schedules + detail)
    const byId = {}; allGames.forEach((g) => { if (g.id) byId[g.id] = g; });

    return { team, managers, groupTables, eight, actualTop, actualRU, anyPlayed, sidePool, log, liveNow, upcoming, dataMs, allGames, byId };
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
          <div class="lb-name"><span class="mgr-link" data-mgr="${esc(m.name)}" title="see ${esc(m.name)}'s team schedules">${esc(m.name)}</span> ${m.isNew ? "" : arrow(m.deltaRank)}
            <span class="lb-left" title="group games this squad has played (of 12)">${m.gamesPlayed}/12 played${m.gamesLive ? ` <span class="lb-livedot">🔴${m.gamesLive}</span>` : ""}</span></div>
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
    const ap = computed.anyPlayed;
    const eight = computed.eight.map((e, i) => {
      const mark = ap && i === 0 ? "🏆 " : ap && i === 1 ? "🥈 " : "";
      const cls = ap && i === 0 ? " sp-top" : ap && i === 1 ? " sp-ru" : "";
      return `<span class="sp-team${cls}">${mark}${esc(e.team)} <b>${e.pts}</b>${e.live ? ' <span class="ct-live">●</span>' : ""}</span>`;
    }).join("");
    const picks = computed.sidePool.map((p) =>
      `<tr><td>${esc(p.manager)}</td>
        <td class="${p.topHit ? "hit" : ""}">${esc(p.top)} <span class="sp-pp">${p.topPts}</span>${p.topHit ? " ✓" : ""}</td>
        <td class="${p.ruHit ? "hit" : ""}">${esc(p.runnerUp)} <span class="sp-pp">${p.ruPts}</span>${p.ruHit ? " ✓" : ""}</td></tr>`
    ).join("");
    let note;
    if (!ap) {
      note = `No Remaining-8 games have finished yet — bets go live the moment these teams play.`;
    } else {
      const w = computed.sidePool.find((p) => p.topHit);
      note = w
        ? `Leading the $${L.pots.sidePool}: <b>${esc(w.manager)}</b> — called <b>${esc(computed.actualTop.team)}</b> as Top Point Winner${w.ruHit ? " + Runner-Up ✓" : ""}.`
        : `Top Point Winner so far: <b>${esc(computed.actualTop.team)}</b> (${computed.actualTop.pts} pts) — no one bet it. Closest: <b>${esc(computed.sidePool[0].manager)}</b>.`;
    }
    box.innerHTML = `
      <div class="panel-h">💰 Remaining 8 — $${L.pots.sidePool} Side Pool <span class="dim">predict the top scorer · $ to the correct Top pick</span></div>
      <div class="sp-standings">${eight}</div>
      <table class="sp-t"><thead><tr><th>Manager</th><th>Top Point Winner</th><th>Runner-Up</th></tr></thead>
        <tbody>${picks}</tbody></table>
      <div class="sp-note">${note}</div>`;
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

  // Live match clock: extrapolate ESPN's elapsed time forward so it ticks each second.
  function liveClockText(clock, displayClock, sinceMs, detail) {
    const d = (detail || "").toLowerCase();
    if (d.includes("half")) return "HT";
    if (d.includes("full") || d.includes("final") || d === "ft") return "FT";
    let base = Number(clock) || 0;                       // ESPN elapsed seconds
    if (base <= 0) {                                     // else parse the minute from "67'"
      const mm = String(displayClock || "").match(/(\d+)/);
      base = mm ? parseInt(mm[1], 10) * 60 : 0;
    }
    const sec = Math.max(0, base + (Date.now() - (Number(sinceMs) || Date.now())) / 1000);
    const m = Math.min(130, Math.floor(sec / 60)), s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function renderGames(computed) {
    const box = $("#games");
    if (!box) return;
    const ownerTag = (t) => {
      const o = OWNER_OF[t]; const mgr = o ? MANAGER[o] : null;
      return mgr ? `<span class="lg-own" title="${esc(o)}">${mgr.emoji}</span>` : "";
    };
    const playedStr = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const upStr = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";

    const mid = (m) => m.id ? ` data-mid="${esc(m.id)}"` : "";
    const liveRows = computed.liveNow.map((m) => `<div class="lg-row lg-live lg-click"${mid(m)}>
      <span class="lg-g">🔴</span>
      <span class="lg-m">${esc(m.home)} ${ownerTag(m.home)} <b>${m.hs}–${m.as}</b> ${ownerTag(m.away)} ${esc(m.away)}</span>
      <span class="lg-clock" data-clock="${m.clock || 0}" data-disp="${esc(m.displayClock || "")}" data-since="${computed.dataMs}" data-detail="${esc(m.detail || "")}">${liveClockText(m.clock, m.displayClock, computed.dataMs, m.detail)}</span></div>`).join("");

    const upRows = computed.upcoming.map((m) => `<div class="lg-row lg-up lg-click"${mid(m)}>
      <span class="lg-g">${m.group || m.stage}</span>
      <span class="lg-m">${esc(m.home)} ${ownerTag(m.home)} <span class="lg-vs">vs</span> ${ownerTag(m.away)} ${esc(m.away)}</span>
      <span class="lg-when">${upStr(m.date)}</span></div>`).join("");

    const finished = computed.log.slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    const doneRows = finished.length ? finished.map((m) => `<div class="lg-row lg-click"${mid(m)}>
      <span class="lg-g">${m.group || m.stage}</span>
      <span class="lg-m">${esc(m.home)} ${ownerTag(m.home)} <b>${m.hs}–${m.as}</b> ${ownerTag(m.away)} ${esc(m.away)}</span>
      <span class="lg-when">${playedStr(m.date)}</span></div>`).join("")
      : `<div class="lg-empty">No games have finished yet.</div>`;

    box.innerHTML = `
      <div class="panel-h">📋 Games
        <span class="dim">${finished.length} final${computed.liveNow.length ? ` · ${computed.liveNow.length} live` : ""}${computed.upcoming.length ? ` · ${computed.upcoming.length} next 24h` : ""}</span></div>
      ${liveRows ? `<div class="lg-sub">🔴 Live now</div><div class="lg-livewrap">${liveRows}</div>` : ""}
      ${upRows ? `<div class="lg-sub">⏭ Up next · next 24h</div><div class="lg-uplist">${upRows}</div>` : ""}
      <div class="lg-sub">✅ Played</div><div class="lg-list">${doneRows}</div>`;
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
      const played = m.teams.reduce((s, t) => s + computed.team[canon(t)].gp, 0);
      return `<div class="club"><div class="club-h">${m.emoji} <b class="mgr-link" data-mgr="${esc(m.name)}" title="see ${esc(m.name)}'s team schedules">${esc(m.name)}</b>
        <span class="club-left" title="group games played (of 12)">${played}/12 played</span>
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

  // World Cup news — headlines scraped from ESPN (refreshed each cycle), linking out to the source
  function renderNews() {
    const box = $("#news"); if (!box) return;
    const arts = state.news || [];
    const upd = state.newsUpdated ? ` <span class="dim">· updated ${new Date(state.newsUpdated).toLocaleTimeString()}</span>` : "";
    if (!arts.length) {
      box.innerHTML = `<div class="panel-h">📰 World Cup News <span class="dim">live from ESPN</span></div>
        <div class="news-empty">Pulling the latest headlines…</div>`;
      return;
    }
    const cards = arts.map((a) => `
      <a class="news-card" href="${esc(a.link || "#")}" target="_blank" rel="noopener noreferrer">
        ${a.image ? `<div class="news-img" style="background-image:url('${esc(a.image)}')"></div>` : `<div class="news-img news-img-ph">📰</div>`}
        <div class="news-body">
          <div class="news-head">${esc(a.headline)}</div>
          ${a.description ? `<div class="news-desc">${esc(a.description)}</div>` : ""}
          <div class="news-meta">${a.published ? new Date(a.published).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " : ""}ESPN ↗</div>
        </div>
      </a>`).join("");
    box.innerHTML = `<div class="panel-h">📰 World Cup News <span class="dim">live from ESPN${upd}</span></div>
      <div class="news-grid">${cards}</div>`;
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
    renderNews();

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
      let matches = [], liveUpdated = null;
      if (live.provider === "custom") {
        const base = (live.proxyUrl || "") + (live.customUrl || "");
        if (!base) throw new Error("customUrl not set");
        const url = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now(); // bust CDN/browser cache
        const data = await (await fetch(url, { cache: "no-store" })).json();
        matches = (data.matches || data).map(normalizeCustom);
        liveUpdated = data.lastUpdated || null;          // when the feed captured the scores/clock
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
      if (liveUpdated) r.lastUpdated = liveUpdated;       // keep the feed's capture time for the live clock
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
             homeScore: m.homeScore, awayScore: m.awayScore, status: m.status || "finished",
             id: m.id || null, venue: m.venue || "",
             date: m.date || null, clock: m.clock, displayClock: m.displayClock, detail: m.detail };
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

  // News: same-origin data/news.json (refreshed server-side every cycle), cache-busted
  async function fetchNews() {
    try {
      const r = await fetch("data/news.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.articles)) { state.news = d.articles; state.newsUpdated = d.lastUpdated; }
    } catch (e) { /* keep last-known headlines */ }
  }

  /* =========================================================================
     REFRESH LOOP + CLOCK
     ====================================================================== */
  let countdown = CFG.refreshSeconds;
  async function refreshCycle() {
    if (state.live) await fetchLive();
    await fetchNews();
    renderBoard(true);              // advance the movement baseline each cycle
    countdown = CFG.refreshSeconds;
  }
  function tick() {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString();
    // advance any live match clocks every second
    document.querySelectorAll(".lg-clock").forEach((el) => {
      el.textContent = liveClockText(el.dataset.clock, el.dataset.disp, Number(el.dataset.since), el.dataset.detail);
    });
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

  /* ---------- match-detail (Fotmob-style) + manager-schedule modals -------- */
  function showModal(html) {
    const m = $("#modal");
    m.innerHTML = `<div class="modal-card mc-big">${html}</div>`;
    m.classList.add("open");
    m.onclick = (e) => { if (e.target === m) closeModal(); };
    const x = m.querySelector(".modal-x"); if (x) x.onclick = closeModal;
  }
  const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=";

  function statusLabel(g) {
    if (g.status === "finished") return "Full time";
    if (g.status === "live") return "🔴 " + liveClockText(g.clock, g.displayClock, (state.computed && state.computed.dataMs) || Date.now(), g.detail);
    return g.date ? new Date(g.date).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Scheduled";
  }
  function matchHeaderHtml(g) {
    const ho = OWNER_OF[g.home], ao = OWNER_OF[g.away];
    const hp = state.computed ? state.computed.team[g.home].fpts : 0, ap = state.computed ? state.computed.team[g.away].fpts : 0;
    const mid = g.status === "scheduled" ? `<span class="md-vs">vs</span>` : `<span class="md-score">${g.hs} – ${g.as}</span>`;
    const own = (o, p) => o ? `${MANAGER[o].emoji} ${esc(o)} · ${p} pts` : "side pool team";
    return `<button class="modal-x">✕</button>
      <div class="md-head">
        <div class="md-team"><div class="md-tn">${esc(g.home)}</div><div class="md-own">${own(ho, hp)}</div></div>
        <div class="md-center">${mid}<div class="md-status">${statusLabel(g)}</div></div>
        <div class="md-team md-team-a"><div class="md-tn">${esc(g.away)}</div><div class="md-own">${own(ao, ap)}</div></div>
      </div>
      <div class="md-meta">${g.group ? "Group " + g.group + " · " : ""}${esc(g.venue || "")}${g.date ? " · " + new Date(g.date).toLocaleString() : ""}</div>`;
  }
  async function openMatchModal(id) {
    const g = state.computed && state.computed.byId[id]; if (!g) return;
    const link = `https://www.espn.com/soccer/match/_/gameId/${id}`;
    showModal(`${matchHeaderHtml(g)}<div id="md-body">${g.status === "scheduled"
      ? `<div class="md-empty">Kicks off ${g.date ? new Date(g.date).toLocaleString() : "soon"}.</div>`
      : `<div class="md-loading">Loading match data…</div>`}</div>
      <div class="md-foot"><a href="${link}" target="_blank" rel="noopener" class="foot-link">Full match on ESPN ↗</a></div>`);
    if (g.status === "scheduled") return;
    try {
      const d = await (await fetch(ESPN_SUMMARY + id, { cache: "no-store" })).json();
      renderMatchDetail(d, g);
    } catch (e) {
      const b = $("#md-body"); if (b) b.innerHTML = `<div class="md-empty">Detailed data couldn't load here — open the full match on ESPN below.</div>`;
    }
  }
  function renderMatchDetail(d, g) {
    const body = $("#md-body"); if (!body) return;
    const teams = (d.boxscore && d.boxscore.teams) || [];
    const sideOf = {}; teams.forEach((t, i) => { sideOf[t.team && t.team.id] = t.homeAway || (i === 0 ? "home" : "away"); });
    const icon = (k) => /red card/i.test(k) ? "🟥" : /yellow/i.test(k) ? "🟨" : /goal/i.test(k) ? "⚽" : /sub/i.test(k) ? "🔁" : "•";
    const evs = (d.keyEvents || []).filter((e) => /goal|card|substitution/i.test((e.type && e.type.text) || "")).map((e) => {
      const side = sideOf[e.team && e.team.id] || "n";
      const player = (e.athletesInvolved && e.athletesInvolved[0] && e.athletesInvolved[0].displayName) || ((e.type && e.type.text) || "");
      return `<div class="md-ev md-ev-${side}"><span class="md-ev-min">${esc((e.clock && e.clock.displayValue) || "")}</span><span class="md-ev-ic">${icon((e.type && e.type.text) || "")}</span><span class="md-ev-tx">${esc(player)}</span></div>`;
    }).join("");
    const pick = {}; teams.forEach((t) => { const s = sideOf[t.team && t.team.id]; const o = {}; (t.statistics || []).forEach((x) => o[x.name] = x.displayValue); pick[s] = o; });
    const statRow = (label, key) => {
      const h = (pick.home && pick.home[key]) || "0", a = (pick.away && pick.away[key]) || "0";
      const hv = parseFloat(h) || 0, av = parseFloat(a) || 0, tot = hv + av || 1;
      return `<div class="md-stat"><span>${esc(h)}</span><div class="md-bar"><i style="width:${(hv / tot * 100).toFixed(0)}%"></i></div><b>${label}</b><div class="md-bar md-bar-a"><i style="width:${(av / tot * 100).toFixed(0)}%"></i></div><span>${esc(a)}</span></div>`;
    };
    const stats = (pick.home || pick.away) ? `<div class="md-section">Match stats</div>${statRow("Possession %", "possessionPct")}${statRow("Shots", "totalShots")}${statRow("On target", "shotsOnTarget")}${statRow("Corners", "wonCorners")}${statRow("Fouls", "foulsCommitted")}${statRow("Yellow cards", "yellowCards")}` : "";
    body.innerHTML = (evs ? `<div class="md-section">Key events</div><div class="md-events">${evs}</div>` : "") + stats
      || `<div class="md-empty">No detailed data published for this match yet.</div>`;
  }
  function openManagerModal(name) {
    const mgr = MANAGER[name]; if (!mgr || !state.computed) return;
    const all = state.computed.allGames;
    const teamBlock = (t) => {
      const ct = canon(t), pts = state.computed.team[ct].fpts;
      const rows = all.filter((x) => x.home === ct || x.away === ct).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)).map((x) => {
        const opp = x.home === ct ? x.away : x.home, va = x.home === ct ? "vs" : "at";
        const sc = x.home === ct ? `${x.hs}-${x.as}` : `${x.as}-${x.hs}`;
        const res = x.status === "finished" ? `<b>${sc}</b>` : x.status === "live" ? `<span class="md-live">LIVE ${sc}</span>`
          : `<span class="dim">${x.date ? new Date(x.date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "TBD"}</span>`;
        return `<div class="sch-row${x.id ? " lg-click" : ""}"${x.id ? ` data-mid="${esc(x.id)}"` : ""}><span class="sch-opp">${esc(va)} ${esc(opp)}</span><span class="sch-res">${res}</span></div>`;
      }).join("") || `<div class="dim" style="padding:6px 2px">No fixtures.</div>`;
      return `<div class="sch-team"><div class="sch-th">${esc(ct)} <span class="sch-pts">${pts} pts</span></div>${rows}</div>`;
    };
    showModal(`<button class="modal-x">✕</button>
      <div class="sch-head">${mgr.emoji} <b>${esc(name)}</b> — team schedules</div>
      <div class="sch-grid">${mgr.teams.map(teamBlock).join("")}</div>`);
  }

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
    document.addEventListener("click", (e) => {
      const g = e.target.closest("[data-mid]");
      if (g) { openMatchModal(g.dataset.mid); return; }
      const mg = e.target.closest("[data-mgr]");
      if (mg) { openManagerModal(mg.dataset.mgr); return; }
    });
    refreshCycle();
    setInterval(tick, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
