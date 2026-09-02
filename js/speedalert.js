/* Convoy — overspeed alert (settings.speedAlert).
   speedAlert is a threshold in the rider's chosen units (mph or km/h); 0 = off.
   When live speed crosses it, a red banner appears and a short beep sounds once per
   crossing (re-armed after dropping ~2 units below), so steady highway cruising
   doesn't nag. Speed is read from gpsfix (Doppler or delta-derived, same as the
   speedometer). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var banner = null, armed = true, audio = null;

  function threshMs() {
    var v = Number(S.settings.speedAlert) || 0;
    if (v <= 0) return 0;
    return S.settings.units === 'km' ? v / 3.6 : v / 2.23694;
  }

  function beep() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.value = 0.06;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.18);
    } catch (e) { /* audio blocked until a gesture — banner still shows */ }
  }

  function build() {
    banner = U.el('div', 'overspeed-banner');
    banner.id = 'overspeed-banner';
    banner.innerHTML = '<b>SLOW DOWN</b><span id="ospd-txt"></span>';
    document.body.appendChild(banner);
  }

  function show(msg) {
    var t = banner.querySelector('#ospd-txt');
    if (t) t.textContent = msg;
    banner.classList.add('on');
  }
  function hide() { banner.classList.remove('on'); }

  function onSpeed(ms) {
    var thr = threshMs();
    if (thr <= 0 || ms == null || isNaN(ms)) { hide(); return; }
    if (ms >= thr) {
      var mult = S.settings.units === 'km' ? 3.6 : 2.23694;
      show(Math.round(ms * mult) + ' ' + (S.settings.units === 'km' ? 'km/h' : 'mph'));
      if (armed) { beep(); armed = false; }
    } else {
      // The BANNER tracks the limit exactly — drop it the moment you're under.
      // The BEEP keeps 2 units of hysteresis so hovering right on the limit
      // doesn't nag. These used to share one threshold, so the banner stayed lit
      // for 2 mph below the limit: you had slowed down and the app still said
      // "SLOW DOWN".
      hide();
      var reset = thr - (S.settings.units === 'km' ? 2 / 3.6 : 2 / 2.23694);
      if (ms < reset) armed = true;
    }
  }

  var lastFix = null;
  function init() {
    build();
    ST.on('gpsfix', function (f) {
      if (f.speed != null) onSpeed(f.speed);
      else if (lastFix) {
        var dt = ((f.t || Date.now()) - lastFix.t) / 1000;
        if (dt > 0.2 && dt < 6) onSpeed(U.haversine(lastFix.pos, f.pos) / dt);
      }
      lastFix = { pos: f.pos, t: f.t || Date.now() };
    });
    ST.on('setting', function (s) { if (s.key === 'speedAlert') { armed = true; hide(); } });
  }

  A.speedalert = { init: init };
})();
