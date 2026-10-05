/* Convoy — instruments pack: G-force meter (settings.showGforce).
   Restored from js/gmeter.js. Longitudinal (accel/braking) and lateral
   (cornering) g from consecutive GPS fixes: longitudinal = dv/dt, lateral =
   v · yaw rate. A dot in a ring shows the vector; the sub-line tracks the
   session peak. GPS-derived, so no motion-sensor permission. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;
  var G = 9.80665;

  var box = null, dot = null, elS = null;
  var lastSpeed = null, lastHeading = null, lastAt = 0, lastPos = null;
  var peak = 0;
  var MAX_PLAUSIBLE_G = 1.6;   // past this is measurement error, not driving
  var YAW_MIN_MS = 4;          // heading-derived yaw is noise below ~9 mph

  function build() {
    box = A.hud.card('hud-gmeter');
    box.title = 'G-force · tap to reset peak';
    box.innerHTML =
      '<div class="gm-ring"><i class="gm-cross-h"></i><i class="gm-cross-v"></i><i class="gm-dot" id="gm-dot"></i></div>' +
      '<span class="hc-l">g-force</span><i class="hc-s" id="gm-s">peak 0.00 g</i>';
    dot = box.querySelector('#gm-dot');
    elS = box.querySelector('#gm-s');
    box.addEventListener('click', function () { peak = 0; render(0, 0); A.ui.toast('Peak g reset', 'info'); });
    sync();
  }
  function render(latG, lonG) {
    if (!dot) return;
    var r = 26;
    var x = U.clamp(latG, -1.2, 1.2) / 1.2 * r;
    var y = U.clamp(-lonG, -1.2, 1.2) / 1.2 * r;
    dot.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    var mag = Math.sqrt(latG * latG + lonG * lonG);
    if (mag > peak) peak = mag;
    if (elS) elS.textContent = 'peak ' + peak.toFixed(2) + ' g';
  }
  function onFix(f) {
    var t = f.t || Date.now();
    if (box && box.style.display === 'none') { lastSpeed = null; lastPos = null; lastAt = t; return; }
    var v = (f.speed != null && !isNaN(f.speed) && f.speed >= 0) ? f.speed : null;
    var dt = (t - lastAt) / 1000;
    if (v == null && lastPos && f.pos && dt > 0.15 && dt < 5) v = U.haversine(lastPos, f.pos) / dt;
    if (v == null || isNaN(v)) { lastSpeed = null; lastPos = f.pos ? f.pos.slice() : null; lastAt = t; return; }
    if (lastSpeed != null && dt > 0.15 && dt < 5) {
      var lonG = ((v - lastSpeed) / dt) / G;
      var latG = 0;
      if (lastHeading != null && f.heading != null && !isNaN(f.heading) && v > YAW_MIN_MS) {
        var dH = (((f.heading - lastHeading + 540) % 360) - 180) * Math.PI / 180;
        latG = (v * (dH / dt)) / G;
      }
      if (Math.abs(lonG) <= MAX_PLAUSIBLE_G && Math.abs(latG) <= MAX_PLAUSIBLE_G) render(latG, lonG);
    }
    lastSpeed = v;
    lastHeading = f.heading;
    lastPos = f.pos ? f.pos.slice() : null;
    lastAt = t;
  }
  function sync() { if (box) box.style.display = S.settings.showGforce ? '' : 'none'; }
  function init() {
    build();
    ST.on('gpsfix', onFix);
    ST.on('setting', function (s) { if (s.key === 'showGforce') sync(); });
  }
  A.gmeter = { init: init, _peak: function () { return peak; } };
})();
