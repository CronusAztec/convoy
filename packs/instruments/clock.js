/* Convoy — instruments pack: clock + sun times HUD (settings.showClock).
   Restored from js/clock.js. Local time plus the next sun event (sunrise or
   sunset) for the rider's position, computed offline from util.sunTimes — no
   network. Updates every 20 s while shown (a visual-only poller: U.poll). */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null, timer = null;
  function pos() { return (A.sim && A.sim.playerPos && A.sim.playerPos()) || S.playerStart; }
  function build() {
    box = A.hud.card('hud-clock');
    box.innerHTML = '<b class="hc-v" id="clk-v">–:–</b><span class="hc-l">local</span><i class="hc-s" id="clk-s"></i>';
    elV = box.querySelector('#clk-v');
    elS = box.querySelector('#clk-s');
    sync();
  }
  function render() {
    if (!elV) return;
    var now = new Date();
    elV.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var p = pos();
    var st = U.sunTimes(p[1], p[0], now);
    if (st) {
      var mins = function (d) { return d.getHours() * 60 + d.getMinutes(); };
      var nowM = mins(now), riseM = mins(st.rise), setM = mins(st.set);
      var next, label;
      if (nowM < riseM) { next = st.rise; label = 'sunrise'; }
      else if (nowM < setM) { next = st.set; label = 'sunset'; }
      else { next = st.rise; label = 'sunrise'; }
      elS.textContent = (label === 'sunset' ? '☀ ' : '☾ ') + label + ' ' + U.fmtClock(next);
    } else {
      elS.textContent = U.isDaylight(p[1], p[0], now) ? '☀ polar day' : '☾ polar night';
    }
  }
  function sync() {
    var on = !!(S.settings.showClock && A.hud.held());
    if (box) box.style.display = S.settings.showClock ? '' : 'none';
    if (on) { render(); if (!timer) timer = U.poll(render, 20000); }
    else timer = U.unpoll(timer);
  }
  function init() {
    build();
    ST.on('setting', function (s) { if (s.key === 'showClock') sync(); });
    ST.on('packs', sync);
  }
  A.clock = { init: init };
})();
