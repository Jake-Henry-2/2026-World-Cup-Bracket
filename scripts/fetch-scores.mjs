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
const stageOf = (slug = "") => {
  slug = slug.toLowerCase();
  if (slug.includes("group")) return "group";
  if (slug.includes("round-of-32") || slug.includes("round of 32")) return "r32";
  if (slug.includes("round-of-16") || slug.includes("round of 16")) return "r16";
  if (slug.includes("quarter")) return "qf";
  if (slug.includes("semi")) return "sf";
  if (slug.includes("third")) return "third";
  if (slug.includes("final")) return "final";
  return "group";
};
const statusOf = (state) => state === "post" ? "finished" : state === "in" ? "live" : "scheduled";

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
      stage: stageOf(ev.season && ev.season.slug),
      home: hName,
      away: aName,
      homeScore: parseInt(home.score, 10) || 0,
      awayScore: parseInt(away.score, 10) || 0,
      status,
      id: ev.id || null,                           // ESPN event id — for the match-detail view
      date: ev.date || null,                       // kickoff (ISO) — used for past times + upcoming
      venue: (comp.venue && comp.venue.fullName) || ""
    };
    if (status === "live") {                       // live match clock, for the running timer
      rec.clock = (typeof cstat.clock === "number") ? cstat.clock : 0;
      rec.displayClock = cstat.displayClock || "";
      rec.detail = (cstat.type && (cstat.type.shortDetail || cstat.type.detail)) || "";
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
async function fetchDetail(id) {
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
  const events = (d.keyEvents || []).filter((e) => /goal|card|substitution|penalty/i.test((e.type && e.type.text) || "")).map((e) => ({
    kind: (e.type && e.type.text) || "", min: (e.clock && e.clock.displayValue) || "",
    side: sideOf[e.team && e.team.id] || null,
    player: (e.athletesInvolved && e.athletesInvolved[0] && e.athletesInvolved[0].displayName) || ""
  }));
  const lineups = {};
  (d.rosters || []).forEach((r) => {
    if (!r.homeAway) return;
    const starters = (r.roster || []).filter((p) => p.starter);
    lineups[r.homeAway] = (starters.length ? starters : (r.roster || []).slice(0, 11)).map((p) => ({
      name: (p.athlete && p.athlete.displayName) || "", pos: (p.position && p.position.abbreviation) || ""
    })).filter((p) => p.name);
  });
  return { venue: (d.gameInfo && d.gameInfo.venue && d.gameInfo.venue.fullName) || "", stats, events, lineups };
}
let details = {};
try { details = (JSON.parse(readFileSync("data/details.json", "utf8")).games) || {}; } catch (e) { details = {}; }
let dGot = 0;
for (const m of matches.filter((x) => x.id && (x.status === "finished" || x.status === "live"))) {
  if (m.status === "finished" && details[m.id] && details[m.id].final) continue;   // cached final — skip
  try { const det = await fetchDetail(m.id); det.final = (m.status === "finished"); details[m.id] = det; dGot++; }
  catch (e) { console.error("detail fail", m.id, e.message); }
}
writeFileSync("data/details.json", JSON.stringify({ lastUpdated: new Date().toISOString(), games: details }, null, 2) + "\n");
console.log(`Wrote data/details.json — ${Object.keys(details).length} games cached (${dGot} fetched this run).`);
