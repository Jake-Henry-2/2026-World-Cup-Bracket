/* =============================================================================
   RESULTS — the ONLY file you touch to update scores by hand.
   -----------------------------------------------------------------------------
   You have two ways to keep this live; you can mix both:

   1) QUICK MODE (matches your current habit): just set each team's running
      point total in `manualTeamPoints`. The app sums them into manager
      standings automatically. Easiest for a fast hand-update.

   2) MATCH MODE (preferred / what the live API fills in): add finished or
      in-play matches to `matches`. The app then computes each team's points
      from the actual scoreline AND can award group winner / runner-up bonuses.
      A team that appears in `matches` is computed from those matches and its
      `manualTeamPoints` value is ignored.

   You normally won't edit this file directly during a match — use the
   "Edit scores" button in the app, which saves to your browser and can
   export a fresh copy of this file for you.

   SEED BELOW = the exact state from your spreadsheet on 2026-06-14
   (e.g. "United States - 7" → United States: 7). On first load the
   leaderboard reproduces your sheet: Francis 9, Trea 9, Paul 7, Ant 3,
   Benny 2, Hafid 2, the rest 0.
   ========================================================================== */
window.RESULTS = {
  lastUpdated: "2026-06-14T00:30:00Z",

  // QUICK MODE — manual per-team points fallback.
  // EMPTY ON PURPOSE: the live ESPN feed (data/live.json) is now the source of
  // truth, so the board reflects REAL scores rather than hand-entered values.
  // (Your old sheet seeds lived here; the auto-feed supersedes them.)
  // If you ever want to hand-score with the feed off, fill this in and set
  // config.js live.enabled = false.
  manualTeamPoints: {},

  // MATCH MODE — add real matches here (or let the live API fill them).
  // Shape:
  //   { stage:"group", group:"D", home:"United States", away:"Türkiye",
  //     homeScore:3, awayScore:0, status:"finished" }   // status: scheduled | live | finished
  // For knockout games use stage:"r32" | "r16" | "qf" | "sf" | "final" | "third".
  matches: [],

  // KNOCKOUT PROGRESSION (optional) — furthest round each team reached, used
  // for the knockout appearance bonuses once the bracket starts.
  //   { "Spain":"qf", "France":"final", ... }
  knockout: {}
};
