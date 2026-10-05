/* Convoy — instruments pack: destination arrow HUD (settings.showDestArrow).
   Restored from js/destarrow.js. With a route active, an arrow points at the
   destination relative to the way you are heading, straight-line distance
   beneath it. Hidden without a route. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;

  var box = null, arrow = null, elS = null;
  function pos() { return (A.sim && A.sim.playerPos && A.sim.playerPos()) || S.playerStart; }
  function heading() { var h = A.sim && A.sim.playerHeading && A.sim.playerHeading(); return (h == null || isNaN(h)) ? 0 : h; }
  function build() {
    box = A.hud.card('hud-dest');
    box.innerHTML =
      '<svg class="dest-arrow" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M12 3 19 20 12 16 5 20Z" fill="var(--accent)"/></svg>' +
      '<span class="hc-l">to dest</span><i class="hc-s" id="da-s"></i>';
    arrow = box.querySelector('.dest-arrow');
    elS = box.querySelector('#da-s');
    render();
  }
  function render() {
    if (!box) return;
    var route = S.route;
    var visible = S.settings.showDestArrow && route && route.dest;
    box.style.display = visible ? '' : 'none';
    if (!visible) return;
    var p = pos();
    var rel = U.relBearing(p, heading(), route.dest);
    if (arrow) arrow.style.transform = 'rotate(' + rel + 'deg)';
    if (elS) elS.textContent = U.fmtDist(U.haversine(p, route.dest), S.settings.units);
  }
  function init() {
    build();
    ST.on('gpsfix', render);
    ST.on('tick', render);
    ST.on('route', render);
    ST.on('units', render);
    ST.on('setting', function (s) { if (s.key === 'showDestArrow') render(); });
  }
  A.destarrow = { init: init };
})();
