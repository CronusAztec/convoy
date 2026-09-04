/* Convoy — test-only preload that lets server/server.js boot on a box with no
   server/.env (Supabase config absent). `node -r test/server-stub.js server/server.js`.

   TEST-ONLY: nothing under server/, js/, scripts/ or deploy/ may require this
   file — it exists to unblock local measurement (test/wire-bench.js), never to
   run the app. It patches the four boot-gate functions server/server.js checks
   during boot() (server/supabase.js's configured/loadJwks/loadSettings/
   forwardsIp) plus server/store.js's init, and nothing else — deliberately
   minimal, so a future server change that needs more stubbing fails loudly
   (an unhandled exception) instead of silently limping along on a stale stub.
   Guest riders (no `token` in their `hello` frame) never touch `store` at all
   (server/server.js:2613 `hello()`, :2066 `blockedPair()`), so this is enough
   to drive the guest wire path end-to-end with zero real database.

   Also wraps global.setInterval, BEFORE server/server.js is required, to
   record per-callback tick durations keyed by the callback source's own
   opening line (not by the requested delay — matching two different intervals
   that both happen to be registered at 1000ms was the mistake in the spike
   this file replaces, see the improve directive for cycle 10). Durations for
   the two frame-sending lanes (TICK_MS=1000 "full sync" and FAST_MS=350
   "fast lane", server/server.js:3343/:3364) are written to the JSON file at
   process.env.CONVOY_BENCH_STATS once a second, if that env var is set. */
'use strict';
const P = require('path').join(__dirname, '..', 'server') + require('path').sep;

const sb = require(P + 'supabase.js');
sb.configured = () => true;
sb.loadJwks = async () => true;
sb.loadSettings = async () => true;
sb.forwardsIp = () => false;

const store = require(P + 'store.js');
store.init = async () => {};

const STATS_PATH = process.env.CONVOY_BENCH_STATS;
if (STATS_PATH) {
  const fs = require('fs');
  // Keyed by a short prefix of the callback's own source, not by delay — two
  // different setInterval calls can share the same delay (they do not here,
  // but the point of keying-by-source is not to depend on that).
  const stats = Object.create(null); // key -> array of ms durations
  const origSetInterval = global.setInterval;
  global.setInterval = function (fn, delay, ...args) {
    const key = (typeof fn === 'function' ? fn.toString() : String(fn)).replace(/\s+/g, ' ').slice(0, 60);
    const wrapped = function () {
      const t0 = process.hrtime.bigint();
      const r = fn.apply(this, arguments);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      (stats[key] || (stats[key] = [])).push(ms);
      return r;
    };
    return origSetInterval.call(this, wrapped, delay, ...args);
  };

  // origSetInterval, not the wrapped global.setInterval — this flush must
  // never itself become a sample in `stats`.
  origSetInterval(() => {
    try { fs.writeFileSync(STATS_PATH, JSON.stringify(stats)); } catch (e) { /* best-effort */ }
  }, 1000);
}
