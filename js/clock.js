/* Convoy — clock + sun times HUD (settings.showClock).
   Local time plus the next sun event (sunrise or sunset) for the rider's current
   position, computed offline from js/util.js sunTimes — no network. Handy for
   judging the drive home against the light. Updates every 20s. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null, timer = null;

  function pos() {
    return (A.sim && A.sim.playerPos && A.sim.playerPos()) || S.playerStart;
  }

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
      // Pick the next event by LOCAL time-of-day. sunTimes returns absolute Dates
      // for the UTC calendar day, so comparing them directly misfires across the
      // UTC/local boundary — normalize to minutes-since-local-midnight instead
      // (same reasoning as util.isDaylight).
      var mins = function (d) { return d.getHours() * 60 + d.getMinutes(); };
      var nowM = mins(now), riseM = mins(st.rise), setM = mins(st.set);
      var next, label;
      if (nowM < riseM) { next = st.rise; label = 'sunrise'; }
      else if (nowM < setM) { next = st.set; label = 'sunset'; }
      else { next = st.rise; label = 'sunrise'; } // after sunset → next is tomorrow's rise
      elS.textContent = (label === 'sunset' ? '☀ ' : '☾ ') + label + ' ' + U.fmtClock(next);
    } else {
      elS.textContent = U.isDaylight(p[1], p[0], now) ? '☀ polar day' : '☾ polar night';
    }
  }

  function sync() {
    if (box) box.style.display = S.settings.showClock ? '' : 'none';
    if (S.settings.showClock) { render(); if (!timer) timer = setInterval(render, 20000); }
    else if (timer) { clearInterval(timer); timer = null; }
  }

  function init() {
    build();
    ST.on('setting', function (s) { if (s.key === 'showClock') sync(); });
  }

  A.clock = { init: init };
})();
