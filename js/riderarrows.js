/* Convoy — convoy rider edge arrows.

   When a convoy member is off screen, an arrow pins to the edge of the map
   pointing at them, with their distance under it. Tap one and the camera flies
   to that rider.

   Why this exists alongside "fit everyone": fitting the whole convoy into one
   view only works while the convoy is tight. Two riders eighty miles apart need
   a zoom where neither of them is a distinguishable dot, so mapview.fitRiders()
   refuses below FIT_MIN_ZOOM and these arrows are the answer instead — you keep
   your own zoom and still know where everyone is.

   Arrows are placed by projecting each rider's real position into screen space
   and clamping to the viewport edge, so the direction is true to the map's
   current rotation and pitch rather than a compass bearing that would drift out
   of agreement with a rotated map. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var host = null;
  var arrows = {};          // riderId -> element
  var raf = null;
  /* Insets are per-edge because the app's chrome is not symmetric. An arrow
     that lands under the radar stat cluster or the alert stack is not an arrow,
     it is a rumour — so each edge is padded past whatever actually lives there.
       left   — #radar-side stat cluster (SCAN / RISK / STATUS), ~125px wide
       top    — top bar, chips, and the #radar-alerts stack beneath them
       bottom — the HUD rail and the walkie overlay
       right  — map zoom/compass controls are narrow, so the plain edge pad */
  var EDGE_PAD = 34;
  var LEFT_PAD = 148;
  var TOP_PAD = 200;
  var BOTTOM_PAD = 150;

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }

  function ensureHost() {
    if (host) return host;
    host = document.getElementById('rider-arrows');
    if (!host) {
      host = U.el('div', 'rider-arrows');
      host.id = 'rider-arrows';
      host.setAttribute('aria-hidden', 'true');
      document.body.appendChild(host);
    }
    return host;
  }

  function memberIds() {
    return (S.party && S.party.members) ? S.party.members.slice() : [];
  }

  function riderPos(id) {
    if (!A.sim || !A.sim.getNpc) return null;
    var npc = A.sim.getNpc(id);
    if (!npc) return null;
    return npc.livePos || npc.pos || null;
  }

  // Parts are built as real elements and kept as references on the arrow rather
  // than written as innerHTML and queried back every frame. This runs on every
  // map move, so re-querying the DOM per rider per frame is waste — and a
  // reference cannot silently become null the way a selector can.
  function mkArrow(id) {
    var el = U.el('button', 'rider-arrow');
    el.type = 'button';
    var icon = U.el('span', 'ra-icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 20 12 16 5 20Z"/></svg>';
    var name = U.el('span', 'ra-name');
    var dist = U.el('span', 'ra-dist');
    el.appendChild(icon);
    el.appendChild(name);
    el.appendChild(dist);
    el.icon = icon; el.nameEl = name; el.distEl = dist;
    // Tapping an arrow is the whole point — it is a shortcut to "where is that
    // rider", not decoration.
    el.addEventListener('click', function () {
      var p = riderPos(id);
      if (p && A.mapview.focusRider) A.mapview.focusRider(p);
    });
    ensureHost().appendChild(el);
    return el;
  }

  function drop(id) {
    var el = arrows[id];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete arrows[id];
  }

  function clearAll() {
    Object.keys(arrows).forEach(drop);
    if (host) host.style.display = 'none';
  }

  function render() {
    raf = null;
    var m = map();
    if (!m || !S.settings.riderArrows || !S.party) { clearAll(); return; }

    var ids = memberIds();
    if (!ids.length) { clearAll(); return; }

    var w = m.getCanvas().clientWidth, h = m.getCanvas().clientHeight;
    if (!w || !h) return;
    ensureHost().style.display = '';

    var live = {};
    ids.forEach(function (id) {
      var pos = riderPos(id);
      if (!pos) return;
      var pt;
      try { pt = m.project(pos); } catch (e) { return; }

      var onScreen = pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h;
      if (onScreen) { drop(id); return; }   // visible riders need no arrow
      live[id] = 1;

      // Clamp the projected point to the usable edge of the viewport, then aim
      // the arrow along the vector from screen centre to the rider.
      var cx = w / 2, cy = h / 2;
      var dx = pt.x - cx, dy = pt.y - cy;
      var minX = LEFT_PAD, maxX = w - EDGE_PAD;
      var minY = TOP_PAD, maxY = h - BOTTOM_PAD;
      // Scale the vector down until it lands inside the padded box.
      var sx = dx === 0 ? Infinity : (dx > 0 ? (maxX - cx) / dx : (minX - cx) / dx);
      var sy = dy === 0 ? Infinity : (dy > 0 ? (maxY - cy) / dy : (minY - cy) / dy);
      var s = Math.max(0, Math.min(sx, sy));
      var x = cx + dx * s, y = cy + dy * s;

      var el = arrows[id] || (arrows[id] = mkArrow(id));
      el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px) translate(-50%,-50%)';
      el.icon.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI + 90) + 'deg)';

      var npc = A.sim.getNpc(id);
      el.nameEl.textContent = (npc && npc.name) ? npc.name : 'Rider';
      var me = A.sim.playerPos && A.sim.playerPos();
      el.distEl.textContent = me ? U.fmtDist(U.haversine(me, pos), S.settings.units) : '';
      el.style.setProperty('--paint', (npc && npc.paint) || 'var(--accent)');
    });

    Object.keys(arrows).forEach(function (id) { if (!live[id]) drop(id); });
  }

  // Coalesce every trigger into one paint per frame: the map fires move events
  // far faster than the screen refreshes, and each one would otherwise reproject
  // every member.
  function schedule() { if (!raf) raf = requestAnimationFrame(render); }

  function init() {
    var m = map();
    if (m) {
      m.on('move', schedule);
      m.on('zoom', schedule);
      m.on('rotate', schedule);
      m.on('pitch', schedule);
      m.on('resize', schedule);
    }
    ST.on('party', schedule);
    ST.on('tick', schedule);
    ST.on('gpsfix', schedule);
    ST.on('units', schedule);
    ST.on('setting', function (s) { if (s.key === 'riderArrows') schedule(); });
    schedule();
  }

  A.riderarrows = {
    init: init,
    refresh: schedule,
    // Test seam. refresh() defers to requestAnimationFrame, which never fires in
    // a headless or hidden page, so the placement maths would be untestable
    // without a synchronous way in.
    _render: render
  };
})();
