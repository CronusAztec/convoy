/* Convoy — instruments pack: compass HUD (settings.showCompass).
   Restored from js/compass.js. Live heading card: rotating needle + degrees +
   cardinal. Heading is the player's course (GPS heading while moving), else
   the map bearing so it still reads sensibly when parked or panning. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, ST = A.store;

  var box = null, needle = null, deg = null, card = null;
  var CARDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function cardinal(h) { return CARDS[Math.round(((h % 360) / 45)) % 8]; }
  function heading() {
    var h = A.sim && A.sim.playerHeading && A.sim.playerHeading();
    if (h == null || isNaN(h)) {
      var m = A.mapview && A.mapview.map && A.mapview.map();
      h = m && m.getBearing ? m.getBearing() : 0;
    }
    return (h % 360 + 360) % 360;
  }
  function build() {
    box = A.hud.card('hud-compass');
    box.innerHTML =
      '<svg class="cmp-needle" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
        '<path d="M12 3 16 13 12 11 8 13Z" fill="var(--accent)"/>' +
        '<path d="M12 21 8 13 12 15 16 13Z" fill="var(--text-dim)"/>' +
      '</svg>' +
      '<b class="hc-v" id="cmp-deg">0°</b><span class="hc-l" id="cmp-card">N</span>';
    needle = box.querySelector('.cmp-needle');
    deg = box.querySelector('#cmp-deg');
    card = box.querySelector('#cmp-card');
    sync();
  }
  function render() {
    if (!box || box.style.display === 'none') return;
    var h = heading();
    if (needle) needle.style.transform = 'rotate(' + h + 'deg)';
    if (deg) deg.textContent = Math.round(h) + '°';
    if (card) card.textContent = cardinal(h);
  }
  function sync() {
    if (box) box.style.display = S.settings.showCompass ? '' : 'none';
    render();
  }
  function init() {
    build();
    ST.on('gpsfix', render);
    ST.on('tick', render);
    var m = A.mapview && A.mapview.map && A.mapview.map();
    if (m && m.on) m.on('rotate', render);
    ST.on('setting', function (s) { if (s.key === 'showCompass') sync(); });
  }
  A.compass = { init: init, _cardinal: cardinal };
})();
