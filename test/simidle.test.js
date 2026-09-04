/* Convoy — js/sim.js render-loop idle gate (T1.1, mission 20260903-173653-75d3
   cycle 16). `node test/simidle.test.js`.

   frame() used to re-arm requestAnimationFrame unconditionally as its first
   statement, so a parked rider with nobody nearby still cost 60 rAF/s forever
   with nothing on screen to animate — no other timer in the app runs anywhere
   near that rate while idle. Real-phone proof (STATE.md §8 item 5): `adb shell
   dumpsys gfxinfo` on a parked phone should show "Total frames rendered"
   climbing at ~1/s instead of ~60/s once this ships.

   The fix (js/sim.js: idleGateActive/scheduleFrame/kick, around the render
   loop) gates the re-arm on real work being pending (riders present, an
   active trip, party links due, or a player dead-reckoning window in
   flight). Idle, it falls back to a ~1/s heartbeat (RAF_IDLE_MS) instead of
   stopping outright — a deliberate fail-safe so any activation this file
   doesn't explicitly kick() (a trip starting in js/routing.js, say) still
   self-corrects within one heartbeat instead of staying silently stuck.
   kick() is called from the wake set — addRider/removeRider/clearRiders/
   setNext/updateGpsDot/relocatePlayer/externalFix — so the common cases
   (a rider appears, a GPS fix lands) go back to 60fps immediately rather
   than waiting up to a second.

   Two groups:
     A  structural class gate (acorn, same idiom as test/visibility.test.js's
        V4): every requestAnimationFrame( call in js/sim.js lives inside
        scheduleFrame() or kick() — the two sanctioned re-arm sites — so a
        future edit can't reintroduce an unconditional rAF re-arm undetected.
     B  behavioural, against the real module with a fully controlled clock/
        rAF/setTimeout: idle → ~1 rAF/s, the fail-safe heartbeat notices
        trip.active flipping true with no kick() at all, and each wake-set
        function forces an immediate re-arm instead of waiting for the
        heartbeat. */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

/* ---------------- A: structural class gate ---------------- */
group('js/sim.js — every requestAnimationFrame( call site is inside scheduleFrame() or kick(), the two sanctioned re-arm points');
{
  const src = fs.readFileSync(path.join(ROOT, 'js', 'sim.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2020 });

  const sanctioned = ['scheduleFrame', 'kick'];
  const rafCallSites = []; // { enclosingFn, node }
  const fnStack = [];

  // Only NAMED functions push a new attribution frame — an anonymous callback
  // (the setTimeout callback inside scheduleFrame, say) is logically still
  // "inside" its nearest named enclosing function, which is what a reviewer
  // means by "every rAF site lives inside scheduleFrame()/kick()".
  walk.recursive(ast, null, {
    FunctionDeclaration(node, state, c) {
      fnStack.push(node.id ? node.id.name : fnStack[fnStack.length - 1] || '(anon)');
      c(node.body, state);
      fnStack.pop();
    },
    FunctionExpression(node, state, c) {
      if (node.id) { fnStack.push(node.id.name); c(node.body, state); fnStack.pop(); }
      else c(node.body, state); // anonymous: inherit the enclosing named function
    },
    CallExpression(node, state, c) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'requestAnimationFrame') {
        rafCallSites.push({ enclosingFn: fnStack[fnStack.length - 1] || '(top-level)', node: node });
      }
      node.arguments.forEach((a) => c(a, state));
      c(node.callee, state);
    }
  });

  ok('the scan is not silently matching nothing — at least 2 requestAnimationFrame( call sites found',
    rafCallSites.length >= 2, 'found ' + rafCallSites.length);
  const unsanctioned = rafCallSites.filter((s) => sanctioned.indexOf(s.enclosingFn) === -1);
  ok('every requestAnimationFrame( call site is enclosed by scheduleFrame() or kick() — no bypass of the idle gate',
    unsanctioned.length === 0,
    unsanctioned.map((s) => 'in ' + s.enclosingFn + '() at offset ' + s.node.start).join('; '));

  ok('start() no longer calls requestAnimationFrame directly (routes through scheduleFrame(), same gate as every other call site)',
    !/function start\s*\(\)\s*\{[\s\S]{0,400}?requestAnimationFrame\(frame\)/.test(src));
}

/* ---------------- B: behavioural, against the real module ---------------- */
function bootSim() {
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  const A = win.App;
  A.mapview = {
    addNpc() {}, removeNpc() {}, updateNpc() {}, createPlayerMarker() {},
    setPlayer() {}, followPlayer() {}, landIntro() {}, setLinksData() {}, jumpCam() {},
    map() {
      return {
        getCanvasContainer() { return { addEventListener() {} }; },
        getBearing() { return 0; }, getZoom() { return 15; }, getPitch() { return 0; }
      };
    }
  };
  A.net = { sendPosNow() {} };
  A.routing = {
    posAt() { return { pos: [0, 0], brg: 0 }; },
    nearestOnRoute() { return { m: 0, devM: 0 }; },
    updateTripUI() {},
    announceCues() {},
    endTrip() {},
    reroute() {}
  };

  let clock = 0;
  const realNow = global.performance.now;
  global.performance.now = () => clock;

  const realSetInterval = global.setInterval;
  global.setInterval = () => 0; // neuter the 1Hz UI tick — unrelated to this proof

  let rafCalls = 0, rafCb = null;
  const realRaf = global.requestAnimationFrame;
  const realWinRaf = win.requestAnimationFrame;
  const fakeRaf = (fn) => { rafCalls++; rafCb = fn; return rafCalls; };
  global.requestAnimationFrame = fakeRaf;
  win.requestAnimationFrame = fakeRaf; // both — installBrowser sets rAF on win AND as a Node
                                        // global, and js/sim.js calls the bare (Node-global)
                                        // identifier, the same trap cycle 15 hit with
                                        // PerformanceObserver (STATE.md §5 cycle 16 handoff)

  let timeoutCalls = 0, timeoutCb = null, timeoutMs = null;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => { timeoutCalls++; timeoutCb = fn; timeoutMs = ms; return timeoutCalls; };
  global.clearTimeout = () => { timeoutCb = null; };

  H.loadModule('js/sim.js');

  function restore() {
    global.performance.now = realNow;
    global.setInterval = realSetInterval;
    global.requestAnimationFrame = realRaf;
    win.requestAnimationFrame = realWinRaf;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }

  // fireRaf(): invoke the pending rAF callback (as the browser would on the
  // next paint), advancing the fake clock first.
  function fireRaf(now) { clock = now; const cb = rafCb; rafCb = null; if (cb) cb(now); }
  // fireHeartbeat(): invoke the pending idle setTimeout (as if RAF_IDLE_MS elapsed).
  function fireHeartbeat() { const cb = timeoutCb; timeoutCb = null; if (cb) cb(); }

  return {
    A, S: A.state,
    setClock: (t) => { clock = t; },
    rafCalls: () => rafCalls,
    timeoutCalls: () => timeoutCalls,
    timeoutPending: () => timeoutCb !== null,
    timeoutMs: () => timeoutMs,
    rafPending: () => rafCb !== null,
    fireRaf, fireHeartbeat, restore
  };
}

{
  const t = bootSim();
  t.A.sim.start();
  ok('start() on an idle boot (no riders, no trip, no party) schedules the idle heartbeat, not an immediate rAF',
    t.rafCalls() === 0 && t.timeoutPending(), 'rafCalls=' + t.rafCalls() + ' timeoutPending=' + t.timeoutPending());
  ok('the idle heartbeat interval is RAF_IDLE_MS (1000ms) — a real ~1/s cadence, not a disguised 60fps loop',
    t.timeoutMs() === 1000, 'timeoutMs=' + t.timeoutMs());

  // Pump five idle heartbeat cycles (heartbeat fires -> schedules one rAF ->
  // that rAF runs frame() -> frame() finds nothing to do -> re-arms the
  // heartbeat again) and prove the rate stays at exactly one rAF per cycle —
  // this IS the "60 -> <=1 rAF/idle-second" measurement the directive asked for.
  for (let i = 1; i <= 5; i++) {
    t.fireHeartbeat();
    t.fireRaf(i * 1000);
  }
  ok('five idle heartbeat cycles produced exactly 5 rAF calls total — 1/s, not 60/s',
    t.rafCalls() === 5, 'rafCalls=' + t.rafCalls());
  ok('after five idle cycles the loop is back to waiting on the heartbeat, not sitting on a live rAF',
    t.timeoutPending() && !t.rafPending());
  t.restore();
}

{
  const t = bootSim();
  t.A.sim.start();
  t.fireHeartbeat(); // first idle rAF armed
  ok('sanity: exactly one rAF armed before the fail-safe is exercised', t.rafCalls() === 1);

  // Nothing in sim.js's own wake set touched this — simulating some OTHER
  // module (js/routing.js starting a trip) flipping S.trip.active with no
  // kick() at all, to prove the heartbeat is a real fail-safe and not just
  // decoration.
  t.S.trip = { active: true, follow: false, live: false, mult: 1, baseSpeed: 0, progress: 0, line: { total: 1000 } };
  t.fireRaf(1000); // frame() runs, sees trip.active, must re-arm at full rate now
  ok('a trip going active with NO kick() call is still picked up within one heartbeat (fail-safe)',
    t.rafPending() && !t.timeoutPending(), 'rafPending=' + t.rafPending() + ' timeoutPending=' + t.timeoutPending());
  t.fireRaf(1016);
  ok('once active, the loop keeps re-arming rAF directly on every frame (no heartbeat gap while a trip is live)',
    t.rafPending() && !t.timeoutPending());
  t.S.trip.active = false;
  t.restore();
}

{
  const t = bootSim();
  t.A.sim.start();
  t.fireHeartbeat(); // idle rAF armed, not yet run
  t.fireRaf(1000);   // frame() runs once idle, re-arms the heartbeat
  ok('sanity: back on the heartbeat before exercising the wake set', t.timeoutPending() && !t.rafPending());

  // addRider (via remoteAdd) is in the directive's wake set — must force an
  // IMMEDIATE rAF re-arm, not wait up to a second for the next heartbeat tick.
  t.A.sim.remoteAdd({ id: 'n1', name: 'Rival', handle: 'r', emoji: '', vibe: '', car: {}, pos: [0, 0], heading: 0 });
  ok('addRider (A.sim.remoteAdd) kicks the loop back to an immediate rAF, cancelling the pending heartbeat',
    t.rafPending() && !t.timeoutPending());

  t.fireRaf(1050);
  ok('with a rider present, frame() keeps re-arming rAF directly (60fps path), never falls back to the heartbeat',
    t.rafPending() && !t.timeoutPending());

  // removeRider (via remoteRemove), back to zero riders — kick() still forces
  // one more immediate frame (the settle window), then the NEXT frame should
  // find nothing active and, once the kick settle window has elapsed, fall
  // back to the heartbeat again.
  t.A.sim.remoteRemove('n1');
  ok('removeRider (A.sim.remoteRemove) also kicks immediately (part of the same wake set)',
    t.rafPending() && !t.timeoutPending());
  t.fireRaf(1060);           // still inside the 1200ms settle window kick() opened
  ok('immediately after the last rider leaves, the settle window still holds — no visible cut on removal', t.rafPending());
  t.setClock(1060);
  t.fireRaf(3000);           // now well past the settle window, and nothing else is active
  ok('once the settle window has elapsed with no riders left, the loop returns to the idle heartbeat',
    t.timeoutPending() && !t.rafPending());
  t.restore();
}

{
  const t = bootSim();
  t.A.sim.start();
  t.fireHeartbeat();
  t.fireRaf(1000);
  ok('sanity: idle before exercising relocatePlayer/externalFix', t.timeoutPending() && !t.rafPending());

  t.A.sim.relocatePlayer([-122.4, 37.8]);
  ok('relocatePlayer (wake set) kicks the loop back to an immediate rAF', t.rafPending() && !t.timeoutPending());
  t.fireRaf(1010);
  t.setClock(1010);
  t.fireRaf(3000); // past the settle window
  ok('settles back to idle after relocatePlayer\'s settle window elapses', t.timeoutPending() && !t.rafPending());

  t.A.sim.externalFix({ lng: -122.41, lat: 37.79, speed: 0 });
  ok('externalFix (wake set, native background-location bridge) also kicks the loop back immediately',
    t.rafPending() && !t.timeoutPending());
  t.restore();
}

process.exit(report());
