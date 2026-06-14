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

  // short, live-feeling relative time ("just now", "3m ago", "2h ago", else the date)
  const relTime = (t) => {
    const ms = typeof t === "number" ? t : Date.parse(t);
    if (!ms) return "";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

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
    newsUpdated: null,
    details: {},
    liveSource: null
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
      date: m.date || null, clock: m.clock, displayClock: m.displayClock, detail: m.detail, period: m.period
    });
    const nowMs = Date.now();
    // a "scheduled" game whose kickoff has already passed (recently) has really kicked off —
    // the feed just hasn't flipped it to "live" yet. Treat it as live so it never vanishes during
    // the data-refresh lag, and extrapolate its clock from kickoff. ~2.5h covers a full match.
    const KICKOFF_GRACE = 150 * 60 * 1000;
    const koMs = (m) => (m && m.date) ? (Date.parse(m.date) || 0) : 0;
    const justKicked = (m) => m.status === "scheduled" && koMs(m) && koMs(m) <= nowMs && (nowMs - koMs(m)) < KICKOFF_GRACE;
    const isLive = (m) => m.status === "live" || justKicked(m);

    const log = matches.filter((m) => known(m) && m.status === "finished").map(fmt);
    const liveNow = matches.filter((m) => known(m) && isLive(m)).map((m) => {
      const r = fmt(m);
      if (r.status !== "live") { r.status = "live"; r.kickedOff = true; }   // promoted: clock comes from kickoff time
      return r;
    }).sort((a, b) => koMs(b) - koMs(a));
    const upcoming = matches.filter((m) => known(m) && m.status === "scheduled" && !isLive(m) && m.date).map(fmt)
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

  // Live match clock: extrapolate ESPN's elapsed seconds forward each second, but never run the
  // timer through a stoppage or across a half boundary before ESPN actually advances the period.
  function liveClockText(clock, displayClock, sinceMs, detail, period) {
    const d = (detail || "").toLowerCase();
    const dc = String(displayClock || "").trim();
    if (/half ?time|halftime|interval|\bht\b/.test(d) || /^ht$/i.test(dc)) return "HT";   // break → frozen
    if (/full ?time|final|ended|abandon|\bft\b/.test(d) || /^ft$/i.test(dc)) return "FT";
    if (/penalt|shootout/.test(d)) return "PENS";
    if (dc.includes("+")) return dc;                     // stoppage ("45'+4'") → show ESPN's exact figure, no run-over
    let base = Number(clock) || 0;                       // ESPN elapsed seconds
    if (base <= 0) {                                     // else parse the minute from "67'"
      const mm = dc.match(/(\d+)/);
      base = mm ? parseInt(mm[1], 10) * 60 : 0;
    }
    let sec = base + (Date.now() - (Number(sinceMs) || Date.now())) / 1000;
    const p = Number(period) || 0;                       // 1=1st half, 2=2nd, 3/4=ET — cap so it can't enter the next period early
    const capMin = p >= 4 ? 120 : p === 3 ? 105 : p >= 2 ? 90 : 45;
    sec = Math.max(0, Math.min(sec, capMin * 60));
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
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
    const liveRows = computed.liveNow.map((m) => {
      // freshly kicked-off games (feed still says "scheduled") have no ESPN clock — tick from kickoff time
      const sinceMs = m.kickedOff ? (Date.parse(m.date) || computed.dataMs) : computed.dataMs;
      const clk = m.kickedOff ? 0 : (m.clock || 0);
      const disp = m.kickedOff ? "" : (m.displayClock || "");
      const det = m.kickedOff ? "" : (m.detail || "");
      const per = m.kickedOff ? 0 : (m.period || 0);
      return `<div class="lg-row lg-live lg-click"${mid(m)}>
      <span class="lg-g">🔴</span>
      <span class="lg-m">${esc(m.home)} ${ownerTag(m.home)} <b>${m.hs}–${m.as}</b> ${ownerTag(m.away)} ${esc(m.away)}</span>
      <span class="lg-clock" data-clock="${clk}" data-disp="${esc(disp)}" data-since="${sinceMs}" data-detail="${esc(det)}" data-period="${per}">${liveClockText(clk, disp, sinceMs, det, per)}</span></div>`;
    }).join("");

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
      <div class="panel-h"><span class="ph-title">📋 Games <span class="dim">${finished.length} final${computed.liveNow.length ? ` · ${computed.liveNow.length} live` : ""}${computed.upcoming.length ? ` · ${computed.upcoming.length} next 24h` : ""}</span></span><button class="ag-btn" data-allgames>All games</button></div>
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
    // newest-first so fresh stories visibly rise to the top each refresh
    const arts = (state.news || []).slice()
      .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
    const sinceMs = state.newsUpdated ? (Date.parse(state.newsUpdated) || 0) : 0;
    // ticking "● LIVE · Xm ago" indicator (refreshed every second by tick()) — same liveness as the scores
    const live = `<span class="news-live"><span class="news-dot"></span>LIVE${sinceMs
      ? ` <span class="news-since" data-since="${sinceMs}">· ${esc(relTime(sinceMs))}</span>` : ""}</span>`;
    const head = `<div class="panel-h"><span class="ph-title">📰 World Cup News <span class="dim">live from ESPN</span></span>${live}</div>`;
    if (!arts.length) {
      box.innerHTML = `${head}<div class="news-empty">Pulling the latest headlines…</div>`;
      return;
    }
    const cards = arts.map((a) => `
      <a class="news-card" href="${esc(a.link || "#")}" target="_blank" rel="noopener noreferrer">
        ${a.image ? `<div class="news-img" style="background-image:url('${esc(a.image)}')"></div>` : `<div class="news-img news-img-ph">📰</div>`}
        <div class="news-body">
          <div class="news-head">${esc(a.headline)}</div>
          ${a.description ? `<div class="news-desc">${esc(a.description)}</div>` : ""}
          <div class="news-meta">${a.published ? esc(relTime(a.published)) + " · " : ""}ESPN ↗</div>
        </div>
      </a>`).join("");
    box.innerHTML = `${head}<div class="news-grid">${cards}</div>`;
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
      ? (state.lastError ? `<span class="warn">⚠ feed error — using manual</span>` : `<span class="ok">● LIVE · ${state.liveSource === "espn" ? "ESPN direct" : "feed"}</span>`)
      : `<span class="man">✎ manual mode</span>`;

    checkNewLeader(computed.managers);
    if (advanceBaseline) setBaseline(computed.managers);
  }

  /* =========================================================================
     LIVE FEED ADAPTERS (optional). Always falls back to manual on failure.
     ====================================================================== */
  // Pull live scores straight from ESPN in the browser → true real-time, no dependency on the
  // build/scheduler. Mirrors scripts/fetch-scores.mjs exactly. A plain GET to site.api.espn.com
  // sends no custom headers (no CORS preflight); on any failure we throw and fall back to the feed.
  const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260720";
  // round detection from any ESPN text — specific rounds before "final" so knockout scoring stays correct
  function espnStage(ev, comp) {
    const s = [(ev.season && ev.season.slug) || "", ev.name || "", ev.shortName || "",
      ((comp && comp.notes) || []).map((n) => n.headline || n.text || "").join(" "),
      (comp && comp.type && (comp.type.text || comp.type.abbreviation)) || ""].join(" ").toLowerCase();
    if (/round of 32|round-of-32|\bro32\b/.test(s)) return "r32";
    if (/round of 16|round-of-16|\bro16\b/.test(s)) return "r16";
    if (/quarter/.test(s)) return "qf";
    if (/semi/.test(s)) return "sf";
    if (/third place|3rd place/.test(s)) return "third";
    if (/\bfinal\b/.test(s)) return "final";
    return "group";
  }
  // fetch JSON with an abort timeout so a stalled request can never freeze the refresh loop
  async function fetchJSON(url, timeout) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout || 9000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function fetchEspnScoreboard() {
    const data = await fetchJSON(ESPN_SCOREBOARD + "&t=" + Date.now(), 9000);
    const events = data.events || [];
    if (!events.length) throw new Error("espn: no events");
    const seen = new Set(), matches = [];
    for (const ev of events) {
      if (seen.has(ev.id)) continue; seen.add(ev.id);
      const comp = (ev.competitions || [])[0]; if (!comp) continue;
      const cs = comp.competitors || [];
      const h = cs.find((c) => c.homeAway === "home") || cs[0];
      const a = cs.find((c) => c.homeAway === "away") || cs[1];
      if (!h || !a) continue;
      const st = ev.status && ev.status.type && ev.status.type.state;
      const status = st === "post" ? "finished" : st === "in" ? "live" : "scheduled";
      const cstat = comp.status || ev.status || {};
      const m = {
        stage: espnStage(ev, comp),
        home: canon((h.team && h.team.displayName) || ""),
        away: canon((a.team && a.team.displayName) || ""),
        homeScore: parseInt(h.score, 10) || 0,
        awayScore: parseInt(a.score, 10) || 0,
        status, id: ev.id || null, date: ev.date || null,
        venue: (comp.venue && comp.venue.fullName) || ""
      };
      if (status === "live") {
        m.clock = (typeof cstat.clock === "number") ? cstat.clock : 0;
        m.displayClock = cstat.displayClock || "";
        m.detail = (cstat.type && (cstat.type.shortDetail || cstat.type.detail)) || "";
        m.period = Number(cstat.period) || 0;            // 1=1st half, 2=2nd half — so the clock can't cross a half early
      }
      matches.push(m);
    }
    if (!matches.length) throw new Error("espn: no matches parsed");
    return { matches, lastUpdated: new Date().toISOString() };
  }

  async function fetchLive() {
    const live = CFG.live || {};
    // 1) PRIMARY: live scores straight from ESPN (real-time, independent of the deploy schedule).
    if (live.espnDirect !== false) {
      try {
        const espn = await fetchEspnScoreboard();
        const r = state.results;
        r.matches = espn.matches; r.lastUpdated = espn.lastUpdated;
        saveResults(r);
        state.lastFetch = new Date().toISOString();
        state.lastError = null; state.liveSource = "espn";
        return;
      } catch (e) { console.info("[live] ESPN direct unavailable — using built feed:", e.message); }
    }
    // 2) FALLBACK: the same-origin feed the workflow commits (no CORS), or another configured provider.
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
      state.lastError = null; state.liveSource = "feed";
    } catch (e) {
      state.lastError = e.message || String(e);
      console.warn("[live feed] falling back to manual:", e);
    }
  }
  function normalizeCustom(m) {
    return { stage: m.stage || "group", group: m.group, home: m.home, away: m.away,
             homeScore: m.homeScore, awayScore: m.awayScore, status: m.status || "finished",
             id: m.id || null, venue: m.venue || "",
             date: m.date || null, clock: m.clock, displayClock: m.displayClock, detail: m.detail, period: m.period };
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
      const d = await fetchJSON("data/news.json?t=" + Date.now(), 8000);
      if (Array.isArray(d.articles)) { state.news = d.articles; state.newsUpdated = d.lastUpdated; }
    } catch (e) { /* keep last-known headlines */ }
  }
  // Per-match detail (events/stats/lineups), prefetched server-side -> same-origin
  async function fetchDetails() {
    try {
      const d = await fetchJSON("data/details.json?t=" + Date.now(), 8000);
      if (d.games) state.details = d.games;
    } catch (e) { /* keep last-known details */ }
  }

  /* =========================================================================
     REFRESH LOOP + CLOCK
     ====================================================================== */
  let scoreCd = CFG.refreshSeconds;     // seconds to next score poll (short while games are live)
  let auxCd = CFG.refreshSeconds;       // seconds to next news/details poll (always the slow clock)
  let busy = false;
  function scoreInterval() {
    const hasLive = state.computed && state.computed.liveNow && state.computed.liveNow.length;
    return hasLive ? (CFG.liveRefreshSeconds || 10) : CFG.refreshSeconds;   // fast during live games → goals land with ~no lag
  }
  async function doRefresh(full) {
    if (busy) return; busy = true;
    try {
      if (state.live) await fetchLive();            // ESPN scoreboard: live scores/goals/clock, real-time
      if (full) { await fetchNews(); await fetchDetails(); }
      renderBoard(true);                            // advance the movement baseline each cycle
    } finally { busy = false; }
  }
  async function refreshCycle() { await doRefresh(true); scoreCd = scoreInterval(); auxCd = CFG.refreshSeconds; }
  function tick() {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString();
    // advance any live match clocks every second
    document.querySelectorAll(".lg-clock").forEach((el) => {
      el.textContent = liveClockText(el.dataset.clock, el.dataset.disp, Number(el.dataset.since), el.dataset.detail, el.dataset.period);
    });
    // keep the news "updated Xm ago" label live so it visibly tracks with the rest of the site
    document.querySelectorAll(".news-since").forEach((el) => {
      el.textContent = "· " + relTime(Number(el.dataset.since));
    });
    scoreCd -= 1; auxCd -= 1;
    if (scoreCd <= 0) {
      const full = auxCd <= 0;                      // fold in news/details only on the slow clock
      doRefresh(full);
      scoreCd = scoreInterval();
      if (full) auxCd = CFG.refreshSeconds;
    }
    $("#refresh-countdown").textContent = Math.max(0, scoreCd) + "s";
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
    if (g.status === "live") return "🔴 " + liveClockText(g.clock, g.displayClock, (state.computed && state.computed.dataMs) || Date.now(), g.detail, g.period);
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
  // Man of the Match — derived by combining each player's match stats: goals, own goals and cards.
  function manOfMatch(det, g) {
    const sc = {};
    (det.events || []).forEach((e) => {
      const p = (e.player || "").trim(); if (!p) return;
      const k = (e.kind || "").toLowerCase();
      sc[p] = sc[p] || { player: p, side: e.side, goals: 0, pts: 0 };
      if (e.side) sc[p].side = e.side;
      if (/own goal/.test(k)) sc[p].pts -= 2;
      else if (/goal/.test(k)) { sc[p].goals++; sc[p].pts += 3; }
      if (/red card/.test(k)) sc[p].pts -= 3;
      else if (/yellow/.test(k)) sc[p].pts -= 1;
    });
    const arr = Object.values(sc).filter((x) => x.pts > 0).sort((a, b) => b.pts - a.pts || b.goals - a.goals);
    if (!arr.length) return null;
    const top = arr[0], team = top.side === "away" ? g.away : g.home, owner = OWNER_OF[team];
    return { player: top.player, team, goals: top.goals, emoji: owner ? MANAGER[owner].emoji : "⚽" };
  }
  // Free live radio: BBC Radio 5 Live holds the World Cup radio commentary rights and streams it
  // free worldwide (no login). Sports Extra carries the second concurrent game.
  const RADIO_MAIN = "https://www.bbc.co.uk/sounds/play/live:bbc_radio_five_live";
  const RADIO_EXTRA = "https://www.bbc.co.uk/sounds/play/live:bbc_radio_five_live_sports_extra";
  function openMatchModal(id) {
    const g = state.computed && state.computed.byId[id]; if (!g) return;
    const link = `https://www.espn.com/soccer/match/_/gameId/${id}`;
    const det = state.details && state.details[id];
    const motm = (det && g.status !== "scheduled") ? manOfMatch(det, g) : null;
    const motmHtml = motm
      ? `<div class="md-motm">⭐ <span class="md-motm-l">Man of the Match</span> ${motm.emoji} <b>${esc(motm.player)}</b> <span class="dim">${esc(motm.team)}${motm.goals ? ` · ${motm.goals} goal${motm.goals > 1 ? "s" : ""}` : ""}</span></div>`
      : "";
    const body = g.status === "scheduled"
      ? `<div class="md-empty">Kicks off ${g.date ? new Date(g.date).toLocaleString() : "soon"}.</div>`
      : det ? matchDetailHtml(det, g)
      : `<div class="md-empty">Detailed data lands within ~5 minutes of kickoff — check back shortly, or open the full match on ESPN below.</div>`;
    showModal(`${matchHeaderHtml(g)}${motmHtml}<div id="md-body">${body}</div>
      <div class="md-foot">
        <a href="${RADIO_MAIN}" target="_blank" rel="noopener" class="foot-link md-radio">📻 Live radio · BBC 5 Live (free) ↗</a>
        <a href="${RADIO_EXTRA}" target="_blank" rel="noopener" class="foot-link md-radio2">📻 5 Sports Extra ↗</a>
        <a href="${link}" target="_blank" rel="noopener" class="foot-link">Full match on ESPN ↗</a>
      </div>`);
  }
  function matchDetailHtml(det, g) {
    const home = (g && g.home) || "Home", away = (g && g.away) || "Away";
    const icon = (k) => /red card/i.test(k) ? "🟥" : /yellow/i.test(k) ? "🟨" : /goal/i.test(k) ? "⚽" : /sub/i.test(k) ? "🔁" : "•";
    const minNum = (m) => { const mm = String(m || "").match(/(\d+)/); return mm ? Math.min(120, parseInt(mm[1], 10)) : 0; };
    const evList = det.events || [];

    // ---- timeline strip: KO → HT → FT with event markers ----
    const timeline = evList.length ? `<div class="md-section">Match timeline</div>
      <div class="md-timeline"><div class="md-tl-line"></div>
        <span class="md-tl-cap" style="left:0">KO</span><span class="md-tl-cap" style="left:50%">HT</span><span class="md-tl-cap" style="left:100%">FT</span>
        ${evList.map((e) => `<span class="md-tl-ev md-tl-${e.side || "n"}" style="left:${Math.max(1, Math.min(99, minNum(e.min) / 90 * 100))}%" title="${esc(e.min)} ${esc(e.player || e.kind)}">${icon(e.kind)}</span>`).join("")}
      </div>` : "";

    // ---- key events ----
    const evs = evList.map((e) => `<div class="md-ev md-ev-${e.side || "n"}"><span class="md-ev-min">${esc(e.min || "")}</span><span class="md-ev-ic">${icon(e.kind || "")}</span><span class="md-ev-tx">${esc(e.player || e.kind || "")}</span></div>`).join("");
    const eventsSec = evs ? `<div class="md-section">Key events</div><div class="md-events">${evs}</div>` : "";

    // ---- per-player match leaders ----
    const L = det.leaders || [];
    const ldCell = (p) => (p && p.name) ? `<b>${esc(p.value)}</b> <span>${esc(p.name)}${p.num ? ` <i>#${esc(String(p.num))}</i>` : ""}</span>` : `<span class="md-ld-none">—</span>`;
    const leaders = L.length ? `<div class="md-section">Match leaders</div><div class="md-leaders">${L.map((c) => `<div class="md-ld"><div class="md-ld-p">${ldCell(c.home)}</div><div class="md-ld-cat">${esc(c.label)}</div><div class="md-ld-p md-ld-a">${ldCell(c.away)}</div></div>`).join("")}</div>` : "";

    // ---- team stats (expanded) ----
    const S = det.stats || {};
    const statRow = (label, keys, suf) => {
      const key = (Array.isArray(keys) ? keys : [keys]).find((k) => (S.home && S.home[k] != null) || (S.away && S.away[k] != null));
      if (!key) return "";
      const h = (S.home && S.home[key]) || "0", a = (S.away && S.away[key]) || "0";
      const hv = parseFloat(h) || 0, av = parseFloat(a) || 0, tot = hv + av || 1;
      return `<div class="md-stat"><span>${esc(h)}${suf || ""}</span><div class="md-bar"><i style="width:${(hv / tot * 100).toFixed(0)}%"></i></div><b>${label}</b><div class="md-bar md-bar-a"><i style="width:${(av / tot * 100).toFixed(0)}%"></i></div><span>${esc(a)}${suf || ""}</span></div>`;
    };
    const stats = (S.home || S.away) ? `<div class="md-section">Team stats</div>
      ${statRow("Expected goals (xG)", ["expectedGoals", "xGoals", "xg"])}${statRow("Possession", "possessionPct", "%")}${statRow("Shots", "totalShots")}${statRow("On target", "shotsOnTarget")}${statRow("Big chances", ["bigChanceCreated", "bigChancesCreated"])}${statRow("Accurate passes", "accuratePasses")}${statRow("Duels won", ["duelsWon", "wonDuels"])}${statRow("Corners", "wonCorners")}${statRow("Fouls", "foulsCommitted")}${statRow("Offsides", "offsides")}${statRow("Saves", "saves")}${statRow("Yellow cards", "yellowCards")}` : "";

    // ---- formations + pitch ----
    const LU = det.lineups || {}, F = det.formation || {};
    const scorers = {}; evList.filter((e) => /goal/i.test(e.kind || "") && !/own/i.test(e.kind || "")).forEach((e) => { if (e.player) scorers[e.player] = (scorers[e.player] || 0) + 1; });
    const lineOf = (pos) => { const p = (pos || "").toUpperCase(); if (/^G/.test(p)) return "G"; if (/^(D|CB|LB|RB|LWB|RWB|SW)/.test(p)) return "D"; if (/^(F|ST|CF|LW|RW|SS|W)/.test(p)) return "F"; return "M"; };
    const pitch = (side) => {
      const arr = LU[side] || []; if (!arr.length) return "";
      const grp = { F: [], M: [], D: [], G: [] };
      arr.forEach((p) => grp[lineOf(p.pos)].push(p));
      const jersey = (p) => `<div class="md-jersey" title="${esc(p.name)}"><span class="md-jn">${esc(String(p.num || ""))}</span>${scorers[p.name] ? `<span class="md-jg">⚽${scorers[p.name] > 1 ? scorers[p.name] : ""}</span>` : ""}<span class="md-jname">${esc(p.short || p.name)}</span></div>`;
      return `<div class="md-pitch">${["F", "M", "D", "G"].map((k) => grp[k].length ? `<div class="md-prow">${grp[k].map(jersey).join("")}</div>` : "").join("")}</div>`;
    };
    const formations = ((LU.home && LU.home.length) || (LU.away && LU.away.length)) ? `<div class="md-section">Formations &amp; lineups</div>
      <div class="md-pitches">
        <div class="md-pitchwrap"><div class="md-form-h">${esc(home)} ${F.home ? `<span class="md-form-tag">${esc(F.home)}</span>` : ""}</div>${pitch("home")}</div>
        <div class="md-pitchwrap"><div class="md-form-h">${esc(away)} ${F.away ? `<span class="md-form-tag">${esc(F.away)}</span>` : ""}</div>${pitch("away")}</div>
      </div>` : "";

    // ---- commentary feed ----
    const C = det.commentary || [];
    const cmin = (m) => (m && typeof m === "object") ? (m.displayValue || "") : (m || "");
    const commentary = C.length ? `<div class="md-section">Commentary</div><div class="md-comm">${C.map((c) => `<div class="md-cm${c.goal ? " md-cm-goal" : ""}"><span class="md-cm-min">${esc(cmin(c.min))}</span><span class="md-cm-tx">${c.goal ? "⚽ " : ""}${esc(c.text)}</span></div>`).join("")}</div>` : "";

    return (timeline + eventsSec + leaders + stats + formations + commentary)
      || `<div class="md-empty">No detailed data published for this match yet.</div>`;
  }
  function openManagerModal(name) {
    const mgr = MANAGER[name]; if (!mgr || !state.computed) return;
    const all = state.computed.allGames;
    const teamBlock = (t) => {
      const ct = canon(t), pts = state.computed.team[ct].fpts;
      const fixtures = all.filter((x) => x.home === ct || x.away === ct).sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
      const played = fixtures.filter((x) => x.status === "finished").length;
      const left = fixtures.filter((x) => x.status !== "finished");        // games LEFT to play (scheduled + live)
      const rows = left.length ? left.map((x) => {
        const opp = x.home === ct ? x.away : x.home, va = x.home === ct ? "vs" : "at";
        const sc = x.home === ct ? `${x.hs}-${x.as}` : `${x.as}-${x.hs}`;
        const when = x.status === "live" ? `<span class="md-live">🔴 LIVE ${sc}</span>`
          : `<span class="dim">${x.date ? new Date(x.date).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "TBD"}</span>`;
        return `<div class="sch-row${x.id ? " lg-click" : ""}"${x.id ? ` data-mid="${esc(x.id)}"` : ""}><span class="sch-opp">${esc(va)} ${esc(opp)}</span><span class="sch-res">${when}</span></div>`;
      }).join("") : `<div class="dim" style="padding:6px 2px">✓ no games left</div>`;
      return `<div class="sch-team"><div class="sch-th">${esc(ct)} <span class="sch-pts">${pts} pts · ${played} played</span></div>${rows}</div>`;
    };
    showModal(`<button class="modal-x">✕</button>
      <div class="sch-head">${mgr.emoji} <b>${esc(name)}</b> — games left to play</div>
      <div class="sch-grid">${mgr.teams.map(teamBlock).join("")}</div>`);
  }

  function openAllGamesModal() {
    if (!state.computed) return;
    const ownerTag = (t) => { const o = OWNER_OF[t], m = o ? MANAGER[o] : null; return m ? `<span class="lg-own" title="${esc(o)}">${m.emoji}</span>` : ""; };
    const all = state.computed.allGames.slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    const groups = {};
    all.forEach((g) => { const d = g.date ? new Date(g.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "Date TBD"; (groups[d] = groups[d] || []).push(g); });
    const html = Object.entries(groups).map(([d, gs]) => `<div class="ag-day">${esc(d)}</div>` + gs.map((g) => {
      const res = g.status === "finished" ? `<b>${g.hs}–${g.as}</b>` : g.status === "live" ? `<span class="md-live">🔴 ${g.hs}–${g.as}</span>`
        : `<span class="dim">${g.date ? new Date(g.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}</span>`;
      return `<div class="ag-row${g.id ? " lg-click" : ""}"${g.id ? ` data-mid="${esc(g.id)}"` : ""}><span class="ag-g">${g.group || g.stage}</span><span class="ag-m">${esc(g.home)} ${ownerTag(g.home)} <span class="dim">v</span> ${ownerTag(g.away)} ${esc(g.away)}</span><span class="ag-r">${res}</span></div>`;
    }).join("")).join("");
    showModal(`<button class="modal-x">✕</button><div class="sch-head">📅 All games <span class="dim">${all.length} fixtures</span></div>
      <div class="ag-list">${html || `<div class="md-empty">No fixtures loaded yet.</div>`}</div>`);
  }

  /* ---------- new-leader fireworks celebration ----------------------------- */
  let fwRAF = null;
  function celebrate(name, emoji) {
    const old = document.querySelector(".celebrate"); if (old) old.remove();
    const wrap = el("div", "celebrate");
    wrap.innerHTML = `<canvas class="fw-canvas"></canvas>
      <div class="celebrate-banner">🎉 <span class="cb-emoji">${emoji}</span> <b>${esc(name)}</b> takes 1st place! 🎉
        <div class="cb-sub">New leader of the $${L.pots.main} pot</div></div>`;
    document.body.appendChild(wrap);
    runFireworks(wrap.querySelector("canvas"));
    setTimeout(() => { wrap.classList.add("fade"); setTimeout(() => { if (fwRAF) cancelAnimationFrame(fwRAF); wrap.remove(); }, 800); }, 5500);
  }
  function runFireworks(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width = window.innerWidth, H = canvas.height = window.innerHeight;
    const parts = [], colors = ["#ffd23f", "#ff5d6c", "#2bd576", "#4ea8ff", "#ffffff", "#ff9f1c"];
    const burst = (x, y) => { const c = colors[Math.random() * colors.length | 0]; for (let i = 0; i < 46; i++) { const a = Math.PI * 2 * i / 46, sp = 2 + Math.random() * 4.5; parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 55 + Math.random() * 35, c }); } };
    let f = 0;
    const loop = () => {
      ctx.clearRect(0, 0, W, H);
      if (f % 16 === 0 && f < 170) burst(W * (0.15 + Math.random() * 0.7), H * (0.15 + Math.random() * 0.45));
      for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.045; p.life--; ctx.globalAlpha = Math.max(0, p.life / 80); ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, 7); ctx.fill(); if (p.life <= 0) parts.splice(i, 1); }
      ctx.globalAlpha = 1; f++;
      if (f < 360 || parts.length) fwRAF = requestAnimationFrame(loop);
    };
    loop();
  }
  function checkNewLeader(managers) {
    const leader = managers[0] ? managers[0].name : null;
    if (!leader) return;
    let prev = null; try { prev = localStorage.getItem("wc2026.leader"); } catch (e) {}
    if (prev && prev !== leader) celebrate(leader, managers[0].emoji);   // only when a NEW name takes 1st
    try { localStorage.setItem("wc2026.leader", leader); } catch (e) {}
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
      if (e.target.closest("[data-allgames]")) { openAllGamesModal(); return; }
      const g = e.target.closest("[data-mid]");
      if (g) { openMatchModal(g.dataset.mid); return; }
      const mg = e.target.closest("[data-mgr]");
      if (mg) { openManagerModal(mg.dataset.mgr); return; }
    });
    // when the tab is re-focused (phone unlocked, app reopened), refresh immediately — no stale wait
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCycle(); });
    window.addEventListener("online", () => refreshCycle());
    window.addEventListener("focus", () => { if (scoreCd > 3) refreshCycle(); });
    refreshCycle();
    setInterval(tick, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
