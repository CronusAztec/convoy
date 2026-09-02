/* Convoy — night dimmer (settings.nightDim: 0..0.7).
   A soft dark scrim over the map to cut screen glare on night drives. Sits above the
   basemap but below all chrome (topbar, controls, panels, HUD), so instruments stay
   crisp while the bright map is dimmed. 0 = off. Pure CSS overlay — no permissions. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
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
