/* Convoy — overlays pack: weather radar, traffic heatmap, hazard pins.
   Restored from js/overlays.js (pre-cut tree a1de6fd) as a feature pack: the
   same layers on the same MapLibre map, now reached through the core's
   extension points (A.mapview.onStyle / onClick, A.net.on / send,
   A.store.registerSettings) and served only to an account holding the pack
   (packs/README.md).

   Data sources:
     - Weather:   RainViewer raster tiles (keyless, direct from the device).
     - Traffic:   TomTom flow tiles through the pack's own proxy,
                  /api/overlays/traffic/<z>/<x>/<y>.png — the key stays on the
                  server. Raster tiles cannot carry a bearer header, so the URL
                  carries the pack's signed file token (A.packs.token) instead,
                  which the server checks against the grant on every tile.
     - Incidents: TomTom traffic incidents through /api/overlays/incidents
                  (bearer), NWS weather alerts (keyless, US) direct.
     - Hazards:   Open-Meteo current conditions near the rider (keyless, direct)
                  plus hazards reported by riders near you, relayed by the
                  server as 'overlays:hazard' frames to holders in range.

   Whether traffic/incidents are available is the server's call
   (/api/overlays/caps); no key is ever read on the client. Nothing here is
   regulated, so there is no legality notice; everything defaults off. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util, ST = A.store;
  var PACK = 'overlays';
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  ST.registerSettings({
    showWeather: false,    // RainViewer precipitation radar
    weatherLayer: 'rain',  // radar colour scheme: rain | temp | wind (RainViewer palettes)
    showTraffic: false,    // TomTom flow heatmap (needs a server key)
    showHazards: false     // weather + incident + rider-reported pins
  });

  function base() { return (A.config && A.config.base) || ''; }
  function held() { return !!(A.packs && A.packs.has(PACK)); }
  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  /* ---------------- server capabilities ---------------- */
  var caps = { traffic: false, incidents: false };
  function fetchCaps() {
    if (!held()) return Promise.resolve(caps);
    return U.fetchT(base() + '/api/overlays/caps', { headers: A.packs.authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return caps;
        caps = { traffic: !!j.traffic, incidents: !!j.incidents };
        setTrafficOn(S.settings.showTraffic);
        fetchIncidents();
        ST.emit('overlays:caps', caps);
        return caps;
      }).catch(function () { return caps; });
  }
  function trafficOn() { return !!(caps.traffic && held()); }
  function incidentsOn() { return !!(caps.incidents && held()); }

  /* ---------------- traffic (TomTom flow tiles via the pack proxy) ---------------- */
  var TRAFFIC_REFRESH_MS = 90000;  // live congestion changes fast; re-fetch visible tiles
  var TOKEN_FRESH_MS = 10 * 60 * 1000; // file tokens live 15 min: refresh them before they lapse
  var trafficTimer = null;
  function tileTemplate(bust) {
    var t = A.packs && A.packs.token(PACK);
    var q = (t ? 't=' + encodeURIComponent(t) : '') + (bust ? (t ? '&' : '') + '_v=' + bust : '');
    return base() + '/api/overlays/traffic/{z}/{x}/{y}.png' + (q ? '?' + q : '');
  }
  // Re-point the source at the same proxy with a bumped cache-buster so MapLibre
  // re-fetches every visible tile — with a fresh token when the current one is
  // getting old (a lapsed token is a 401 per tile, i.e. a blank layer).
  function refreshTraffic() {
    var apply = function () {
      var m = map();
      if (m && m.getSource('traffic')) m.getSource('traffic').setTiles([tileTemplate(Date.now())]);
    };
    if (A.packs && A.packs.tokenAgeMs() > TOKEN_FRESH_MS) A.packs.sync().then(apply, apply); else apply();
  }

  /* ---------------- weather (RainViewer) ---------------- */
  var RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
  var RV_COLOR = { rain: 4, temp: 2, wind: 7 };
  var rvHost = 'https://tilecache.rainviewer.com';
  var rvPath = '';
  var rvTimer = null;
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  function rvColor() { var k = S.settings.weatherLayer; return RV_COLOR[k] != null ? RV_COLOR[k] : 4; }
  // RainViewer's free API serves 512px tiles; tileSize and the path must agree.
  function rvTileUrl() { return rvHost + rvPath + '/512/{z}/{x}/{y}/' + rvColor() + '/1_1.png'; }
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

  /* ---------------- hazards ---------------- */
  var HAZARD_POLL_MS = 5 * 60 * 1000;
  var HAZARD_MOVE_KM = 8;
  var hazardTimer = null;
  var lastHazPos = null;
  var weatherHazards = [];
  var reportedHazards = [];
  var incidentHazards = [], alertHazards = [];
  var incidentTimer = null, nwsTimer = null;
  var lastIncidentBbox = null, lastNwsBbox = null;
  var INCIDENT_MS = 2 * 60 * 1000;
  var NWS_MS = 5 * 60 * 1000;
  var NWS_URL = 'https://api.weather.gov/alerts/active';

  /* ---------------- sources + layers (every style.load, idempotent) ---------------- */
  function ensure(m) {
    m = m || map();
    if (!m) return;
    if (!m.getSource('weather')) {
      m.addSource('weather', {
        type: 'raster', tiles: [rvTileUrl()], tileSize: 512, minzoom: 0, maxzoom: 7,
        attribution: 'Radar © <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'
      });
    }
    addRaster(m, 'weather', 0.7, true);
    if (!m.getSource('traffic')) {
      m.addSource('traffic', {
        type: 'raster', tiles: [tileTemplate()], tileSize: 256,
        attribution: 'Traffic © <a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>'
      });
    }
    addRaster(m, 'traffic', 0.6);
    if (!m.getSource('hazards')) m.addSource('hazards', { type: 'geojson', data: emptyFC() });
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
    registerHazardIcons(m);
    if (!m.getLayer('hazard-icon')) {
      m.addLayer({
        id: 'hazard-icon', type: 'symbol', source: 'hazards',
        layout: {
          'icon-image': hazardIconExpr(),
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.45, 14, 0.6, 18, 0.85],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      });
    }
    applyAll();
    pushHazards();
  }

  /* ---------------- hazard glyphs ---------------- */
  var HAZARD_ICONS = {
    accident: 'M5 16l1.7-4.6A3 3 0 0 1 9.5 9.4h5a3 3 0 0 1 2.8 2L19 16 M4 16h16v3h-2.5v-1.6h-11V19H4Z M9 6l1.4 2.2 M15.5 5l-1 2.4',
    stopped:  'M5 16l1.6-4.7A3 3 0 0 1 9.4 9.4h5.2a3 3 0 0 1 2.8 1.9L19 16 M4 16.5h16v3h-2.6v-1.5H6.6v1.5H4Z',
    police:   'M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6Z M9.5 11.5l1.8 1.8 3.4-3.6',
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
  var HZ_PX = 40;
  function makeHazardIcon(d) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = HZ_PX;
    var ctx = cv.getContext('2d');
    var pad = 7, scale = (HZ_PX - pad * 2) / 24;
    ctx.translate(pad, pad); ctx.scale(scale, scale);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var path = new Path2D(d);
    ctx.strokeStyle = 'rgba(8,12,18,.85)'; ctx.lineWidth = 3.6; ctx.stroke(path);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(path);
    return ctx.getImageData(0, 0, HZ_PX, HZ_PX);
  }
  function hazardIconExpr() {
    var expr = ['match', ['get', 'kind']];
    for (var kind in HAZARD_ICONS) {
      if (!own(HAZARD_ICONS, kind) || kind === 'hazard') continue;
      expr.push(kind, 'hz-' + kind);
    }
    expr.push('hz-hazard');
    return expr;
  }
  function registerHazardIcons(m) {
    for (var kind in HAZARD_ICONS) {
      if (!own(HAZARD_ICONS, kind)) continue;
      var id = 'hz-' + kind;
      if (m.hasImage(id)) continue;
      try { m.addImage(id, makeHazardIcon(HAZARD_ICONS[kind]), { pixelRatio: 2 }); } catch (e) { /* no canvas: bare discs */ }
    }
  }

  function addRaster(m, id, opacity, zoomFade) {
    if (m.getLayer(id)) return;
    var opacityExpr = zoomFade
      ? ['interpolate', ['linear'], ['zoom'], 0, opacity, 8, opacity * 0.7, 12, opacity * 0.35, 15, opacity * 0.12]
      : opacity;
    m.addLayer({
      id: id, type: 'raster', source: id,
      layout: { visibility: 'none' },   // revealed by applyAll()/setWeatherOn() once ready
      paint: { 'raster-opacity': opacityExpr }
    }, symbolLayerId(m));
  }
  function symbolLayerId(m) {
    var style = m.getStyle && m.getStyle();
    var layers = (style && style.layers) || [];
    for (var i = 0; i < layers.length; i++) if (layers[i].type === 'symbol') return layers[i].id;
    return undefined;
  }

  /* ---------------- visibility ---------------- */
  function applyAll() {
    if (!map()) return;
    setWeatherOn(!!(S.settings.showWeather && held()));
    setTrafficOn(!!S.settings.showTraffic);
    if (S.settings.showHazards && held()) startHazards(); else stopHazards();
  }
  function setVisible(id, show) {
    var m = map(); if (!m || !m.getLayer(id)) return;
    m.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }
  function setWeatherOn(on) {
    var m = map(); if (!m || !m.getLayer('weather')) return;
    if (on) {
      refreshRadar().then(function () {
        if (rvPath && S.settings.showWeather && held()) setVisible('weather', true);
      });
      if (!rvTimer) rvTimer = U.poll(refreshRadar, 5 * 60 * 1000);
    } else {
      setVisible('weather', false);
      rvTimer = U.unpoll(rvTimer);
    }
  }
  function setTrafficOn(on) {
    on = !!(on && trafficOn());
    setVisible('traffic', on);
    if (on) {
      if (!trafficTimer) { refreshTraffic(); trafficTimer = U.poll(refreshTraffic, TRAFFIC_REFRESH_MS); }
    } else if (trafficTimer) {
      trafficTimer = U.unpoll(trafficTimer);
    }
  }
  function setWeatherLayer() {
    var m = map(); if (!m) return;
    var src = m.getSource('weather');
    if (src) src.setTiles([rvTileUrl()]);
  }

  /* ---------------- hazards: conditions near the rider, incidents + alerts in view ---------------- */
  function startHazards() {
    if (hazardTimer) return;
    pollHazards();
    fetchIncidents();
    fetchNwsAlerts();
    hazardTimer = U.poll(pollHazards, HAZARD_POLL_MS);
    if (!incidentTimer) incidentTimer = U.poll(fetchIncidents, INCIDENT_MS);
    if (!nwsTimer) nwsTimer = U.poll(fetchNwsAlerts, NWS_MS);
  }
  function stopHazards() {
    hazardTimer = U.unpoll(hazardTimer);
    incidentTimer = U.unpoll(incidentTimer);
    nwsTimer = U.unpoll(nwsTimer);
    weatherHazards = []; incidentHazards = []; alertHazards = [];
    lastIncidentBbox = null; lastNwsBbox = null; lastHazPos = null;
    var m = map(); if (m && m.getSource('hazards')) m.getSource('hazards').setData(emptyFC());
  }

  // A rider-reported hazard at the rider's own position: a local pin at once,
  // and the server relays it to riders nearby who hold the pack.
  function reportHazard(kind, labelOverride) {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return false;
    var def = own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
    var label = labelOverride || def.label;
    reportedHazards.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos.slice() },
      properties: { kind: kind, label: label, color: def.color, reported: true, by: A.net && A.net.myId ? A.net.myId() : null }
    });
    capReports();
    pushHazards();
    if (A.net && A.net.isLive && A.net.isLive()) {
      A.net.send({ t: 'overlays:report', lat: pos[1], lng: pos[0], kind: kind, label: label });
    }
    if (A.ui) A.ui.toast(label + ' reported', 'info');
    return true;
  }
  var REPORT_CAP = 120;
  function capReports() { while (reportedHazards.length > REPORT_CAP) reportedHazards.shift(); }
  // A hazard relayed from another rider ('overlays:hazard').
  function addReportedHazard(payload) {
    if (!payload || typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return;
    if (!isFinite(payload.lat) || !isFinite(payload.lng)) return;
    var me = A.net && A.net.myId ? A.net.myId() : null;
    if (me && payload.by === me) return;   // our own echo — drawn at report time
    var kind = typeof payload.kind === 'string' && own(HAZARD_KINDS, payload.kind) ? payload.kind : 'hazard';
    var def = HAZARD_KINDS[kind];
    reportedHazards.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [payload.lng, payload.lat] },
      properties: { kind: kind, label: typeof payload.label === 'string' && payload.label ? payload.label.slice(0, 48) : def.label, color: def.color, reported: true, crowd: true, by: payload.by || null }
    });
    capReports();
    pushHazards();
  }

  function pollHazards() {
    var pos = A.sim ? A.sim.playerPos() : null;
    if (!pos) return;
    if (lastHazPos && U.haversine(lastHazPos, pos) < HAZARD_MOVE_KM * 1000) { pushHazards(); return; }
    lastHazPos = pos.slice();
    var url = FORECAST + '?latitude=' + pos[1].toFixed(4) + '&longitude=' + pos[0].toFixed(4) +
      '&current=weather_code,precipitation,snowfall,wind_speed_10m,temperature_2m';
    U.fetchT(url).then(function (r) { if (!r.ok) throw new Error('w ' + r.status); return r.json(); })
      .then(function (j) { weatherHazards = scanHazards(j && j.current, pos); pushHazards(); })
      .catch(function () { /* keep the previous pins */ });
  }
  function scanHazards(cur, pos) {
    if (!cur) return [];
    var out = [];
    var code = cur.weather_code != null ? cur.weather_code : -1;
    var rain = cur.precipitation || 0, snow = cur.snowfall || 0, wind = cur.wind_speed_10m || 0, temp = cur.temperature_2m;
    if (rain >= 4) out.push(hazFeat('rain', 'Heavy rain', pos));
    if (snow >= 1) out.push(hazFeat('snow', 'Snowfall', pos));
    if (temp != null && temp <= 0.5 && (rain > 0 || snow > 0)) out.push(hazFeat('ice', 'Icy road', pos));
    if (wind >= 50) out.push(hazFeat('wind', 'High winds ' + Math.round(wind) + ' km/h', pos));
    if (code === 45 || code === 48) out.push(hazFeat('fog', 'Fog', pos));
    return out;
  }
  function hazFeat(kind, label, pos) {
    var def = own(HAZARD_KINDS, kind) ? HAZARD_KINDS[kind] : HAZARD_KINDS.hazard;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: pos.slice() }, properties: { kind: kind, label: label, color: def.color } };
  }
  function pushHazards() {
    var m = map();
    if (m && m.getSource('hazards')) {
      m.getSource('hazards').setData({ type: 'FeatureCollection', features: weatherHazards.concat(reportedHazards, incidentHazards, alertHazards) });
    }
  }

  function viewBBox() {
    var m = map(); if (!m || !m.getBounds) return null;
    var b = m.getBounds();
    return { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() };
  }
  function movedFar(prev, bb, deg) {
    if (!prev) return true;
    if (Math.abs(bb.minLat - prev.minLat) > deg || Math.abs(bb.minLng - prev.minLng) > deg) return true;
    var prevSpan = (prev.maxLng - prev.minLng) + (prev.maxLat - prev.minLat);
    var span = (bb.maxLng - bb.minLng) + (bb.maxLat - bb.minLat);
    return Math.abs(span - prevSpan) > deg;
  }
  function fetchIncidents() {
    if (!S.settings.showHazards || !incidentsOn()) return;
    var bb = viewBBox(); if (!bb) return;
    if (lastIncidentBbox && !movedFar(lastIncidentBbox, bb, 0.2)) return;
    lastIncidentBbox = bb;
    U.fetchT(base() + '/api/overlays/incidents', {
      method: 'POST', headers: A.packs.authHeaders(true),
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat] })
    }).then(function (r) { if (!r.ok) throw new Error('incidents ' + r.status); return r.json(); })
      .then(function (fc) { incidentHazards = (fc && fc.features) || []; pushHazards(); })
      .catch(function () { lastIncidentBbox = null; });
  }
  function fetchNwsAlerts() {
    if (!S.settings.showHazards || !held()) return;
    var bb = viewBBox(); if (!bb) return;
    if (lastNwsBbox && !movedFar(lastNwsBbox, bb, 0.5)) return;
    lastNwsBbox = bb;
    var cLat = (bb.minLat + bb.maxLat) / 2, cLng = (bb.minLng + bb.maxLng) / 2;
    U.fetchT(NWS_URL + '?point=' + cLat.toFixed(4) + ',' + cLng.toFixed(4), { headers: { 'Accept': 'application/geo+json' } })
      .then(function (r) { if (!r.ok) throw new Error('nws ' + r.status); return r.json(); })
      .then(function (j) {
        var feats = (j && j.features) || [];
        alertHazards = [];
        feats.slice(0, 20).forEach(function (f) {
          var p = f.properties || {};
          var pt = alertPoint(f.geometry);
          if (!pt) return;
          alertHazards.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pt },
            properties: { kind: 'alert', label: p.event || 'Weather alert', color: alertColor(p.severity), alert: true } });
        });
        pushHazards();
      }).catch(function () { lastNwsBbox = null; });
  }
  function alertPoint(geom) {
    if (!geom) return null;
    if (geom.type === 'Point') return geom.coordinates;
    var ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
    if (!ring || !ring.length) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
    return [sx / ring.length, sy / ring.length];
  }
  function alertColor(sev) { return sev === 'Extreme' ? '#ff2d2d' : sev === 'Severe' ? '#ff7a1a' : '#ffd23f'; }

  var HAZARD_KINDS = {
    rain: { label: 'Heavy rain', color: '#3aa0ff' },
    snow: { label: 'Snowfall', color: '#cfe6ff' },
    ice: { label: 'Icy road', color: '#7fe3ff' },
    wind: { label: 'High winds', color: '#c39cff' },
    fog: { label: 'Fog', color: '#9aa3b0' },
    hazard: { label: 'Hazard', color: '#ff5a3c' },
    accident: { label: 'Accident', color: '#ff3b3b' },
    police: { label: 'Police', color: '#3b82f6' },
    camera: { label: 'Speed camera', color: '#ffcf2e' },
    stopped: { label: 'Stopped vehicle', color: '#ff9f43' },
    debris: { label: 'Object on road', color: '#ffd23f' },
    closure: { label: 'Road closed', color: '#e0457b' },
    flood: { label: 'Flooding', color: '#3aa0ff' },
    alert: { label: 'Weather alert', color: '#ffd23f' }
  };
  var HZ_WEATHER = { rain: 1, snow: 1, ice: 1, wind: 1, fog: 1, flood: 1, alert: 1 };

  /* ---------------- tap on a pin → description popup ---------------- */
  function compass8(deg) {
    var names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  function relAgo(ts) {
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }
  function showHazardPopup(props, lngLat) {
    props = props || {};
    var color = /^#[0-9a-f]{3,8}$/i.test(String(props.color)) ? props.color : '#ff5a3c';
    var src = props.tomtom ? 'TomTom traffic' : props.alert ? 'NWS weather alert'
      : props.crowd ? 'Reported by a rider' : props.reported ? 'You reported this' : 'Local conditions';
    var cat = HZ_WEATHER[props.kind] ? 'Weather' : 'Road hazard';
    var me = A.sim && A.sim.playerPos && A.sim.playerPos();
    var dirText = '';
    if (me && lngLat && (me[0] !== lngLat[0] || me[1] !== lngLat[1])) {
      dirText = U.fmtDist(U.haversine(me, lngLat), S.settings.units) + ' to the ' + compass8(U.bearing(me, lngLat));
    }
    var extra = [];
    if (dirText) extra.push('<span class="tag"><span class="dot" style="background:' + color + '"></span>' + U.esc(dirText) + '</span>');
    if (props.when) { var w = new Date(props.when); if (!isNaN(w)) extra.push('<span class="tag tag-delayed">' + relAgo(w.getTime()) + '</span>'); }
    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + color + '"><span class="dot" style="background:' + color + '"></span></div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.label || 'Hazard') + '</div>' +
      '  <div class="u-handle">' + cat + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' + extra.join('') +
        '<span class="tag tag-delayed"><span class="dot dot-global"></span>' + U.esc(src) + '</span>' +
      '</div>';
    if (A.mapview && A.mapview.openPopup) A.mapview.openPopup(lngLat, card);
  }
  function onMapClick(e, m) {
    if (!held() || !m) return false;
    var hz = ['hazard-icon', 'hazard-circle'].filter(function (id) { return m.getLayer(id); });
    if (!hz.length) return false;
    var hf = m.queryRenderedFeatures(e.point, { layers: hz });
    if (!hf || !hf.length) return false;
    showHazardPopup(hf[0].properties, hf[0].geometry.coordinates.slice());
    return true;
  }

  /* ---------------- the report picker ---------------- */
  var REPORT_KINDS = [
    { kind: 'accident', label: 'Accident', icon: '<path d="M5 16l1.7-4.6A3 3 0 0 1 9.5 9.4h5a3 3 0 0 1 2.8 2L19 16"/><path d="M4 16h16v3h-2.5v-1.6h-11V19H4Z"/><path d="m9 6 1.4 2.2M15.5 5l-1 2.4"/>' },
    { kind: 'debris', label: 'Object', icon: '<path d="M12 4 21.5 20H2.5Z"/><path d="M12 10.5v4M12 17.4v.02"/>' },
    { kind: 'stopped', label: 'Stopped car', icon: '<path d="M5 16l1.6-4.7A3 3 0 0 1 9.4 9.4h5.2a3 3 0 0 1 2.8 1.9L19 16"/><path d="M4 16.5h16v3h-2.6v-1.5H6.6v1.5H4Z"/>' },
    { kind: 'ice', label: 'Icy road', icon: '<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9M9 4.2l3 2 3-2M9 19.8l3-2 3 2M4.6 12H2.8M21.2 12h-1.8"/>' },
    { kind: 'fog', label: 'Fog', icon: '<path d="M4 8.5h13M7 12h13M5 15.5h12"/>' },
    { kind: 'flood', label: 'Flooding', icon: '<path d="M8 11l4-4 4 4"/><path d="M3 14.5c2 0 2 1.4 4 1.4s2-1.4 4-1.4 2 1.4 4 1.4 2-1.4 4-1.4M3 18.5c2 0 2 1.4 4 1.4s2-1.4 4-1.4 2 1.4 4 1.4 2-1.4 4-1.4"/>' }
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
    var btns = REPORT_KINDS.map(function (r) {
      var col = (own(HAZARD_KINDS, r.kind) ? HAZARD_KINDS[r.kind] : HAZARD_KINDS.hazard).color;
      return '<button class="hazard-btn" type="button" data-kind="' + r.kind + '">' +
        '<span class="hz-ic" style="color:' + col + '"><svg viewBox="0 0 24 24">' + r.icon + '</svg></span>' +
        '<span class="hz-lb">' + U.esc(r.label) + '</span></button>';
    }).join('');
    reportOverlay.innerHTML =
      '<div class="hazard-modal" role="document">' +
      '  <header class="hazard-head">' +
      '    <div><h2>Report a hazard</h2><span class="hazard-sub">drops a pin at your location for riders nearby</span></div>' +
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
    if (!S.settings.showHazards) ST.setSetting('showHazards', true, 'hazards');
    reportHazard(kind);
    closeReport();
  }
  var reportLastFocus = null;
  function openReport() {
    if (!held()) return;
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
    if (reportLastFocus) { try { reportLastFocus.focus(); } catch (e) { /* gone */ } reportLastFocus = null; }
  }

  /* ---------------- wiring ---------------- */
  function showCtl(on) {
    var hz = document.getElementById('ctl-hazard');
    if (hz) hz.hidden = !on;
  }
  function standDown() {
    showCtl(false);
    setWeatherOn(false);
    setTrafficOn(false);
    stopHazards();
    closeReport();
  }
  function init() {
    A.mapview.onStyle(ensure);
    A.mapview.onClick(onMapClick);
    var hz = document.getElementById('ctl-hazard');
    if (hz) hz.addEventListener('click', openReport);
    ST.on('setting', function (e) {
      if (!e || !e.key || !held()) return;
      if (e.key === 'showWeather') setWeatherOn(!!e.val);
      else if (e.key === 'showTraffic') setTrafficOn(e.val);
      else if (e.key === 'showHazards') { if (e.val) startHazards(); else stopHazards(); }
      else if (e.key === 'weatherLayer') setWeatherLayer();
    });
    ST.on('mapmoved', function () { if (held()) { fetchIncidents(); fetchNwsAlerts(); } });
    A.net.on('overlays:hazard', function (m) { if (held()) addReportedHazard(m); });
    // Held or not is the server's word (the 'packs' event); stand down the
    // moment it says no, come back when it says yes again.
    ST.on('packs', function () { if (held()) { showCtl(true); fetchCaps(); applyAll(); } else standDown(); });
    showCtl(held());
    fetchCaps();
    applyAll();
  }

  A.overlays = {
    init: init,
    ensure: ensure,
    applyAll: applyAll,
    reportHazard: reportHazard,
    addReportedHazard: addReportedHazard,
    openReport: openReport,
    closeReport: closeReport,
    caps: function () { return caps; },
    hasTrafficKey: function () { return trafficOn(); },
    kinds: function () { return HAZARD_KINDS; },
    // test surface
    _scanHazards: scanHazards, _alertPoint: alertPoint, _movedFar: movedFar, _tileTemplate: tileTemplate, _setCaps: function (c) { caps = c; }
  };
})();
