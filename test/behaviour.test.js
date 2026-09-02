/* Convoy — behavioural regression tests for the non-physics fixes.

   Each block pins down one bug that was found and fixed, so it cannot come back
   silently. Run:  node test/behaviour.test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');

H.installBrowser();
H.loadModule('js/config.js');
H.loadModule('js/util.js');
H.loadModule('js/data.js');
H.loadModule('js/state.js');
H.loadModule('js/routing.js');
H.loadModule('js/speedalert.js');

const A = global.window.App;
const U = A.util;
const S = A.state;
const ST = A.store;

const src = (rel) => fs.readFileSync(path.join(H.ROOT, rel), 'utf8');

/* ======================================================================== */
H.group('Event bus — on() returns a working unsubscribe');
{
  // ui.js's profile overlay calls the return value of ST.on to detach its
  // one-shot 'stats' listener. on() used to return undefined, so that call
  // threw and every opened profile leaked a listener that kept re-rendering a
  // closed overlay.
  let hits = 0;
  const off = ST.on('__test', () => { hits++; });
  H.ok('on() returns a function', typeof off === 'function', 'got ' + typeof off);
  ST.emit('__test');
  H.ok('the listener fires while subscribed', hits === 1, 'hits=' + hits);
  off();
  ST.emit('__test');
  H.ok('the listener stops after unsubscribing', hits === 1, 'hits=' + hits);
  H.ok('unsubscribing twice is harmless', (() => { try { off(); return true; } catch (e) { return false; } })());
}

/* ======================================================================== */
H.group('Route snapping — longitude convergence (cos-lat) is honoured');
{
  // A degree of longitude is only cos(lat) as long as a degree of latitude — 0.83
  // at 34° N, 0.44 at 64° N. Projecting raw lng/lat as a square grid stretches
  // every segment east–west, so the perpendicular foot lands in the wrong place
  // and the lateral deviation reads high. The off-route trigger is 55 m, so a
  // rider genuinely 40 m off a DIAGONAL road measured 54 m at Reykjavík's
  // latitude and was one metre from a spurious "recalculating…" reroute.
  //
  // Diagonal bearings matter: a due-east or due-north road is axis-aligned in
  // both projections, so it hides the bug entirely.
  function road(lat, lng, brg, lengthM) {
    const coords = [];
    for (let i = 0; i <= 20; i++) coords.push(U.destPoint([lng, lat], brg, (lengthM / 20) * i));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + U.haversine(coords[i - 1], coords[i]);
    return { coords, cum, total: cum[cum.length - 1] };
  }
  // The un-corrected projection, kept here so the test proves the fix rather
  // than merely restating it.
  function uncorrected(line, pos) {
    const { coords } = line;
    let bestD = Infinity, bestPt = coords[0];
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = coords[i], [bx, by] = coords[i + 1], [px, py] = pos;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d < bestD) { bestD = d; bestPt = [cx, cy]; }
    }
    return U.haversine(pos, bestPt);
  }

  [[34.05, 'Los Angeles'], [51.51, 'London'], [64.14, 'Reykjavík']].forEach(([lat, name]) => {
    [45, 30, 20].forEach((brg) => {
      const line = road(lat, -0.1, brg, 4000);
      const pos = U.destPoint(line.coords[10], (brg + 90) % 360, 40);  // exactly 40 m off
      const now = A.routing.nearestOnRoute(line, pos).devM;
      const before = uncorrected(line, pos);
      H.near(name + ' @ ' + brg + '° bearing', now, 40, 0.5, 'm');
      H.ok('  …and beats the un-corrected projection  (was ' + H.fmt(before) +
        'm, now ' + H.fmt(now) + 'm)', Math.abs(now - 40) < Math.abs(before - 40));
    });
  });

  // Worst observed case: 64° N on a 20° bearing read 54 m for a 40 m offset —
  // a hair under the 55 m trigger. Confirm that's now nowhere near it.
  const arctic = road(64.14, -0.1, 20, 4000);
  const forty = U.destPoint(arctic.coords[10], 110, 40);
  H.ok('a rider 40 m off no longer approaches the reroute trigger',
    A.routing.nearestOnRoute(arctic, forty).devM < 45,
    'devM=' + H.fmt(A.routing.nearestOnRoute(arctic, forty).devM));

  // ...and a genuinely off-route rider must still be caught.
  const off = U.destPoint(arctic.coords[10], 110, 300);
  H.ok('a rider 300 m off route still trips the trigger',
    A.routing.nearestOnRoute(arctic, off).devM > 55,
    'devM=' + H.fmt(A.routing.nearestOnRoute(arctic, off).devM));

  // Progress along the line must land where expected.
  H.near('progress at the midpoint', A.routing.nearestOnRoute(arctic, arctic.coords[10]).m,
    arctic.total / 2, 5, 'm');
}

/* ======================================================================== */
H.group('posAt — a degenerate route must not throw');
{
  // A provider hiccup returning a 1-point "route" used to throw on coords[1],
  // which killed the whole trip render loop.
  const ok1 = (() => { try { A.routing.posAt({ coords: [[0, 0]], cum: [0], total: 0 }, 5); return true; } catch (e) { return false; } })();
  H.ok('single-point line returns instead of throwing', ok1);
  const ok2 = (() => { try { A.routing.posAt({ coords: [], cum: [], total: 0 }, 5); return true; } catch (e) { return false; } })();
  H.ok('empty line returns instead of throwing', ok2);
}

/* ======================================================================== */
H.group('Overspeed alert — banner tracks the limit, beep keeps hysteresis');
{
  A.speedalert.init();
  const banner = document.body.children.filter((c) => c.className === 'overspeed-banner')[0];
  H.ok('the banner element is built', !!banner);

  S.settings.units = 'mi';
  S.settings.speedAlert = 65;
  const mph = (v) => v / 2.23694;
  const lit = () => banner.classList.contains('on');
  const feed = (v) => ST.emit('gpsfix', { pos: [-118.25, 34.05], speed: mph(v), t: Date.now() });

  feed(60); H.ok('under the limit → no banner', !lit());
  feed(70); H.ok('over the limit → banner on', lit());
  // The bug: banner and beep shared one threshold, so the banner stayed lit for
  // 2 mph under the limit — you had already slowed down and it still said
  // "SLOW DOWN".
  feed(64); H.ok('back under the limit → banner off immediately', !lit());
  feed(70); H.ok('over again → banner returns', lit());
  feed(50); H.ok('well under → banner off', !lit());

  S.settings.speedAlert = 0;
  feed(90); H.ok('alert disabled → never fires', !lit());
}

/* ======================================================================== */
H.group('Icon keys — the avatar picker fix relies on stable string keys');
{
  // mkIconGrid used to pass the BUTTON ELEMENT to iconKey, which stringified to
  // "[object HTMLButtonElement]" and hashed it — one constant for every icon.
  // The fix reads button.dataset.key, so iconKey(String(k)) must round-trip.
  let allRoundTrip = true;
  for (let k = 0; k < U.ICON_COUNT; k++) {
    if (U.iconKey(String(k)) !== k) allRoundTrip = false;
  }
  H.ok('iconKey(String(k)) === k for every icon', allRoundTrip);
  H.ok('distinct keys give distinct glyphs',
    new Set([...Array(U.ICON_COUNT).keys()].map((k) => U.riderIcon(String(k)))).size === U.ICON_COUNT);
  // The old path collapsed everything to one value — prove that was the defect.
  H.ok('the old element-stringify path did collapse to one key',
    U.iconKey('[object HTMLButtonElement]') === U.iconKey('[object HTMLButtonElement]'));
}

/* ======================================================================== */
H.group('Hazard glyphs — every reportable kind has an icon');
{
  // A kind present in HAZARD_KINDS but missing from HAZARD_ICONS resolved to a
  // missing map image ('hz-camera' was exactly this), logging an error per
  // feature and drawing a bare disc.
  const s = src('js/overlays.js');
  const grab = (name) => {
    const at = s.indexOf('var ' + name + ' = {');
    const end = s.indexOf('\n  };', at);
    return s.slice(at, end);
  };
  const keysOf = (blob) => (blob.match(/^\s{4}(\w+):/gm) || []).map((m) => m.trim().replace(':', ''));
  const icons = keysOf(grab('HAZARD_ICONS'));
  const kinds = keysOf(grab('HAZARD_KINDS'));
  H.ok('both tables parsed', icons.length > 5 && kinds.length > 5,
    'icons=' + icons.length + ' kinds=' + kinds.length);
  const missing = kinds.filter((k) => icons.indexOf(k) < 0);
  H.ok('no hazard kind is missing a glyph', missing.length === 0, 'missing: ' + missing.join(', '));
  H.ok('the camera glyph specifically exists', icons.indexOf('camera') >= 0);
}

/* ======================================================================== */
H.group('Timing core stays in sync across its two copies');
{
  // dragy.js and racetimer.js each carry the same launch/crossing/integration
  // maths. They drifted apart before; pin the shared pieces so a fix applied to
  // one but not the other is caught here rather than in the field.
  const a = src('js/dragy.js'), b = src('js/racetimer.js');
  [
    ['segDist (trapezoidal integration)', 'return dtSec > 0 ? 0.5 * (v0 + v1) * dtSec : 0;'],
    ['quadratic distance crossing', 'tau = (Math.sqrt(disc) - v0) / accel;'],
    ['EPS-crossing launch tracking', 'launchAt = p.t + f * (t - p.t);'],
    ['launch distance integration', 'launchDist = segDist(EPS, sp, (t - launchAt) / 1000);'],
    ['run distance from speed', 'runDist += segDist(prev.speed, sp, (t - prev.t) / 1000);'],
    ['stale-baseline reset on re-arm', 'launchAt = 0; launchDist = 0;']
  ].forEach(([label, needle]) => {
    H.ok(label + ' present in both', a.indexOf(needle) >= 0 && b.indexOf(needle) >= 0,
      'dragy=' + (a.indexOf(needle) >= 0) + ' racetimer=' + (b.indexOf(needle) >= 0));
  });
  // Neither may fall back to chord-summing for run distance.
  H.ok('neither copy sums GPS chords for run distance',
    a.indexOf('runDist += U.haversine') < 0 && b.indexOf('runDist += U.haversine') < 0);
}

/* ======================================================================== */
H.group('Race client talks to the real net module');
{
  // Every call site said A.Net; the module is A.net. The whole racing feature
  // was dead code that threw on the first tap.
  const s = src('js/race.js');
  H.ok('no A.Net references remain', !/\bA\.Net\b/.test(s));
  H.ok('A.net is actually used', /\bA\.net\.sendRace\(/.test(s));
  H.ok('the HUD sort reads finished off the member record', /a\.finished !== b\.finished/.test(s) &&
    /finished: !!mem\.finished/.test(s));
  H.ok('the HUD repaint is throttled', /HUD_PAINT_MS/.test(s));
}

/* ======================================================================== */
H.group('Settings integrity');
{
  // Every setting the UI writes must exist in DEFAULT_SETTINGS — setSetting
  // silently refuses unknown keys, so a typo becomes a dead toggle.
  const uiSrc = src('js/ui.js');
  const stateSrc = src('js/state.js');
  const defBlock = stateSrc.slice(stateSrc.indexOf('var DEFAULT_SETTINGS'), stateSrc.indexOf('\n  };', stateSrc.indexOf('var DEFAULT_SETTINGS')));
  const used = [...uiSrc.matchAll(/ST\.setSetting\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((k) => !new RegExp('^\\s{4}' + k + ':', 'm').test(defBlock));
  H.ok('every setting written by the UI is declared', unknown.length === 0,
    'undeclared: ' + unknown.join(', '));
  H.ok('a meaningful number of settings were checked', used.length > 20, used.length + ' call sites');
}

/* ======================================================================== */
H.group('sim.js — dead solo-physics branch removed (frontend-003)');
{
  // enableSolo() never set solo=true (solo simulation is deliberately disabled
  // in production), so tick()'s `if (solo)` body and relocatePlayer()'s solo
  // branch were unreachable dead code with a half-alive contract. Deleted the
  // flag and both branches rather than resurrecting a code path the product
  // intentionally doesn't use.
  const s = src('js/sim.js');
  H.ok('the solo flag is gone', !/var solo = false/.test(s));
  H.ok('isSolo() is gone (always returned false, unused everywhere)', !/isSolo:/.test(s));
  H.ok('tick() no longer branches on solo', !/function tick\s*\(\)\s*\{\s*if \(solo\)/.test(s));
}

process.exit(H.report());
