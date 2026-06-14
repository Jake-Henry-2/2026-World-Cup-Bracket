/* =============================================================================
   LEAGUE CONFIG — 2026 World Cup Fantasy Draft
   -----------------------------------------------------------------------------
   This is the "rules of your league" file. It rarely changes during the
   tournament. Match SCORES live in data/results.js instead.

   Sourced directly from your spreadsheet (Live Score + Draft Sheet + Rules).
   ========================================================================== */
window.LEAGUE = {
  season: "2026 FIFA World Cup",
  // Money pots, from your sheet (Buy In $25/manager x 10 = $250 main pot)
  pots: { buyIn: 25, main: 250, sidePool: 50 },

  /* -------------------------------------------------------------------------
     MANAGERS — each drafted 4 national teams (snake draft, rounds 1–4).
     Each manager gets a UNIQUE emoji. Whoever is in 1st also gets a 👑 crown
     in the ticker and on the leaderboard.
     ---------------------------------------------------------------------- */
  managers: [
    { name: "Mitch",   emoji: "🦁", teams: ["Argentina", "Croatia", "Iran", "Panama"] },
    { name: "Trea",    emoji: "🐉", teams: ["Brazil", "Uruguay", "South Korea", "Qatar"] },
    { name: "Benny",   emoji: "🦅", teams: ["Portugal", "Egypt", "Canada", "Iraq"] },
    { name: "Andy",    emoji: "🐺", teams: ["England", "Senegal", "Ecuador", "Ghana"] },
    { name: "Jack",    emoji: "🃏", teams: ["Belgium", "Colombia", "Ivory Coast", "Algeria"] },
    { name: "Dom",     emoji: "💎", teams: ["France", "Japan", "Türkiye", "South Africa"] },
    { name: "Ant",     emoji: "🐜", teams: ["Netherlands", "Switzerland", "Australia", "Czechia"] },
    { name: "Francis", emoji: "🔥", teams: ["Spain", "United States", "Sweden", "Bosnia and Herzegovina"] },
    { name: "Hafid",   emoji: "🦊", teams: ["Norway", "Morocco", "Austria", "Scotland"] },
    { name: "Paul",    emoji: "⚡", teams: ["Germany", "Mexico", "Paraguay", "New Zealand"] }
  ],

  /* -------------------------------------------------------------------------
     GROUPS — 48 teams, 12 groups of 4 (official 2026 format).
     ---------------------------------------------------------------------- */
  groups: {
    A: ["Mexico", "South Africa", "South Korea", "Czechia"],
    B: ["Canada", "Switzerland", "Qatar", "Bosnia and Herzegovina"],
    C: ["Brazil", "Morocco", "Haiti", "Scotland"],
    D: ["United States", "Paraguay", "Australia", "Türkiye"],
    E: ["Germany", "Curaçao", "Ivory Coast", "Ecuador"],
    F: ["Netherlands", "Japan", "Tunisia", "Sweden"],
    G: ["Belgium", "Egypt", "Iran", "New Zealand"],
    H: ["Spain", "Cabo Verde", "Saudi Arabia", "Uruguay"],
    I: ["France", "Senegal", "Norway", "Iraq"],
    J: ["Argentina", "Algeria", "Austria", "Jordan"],
    K: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    L: ["England", "Croatia", "Ghana", "Panama"]
  },

  /* -------------------------------------------------------------------------
     THE "REMAINING 8" — the 8 undrafted teams that form the $50 side pool.
     ---------------------------------------------------------------------- */
  remainingEight: ["Haiti", "Curaçao", "Tunisia", "Cabo Verde", "Saudi Arabia", "DR Congo", "Uzbekistan", "Jordan"],

  /* Side-pool picks: each manager called the Top points winner, a Runner-up,
     and one more Team, among the remaining 8. (From your "Remaining 8" block.)
     Only the 5 fully-filled rows from the sheet are encoded; add more here. */
  sidePool: [
    { manager: "Francis", top: "Uzbekistan",   runnerUp: "Tunisia",      team: "Cabo Verde" },
    { manager: "Paul",    top: "Uzbekistan",   runnerUp: "Saudi Arabia", team: "Curaçao" },
    { manager: "Mitch",   top: "Saudi Arabia", runnerUp: "Haiti",        team: "DR Congo" },
    { manager: "Dom",     top: "DR Congo",     runnerUp: "Uzbekistan",   team: "Haiti" },
    { manager: "Andy",    top: "Saudi Arabia", runnerUp: "Uzbekistan",   team: "Jordan" }
  ],

  /* -------------------------------------------------------------------------
     SCORING RULES — from your sheet.
     ---------------------------------------------------------------------- */
  scoring: {
    // Group Match Fixtures (June 11–27)
    group: {
      win: 3,
      draw: 1,
      goalEach: 1,        // 1 point per goal scored
      shutout: 1,         // 1 point for keeping a clean sheet
      groupWinner: 5,     // team finishes 1st in its group
      groupRunnerUp: 3    // team finishes 2nd in its group
    },
    // Round of 32 → Finals (June 28 – July 19)
    knockout: {
      goalEach: 1,
      shutout: 1,
      r16: 1,             // reached Round of 16
      qf: 2,              // reached Quarterfinal
      sf: 4,              // reached Semifinal
      final: 6,           // reached Final
      champion: 8         // won it all
    }
  },

  /* -------------------------------------------------------------------------
     TEAM NAME ALIASES — reconcile spreadsheet typos and live-API variants to
     one canonical name. Keys are lowercase. Extend if a live feed uses other
     spellings.
     ---------------------------------------------------------------------- */
  aliases: {
    "turkey": "Türkiye", "turkiye": "Türkiye", "türkiye": "Türkiye",
    "curacao": "Curaçao", "curaçao": "Curaçao",
    "cape verde": "Cabo Verde", "cabo verde": "Cabo Verde", "capo verde": "Cabo Verde",
    "dr congo": "DR Congo", "congo dr": "DR Congo", "democratic republic of the congo": "DR Congo", "congo": "DR Congo",
    "uzbekistan": "Uzbekistan", "uzbekizstan": "Uzbekistan",
    "algeria": "Algeria", "alegeria": "Algeria",
    "united states": "United States", "usa": "United States", "united states of america": "United States", "us": "United States",
    "south korea": "South Korea", "korea republic": "South Korea", "republic of korea": "South Korea",
    "ivory coast": "Ivory Coast", "côte d'ivoire": "Ivory Coast", "cote d'ivoire": "Ivory Coast",
    "bosnia and herzegovina": "Bosnia and Herzegovina", "bosnia": "Bosnia and Herzegovina",
    "czechia": "Czechia", "czech republic": "Czechia"
  }
};
