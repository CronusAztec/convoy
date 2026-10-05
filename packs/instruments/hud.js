/* Convoy — instruments pack: the shared HUD instrument rail.
   Restored from js/hud.js (pre-cut tree a1de6fd). One top-right vertical stack
   the instrument widgets append their glass cards into, in a fixed rank order,
   so they auto-flow without overlapping. This is the first script of the pack:
   it registers every instrument setting (defaults as they were; they only show
   once the pack is held) and the pack-wide `held()` helper the widgets gate on. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, ST = A.store;

  ST.registerSettings({
    showSpeedo: true,      // HUD speedometer (speedo.js)
    showCompass: true,     // heading rose (compass.js)
    showClock: true,       // local time + next sun event (clock.js)
    showTripmeter: false,  // session distance + moving time (tripmeter.js)
    showGforce: false,     // GPS-derived g-force meter (gmeter.js)
    showWeatherNow: false, // current conditions at your position (weathernow.js)
    showBattery: false,    // device battery level (battery.js)
    showCoords: false,     // live lat/lng, tap to copy (coords.js)
    showDestArrow: false,  // arrow to the active route destination (destarrow.js)
    speedAlert: 0,         // overspeed alert threshold in current units; 0 = off (speedalert.js)
    nightDim: 0,           // night-drive glare dimmer 0..0.7 (dimmer.js)
    autoParkPin: true      // drop a parking pin automatically when a trip arrives (places.js)
  });

  var railEl = null;
  function rail() {
    if (railEl) return railEl;
    railEl = document.getElementById('hud-rail');
    if (!railEl) {
      railEl = U.el('div', 'hud-rail');
      railEl.id = 'hud-rail';
      document.body.appendChild(railEl);
    }
    return railEl;
  }

  // The fixed rail order, enforced here rather than by load order alone: a card
  // built late (a setting flipped on mid-session) still lands in the position it
  // would have had at boot.
  var RANK = ['hud-compass', 'hud-clock', 'hud-trip', 'hud-gmeter', 'hud-quest',
    'hud-weather', 'hud-battery', 'hud-coords', 'hud-dest'];

  function card(cls) {
    var c = U.el('div', 'hud-card glass' + (cls ? ' ' + cls : ''));
    var token = cls ? String(cls).split(' ')[0] : '';
    var rank = RANK.indexOf(token);
    var r = rail();
    if (rank >= 0) {
      for (var i = 0; i < r.children.length; i++) {
        var sib = r.children[i];
        var sibRank = RANK.indexOf((sib.dataset && sib.dataset.rank) || '');
        if (sibRank >= 0 && sibRank > rank) { r.insertBefore(c, sib); c.dataset.rank = token; return c; }
      }
    }
    r.appendChild(c);
    c.dataset.rank = token;
    return c;
  }

  function held() { return !!(A.packs && A.packs.has('instruments')); }

  A.hud = { rail: rail, card: card, held: held, RANK: RANK };
})();
