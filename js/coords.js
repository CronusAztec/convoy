/* Convoy — coordinates HUD (settings.showCoords).
   Live latitude/longitude of the rider. Tap the card to copy "lat, lng" to the
   clipboard — quick way to share exactly where you are. Updates from GPS fixes and
   position changes (throttled to a readable cadence). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, lastShown = 0;

  function pos() { return (A.sim && A.sim.playerPos && A.sim.playerPos()) || S.playerStart; }

  function build() {
    box = A.hud.card('hud-coords');
    box.title = 'Tap to copy your coordinates';
    box.innerHTML = '<b class="hc-v" id="co-v" style="font-size:13px">–</b><span class="hc-l">position</span>';
    elV = box.querySelector('#co-v');
    box.addEventListener('click', copy);
    sync();
  }

  function text() {
    var p = pos();
    return p[1].toFixed(5) + ', ' + p[0].toFixed(5);
  }

  function copy() {
    var t = text();
    var done = function () { A.ui.toast('Copied ' + t, 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(function () { A.ui.toast(t, 'info'); });
    } else A.ui.toast(t, 'info');
  }

  function render() {
    if (!elV || (box && box.style.display === 'none')) return;
    var now = Date.now();
    if (now - lastShown < 500) return; // don't thrash the DOM on every fix
    lastShown = now;
    elV.textContent = text();
  }

  function sync() {
    if (box) box.style.display = S.settings.showCoords ? '' : 'none';
    lastShown = 0; render();
  }

  function init() {
    build();
    ST.on('gpsfix', render);
    ST.on('tick', render);
    ST.on('setting', function (s) { if (s.key === 'showCoords') sync(); });
  }

  A.coords = { init: init };
})();
