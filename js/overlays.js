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
    return U.fetchT(RAINVIEWER).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
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
  // Live view-based hazard sources (refreshed as the map pans). incidents = TomTom
  // (accidents/closures/road hazards, server-proxied); alerts = NWS weather warnings (keyless, US).
  var incidentHazards = [], alertHazards = [];
  var incidentTimer = null, nwsTimer = null;
  var lastIncidentBbox = null, lastNwsBbox = null;
  var INCIDENT_MS = 2 * 60 * 1000;   // incidents shift every couple of minutes
  var NWS_MS = 5 * 60 * 1000;        // weather alerts change slowly
  var NWS_URL = 'https://api.weather.gov/alerts/active';

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

    // Hazard pins: a colored disc (by kind) with a small white glyph on top, so each
    // hazard reads at a glance (accident vs ice vs flood vs weather alert …).
    if (!m.getSource('hazards')) {
      m.addSource('hazards', { type: 'geojson', data: emptyFC() });
    }
    if (!m.getLayer('hazard-circle')) {
      m.addLayer({
        id: 'hazard-circle', type: 'circle', source: 'hazards',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 11, 18, 17],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#0e1116',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.92
        }
      });
    }
    registerHazardIcons(m); // (re)register glyphs — setStyle() wipes addImage too
    if (!m.getLayer('hazard-icon')) {
      m.addLayer({
        id: 'hazard-icon', type: 'symbol', source: 'hazards',
        layout: {
          // Match against the kinds we actually registered, falling back to the
          // generic triangle. A bare concat produced 'hz-<anything>' — any kind
          // arriving from a server feed (TomTom incidents, NWS) that we have no
          // glyph for became a missing-image error, once per feature per frame.
          'icon-image': hazardIconExpr(),
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.45, 14, 0.6, 18, 0.85],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      });
    }

    applyAll();
    pushHazards(); // repaint any existing reported/weather pins onto the fresh source
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  /* ---------------- hazard glyphs (one small white icon per kind) ---------------- */
  // Stroke-based paths on a 24×24 grid; rendered to a canvas image per kind and used
  // as the symbol layer's icon-image ('hz-<kind>'). Mirrors the report-picker icons.
  var HAZARD_ICONS = {
    accident: 'M5 16l1.7-4.6A3 3 0 0 1 9.5 9.4h5a3 3 0 0 1 2.8 2L19 16 M4 16h16v3h-2.5v-1.6h-11V19H4Z M9 6l1.4 2.2 M15.5 5l-1 2.4',
    stopped:  'M5 16l1.6-4.7A3 3 0 0 1 9.4 9.4h5.2a3 3 0 0 1 2.8 1.9L19 16 M4 16.5h16v3h-2.6v-1.5H6.6v1.5H4Z',
    police:   'M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6Z M9.5 11.5l1.8 1.8 3.4-3.6',
    // 'camera' is a reportable kind (HAZARD_KINDS) and the radar detector uploads
    // MRCD/photo-enforcement hits as one — but it had no glyph here, so the symbol
    // layer resolved 'hz-camera' to a missing image: a console error per feature
    // and a bare disc with nothing on it.
    camera:   'M4 8h3l2-2.5h6L17 8h3v11H4Z M12 13.2m-3.2 0a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0',
    debris:   'M12 4 21.5 20H2.5Z M12 10.5v4 M12 17.4v.02',
    hazard:   'M12 4 21.5 20H2.5Z M12 10.5v4 M12 17.4v.02',
    ice:      'M12 3v18 M4.5 7.5l15 9 M19.5 7.5l-15 9 M9 4.2l3 2 3-2 M9 19.8l3-2 3 2 M4.6 12H2.8 M21.2 12h-1.8',
    snow:     'M12 3v18 M4.5 7.5l15 9 M19.5 7.5l-15 9 M9 4.2l3 2 3-2 M9 19.8l3-2 3 2 M4.6 12H2.8 M21.2 12h-1.8',
    fog:      'M4 8.5h13 M7 12h13 M5 15.5h12',
    rain:     'M5 11a4 4 0 0 1 1-7.5 5.5 5.5 0 0 1 10 1.3A3.2 3.2 0 0 1 17.5 11 M8 15l-1 3 M12 15l-1 3 M16 15l-1 3',
    wind:     'M3 8h11a2.5 2.5 0 1 0-2.5-2.6 M3 16h15a2.5 2.5 0 1 1-2.5 2.6 M3 12h9',
    flood:    'M8 11l4-4 4 4 M3 14.5c2 0 2 1.4 4 1.4s2-1.4 4-1.4 2 1.4 4 1.4 2-1.4 4-1.4 M3 18.5c2 0 2 1.4 4 1.4s2-1.4 4-1.4 2 1.4 4 1.4 2-1.4 4-1.4',
    closure:  'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M7.5 12h9',
    alert:    'M13 3 5 13h5l-1 8 9-11h-6l1-7Z'
  };
  var HZ_PX = 40; // @2x source so small pins stay crisp
  function makeHazardIcon(d) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = HZ_PX;
    var ctx = cv.getContext('2d');
    var pad = 7, scale = (HZ_PX - pad * 2) / 24;
    ctx.translate(pad, pad); ctx.scale(scale, scale);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var path = new Path2D(d);
    ctx.strokeStyle = 'rgba(8,12,18,.85)'; ctx.lineWidth = 3.6; ctx.stroke(path); // dark halo for contrast
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(path);             // white glyph
    return ctx.getImageData(0, 0, HZ_PX, HZ_PX);
  }
  // ['match', kind, 'accident','hz-accident', …, 'hz-hazard'] built from the icon
  // table, so adding a glyph above automatically wires it up here.
  function hazardIconExpr() {
    var expr = ['match', ['get', 'kind']];
    for (var kind in HAZARD_ICONS) {
      if (!HAZARD_ICONS.hasOwnProperty(kind) || kind === 'hazard') continue;
      expr.push(kind, 'hz-' + kind);
    }
    expr.push('hz-hazard'); // default
    return expr;
  }

  function registerHazardIcons(m) {
    for (var kind in HAZARD_ICONS) {
      if (!HAZARD_ICONS.hasOwnProperty(kind)) continue;
      var id = 'hz-' + kind;
      if (m.hasImage(id)) continue;
      try { m.addImage(id, makeHazardIcon(HAZARD_ICONS[kind]), { pixelRatio: 2 }); } catch (e) { /* ignore */ }
    }
  }

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
      // Re-read the SETTING inside the .then: toggling weather off while the frame
      // was mid-fetch must win — the interval is already dead by then, but this
      // reveal used to run anyway and resurrected the layer the rider just killed.
      refreshRadar().then(function () {
        if (rvPath && S.settings.showWeather) setVisible('weather', true);
      });
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
    fetchIncidents();            // live TomTom incidents for the current view
    fetchNwsAlerts();            // NWS weather warnings for the current view
    hazardTimer = setInterval(pollHazards, HAZARD_POLL_MS);
    if (hazardTimer.unref) hazardTimer.unref();
    if (!incidentTimer) { incidentTimer = setInterval(fetchIncidents, INCIDENT_MS); if (incidentTimer.unref) incidentTimer.unref(); }
    if (!nwsTimer) { nwsTimer = setInterval(fetchNwsAlerts, NWS_MS); if (nwsTimer.unref) nwsTimer.unref(); }
  }
  function stopHazards() {
    if (hazardTimer) { clearInterval(hazardTimer); hazardTimer = null; }
    if (incidentTimer) { clearInterval(incidentTimer); incidentTimer = null; }
    if (nwsTimer) { clearInterval(nwsTimer); nwsTimer = null; }
    weatherHazards = []; incidentHazards = []; alertHazards = [];
    lastIncidentBbox = null; lastNwsBbox = null; lastHazPos = null;
    var m = map(); if (m && m.getSource('hazards')) m.getSource('hazards').setData(emptyFC());
  }

  // Report a local hazard at the player's position (user-reported). Kept separate
  // from weather-derived pins so a weather refresh can't wipe a manual report.
  // labelOverride: optional custom pin text (e.g. the SOS beacon's "<name> needs
  // help") — defaults to the kind's standard label.
  function reportHazard(kind, labelOverride) {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return;
    var def = U.own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
    var label = labelOverride || def.label;
    reportedHazards.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos.slice() },
      // `by` stamps this as our own so the crowd broadcast echo (which carries the
      // same id) is dropped on arrival instead of double-rendering our own pin.
      properties: { kind: kind, label: label, color: def.color, reported: true, by: A.net && A.net.myId ? A.net.myId() : null }
    });
    pushHazards();
    // Share with nearby riders (server relays only within NEARBY_KM). Solo/guest
    // with no socket is a no-op — the local pin above still shows for the reporter.
    if (A.net && A.net.isLive && A.net.isLive() && A.net.sendCrowdReport) {
      A.net.sendCrowdReport(pos[1], pos[0], kind, label);
    }
    A.ui && A.ui.toast(label + ' reported', 'info');
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
    var def = U.own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
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
    U.fetchT(url).then(function (r) { if (!r.ok) throw new Error('w ' + r.status); return r.json(); })
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
    var def = U.own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos.slice() },
      properties: { kind: kind, label: label, color: def.color }
    };
  }
  function pushHazards() {
    var m = map();
    if (m && m.getSource('hazards')) {
      // Merge every hazard source: weather (player), user/crowd reports, live TomTom
      // incidents and NWS weather alerts (both view-based). Each refreshes on its own
      // cadence; concat is cheap and always reflects the latest of each.
      m.getSource('hazards').setData({
        type: 'FeatureCollection',
        features: weatherHazards.concat(reportedHazards, incidentHazards, alertHazards)
      });
    }
  }

  /* ---------------- live view-based hazards: TomTom incidents + NWS alerts ---------------- */
  function viewBBox() {
    var m = map(); if (!m || !m.getBounds) return null;
    var b = m.getBounds();
    return { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() };
  }
  // Refetch only after a real view change — avoids hammering the APIs on every tiny
  // move. Triggers on a pan (a corner moved far enough) OR a zoom (the view span
  // changed materially), so zooming out actually loads the newly-visible area.
  function movedFar(prev, bb, deg) {
    if (!prev) return true;
    if (Math.abs(bb.minLat - prev.minLat) > deg || Math.abs(bb.minLng - prev.minLng) > deg) return true;
    var prevSpan = (prev.maxLng - prev.minLng) + (prev.maxLat - prev.minLat);
    var span = (bb.maxLng - bb.minLng) + (bb.maxLat - bb.minLat);
    return Math.abs(span - prevSpan) > deg;
  }
  // Incidents ride on the TomTom key OR the server's agent ingest feed — the
  // caps probe reports `incidents` covering both (routing is the legacy fallback).
  function incidentsOn() {
    var caps = A.config && A.config.routeCaps;
    return !!(caps && (caps.incidents != null ? caps.incidents : caps.routing));
  }

  function fetchIncidents() {
    if (!S.settings.showHazards || !incidentsOn()) return;
    var bb = viewBBox(); if (!bb) return;
    if (lastIncidentBbox && !movedFar(lastIncidentBbox, bb, 0.2)) return;
    lastIncidentBbox = bb;
    U.fetchT((A.config ? A.config.base : '') + '/api/incidents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat] })
    }).then(function (r) { if (!r.ok) throw new Error('incidents ' + r.status); return r.json(); })
      .then(function (fc) { incidentHazards = (fc && fc.features) || []; pushHazards(); })
      .catch(function () { lastIncidentBbox = null; /* retry this area next tick */ });
  }

  function fetchNwsAlerts() {
    if (!S.settings.showHazards) return;
    var bb = viewBBox(); if (!bb) return;
    if (lastNwsBbox && !movedFar(lastNwsBbox, bb, 0.5)) return;
    lastNwsBbox = bb;
    var cLat = (bb.minLat + bb.maxLat) / 2, cLng = (bb.minLng + bb.maxLng) / 2;
    // NWS is US-only + keyless (CORS '*'); query by the view centre. Non-US → empty.
    U.fetchT(NWS_URL + '?point=' + cLat.toFixed(4) + ',' + cLng.toFixed(4), { headers: { 'Accept': 'application/geo+json' } })
      .then(function (r) { if (!r.ok) throw new Error('nws ' + r.status); return r.json(); })
      .then(function (j) {
        var feats = (j && j.features) || [];
        alertHazards = [];
        feats.slice(0, 20).forEach(function (f) {
          var p = f.properties || {};
          // Zone-only alerts carry null geometry — there is no honest point to pin
          // them to. Falling back to the view centre stacked up to 20 identical pins
          // at a fabricated spot that moved with every pan, so skip them instead.
          var pt = alertPoint(f.geometry);
          if (!pt) return;
          alertHazards.push({
            type: 'Feature', geometry: { type: 'Point', coordinates: pt },
            properties: { kind: 'alert', label: p.event || 'Weather alert', color: alertColor(p.severity), alert: true }
          });
        });
        pushHazards();
      }).catch(function () { lastNwsBbox = null; });
  }
  // Rough centroid of an alert area so the pin sits inside it (full polygon would
  // clutter the hazard layer, which is point-based).
  function alertPoint(geom) {
    if (!geom) return null;
    if (geom.type === 'Point') return geom.coordinates;
    var ring = geom.type === 'Polygon' ? geom.coordinates[0]
      : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
    if (!ring || !ring.length) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
    return [sx / ring.length, sy / ring.length];
  }
  function alertColor(sev) {
    return sev === 'Extreme' ? '#ff2d2d' : sev === 'Severe' ? '#ff7a1a' : '#ffd23f';
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
    camera: { label: 'Speed camera', color: '#ffcf2e' }, // radar-detector MRCD/photo-enforcement
    stopped: { label: 'Stopped vehicle', color: '#ff9f43' },
    debris: { label: 'Object on road', color: '#ffd23f' },
    // live TomTom incidents + NWS weather alerts (see fetchIncidents / fetchNwsAlerts)
    closure: { label: 'Road closed', color: '#e0457b' },
    flood: { label: 'Flooding', color: '#3aa0ff' },
    alert: { label: 'Weather alert', color: '#ffd23f' }
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
      var col = (U.own(HAZARD_KINDS, r.kind) ? HAZARD_KINDS[r.kind] : HAZARD_KINDS.hazard).color;
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
      var def = U.own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
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
    ST.on('routecaps', function () { setTrafficOn(S.settings.showTraffic); fetchIncidents(); });
    // Map panned/zoomed (or first ready) — refresh the view-based hazard sources for
    // the new area. Both are gated on showHazards + bbox internally, so this is cheap.
    ST.on('mapmoved', function () { fetchIncidents(); fetchNwsAlerts(); });
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
