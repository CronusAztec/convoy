/* Convoy — Ghost Mode data sources.
   Client-side fetchers for live aircraft (OpenSky Network, anonymous) and
   nearby police stations (OpenStreetMap via Overpass). Runs only while Ghost
   Mode is on. All fetches degrade gracefully: a network error or empty result
   simply yields an empty layer (no crash, no stale data).

   OpenSky:   https://openskynetwork.github.io/opensky-api/rest.html  (anonymous, live states)
   Overpass:  https://wiki.openstreetmap.org/wiki/Overpass_API          (amenity=police POIs) */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, U = A.util;

  var OPENSKY = 'https://opensky-network.org/api/states/all';
  var ADSBX = 'https://api.airplanes.live/v2/point'; // /{lat}/{lon}/{radiusNm} — keyless ADS-B Exchange-format feed
  var OVERPASS = 'https://overpass-api.de/api/interpreter';

  var ADSBX_MS = 3000;       // ADS-B Exchange (airplanes.live) — fast/live, well within its ~1/s budget
  var OPENSKY_MS = 12000;    // OpenSky anonymous — slower, rate-limit friendly; supplements ADSBx
  var POLICE_MS = 90000;     // 90s — POIs are static; refetch when bounds move
  var WAZE_MS = 60000;       // 60s — live Waze police sightings (transient; faster than static POIs)
  var HOT_MS = 5 * 60 * 1000; // 5 min — probability stats change hourly, so slow is fine
  var MAX_BBOX_DEG = 4;      // never query more than a ~4° box (avoid hammering the API)

  var adTimer = null;
  var osTimer = null;
  var poTimer = null;
  var wzTimer = null;
  var hotTimer = null;
  var lastPoliceBbox = null; // {minLat,minLng,maxLat,maxLng} last queried
  var lastWazeBbox = null;   // separate bbox gate — Waze refreshes faster than static POIs
  var lastHotBbox = null;    // hotspots refetch on a wider pan than live sightings
  var running = false;

  // Per-source aircraft caches (raw normalized objects). Each source refreshes on its
  // own cadence and republishes the merged set; a failed poll keeps that source's
  // last-good list so dots don't flicker.
  var acAdsbx = [], acOpenSky = [];
  // Police layer = static OSM POIs (stations/cameras/ALPR) MERGED with live Waze
  // police sightings. Each source caches independently; publishPolice() merges them
  // so a stale Waze poll never blanks the static POIs (and vice-versa).
  var policeOSM = [], policeWaze = [];

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }

  // Clamp the current view to a sane bounding box for querying.
  function viewBBox() {
    var m = map();
    if (!m) return null;
    var b = m.getBounds();
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var minLat = Math.max(-90, sw.lat), maxLat = Math.min(90, ne.lat);
    var minLng = Math.max(-180, sw.lng), maxLng = Math.min(180, ne.lng);
    // if the world wraps (tiny zoom), shrink to a manageable box around center
    var cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
    if (maxLat - minLat > MAX_BBOX_DEG) { minLat = cLat - MAX_BBOX_DEG / 2; maxLat = cLat + MAX_BBOX_DEG / 2; }
    if (maxLng - minLng > MAX_BBOX_DEG) { minLng = cLng - MAX_BBOX_DEG / 2; maxLng = cLng + MAX_BBOX_DEG / 2; }
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  /* ---------------- aircraft (OpenSky + ADS-B Exchange, merged) ----------------
     Two live sources deduped by ICAO hex. ADS-B Exchange (via the keyless
     airplanes.live mirror, same v2 schema) wins on a hex collision — it carries
     aircraft type / registration / military flag; OpenSky fills any hexes ADS-B
     Exchange didn't return. Either source failing degrades to the other; both
     failing keeps the previous dots (transient-error friendly).
     OpenSky state row: [icao24, callsign, origin_country, lastContact, lon, lat,
       baro_altitude(m), on_ground, velocity(m/s), true_track(deg), ...]
     ADSBx ac entry: { hex, flight, r(reg), t(type), lat, lon, alt_baro(ft|'ground'),
       gs(knots), track(deg), category(A1..A7), dbFlags(&1=military) } */
  var KNOTS_MS = 0.514444, FT_M = 0.3048;

  function fetchOpenSky(bb) {
    var url = OPENSKY + '?lamin=' + bb.minLat.toFixed(3) + '&lomin=' + bb.minLng.toFixed(3) +
      '&lamax=' + bb.maxLat.toFixed(3) + '&lomax=' + bb.maxLng.toFixed(3);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('opensky ' + r.status);
      return r.json();
    }).then(function (j) {
      var out = [], states = j && j.states ? j.states : [];
      for (var i = 0; i < states.length; i++) {
        var s = states[i], lon = s[5], lat = s[6];
        if (lat == null || lon == null) continue;
        out.push({
          hex: (s[0] || '').toLowerCase(), callsign: (s[1] || '').trim(), country: s[2] || '',
          lat: lat, lon: lon, alt: s[7] != null ? s[7] : null, ground: !!s[8],
          speed: s[9] != null ? s[9] : null, heading: s[10] != null ? s[10] : null,
          reg: '', acType: '', category: '', mil: false, src: 'opensky'
        });
      }
      return out;
    }).catch(function () { return null; }); // null = errored (vs [] = genuinely empty)
  }

  function fetchAdsbx(bb) {
    var cLat = (bb.minLat + bb.maxLat) / 2, cLng = (bb.minLng + bb.maxLng) / 2;
    var cornerM = U.haversine([cLng, cLat], [bb.maxLng, bb.maxLat]);
    var radNm = Math.min(250, Math.max(5, Math.ceil(cornerM / 1852)));
    var url = ADSBX + '/' + cLat.toFixed(4) + '/' + cLng.toFixed(4) + '/' + radNm;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('adsbx ' + r.status);
      return r.json();
    }).then(function (j) {
      var out = [], ac = j && j.ac ? j.ac : [];
      for (var i = 0; i < ac.length; i++) {
        var a = ac[i];
        if (a.lat == null || a.lon == null) continue;
        var ground = a.alt_baro === 'ground';
        var altFt = typeof a.alt_baro === 'number' ? a.alt_baro
          : (typeof a.alt_geom === 'number' ? a.alt_geom : null);
        out.push({
          hex: (a.hex || '').toLowerCase(), callsign: (a.flight || '').trim(), country: '',
          lat: a.lat, lon: a.lon,
          alt: altFt != null ? altFt * FT_M : (ground ? 0 : null), ground: ground,
          speed: typeof a.gs === 'number' ? a.gs * KNOTS_MS : null,
          heading: typeof a.track === 'number' ? a.track
            : (typeof a.true_heading === 'number' ? a.true_heading : null),
          reg: a.r || '', acType: a.t || '', category: a.category || '',
          mil: !!(a.dbFlags & 1), src: 'adsbx'
        });
      }
      return out;
    }).catch(function () { return null; });
  }

  function toAircraftFeature(a) {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: {
        callsign: a.callsign || a.reg || '—', icao: a.hex || '', country: a.country || '',
        alt: a.alt, ground: !!a.ground, speed: a.speed, heading: a.heading,
        reg: a.reg || '', acType: a.acType || '', category: a.category || '',
        mil: !!a.mil, src: a.src
      }
    };
  }

  function publishAircraft() {
    var lists = [acAdsbx, acOpenSky]; // ADSBx first ⇒ keeps the slot on a hex collision
    var byKey = {}, order = [];
    for (var L = 0; L < lists.length; L++) {
      for (var i = 0; i < lists[L].length; i++) {
        var a = lists[L][i];
        var k = a.hex || ('_' + a.lat.toFixed(4) + ',' + a.lon.toFixed(4));
        if (k in byKey) continue;
        byKey[k] = a; order.push(k);
      }
    }
    var feats = [];
    for (var n = 0; n < order.length; n++) feats.push(toAircraftFeature(byKey[order[n]]));
    if (A.mapview && A.mapview.setAircraftData) A.mapview.setAircraftData({
      type: 'FeatureCollection', features: feats
    });
  }

  function pollAdsbx() {
    if (!running) return;
    var bb = viewBBox();
    if (!bb) return;
    fetchAdsbx(bb).then(function (list) {
      if (!running || list == null) return; // error → keep previous ADSBx dots
      acAdsbx = list;
      publishAircraft();
    });
  }

  function pollOpenSky() {
    if (!running) return;
    var bb = viewBBox();
    if (!bb) return;
    fetchOpenSky(bb).then(function (list) {
      if (!running || list == null) return; // error → keep previous OpenSky dots
      acOpenSky = list;
      publishAircraft();
    });
  }

  /* ---------------- ground law enforcement (Overpass / OSM) ----------------
     police stations (nodes + buildings) + speed/enforcement cameras. Each feature
     carries a `kind` ('police' | 'camera') so the map + radar style them apart. */
  function bboxChanged(bb) {
    if (!lastPoliceBbox) return true;
    // refetch if the view center moved more than ~half the last box, or grew a lot
    var movedLat = Math.abs(((bb.minLat + bb.maxLat) / 2) - ((lastPoliceBbox.minLat + lastPoliceBbox.maxLat) / 2));
    var movedLng = Math.abs(((bb.minLng + bb.maxLng) / 2) - ((lastPoliceBbox.minLng + lastPoliceBbox.maxLng) / 2));
    return movedLat > 0.6 || movedLng > 0.6;
  }

  function fetchPolice() {
    if (!running) return;
    var bb = viewBBox();
    if (!bb) return;
    if (lastPoliceBbox && !bboxChanged(bb)) return; // static POIs — skip if same area
    lastPoliceBbox = bb;
    var box = bb.minLat + ',' + bb.minLng + ',' + bb.maxLat + ',' + bb.maxLng;
    // police stations + speed cameras + ALPR/surveillance cameras (DeFlock's 336K+
    // license-plate-reader locations are tagged man_made=surveillance in OSM).
    // One query, one fetch — these are all static enforcement POIs on the same cadence.
    var q = '[out:json][timeout:25];(' +
      'node["amenity"="police"](' + box + ');' +
      'way["amenity"="police"](' + box + ');' +
      'node["highway"="speed_camera"](' + box + ');' +
      'node["man_made"="surveillance"](' + box + ');' +
      'way["man_made"="surveillance"](' + box + ');' +
      ');out center 200;';
    fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    }).then(function (r) {
      if (!r.ok) throw new Error('overpass ' + r.status);
      return r.json();
    }).then(function (j) {
      var feats = [];
      var els = j && j.elements ? j.elements : [];
      for (var i = 0; i < els.length; i++) {
        var e = els[i], tags = e.tags || {};
        var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
        var lon = e.lon != null ? e.lon : (e.center && e.center.lon);
        if (lat == null || lon == null) continue;
        var kind, name;
        if (tags.highway === 'speed_camera') {
          kind = 'camera';
          name = tags.name || (tags.maxspeed ? 'Speed camera · ' + tags.maxspeed : 'Speed camera');
        } else if (tags.man_made === 'surveillance') {
          // ALPR / license-plate-reader / surveillance camera (DeFlock data).
          // surveillance:type values: ALPR, camera, guard, etc. — surface the type.
          var stype = tags['surveillance:type'] || tags.surveillance || '';
          kind = 'alpr';
          name = tags.name || (stype ? ('Surveillance · ' + stype) : 'ALPR / surveillance camera');
        } else if (tags.amenity === 'police') {
          kind = 'police';
          name = tags.name || tags['name:en'] || 'Police station';
        } else { continue; }
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { name: name, kind: kind }
        });
      }
      policeOSM = feats;       // cache static POIs; publishPolice() merges with Waze
      publishPolice();
    }).catch(function () { /* graceful: keep previous or empty */ });
  }

  /* ---------------- live Waze police (via our server proxy → RapidAPI) ----------------
     The RapidAPI key is a server secret; the client hits /api/waze with a bbox and
     the server forwards to Waze with the key injected. Live sightings are transient,
     so we poll faster (WAZE_MS) and on a separate bbox gate from the static POIs. Only
     opted in when the server reports it has a key (A.config.routeCaps.waze). */
  function wazeOn() { return !!(A.config && A.config.routeCaps && A.config.routeCaps.waze); }
  function wazeBboxChanged(bb) {
    if (!lastWazeBbox) return true;
    var dLat = Math.abs(bb.minLat - lastWazeBbox.minLat), dLng = Math.abs(bb.minLng - lastWazeBbox.minLng);
    return dLat > 0.15 || dLng > 0.15; // Waze sightings move; refetch on a smaller pan than static POIs
  }
  function fetchWaze() {
    if (!running || !wazeOn()) return;
    var bb = viewBBox();
    if (!bb) return;
    if (lastWazeBbox && !wazeBboxChanged(bb)) return;
    lastWazeBbox = bb;
    fetch((A.config ? A.config.base : '') + '/api/waze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat] })
    }).then(function (r) { if (!r.ok) throw new Error('waze ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!running) return;
        // The proxy already classified alerts into {kind,label,color}; only police
        // belong on the Ghost police layer — hazards have their own layer.
        policeWaze = ((fc && fc.features) || []).filter(function (f) {
          return f.properties && f.properties.kind === 'police';
        });
        publishPolice();
      }).catch(function () { /* keep previous Waze pins */ });
  }

  // Merge static OSM POIs + live Waze sightings into the single police source.
  // Mirrors publishAircraft(): either source failing keeps its last-good cache so
  // a transient Waze error never blanks the static stations.
  function publishPolice() {
    if (!A.mapview || !A.mapview.setPoliceData) return;
    A.mapview.setPoliceData({
      type: 'FeatureCollection',
      features: policeOSM.concat(policeWaze)
    });
  }

  /* ---------------- police probability hotspots (server-accumulated) ----------------
     Where police are USUALLY seen at the current hour — derived server-side from
     accumulated Waze + crowd police sightings (see server/hotspots.js). Distinct
     from the live police layer: live sightings show "where they are now"; hotspots
     show "where they tend to be at this time of day". Empty until the server has
     gathered enough observations (day-1 is correctly empty — no fabricated data). */
  // Gated by BOTH the server capability and the user's "Police hotspots" toggle.
  function hotspotsOn() {
    return !!(A.config && A.config.routeCaps && A.config.routeCaps.hotspots) &&
           (S.settings.ghostHotspots !== false);
  }
  function hotBboxChanged(bb) {
    if (!lastHotBbox) return true;
    // Stats move slowly; refetch only on a substantial pan (wider than live sightings).
    var dLat = Math.abs(bb.minLat - lastHotBbox.minLat), dLng = Math.abs(bb.minLng - lastHotBbox.minLng);
    return dLat > 0.3 || dLng > 0.3;
  }
  // null = "now" (live local hour); 0..23 = a previewed hour via the legend scrubber.
  var hotPreviewHour = null;
  function hotHour() { return hotPreviewHour == null ? new Date().getHours() : hotPreviewHour; }
  function fetchHotspots() {
    if (!running || !hotspotsOn()) return;
    var bb = viewBBox();
    if (!bb) return;
    if (lastHotBbox && !hotBboxChanged(bb)) return;
    lastHotBbox = bb;
    // Pass the viewer's LOCAL hour (or a previewed hour) — police patterns are
    // local ("morning rush" = local morning), not UTC. The server folds ±1h.
    var hour = hotHour();
    fetch((A.config ? A.config.base : '') + '/api/hotspots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat], hour: hour })
    }).then(function (r) { if (!r.ok) throw new Error('hotspots ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!running) return;
        if (A.mapview && A.mapview.setHotspotData) A.mapview.setHotspotData(fc || emptyFC());
        updateLegendCount(fc && fc.features ? fc.features.length : 0);
      }).catch(function () { /* keep previous hotspots */ });
  }
  // Force an immediate refetch at the current preview hour (bypasses the pan gate).
  function refreshHotspots() { lastHotBbox = null; updateLegendHour(); fetchHotspots(); }

  /* ---------------- hotspot legend + hour scrubber ---------------- */
  var legendEl = null;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ensureLegend() {
    if (legendEl) return legendEl;
    legendEl = document.createElement('div');
    legendEl.className = 'hot-legend';
    legendEl.hidden = true;
    legendEl.innerHTML =
      '<div class="hl-head"><span class="hl-title">Police hotspots</span>' +
      '<span class="hl-hour" id="hl-hour">now</span></div>' +
      '<div class="hl-bar"></div>' +
      '<div class="hl-scale"><span>rare</span><span>likely</span><span>usual</span></div>' +
      '<div class="hl-foot"><span class="hl-count" id="hl-count"></span>' +
      '<span class="hl-scrub">' +
      '<button class="hl-btn" id="hl-prev" type="button" aria-label="Earlier hour">‹</button>' +
      '<button class="hl-now" id="hl-now" type="button" hidden>Now</button>' +
      '<button class="hl-btn" id="hl-next" type="button" aria-label="Later hour">›</button>' +
      '</span></div>';
    document.body.appendChild(legendEl);
    legendEl.querySelector('#hl-prev').addEventListener('click', function () { stepHour(-1); });
    legendEl.querySelector('#hl-next').addEventListener('click', function () { stepHour(1); });
    legendEl.querySelector('#hl-now').addEventListener('click', function () { hotPreviewHour = null; refreshHotspots(); });
    return legendEl;
  }
  function stepHour(d) {
    var h = hotHour();
    hotPreviewHour = (((h + d) % 24) + 24) % 24;
    refreshHotspots();
  }
  function updateLegendHour() {
    if (!legendEl) return;
    var hEl = legendEl.querySelector('#hl-hour');
    var nowBtn = legendEl.querySelector('#hl-now');
    if (hEl) hEl.textContent = hotPreviewHour == null ? 'now' : pad2(hotPreviewHour) + ':00';
    if (nowBtn) nowBtn.hidden = (hotPreviewHour == null);
  }
  function updateLegendCount(n) {
    if (!legendEl) return;
    var c = legendEl.querySelector('#hl-count');
    if (c) c.textContent = n ? (n + ' spot' + (n === 1 ? '' : 's')) : 'no data yet';
  }
  function showLegend(on) {
    ensureLegend();
    legendEl.hidden = !on;
    if (on) updateLegendHour();
  }
  // React to the user toggling "Police hotspots" while ghost mode is already on.
  if (A.store && A.store.on) {
    A.store.on('ghosthotspots', function () {
      if (!running) return;
      if (hotspotsOn()) {
        showLegend(true);
        if (!hotTimer) hotTimer = setInterval(fetchHotspots, HOT_MS);
        refreshHotspots();
      } else {
        showLegend(false);
        if (hotTimer) { clearInterval(hotTimer); hotTimer = null; }
        if (A.mapview && A.mapview.setHotspotData) A.mapview.setHotspotData(emptyFC());
      }
    });
  }

  function start() {
    if (running) return;
    if (!S || !S.settings || !S.settings.ghost) return;
    running = true;
    acAdsbx = []; acOpenSky = [];
    policeOSM = []; policeWaze = [];
    lastPoliceBbox = null;   // force a refetch even if the view bbox hasn't changed
    lastWazeBbox = null;
    lastHotBbox = null;
    // immediate first fetch, then per-source intervals (ADSBx fast, OpenSky slow)
    pollAdsbx();
    pollOpenSky();
    fetchPolice();
    if (wazeOn()) fetchWaze();
    if (hotspotsOn()) { fetchHotspots(); showLegend(true); }
    adTimer = setInterval(pollAdsbx, ADSBX_MS);
    osTimer = setInterval(pollOpenSky, OPENSKY_MS);
    poTimer = setInterval(fetchPolice, POLICE_MS);
    if (wazeOn()) wzTimer = setInterval(fetchWaze, WAZE_MS);
    if (hotspotsOn()) hotTimer = setInterval(fetchHotspots, HOT_MS);
  }

  function stop() {
    running = false;
    if (adTimer) { clearInterval(adTimer); adTimer = null; }
    if (osTimer) { clearInterval(osTimer); osTimer = null; }
    if (poTimer) { clearInterval(poTimer); poTimer = null; }
    if (wzTimer) { clearInterval(wzTimer); wzTimer = null; }
    if (hotTimer) { clearInterval(hotTimer); hotTimer = null; }
    showLegend(false);
    acAdsbx = []; acOpenSky = [];
    policeOSM = []; policeWaze = [];
    // clear the layers so nothing lingers when ghost is off
    if (A.mapview) {
      if (A.mapview.setAircraftData) A.mapview.setAircraftData(emptyFC());
      if (A.mapview.setPoliceData) A.mapview.setPoliceData(emptyFC());
      if (A.mapview.setHotspotData) A.mapview.setHotspotData(emptyFC());
    }
  }

  A.ghost = { start: start, stop: stop, isRunning: function () { return running; } };
})();
