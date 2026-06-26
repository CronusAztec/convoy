/* Convoy — map overlays: weather radar, traffic heatmap, hazard pins.
   These are pure-frontend layers added on top of the MapLibre map. They react to
   the showWeather / showTraffic / showHazards settings and refresh themselves on
   a slow cadence driven by the player's movement.

   Data sources (all free / keyless from the browser):
     - Weather: RainViewer raster tiles (https://api.rainviewer.com) — precipitation.
     - Traffic: TomTom flow tiles, fetched through our own /api/traffic proxy so
                the provider key stays server-side. The layer is a graceful no-op
                (hidden, not an error) until the server reports it has a key.
     - Hazards: Open-Meteo current conditions polled near the player, mapped to pins
                (heavy rain, snow, freezing, fog, high wind) + locally-reported pins.

   Whether traffic is available is decided at runtime by the server's capability
   probe (A.config.routeCaps.routing); no key is ever read on the client. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, U = A.util, ST = A.store;

  // Live traffic-flow heatmap. The TomTom key is a server secret now: tiles are
  // fetched through our /api/traffic/<z>/<x>/<y>.png proxy, which injects the key
  // server-side. The layer only lights up once net.js's capability probe reports
  // the server has a key (A.config.routeCaps.routing); until then (or on the web
  // build with no server) it stays a graceful no-op, exactly as before.
  function trafficOn() { return !!(A.config && A.config.routeCaps && A.config.routeCaps.routing); }
  var TRAFFIC_BASE = (A.config ? A.config.base : '') + '/api/traffic';
  var TRAFFIC_TILES = TRAFFIC_BASE + '/{z}/{x}/{y}.png';
  var TRAFFIC_REFRESH_MS = 90000;  // live congestion changes fast; re-fetch visible tiles
  var trafficTimer = null;         // armed only while the traffic layer is visible
  // Re-point the traffic source at the same proxy with a bumped cache-buster so
  // MapLibre re-fetches every visible tile. The proxy forwards to TomTom fresh
  // (its own Cache-Control was lowered to 90s to match), so live flow colors update
  // without the user having to pan. Mirrors refreshRadar() for the weather layer.
  function refreshTraffic() {
    var m = map();
    if (m && m.getSource('traffic')) m.getSource('traffic').setTiles([TRAFFIC_TILES + '?_v=' + Date.now()]);
  }

  // Live precipitation radar via RainViewer (keyless, real PNG tiles). The old
  // Open-Meteo "tiles" endpoint returned an HTML page, not images, so the weather
  // layer silently showed nothing. RainViewer paths are timestamped and rotate
  // (newest frame every ~10 min), so we fetch the latest path then build tiles.
  var RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
  // The legacy rain/temp/wind toggle now picks a radar color scheme (RainViewer
  // is precipitation-only; there's no keyless temp/wind raster). Labels in ui.js
  // are relabeled to match (Radar / Blue / Vivid).
  var RV_COLOR = { rain: 4, temp: 2, wind: 7 };
  var rvHost = 'https://tilecache.rainviewer.com';
  var rvPath = '';            // latest radar frame path (empty until first fetch)
  var rvTimer = null;         // periodic refresh while the layer is on
  var FORECAST = 'https://api.open-meteo.com/v1/forecast'; // no key, no CORS issue

  function rvColor() {
    var k = S.settings.weatherLayer;
    return RV_COLOR[k] != null ? RV_COLOR[k] : 4;
  }
  // {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
  // RainViewer's free API serves 512px tiles (256px requests return blank/error
  // tiles, which is why the layer used to vanish at higher zooms). tileSize + the
  // path here must agree so MapLibre places 512px tiles on the 512px grid.
  function rvTileUrl() { return rvHost + rvPath + '/512/{z}/{x}/{y}/' + rvColor() + '/1_1.png'; }

  // Fetch the newest radar frame and point the source's tiles at it.
  function refreshRadar() {
    return fetch(RAINVIEWER).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var past = j && j.radar && j.radar.past;
      if (!past || !past.length) return false;
      rvHost = j.host || rvHost;
      rvPath = past[past.length - 1].path;
      var m = map();
      if (m && m.getSource('weather')) m.getSource('weather').setTiles([rvTileUrl()]);
      return true;
    }).catch(function () { return false; });
  }
  var HAZARD_POLL_MS = 5 * 60 * 1000;  // refresh hazard conditions every 5 min
  var HAZARD_MOVE_KM = 8;              // or when the player moves this far

  var attached = false;       // 'style.load' listener wired once
  var hazardTimer = null;
  var lastHazPos = null;
  var weatherHazards = [];    // hazard features derived from weather conditions
  var reportedHazards = [];   // user-reported hazard features (persist until session ends)

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }

  /* ---------------- register sources + layers (once, after first map style load) ---------------- */
  // setStyle() wipes every source/layer, so this must run on EACH 'style.load'
  // (not just the first time) or the overlays vanish after a theme/map-style
  // change and never come back. The getSource/getLayer guards keep it idempotent.
  function ensure() {
    var m = map();
    if (!m) return;

    // Weather raster layer. RainViewer free API = 512px tiles, native detail up
    // to zoom 7. Beyond z7 MapLibre upscales the z7 tiles (normal for a weather
    // overlay) so the layer stays visible at every zoom level instead of going
    // blank. minzoom 0 covers the whole-globe zoom-out view.
    if (!m.getSource('weather')) {
      m.addSource('weather', {
        type: 'raster',
        tiles: [rvTileUrl()], // refreshed with a real frame path the moment the layer is shown
        tileSize: 512,
        minzoom: 0,
        maxzoom: 7,
        attribution: 'Radar © <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'
      });
    }
    addRaster(m, 'weather', '#7fd0ff', 0.7, true); // fade out as you zoom in

    // Traffic raster layer (only useful if a provider key is set; otherwise stays hidden).
    if (!m.getSource('traffic')) {
      m.addSource('traffic', {
        type: 'raster',
        tiles: [TRAFFIC_TILES],
        tileSize: 256,
        attribution: 'Traffic © <a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>'
      });
    }
    addRaster(m, 'traffic', '#ff8a3c', 0.6);

    // Hazard pins: small colored circles + symbol labels.
    if (!m.getSource('hazards')) {
      m.addSource('hazards', { type: 'geojson', data: emptyFC() });
    }
    if (!m.getLayer('hazard-circle')) {
      m.addLayer({
        id: 'hazard-circle', type: 'circle', source: 'hazards',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 9, 18, 16],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0e1116',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.9
        }
      });
    }

    applyAll();
    pushHazards(); // repaint any existing reported/weather pins onto the fresh source
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // opacity: a flat number, OR — when zoomFade is set — the "fully zoomed out" opacity
  // that fades to ~0 as you zoom in. The weather layer uses the fade so a radar blob
  // that's useful at city/country zoom doesn't wash out the street detail once you're
  // close in; traffic stays flat (congestion color is the whole point up close).
  function addRaster(m, id, color, opacity, zoomFade) {
    if (m.getLayer(id)) return;
    var opacityExpr = zoomFade
      ? ['interpolate', ['linear'], ['zoom'],
          0, opacity,        // fully visible zoomed out
          8, opacity * 0.7,  // start easing off
          12, opacity * 0.35,
          15, opacity * 0.12 // nearly transparent when street-level
        ]
      : opacity;
    m.addLayer({
      id: id, type: 'raster', source: id,
      // Start hidden — both overlays are off by default and applyAll()/setWeatherOn()
      // reveal them. Crucially this stops the weather layer from loading tiles before
      // refreshRadar() has set a real RainViewer frame path (empty-path 404s otherwise).
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': opacityExpr,
        'raster-hue-rotate': hueFor(color)
      }
    }, symbolLayerId(m)); // insert below the first symbol/label layer if present
  }

  // Rotate a hex color to a hue for the raster hue-rotate (keeps overlays distinct).
  function hueFor(hex) { return 0; }

  // Find a label/symbol layer to sit beneath, so overlays don't bury place names.
  function symbolLayerId(m) {
    var layers = (m.getStyle() && m.getStyle().layers) || [];
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].type === 'symbol') return layers[i].id;
    }
    return undefined; // append to top
  }

  /* ---------------- visibility (driven by settings) ---------------- */
  function applyAll() {
    if (!map()) return;
    setWeatherOn(!!(S.settings.showWeather));
    setTrafficOn(!!S.settings.showTraffic);
    if (S.settings.showHazards) startHazards(); else stopHazards();
  }

  // Turn the radar layer on/off. On enable we fetch a fresh frame BEFORE showing
  // the layer (so no broken/empty tiles flash), then refresh it every 5 min.
  function setWeatherOn(on) {
    var m = map(); if (!m || !m.getLayer('weather')) return;
    if (on) {
      // Only reveal once a real frame path exists, so tiles never 404 mid-fetch.
      refreshRadar().then(function () { if (rvPath) setVisible('weather', true); });
      if (!rvTimer) rvTimer = setInterval(refreshRadar, 5 * 60 * 1000);
    } else {
      setVisible('weather', false);
      if (rvTimer) { clearInterval(rvTimer); rvTimer = null; }
    }
  }

  function setVisible(id, show) {
    var m = map(); if (!m || !m.getLayer(id)) return;
    m.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }

  // Traffic is a live layer, so toggling it on also arms the refresh timer (which
  // re-fetches visible tiles every TRAFFIC_REFRESH_MS); toggling off stops it.
  // Keeps the gate on trafficOn() (server must have a TomTom key) so we never
  // arm refreshes against an unavailable layer.
  function setTrafficOn(on) {
    on = !!(on && trafficOn());
    setVisible('traffic', on);
    if (on) {
      if (!trafficTimer) {
        refreshTraffic();
        trafficTimer = setInterval(refreshTraffic, TRAFFIC_REFRESH_MS);
      }
    } else if (trafficTimer) {
      clearInterval(trafficTimer); trafficTimer = null;
    }
  }

  // Color-scheme change for the radar (the rain/temp/wind toggle). Re-point the
  // tiles at the same frame with the newly-selected RainViewer color scheme.
  function setWeatherLayer(/* kind read from settings */) {
    var m = map(); if (!m) return;
    var src = m.getSource('weather');
    if (src) src.setTiles([rvTileUrl()]);
  }

  /* ---------------- hazards: poll current conditions near the player ---------------- */
  function startHazards() {
    if (hazardTimer) return;
    pollHazards();
    hazardTimer = setInterval(pollHazards, HAZARD_POLL_MS);
    if (hazardTimer.unref) hazardTimer.unref();
  }
  function stopHazards() {
    if (hazardTimer) { clearInterval(hazardTimer); hazardTimer = null; }
    var m = map(); if (m && m.getSource('hazards')) m.getSource('hazards').setData(emptyFC());
    lastHazPos = null;
  }

  // Report a local hazard at the player's position (user-reported). Kept separate
  // from weather-derived pins so a weather refresh can't wipe a manual report.
  function reportHazard(kind) {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return;
    var def = HAZARD_KINDS[kind] || HAZARD_KINDS.hazard;
    reportedHazards.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos.slice() },
      // `by` stamps this as our own so the crowd broadcast echo (which carries the
      // same id) is dropped on arrival instead of double-rendering our own pin.
      properties: { kind: kind, label: def.label, color: def.color, reported: true, by: A.net && A.net.myId ? A.net.myId() : null }
    });
    pushHazards();
    // Share with nearby riders (server relays only within NEARBY_KM). Solo/guest
    // with no socket is a no-op — the local pin above still shows for the reporter.
    if (A.net && A.net.isLive && A.net.isLive() && A.net.sendCrowdReport) {
      A.net.sendCrowdReport(pos[1], pos[0], kind, def.label);
    }
    A.ui && A.ui.toast(def.label + ' reported', 'info');
  }

  // Add a hazard at explicit coordinates — either a SABRE crowd alert relayed by
  // js/native.js, or a crowd report relayed from another rider via the server
  // (js/net.js). Like reportHazard but doesn't assume the player's position.
  // payload: { lat, lng, kind?, label?, by? } where `by` is the reporter's rider id.
  var REPORT_CAP = 120; // bound memory: a chatty region can't grow this array forever
  function addReportedHazard(payload) {
    if (!payload || typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
    // Drop our own echo: if we reported this, reportHazard() already drew it and
    // stamped `by` with our id; the server broadcast carries the same id back to us.
    var me = A.net && A.net.myId ? A.net.myId() : null;
    if (me && payload.by === me) return;
    var kind = payload.kind || 'hazard';
    var def = HAZARD_KINDS[kind] || HAZARD_KINDS.hazard;
    reportedHazards.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [payload.lng, payload.lat] },
      properties: { kind: kind, label: payload.label || def.label, color: def.color, reported: true, crowd: true, by: payload.by || null }
    });
    if (reportedHazards.length > REPORT_CAP) reportedHazards.shift(); // oldest first → drop the stalest
    pushHazards();
  }

  function pollHazards() {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return;
    // Throttle by movement: skip if we haven't moved much since the last poll.
    if (lastHazPos && U.haversine(lastHazPos, pos) < HAZARD_MOVE_KM * 1000) {
      pushHazards(); return;
    }
    lastHazPos = pos.slice();
    var url = FORECAST + '?latitude=' + pos[1].toFixed(4) + '&longitude=' + pos[0].toFixed(4) +
      '&current=weather_code,precipitation,snowfall,wind_speed_10m,temperature_2m';
    fetch(url).then(function (r) { if (!r.ok) throw new Error('w ' + r.status); return r.json(); })
      .then(function (j) {
        var cur = j && j.current;
        weatherHazards = scanHazards(cur, pos); // refresh weather set only; reports persist
        pushHazards();
      }).catch(function () { /* keep previous hazard pins */ });
  }

  // Map Open-Meteo current conditions to hazard pins at the player location.
  function scanHazards(cur, pos) {
    if (!cur) return [];
    var out = [];
    var code = cur.weather_code != null ? cur.weather_code : -1;
    var rain = cur.precipitation || 0;
    var snow = cur.snowfall || 0;
    var wind = cur.wind_speed_10m || 0; // km/h
    var temp = cur.temperature_2m;

    if (rain >= 4) out.push(hazFeat('rain', 'Heavy rain', pos));
    if (snow >= 1) out.push(hazFeat('snow', 'Snowfall', pos));
    if (temp != null && temp <= 0.5 && (rain > 0 || snow > 0)) out.push(hazFeat('ice', 'Icy road', pos));
    if (wind >= 50) out.push(hazFeat('wind', 'High winds ' + Math.round(wind) + ' km/h', pos));
    if (code === 45 || code === 48) out.push(hazFeat('fog', 'Fog', pos));
    return out;
  }
  function hazFeat(kind, label, pos) {
    var def = HAZARD_KINDS[kind] || HAZARD_KINDS.hazard;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos.slice() },
      properties: { kind: kind, label: label, color: def.color }
    };
  }
  function pushHazards() {
    var m = map();
    if (m && m.getSource('hazards')) {
      // Merge weather-derived and user-reported pins; weather refreshes, reports persist.
      m.getSource('hazards').setData({
        type: 'FeatureCollection',
        features: weatherHazards.concat(reportedHazards)
      });
    }
  }

  var HAZARD_KINDS = {
    rain: { label: 'Heavy rain', color: '#3aa0ff' },
    snow: { label: 'Snowfall', color: '#cfe6ff' },
    ice: { label: 'Icy road', color: '#7fe3ff' },
    wind: { label: 'High winds', color: '#c39cff' },
    fog: { label: 'Fog', color: '#9aa3b0' },
    hazard: { label: 'Hazard', color: '#ff5a3c' },
    // user-reportable road hazards (the report buttons below)
    accident: { label: 'Accident', color: '#ff3b3b' },
    police: { label: 'Police', color: '#3b82f6' },
    stopped: { label: 'Stopped vehicle', color: '#ff9f43' },
    debris: { label: 'Object on road', color: '#ffd23f' }
  };

  /* ---------------- hazard report UI (the buttons) ---------------- */
  // The reportable set, each a button in the picker. Colors come from HAZARD_KINDS.
  var REPORT_KINDS = [
    { kind: 'accident', label: 'Accident', icon: '<path d="M5 16l1.7-4.6A3 3 0 0 1 9.5 9.4h5a3 3 0 0 1 2.8 2L19 16"/><path d="M4 16h16v3h-2.5v-1.6h-11V19H4Z"/><path d="m9 6 1.4 2.2M15.5 5l-1 2.4"/>' },
    { kind: 'police', label: 'Police', icon: '<path d="M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6Z"/><path d="m9.5 11.5 1.8 1.8 3.4-3.6"/>' },
    { kind: 'debris', label: 'Object', icon: '<path d="M12 4 21.5 20H2.5Z"/><path d="M12 10.5v4M12 17.4v.02"/>' },
    { kind: 'stopped', label: 'Stopped car', icon: '<path d="M5 16l1.6-4.7A3 3 0 0 1 9.4 9.4h5.2a3 3 0 0 1 2.8 1.9L19 16"/><path d="M4 16.5h16v3h-2.6v-1.5H6.6v1.5H4Z"/>' },
    { kind: 'ice', label: 'Icy road', icon: '<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9M9 4.2l3 2 3-2M9 19.8l3-2 3 2M4.6 12H2.8M21.2 12h-1.8"/>' },
    { kind: 'fog', label: 'Fog', icon: '<path d="M4 8.5h13M7 12h13M5 15.5h12"/>' }
  ];

  var reportOverlay = null;
  function ensureReportUI() {
    if (reportOverlay) return reportOverlay;
    reportOverlay = U.el('div', 'modal-backdrop');
    reportOverlay.id = 'hazard-report';
    reportOverlay.hidden = true;
    reportOverlay.setAttribute('role', 'dialog');
    reportOverlay.setAttribute('aria-modal', 'true');
    reportOverlay.setAttribute('aria-label', 'Report a hazard');
    var shared = (A.native && A.native.isNative && A.native.isNative()) ? ' · shared to nearby apps' : '';
    var btns = REPORT_KINDS.map(function (r) {
      var col = (HAZARD_KINDS[r.kind] || HAZARD_KINDS.hazard).color;
      return '<button class="hazard-btn" type="button" data-kind="' + r.kind + '">' +
        '<span class="hz-ic" style="color:' + col + '"><svg viewBox="0 0 24 24">' + r.icon + '</svg></span>' +
        '<span class="hz-lb">' + U.esc(r.label) + '</span></button>';
    }).join('');
    reportOverlay.innerHTML =
      '<div class="hazard-modal" role="document">' +
      '  <header class="hazard-head">' +
      '    <div><h2>Report a hazard</h2><span class="hazard-sub">drops a pin at your location' + shared + '</span></div>' +
      '    <button class="icon-btn" id="hazard-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '  </header>' +
      '  <div class="hazard-grid">' + btns + '</div>' +
      '</div>';
    document.body.appendChild(reportOverlay);
    reportOverlay.addEventListener('click', function (e) { if (e.target === reportOverlay) closeReport(); });
    reportOverlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeReport(); } });
    reportOverlay.querySelector('#hazard-close').addEventListener('click', closeReport);
    Array.prototype.forEach.call(reportOverlay.querySelectorAll('.hazard-btn'), function (b) {
      b.addEventListener('click', function () { doReport(b.getAttribute('data-kind')); });
    });
    return reportOverlay;
  }

  function doReport(kind) {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) { if (A.ui) A.ui.toast('Set your location first (tap ⌖)', 'warn'); closeReport(); return; }
    if (!S.settings.showHazards) ST.setSetting('showHazards', true, 'hazards'); // make sure pins are shown
    reportHazard(kind);                                  // drops the pin + toasts
    if (A.native && A.native.publishCrowd) {             // share to SABRE hosts on native (no-op on web)
      var def = HAZARD_KINDS[kind] || HAZARD_KINDS.hazard;
      A.native.publishCrowd({ lat: pos[1], lng: pos[0], kind: kind, label: def.label });
    }
    closeReport();
  }

  var reportLastFocus = null;
  function openReport() {
    ensureReportUI();
    reportLastFocus = document.activeElement;
    reportOverlay.hidden = false;
    requestAnimationFrame(function () { reportOverlay.classList.add('show'); });
    var c = reportOverlay.querySelector('#hazard-close'); if (c) c.focus();
  }
  function closeReport() {
    if (!reportOverlay) return;
    reportOverlay.classList.remove('show');
    setTimeout(function () { reportOverlay.hidden = true; }, 200);
    if (reportLastFocus) { try { reportLastFocus.focus(); } catch (e) {} reportLastFocus = null; }
  }

  /* ---------------- wiring ---------------- */
  function init() {
    // Register layers once the map's style has loaded. mapview hooks 'style.load'
    // for its own layers; we attach to the same event on the map directly so
    // overlays don't depend on a custom event bus from mapview.
    var attach = function () {
      var m = map();
      if (!m || attached) return;
      attached = true;
      m.on('style.load', ensure);
      ensure(); // style may already be loaded
    };
    if (A.mapview && A.mapview.map) attach();
    else setTimeout(attach, 200); // map not ready yet — retry shortly

    var hz = document.getElementById('ctl-hazard');
    if (hz) hz.addEventListener('click', openReport); // the "report a hazard" map control

    ST.on('setting', function (e) {
      if (!e || !e.key) return;
      if (e.key === 'showWeather') setWeatherOn(!!e.val);
      else if (e.key === 'showTraffic') setTrafficOn(e.val);
      else if (e.key === 'showHazards') { if (e.val) startHazards(); else stopHazards(); }
      else if (e.key === 'weatherLayer') setWeatherLayer();
    });

    // The TomTom capability arrives asynchronously (probed on connect). When the
    // server confirms it has a key, re-evaluate traffic visibility so a user who
    // toggled traffic on before the probe finished isn't left with a hidden layer.
    ST.on('routecaps', function () { setTrafficOn(S.settings.showTraffic); });
  }

  A.overlays = {
    init: init,
    ensure: ensure,
    applyAll: applyAll,
    reportHazard: reportHazard,
    addReportedHazard: addReportedHazard,
    openReport: openReport,
    hasTrafficKey: function () { return trafficOn(); }
  };
})();
