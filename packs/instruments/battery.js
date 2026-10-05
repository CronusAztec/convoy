/* Convoy — instruments pack: battery HUD (settings.showBattery).
   Restored from js/battery.js. Device battery level + charging state via the
   Battery Status API. Unsupported (iOS WebKit has no such API) → the card
   hides itself. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, ST = A.store;

  var box = null, elV = null, elS = null, batt = null, ok = false;
  function build() {
    box = A.hud.card('hud-battery');
    box.innerHTML = '<b class="hc-v" id="bat-v">–</b><span class="hc-l">battery</span><i class="hc-s" id="bat-s"></i>';
    elV = box.querySelector('#bat-v');
    elS = box.querySelector('#bat-s');
    sync();
  }
  function render() {
    if (!elV || !batt) return;
    var pct = Math.round(batt.level * 100);
    elV.textContent = pct + '%';
    elV.style.color = pct <= 15 && !batt.charging ? 'var(--danger, #ff5a5a)' : '';
    elS.textContent = batt.charging ? '⚡ charging' : 'on battery';
  }
  function sync() {
    var vis = S.settings.showBattery && ok;
    if (box) box.style.display = vis ? '' : 'none';
    if (vis) render();
  }
  function init() {
    build();
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        batt = b; ok = true;
        ['levelchange', 'chargingchange'].forEach(function (ev) { b.addEventListener(ev, render); });
        sync();
      }).catch(function () { ok = false; sync(); });
    } else { ok = false; sync(); }
    ST.on('setting', function (s) { if (s.key === 'showBattery') sync(); });
  }
  A.battery = { init: init };
})();
