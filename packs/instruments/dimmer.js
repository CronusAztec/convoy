/* Convoy — instruments pack: night dimmer (settings.nightDim: 0..0.7).
   Restored from js/dimmer.js. A dark scrim over the map, below all chrome, to
   cut glare on night drives. 0 = off. Pure CSS; no permissions. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;

  var el = null;
  function apply(v) {
    if (!el) return;
    var a = U.clamp(Number(v) || 0, 0, 0.7);
    el.style.opacity = String(a);
    el.style.display = a > 0 ? '' : 'none';
  }
  function init() {
    el = U.el('div', 'night-dim');
    el.id = 'night-dim';
    document.body.appendChild(el);
    apply(S.settings.nightDim);
    ST.on('setting', function (s) { if (s.key === 'nightDim') apply(s.val); });
  }
  A.dimmer = { init: init };
})();
