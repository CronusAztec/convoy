/* Convoy — shared HUD instrument rail.

   A single top-left vertical stack that the instrument widgets (compass, clock,
   tripmeter, weather, battery, coords, g-meter, destination arrow) append their
   glass cards into, so they auto-flow without each module hard-coding fixed
   coordinates that would overlap. The rail clears the topbar (top) and the
   speedometer (bottom-left, bottom:46px); it scrolls internally if a rider turns
   on more cards than fit. Card order follows the module load order in index.html. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util;

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

  // Cycle 13: the fixed rail order the comment above promises, now enforced
  // here instead of by load order alone — six of these nine modules
  // (js/app.js's LAZY_INSTRUMENTS) load on demand, in *enable* order, which
  // without this table would put a card wherever it happened to be turned on
  // rather than in the app's stable top-to-bottom position (guardrail 6:
  // visual identity). Keep in sync with js/app.js's boot order/table.
  var RANK = ['hud-compass', 'hud-clock', 'hud-trip', 'hud-gmeter', 'hud-quest',
    'hud-weather', 'hud-battery', 'hud-coords', 'hud-dest'];

  // Make a card in the rail. `cls` = extra class(es). Returns the element.
  // Visibility is the caller's job (toggle .style.display off its setting).
  // `cls`'s first token (e.g. "hud-battery") is looked up in RANK; a known
  // token is inserted before the first existing card that outranks it (i.e.
  // has a later boot slot) instead of always being appended, so a card that
  // loads late (a setting flipped on mid-session) still lands in the position
  // it would have had if loaded at boot. An unknown/absent token appends,
  // same as before this change.
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

  A.hud = { rail: rail, card: card };
})();
