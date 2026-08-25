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

  // Make a card in the rail. `cls` = extra class(es). Returns the element.
  // Visibility is the caller's job (toggle .style.display off its setting).
  function card(cls) {
    var c = U.el('div', 'hud-card glass' + (cls ? ' ' + cls : ''));
    rail().appendChild(c);
    return c;
  }

  A.hud = { rail: rail, card: card };
})();
