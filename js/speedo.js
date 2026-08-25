/* Convoy — HUD speedometer.

   Big live speed readout with session top/average, bottom-left over the map.
   Speed sources, best first:
     1. GPS Doppler speed from 'gpsfix' (real driving)
     2. position deltas between fixes (receivers that report no speed)
     3. the simulated trip speed during 5×/20× route previews
   Toggled by settings.showSpeedo; tap the readout to reset the session stats. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var elBox = null, elV = null, elU = null, elSub = null;
  var curMs = null;        // latest speed in m/s (null = no data yet)
  var lastFix = null;      // { pos, t } for delta-derived speed
  var lastDataAt = 0;      // wall time of the last speed sample
  var maxMs = 0;
  // Time-weighted average over moving samples: sum(v*dt) / sum(dt). A plain
  // sample mean weighted every fix equally, but GPS cadence drops in poor
  // reception — so slow, badly-received stretches were under-counted and the
  // displayed average read high.
  var movingSum = 0, movingMs = 0, lastNoteAt = 0;

  function unitMult() { return S.settings.units === 'km' ? 3.6 : 2.23694; }
  function unitLabel() { return S.settings.units === 'km' ? 'km/h' : 'mph'; }

  function build() {
    elBox = U.el('div', 'speedo glass');
    elBox.id = 'speedo';
    elBox.title = 'Session speed — tap to reset';
    elBox.innerHTML = '<b id="speedo-v">–</b><span id="speedo-u"></span><i id="speedo-sub"></i>';
    document.body.appendChild(elBox);
    elV = elBox.querySelector('#speedo-v');
    elU = elBox.querySelector('#speedo-u');
    elSub = elBox.querySelector('#speedo-sub');
    elBox.addEventListener('click', function () {
      maxMs = 0; movingSum = 0; movingMs = 0; lastNoteAt = 0;
      render();
      A.ui.toast('Speed stats reset', 'info');
    });
    syncVisible();
    render();
  }

  function syncVisible() {
    if (elBox) elBox.style.display = S.settings.showSpeedo ? '' : 'none';
  }

  function note(ms) {
    if (ms == null || isNaN(ms) || ms < 0 || ms > 90) return;
    var now = Date.now();
    curMs = ms;
    if (ms > maxMs) maxMs = ms;
    if (ms > 1) {
      var dt = lastNoteAt ? now - lastNoteAt : 0;
      if (dt > 0 && dt < 15000) { movingSum += ms * dt; movingMs += dt; }
    }
    lastNoteAt = now;
    lastDataAt = now;
    render();
  }

  function render() {
    if (!elV) return;
    var mult = unitMult();
    var stale = Date.now() - lastDataAt > 5000;
    elV.textContent = (curMs == null || stale) ? '–' : String(Math.round(curMs * mult));
    elU.textContent = unitLabel();
    elSub.textContent = maxMs > 0
      ? 'top ' + Math.round(maxMs * mult) + ' · avg ' + Math.round((movingMs ? movingSum / movingMs : 0) * mult)
      : 'waiting for movement';
  }

  function init() {
    build();

    // Real GPS: Doppler speed when the receiver gives it, else derive from deltas.
    ST.on('gpsfix', function (f) {
      if (f.speed != null) { note(f.speed); }
      else if (lastFix) {
        var dt = (f.t - lastFix.t) / 1000;
        if (dt > 0.2 && dt < 6) note(U.haversine(lastFix.pos, f.pos) / dt);
      }
      lastFix = { pos: f.pos, t: f.t };
    });

    // Route preview playback (no GPS driving it): show the simulated pace.
    ST.on('tick', function () {
      var trip = S.trip;
      if (trip && trip.active && !(trip.live && trip.gotFix)) note(trip.baseSpeed * trip.mult);
      else if (curMs != null && Date.now() - lastDataAt > 5000) render(); // decay to '–'
    });

    ST.on('units', render);
    ST.on('setting', function (s) { if (s.key === 'showSpeedo') syncVisible(); });
  }

  A.speedo = { init: init };
})();
