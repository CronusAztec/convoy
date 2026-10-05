/* Convoy — instruments pack: settings + profile sections, boot and stand-down.
   The "Instruments" settings section (every widget toggle, night dimmer,
   overspeed alert, auto parking pin) through A.ui.addHook('settings'); the
   Drive log and Saved places on the profile page through addHook('profile').
   The pack's init runs every module in rail order; body.pack-instruments is
   the switch the stylesheet hides every instrument behind while the account
   does not hold the pack. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;
  var PACK = 'instruments';
  function held() { return !!(A.packs && A.packs.has(PACK)); }

  /* ---------------- settings ---------------- */
  A.ui.addHook('settings', function (body, kit) {
    if (!held()) return;
    body.appendChild(U.el('div', 'section-label', 'Instruments'));
    var row = function (title, sub, key) {
      body.appendChild(kit.row(title, sub, kit.toggle(!!S.settings[key], function (v) { ST.setSetting(key, v); })));
    };
    row('Speedometer', 'Live speed with session top & average', 'showSpeedo');
    row('Compass', 'Heading rose with cardinal direction', 'showCompass');
    row('Clock & sun', 'Local time and the next sunrise / sunset', 'showClock');
    row('Tripmeter', 'Session distance & moving time (tap the card to reset)', 'showTripmeter');
    row('G-force meter', 'Cornering & braking g, derived from GPS', 'showGforce');
    row('Weather now', 'Live temperature & conditions at your location', 'showWeatherNow');
    row('Battery', 'Device battery level while you drive', 'showBattery');
    row('Coordinates', 'Live lat/lng · tap the card to copy', 'showCoords');
    row('Destination arrow', 'Arrow pointing to your active route destination', 'showDestArrow');

    var dimSlider = U.el('input', 'input');
    dimSlider.type = 'range'; dimSlider.min = '0'; dimSlider.max = '0.7'; dimSlider.step = '0.05';
    dimSlider.value = S.settings.nightDim != null ? S.settings.nightDim : 0;
    dimSlider.style.width = '100%';
    dimSlider.setAttribute('aria-label', 'Night dimmer');
    dimSlider.addEventListener('input', function () { ST.setSetting('nightDim', parseFloat(dimSlider.value)); });
    body.appendChild(kit.field('Night dimmer', dimSlider));

    var spdUnit = S.settings.units === 'km' ? 'km/h' : 'mph';
    body.appendChild(kit.field('Overspeed alert (' + spdUnit + ')', kit.segmented([
      { label: 'Off', value: '0' }, { label: '30', value: '30' }, { label: '45', value: '45' },
      { label: '65', value: '65' }, { label: '80', value: '80' }
    ], String(Number(S.settings.speedAlert) || 0), function (v) { ST.setSetting('speedAlert', Number(v)); })));

    body.appendChild(kit.row('Auto parking pin', 'Drops a pin where a trip ends',
      kit.toggle(!!S.settings.autoParkPin, function (v) { ST.setSetting('autoParkPin', v); })));
  });

  /* ---------------- profile: drive log + saved places ---------------- */
  function renderDriveLog(el) {
    if (!el || !A.triplog) return;
    var st = A.triplog.stats();
    var trips = A.triplog.list().slice(0, 6);
    var units = S.settings.units;
    var vMult = units === 'km' ? 3.6 : 2.23694;
    var vUnit = units === 'km' ? ' km/h' : ' mph';
    el.innerHTML = '<div class="dl-odo"><b>' + U.fmtDist(st.odoM, units) + '</b> lifetime · ' +
      st.count + ' trip' + (st.count === 1 ? '' : 's') + '</div>';
    if (!trips.length) {
      el.appendChild(U.el('div', 'dl-empty', 'Start a ride and your trips log themselves here.'));
      return;
    }
    var shown = A.triplog.shownIdx();
    trips.forEach(function (t, i) {
      var d = new Date(t.t0);
      var row = U.el('div', 'dl-row');
      row.innerHTML =
        '<div class="dl-main"><b>' + U.esc(t.label) + '</b>' +
        '<i>' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + U.fmtClock(d) +
        ' · ' + U.fmtDist(t.dist, units) + ' · ' + U.fmtDur(t.dur) +
        (t.maxMs > 0 ? ' · top ' + Math.round(t.maxMs * vMult) + vUnit : '') + '</i></div>';
      var btn = U.el('button', 'btn btn-ghost btn-small', shown === i ? 'Hide' : 'Map');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (A.triplog.shownIdx() === i) A.triplog.hideTrail();
        else if (!A.triplog.showTrail(i)) A.ui.toast('No path recorded for this trip', 'info');
        renderDriveLog(el);
      });
      row.appendChild(btn);
      el.appendChild(row);
    });
    var clr = U.el('button', 'btn btn-ghost btn-small dl-clear', 'Clear log');
    clr.type = 'button';
    clr.addEventListener('click', function () { A.triplog.clear(); });
    el.appendChild(clr);
  }
  function renderPlaces(el) {
    if (!el || !A.places) return;
    var list = A.places.list();
    el.innerHTML = '';
    if (!list.length) { el.appendChild(U.el('div', 'dl-empty', 'Star a destination on the route card to keep it here.')); return; }
    list.forEach(function (p, i) {
      var row = U.el('div', 'dl-row');
      row.innerHTML = '<div class="dl-main"><b>' + U.esc(p.label) + '</b><i>' + U.esc(p.sub || 'Saved place') + '</i></div>';
      var go = U.el('button', 'btn btn-ghost btn-small', 'Go');
      go.type = 'button';
      go.addEventListener('click', function () { A.ui.closePanels(); A.routing.setDestination([p.lng, p.lat], p.label); });
      var rm = U.el('button', 'btn btn-ghost btn-small', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', function () { A.places.removeAt(i); renderPlaces(el); });
      row.appendChild(go); row.appendChild(rm);
      el.appendChild(row);
    });
  }
  A.ui.addHook('profile', function (body) {
    if (!held()) return;
    body.appendChild(U.el('div', 'section-label', 'Drive log'));
    var dlog = U.el('div', 'drive-log');
    body.appendChild(dlog);
    renderDriveLog(dlog);
    var off = ST.on('triplog', function () { if (!dlog.isConnected) { off(); return; } renderDriveLog(dlog); });
    body.appendChild(U.el('div', 'section-label', 'Saved places'));
    var pl = U.el('div', 'saved-places');
    body.appendChild(pl);
    renderPlaces(pl);
  });

  /* ---------------- boot + stand-down ---------------- */
  function applyHeld() {
    document.body.classList.toggle('pack-instruments', held());
  }
  function init() {
    applyHeld();
    ['speedo', 'compass', 'clock', 'tripmeter', 'gmeter', 'weathernow', 'battery', 'coords', 'destarrow',
      'speedalert', 'dimmer', 'triplog', 'places', 'tripextras'].forEach(function (k) {
      try { if (A[k] && A[k].init) A[k].init(); } catch (e) { console.error('[instruments] ' + k, e); }
    });
    ST.on('packs', applyHeld);
  }
  A.instruments = { init: init, renderDriveLog: renderDriveLog, renderPlaces: renderPlaces, held: held };
  A.packs.register(PACK, { init: init });
})();
