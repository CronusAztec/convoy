/* Convoy — js/tripmeter.js / gmeter.js / weathernow.js / battery.js / coords.js /
   destarrow.js / speedalert.js / dimmer.js off the boot path. `node test/lazyinstruments.test.js`.

   Mission 20260903-173653-75d3 cycle 13 (directive task 3): the eight default-off
   HUD instrument modules (js/state.js:41-49 all ship false/0) are no longer
   <script>-tagged in index.html; js/app.js's LAZY_INSTRUMENTS table +
   wakeInstrument()/wakeLazyInstruments() load each one via A.lazy.<key>
   (js/config.js) the moment its setting is truthy — at boot for a rider who
   already turned one on, or the first time A.store.setSetting() flips it on
   mid-session. js/hud.js's card() gained a rank table so a card that loads
   late still lands in its fixed rail position (guardrail 6: visual identity).

   app.js otherwise exports nothing onto A (it is boot-time side effects wired
   through DOMContentLoaded/load listeners that need a live map/socket/GPS to
   run safely) — A.appBoot = { LAZY_INSTRUMENTS, wakeInstrument,
   wakeLazyInstruments } is a test-only seam added in the same commit so this
   suite can drive the real mechanism instead of a hand-written mirror of it.

   Run:  node test/lazyinstruments.test.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------------- boot a fresh window with config+util+state+hud+app loaded,
   script injection intercepted (same shape as test/lazydata.test.js's (c)/(d)
   groups) so a "load" can be driven under test control instead of hitting a
   real network. Returns {win, A, injected, stampFor}. ---------------- */
function bootAppBoot() {
  const win = H.installBrowser();
  win.document.head = H.makeEl('head');
  const m = html.match(/config\.js(\?v=cy\d+)/);
  const stamp = m ? m[1] : '?v=cyMISSING';
  const cfgTag = H.makeEl('script');
  cfgTag.src = 'js/config.js' + stamp;
  win.document.head.appendChild(cfgTag);
  win.document.querySelector = function (sel) {
    return sel === 'script[src*="config.js?v="]' ? cfgTag : null;
  };
  const injected = [];
  win.document.createElement = function (tag) {
    const n = H.makeEl(tag);
    if (tag === 'script') injected.push(n);
    return n;
  };
  H.loadModule('js/config.js');
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  H.loadModule('js/hud.js');
  H.loadModule('js/app.js');
  return { win, A: win.App, injected, stamp };
}

// Simulate the real file finishing its network fetch: eval the real module
// source (so A.<mod> is the real object with the real init()), THEN wrap
// init() with a call-counting spy before yielding — the wrap must land before
// A.lazy's .then(m => m.init()) microtask runs, which it does because eval +
// wrap are both synchronous and el.onload() is what unblocks that microtask.
function resolveInjectedScript(win, el, modKey) {
  H.loadModule('js/' + modKey + '.js'); // executes against global.window, which installBrowser() set to `win`
  const mod = win.App[modKey];
  let calls = 0;
  const realInit = mod.init;
  mod.init = function () { calls++; return realInit.apply(this, arguments); };
  if (el.onload) el.onload();
  return { calls: () => calls };
}

const PAIRS = [
  ['showTripmeter', 'tripmeter'], ['showGforce', 'gmeter'], ['showWeatherNow', 'weathernow'],
  ['showBattery', 'battery'], ['showCoords', 'coords'], ['showDestArrow', 'destarrow'],
  ['speedAlert', 'speedalert'], ['nightDim', 'dimmer']
];

/* ---------------- (1) committed defaults are falsy, read off the real
   js/state.js (not hardcoded here) ---------------- */
group('js/state.js — the eight lazy instruments\' settings all default falsy');
{
  const { A } = bootAppBoot();
  PAIRS.forEach(function (p) {
    ok('DEFAULT_SETTINGS.' + p[0] + ' is falsy (measured "' + A.state.settings[p[0]] + '")',
      !A.state.settings[p[0]]);
  });
}

/* ---------------- (2) index.html carries no <script> tag for any of the eight ---------------- */
group('index.html — the eight lazy instruments are off the boot path');
{
  PAIRS.forEach(function (p) {
    const re = new RegExp('<script[^>]*src="js/' + p[1] + '\\.js[^"]*"');
    ok('no <script src="js/' + p[1] + '.js…"> tag remains', !re.test(html));
    ok('js/' + p[1] + '.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
      fs.existsSync(path.join(ROOT, 'js', p[1] + '.js')));
  });
}

/* ---------------- (3) A.lazy.<key> exists and is a function for all eight ---------------- */
group('js/config.js — A.lazy.<key> is a function for all eight instruments');
{
  const { A } = bootAppBoot();
  PAIRS.forEach(function (p) {
    ok('A.lazy.' + p[1] + ' is a function', typeof A.lazy[p[1]] === 'function');
  });
}

/* ---------------- (4) boot with all defaults -> zero injected <script>s, A.<mod> undefined ---------------- */
group('js/app.js wakeLazyInstruments() — with every setting at its (falsy) default, nothing is fetched');
{
  const { A, injected } = bootAppBoot();
  A.appBoot.wakeLazyInstruments();
  ok('zero <script> elements injected for the eight lazy instruments at default boot',
    injected.length === 0, 'injected ' + injected.length);
  PAIRS.forEach(function (p) {
    ok('A.' + p[1] + ' is undefined (module never fetched)', A[p[1]] === undefined);
  });
}

/* ---------------- (5) flip one setting on via the REAL A.store.setSetting() ----------------
   exactly one <script> injected, its src carries the live ?v= stamp, and
   after the stub "loads", init() runs exactly once. Flip off/on/off/on again:
   still one injection total, still one init() call total (wokenInstruments
   guard in js/app.js is unconditional once a key has been woken). */
async function checkSettingFlipWakesOnce() {
  group('js/app.js wakeLazyInstruments() — A.store.setSetting() wakes a module exactly once, idempotent across further toggles');
  const { win, A, injected, stamp } = bootAppBoot();
  A.appBoot.wakeLazyInstruments();
  ok('sanity: zero injected before the flip', injected.length === 0);

  A.store.setSetting('showBattery', true);
  ok('exactly one <script> injected after flipping showBattery on', injected.length === 1,
    'injected ' + injected.length);
  const src = injected[0] && injected[0].src;
  ok('injected src is js/battery.js' + stamp + ' (measured "' + src + '")', src === 'js/battery.js' + stamp);

  const spy = resolveInjectedScript(win, injected[0], 'battery');
  await H.sleep(10);
  ok('A.battery.init() called exactly once after the script "loads"', spy.calls() === 1,
    'calls=' + spy.calls());

  A.store.setSetting('showBattery', false);
  A.store.setSetting('showBattery', true);
  A.store.setSetting('showBattery', false);
  A.store.setSetting('showBattery', true);
  ok('still exactly one <script> injected after off/on/off/on', injected.length === 1,
    'injected ' + injected.length);
  ok('still exactly one init() call after off/on/off/on', spy.calls() === 1,
    'calls=' + spy.calls());
}

/* ---------------- task 4 (stretch): js/tripextras.js wakes on the first
   'route'/'trip' bus event, not a boolean setting, and only once. ---------------- */
async function checkTripextrasWakesOnFirstRouteOrTrip() {
  group('js/app.js wakeTripextrasOnFirstRouteOrTrip() — loads js/tripextras.js on the first route/trip event, only once');
  const tripextrasTagRe = /<script[^>]*src="js\/tripextras\.js[^"]*"/;
  ok('no <script src="js/tripextras.js…"> tag remains in index.html', !tripextrasTagRe.test(html));
  ok('js/tripextras.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
    fs.existsSync(path.join(ROOT, 'js', 'tripextras.js')));

  const { win, A, injected, stamp } = bootAppBoot();
  ok('A.lazy.tripextras is a function', typeof A.lazy.tripextras === 'function');

  A.appBoot.wakeTripextrasOnFirstRouteOrTrip();
  ok('zero <script> elements injected before any route/trip event', injected.length === 0);

  A.state.route = { label: 'Test Dest', dest: [0, 0], distance: 1000, duration: 600 };
  A.store.emit('route', A.state.route);
  ok('exactly one <script> injected after the first "route" event', injected.length === 1,
    'injected ' + injected.length);
  const src = injected[0] && injected[0].src;
  ok('injected src is js/tripextras.js' + stamp + ' (measured "' + src + '")', src === 'js/tripextras.js' + stamp);

  const spy = resolveInjectedScript(win, injected[0], 'tripextras');
  await H.sleep(10);
  ok('A.tripextras.init() called exactly once after the script "loads" (its own trailing refresh() catches the eta-card up, not a second init call)',
    spy.calls() === 1, 'calls=' + spy.calls());

  A.store.emit('trip', A.state.trip);
  A.store.emit('route', A.state.route);
  ok('still exactly one <script> injected after further route/trip events (wake-once, both listeners unsubscribed)',
    injected.length === 1, 'injected ' + injected.length);
}

/* ---------------- (6) js/hud.js card() — rank-ordered insert ---------------- */
async function checkHudRankOrder() {
  group('js/hud.js card() — cards insert by rank regardless of enable order (guardrail 6: fixed rail position)');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  win.eval(fs.readFileSync(path.join(ROOT, 'js', 'util.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'js', 'hud.js'), 'utf8'));
  const A = win.App;

  // Enabled out of rank order: coords, then clock, then battery.
  const coords = A.hud.card('hud-coords');
  const clock = A.hud.card('hud-clock');
  const battery = A.hud.card('hud-battery');
  const rail = win.document.getElementById('hud-rail');
  ok('three cards landed in the rail', !!rail && rail.children.length === 3,
    'rail children: ' + (rail ? rail.children.length : 'none'));
  ok('DOM order is clock, battery, coords (rank order), not coords, clock, battery (enable order)',
    !!rail && rail.children[0] === clock && rail.children[1] === battery && rail.children[2] === coords);

  const unknown = A.hud.card('hud-mystery');
  ok('an unranked token still appends to the end (back-compat)', rail.children[rail.children.length - 1] === unknown);
}

/* ---------------- (7) no silent drift: every LAZY_INSTRUMENTS entry names a
   real module file AND a real js/state.js default-settings key ---------------- */
group('js/app.js LAZY_INSTRUMENTS — every entry names a real module file and a real settings key');
{
  const { A } = bootAppBoot();
  const table = A.appBoot.LAZY_INSTRUMENTS;
  ok('LAZY_INSTRUMENTS has all eight known entries', table.length === PAIRS.length,
    'found ' + table.length);
  table.forEach(function (pair) {
    const settingKey = pair[0], modKey = pair[1];
    ok('js/' + modKey + '.js exists on disk', fs.existsSync(path.join(ROOT, 'js', modKey + '.js')));
    ok('"' + settingKey + '" exists in js/state.js\'s DEFAULT_SETTINGS',
      Object.prototype.hasOwnProperty.call(A.state.settings, settingKey));
  });
}

(async function runAsyncGroupsInSequence() {
  await checkSettingFlipWakesOnce();
  await checkTripextrasWakesOnFirstRouteOrTrip();
  await checkHudRankOrder();
  process.exit(report());
})();
