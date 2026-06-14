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

  live: {
    enabled: false,              // ← flip to true once a feed below is set up

    // "custom"         → your own URL returning { matches:[...] } in this app's format (recommended)
    // "football-data"  → football-data.org v4 (free key; needs a proxy for CORS)
    // "api-football"   → api-sports.io / RapidAPI (key; needs a proxy for CORS)
    provider: "custom",

    apiKey: "",                  // your API key, if the provider needs one

    // Optional CORS proxy. If your feed isn't browser-accessible, deploy a tiny
    // proxy (see README) and put its base URL here; requests get prefixed with it.
    proxyUrl: "",

    // For "custom": the full URL to your JSON feed.
    customUrl: "",

    // For "football-data": competition code for the World Cup.
    competition: "WC"
  }
};
