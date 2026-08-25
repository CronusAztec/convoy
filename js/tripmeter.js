/* Convoy — session tripmeter HUD (settings.showTripmeter).
   A live odometer for the current session: distance travelled + moving time. Sums
   real GPS position deltas (gated on a small speed so parked GPS jitter doesn't
   inflate it) and, during a route preview with no GPS, the simulated pace. Tap the
   card to reset. Distinct from the drive-log recorder (js/triplog.js), which saves
   a full trip for replay — this is a lightweight always-on trip A/B meter. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null;
  var meters = 0, movingMs = 0;
  var lastPos = null, lastAt = 0;

  function build() {
    box = A.hud.card('hud-trip');
    box.title = 'Session trip — tap to reset';
    box.innerHTML = '<b class="hc-v" id="tm-v">0.0</b><span class="hc-l">trip</span><i class="hc-s" id="tm-s">0 min moving</i>';
    elV = box.querySelector('#tm-v');
    elS = box.querySelector('#tm-s');
    box.addEventListener('click', function () {
      meters = 0; movingMs = 0; lastPos = null;
      render(); A.ui.toast('Tripmeter reset', 'info');
    });
    sync();
  }

  // Add a position sample; accumulate distance + moving time when actually moving.
  function sample(pos, t, speed) {
    if (lastPos) {
      var d = U.haversine(lastPos, pos);
      var dt = t - lastAt;
      // Reject teleports (relocate / big GPS jumps) and standstill jitter.
      var v = dt > 0 ? d / (dt / 1000) : 0;
      var moving = (speed != null && speed > 0.7) || v > 0.7;
      // Reject teleports by implied SPEED, not by raw distance. The old `d < 400`
      // cap combined with the 15 s window implied a 26.7 m/s (60 mph) ceiling —
      // so any motorway stretch that spanned a slow GPS interval wasn't clamped,
      // it was discarded, and the trip silently came up short.
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
    var dist = U.fmtDist(meters, S.settings.units); // e.g. "2.4 mi"
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
    // Route preview (no GPS): advance by the simulated pace between ticks.
    var lastTick = 0;
    ST.on('tick', function () {
      var trip = S.trip;
      if (trip && trip.active && !(trip.live && trip.gotFix)) {
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

  A.tripmeter = { init: init };
})();
