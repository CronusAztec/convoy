/* Convoy — current-conditions HUD (settings.showWeatherNow).
   Live temperature + sky condition at the rider's position via Open-Meteo's keyless
   current-weather API (the same provider the map weather overlay uses). Fetches on
   enable, when the rider moves >8 km, and at most every 10 min otherwise, so it's
   gentle on the free endpoint. Temperature unit follows the app's mi/km setting. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var box = null, elV = null, elS = null;
  var lastPos = null, lastAt = 0, inflight = false;

  // WMO weather codes → short label + glyph (Open-Meteo current.weather_code).
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
    if (!S.settings.showWeatherNow || inflight) return;
    var p = pos();
    var now = Date.now();
    if (!force && lastPos && U.haversine(lastPos, p) < 8000 && now - lastAt < 600000) return;
    inflight = true;
    var unit = S.settings.units === 'km' ? 'celsius' : 'fahrenheit';
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + p[1].toFixed(3) +
      '&longitude=' + p[0].toFixed(3) + '&current=temperature_2m,weather_code&temperature_unit=' + unit;
    // Hard 8s deadline: without it a hung request would leave inflight=true forever
    // and silently freeze all future weather updates.
    var ac = window.AbortController ? new AbortController() : null;
    var killer = ac ? setTimeout(function () { ac.abort(); }, 8000) : null;
    fetch(u, ac ? { signal: ac.signal } : undefined)
      .then(function (r) { return r.json(); }).then(function (j) {
      if (killer) clearTimeout(killer);
      inflight = false; lastPos = p.slice(); lastAt = Date.now();
      var c = j && j.current;
      if (!c) { if (elS) elS.textContent = 'unavailable'; return; }
      var deg = c.temperature_2m != null ? c.temperature_2m : c.temperature;
      // weather_code arrives from the network; an own-property probe keeps a hostile
      // or garbled 'constructor' from resolving to a prototype member instead of
      // falling through to the placeholder.
      var w = (U.own(WMO, c.weather_code) ? WMO[c.weather_code] : null) || ['—', ''];
      if (elV) elV.textContent = Math.round(deg) + '°';
      if (elS) elS.textContent = w[1] + ' ' + w[0];
    }).catch(function () {
      if (killer) clearTimeout(killer);
      inflight = false; if (elS) elS.textContent = 'offline';
    });
  }

  function sync() {
    if (box) box.style.display = S.settings.showWeatherNow ? '' : 'none';
    if (S.settings.showWeatherNow) fetchNow(true);
  }

  function init() {
    build();
    // Re-check on movement (throttled inside fetchNow) and on unit change.
    ST.on('gpsfix', function () { fetchNow(false); });
    ST.on('units', function () { fetchNow(true); });
    ST.on('setting', function (s) { if (s.key === 'showWeatherNow') sync(); });
  }

  A.weathernow = { init: init };
})();
