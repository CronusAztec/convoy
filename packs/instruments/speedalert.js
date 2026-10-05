/* Convoy — instruments pack: overspeed alert (settings.speedAlert).
   Restored from js/speedalert.js. speedAlert is a threshold in the rider's
   units (0 = off). Crossing it shows a red banner and beeps once per
   crossing; the beep re-arms 2 units below, the banner tracks the limit
   exactly. Speed comes from gpsfix (Doppler or delta-derived). */
(function () {
  'use strict';
  var A = window.App;
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
    } catch (e) { /* audio blocked until a gesture — the banner still shows */ }
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
    if (thr <= 0 || ms == null || isNaN(ms) || !A.hud.held()) { hide(); return; }
    if (ms >= thr) {
      var mult = S.settings.units === 'km' ? 3.6 : 2.23694;
      show(Math.round(ms * mult) + ' ' + (S.settings.units === 'km' ? 'km/h' : 'mph'));
      if (armed) { beep(); armed = false; }
    } else {
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
  A.speedalert = { init: init, _onSpeed: onSpeed, _armed: function () { return armed; } };
})();
