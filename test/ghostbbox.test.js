/* Convoy — the box ghost.js is willing to ask an upstream about (js/ghost.js clampBBox).

   Every feed in ghost.js — aircraft, police/enforcement POIs (Overpass), live
   Waze sightings, police hotspots — starts with `viewBBox()`: take the map's
   bounds, clamp them to a limit, query that. Cycle 51 (2026-09-03) read the
   production log and found that five of the seven Overpass failures since the
   mission began were for boxes with longitude exactly -2 … 2: the intro globe
   wraps the whole world, the bounds clamp to -180..180, the centre is 0, and
   `centre ± 2` is a 4° box in the Gulf of Guinea that nobody was looking at.
   Each of those failures backed the rider's REAL police layer off for up to
   15 minutes (BUGS.md frontend-019).

   The clamp is now a pure function, `A.ghost.clampBBox(rawBounds, lim)`, and
   it returns null — "skip this tick", which every caller already handles —
   when the view is wider than WIDE_VIEW_FACTOR (4) times the limit. These
   checks pin the rejection, the exact production signature it kills, and the
   band below the threshold that must NOT change.

   Run:  node test/ghostbbox.test.js
*/
'use strict';
const path = require('path');
const H = require('./harness');
const { group, ok } = H;

// Boot the module the way test/riderarrows.test.js does: the harness shim, then
// the two modules ghost.js reads at load, then ghost.js itself. No map is
// installed, so its load-time fetches all stop at `if (!bb) return`.
function boot() {
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  H.loadModule('js/ghost.js');
  return win.App;
}

const A = boot();
const clamp = A.ghost && A.ghost.clampBBox;
const c = (b, lim) => (typeof clamp === 'function' ? clamp(b, lim) : undefined);
const LIM = 4;              // MAX_BBOX_DEG in js/ghost.js — the external feeds' clamp
const HOT = 80;             // what fetchHotspots passes
const WORLD = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
const span = (b) => (b ? (b.maxLat - b.minLat).toFixed(3) + '°×' + (b.maxLng - b.minLng).toFixed(3) + '°' : String(b));
const show = (b) => JSON.stringify(b);

group('The clamp is a pure, exported function');
ok('A.ghost.clampBBox exists', typeof clamp === 'function', 'A.ghost keys: ' + Object.keys(A.ghost || {}).join(','));

group('A view nobody is looking at is not queried (the production bug)');
{
  const r = c(WORLD, LIM);
  ok('the world-wrapped intro view at the 4° clamp → null', r === null, 'got ' + show(r));
  ok('and at the hotspots\' 80° clamp → null', c(WORLD, HOT) === null, 'got ' + show(c(WORLD, HOT)));

  // The signature the fix kills, computed the way viewBBox() used to: clamp the
  // wrapped bounds to ±180, centre them, take centre ± lim/2. That is lng -2..2
  // at any latitude — the production lines read 12.47,-2,16.47,2 and friends.
  // Computed inline on purpose: the removed code is not called.
  const minLng = Math.max(-180, WORLD.minLng), maxLng = Math.min(180, WORLD.maxLng);
  const cLng = (minLng + maxLng) / 2;
  const oldBox = { minLng: cLng - LIM / 2, maxLng: cLng + LIM / 2 };
  ok('that view is what used to produce the logged lng -2 … 2 box', oldBox.minLng === -2 && oldBox.maxLng === 2, show(oldBox));

  // MapLibre reports a wrapped world with longitudes past ±180 as well.
  const wrapped = { minLat: -85, minLng: -540, maxLat: 85, maxLng: 540 };
  ok('an over-wrapped view (lng -540..540) is also null', c(wrapped, LIM) === null, 'got ' + show(c(wrapped, LIM)));
}

group('Everything a rider can actually see keeps today\'s behaviour');
{
  // A whole-region view, 12° across. Wide, but a person is looking at it.
  const region = { minLat: 30, minLng: -10, maxLat: 42, maxLng: 2 };
  const r = c(region, LIM);
  ok('a 12° regional view still returns a box', !!r, show(r));
  ok('…clamped to exactly 4° around the centre (no regression)',
    !!r && Math.abs((r.maxLat - r.minLat) - LIM) < 1e-9 && Math.abs((r.maxLng - r.minLng) - LIM) < 1e-9 &&
    Math.abs((r.minLat + r.maxLat) / 2 - 36) < 1e-9 && Math.abs((r.minLng + r.maxLng) / 2 - (-4)) < 1e-9,
    span(r) + ' ' + show(r));
  ok('and the server accepts what the client will send',
    !!r && !!require(path.join(H.ROOT, 'server', 'overpass.js')).parseBbox(r), show(r));

  // The threshold is WIDE_VIEW_FACTOR × lim = 16°.
  const atLimit = { minLat: 20, minLng: 20, maxLat: 36, maxLng: 36 };
  ok('exactly 16° (the threshold) is still accepted', !!c(atLimit, LIM), show(c(atLimit, LIM)));
  const over = { minLat: 20, minLng: 20, maxLat: 36.1, maxLng: 36 };
  ok('16.1° is refused', c(over, LIM) === null, show(c(over, LIM)));

  // Street level: nothing to clamp, values preserved.
  const street = { minLat: 51.5, minLng: -0.13, maxLat: 51.52, maxLng: -0.11 };
  const s = c(street, LIM);
  ok('a street-level view passes through unchanged',
    !!s && s.minLat === 51.5 && s.minLng === -0.13 && s.maxLat === 51.52 && s.maxLng === -0.11, show(s));

  // Hotspots: a country-sized view is wanted as-is; only the wrap is refused.
  const country = { minLat: 25, minLng: -125, maxLat: 50, maxLng: -65 };
  const h = c(country, HOT);
  ok('a 60° country view at the 80° clamp is returned unclamped', !!h && h.minLng === -125 && h.maxLng === -65, show(h));
}

group('Blow-ups on one axis and degenerate bounds are refused, not queried');
{
  ok('lat span 40° with lng span 2° → null', c({ minLat: 0, minLng: 10, maxLat: 40, maxLng: 12 }, LIM) === null,
    show(c({ minLat: 0, minLng: 10, maxLat: 40, maxLng: 12 }, LIM)));
  ok('lng span 40° with lat span 2° → null', c({ minLat: 10, minLng: 0, maxLat: 12, maxLng: 40 }, LIM) === null,
    show(c({ minLat: 10, minLng: 0, maxLat: 12, maxLng: 40 }, LIM)));
  ok('minLat === maxLat → null, not a zero-area box', c({ minLat: 10, minLng: 10, maxLat: 10, maxLng: 11 }, LIM) === null,
    show(c({ minLat: 10, minLng: 10, maxLat: 10, maxLng: 11 }, LIM)));
  ok('inverted bounds → null', c({ minLat: 12, minLng: 10, maxLat: 10, maxLng: 11 }, LIM) === null);
  ok('a NaN corner → null', c({ minLat: NaN, minLng: 10, maxLat: 12, maxLng: 11 }, LIM) === null);
  ok('no bounds at all → null', c(null, LIM) === null && c(undefined, LIM) === null);
}

// ghost.js arms its always-on police/hotspot timers at load; without this the
// process never exits and `npm test` hangs on this suite with no output.
process.exit(H.report());
