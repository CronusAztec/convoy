/* Convoy — visual-only pollers pause while the page is hidden, and one
   coalesced refresh runs on the way back. `npm test` (test/run.js)

   Why this exists: nine timer-owning modules never checked document.hidden
   (BUGS.md frontend-021, measured by the cycle-56 improve stage), so a
   backgrounded app kept fetching aircraft every 8 s and radar / traffic /
   hazards / incidents / NWS every 1.5-5 min, and repainted a clock nobody
   could see. The rider-felt half is the RESUME: coming back to the app showed
   stale layers until each timer happened to fire, up to five minutes later.

   The rule (cycle-58 improve stage §3, a per-timer table read at all 22
   setInterval sites): anything that can produce an audible alert, transmit to
   another rider, or feed the data an audible alert reads keeps a plain
   setInterval while hidden. Only pixels pause. 8 of the 22 sites are pixels;
   the other 14 are POLL_ALLOW in group V4, each with the reason it must keep
   running — a rider backgrounds the app ON PURPOSE while Ghost Mode alerting,
   the scanner audio queue and the position beacon run.

   What this does, in four groups, executed against the REAL modules:
     V1  the eight pause-set timers: the recorded tick does its work while
         visible, ZERO work while hidden, then works again once visible — the
         control that proves the zero was the gate, not the poller's own latch.
     V2  the keep-set timers reachable here (police, Waze, hotspots): hidden,
         they still fetch. These fail the day a future cycle "tidies" the
         safety path into the paused set.
     V3  the coalesced resume through a real document.dispatchEvent: one
         visibilitychange runs each DUE poller exactly once, a not-due poller
         not at all, a second event nothing, an unpolled timer never again.
     V4  the class gate (acorn + acorn-walk, the test/globals.test.js
         toolchain): every setInterval in js/ is the helper itself or an
         allowlisted site whose reason still matches a real call, every
         converted site is U.poll with a U.unpoll partner, and js/util.js
         registers exactly one visibilitychange listener.

   test/harness.js used to stub document.addEventListener as a no-op, so a
   test of a visibilitychange handler passed before the handler existed (the
   cycle-55 failure mode one layer down). It keeps a real registry now, and
   V3 dispatches through it.

   When this fails: a new visual-only setInterval belongs in U.poll(fn, ms) /
   U.unpoll(id); a new timer that alerts, speaks or transmits belongs in
   POLL_ALLOW with a reason a stranger can act on — never both, never neither. */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, ROOT } = H;

const JS_DIR = path.join(ROOT, 'js');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => 'js/' + f);

/* ---------------- boot: util + state + ghost + overlays + clock ----------------
   Timers are recorded, not armed (the test/fetchtimeout.test.js idiom): each
   tick is called by hand with document.hidden flipped around it, and nothing
   keeps the process alive. Date.now is a hand-turned clock because poll()
   stamps every real run and the resume compares against that stamp. */
const win = H.installBrowser();
const armed = [];   // every setInterval(fn, ms) the modules asked for, in order
const cleared = []; // every clearInterval(id)
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
global.setInterval = function (fn, ms) { armed.push({ fn: fn, ms: ms, id: armed.length + 1 }); return armed.length; };
global.clearInterval = function (id) { cleared.push(id); };
const realNow = Date.now, realTimeout = AbortSignal.timeout;
let clock = realNow();
Date.now = () => clock;
AbortSignal.timeout = () => new AbortController().signal; // fetchT's deadline: a signal, no timer

// Transport: records every call, answers at once with a body the layer accepts.
const calls = [];
const BODIES = [
  [/\/api\/aircraft$/, () => ({ aircraft: [{ hex: 'a1', callsign: 'N1', lat: 51.5, lon: -0.1, alt: 900, speed: 80, heading: 90, at: clock }] })],
  [/rainviewer/, () => ({ host: 'https://tilecache.rainviewer.com', radar: { past: [{ path: '/v2/radar/' + clock }] } })],
  [/open-meteo/, () => ({ current: { weather_code: 45, precipitation: 5 } })],
  [/./, () => ({ type: 'FeatureCollection', features: [], elements: [] })]
];
function fakeFetch(url, opts) {
  calls.push({ url: String(url), opts: opts || {} });
  const body = BODIES.find((b) => b[0].test(String(url)))[1]();
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}
global.fetch = fakeFetch;
const n = (re) => calls.filter((c) => re.test(c.url)).length;
const settle = () => new Promise((r) => setTimeout(r, 0)); // one macrotask drains the whole .then chain

// Server capabilities, read at call time by wazeOn() / hotspotsOn() / trafficOn() / incidentsOn().
win.App.config = { base: '', routeCaps: { routing: true, incidents: true, waze: true, hotspots: true } };
// The hotspot legend (built by A.ghost.start()) wires buttons through querySelector().
const realCreate = global.document.createElement;
global.document.createElement = function (tag) { const el = realCreate(tag); el.querySelector = () => realCreate('span'); return el; };

const armedAt = {};
armedAt.load0 = armed.length;
H.loadModule('js/util.js');
H.loadModule('js/state.js');
armedAt.state = armed.length;
H.loadModule('js/ghost.js');
armedAt.ghost = armed.length;
H.loadModule('js/overlays.js');
H.loadModule('js/clock.js');
const A = win.App, S = A.state, U = A.util || {};

/* ---------------- the world the pollers look at ---------------- */
const view = { minLat: 51.4, minLng: -0.2, maxLat: 51.6, maxLng: 0.0 }; // London, a ~22 km box
function pan(dLat, dLng) { view.minLat += dLat; view.maxLat += dLat; view.minLng += dLng; view.maxLng += dLng; }
const effects = { setTiles: {}, setData: {}, aircraft: 0, police: 0, hotspots: 0 };
function source(id) {
  return {
    setTiles() { effects.setTiles[id] = (effects.setTiles[id] || 0) + 1; },
    setData() { effects.setData[id] = (effects.setData[id] || 0) + 1; }
  };
}
const sources = { weather: source('weather'), traffic: source('traffic'), hazards: source('hazards') };
const fakeMap = {
  getLayer: () => ({}),
  getSource: (id) => sources[id] || null,
  setLayoutProperty() {},
  getBounds: () => ({
    getSouthWest: () => ({ lat: view.minLat, lng: view.minLng }), getNorthEast: () => ({ lat: view.maxLat, lng: view.maxLng }),
    getWest: () => view.minLng, getSouth: () => view.minLat, getEast: () => view.maxLng, getNorth: () => view.maxLat
  })
};
A.mapview = {
  map: () => fakeMap,
  setAircraftData() { effects.aircraft++; }, setAircraftTrailData() {},
  setPoliceData() { effects.police++; }, setHotspotData() { effects.hotspots++; }
};
let player = [-0.1, 51.5];
A.sim = { playerPos: () => player.slice() };
// The clock card: a box whose querySelector hands back real elements.
const clkV = H.makeEl('b'), clkS = H.makeEl('i'), box = H.makeEl('div');
box.querySelector = (sel) => (sel === '#clk-v' ? clkV : sel === '#clk-s' ? clkS : null);
A.hud = { card: () => box };

const doc = global.document;
function run(t, hidden) { doc.hidden = !!hidden; if (t) t.fn(); }
function show(fire) { doc.hidden = false; if (fire) doc.dispatchEvent({ type: 'visibilitychange' }); }
const listeners = (type) => (typeof doc._listeners === 'function' ? doc._listeners(type) : []);

(async () => {
  /* ================= boot ================= */
  group('boot — the real modules arm their timers in the harness (recorded, not armed)');
  ok('the harness registers document listeners for real: document.dispatchEvent and document._listeners exist (test/harness.js, cycle 59)',
    typeof doc.dispatchEvent === 'function' && typeof doc._listeners === 'function');
  S.settings.ghost = true; S.settings.ghostPolice = true; S.settings.ghostHotspots = true;
  S.settings.showWeather = true; S.settings.showTraffic = true; S.settings.showHazards = true; S.settings.showClock = true;
  const ghostLoad = armed.slice(armedAt.state, armedAt.ghost).map((a) => a.ms);
  ok('js/ghost.js arms its always-on hotspot / police / Waze pollers at load (300000, 90000, 60000) — the keep set',
    ghostLoad.join(',') === '300000,90000,60000', 'armed at load: ' + ghostLoad.join(','));
  const T = { hotspots: armed[armedAt.state], police: armed[armedAt.state + 1], waze: armed[armedAt.state + 2] };
  let mark = armed.length;
  A.ghost.start();
  T.aircraft = armed[mark];
  await settle(); // the aircraft answer lands → publishAircraft() arms the 200 ms predictor
  T.predict = armed[mark + 1];
  ok('A.ghost.start() arms the 8 s aircraft poll, and the first aircraft answer arms the 200 ms predictor',
    armed.length === mark + 2 && T.aircraft.ms === 8000 && T.predict.ms === 200, 'armed: ' + armed.slice(mark).map((a) => a.ms).join(','));
  mark = armed.length;
  A.overlays.applyAll();
  const ov = armed.slice(mark).map((a) => a.ms);
  ok('A.overlays.applyAll() arms radar, traffic, hazards, incidents, NWS in that order (300000, 90000, 300000, 120000, 300000)',
    ov.join(',') === '300000,90000,300000,120000,300000', 'armed: ' + ov.join(','));
  T.radar = armed[mark]; T.traffic = armed[mark + 1]; T.hazards = armed[mark + 2]; T.incidents = armed[mark + 3]; T.nws = armed[mark + 4];
  mark = armed.length;
  A.clock.init();
  T.clock = armed[mark];
  ok('A.clock.init() arms the 20 s clock render', armed.length === mark + 1 && T.clock && T.clock.ms === 20000, 'armed: ' + armed.slice(mark).map((a) => a.ms).join(','));
  await settle();

  /* ================= V1 — the pause set, executed ================= */
  group('V1 — executed: each pause-set tick works while visible, does ZERO work while hidden, then works again (frontend-021)');
  // `work` counts the tick's observable effect; `prep` makes the poller's own
  // latch let the next call through (the rider moved, the map panned, the text
  // was cleared) — so a zero while hidden can only be the visibility gate.
  const POLLERS = [
    { name: 'js/ghost.js pollAircraft → POST /api/aircraft (8 s)', t: T.aircraft, work: () => n(/\/api\/aircraft$/) },
    { name: 'js/ghost.js predictTick → A.mapview.setAircraftData (200 ms, dead-reckons the dots between polls)', t: T.predict, work: () => effects.aircraft },
    { name: 'js/overlays.js refreshRadar → api.rainviewer.com frame list (5 min)', t: T.radar, work: () => n(/rainviewer/) },
    { name: 'js/overlays.js refreshTraffic → traffic source setTiles (90 s)', t: T.traffic, work: () => effects.setTiles.traffic || 0 },
    { name: 'js/overlays.js pollHazards → api.open-meteo.com (5 min; the rider moved 14 km, past the 8 km gate)', t: T.hazards, work: () => n(/open-meteo/), prep: () => { player = [player[0] + 0.2, player[1]]; } },
    { name: 'js/overlays.js fetchIncidents → POST /api/incidents (2 min; the map panned 0.3°, past the 0.2° gate)', t: T.incidents, work: () => n(/\/api\/incidents$/), prep: () => pan(0.3, 0) },
    { name: 'js/overlays.js fetchNwsAlerts → api.weather.gov (5 min; the map panned 0.6°, past the 0.5° gate)', t: T.nws, work: () => n(/weather\.gov/), prep: () => pan(0.6, 0) },
    { name: 'js/clock.js render → #clk-v textContent (20 s; the text is cleared first)', t: T.clock, work: () => (clkV.textContent ? 1 : 0), prep: () => { clkV.textContent = ''; } }
  ];
  const prep = (p) => { if (p.prep) p.prep(); };
  for (const p of POLLERS) {
    if (!p.t) { ok(p.name + ': timer recorded', false, 'no timer'); continue; }
    prep(p); let before = p.work(); run(p.t, false); const visible = p.work() - before;
    prep(p); before = p.work(); run(p.t, true); const hidden = p.work() - before;
    prep(p); before = p.work(); run(p.t, false); const again = p.work() - before;
    ok(p.name + ' — visible: the tick does its work once', visible === 1, 'work=' + visible);
    ok(p.name + ' — hidden: the same tick does ZERO work, and works again once visible (so the zero was the gate, not the latch)',
      hidden === 0 && again === 1, 'hidden work=' + hidden + ' visible-again work=' + again);
  }
  await settle();

  /* ================= V2 — the carve-outs, executed ================= */
  group('V2 — executed: the keep set still runs while hidden (the reasons are the point — see POLL_ALLOW)');
  pan(0.7, 0); // past the police layer's 0.6° centre-move gate and Waze's 0.15°
  clock += 300000; // past the hotspot / Waze freshness gates
  const keep = [
    { name: 'hidden: fetchPolice still runs — Ghost Mode enforcement alerting is why a rider backgrounds the app with the location service on', t: T.police, work: () => n(/\/api\/overpass$/) },
    { name: 'hidden: fetchWaze still runs — live police sightings are the same alerting family', t: T.waze, work: () => n(/\/api\/waze$/) },
    { name: 'hidden: fetchHotspots still runs — the police-probability layer, one request per 5 min to our own server', t: T.hotspots, work: () => n(/\/api\/hotspots$/) }
  ];
  for (const k of keep) {
    const before = k.work(); run(k.t, true); const d = k.work() - before;
    ok(k.name, d === 1, 'hidden work=' + d + (k.t ? '' : ' (timer not recorded)'));
  }
  await settle();

  /* ================= V3 — the coalesced resume ================= */
  group('V3 — the coalesced resume: one visibilitychange runs each DUE poller exactly once, never a storm');
  ok('js/util.js registers exactly one document visibilitychange listener — one for all pollers, not one per poll()',
    listeners('visibilitychange').length === 1, 'listeners: ' + listeners('visibilitychange').length);
  const snap = () => POLLERS.map((p) => p.work());
  const delta = (a, b) => POLLERS.map((p, i) => b[i] - a[i]);
  // Every pause-set tick just ran visible: each poller's last-run stamp is "now".
  POLLERS.forEach((p) => { prep(p); run(p.t, false); });
  await settle();
  // Five minutes in a pocket, riding: every latch would let a fresh request through.
  doc.hidden = true; clock += 301000; POLLERS.forEach(prep);
  let before = snap();
  const keepBefore = keep.map((k) => k.work()), armedBefore = armed.length;
  show(true);
  let d = delta(before, snap());
  POLLERS.forEach((p, i) => ok('resume after 5 min hidden: ' + p.name.replace(/ \(.*$/, '') + ' ran exactly once', d[i] === 1, 'runs=' + d[i]));
  ok('the resume touched nothing in the keep set (police / Waze / hotspot counts unchanged) and armed no new timer',
    keep.every((k, i) => k.work() === keepBefore[i]) && armed.length === armedBefore, 'keep deltas=' + keep.map((k, i) => k.work() - keepBefore[i]).join(',') + ' armed ' + armedBefore + '→' + armed.length);
  before = snap(); show(true); d = delta(before, snap());
  ok('a second visibilitychange straight after fires nothing — every poller was just stamped', d.every((x) => x === 0), 'runs=' + d.join(','));
  // Not due: a glance at another app, 100 ms — below even the 200 ms predictor. Blanket resume would fire all eight here.
  POLLERS.forEach((p) => { prep(p); run(p.t, false); });
  await settle();
  doc.hidden = true; clock += 100; POLLERS.forEach(prep);
  before = snap(); show(true); d = delta(before, snap());
  ok('not due: 100 ms hidden → the visibilitychange fires NOTHING (due-only resume, no request storm when flicking between apps)', d.every((x) => x === 0), 'runs=' + d.join(','));
  // An event while still hidden (some engines fire one on the way out) is ignored.
  clock += 301000; POLLERS.forEach(prep);
  before = snap(); doc.hidden = true; doc.dispatchEvent({ type: 'visibilitychange' }); d = delta(before, snap());
  ok('a visibilitychange while still hidden fires nothing — the listener only acts on the way back', d.every((x) => x === 0), 'runs=' + d.join(','));
  show(false);
  await settle();
  // The helper's own contract, with synthetic pollers: exact counts, unpoll.
  ok('A.util.poll and A.util.unpoll are functions', typeof U.poll === 'function' && typeof U.unpoll === 'function', 'A.util keys: ' + Object.keys(U).join(','));
  if (typeof U.poll === 'function' && typeof U.unpoll === 'function') {
    let a = 0, b = 0;
    const idA = U.poll(() => { a++; }, 1000), idB = U.poll(() => { b++; }, 60000);
    const wa = armed[armed.length - 2], wb = armed[armed.length - 1];
    ok('poll(fn, ms) arms setInterval(wrapper, ms) and returns ITS id, so clearInterval bookkeeping at a call site is unchanged',
      wa && wb && wa.ms === 1000 && wb.ms === 60000 && idA === wa.id && idB === wb.id, 'ids ' + idA + '/' + idB + ' vs ' + (wa && wa.id) + '/' + (wb && wb.id));
    run(wa, true); const hiddenRuns = a; run(wa, false);
    ok('the wrapper reads document.hidden at TICK time — hidden: skipped, visible: runs (a cached flag would fail here)', hiddenRuns === 0 && a === 1, 'a=' + a + ' after hidden=' + hiddenRuns);
    run(wb, false);
    doc.hidden = true; clock += 5000; show(true);
    ok('due only: 5 s hidden → the 1 s poller ran once on resume, the 60 s poller not at all', a === 2 && b === 1, 'a=' + a + ' b=' + b);
    U.unpoll(idA);
    doc.hidden = true; clock += 600000; show(true);
    ok('unpoll(id) clears the interval AND drops the poller from the resume list: 10 min later the resume runs b, never a', cleared.indexOf(idA) >= 0 && a === 2 && b === 2, 'cleared=' + cleared.indexOf(idA) + ' a=' + a + ' b=' + b);
    U.unpoll(idB);
    ok('unpoll returns null, the value every call site stores back into its timer variable', U.unpoll(idB) === null);
  }

  /* ================= V4 — the class gate ================= */
  group('V4 — class gate: every setInterval in js/ is the helper itself or an allowlisted timer that alerts, transmits or feeds an alert');
  // The §3.2 table of the cycle-58 improve directive, machine-checked. `fn` is
  // the identifier passed to setInterval, or a call inside the inline function
  // that identifies it (word-bounded, so `tick` never matches predictTick).
  // Anti-rot both ways: every entry must still match a real bare site, and
  // every bare site must be matched by exactly one entry.
  const POLL_ALLOW = {
    'js/ghost.js': [
      { fn: 'fetchPolice', why: 'Ghost Mode enforcement alerting: a rider backgrounds the app ON PURPOSE while the foreground location service runs — the carve-out BUGS.md frontend-021 names' },
      { fn: 'fetchWaze', why: 'live Waze police sightings: the same alerting family as fetchPolice' },
      { fn: 'fetchHotspots', why: 'police-probability layer, same family; one request per 5 min to our own server' }
    ],
    'js/scanners.js': [{ fn: 'pollCalls', why: 'feeds the audio queue: js/scanners.js playNext() runs when the poll adds calls — paused, scanner audio dies after the current call, screen off' }],
    'js/radar.js': [{ fn: 'tick', why: 'drives updateSonar() (audible pings / heartbeat) and the alert stack; no network at all' }],
    'js/race.js': [{ fn: 'sendRace', why: 'transmits race fixes to peers at 10 Hz; its own comment: an unbounded gap back-dates a peer\'s t0 across the whole pause' }],
    'js/net.js': [{ fn: 'sendPos', why: 'your position to your convoy, 1 Hz — the product' }],
    'js/voice.js': [
      { fn: 'shouldTransmit', why: 'the 33 ms mic gate flips micTrack.enabled; paused, push-to-talk never opens the mic with the screen off' },
      { fn: 'reconcile', why: 'proximity-voice membership: riders drift in and out of range while you ride' }
    ],
    'js/ui.js': [{ fn: 'pollClose', why: 'self-clearing overlay-close detector (250 ms); paused, it leaks the stats listener it exists to detach' }],
    'js/state.js': [{ fn: 'applyTheme', why: 'sun-synced theme, 60 s: two comparisons, no network, no paint — pausing buys nothing' }],
    'js/space.js': [{ fn: 'refreshNight', why: 'already visibility-aware: returns unless `active`, and the rAF loop stops on its own visibilitychange listener' }],
    'js/sim.js': [
      { fn: 'tick', why: 'start(): the solo physics tick — paused and re-armed by its own visibilitychange listener' },
      { fn: 'tick', why: 'that visibilitychange listener re-arming the physics tick on return' }
    ]
  };
  // The pause set, by file: every U.poll() call must be here, and every count must hold.
  const POLL_SITES = { 'js/ghost.js': 2, 'js/overlays.js': 5, 'js/clock.js': 1 };
  const bare = [], helperSites = [], pollCalls = {}, unpollCalls = {}, parseErrors = [];
  let visListeners = 0, visInsidePoll = 0;
  const propName = (c, name) => c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === name;
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); } catch (e) { parseErrors.push(rel + ': ' + e.message); continue; }
    walk.ancestor(ast, {
      CallExpression(node, _s, ancestors) {
        const c = node.callee;
        const inPoll = ancestors.some((a) => a.type === 'FunctionDeclaration' && a.id && a.id.name === 'poll');
        if ((c.type === 'Identifier' && c.name === 'setInterval') || propName(c, 'setInterval')) {
          const a0 = node.arguments[0];
          const site = { key: rel + ':' + node.loc.start.line, file: rel, line: node.loc.start.line, arg: a0 ? src.slice(a0.start, a0.end) : '' };
          if (inPoll && rel === 'js/util.js') helperSites.push(site); else bare.push(site);
        } else if (propName(c, 'poll') && (c.object.type === 'Identifier' || propName(c.object, 'util'))) {
          pollCalls[rel] = (pollCalls[rel] || 0) + 1;                      // U.poll(...) or A.util.poll(...)
        } else if (propName(c, 'unpoll')) {
          unpollCalls[rel] = (unpollCalls[rel] || 0) + 1;
        } else if (propName(c, 'addEventListener') && rel === 'js/util.js' && node.arguments[0] && node.arguments[0].type === 'Literal' && node.arguments[0].value === 'visibilitychange') {
          visListeners++; if (inPoll) visInsidePoll++;
        }
      }
    });
  }
  const violations = [], stale = [];
  const byFile = {};
  for (const s of bare) (byFile[s.file] = byFile[s.file] || []).push(s);
  const allowFiles = Object.keys(POLL_ALLOW);
  for (const file of new Set(allowFiles.concat(Object.keys(byFile)))) {
    const entries = (POLL_ALLOW[file] || []).slice();
    for (const s of byFile[file] || []) {
      const i = entries.findIndex((e) => new RegExp('\\b' + e.fn + '\\b').test(s.arg));
      if (i >= 0) entries.splice(i, 1); else violations.push(s.key + ' (' + s.arg.replace(/\s+/g, ' ').slice(0, 40) + ')');
    }
    entries.forEach((e) => stale.push(file + ' fn=' + e.fn));
  }
  const allowCount = allowFiles.reduce((t, f) => t + POLL_ALLOW[f].length, 0);
  const pollTotal = Object.keys(pollCalls).reduce((t, f) => t + pollCalls[f], 0);
  const unpollTotal = Object.keys(unpollCalls).reduce((t, f) => t + unpollCalls[f], 0);
  console.log('    setInterval sites: ' + (bare.length + helperSites.length) + ' | the helper: ' + helperSites.length + ' | allowlisted: ' + (bare.length - violations.length) +
    ' | violations: ' + violations.length + ' | U.poll() calls: ' + pollTotal + ' | U.unpoll() calls: ' + unpollTotal);
  ok('every js/*.js parses (' + jsFiles.length + ' files) and the scan is real: >= 15 setInterval sites found (' + (bare.length + helperSites.length) + ')',
    parseErrors.length === 0 && bare.length + helperSites.length >= 15, parseErrors.join('; '));
  ok('exactly one setInterval lives inside a function named poll, and it is in js/util.js — the single place a visual poller may arm a timer',
    helperSites.length === 1 && helperSites[0].file === 'js/util.js', 'helper sites: ' + helperSites.map((s) => s.key).join(', ') || 'none');
  ok('every other setInterval is allowlisted with a reason that still matches its call — 0 violations (' + violations.length + ' found)',
    violations.length === 0, 'convert to U.poll(fn, ms) or add to POLL_ALLOW with a reason: ' + violations.join('  '));
  ok('anti-rot: every POLL_ALLOW entry still names a real bare setInterval (an entry that stops matching must be removed, not kept)',
    stale.length === 0, 'stale: ' + stale.join(', '));
  ok('the allowlist is the §3.2 table: exactly 14 entries across 10 files (a 15th needs the reason written here, not a quiet addition)',
    allowCount === 14 && allowFiles.length === 10, allowCount + ' entries / ' + allowFiles.length + ' files');
  const pollFiles = Object.keys(pollCalls).sort();
  const wrongCounts = Object.keys(POLL_SITES).filter((f) => (pollCalls[f] || 0) !== POLL_SITES[f]);
  const newFiles = pollFiles.filter((f) => !(f in POLL_SITES));
  ok('the pause set is exactly the eight U.poll() sites of frontend-021: js/ghost.js 2, js/overlays.js 5, js/clock.js 1 (' + pollTotal + ' found)',
    pollTotal === 8 && wrongCounts.length === 0 && newFiles.length === 0,
    'counts: ' + JSON.stringify(pollCalls) + (newFiles.length ? ' — new pause-set file(s), add to POLL_SITES with why they are pixels-only: ' + newFiles.join(', ') : ''));
  ok('every U.poll() has a U.unpoll() partner in the same file (8 unpoll calls: the clearInterval bookkeeping of the eight sites)',
    unpollTotal === 8 && Object.keys(POLL_SITES).every((f) => (unpollCalls[f] || 0) === POLL_SITES[f]), 'unpoll counts: ' + JSON.stringify(unpollCalls));
  ok('js/util.js registers exactly one visibilitychange listener, outside poll() (one resume loop, not one per poller)',
    visListeners === 1 && visInsidePoll === 0, 'listeners in util.js: ' + visListeners + ' (inside poll: ' + visInsidePoll + ')');
  const utilSrc = fs.readFileSync(path.join(ROOT, 'js', 'util.js'), 'utf8');
  const pollAt = utilSrc.indexOf('function poll(');
  const pollCtx = pollAt >= 0 ? utilSrc.slice(Math.max(0, pollAt - 900), pollAt + 500) : '';
  ok('the reasoning lives at the helper, not only here: the comment around `function poll(` in js/util.js names frontend-021, the allowlist suite and the due-only resume',
    pollAt >= 0 && /frontend-021/.test(pollCtx) && /visibility\.test\.js/.test(pollCtx) && /due/.test(pollCtx), 'found at ' + pollAt);

  global.setInterval = realSetInterval; global.clearInterval = realClearInterval;
  Date.now = realNow; AbortSignal.timeout = realTimeout;
  process.exit(H.report());
})().catch((e) => { console.error(e); process.exit(1); });
