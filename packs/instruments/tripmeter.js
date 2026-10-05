/* Convoy — instruments pack: session tripmeter HUD (settings.showTripmeter).
   Restored from js/tripmeter.js. A live odometer for the session: distance
   travelled + moving time from real GPS deltas (gated on a small speed so
   parked jitter does not inflate it) and, during a route preview with no GPS,
   the simulated pace. Tap the card to reset. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null;
  var meters = 0, movingMs = 0, lastPos = null, lastAt = 0;

  function build() {
    box = A.hud.card('hud-trip');
    box.title = 'Session trip · tap to reset';
    box.innerHTML = '<b class="hc-v" id="tm-v">0.0</b><span class="hc-l">trip</span><i class="hc-s" id="tm-s">0 min moving</i>';
    elV = box.querySelector('#tm-v');
    elS = box.querySelector('#tm-s');
    box.addEventListener('click', function () {
      meters = 0; movingMs = 0; lastPos = null;
      render(); A.ui.toast('Tripmeter reset', 'info');
    });
    sync();
  }
  function previewDriving() {
    var trip = S.trip;
    return !!(trip && trip.active && !(trip.live && trip.gotFix));
  }
  function sample(pos, t, speed) {
    if (previewDriving()) { lastPos = pos.slice(); lastAt = t; return; }
    if (lastPos) {
      var d = U.haversine(lastPos, pos);
      var dt = t - lastAt;
      var v = dt > 0 ? d / (dt / 1000) : 0;
      var moving = (speed != null && speed > 0.7) || v > 0.7;
      // Teleports are rejected by implied SPEED, not raw distance.
      if (moving && v < 70 && dt > 0 && dt < 15000) {
        meters += d;
        movingMs += dt;
        render();
      }
    }
    lastPos = pos.slice();
    lastAt = t;
  }
  function render() {
    if (!elV) return;
    var dist = U.fmtDist(meters, S.settings.units);
    var parts = dist.split(' ');
    elV.textContent = parts[0];
    var mins = Math.round(movingMs / 60000);
    elS.textContent = parts[1] + ' · ' + (mins < 1 ? '<1' : mins) + ' min moving';
  }
  function sync() {
    if (box) box.style.display = S.settings.showTripmeter ? '' : 'none';
    render();
  }
  function init() {
    build();
    ST.on('gpsfix', function (f) { sample(f.pos, f.t || Date.now(), f.speed); });
    var lastTick = 0;
    ST.on('tick', function () {
      if (previewDriving()) {
        var trip = S.trip;
        var now = Date.now();
        if (lastTick) {
          var dt = now - lastTick;
          if (dt > 0 && dt < 2000) { meters += (trip.baseSpeed * trip.mult) * (dt / 1000); movingMs += dt; render(); }
        }
        lastTick = now;
      } else lastTick = 0;
    });
    ST.on('units', render);
    ST.on('setting', function (s) { if (s.key === 'showTripmeter') sync(); });
  }
  A.tripmeter = { init: init, _meters: function () { return meters; } };
})();
