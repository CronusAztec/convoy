/* Convoy — G-force meter (settings.showGforce).
   Derives longitudinal (accel/braking) and lateral (cornering) g from consecutive
   GPS fixes: longitudinal = dv/dt, lateral = v · yawRate. A dot in a ring shows the
   combined vector; the sub-line tracks the session peak. Purely GPS-derived so it
   works on any device (no motion-sensor permission needed). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;
  var G = 9.80665;

  var box = null, dot = null, elS = null;
  var lastSpeed = null, lastHeading = null, lastAt = 0, lastPos = null;
  var peak = 0;

  // Physical ceiling for a road car on public roads. A GPS glitch (a fix that
  // teleports, or a Doppler spike after a tunnel) used to sail straight into the
  // session peak and park a fake "2.7 g" on the card for the rest of the drive.
  // Road tyres top out near 1.1 g braking / 1.0 g lateral, so anything past this
  // is measurement error, not driving — drop the sample instead of recording it.
  var MAX_PLAUSIBLE_G = 1.6;
  // Heading-derived yaw rate is only meaningful once the car is properly moving:
  // a GPS course at walking pace is mostly noise, and multiplying that noise by v
  // manufactured phantom cornering g while crawling in traffic.
  var YAW_MIN_MS = 4;   // ~9 mph

  function build() {
    box = A.hud.card('hud-gmeter');
    box.title = 'G-force — tap to reset peak';
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
    // Ring radius ~26px, full scale ±1.2 g — so 1.0 g sits at ~83% of the
    // radius, leaving visible headroom before the clamp.
    var r = 26;
    var x = U.clamp(latG, -1.2, 1.2) / 1.2 * r;
    var y = U.clamp(-lonG, -1.2, 1.2) / 1.2 * r; // accel pushes the dot up
    dot.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    var mag = Math.sqrt(latG * latG + lonG * lonG);
    if (mag > peak) peak = mag;
    if (elS) elS.textContent = 'peak ' + peak.toFixed(2) + ' g';
  }

  function onFix(f) {
    var t = f.t || Date.now();
    // Hidden card: drop the baseline so re-enabling doesn't compute a huge dv
    // across the whole gap. lastAt has to go with it, or the first sample back
    // divides by a multi-minute dt.
    if (box && box.style.display === 'none') { lastSpeed = null; lastPos = null; lastAt = t; return; }

    // Speed source, same order as the rest of the app: GPS Doppler when the
    // receiver reports it, else derived from the position delta. Deriving is
    // what makes the meter work at all on hardware with no Doppler — it used to
    // bail here and the card sat at 0.00 g for the entire drive.
    var v = (f.speed != null && !isNaN(f.speed) && f.speed >= 0) ? f.speed : null;
    var dt = (t - lastAt) / 1000;
    if (v == null && lastPos && f.pos && dt > 0.15 && dt < 5) {
      v = U.haversine(lastPos, f.pos) / dt;
    }
    if (v == null || isNaN(v)) { lastSpeed = null; lastPos = f.pos ? f.pos.slice() : null; lastAt = t; return; }

    if (lastSpeed != null && dt > 0.15 && dt < 5) {
      var lonG = ((v - lastSpeed) / dt) / G;
      var latG = 0;
      if (lastHeading != null && f.heading != null && !isNaN(f.heading) && v > YAW_MIN_MS) {
        var dH = (((f.heading - lastHeading + 540) % 360) - 180) * Math.PI / 180;
        latG = (v * (dH / dt)) / G;   // a_lat = v · yaw rate
      }
      // Reject the whole sample if either axis is off the physical scale — a
      // partially-bogus fix has no trustworthy axis.
      if (Math.abs(lonG) <= MAX_PLAUSIBLE_G && Math.abs(latG) <= MAX_PLAUSIBLE_G) {
        render(latG, lonG);
      }
    }
    lastSpeed = v;
    lastHeading = f.heading;
    lastPos = f.pos ? f.pos.slice() : null;
    lastAt = t;
  }

  function sync() {
    if (box) box.style.display = S.settings.showGforce ? '' : 'none';
  }

  function init() {
    build();
    ST.on('gpsfix', onFix);
    ST.on('setting', function (s) { if (s.key === 'showGforce') sync(); });
  }

  A.gmeter = { init: init };
})();
