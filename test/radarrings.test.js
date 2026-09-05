/* Convoy — radar range-ring push guard (T1.7 remainder, mission
   20260903-173653-75d3 cycle 21). `node test/radarrings.test.js`.

   tick() (js/radar.js, runs every TICK_MS=700ms while the radar HUD is
   active) used to rebuild the 3-ring, ~195-point range-ring GeoJSON
   FeatureCollection and push it into MapLibre unconditionally, every tick,
   whether or not the rider had moved a metre — 195 destPoint() trig calls
   plus a full source setData()/re-tessellate, 1.43 times a second, forever,
   even parked.

   The fix (js/radar.js: lastRingSig/ringSig()/pushRings(), around ringFC())
   gates the push on a signature of the two real inputs (distance unit +
   player position, 5-decimal ~1.1m precision) actually changing.

   Two groups, same shape as test/simidle.test.js's T1.1 proof:
     A  structural class gate (acorn): every setRingsData( call site in
        js/radar.js lives inside pushRings() or setActive() — the two
        sanctioned pushers — so a future edit can't reintroduce an
        unconditional push undetected.
     B  behavioural, against the real module with a controlled setInterval:
        parked → exactly one push per activation, not one per tick; moving →
        one more push; jitter (<1m) → no extra push; re-engage (off then on
        from the same spot) → pushed again (the lastRingSig-reset guard). */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

/* ---------------- A: structural class gate ---------------- */
group('js/radar.js — every setRingsData( call site is inside pushRings() or setActive(), the two sanctioned range-ring pushers');
{
  const src = fs.readFileSync(path.join(ROOT, 'js', 'radar.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2020 });

  const sanctioned = ['pushRings', 'setActive'];
  const callSites = []; // { enclosingFn, node }
  const fnStack = [];

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
      if (node.callee.type === 'MemberExpression' && node.callee.property &&
          node.callee.property.type === 'Identifier' && node.callee.property.name === 'setRingsData') {
        callSites.push({ enclosingFn: fnStack[fnStack.length - 1] || '(top-level)', node: node });
      }
      node.arguments.forEach((a) => c(a, state));
      c(node.callee, state);
    }
  });

  ok('the scan is not silently matching nothing — at least 2 setRingsData( call sites found',
    callSites.length >= 2, 'found ' + callSites.length);
  const unsanctioned = callSites.filter((s) => sanctioned.indexOf(s.enclosingFn) === -1);
  ok('every setRingsData( call site is enclosed by pushRings() or setActive() — no bypass of the ring-push guard',
    unsanctioned.length === 0,
    unsanctioned.map((s) => 'in ' + s.enclosingFn + '() at offset ' + s.node.start).join('; '));
}

/* ---------------- B: behavioural, against the real module ---------------- */
function bootRadar() {
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  const A = win.App;

  let ringsCalls = 0, lastFc = null;
  A.mapview = {
    setRingsData(fc) { ringsCalls++; lastFc = fc; },
    setRingsVisible() {},
    map() { return null; },
    getGhostData() { return { aircraft: { features: [] }, police: { features: [] } }; }
  };
  let pos = [-122.4194, 37.7749];
  A.sim = { playerPos: () => pos, playerHeading: () => 0 };

  // radar.js calls the bare `setInterval`/`clearInterval` identifiers, which
  // resolve through Node's global scope (loadModule runs the source via
  // `new Function(src).call(win)`, not a real closure over `win`) — same
  // trap test/simidle.test.js's bootSim() neuters for js/sim.js.
  let intervalFn = null;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn) => { intervalFn = fn; return 1; };
  global.clearInterval = () => { intervalFn = null; };

  H.loadModule('js/radar.js');

  function restore() {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }

  return {
    A,
    setPos: (c) => { pos = c; },
    fireTick: () => { if (intervalFn) intervalFn(); },
    ringsCalls: () => ringsCalls,
    lastFc: () => lastFc,
    restore
  };
}

{
  const t = bootRadar();
  t.A.radar.setActive(true); // this alone calls tick() once directly (the immediate render-on-engage)
  ok('activating the radar pushes the rings exactly once (the immediate on-engage render)',
    t.ringsCalls() === 1, 'ringsCalls=' + t.ringsCalls());

  // Drive the interval through 43 ticks (30s / TICK_MS=700ms) at the SAME
  // position — this is the cycle's headline before/after: 43 -> 1 pushes.
  for (let i = 0; i < 43; i++) t.fireTick();
  ok('43 ticks (30s) parked at the same spot produce ZERO additional pushes — total stays at 1, not 44',
    t.ringsCalls() === 1, 'ringsCalls=' + t.ringsCalls());
  t.restore();
}

{
  const t = bootRadar();
  t.A.radar.setActive(true);
  ok('sanity: one push on activation', t.ringsCalls() === 1);

  // ~10m move (0.0001 deg lat ≈ 11m) — real movement, must push again.
  t.setPos([-122.4194, 37.77500]);
  t.fireTick();
  ok('moving ~10m triggers exactly one additional ring push',
    t.ringsCalls() === 2, 'ringsCalls=' + t.ringsCalls());

  // Sub-metre GPS jitter (< 0.00001 deg ≈ 1.1m at 5dp) — must NOT push.
  t.setPos([-122.41940003, 37.77500004]);
  t.fireTick();
  ok('sub-metre GPS jitter (< 5-decimal precision) does not trigger a push',
    t.ringsCalls() === 2, 'ringsCalls=' + t.ringsCalls());
  t.restore();
}

{
  const t = bootRadar();
  t.A.radar.setActive(true);
  ok('sanity: one push on first activation', t.ringsCalls() === 1);

  // Regression guard for the lastRingSig reset: turning the radar off then
  // back on FROM THE SAME SPOT must still push (setActive(false) pushes an
  // empty FeatureCollection and must reset the signature, or the on-engage
  // tick sees an unchanged sig and silently skips the render).
  t.A.radar.setActive(false);
  const callsAfterOff = t.ringsCalls();
  ok('deactivating pushes the empty FeatureCollection (one more call)',
    callsAfterOff === 2, 'ringsCalls=' + callsAfterOff);
  ok('the deactivation push is an empty FeatureCollection',
    t.lastFc() && Array.isArray(t.lastFc().features) && t.lastFc().features.length === 0,
    JSON.stringify(t.lastFc()));

  t.A.radar.setActive(true);
  ok('re-engaging from the SAME position still pushes real rings (lastRingSig was reset on deactivate)',
    t.ringsCalls() === callsAfterOff + 1, 'ringsCalls=' + t.ringsCalls());
  ok('the re-engage push is a real (non-empty) FeatureCollection',
    t.lastFc() && t.lastFc().features.length > 0, JSON.stringify(t.lastFc()));
  t.restore();
}

process.exit(report());
