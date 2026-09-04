/* Convoy — ETA-card extras: arrival weather, share ETA, save place.

   routing.renderEtaCard() rebuilds the card's innerHTML on every route/trip
   transition, so this module re-injects its widgets after each 'route'/'trip'
   event (injection is idempotent — it checks for its own ids first).

   Weather: Open-Meteo (free, no key) forecast at the DESTINATION for the hour
   you'll arrive — "🌧 64° · 40% rain on arrival". Cached per destination.
   Share: Web Share on mobile, clipboard elsewhere.
   Save: star the destination into saved places (js/places.js). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var wxCache = {};   // destKey -> { line } | { pending } | { fail }

  /* ---------------- weather ---------------- */
  // WMO weather codes → glyph + word (coarse buckets are plenty here)
  function wmoText(code) {
    if (code === 0) return ['☀️', 'clear'];
    if (code <= 2) return ['🌤', 'partly cloudy'];
    if (code === 3) return ['☁️', 'cloudy'];
    if (code <= 48) return ['🌫', 'fog'];
    if (code <= 57) return ['🌦', 'drizzle'];
    if (code <= 67) return ['🌧', 'rain'];
    if (code <= 77) return ['❄️', 'snow'];
    if (code <= 82) return ['🌧', 'showers'];
    if (code <= 86) return ['❄️', 'snow showers'];
    return ['⛈', 'storms'];
  }

  function destKey() {
    return S.route ? S.route.dest[0].toFixed(3) + ',' + S.route.dest[1].toFixed(3) + '|' + S.settings.units : null;
  }

  function fetchWx() {
    var r = S.route;
    var key = destKey();
    if (!r || !key || wxCache[key]) { paintWx(); return; }
    wxCache[key] = { pending: true };
    var f = S.settings.units !== 'km'; // imperial units → °F
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + r.dest[1] + '&longitude=' + r.dest[0] +
      '&hourly=temperature_2m,precipitation_probability,weather_code' +
      (f ? '&temperature_unit=fahrenheit' : '') + '&forecast_days=2&timezone=auto';
    U.fetchT(url).then(function (res) { return res.json(); }).then(function (j) {
      var h = j && j.hourly;
      if (!h || !h.time || !h.time.length) throw new Error('no data');
      // pick the forecast hour closest to the arrival time
      var arrive = Date.now() + (S.route ? S.route.duration * 1000 : 0);
      var best = 0, bestD = Infinity;
      for (var i = 0; i < h.time.length; i++) {
        var d = Math.abs(new Date(h.time[i]).getTime() - arrive);
        if (d < bestD) { bestD = d; best = i; }
      }
      var w = wmoText(h.weather_code[best] || 0);
      var line = w[0] + ' ' + Math.round(h.temperature_2m[best]) + '°' + (f ? 'F' : 'C') + ' ' + w[1];
      var pp = h.precipitation_probability ? h.precipitation_probability[best] : null;
      if (pp != null && pp >= 25 && w[1].indexOf('rain') < 0 && w[1].indexOf('storm') < 0) {
        line += ' · ' + pp + '% rain';
      }
      wxCache[key] = { line: line + ' on arrival' };
      paintWx();
    }).catch(function () {
      wxCache[key] = { fail: true }; // quietly show nothing — weather is a garnish
      paintWx();
    });
  }

  function paintWx() {
    var card = document.getElementById('eta-card');
    if (!card || card.hidden || !S.route) return;
    var key = destKey();
    var hit = key && wxCache[key];
    var el = card.querySelector('#eta-wx');
    if (!hit || !hit.line) { if (el) el.remove(); return; }
    if (!el) {
      var main = card.querySelector('.eta-main');
      if (!main) return;
      el = U.el('div', 'eta-wx');
      el.id = 'eta-wx';
      main.appendChild(el);
    }
    el.textContent = hit.line;
  }

  /* ---------------- share + save buttons ---------------- */
  function shareText() {
    var r = S.route;
    if (!r) return '';
    var secs = r.duration;
    if (S.trip && S.trip.active) {
      var remain = Math.max(0, (S.trip.line.total || 0) - S.trip.progress);
      // Same guard as routing.updateTripUI — a 0 pace produced an Infinity ETA
      // and a shared message reading "ETA Invalid Date".
      var pace = (S.trip.baseSpeed || 0) * (S.trip.mult || 1);
      secs = pace > 0.1 ? remain / pace : r.duration;
    }
    var eta = U.fmtClock(new Date(Date.now() + secs * 1000));
    return 'Heading to ' + r.label + ', ETA ' + eta + ' (' + U.fmtDist(r.distance, S.settings.units) + '). Sent from Convoy.';
  }

  function doShare() {
    var text = shareText();
    if (!text) return;
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () { });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        A.ui.toast('ETA copied. Paste it anywhere', 'success');
      }, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); A.ui.toast('ETA copied. Paste it anywhere', 'success'); }
    catch (e) { A.ui.toast('Could not copy on this device', 'warn'); }
    document.body.removeChild(ta);
  }

  var STAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/></svg>';
  var SHARE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="m8.4 10.8 6.8-4M8.4 13.2l6.8 4"/></svg>';

  function placeOfRoute() {
    var r = S.route;
    return r ? { label: r.label, sub: 'Saved place', lng: r.dest[0], lat: r.dest[1] } : null;
  }

  function ensureButtons() {
    var card = document.getElementById('eta-card');
    if (!card || card.hidden || !S.route) return;
    var actions = card.querySelector('.eta-actions');
    if (!actions) return;

    if (!card.querySelector('#eta-share')) {
      var sh = U.el('button', 'icon-btn');
      sh.id = 'eta-share';
      sh.title = 'Share your ETA';
      sh.setAttribute('aria-label', 'Share your ETA');
      sh.innerHTML = SHARE;
      sh.addEventListener('click', doShare);
      actions.insertBefore(sh, actions.firstChild);
    }
    var sv = card.querySelector('#eta-save');
    if (!sv) {
      sv = U.el('button', 'icon-btn');
      sv.id = 'eta-save';
      sv.title = 'Save this place';
      sv.setAttribute('aria-label', 'Save this place');
      sv.innerHTML = STAR;
      sv.addEventListener('click', function () {
        var p = placeOfRoute();
        if (!p || !A.places) return;
        var nowSaved = A.places.toggleSave(p);
        sv.classList.toggle('saved', nowSaved);
        A.ui.toast(nowSaved ? 'Saved. Find it in search' : 'Removed from saved places', nowSaved ? 'success' : 'info');
      });
      actions.insertBefore(sv, actions.firstChild);
    }
    sv.classList.toggle('saved', !!(A.places && A.places.isSaved(placeOfRoute())));
  }

  function refresh() {
    // renderEtaCard just rebuilt the card — re-add our widgets + repaint weather
    ensureButtons();
    paintWx();
    if (S.route) fetchWx();
  }

  function init() {
    ST.on('route', refresh);
    ST.on('trip', refresh);
    ST.on('units', function () { wxCache = {}; refresh(); }); // °F/°C flip → refetch
    // Cycle 13: this module now loads lazily on the FIRST 'route'/'trip'
    // event (js/app.js) — by definition this init() runs strictly AFTER that
    // event already fired and the subscriptions above therefore missed it.
    // refresh() reads live S.route/S.trip, so calling it once here catches
    // the eta-card up to the state that triggered the load. Idempotent
    // (ensureButtons()/paintWx() both check for their own DOM/cache first).
    refresh();
  }

  A.tripextras = { init: init };
})();
