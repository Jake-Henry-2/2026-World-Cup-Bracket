/* =============================================================================
   CONFIG — refresh cadence + optional live data feed.
   -----------------------------------------------------------------------------
   The tracker ALWAYS works with manual scores (data/results.js + the in-app
   "Edit scores" button). Turn on `live.enabled` only when you have a feed.

   Why a feed needs a tiny bit of setup: browsers block most sports APIs from
   being called directly from a web page (CORS), and the good ones need a free
   key. See README.md → "Going fully live" for the 3 options. The simplest and
   most reliable is the "custom" provider pointed at a URL that returns JSON in
   this app's own match format.
   ========================================================================== */
window.CONFIG = {
  // How often the board recomputes / re-polls, in seconds.
  refreshSeconds: 60,

  // While any game is LIVE, poll scores this often instead (seconds) so goals/clock update with ~no lag.
  liveRefreshSeconds: 10,

  live: {
    enabled: true,               // ← ON: the page auto-pulls scores, no manual updates

    // "custom" reads data/live.json from this same site. That file is refreshed
    // automatically every ~5 min by .github/workflows/pages.yml, which fetches
    // live scores from ESPN (no API key, no CORS proxy needed). Nothing to maintain.
    provider: "custom",
    customUrl: "data/live.json",

    apiKey: "",                  // not needed for the ESPN/custom setup
    proxyUrl: "",                // not needed (data/live.json is same-origin)
    competition: "WC"            // only used if you switch provider to football-data
  }
};
