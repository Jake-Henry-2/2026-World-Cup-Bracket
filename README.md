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

## Live scores are fully automatic ✅

You don't update anything. Here's the pipeline:

1. **`.github/workflows/pages.yml`** runs on a **5-minute schedule** (and on every
   push). It runs **`scripts/fetch-scores.mjs`**, which pulls live 2026 World Cup
   scores from **ESPN's public scoreboard** (`soccer/fifa.world`) — **no API key,
   no CORS proxy** — and writes **`data/live.json`**.
2. The same workflow **redeploys the site** with that fresh data.
3. The page reads `data/live.json` from its own domain (same-origin, so no CORS)
   and **re-checks every 60 seconds**, so open tabs update on their own.

Net effect: scores refresh server-side every ~5 minutes and every viewer sees it
within a minute — hands-off. The header shows `● LIVE feed` when it's flowing, or
`⚠ feed error` if ESPN ever hiccups (the workflow's `continue-on-error` keeps the
last good board live in that case).

**Want tighter than 5 minutes?** GitHub's scheduler floor is ~5 min. True 60-second
server-side polling needs an always-on host (e.g. a small Cloudflare Worker / Fly.io
app on a cron) writing the same `data/live.json` — a paid/always-on upgrade. Say the
word and I'll set it up.

**Switch off auto / go manual:** set `live.enabled = false` in `config.js`; then the
in-app **✎ Edit scores** button drives the board again.

**Team-name mismatches:** if ESPN ever spells a team differently than the draft, the
fetch script logs it as `⚠ UNMAPPED` in the Actions log — add the spelling to
`ALIASES` in `scripts/fetch-scores.mjs` (and `data/league.js`).

---

## How scoring works (from your rules sheet)

**Group stage (Jun 11–27):** Win **3** · Draw **1** · each Goal **1** ·
Shutout **1** · team wins its group **+5** · group runner-up **+3**.
A manager's score = the sum of their **4** teams' points.

**Points are awarded only when a game goes _final_** (matching the league
spreadsheet's "as games end" rule). A match in progress shows in the **Games
Played** panel marked 🔴 live, but it does not move the standings until it ends.
The Games Played panel is the running log of every completed match.

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
