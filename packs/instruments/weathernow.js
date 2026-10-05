/* Convoy — instruments pack: current-conditions HUD (settings.showWeatherNow).
   Restored from js/weathernow.js. Temperature + sky at the rider's position
   via Open-Meteo's keyless current-weather API: on enable, when the rider
   moves > 8 km, and at most every 10 min otherwise. The 8 s deadline the old
   module hand-rolled with an AbortController is now U.fetchT's. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null;
  var lastPos = null, lastAt = 0, inflight = false;
  var WMO = {
    0: ['Clear', '☀'], 1: ['Mostly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'],
    45: ['Fog', '🌫'], 48: ['Rime fog', '🌫'],
    51: ['Drizzle', '🌦'], 53: ['Drizzle', '🌦'], 55: ['Drizzle', '🌧'],
    61: ['Rain', '🌧'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'],
    66: ['Freezing rain', '🌧'], 67: ['Freezing rain', '🌧'],
    71: ['Snow', '🌨'], 73: ['Snow', '🌨'], 75: ['Heavy snow', '❄'], 77: ['Snow grains', '🌨'],
    80: ['Showers', '🌦'], 81: ['Showers', '🌧'], 82: ['Violent showers', '⛈'],
    85: ['Snow showers', '🌨'], 86: ['Snow showers', '🌨'],
    95: ['Thunderstorm', '⛈'], 96: ['Thunderstorm', '⛈'], 99: ['Thunderstorm', '⛈']
  };
  function pos() { return (A.sim && A.sim.playerPos && A.sim.playerPos()) || S.playerStart; }
  function build() {
    box = A.hud.card('hud-weather');
    box.title = 'Current conditions · tap to refresh';
    box.innerHTML = '<b class="hc-v" id="wx-v">–°</b><span class="hc-l">weather</span><i class="hc-s" id="wx-s">…</i>';
    elV = box.querySelector('#wx-v');
    elS = box.querySelector('#wx-s');
    box.addEventListener('click', function () { fetchNow(true); });
    sync();
  }
  function fetchNow(force) {
    if (!S.settings.showWeatherNow || inflight || !A.hud.held()) return;
    var p = pos();
    var now = Date.now();
    if (!force && lastPos && U.haversine(lastPos, p) < 8000 && now - lastAt < 600000) return;
    inflight = true;
    var unit = S.settings.units === 'km' ? 'celsius' : 'fahrenheit';
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + p[1].toFixed(3) +
      '&longitude=' + p[0].toFixed(3) + '&current=temperature_2m,weather_code&temperature_unit=' + unit;
    U.fetchT(u, undefined, 8000).then(function (r) { return r.json(); }).then(function (j) {
      inflight = false; lastPos = p.slice(); lastAt = Date.now();
      var c = j && j.current;
      if (!c) { if (elS) elS.textContent = 'unavailable'; return; }
      var deg = c.temperature_2m != null ? c.temperature_2m : c.temperature;
      var w = (U.own(WMO, c.weather_code) ? WMO[c.weather_code] : null) || ['—', ''];
      if (elV) elV.textContent = Math.round(deg) + '°';
      if (elS) elS.textContent = w[1] + ' ' + w[0];
    }).catch(function () {
      inflight = false; if (elS) elS.textContent = 'offline';
    });
  }
  function sync() {
    if (box) box.style.display = S.settings.showWeatherNow ? '' : 'none';
    if (S.settings.showWeatherNow) fetchNow(true);
  }
  function init() {
    build();
    ST.on('gpsfix', function () { fetchNow(false); });
    ST.on('units', function () { fetchNow(true); });
    ST.on('setting', function (s) { if (s.key === 'showWeatherNow') sync(); });
  }
  A.weathernow = { init: init };
})();
