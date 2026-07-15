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
  // "third" = the 3rd-place match, played by the two semifinal losers, so it earns the Semifinal
  // bonus (a semi exit pays +4, exactly as the rules show — NOT the Final's +6). The finalists never
  // play it, so they keep final/champion. KO_ORDER ranks it just past "sf" but below the finalists.
  // Knockout appearance points are CUMULATIVE — a team banks each round's value as it advances.
  // APP_CUM[furthest round a team reached] = running total of appearance points earned by then.
  // (r16 +1, qf +2, sf +4, final +6, champion +8 → champion = 1+2+4+6+8 = 21.) "third" = the
  // 3rd-place match, played by semifinal losers, so it carries the same appearances as reaching SF.
  const APP_CUM = {
    r32: 0,
    r16: SK.r16,
    qf: SK.r16 + SK.qf,
    sf: SK.r16 + SK.qf + SK.sf,
    third: SK.r16 + SK.qf + SK.sf,
    final: SK.r16 + SK.qf + SK.sf + SK.final,
    champion: SK.r16 + SK.qf + SK.sf + SK.final + SK.champion
  };
  const KO_ORDER = ["r32", "r16", "qf", "sf", "third", "final", "champion"];

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

      // who won the match (knockout "Win" point) — trust ESPN's winner flag (correct on penalties),
      // fall back to the scoreline when no flag is present.
      const homeWon = m.homeWinner === true || (m.homeWinner == null && m.awayWinner == null && hs > as);
      const awayWon = m.awayWinner === true || (m.homeWinner == null && m.awayWinner == null && as > hs);
      [[home, hs, as, homeWon], [away, as, hs, awayWon]].forEach(([t, gf, ga, won]) => {
        const ts = team[t];
        ts.fromMatch = true;
        ts.gp += 1; ts.gf += gf; ts.ga += ga;
        if (gf > ga) ts.w += 1; else if (gf === ga) ts.d += 1; else ts.l += 1;
        ts.stand += gf > ga ? 3 : gf === ga ? 1 : 0;     // real 3/1/0 for ranking

        if (isGroup) {                                   // group games no longer score (all SG values are 0)
          ts.fpts += gf > ga ? SG.win : gf === ga ? SG.draw : 0;
          ts.fpts += gf * SG.goalEach;
          if (ga === 0) ts.fpts += SG.shutout;
        } else {                                         // knockout: Win +1, each Goal +1, Shutout +1
          if (won) ts.fpts += (stage === "third" ? SK.thirdWin : SK.win);
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
    // ----- champion: the winner of the FINISHED Final earns the champion bonus;
    //       the loser (runner-up) keeps the "final" bonus. Trust ESPN's winner
    //       flag — correct even when the final goes to penalties — and fall back
    //       to the scoreline. A tie with no flag stays at "final" (no false crown).
    const fin = matches.find((m) => m && m.stage === "final" && m.status === "finished"
      && team[canon(m.home)] && team[canon(m.away)]);
    if (fin) {
      const fh = canon(fin.home), fa = canon(fin.away);
      const hs = Number(fin.homeScore) || 0, as = Number(fin.awayScore) || 0;
      const champ = fin.homeWinner ? fh : fin.awayWinner ? fa : (hs > as ? fh : as > hs ? fa : null);
      if (champ) koMap[champ] = "champion";
    }
    Object.entries(koMap).forEach(([raw, round]) => {
      const t = canon(raw);
      if (team[t] && APP_CUM[round]) { team[t].koBonus = APP_CUM[round]; team[t].fpts += APP_CUM[round]; }
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
      odds: m.odds || null,
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
      const teams = m.teams.map((t) =>
        `<span class="lb-team"><span class="lb-team-name">${esc(t.team)}</span>
          <span class="lb-team-pts">${t.pts}</span></span>`).join("");
      card.innerHTML = `
        <div class="lb-rank">${m.rank === 1 ? "👑" : "#" + m.rank}</div>
        <div class="lb-emoji">${m.emoji}</div>
        <div class="lb-main">
          <div class="lb-name"><span class="mgr-link" data-mgr="${esc(m.name)}" title="see ${esc(m.name)}'s team schedules">${esc(m.name)}</span> ${m.isNew ? "" : arrow(m.deltaRank)}
            ${m.gamesLive ? `<span class="lb-left lb-livedot">🔴 ${m.gamesLive} live</span>` : ""}</div>
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
    // odds-powered projection (computed in renderProjections, which runs earlier in the cycle)
    const sp = state.projCache && state.projCache.data && state.projCache.data.sidePool;
    const winOf = {}, pTopOf = {};
    if (sp) { sp.bettors.forEach((b) => (winOf[b.manager] = b.win)); sp.teams.forEach((t) => (pTopOf[t.team] = t.pTop)); }
    const pct0 = (x) => (x * 100).toFixed(0) + "%";
    const eight = computed.eight.map((e, i) => {
      const mark = ap && i === 0 ? "🏆 " : ap && i === 1 ? "🥈 " : "";
      const cls = ap && i === 0 ? " sp-top" : ap && i === 1 ? " sp-ru" : "";
      const pt = pTopOf[e.team];
      return `<span class="sp-team${cls}">${mark}${esc(e.team)} <b>${e.pts}</b>${(sp && pt != null) ? ` <span class="sp-ptop" title="projected chance of finishing top scorer">${pct0(pt)}</span>` : ""}${e.live ? ' <span class="ct-live">●</span>' : ""}</span>`;
    }).join("");
    const picks = computed.sidePool.map((p) =>
      `<tr><td>${esc(p.manager)}</td>
        <td class="${p.topHit ? "hit" : ""}">${esc(p.top)} <span class="sp-pp">${p.topPts}</span>${p.topHit ? " ✓" : ""}</td>
        <td class="${p.ruHit ? "hit" : ""}">${esc(p.runnerUp)} <span class="sp-pp">${p.ruPts}</span>${p.ruHit ? " ✓" : ""}</td>
        <td class="sp-win">${(sp && winOf[p.manager] != null) ? pct0(winOf[p.manager]) : "—"}</td></tr>`
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
    if (sp && sp.bettors.length && sp.bettors[0].win > 0) {
      note += ` · <b>Projected:</b> ${esc(sp.bettors[0].manager)} ${pct0(sp.bettors[0].win)} to take the $${L.pots.sidePool} (odds-based).`;
    }
    box.innerHTML = `
      <div class="panel-h">💰 Remaining 8 — $${L.pots.sidePool} Side Pool <span class="dim">predict the top scorer · $ to the correct Top pick</span></div>
      <div class="sp-standings">${eight}</div>
      <table class="sp-t"><thead><tr><th>Manager</th><th>Top Point Winner</th><th>Runner-Up</th><th title="projected chance of winning the $${L.pots.sidePool}">Win $${L.pots.sidePool}</th></tr></thead>
        <tbody>${picks}</tbody></table>
      <div class="sp-note">${note}</div>`;
  }

  function renderPots(computed) {
    const box = $("#pots");
    const leader = computed.managers[0];
    const runner = computed.managers[1];
    box.innerHTML = `
      <div class="panel-h">🏆 Money Pot <span class="dim">Round of 32 → Final</span></div>
      <div class="pot-grid">
        <div class="pot">
          <div class="pot-amt">$${L.pots.main}</div>
          <div class="pot-lbl">Knockout pot · $${L.pots.buyIn} rebuy / manager</div>
          <div class="pot-line">Leader: <b>${leader.emoji} ${esc(leader.name)}</b></div>
          <div class="pot-line dim">Winner takes the prize · runner-up${runner ? ` (${esc(runner.name)})` : ""} gets money back</div>
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

  /* ---------- DraftKings odds display (from the captured m.odds) ----------- */
  const fmtAm = (n) => (n == null ? "—" : (n > 0 ? "+" + n : "" + n));   // American odds, e.g. -225 / +700
  const teamCode = (name) => esc(String(name || "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase());
  function impliedPct(o) {                                  // de-vigged win/draw/away %
    if (!o) return null;
    const pH = amToProb(o.home), pA = amToProb(o.away), pD = (o.draw != null ? amToProb(o.draw) : null);
    if (pH == null || pA == null) return null;
    const dd = pD == null ? 0 : pD, s = pH + dd + pA; if (s <= 0) return null;
    return { h: Math.round(pH / s * 100), d: pD == null ? null : Math.round(dd / s * 100), a: Math.round(pA / s * 100) };
  }
  // compact one-line odds for a game row: HOME ml · X ml · AWAY ml · O/U · DK (favorite highlighted)
  function oddsInline(g) {
    const o = g && g.odds; if (!o || o.home == null || o.away == null) return "";
    const favH = o.home <= o.away;
    const cell = (code, ml, fav) => `<span class="lg-od${fav ? " lg-odfav" : ""}">${code} ${fmtAm(ml)}</span>`;
    return `<span class="lg-odds"><span class="lg-odbk">DK</span>${cell(teamCode(g.home), o.home, favH)}` +
      `${o.draw != null ? `<span class="lg-od">X ${fmtAm(o.draw)}</span>` : ""}${cell(teamCode(g.away), o.away, !favH)}` +
      `${o.total != null ? `<span class="lg-od lg-odou">O/U ${o.total}</span>` : ""}</span>`;
  }
  // fuller odds block for the match modal: each outcome's moneyline + implied %, favorite highlighted
  function dkBlock(g) {
    const o = g && g.odds; if (!o || o.home == null || o.away == null) return "";
    const ip = impliedPct(o), favH = o.home <= o.away;
    const c = (name, ml, pct, fav) => `<div class="md-od${fav ? " md-odfav" : ""}">
      <div class="md-od-t">${esc(name)}</div><div class="md-od-ml">${fmtAm(ml)}</div>${pct != null ? `<div class="md-od-pc">${pct}%</div>` : ""}</div>`;
    return `<div class="md-odds"><div class="md-odds-h">💰 DraftKings line${o.total != null ? ` · Total O/U ${o.total} goals` : ""}</div>
      <div class="md-odds-grid">${c(g.home, o.home, ip && ip.h, favH)}${o.draw != null ? c("Draw", o.draw, ip && ip.d, false) : ""}${c(g.away, o.away, ip && ip.a, !favH)}</div></div>`;
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
      <span class="lg-when">${upStr(m.date)}</span>${oddsInline(m)}</div>`).join("");

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
        return `<div class="club-team"><span class="ct-name">${esc(ct)}</span>
          ${ts.live ? '<span class="ct-gp"><span class="ct-live">●LIVE</span></span>' : ""}
          <span class="club-pts">${ts.fpts}</span></div>`;
      }).join("");
      const total = m.teams.reduce((s, t) => s + computed.team[canon(t)].fpts, 0);
      return `<div class="club"><div class="club-h">${m.emoji} <b class="mgr-link" data-mgr="${esc(m.name)}" title="see ${esc(m.name)}'s team schedules">${esc(m.name)}</b>
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
    const k = L.scoring.knockout;
    const r = (label, val, plus) => `<div class="rule"><span>${label}</span><b>${plus ? "+" : ""}${val}</b></div>`;
    box.innerHTML = `<div class="panel-h">📏 Scoring Rules <span class="dim">Round of 32 → Final · everyone starts at 0</span></div>
      <div class="rules-wrap">
        <div class="rules-col"><div class="rules-h">Per Knockout Game</div>
          ${r("Win", k.win)}${r("Goal (each)", k.goalEach)}${r("Shutout", k.shutout)}</div>
        <div class="rules-col"><div class="rules-h">Appearance (cumulative)</div>
          ${r("Reach Round of 16", k.r16, true)}${r("Reach Quarterfinal", k.qf, true)}${r("Reach Semifinal", k.sf, true)}${r("Reach Final", k.final, true)}${r("Champion", k.champion, true)}</div>
      </div>
      <div class="rules-foot">Appearances stack as a team advances — a Champion earns ${APP_CUM.champion} from appearances (1+2+4+6+8) plus Win/Goal/Shutout points each round. The 3rd-place game pays +${k.thirdWin} for the win.</div>`;
  }

  /* =========================================================================
     KNOCKOUT BRACKET — a live tree of the Round of 32 → Final.
     HIDDEN until the group stage is over (every group has played its 6 games),
     then it reveals itself and fills in as ESPN resolves each matchup.

     ESPN publishes the whole knockout schedule from day one (placeholder teams
     like "Group A Winner"), so we order each round's fixtures by ESPN id — which
     equals FIFA's match numbering — to know which slot is which. The 2026 tree
     is fixed; the per-side, top-to-bottom slot orders below are arranged so each
     match sits directly between the two feeders that produce it (so equal-height
     flex slots align the whole tree automatically).
     ====================================================================== */
  const KO_STAGES = ["r32", "r16", "qf", "sf", "final", "third"];
  const TEAM_SET = new Set(ALL_TEAMS);
  const ROUND_LABEL = { r32: "Round of 32", r16: "Round of 16", qf: "Quarters", sf: "Semis", final: "Final", third: "3rd place" };
  // STABLE upper structure: which R16/QF/SF matches sit on each half (from QF/SF wiring, which never
  // shifts). The R32-column order is derived live per side (buildBracket), so r32 here is just a fallback.
  const BRACKET = {
    left:  { r32: [1, 3, 4, 7, 11, 12, 9, 10], r16: [1, 2, 5, 6], qf: [1, 2], sf: [1] },
    right: { r32: [2, 5, 6, 8, 13, 15, 14, 16], r16: [3, 4, 7, 8], qf: [3, 4], sf: [2] }
  };

  // the group stage is over once all 12 groups are complete (or any knockout game has kicked off)
  function isGroupStageOver(computed) {
    const raw = (state.results && state.results.matches) || [];
    if (raw.some((m) => m && KO_STAGES.includes(m.stage) && (m.status === "live" || m.status === "finished"))) return true;
    const groups = Object.keys(L.groups);
    return groups.length > 0 && groups.every((g) => computed.groupTables[g] && computed.groupTables[g].complete);
  }

  // Which two R32 matches feed each Round-of-16 match (1..8 by ESPN id). ESPN's bracket differs from
  // its early placeholder labels and those labels can go stale, so we DERIVE this from the live feed:
  // each resolved R16 team came from the R32 match it won (authoritative); placeholders / gaps fill by
  // constraint (every R32 match feeds exactly one R16). Falls back to the static R16_FEED if unreadable.
  function deriveR16Feed(raw) {
    const ms = (m, st) => (raw || []).filter((x) => x && x.stage === st).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    const r32 = ms(raw, "r32"), r16 = ms(raw, "r16");
    if (r16.length !== 8 || r32.length !== 16) return R16_FEED;
    const winnerTeam = (m) => { if (m.status !== "finished") return null; const hs = Number(m.homeScore) || 0, as = Number(m.awayScore) || 0;
      return m.homeWinner ? canon(m.home) : m.awayWinner ? canon(m.away) : hs > as ? canon(m.home) : as > hs ? canon(m.away) : null; };
    const r32win = {}; r32.forEach((m, i) => { const w = winnerTeam(m); if (w) r32win[w] = i + 1; });
    const F = {}, claimed = new Set();
    r16.forEach((m, i) => { F[i + 1] = [null, null]; [m.home, m.away].forEach((name, si) => {       // 1) resolved teams (authoritative)
      const num = r32win[canon(name)]; if (num && !claimed.has(num)) { F[i + 1][si] = num; claimed.add(num); } }); });
    r16.forEach((m, i) => [m.home, m.away].forEach((name, si) => { if (F[i + 1][si] != null) return;   // 2) placeholder labels, if free
      const ph = String(name || "").match(/round of 32\s+(\d+)\s+winner/i); if (ph && !claimed.has(+ph[1])) { F[i + 1][si] = +ph[1]; claimed.add(+ph[1]); } }));
    const missing = []; for (let n = 1; n <= 16; n++) if (!claimed.has(n)) missing.push(n);            // 3) fill the rest by constraint
    r16.forEach((m, i) => [0, 1].forEach((si) => { if (F[i + 1][si] == null) { const mn = missing.shift(); if (mn != null) { F[i + 1][si] = mn; claimed.add(mn); } } }));
    return F;
  }

  // map the live feed onto the 2026 tree: stable upper structure (which R16 matches sit on each side),
  // with the R32 column order derived from the live feed so every match aligns with its real feeders.
  function buildBracket() {
    const raw = Array.isArray(state.results.matches) ? state.results.matches : [];
    const byRound = {}; KO_STAGES.forEach((st) => (byRound[st] = []));
    raw.forEach((m) => { if (m && byRound[m.stage]) byRound[m.stage].push(m); });
    KO_STAGES.forEach((st) => byRound[st].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)));
    const slot = (round, idx) => {
      const m = byRound[round][idx - 1];
      if (!m) return { round, idx, empty: true };
      const home = canon(m.home), away = canon(m.away);
      const hReal = TEAM_SET.has(home), aReal = TEAM_SET.has(away);
      const hs = Number(m.homeScore) || 0, as = Number(m.awayScore) || 0;
      const finished = m.status === "finished";
      const winner = finished ? (m.homeWinner ? "home" : m.awayWinner ? "away" : hs > as ? "home" : as > hs ? "away" : null) : null;
      return { round, idx, id: m.id || null, status: m.status || "scheduled",
               home, away, hReal, aReal, hs, as, finished, winner, clickable: hReal && aReal && !!m.id };
    };
    const rf = deriveR16Feed(raw);
    const r32order = (r16list) => r16list.reduce((acc, k) => acc.concat(rf[k] || [0, 0]), []);
    const ord = {
      left:  { r16: BRACKET.left.r16,  qf: BRACKET.left.qf,  sf: BRACKET.left.sf,  r32: r32order(BRACKET.left.r16) },
      right: { r16: BRACKET.right.r16, qf: BRACKET.right.qf, sf: BRACKET.right.sf, r32: r32order(BRACKET.right.r16) }
    };
    const col = (side, round) => ord[side][round].map((idx) => slot(round, idx));
    return {
      left:  { r32: col("left", "r32"),  r16: col("left", "r16"),  qf: col("left", "qf"),  sf: col("left", "sf") },
      right: { r32: col("right", "r32"), r16: col("right", "r16"), qf: col("right", "qf"), sf: col("right", "sf") },
      final: slot("final", 1), third: slot("third", 1)
    };
  }

  function renderBracket(computed) {
    const box = $("#bracket"); if (!box) return;
    if (!isGroupStageOver(computed)) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const B = buildBracket();

    const teamRow = (name, real, score, mark, showScore, crown) => {
      const owner = real ? OWNER_OF[name] : null;
      const emoji = owner ? MANAGER[owner].emoji : "";
      return `<div class="bk-row bk-${mark}${real ? "" : " bk-tbd"}">
        <span class="bk-em">${emoji}</span>
        <span class="bk-tm">${crown ? "👑 " : ""}${esc(real ? name : "TBD")}</span>
        <span class="bk-sc">${showScore ? score : ""}</span></div>`;
    };
    const card = (m) => {
      if (!m || m.empty) return `<div class="bk-match bk-empty">
        <div class="bk-row bk-tbd"><span class="bk-em"></span><span class="bk-tm">TBD</span><span class="bk-sc"></span></div>
        <div class="bk-row bk-tbd"><span class="bk-em"></span><span class="bk-tm">TBD</span><span class="bk-sc"></span></div></div>`;
      const show = m.status === "finished" || m.status === "live";
      const hMark = m.finished ? (m.winner === "home" ? "win" : m.winner === "away" ? "lose" : "n") : "n";
      const aMark = m.finished ? (m.winner === "away" ? "win" : m.winner === "home" ? "lose" : "n") : "n";
      const isFinal = m.round === "final";
      return `<div class="bk-match${m.clickable ? " bk-click" : ""}${m.status === "live" ? " bk-livematch" : ""}"${m.clickable ? ` data-mid="${esc(m.id)}"` : ""}>
        ${teamRow(m.home, m.hReal, m.hs, hMark, show, isFinal && hMark === "win")}
        ${teamRow(m.away, m.aReal, m.as, aMark, show, isFinal && aMark === "win")}
        ${m.status === "live" ? `<span class="bk-livetag">🔴 LIVE</span>` : ""}</div>`;
    };
    const colEl = (slots, round) => `<div class="bk-col"><div class="bk-rhead">${ROUND_LABEL[round]}</div>${slots.map((m) => `<div class="bk-slot">${card(m)}</div>`).join("")}</div>`;

    const champ = (B.final && B.final.finished && B.final.winner)
      ? (B.final.winner === "home" ? B.final.home : B.final.away) : null;
    const champOwner = champ ? OWNER_OF[champ] : null;
    const champBanner = champ
      ? `<div class="bk-champ">🏆 Champion: ${champOwner ? MANAGER[champOwner].emoji + " " : ""}<b>${esc(champ)}</b></div>`
      : `<div class="bk-champ bk-champ-tbd">🏆 Champion</div>`;

    box.innerHTML = `
      <div class="panel-h">🏆 Knockout Bracket <span class="dim">winners advance toward the final →</span></div>
      <div class="bk-scroll"><div class="bk">
        <div class="bk-side bk-left">
          ${colEl(B.left.r32, "r32")}${colEl(B.left.r16, "r16")}${colEl(B.left.qf, "qf")}${colEl(B.left.sf, "sf")}
        </div>
        <div class="bk-mid">
          ${champBanner}
          <div class="bk-mid-final">${card(B.final)}</div>
          <div class="bk-mid-third"><div class="bk-third-h">3rd-place match</div>${card(B.third)}</div>
        </div>
        <div class="bk-side bk-right">
          ${colEl(B.right.sf, "sf")}${colEl(B.right.qf, "qf")}${colEl(B.right.r16, "r16")}${colEl(B.right.r32, "r32")}
        </div>
      </div></div>`;
  }

  /* =========================================================================
     PROJECTIONS (#1-3) — Monte Carlo from live DraftKings odds.
     Per manager: Banked (locked in) → Projected (avg finish) → Ceiling (top 10%),
     plus their chance of finishing 1st for the $250 main pot.
     Remaining GROUP games are simulated from DK win/draw/total prices; the
     knockout is a strength-seeded bracket (an estimate until the real bracket is
     set, when it switches to actual matchups + per-game odds). One fixed RNG seed
     → every visitor sees the same numbers; recomputed only when scores change.
     ====================================================================== */
  const SIM_N = 4000, WC_MEAN = 1.3;
  const amToProb = (am) => (am == null ? null : (am > 0 ? 100 / (am + 100) : -am / (-am + 100)));
  // de-vigged win/draw/away probabilities + expected goals (split the total by supremacy) from DK odds
  function oddsModel(o) {
    if (!o) return null;
    let pH = amToProb(o.home), pA = amToProb(o.away), pD = (o.draw != null ? amToProb(o.draw) : 0.26);
    if (pH == null || pA == null) return null;
    const s = pH + pD + pA; if (s <= 0) return null; pH /= s; pD /= s; pA /= s;
    const tot = (typeof o.total === "number" && o.total > 0) ? o.total : 2.6;
    const share = Math.min(0.85, Math.max(0.15, 0.5 + 0.45 * (pH - pA)));
    return { pH, pD, pA, lH: tot * share, lA: tot * (1 - share) };
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function rpois(rng, l) { if (l <= 0) return 0; const L0 = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L0); return k - 1; }
  const clampn = (x, a, b) => Math.min(b, Math.max(a, x));
  const lamFromStrength = (A, B, S) => ({ lH: clampn(WC_MEAN * S.atk[A] * S.def[B], 0.15, 4.5), lA: clampn(WC_MEAN * S.atk[B] * S.def[A], 0.15, 4.5) });

  // attack/defense ratings (vs WC mean), shrunk toward the mean, from every match that carries DK odds
  function buildStrengths(matches) {
    const sc = {}, co = {}; ALL_TEAMS.forEach((t) => { sc[t] = []; co[t] = []; });
    matches.forEach((m) => {
      const md = oddsModel(m && m.odds); if (!md) return;
      const h = canon(m.home), a = canon(m.away); if (!sc[h] || !sc[a]) return;
      sc[h].push(md.lH); co[h].push(md.lA); sc[a].push(md.lA); co[a].push(md.lH);
    });
    const K = 2, atk = {}, def = {}, avg = (arr) => (arr.reduce((x, y) => x + y, 0) + WC_MEAN * K) / (arr.length + K);
    ALL_TEAMS.forEach((t) => { atk[t] = avg(sc[t]) / WC_MEAN; def[t] = avg(co[t]) / WC_MEAN; });
    return { atk, def };
  }

  // Fallback R16 wiring (R32 matches feeding each R16) — only used if the live feed can't be read;
  // normally derived live by deriveR16Feed() so it always tracks ESPN's actual bracket.
  const R16_FEED = { 1: [1, 3], 2: [4, 7], 3: [2, 5], 4: [6, 8], 5: [11, 12], 6: [9, 10], 7: [13, 15], 8: [14, 16] };
  const QF_FEED = { 1: [1, 2], 2: [5, 6], 3: [3, 4], 4: [7, 8] };
  const SF_FEED = { 1: [1, 2], 2: [3, 4] };

  function runProjection(computed) {
    const matches = Array.isArray(state.results.matches) ? state.results.matches : [];
    const S = buildStrengths(matches);
    // actual results of every finished knockout game, keyed by "home|away" so finished games are
    // DETERMINISTIC in the sim (resolved by team identity → no double-count, no bracket-slot guessing).
    const finRes = {};
    matches.forEach((m) => {
      if (!m || m.stage === "group" || m.status !== "finished") return;
      const h = canon(m.home), a = canon(m.away); if (!TEAM_SET.has(h) || !TEAM_SET.has(a)) return;
      const hs = Number(m.homeScore) || 0, as = Number(m.awayScore) || 0;
      const hw = m.homeWinner === true || (m.homeWinner == null && m.awayWinner == null && hs > as);
      finRes[h + "|" + a] = { winner: hw ? h : a, gh: hs, ga: as };
    });
    // the 16 Round-of-32 matchups from the feed (real teams, ordered by ESPN id = R32 match number)
    const r32 = matches.filter((m) => m && m.stage === "r32" && TEAM_SET.has(canon(m.home)) && TEAM_SET.has(canon(m.away)))
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
      .map((m) => ({ home: canon(m.home), away: canon(m.away), md: oddsModel(m.odds) }));
    const ready = r32.length === 16;
    const RF = deriveR16Feed(matches);   // R16 wiring from the live feed (matches ESPN's actual bracket)

    // play one game: finished → actual result; else simulate (R32 from DK odds, later rounds from strength)
    function playGame(A, B, md, rng, tp) {
      let gA, gB, aWon;
      if (finRes[A + "|" + B]) { const x = finRes[A + "|" + B]; gA = x.gh; gB = x.ga; aWon = x.winner === A; }
      else if (finRes[B + "|" + A]) { const x = finRes[B + "|" + A]; gA = x.ga; gB = x.gh; aWon = x.winner === A; }
      else { const lam = md || lamFromStrength(A, B, S); gA = rpois(rng, lam.lH); gB = rpois(rng, lam.lA); aWon = gA === gB ? rng() < 0.5 : gA > gB; }
      tp[A] = (tp[A] || 0) + (aWon ? SK.win : 0) + gA * SK.goalEach + (gB === 0 ? SK.shutout : 0);
      tp[B] = (tp[B] || 0) + (aWon ? 0 : SK.win) + gB * SK.goalEach + (gA === 0 ? SK.shutout : 0);
      return aWon ? A : B;
    }

    function oneSim(rng) {
      const tp = {}, furth = {};
      const setF = (t, s) => { if (!furth[t] || KO_ORDER.indexOf(s) > KO_ORDER.indexOf(furth[t])) furth[t] = s; };
      const w32 = {};
      r32.forEach((mm, i) => { const A = mm.home, B = mm.away; setF(A, "r32"); setF(B, "r32"); w32[i + 1] = playGame(A, B, mm.md, rng, tp); });
      const w16 = {};
      for (let k = 1; k <= 8; k++) { const A = w32[RF[k][0]], B = w32[RF[k][1]]; setF(A, "r16"); setF(B, "r16"); w16[k] = playGame(A, B, null, rng, tp); }
      const wqf = {};
      for (let k = 1; k <= 4; k++) { const A = w16[QF_FEED[k][0]], B = w16[QF_FEED[k][1]]; setF(A, "qf"); setF(B, "qf"); wqf[k] = playGame(A, B, null, rng, tp); }
      const wsf = {}, lsf = {};
      for (let k = 1; k <= 2; k++) { const A = wqf[SF_FEED[k][0]], B = wqf[SF_FEED[k][1]]; setF(A, "sf"); setF(B, "sf"); const w = playGame(A, B, null, rng, tp); wsf[k] = w; lsf[k] = w === A ? B : A; }
      { const A = wsf[1], B = wsf[2]; setF(A, "final"); setF(B, "final"); setF(playGame(A, B, null, rng, tp), "champion"); }
      { const A = lsf[1], B = lsf[2]; setF(A, "third"); setF(B, "third"); playGame(A, B, null, rng, tp); }
      for (const t in furth) tp[t] = (tp[t] || 0) + (APP_CUM[furth[t]] || 0);          // cumulative appearance
      const out = {};
      for (const mgr of L.managers) out[mgr.name] = mgr.teams.reduce((s, t) => s + (tp[canon(t)] || 0), 0);
      return out;
    }

    const banked = {}; L.managers.forEach((m) => (banked[m.name] = Math.round(m.teams.reduce((s, t) => s + computed.team[canon(t)].fpts, 0))));
    if (!ready) {   // Round-of-32 field not fully set yet → show banked only, no projection
      return { ready: false, n: SIM_N, oddsCount: r32.filter((x) => x.md).length,
        rows: L.managers.map((m) => ({ name: m.name, emoji: m.emoji, banked: banked[m.name], proj: banked[m.name], ceil: banked[m.name], win: 0 })).sort((a, b) => b.banked - a.banked) };
    }
    const rng = mulberry32(20260628);     // fixed seed → reproducible for every visitor
    const totals = {}, wins = {}; L.managers.forEach((m) => { totals[m.name] = new Float64Array(SIM_N); wins[m.name] = 0; });
    for (let s = 0; s < SIM_N; s++) {
      const mt = oneSim(rng);
      let best = -Infinity, leaders = [];
      for (const m of L.managers) { const v = mt[m.name]; totals[m.name][s] = v; if (v > best) { best = v; leaders = [m.name]; } else if (v === best) leaders.push(m.name); }
      leaders.forEach((n) => (wins[n] += 1 / leaders.length));
    }
    const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
    const pctl = (a, p) => { const b = Array.from(a).sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
    const rows = L.managers.map((m) => ({
      name: m.name, emoji: m.emoji, banked: banked[m.name],
      proj: Math.round(mean(totals[m.name])), ceil: Math.round(pctl(totals[m.name], 0.9)), win: wins[m.name] / SIM_N
    }));
    rows.sort((a, b) => b.proj - a.proj || b.win - a.win);
    return { rows, n: SIM_N, oddsCount: r32.filter((x) => x.md).length, ready: true };
  }

  function renderProjections(computed) {
    const box = $("#projections"); if (!box) return;
    const matches = (state.results && state.results.matches) || [];
    const sig = computed.managers.reduce((s, m) => s + m.total, 0) + "|" +
      matches.filter((m) => m && m.status === "finished").length + "|" + matches.filter((m) => m && m.odds).length;
    if (!state.projCache || state.projCache.sig !== sig) state.projCache = { sig, data: runProjection(computed) };
    const P = state.projCache.data;
    const maxWin = Math.max(0.01, ...P.rows.map((r) => r.win));
    const rows = P.rows.map((r, i) => `<tr class="${i === 0 ? "proj-lead" : ""}">
        <td class="proj-mgr">${r.emoji} ${esc(r.name)}</td>
        <td class="proj-n">${r.banked}</td>
        <td class="proj-n proj-pj"><b>${r.proj}</b></td>
        <td class="proj-n proj-cl">${r.ceil}</td>
        <td class="proj-win"><span class="proj-bar" style="width:${(r.win / maxWin * 100).toFixed(0)}%"></span><span class="proj-wn">${(r.win * 100).toFixed(1)}%</span></td>
      </tr>`).join("");
    const note = !P.ready
      ? `Projections start once all 16 Round-of-32 matchups are set. <b>Now</b> = points banked so far.`
      : `Monte Carlo over the rest of the knockouts (${P.n.toLocaleString()} sims) from live <b>DraftKings</b> odds (${P.oddsCount} R32 games priced; later rounds use form). Finished games are locked to their real result. <b>Now</b> = banked · <b>Proj</b> = average finish · <b>Ceiling</b> = top-10% outcome · <b>Win $${L.pots.main}</b> = chance of finishing 1st. Updates as results land.`;
    box.innerHTML = `<div class="panel-h">📈 Projections <span class="dim">odds-powered · ${P.n.toLocaleString()} sims · DraftKings</span></div>
      <div class="proj-tablewrap"><table class="proj-t">
        <thead><tr><th>Manager</th><th title="points banked so far">Now</th><th title="average simulated finish">Proj</th><th title="top-10% outcome">Ceiling</th><th title="chance of finishing 1st for the $${L.pots.main} pot">Win $${L.pots.main}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="proj-note">${note}</div>`;
  }

  /* =========================================================================
     POINTS OVER TIME — cumulative fantasy points per manager, by match day.
     Reconstructed by re-running the exact scoring engine on the finished games
     up to each day (so the last point always equals the live standings).
     ====================================================================== */
  function managerTotalsAsOf(sub) {
    const saved = state.results.matches;
    state.results.matches = sub;
    const totals = {};
    try { computeState().managers.forEach((m) => (totals[m.name] = m.total)); }
    finally { state.results.matches = saved; }
    return totals;
  }
  function pointsTimeline(computed) {
    const all = (state.results.matches || []).filter((m) => m && m.status === "finished" && m.date && m.stage !== "group"
      && computed.team[canon(m.home)] && computed.team[canon(m.away)]);   // knockout games only — group no longer scores
    const dayOf = (m) => String(m.date).slice(0, 10);
    const days = [...new Set(all.map(dayOf))].sort();
    if (days.length < 2) return { days: [], series: {} };
    const series = {}; L.managers.forEach((m) => (series[m.name] = []));
    for (const d of days) {
      const tot = managerTotalsAsOf(all.filter((m) => dayOf(m) <= d));
      L.managers.forEach((m) => series[m.name].push(tot[m.name] || 0));
    }
    return { days, series };
  }
  const TL_COLORS = ["#ffd23f", "#4ea8ff", "#2bd576", "#ff5d6c", "#b07cff", "#ff9f1c", "#19d3da", "#ff6fb5", "#9acd32", "#c0c8d8"];
  function renderTimeline(computed) {
    const box = $("#timeline"); if (!box) return;
    const matches = state.results.matches || [];
    const sig = computed.managers.reduce((s, m) => s + m.total, 0) + "|" + matches.filter((m) => m && m.status === "finished").length;
    if (!state.tlCache || state.tlCache.sig !== sig) state.tlCache = { sig, data: pointsTimeline(computed) };
    const T = state.tlCache.data, n = T.days.length;
    if (!n) { box.innerHTML = `<div class="panel-h">📈 Points Over Time</div><div class="tl-empty">A trend line appears once a few match days are in the books.</div>`; return; }
    const W = 920, H = 360, padL = 32, padR = 16, padT = 14, padB = 26;
    const maxV = Math.max(1, ...L.managers.map((m) => T.series[m.name][n - 1]));
    const x = (i) => padL + (n === 1 ? 0 : i / (n - 1) * (W - padL - padR));
    const y = (v) => H - padB - (v / maxV) * (H - padT - padB);
    const order = L.managers.map((m) => ({ m, fin: T.series[m.name][n - 1] })).sort((a, b) => b.fin - a.fin);
    const colorOf = {}; order.forEach((o, i) => (colorOf[o.m.name] = TL_COLORS[i % TL_COLORS.length]));
    let grid = "";
    for (let g = 0; g <= 4; g++) { const v = maxV * g / 4, yy = y(v).toFixed(1); grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="tl-grid"/><text x="${padL - 5}" y="${(+yy + 3).toFixed(1)}" class="tl-yl">${Math.round(v)}</text>`; }
    const lines = order.map((o) => {
      const pts = T.series[o.m.name].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const lead = o === order[0], col = colorOf[o.m.name];
      return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${lead ? 3 : 1.8}" opacity="${lead ? 1 : 0.82}" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n - 1).toFixed(1)}" cy="${y(o.fin).toFixed(1)}" r="${lead ? 3.6 : 2.4}" fill="${col}"/>`;
    }).join("");
    const dl = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const xl = `<text x="${padL}" y="${H - 7}" class="tl-xl">${esc(dl(T.days[0]))}</text><text x="${W - padR}" y="${H - 7}" class="tl-xl" text-anchor="end">${esc(dl(T.days[n - 1]))}</text>`;
    const legend = order.map((o) => `<span class="tl-leg"><span class="tl-sw" style="background:${colorOf[o.m.name]}"></span>${o.m.emoji} ${esc(o.m.name)} <b>${o.fin}</b></span>`).join("");
    box.innerHTML = `<div class="panel-h">📈 Points Over Time <span class="dim">cumulative fantasy points · by match day</span></div>
      <div class="tl-wrap"><svg viewBox="0 0 ${W} ${H}" class="tl-svg" preserveAspectRatio="xMidYMid meet">${grid}${lines}${xl}</svg></div>
      <div class="tl-legend">${legend}</div>`;
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
    renderBracket(computed);
    renderLeaderboard(computed.managers);
    renderProjections(computed);
    renderPots(computed);
    renderGames(computed);
    renderClubs(computed);
    renderTimeline(computed);
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
  const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260720";
  // DraftKings odds, straight out of the ESPN feed: home/draw/away moneyline (American) + goal total.
  // We capture the closing price (fallback to opening). These power the projections (probabilities + xG).
  function parseOdds(comp) {
    const o = comp && comp.odds && comp.odds[0]; if (!o) return null;
    const ml = o.moneyline || {};
    const pick = (side) => { const x = ml[side]; const v = x && ((x.close && x.close.odds) || (x.open && x.open.odds)); return v != null ? parseInt(v, 10) : null; };
    const home = pick("home"), away = pick("away");
    if (home == null || away == null) return null;
    const draw = ml.draw ? pick("draw") : (o.drawOdds && o.drawOdds.moneyLine != null ? Number(o.drawOdds.moneyLine) : null);
    return { home, away, draw, total: (typeof o.overUnder === "number") ? o.overUnder : null, book: (o.provider && o.provider.name) || null };
  }

  // ESPN's season slug names the match's OWN round, unpolluted by feeder labels (an R16 game is named
  // "Round of 32 1 Winner..."). Prefer the exact slug, then fall back to text. Keeps knockout stages right.
  const SLUG_STAGE = { "round-of-32": "r32", "round-of-16": "r16", "quarterfinals": "qf",
                      "semifinals": "sf", "3rd-place-match": "third", "final": "final" };
  function espnStage(ev, comp) {
    const slug = ev && ev.season && ev.season.slug;
    if (slug && SLUG_STAGE[slug]) return SLUG_STAGE[slug];
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
        homeWinner: h.winner === true,     // ESPN's authoritative result — true even when the match is decided on penalties
        awayWinner: a.winner === true,
        odds: parseOdds(comp),             // DraftKings moneyline + total (powers the projections)
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
             homeWinner: m.homeWinner === true, awayWinner: m.awayWinner === true,
             odds: m.odds || null,
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
    showModal(`${matchHeaderHtml(g)}${dkBlock(g)}${motmHtml}<div id="md-body">${body}</div>
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
