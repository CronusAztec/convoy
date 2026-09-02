/* Convoy — trip recorder + drive log.

   Records every navigation trip (distance, duration, average/top speed, and a
   thinned breadcrumb of the path) plus a lifetime odometer. Shown in Profile →
   Drive log, where any entry can be replayed as a dotted trail on the map.
   Everything is local — nothing leaves the device. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var KEY = 'convoy.triplog.v1';
  var MAX_TRIPS = 40;      // keep the log bounded
  var MAX_PTS = 200;       // stored breadcrumb points per trip
  var MIN_TRIP_M = 150;    // shorter than this = noise, don't log it

  var db = { odoM: 0, trips: [] };
  var rec = null;          // active recording | null
  var shownIdx = -1;       // which log entry's trail is on the map (-1 = none)

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && typeof saved.odoM === 'number' && Array.isArray(saved.trips)) db = saved;
    } catch (e) { }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { }
  }

  /* ---------------- recording ---------------- */
  function begin() {
    rec = {
      t0: Date.now(),
      label: S.route ? S.route.label : 'Trip',
      coords: [],
      dist: 0,
      maxMs: 0,
      moveS: 0,          // seconds actually moving (for a fair average)
      lastPos: null,
      lastT: 0
    };
  }

  // 1 Hz sample from the sim tick while a trip is active.
  function sample() {
    if (!rec || !S.trip || !S.trip.active) return;
    var pos = A.sim.playerPos();
    if (!pos) return;
    var now = Date.now();
    if (rec.lastPos) {
      var dt = Math.min((now - rec.lastT) / 1000, 5);
      var d = U.haversine(rec.lastPos, pos);
      // Gate: ignore sub-jitter moves and teleports (relocate, 20× preview seams).
      if (dt > 0 && d > 0.5 && d < 600) {
        rec.dist += d;
        rec.moveS += dt;
        var v = d / dt;
        if (v > rec.maxMs && v < 90) rec.maxMs = v;
        var lastKept = rec.coords[rec.coords.length - 1];
        if (!lastKept || U.haversine(lastKept, pos) > 20) {
          rec.coords.push([+pos[0].toFixed(5), +pos[1].toFixed(5)]);
          // over budget → thin by dropping every other midpoint
          if (rec.coords.length > MAX_PTS) {
            rec.coords = rec.coords.filter(function (c, i) {
              return i === 0 || i === rec.coords.length - 1 || i % 2 === 0;
            });
          }
        }
      }
    } else {
      rec.coords.push([+pos[0].toFixed(5), +pos[1].toFixed(5)]);
    }
    rec.lastPos = pos;
    rec.lastT = now;
  }

  function finalize(arrived) {
    if (!rec) return;
    var r = rec; rec = null;
    if (r.dist < MIN_TRIP_M) return; // too short to be a real drive
    var dur = Math.max(1, Math.round((Date.now() - r.t0) / 1000));
    db.trips.unshift({
      t0: r.t0,
      label: r.label,
      dist: Math.round(r.dist),
      dur: dur,
      avgMs: r.moveS > 5 ? r.dist / r.moveS : r.dist / dur,
      maxMs: r.maxMs,
      arrived: !!arrived,
      coords: r.coords
    });
    db.trips = db.trips.slice(0, MAX_TRIPS);
    db.odoM += Math.round(r.dist);
    persist();
    ST.emit('triplog');
  }

  /* ---------------- trail replay ---------------- */
  function showTrail(i) {
    var t = db.trips[i];
    if (!t || !t.coords || t.coords.length < 2) return false;
    A.mapview.setTrailData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords } }]
    });
    A.mapview.fitRoute(t.coords);
    shownIdx = i;
    ST.emit('triplog:trail', i);
    return true;
  }
  function hideTrail() {
    A.mapview.setTrailData(null);
    shownIdx = -1;
    ST.emit('triplog:trail', -1);
  }

  function clearLog() {
    db = { odoM: db.odoM, trips: [] }; // odometer survives a log wipe
    persist();
    hideTrail();
    ST.emit('triplog');
  }

  /* ---------------- init ---------------- */
  function init() {
    load();
    ST.on('trip', function (t) {
      // reroutes re-emit 'trip' while still active — keep the same recording
      if (t && t.active) { if (!rec) begin(); return; }
      if (!t) finalize(!S.route); // arrived ⇒ endTrip already cleared the route
    });
    ST.on('tick', sample);
  }

  A.triplog = {
    init: init,
    stats: function () { return { odoM: db.odoM, count: db.trips.length }; },
    list: function () { return db.trips.slice(); },
    shownIdx: function () { return shownIdx; },
    showTrail: showTrail,
    hideTrail: hideTrail,
    clear: clearLog
  };
})();
