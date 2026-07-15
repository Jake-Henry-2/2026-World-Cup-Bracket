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

  // PRESEASON RANK (1-10) from your sheet — FIFA-strength of each 4-team roster.
  preseasonRank: { Andy: 1, Trea: 2, Jack: 3, Mitch: 4, Dom: 5, Hafid: 6, Ant: 7, Francis: 8, Paul: 9, Benny: 10 },

  /* -------------------------------------------------------------------------
     MANAGERS — KNOCKOUT REDRAFT: each manager drafted 3 teams for the Round of
     32 → Final phase. Everyone restarts at 0; only knockout games score.
     Each manager keeps their UNIQUE emoji; 1st place gets a 👑 crown.
     ---------------------------------------------------------------------- */
  managers: [
    { name: "Mitch",   emoji: "🦁", teams: ["Argentina", "Belgium", "Australia"] },
    { name: "Trea",    emoji: "🐉", teams: ["Brazil", "United States", "Paraguay"] },
    { name: "Benny",   emoji: "🦅", teams: ["Portugal", "Morocco", "Ghana"] },
    { name: "Andy",    emoji: "🐺", teams: ["England", "Senegal", "Austria"] },
    { name: "Jack",    emoji: "🃏", teams: ["Colombia", "Egypt", "Cabo Verde"] },
    { name: "Dom",     emoji: "💎", teams: ["France", "Croatia", "Mexico"] },
    { name: "Ant",     emoji: "🐜", teams: ["Netherlands", "Switzerland", "Algeria"] },
    { name: "Francis", emoji: "💣", teams: ["Spain", "Ecuador", "Sweden"] },
    { name: "Hafid",   emoji: "🦊", teams: ["Norway", "Japan", "Bosnia and Herzegovina"] },
    { name: "Paul",    emoji: "⚡", teams: ["Germany", "Ivory Coast", "Canada"] }
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

  /* The $50 side pool was retired for the knockout phase — no more group pools. */
  remainingEight: [],
  sidePool: [],

  /* -------------------------------------------------------------------------
     SCORING RULES — from your sheet.
     ---------------------------------------------------------------------- */
  scoring: {
    // Group stage no longer scores — the knockout redraft reset everyone to 0.
    group: { win: 0, draw: 0, goalEach: 0, shutout: 0, groupWinner: 0, groupRunnerUp: 0 },
    // Round of 32 → Final. Per knockout game: Win +1, each Goal +1, Shutout +1.
    // Appearance bonuses are CUMULATIVE — a team banks each round's points as it advances
    // (summed in app.js): so a champion earns 1 + 2 + 4 + 6 + 8 = 21 from appearances alone.
    knockout: {
      win: 1, thirdWin: 3,             // win a knockout match (incl. on penalties)
      goalEach: 1,        // 1 point per goal scored
      shutout: 1,         // 1 point for a clean sheet
      r16: 1,             // reaching the Round of 16
      qf: 2,              // reaching the Quarterfinal
      sf: 4,              // reaching the Semifinal
      final: 6,           // reaching the Final
      champion: 8         // winning it all
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
    "bosnia and herzegovina": "Bosnia and Herzegovina", "bosnia & herzegovina": "Bosnia and Herzegovina", "bosnia-herzegovina": "Bosnia and Herzegovina", "bosnia": "Bosnia and Herzegovina",
    "czechia": "Czechia", "czech republic": "Czechia",
    "cape verde islands": "Cabo Verde", "iran": "Iran", "ir iran": "Iran"
  }
};
