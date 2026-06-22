/* =============================================================================
   fetch-scores.mjs — pulls live 2026 World Cup scores from ESPN's public
   scoreboard (no API key) and writes data/live.json in the tracker's format.
   Runs on GitHub Actions (which has internet + no browser CORS limits).

   Node 20+ (uses global fetch). No dependencies.
   ========================================================================== */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=";
const START = "2026-06-11";              // tournament opener; we aggregate from here for cumulative scoring

/* --- canonical team names + aliases (mirrors data/league.js) --------------- */
const GROUPS = {
  A: ["Mexico","South Africa","South Korea","Czechia"],
  B: ["Canada","Switzerland","Qatar","Bosnia and Herzegovina"],
  C: ["Brazil","Morocco","Haiti","Scotland"],
  D: ["United States","Paraguay","Australia","Türkiye"],
  E: ["Germany","Curaçao","Ivory Coast","Ecuador"],
  F: ["Netherlands","Japan","Tunisia","Sweden"],
  G: ["Belgium","Egypt","Iran","New Zealand"],
  H: ["Spain","Cabo Verde","Saudi Arabia","Uruguay"],
  I: ["France","Senegal","Norway","Iraq"],
  J: ["Argentina","Algeria","Austria","Jordan"],
  K: ["Portugal","DR Congo","Uzbekistan","Colombia"],
  L: ["England","Croatia","Ghana","Panama"]
};
const CANON = new Set(Object.values(GROUPS).flat());
const ALIASES = {
  "turkey":"Türkiye","turkiye":"Türkiye","türkiye":"Türkiye",
  "curacao":"Curaçao","curaçao":"Curaçao",
  "cape verde":"Cabo Verde","cabo verde":"Cabo Verde","capo verde":"Cabo Verde","cape verde islands":"Cabo Verde",
  "dr congo":"DR Congo","congo dr":"DR Congo","democratic republic of the congo":"DR Congo","congo":"DR Congo",
  "uzbekistan":"Uzbekistan","uzbekizstan":"Uzbekistan",
  "algeria":"Algeria","alegeria":"Algeria",
  "united states":"United States","usa":"United States","united states of america":"United States",
  "south korea":"South Korea","korea republic":"South Korea","republic of korea":"South Korea",
  "ivory coast":"Ivory Coast","côte d'ivoire":"Ivory Coast","cote d'ivoire":"Ivory Coast",
  "bosnia and herzegovina":"Bosnia and Herzegovina","bosnia & herzegovina":"Bosnia and Herzegovina","bosnia-herzegovina":"Bosnia and Herzegovina","bosnia":"Bosnia and Herzegovina",
  "czechia":"Czechia","czech republic":"Czechia",
  "iran":"Iran","ir iran":"Iran"
};
const canon = (n) => {
  if (!n) return n;
  const k = String(n).trim().toLowerCase();
  return ALIASES[k] || String(n).trim();
};

/* --- helpers --------------------------------------------------------------- */
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
function* dateRange(startStr, endDate) {
  const d = new Date(startStr + "T00:00:00Z");
  while (d <= endDate) { yield ymd(d); d.setUTCDate(d.getUTCDate() + 1); }
}
// ESPN's season slug is the AUTHORITATIVE round of the match itself — unlike the event name, it is
// NOT polluted by feeder labels ("Round of 32 1 Winner" names an R16 match, not an R32 one). Prefer it.
const SLUG_STAGE = { "round-of-32": "r32", "round-of-16": "r16", "quarterfinals": "qf",
                    "semifinals": "sf", "3rd-place-match": "third", "final": "final" };
// Round detection: exact season slug first, then fall back to any ESPN text. Check specific rounds
// before "final" so semifinal/quarterfinal aren't misread, so knockout scoring stays correct.
const stageOf = (s = "", slug = "") => {
  if (SLUG_STAGE[slug]) return SLUG_STAGE[slug];
  s = String(s).toLowerCase();
  if (/round of 32|round-of-32|\bro32\b/.test(s)) return "r32";
  if (/round of 16|round-of-16|\bro16\b/.test(s)) return "r16";
  if (/quarter/.test(s)) return "qf";
  if (/semi/.test(s)) return "sf";
  if (/third place|3rd place/.test(s)) return "third";
  if (/\bfinal\b/.test(s)) return "final";
  return "group";
};
// pull every text field ESPN might carry the round in, for stageOf()
const stageText = (ev, comp) => [(ev.season && ev.season.slug) || "", ev.name || "", ev.shortName || "",
  ((comp && comp.notes) || []).map((n) => n.headline || n.text || "").join(" "),
  (comp && comp.type && (comp.type.text || comp.type.abbreviation)) || ""].join(" ");
const statusOf = (state) => state === "post" ? "finished" : state === "in" ? "live" : "scheduled";
// DraftKings odds from the ESPN feed: home/draw/away moneyline (American) + goal total. Closing price,
// fallback to opening. Captured into live.json so the projections work on the fallback feed too.
const parseOdds = (comp) => {
  const o = comp && comp.odds && comp.odds[0]; if (!o) return null;
  const ml = o.moneyline || {};
  const pick = (s) => { const x = ml[s]; const v = x && ((x.close && x.close.odds) || (x.open && x.open.odds)); return v != null ? parseInt(v, 10) : null; };
  const home = pick("home"), away = pick("away");
  if (home == null || away == null) return null;
  const draw = ml.draw ? pick("draw") : (o.drawOdds && o.drawOdds.moneyLine != null ? Number(o.drawOdds.moneyLine) : null);
  return { home, away, draw, total: (typeof o.overUnder === "number") ? o.overUnder : null, book: (o.provider && o.provider.name) || null };
};

/* --- fetch + aggregate ----------------------------------------------------- */
const end = new Date("2026-07-20T00:00:00Z");   // through the final — full schedule for every team
const seen = new Set();
const matches = [];
const unknown = new Set();

// Fetch the whole tournament window in one range call; fall back to per-day if needed.
let events = [];
try {
  const res = await fetch(ESPN + START.replace(/-/g, "") + "-" + ymd(end), { headers: { "User-Agent": "wc2026-tracker" } });
  if (res.ok) events = (await res.json()).events || [];
} catch (e) { console.error("range fetch failed:", e.message); }
if (!events.length) {
  for (const ds of dateRange(START, end)) {
    try {
      const res = await fetch(ESPN + ds, { headers: { "User-Agent": "wc2026-tracker" } });
      if (res.ok) events.push(...((await res.json()).events || []));
    } catch (e) { console.error("fetch failed for", ds, "-", e.message); }
  }
}

for (const ev of events) {
    if (seen.has(ev.id)) continue; seen.add(ev.id);
    const comp = (ev.competitions || [])[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === "home") || cs[0];
    const away = cs.find((c) => c.homeAway === "away") || cs[1];
    if (!home || !away) continue;

    const hName = canon(home.team && home.team.displayName);
    const aName = canon(away.team && away.team.displayName);
    if (!CANON.has(hName)) unknown.add(home.team && home.team.displayName);
    if (!CANON.has(aName)) unknown.add(away.team && away.team.displayName);

    const status = statusOf(ev.status && ev.status.type && ev.status.type.state);
    const cstat = comp.status || ev.status || {};
    const rec = {
      stage: stageOf(stageText(ev, comp), ev.season && ev.season.slug),
      home: hName,
      away: aName,
      homeScore: parseInt(home.score, 10) || 0,
      awayScore: parseInt(away.score, 10) || 0,
      homeWinner: home.winner === true,            // ESPN result flag — correct even on penalties (drives champion detection)
      awayWinner: away.winner === true,
      odds: parseOdds(comp),                       // DraftKings moneyline + total (powers the projections)
      status,
      id: ev.id || null,                           // ESPN event id — for the match-detail view
      date: ev.date || null,                       // kickoff (ISO) — used for past times + upcoming
      venue: (comp.venue && comp.venue.fullName) || ""
    };
    if (status === "live") {                       // live match clock, for the running timer
      rec.clock = (typeof cstat.clock === "number") ? cstat.clock : 0;
      rec.displayClock = cstat.displayClock || "";
      rec.detail = (cstat.type && (cstat.type.shortDetail || cstat.type.detail)) || "";
      rec.period = Number(cstat.period) || 0;        // 1=1st half, 2=2nd half — so the clock can't cross a half early
    }
    matches.push(rec);
}

if (unknown.size) console.error("⚠ UNMAPPED team names (add to ALIASES):", [...unknown].join(" | "));

if (!matches.length) {
  console.error("No matches parsed — leaving existing data/live.json untouched.");
} else {
  const out = { lastUpdated: new Date().toISOString(), source: "ESPN soccer/fifa.world", matches };
  writeFileSync("data/live.json", JSON.stringify(out, null, 2) + "\n");
  const playedList = matches.filter((m) => m.status !== "scheduled");
  console.log(`Wrote data/live.json — ${matches.length} matches (${playedList.length} played/live, ${matches.length - playedList.length} upcoming).`);
  for (const m of playedList) {
    console.log(`  ${m.status.toUpperCase().padEnd(8)} ${m.home} ${m.homeScore}-${m.awayScore} ${m.away}  [${m.stage}]`);
  }
}

/* ---------- World Cup news (ESPN public feed, no key) -> data/news.json ----- */
try {
  const nres = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news",
    { headers: { "User-Agent": "wc2026-tracker" } });
  if (!nres.ok) throw new Error("HTTP " + nres.status);
  const nd = await nres.json();
  const articles = (nd.articles || []).slice(0, 16).map((a) => ({
    headline: (a.headline || a.title || "").trim(),
    description: (a.description || "").trim().slice(0, 220),
    published: a.published || a.lastModified || "",
    link: (a.links && a.links.web && a.links.web.href) || (a.links && a.links.mobile && a.links.mobile.href) || "",
    image: (a.images && a.images[0] && (a.images[0].url || a.images[0].href)) || ""
  })).filter((a) => a.headline);
  if (articles.length) {
    writeFileSync("data/news.json", JSON.stringify({ lastUpdated: new Date().toISOString(), source: "ESPN", articles }, null, 2) + "\n");
    console.log(`Wrote data/news.json — ${articles.length} headlines (top: "${articles[0].headline}").`);
  } else {
    console.error("news: no articles parsed; leaving existing file.");
  }
} catch (e) {
  console.error("news fetch failed (keeping existing data/news.json):", e.message);
}

/* ---------- per-match detail (events, stats, lineups) -> data/details.json --
   Pulled server-side from ESPN's match-summary feed so the page can show it
   same-origin (no browser CORS). Finished matches are cached; only live + new
   finals are re-fetched each run. -------------------------------------------- */
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=";
async function fetchDetail(id, home, away) {
  const res = await fetch(SUMMARY + id, { headers: { "User-Agent": "wc2026-tracker" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  const teams = (d.boxscore && d.boxscore.teams) || [];
  const sideOf = {}, stats = {};
  teams.forEach((t, i) => {
    const side = t.homeAway || (i === 0 ? "home" : "away");
    sideOf[t.team && t.team.id] = side;
    const o = {}; (t.statistics || []).forEach((s) => { o[s.name] = s.displayValue; });
    stats[side] = o;
  });
  const scorerOf = (e) => {
    const a = (e.athletesInvolved && e.athletesInvolved[0]) || null;
    if (!a) return (e.text || "").replace(/\s*\(.*$/, "").trim();   // last resort: strip "(assist…)" from the play text
    return a.displayName || a.shortName || (a.athlete && a.athlete.displayName) || "";
  };
  const events = (d.keyEvents || []).filter((e) => /goal|card|substitution|penalty/i.test((e.type && e.type.text) || "")).map((e) => ({
    kind: (e.type && e.type.text) || "", min: (e.clock && e.clock.displayValue) || "",
    side: sideOf[e.team && e.team.id] || null,
    player: scorerOf(e)
  }));
  const lineups = {}, subs = {}, formation = {};
  (d.rosters || []).forEach((r) => {
    if (!r.homeAway) return;
    formation[r.homeAway] = (r.formation && (r.formation.name || r.formation)) || "";
    const all = r.roster || [];
    const map = (p) => ({
      name: (p.athlete && p.athlete.displayName) || "",
      short: (p.athlete && (p.athlete.shortName || p.athlete.lastName)) || "",
      num: p.jersey || (p.athlete && p.athlete.jersey) || "",
      pos: (p.position && p.position.abbreviation) || "",
      place: (typeof p.formationPlace !== "undefined" ? p.formationPlace : null)
    });
    const starters = all.filter((p) => p.starter);
    lineups[r.homeAway] = (starters.length ? starters : all.slice(0, 11)).map(map).filter((p) => p.name);
    subs[r.homeAway] = all.filter((p) => !p.starter).map(map).filter((p) => p.name);
  });
  // play-by-play commentary (most recent first, capped)
  const commentary = (d.commentary || []).map((c) => ({
    min: (c.time && typeof c.time === "object" ? c.time.displayValue : c.time) || "",
    text: (c.text || "").trim(),
    goal: !!(c.play && (c.play.scoringPlay || /goal/i.test((c.play.type && c.play.type.text) || "")))
  })).filter((c) => c.text).reverse().slice(0, 60);
  // per-player match leaders (Total Shots, Accurate Passes, Defensive Interventions, Saves, …)
  const byCat = {};
  (d.leaders || []).forEach((tl) => {
    const side = sideOf[tl.team && tl.team.id] || null; if (!side) return;
    (tl.leaders || []).forEach((cat) => {
      const label = cat.displayName || cat.shortDisplayName || cat.name || ""; if (!label) return;
      const top = (cat.leaders || [])[0]; if (!top) return;
      byCat[label] = byCat[label] || { label };
      byCat[label][side] = {
        name: (top.athlete && (top.athlete.shortName || top.athlete.displayName)) || "",
        num: (top.athlete && top.athlete.jersey) || "",
        pos: (top.athlete && top.athlete.position && top.athlete.position.abbreviation) || "",
        value: top.displayValue || ""
      };
    });
  });
  const leaders = Object.values(byCat).filter((c) => c.home || c.away);
  // grab the match highlight video — capture a directly-playable source (mp4 preferred, else HLS)
  // so the page can embed and play the actual goals inline (a <video> plays cross-origin without CORS).
  // ESPN lists pressers/interviews alongside the goals reel, so rank for actual goal/highlight footage.
  const pickVid = (vids) => {
    if (!vids || !vids.length) return null;
    const h = (home || "").toLowerCase(), a = (away || "").toLowerCase();
    const rank = (v) => {
      const t = ((v.headline || "") + " " + (v.description || "") + " " + (v.caption || "")).toLowerCase();
      let s = 0;
      if (/\bhighlight|condensed|all the goals|extended|full match|match recap|game recap/.test(t)) s += 6;
      if (/\bgoal/.test(t)) s += 4;
      if (h && a && t.includes(h) && t.includes(a)) s += 2;     // "Brazil vs Morocco …"
      if (/press conf|presser|reaction|react\b|interview|preview|analysis|pre-?match|post-?match|talks|speaks|on the win|on the loss/.test(t)) s -= 6;
      return s;
    };
    return vids.slice().map((v, i) => ({ v, i, s: rank(v) })).sort((x, y) => y.s - x.s || x.i - y.i)[0].v;
  };
  const v0 = pickVid(d.videos);
  let highlight = null;
  if (v0) {
    const src = (v0.links && v0.links.source) || {};
    const mob = (v0.links && v0.links.mobile) || {};
    const cand = [];
    const add = (u) => { if (u && typeof u === "string") cand.push(u); };
    add(src.href); add(src.full && src.full.href); add(src.mezzanine && src.mezzanine.href);
    add(src.HD && src.HD.href); add(mob.progressiveDownload && mob.progressiveDownload.href);
    add(src.HLS && src.HLS.href); add(src.HLS && src.HLS.HD && src.HLS.HD.href);
    add(mob.streaming && mob.streaming.href); add(mob.href);
    const mp4 = cand.find((u) => /\.mp4(\?|$)/i.test(u)) || "";
    const hls = cand.find((u) => /\.m3u8(\?|$)/i.test(u)) || "";
    highlight = {
      thumb: v0.thumbnail || (v0.images && v0.images[0] && (v0.images[0].url || v0.images[0].href)) || "",
      link: (v0.links && ((v0.links.web && v0.links.web.href) || (v0.links.source && v0.links.source.href) || (v0.links.mobile && v0.links.mobile.href))) || "",
      headline: v0.headline || "", mp4, hls
    };
  }
  return { venue: (d.gameInfo && d.gameInfo.venue && d.gameInfo.venue.fullName) || "",
    stats, events, lineups, subs, formation, commentary, leaders, highlight };
}
const DETAIL_VERSION = 5;   // bump when fetchDetail's shape changes → forces a one-time re-fetch of cached finals
let details = {};
try { details = (JSON.parse(readFileSync("data/details.json", "utf8")).games) || {}; } catch (e) { details = {}; }
let dGot = 0;
for (const m of matches.filter((x) => x.id && (x.status === "finished" || x.status === "live"))) {
  // cached final — skip, unless it predates the current detail shape (e.g. playable video sources)
  if (m.status === "finished" && details[m.id] && details[m.id].final && details[m.id].dv === DETAIL_VERSION) continue;
  try { const det = await fetchDetail(m.id, m.home, m.away); det.final = (m.status === "finished"); det.dv = DETAIL_VERSION; details[m.id] = det; dGot++; }
  catch (e) { console.error("detail fail", m.id, e.message); }
}
writeFileSync("data/details.json", JSON.stringify({ lastUpdated: new Date().toISOString(), games: details }, null, 2) + "\n");
console.log(`Wrote data/details.json — ${Object.keys(details).length} games cached (${dGot} fetched this run).`);
