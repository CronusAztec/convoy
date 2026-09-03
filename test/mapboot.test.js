/* Convoy — the map-boot crash handler is reachable (reviewer MEDIUM, mission
   20260903-173653-75d3 cycle 0, "improve" stage after P0a).

   The bug: js/mapview.js's init() used to throw SYNCHRONOUSLY the moment
   MapLibre's CDN <script> hasn't landed (a blocked network, a regional CDN
   block, a flaky mobile connection, an ad/tracker blocker, or an offline OTA
   bundle) — `maplibregl` is an undeclared global in that case, and reading it
   raises a ReferenceError before js/mapview.js ever reaches `return new
   Promise(...)`. js/app.js:32 is `A.mapview.init().then(onOk).catch(onErr)`;
   a .catch() attached to the RETURNED value can never see a throw that
   happened producing that value, so onErr never ran, no toast, no
   A.telemetry.capture(e, 'mapview.init'), and none of the 20+ A.*.init()
   calls after it in js/app.js's boot chain — a black screen with no route off
   the device.

   The fix: js/mapview.js's init() is now a thin wrapper —
     function init() { try { return initMap(); } catch (e) { return Promise.reject(e); } }
   — that converts a synchronous throw into a rejection, so the one handler
   that knows what to do about a dead map actually runs. Checks 1-4 below pin
   that; check 3 reproduces js/app.js's exact .then().catch() shape as the
   regression guard — before the fix this test would throw out of the .then()
   call instead of ever reaching onErr.

   Checks 5-6 cover the paired fix from the same directive (T1.4): js/routing.js
   used to fire `probeTts()` — a GET /api/tts/health round-trip — at MODULE
   PARSE TIME, before DOMContentLoaded. It now waits for the first 'route' bus
   event, which is minutes ahead of any cue a rider could actually hear.

   Run:  node test/mapboot.test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, ROOT } = H;

function bootMapview(withMapLib) {
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  if (withMapLib) {
    // Minimal fake: only the surface js/mapview.js's boot path touches
    // (constructing the map, wiring listeners, one control add). Real
    // rendering is never exercised here — that needs a real browser
    // (test/perf-bench.js --idle with --fetch-maplibre covers that).
    function FakeMap(opts) { this._opts = opts; this._listeners = {}; }
    FakeMap.prototype.setProjection = function () { };
    FakeMap.prototype.addControl = function () { };
    FakeMap.prototype.on = function (evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); return this; };
    FakeMap.prototype.once = function (evt, fn) { this.on(evt, fn); return this; };
    FakeMap.prototype.getZoom = function () { return 13; };
    FakeMap.prototype.getBearing = function () { return 0; };
    FakeMap.prototype.getLayer = function () { return null; };
    global.maplibregl = {
      Map: FakeMap,
      AttributionControl: function () { },
      Marker: function () { },
      Popup: function () { },
      LngLatBounds: function () { }
    };
  } else {
    delete global.maplibregl;
  }
  H.loadModule('js/mapview.js');
  return win.App;
}

function routingChecks() {
  group('routing.js — the TTS probe waits for the first route, not module load');

  const src = fs.readFileSync(path.join(ROOT, 'js', 'routing.js'), 'utf8');
  // A bare `probeTts();` at the top level (module-parse time) used to fire
  // GET /api/tts/health before DOMContentLoaded. It must now only ever be
  // called from inside the 'route' subscriber below.
  const bareCall = /(^|\n)\s*probeTts\(\);/.test(src);
  ok('no parse-time probeTts() call remains in js/routing.js', !bareCall);
  ok('probeTts() is instead called from an A.store.on(\'route\', …) subscriber',
    /A\.store\.on\(\s*['"]route['"]/.test(src) && /probeTts\(\)/.test(src));

  const win = H.installBrowser();
  win.App.config = { base: '' };
  global.Audio = function () { }; // routing.js gates probeTts() on Audio existing
  const fetchCalls = [];
  global.fetch = win.fetch = function (url) {
    fetchCalls.push(String(url));
    return Promise.resolve({ ok: false });
  };
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  H.loadModule('js/routing.js');
  const A = win.App;

  ok('nothing fetched yet at load time', fetchCalls.length === 0, JSON.stringify(fetchCalls));

  A.store.emit('route', { steps: [] });
  const afterFirst = fetchCalls.filter((u) => /\/api\/tts\/health/.test(u)).length;
  ok('the first route event triggers exactly one TTS probe', afterFirst === 1, 'calls=' + JSON.stringify(fetchCalls));

  A.store.emit('route', { steps: [] });
  const afterSecond = fetchCalls.filter((u) => /\/api\/tts\/health/.test(u)).length;
  ok('a second route event does not re-probe', afterSecond === 1, 'calls=' + JSON.stringify(fetchCalls));

  delete global.Audio;
}

(async () => {
  group('mapview.init() — the crash handler js/app.js:63 depends on is reachable');

  // 1 + 2: maplibregl absent — init() returns a rejecting thenable, not a throw.
  const A = bootMapview(false);
  let threw = null, ret;
  try { ret = A.mapview.init(); } catch (e) { threw = e; }
  ok('with maplibregl absent, init() does not throw', threw === null, threw && threw.message);
  ok('...and returns a thenable', !!ret && typeof ret.then === 'function', typeof ret);

  let rejReason = null, resolved = false;
  await (ret && typeof ret.then === 'function'
    ? ret.then(() => { resolved = true; }, (e) => { rejReason = e; })
    : Promise.resolve());
  ok('the returned promise rejects, not resolves', resolved === false, 'resolved=' + resolved);
  ok('...with an Error as the reason', rejReason instanceof Error, String(rejReason));

  // 3: reproduce js/app.js:32-70's exact shape as the regression guard.
  // Before the fix, A.mapview.init() itself threw synchronously, so this
  // whole expression would throw out of the .then() call and onErr would
  // never run — that is precisely the bug (js/app.js's own .catch() never
  // firing). After the fix, onErr runs and onOk does not.
  const A2 = bootMapview(false);
  let onOkRan = false, onErrRan = false, caughtSync = null;
  try {
    await A2.mapview.init().then(function () { onOkRan = true; }).catch(function () { onErrRan = true; });
  } catch (e) { caughtSync = e; }
  ok('regression guard: js/app.js\'s .then().catch() shape does not throw synchronously',
    caughtSync === null, caughtSync && caughtSync.message);
  ok('...and its .catch() (onErr) is the one that runs', onErrRan === true && onOkRan === false,
    'onErrRan=' + onErrRan + ' onOkRan=' + onOkRan);

  // 4: happy path not regressed — with a real (fake) maplibregl, init()
  // still returns a Promise and does not go straight to rejection.
  const A3 = bootMapview(true);
  let threw3 = null, ret3;
  try { ret3 = A3.mapview.init(); } catch (e) { threw3 = e; }
  ok('with maplibregl present, init() still returns a Promise', threw3 === null && !!ret3 && typeof ret3.then === 'function',
    threw3 && threw3.message);

  routingChecks();
  process.exit(H.report());
})().catch((e) => { console.error(e); process.exit(1); });
