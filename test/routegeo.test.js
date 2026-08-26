/* Convoy — route geometry tests.

   Drives the REAL js/routing.js through posAt / nearestOnRoute / progressAt.
   Nothing is reimplemented here: a copy of the maths under test would pass
   happily while the shipped code drifted away from it.

   Why these two functions are worth pinning down
   ----------------------------------------------
   Everything a rider sees during a trip is derived from them. nearestOnRoute
   snaps a GPS fix onto the planned line and answers two questions at once —
   how far along the route you are (progress, distance left, ETA, when to speak
   the next turn) and how far off it you are (the 55 m lateral test that decides
   whether to auto-reroute). posAt is the inverse, and drives the preview player
   and the chase camera.

   The failures they produce are quiet ones. A progress error does not throw; it
   just makes the arrival never fire, or the ETA drift, or a turn get announced
   after you have taken it. A deviation error does not throw either; it silently
   re-routes a rider who is driving perfectly straight. Both have happened here
   before, which is why the properties below are written as properties rather
   than as a handful of examples:

     P1  posAt and nearestOnRoute are inverses along the whole line
     P2  a point ON the line has no lateral deviation
     P3  progress is clamped into [0, total] however far off-route the fix is
     P4  posAt's _idx segment cache cannot desync on a backwards seek
     P5  deviation is measured in real metres on an east-west road — the
         cos(lat) projection fix, which is where the spurious reroutes came from
     P6  progress never runs backwards along a forward drive

   Run:  node test/routegeo.test.js
*/
'use strict';
const H = require('./harness');

H.installBrowser();
H.loadModule('js/util.js');
H.loadModule('js/routing.js');

const A = global.window.App;
const U = A.util;
const R = A.routing;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}
function head(s) { console.log('\n\x1b[1m' + s + '\x1b[0m'); }

// Build a line the way routing.js does: cumulative haversine over the vertices,
// with `total` measured on the SAME polyline that progress is measured against.
function lineOf(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + U.haversine(coords[i - 1], coords[i]);
  return { coords: coords, cum: cum, total: cum[cum.length - 1], _idx: 0 };
}

// East, then north, then a diagonal — so the east-west leg (where the projection
// error lived) and an oblique leg are both covered.
const COORDS = [
  [-118.2500, 34.0500], [-118.2400, 34.0500], [-118.2400, 34.0600],
  [-118.2300, 34.0700], [-118.2200, 34.0700]
];

head('route geometry (' + COORDS.length + ' points, ' + lineOf(COORDS).total.toFixed(0) + ' m)');

head('P1 — posAt and nearestOnRoute are inverses');
{
  const line = lineOf(COORDS);
  let worst = 0, worstAt = 0;
  for (let s = 0; s <= 1.0001; s += 0.005) {
    const m = line.total * s;
    const err = Math.abs(R.nearestOnRoute(line, R.posAt(line, m).pos).m - m);
    if (err > worst) { worst = err; worstAt = m; }
  }
  ok('round-trip error under 1 m (worst ' + worst.toFixed(3) + ' m at ' + worstAt.toFixed(0) + ' m)',
    worst < 1, worst);
}

head('P2 — a point on the line has no lateral deviation');
{
  const line = lineOf(COORDS);
  let worst = 0;
  for (let s = 0; s <= 1.0001; s += 0.005) {
    const d = R.nearestOnRoute(line, R.posAt(line, line.total * s).pos).devM;
    if (d > worst) worst = d;
  }
  ok('max deviation under 0.5 m (' + worst.toFixed(4) + ')', worst < 0.5, worst);
}

head('P3 — progress clamps into [0, total] however far off-route');
{
  const line = lineOf(COORDS);
  const wild = [[-118.10, 34.07], [-118.90, 34.05], [-118.22, 35.90], [-118.22, 33.00], [0, 0]];
  const bad = wild.filter((p) => {
    const m = R.nearestOnRoute(line, p).m;
    return !(m >= 0 && m <= line.total + 1e-6);
  });
  ok('all ' + wild.length + ' far-off fixes clamp', bad.length === 0, bad);
}

head('P4 — the _idx segment cache survives a backwards seek');
{
  // posAt caches the segment index and only ever scans FORWARD from it, so a
  // seek back down the line has to reset it. Walking forward first primes the
  // cache high; without the reset this returns a point from the wrong segment.
  const primed = lineOf(COORDS);
  for (let s = 0; s <= 1.0001; s += 0.02) R.posAt(primed, primed.total * s);
  const mid = primed.total * 0.25;
  const cached = R.posAt(primed, mid).pos;
  const fresh = R.posAt(lineOf(COORDS), mid).pos;
  ok('backwards seek matches a fresh line', U.haversine(cached, fresh) < 0.01, { cached, fresh });
}

head('P5 — deviation is real metres on an east-west road');
{
  // Longitude degrees are only cos(lat) as long as latitude degrees. Treating
  // the grid as square read this ~40% high at 34 N and auto-rerouted riders who
  // were driving straight.
  const line = lineOf(COORDS);
  const off = U.destPoint([-118.2450, 34.0500], 0, 60);   // 60 m north of the E-W leg
  const dev = R.nearestOnRoute(line, off).devM;
  ok('60 m offset reads 57-63 m (' + dev.toFixed(1) + ')', dev > 57 && dev < 63, dev);

  // ...and the same offset on a NORTH-SOUTH leg, which the square-grid bug did
  // not affect — so a regression that over-corrects shows up here.
  const off2 = U.destPoint([-118.2400, 34.0550], 90, 60); // 60 m east of the N-S leg
  const dev2 = R.nearestOnRoute(line, off2).devM;
  ok('same on a north-south leg (' + dev2.toFixed(1) + ')', dev2 > 57 && dev2 < 63, dev2);
}

head('P6 — progress never runs backwards on a forward drive');
{
  const line = lineOf(COORDS);
  let prev = -1, worstBack = 0;
  for (let s = 0; s <= 1.0001; s += 0.005) {
    const m = R.progressAt(line, R.posAt(line, line.total * s).pos);
    if (m < prev) worstBack = Math.max(worstBack, prev - m);
    prev = m;
  }
  ok('monotonic within 0.5 m (worst step back ' + worstBack.toFixed(3) + ' m)', worstBack < 0.5, worstBack);
}

head('degenerate lines do not throw');
{
  ok('empty line', R.posAt({ coords: [], cum: [], total: 0 }, 10).pos.length === 2);
  ok('single-point line', R.posAt({ coords: [[0, 0]], cum: [0], total: 0 }, 10).pos.length === 2);
  ok('nearestOnRoute on a single point', R.nearestOnRoute({ coords: [[0, 0]], cum: [0], total: 0 }, [1, 1]).m === 0);
}

console.log('');
if (fail) { console.log('\x1b[31m\x1b[1m' + fail + ' of ' + (pass + fail) + ' checks failed.\x1b[0m'); process.exit(1); }
console.log('\x1b[32m\x1b[1mAll ' + pass + ' checks passed.\x1b[0m');
