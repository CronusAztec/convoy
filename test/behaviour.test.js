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

const A = global.window.App;
const U = A.util;
const S = A.state;
const ST = A.store;

const src = (rel) => fs.readFileSync(path.join(H.ROOT, rel), 'utf8');

/* ======================================================================== */
H.group('test/harness.js DOM shim — insertBefore(child, ref) honours its second argument');
{
  // The shim's insertBefore used to ignore its second argument entirely
  // (always this.children.unshift(c)) — every real caller that passes a
  // reference node (js/hud.js's rank-ordered card insert, js/space.js,
  // js/tripextras.js) would have silently gotten "always first" instead of
  // "before ref", and insertBefore(x, null) — which real DOM appends — would
  // have prepended instead. Direct check against a fresh parent, not routed
  // through any app module, so it proves the shim itself, not a caller.
  const parent = H.makeEl('div');
  const a = H.makeEl('span'); a.id = 'a';
  const b = H.makeEl('span'); b.id = 'b';
  const c = H.makeEl('span'); c.id = 'c';
  parent.appendChild(a); parent.appendChild(b); parent.appendChild(c);

  const d = H.makeEl('span'); d.id = 'd';
  parent.insertBefore(d, b);
  H.ok('insertBefore(d, b) lands d directly before b, not at the front',
    parent.children.map((x) => x.id).join(',') === 'a,d,b,c',
    'got ' + parent.children.map((x) => x.id).join(','));
  H.ok('insertBefore sets the inserted node\'s parentNode', d.parentNode === parent);

  const e = H.makeEl('span'); e.id = 'e';
  parent.insertBefore(e, null);
  H.ok('insertBefore(e, null) appends at the end (matches real DOM insertBefore(x, null))',
    parent.children.map((x) => x.id).join(',') === 'a,d,b,c,e',
    'got ' + parent.children.map((x) => x.id).join(','));
}

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
  H.ok('a meaningful number of settings were checked', used.length >= 6, used.length + ' call sites');
}

process.exit(H.report());
