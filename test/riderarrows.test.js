/* Convoy — convoy rider edge-arrow tests (js/riderarrows.js).

   These arrows are the answer to "where is everyone" when the convoy is too
   spread out for mapview.fitRiders() to frame — it refuses below a minimum zoom
   rather than showing a continent where no rider is distinguishable, and these
   take over from there.

   Properties pinned:

     P1  a rider who is on screen gets NO arrow (the map already shows them)
     P2  an off-screen rider gets exactly one, clamped inside the padded viewport
     P3  the arrow points along the true screen-space direction to that rider
     P4  padding keeps arrows clear of the top bar and the HUD rail
     P5  arrows appear and disappear with the convoy and with the setting

   Run:  node test/riderarrows.test.js
*/
'use strict';
const H = require('./harness');
const { group, ok } = H;

const W = 800, HGT = 600;

/* A map stand-in. project() is a plain linear lng/lat -> pixel mapping centred
   on the view, which is all the arrow maths reads. */
function fakeMap(center, scale) {
  return {
    _c: center, _s: scale || 1000,
    getCanvas() { return { clientWidth: W, clientHeight: HGT }; },
    project(ll) {
      return {
        x: W / 2 + (ll[0] - this._c[0]) * this._s,
        y: HGT / 2 - (ll[1] - this._c[1]) * this._s
      };
    },
    on() {}
  };
}

function boot() {
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  const A = win.App;

  // The shim's document returns null from getElementById and cannot append to a
  // real tree, so give the module a body that actually collects children.
  const body = H.makeEl('div');
  global.document.body = body;
  win.document.body = body;
  global.document.getElementById = () => null;

  A.mapview = { map: () => A._map, focusRider: (p) => { A._focused = p; return true; } };
  A.sim = {
    npcs: {},
    getNpc(id) { return this.npcs[id] || null; },
    playerPos: () => [0, 0]
  };
  H.loadModule('js/riderarrows.js');
  return { win, A, body };
}

const arrowsIn = (body) => {
  const host = body.children.filter((c) => c.className === 'rider-arrows')[0];
  return host ? host.children : [];
};

function main() {
  const { A, body } = boot();
  A._map = fakeMap([0, 0], 1000);
  A.state.settings.riderArrows = true;

  /* ===================================================================== P1 */
  group('a rider already on screen gets no arrow');
  {
    // 0.1 deg * 1000 px/deg = 100px from centre — comfortably inside 800x600.
    A.sim.npcs = { r1: { id: 'r1', name: 'Ana', pos: [0.1, 0.05], paint: '#fff' } };
    A.state.party = { members: ['r1'] };
    A.riderarrows._render();
    ok('no arrow is drawn for a visible rider', arrowsIn(body).length === 0);
  }

  /* ================================================================= P2, P3 */
  group('an off-screen rider gets one clamped, aimed arrow');
  {
    // 1.0 deg east = 1000px right of centre, far outside the 800px canvas.
    A.sim.npcs = { r1: { id: 'r1', name: 'Ana', pos: [1.0, 0], paint: '#2f80ff' } };
    A.state.party = { members: ['r1'] };
    A.riderarrows._render();

    const arrows = arrowsIn(body);
    ok('exactly one arrow', arrows.length === 1);

    const el = arrows[0];
    const m = /translate\((-?\d+)px,(-?\d+)px\)/.exec(el.style.transform || '');
    ok('it is positioned', !!m, 'transform was ' + el.style.transform);
    const x = m ? Number(m[1]) : -1, y = m ? Number(m[2]) : -1;

    ok('it is clamped inside the viewport width', x >= 0 && x <= W, 'x=' + x);
    ok('it sits at the right edge, since the rider is due east', x > W / 2, 'x=' + x);
    ok('it stays clear of the edge padding', x <= W - 34 + 1, 'x=' + x);
    ok('a due-east rider keeps the arrow vertically centred', Math.abs(y - HGT / 2) < 2, 'y=' + y);

    // The SVG is rotated so "up" is the direction of travel: due east is +90deg.
    const rot = /rotate\((-?[\d.]+)deg\)/.exec(el.icon.style.transform || '');
    ok('the arrow is rotated toward the rider', !!rot);
    ok('due east reads as 90 degrees', rot && Math.abs(Number(rot[1]) - 90) < 0.01,
      'got ' + (rot && rot[1]));

    // The label and distance are what make an arrow useful rather than decorative.
    ok('it is labelled with the rider name', el.nameEl.textContent === 'Ana');
    ok('it carries a distance', /\d/.test(el.distEl.textContent));
    ok('it is painted in that rider’s colour', el.style.getPropertyValue('--paint') === '#2f80ff');
  }

  group('direction is true for every quadrant');
  {
    const cases = [
      { pos: [0, 1.0], deg: 0, name: 'due north' },
      { pos: [1.0, 0], deg: 90, name: 'due east' },
      { pos: [0, -1.0], deg: 180, name: 'due south' },
      { pos: [-1.0, 0], deg: -90, name: 'due west' }
    ];
    cases.forEach(function (c) {
      A.sim.npcs = { r1: { id: 'r1', name: 'Ana', pos: c.pos, paint: '#fff' } };
      A.state.party = { members: ['r1'] };
      A.riderarrows._render();
      const el = arrowsIn(body)[0];
      const rot = el && /rotate\((-?[\d.]+)deg\)/.exec(el.icon.style.transform || '');
      // Compare modulo a full turn: 270 and -90 are the same rotation, and
      // atan2 is free to return either.
      const norm = (d) => ((d % 360) + 360) % 360;
      ok(c.name + ' points ' + c.deg + ' degrees',
        rot && Math.abs(norm(Number(rot[1])) - norm(c.deg)) < 0.01, 'got ' + (rot && rot[1]));
    });
  }

  /* ===================================================================== P4
     Each edge is padded past the chrome that actually lives there. An arrow
     drawn underneath the radar stat cluster or the alert stack is unreadable,
     which is the same as not drawing it. */
  const at = (el) => {
    const m = /translate\((-?\d+)px,(-?\d+)px\)/.exec(el.style.transform);
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  group('arrows stay clear of the app chrome on every edge');
  {
    const place = (pos) => {
      A.sim.npcs = { r1: { id: 'r1', name: 'Ana', pos: pos, paint: '#fff' } };
      A.state.party = { members: ['r1'] };
      A.riderarrows._render();
      return at(arrowsIn(body)[0]);
    };

    ok('due north clears the top bar and the alert stack', place([0, 1.0]).y >= 200 - 1,
      'y=' + place([0, 1.0]).y);
    ok('due south clears the HUD rail', place([0, -1.0]).y <= HGT - 150 + 1,
      'y=' + place([0, -1.0]).y);
    // The left edge carries the SCAN / RISK / STATUS cluster, so it is padded
    // much further in than the right — this is the collision that buried an
    // arrow behind the risk meter.
    ok('due west clears the radar stat cluster', place([-1.0, 0]).x >= 148 - 1,
      'x=' + place([-1.0, 0]).x);
    ok('due east still hugs the right edge', place([1.0, 0]).x >= W - 34 - 1,
      'x=' + place([1.0, 0]).x);
    ok('the left inset is genuinely wider than the right',
      place([-1.0, 0]).x > (W - place([1.0, 0]).x));
  }

  /* ===================================================================== P5 */
  group('arrows come and go with the convoy');
  {
    A.sim.npcs = {
      r1: { id: 'r1', name: 'Ana', pos: [1.0, 0], paint: '#fff' },
      r2: { id: 'r2', name: 'Bo', pos: [-1.0, 0], paint: '#fff' }
    };
    A.state.party = { members: ['r1', 'r2'] };
    A.riderarrows._render();
    ok('two off-screen riders get two arrows', arrowsIn(body).length === 2);

    // One rider comes back into view.
    A.sim.npcs.r2.pos = [0.05, 0.05];
    A.riderarrows._render();
    ok('the returning rider loses their arrow', arrowsIn(body).length === 1);

    A.state.party = null;
    A.riderarrows._render();
    ok('leaving the convoy clears every arrow', arrowsIn(body).length === 0);

    A.state.party = { members: ['r1'] };
    A.state.settings.riderArrows = false;
    A.riderarrows._render();
    ok('turning the setting off clears them too', arrowsIn(body).length === 0);

    A.state.settings.riderArrows = true;
    A.riderarrows._render();
    ok('turning it back on brings them back', arrowsIn(body).length === 1);
  }

  group('a rider with no position is skipped, not crashed on');
  {
    A.sim.npcs = { r1: { id: 'r1', name: 'Ana', pos: null, paint: '#fff' } };
    A.state.party = { members: ['r1', 'ghost-id'] };
    let threw = false;
    try { A.riderarrows._render(); } catch (e) { threw = true; }
    ok('rendering does not throw', !threw);
    ok('and no arrow is invented', arrowsIn(body).length === 0);
  }

  process.exit(H.report());
}

main();
