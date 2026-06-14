# 2026 World Cup — Live Fantasy Tracker ⚽

An interactive, broadcast-style scoreboard for your World Cup draft league. It
turns match scores into points, ranks all 10 managers **1st → last**, runs a
**NYSE-style scrolling ticker** across the top with the current leader (and a
unique emoji per manager), and **refreshes every 60 seconds**.

It replaces the manual "change every cell" workflow: you update **one** number
(or let a live feed do it) and everything — team points, manager totals, ranks,
group winner/runner-up bonuses, the side pool, the money pots, and the ticker —
recalculates instantly.

> Open `index.html` to see it: a live ticker across the top, the manager
> standings on the left, money pots and the side pool on the right, and all
> 12 group tables below.

---

## Quick start

**Just open it.** Double-click `index.html` (or drag it into any browser).
No install, no server. It loads with your spreadsheet's current standings
already in place (Francis 9, Trea 9, Paul 7, Ant 3, Benny 2, Hafid 2, rest 0).

**Share it with the league (free):** push this folder to GitHub and turn on
**Settings → Pages → Deploy from branch**. Everyone gets a live URL on their
phone. (This repo is already set up — just enable Pages.)

---

## Updating scores

Click **✎ Edit scores** (top-right). Two ways, mix freely:

| Mode | When to use | What it does |
|------|-------------|--------------|
| **Quick points** | Fastest hand-update, just like your old sheet | Type each team's running point total. Everything re-totals. |
| **Match entry** | You want it computed for you | Enter a final/in-play score (e.g. USA 3–0 Türkiye). The app applies Win 3 / Draw 1 / Goal 1 / Shutout 1, and once all 6 of a group's games are in, it awards the **+5 group winner** and **+3 runner-up** bonuses automatically. |

Edits save to **your browser** immediately. To make them permanent for everyone,
click **Export results.js** and drop the downloaded file into `data/`, then
commit. **Reset to file** discards browser edits and reloads `data/results.js`.

---

## Going fully live (auto-pull every 60s)

The tracker already re-renders every 60s. To have it *pull scores from the
internet* on that cycle, open `config.js` and set `live.enabled = true`, then
pick one of three feeds. (Browsers block most sports APIs from being called
directly — "CORS" — so options B and C usually need a tiny proxy.)

**A. Custom JSON feed — most reliable.** Point it at any URL that returns
matches in this app's own shape. You control CORS, so no proxy needed.
```js
live: { enabled:true, provider:"custom",
        customUrl:"https://your-host.com/wc.json" }
```
The JSON should look like:
```json
{ "matches": [
  { "stage":"group", "group":"D", "home":"United States", "away":"Türkiye",
    "homeScore":3, "awayScore":0, "status":"finished" }
] }
```
`status` is `scheduled` | `live` | `finished`. Knockout `stage`s:
`r32`, `r16`, `qf`, `sf`, `final`, `third`.

**B. football-data.org** (free key). Set `provider:"football-data"`, your
`apiKey`, and a `proxyUrl` (below). World Cup competition code is `WC`.

**C. API-Football / api-sports.io** (key). Set `provider:"api-football"`,
your `apiKey`, and a `proxyUrl`.

### Tiny CORS proxy (for B and C)
Deploy this free Cloudflare Worker and put its URL in `proxyUrl`:
```js
export default {
  async fetch(req) {
    const target = new URL(req.url).search.slice(1);          // ?<encoded url>
    const r = await fetch(decodeURIComponent(target), { headers: req.headers });
    const res = new Response(r.body, r);
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  }
};
```

If a feed ever fails, the tracker **silently falls back to your manual scores** —
it never goes blank. The header shows `● LIVE feed`, `✎ manual mode`, or a
`⚠ feed error` notice so you always know which is driving the board.

---

## How scoring works (from your rules sheet)

**Group stage (Jun 11–27):** Win **3** · Draw **1** · each Goal **1** ·
Shutout **1** · team wins its group **+5** · group runner-up **+3**.
A manager's score = the sum of their **4** teams' points.

**Knockout, Round of 32 → Final (Jun 28 – Jul 19):** each Goal **1** ·
Shutout **1** · reach R16 **+1** · QF **+2** · SF **+4** · Final **+6** ·
Champion **+8**. (Appearance bonus = the furthest round a team reaches.)

**Side pool ($50):** the 8 undrafted teams (Haiti, Curaçao, Tunisia, Cabo Verde,
Saudi Arabia, DR Congo, Uzbekistan, Jordan). Managers called the top points
winner / runner-up; the panel shows who's projected to win it.

**Pots:** $25 buy-in × 10 = **$250** main pot (group stage); separate **$50**
remaining-8 pool. Winner takes the pot, runner-up gets their buy-in back.

---

## Files

```
index.html        the page
config.js          refresh interval + optional live feed
data/league.js     YOUR LEAGUE: managers, drafts, groups, side bets, scoring, emojis
data/results.js    THE SCORES: seeded from your sheet; the only file scores live in
assets/app.js      engine (scoring, ranking, movement, ticker) + UI
assets/styles.css  theme
```

Everything is plain HTML/CSS/JS — no build step, no dependencies.

### Manager emojis
🦁 Mitch · 🐉 Trea · 🦅 Benny · 🐺 Andy · 🃏 Jack · 💎 Dom · 🐜 Ant ·
🔥 Francis · 🦊 Hafid · ⚡ Paul — and whoever's in 1st also wears the 👑.
