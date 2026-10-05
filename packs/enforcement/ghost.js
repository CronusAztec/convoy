/* Convoy — enforcement pack: data sources (the pre-cut js/ghost.js).
   Fetchers for live aircraft, ground enforcement (police stations, speed and
   ALPR cameras from OpenStreetMap), live police sightings (Waze via the
   server, the collector, and other riders' reports) and the server's
   police-probability hotspots. Runs only while the pack's `radar` setting is
   on. All fetches degrade gracefully: a network error or empty result simply
   yields an empty layer (no crash, no stale data).

   Every upstream goes through OUR server, never from the browser:

     OpenSky        sends `Access-Control-Allow-Origin: https://opensky-network.org`,
                    so a browser read is refused by CORS every single time.
     Overpass       serves no CORS header at all.
     Waze           needs a billable key that must not leave the server.

   server/packs/enforcement.js owns those calls, caches per area so every rider
   near each other shares one upstream poll, and is reached only with a bearer
   for an account that holds this pack. Pack routes run on POST and the core
   consumes the request body before a pack route sees it, so every parameter
   rides the query string (api() below). */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util, ST = A.store;
  var E = (A.enforcement = A.enforcement || {});

  var API = {
    aircraft: '/api/enforcement/aircraft',
    overpass: '/api/enforcement/overpass',
    waze: '/api/enforcement/waze',
    hotspots: '/api/enforcement/hotspots'
  };
  /* Deadlines, sized against the server's own budget for each upstream
     (js/util.js carries only the generic 15 s row now):
       overpass: 2 mirrors × 30 s on the server, plus slack for the pipe
       aircraft: the server's 12 s upstream timeout, plus slack */
  var FETCH_MS = { overpass: 75000, aircraft: 20000 };

  // Matches the server's own 8s cache: asking faster only burns our own rate
  // limit for an answer that cannot have changed. Between polls the predictor
  // below dead-reckons the dots so they glide rather than teleport.
  var AIRCRAFT_MS = 8000;
  var POLICE_MS = 90000;     // 90s — POIs are static; refetch when bounds move
  var WAZE_MS = 60000;       // 60s — live police sightings (transient; faster than static POIs)
  var HOT_MS = 5 * 60 * 1000; // 5 min — probability stats change hourly, so slow is fine
  var MAX_BBOX_DEG = 4;      // never query more than a ~4° box (avoid hammering the API)
  var CROWD_TTL_MS = 30 * 60 * 1000; // a rider's police report stays on the map this long
  var CROWD_MAX = 80;

  var acTimer = null;
  var poTimer = null;
  var wzTimer = null;
  var hotTimer = null;
  var lastPoliceBbox = null; // {minLat,minLng,maxLat,maxLng} last queried
  var lastWazeBbox = null;   // separate bbox gate — Waze refreshes faster than static POIs
  var lastHotBbox = null;    // hotspots refetch on a wider pan than live sightings
  var running = false;       // the radar is on — every loop below hangs off this
  var policeRunning = false;
  var hotRunning = false;

  // Last good aircraft list from the proxy. A failed poll keeps it, so a single
  // upstream hiccup doesn't blink every dot off the map.
  var acLive = [];
  // Merged + dead-reckoned aircraft snapshot, republished at PREDICT_MS. Keyed
  // by ICAO hex (stable) so the board's per-target tracking survives a repaint.
  var acMerged = [];
  var predTimer = null;
  var PREDICT_MS = 200;     // ~5 Hz — smooth motion without burning a setData per frame
  var PREDICT_MAX_S = 30;   // never drift a dot more than 30s past its last real fix
  // Motion trails: per-key ring buffer of recent positions, rendered as a
  // fading polyline so the dot leaves a comet tail that dissolves.
  var TRAIL_MAX = 14;       // points per aircraft (~2.8s of history at 5Hz)
  var TRAIL_MIN_DIST_M = 25; // skip a point if the aircraft moved less than this
  var trails = new Map();   // key -> [{lon,lat,owner}] (most-recent last)
  var seenKeys = new Set(); // reused across ticks: which trail keys were touched
  // Police layer = static OSM POIs MERGED with live sightings (Waze/collector
  // via the server, plus other riders' reports over the socket). Each source
  // caches independently; publishPolice() merges them so a stale poll never
  // blanks the static POIs (and vice-versa).
  var policeOSM = [], policeWaze = [], policeCrowd = [];

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }
  function layers() { return E.map || null; }
  function toast(msg, type) { if (A.ui && A.ui.toast) A.ui.toast(msg, type); }

  /* ---------------- the pack's API helper ----------------
     POST + bearer + query-string parameters, through U.fetchT with a deadline.
     Shared with routing.js (E.api). */
  function base() { return (A.config && A.config.base) || ''; }
  function token() { return S.auth && S.auth.token ? S.auth.token : null; }
  function api(path, params, ms) {
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    var h = {};
    var t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    return U.fetchT(base() + path + (q.length ? '?' + q.join('&') : ''), { method: 'POST', headers: h }, ms);
  }
  function bboxParams(bb) { return { minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng }; }
  E.api = api;

  // Clamp the current view to a sane bounding box for querying. `maxDeg`
  // overrides the default clamp — external APIs stay at MAX_BBOX_DEG, but our
  // own server (hotspots) can take a country-sized box cheaply.
  function viewBBox(maxDeg) {
    var m = map();
    if (!m) return null;
    var b = m.getBounds();
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    return clampBBox({ minLat: sw.lat, minLng: sw.lng, maxLat: ne.lat, maxLng: ne.lng }, maxDeg || MAX_BBOX_DEG);
  }

  // How much wider than the clamp a view may be before its clamped box stops
  // describing anything the rider can see. On the intro globe the view is 90x
  // the clamp and the box collapses to lng -2..2 at longitude 0 — a query about
  // the Gulf of Guinea whose failures then back off the rider's REAL area for
  // up to 15 minutes (BUGS.md frontend-019). Not a view worth asking about.
  var WIDE_VIEW_FACTOR = 4;

  // Pure: raw view bounds -> the box we are willing to query, or null.
  function clampBBox(b, lim) {
    if (!b) return null;
    var minLat = Math.max(-90, b.minLat), maxLat = Math.min(90, b.maxLat);
    var minLng = Math.max(-180, b.minLng), maxLng = Math.min(180, b.maxLng);
    // Degenerate (zero-area, inverted, NaN) bounds are not a view either.
    if (!(maxLat > minLat) || !(maxLng > minLng)) return null;
    if (maxLat - minLat > lim * WIDE_VIEW_FACTOR) return null;
    if (maxLng - minLng > lim * WIDE_VIEW_FACTOR) return null;
    // A wide but real view (a whole region on screen): shrink to a manageable
    // box around the centre.
    var cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
    if (maxLat - minLat > lim) { minLat = cLat - lim / 2; maxLat = cLat + lim / 2; }
    if (maxLng - minLng > lim) { minLng = cLng - lim / 2; maxLng = cLng + lim / 2; }
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  /* ---------------- aircraft (via /api/enforcement/aircraft) ----------------
     The server does the fetching and the ownership classification, so a row
     arrives here already carrying `owner`: military | police | ems | civilian |
     unknown. Row shape (server/packs/enforcement/aircraft.js rowToAircraft):
       { hex, callsign, country, lat, lon, alt(m), ground, speed(m/s),
         heading(deg), vertRate(m/s), squawk, owner, at(ms), src } */
  var OWNER_NAMES = {
    military: 'Military',
    police: 'Law enforcement',
    ems: 'EMS / medevac',
    civilian: 'Civilian',
    unknown: 'Unidentified'
  };
  function ownerName(o) { return OWNER_NAMES[o] || OWNER_NAMES.unknown; }
  function ownerOf(a) { return OWNER_NAMES[a && a.owner] ? a.owner : 'unknown'; }

  function fetchAircraft(bb) {
    return api(API.aircraft, bboxParams(bb), FETCH_MS.aircraft).then(function (r) {
      if (!r.ok) throw new Error('aircraft ' + r.status);
      return r.json();
    }).then(function (j) {
      return (j && j.aircraft) || [];
    }).catch(function () { return null; }); // null = errored (vs [] = empty sky)
  }

  function publishAircraft() {
    var seen = {};
    acMerged = [];
    for (var i = 0; i < acLive.length; i++) {
      var a = acLive[i];
      var k = a.hex || ('_' + a.lat.toFixed(4) + ',' + a.lon.toFixed(4));
      if (seen[k]) continue;
      seen[k] = 1;
      acMerged.push({ key: k, a: a });
    }
    predictTick(); // push the fresh set immediately (no 200ms wait)
    if (running && !predTimer) predTimer = U.poll(predictTick, PREDICT_MS);
  }

  // Re-extrapolate every aircraft forward to "now" from its last real fix, then
  // publish. Grounded or heading/speed-less aircraft hold still.
  function predictTick() {
    var L = layers();
    if (!L) return;
    var now = Date.now();
    var feats = new Array(acMerged.length);
    seenKeys.clear();
    for (var i = 0; i < acMerged.length; i++) {
      var entry = acMerged[i], a = entry.a;
      var dt = Math.min((now - (a.at || now)) / 1000, PREDICT_MAX_S);
      var moving = !a.ground && typeof a.speed === 'number' && a.speed > 0.5 &&
        typeof a.heading === 'number' && a.heading !== null && dt > 0;
      var lat = a.lat, lon = a.lon;
      if (moving) {
        var p = U.destPoint([a.lon, a.lat], a.heading, a.speed * dt);
        lon = p[0]; lat = p[1];
      }
      feats[i] = toAircraftFeatureAt(a, lon, lat, entry.key);
      if (moving) { seenKeys.add(entry.key); pushTrailPoint(entry.key, lon, lat, ownerOf(a)); }
    }
    L.setAircraftData({ type: 'FeatureCollection', features: feats });
    trails.forEach(function (_, k) { if (!seenKeys.has(k)) trails.delete(k); });
    L.setAircraftTrailData(buildTrailFC());
  }

  var M_PER_DEG_LAT = 111320;
  var TRAIL_MIN_DIST_SQ = TRAIL_MIN_DIST_M * TRAIL_MIN_DIST_M;
  function pushTrailPoint(key, lon, lat, owner) {
    var buf = trails.get(key);
    if (!buf) { buf = []; trails.set(key, buf); }
    var last = buf.length ? buf[buf.length - 1] : null;
    if (last) {
      var dy = (lat - last.lat) * M_PER_DEG_LAT;
      var dx = (lon - last.lon) * M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
      if (dx * dx + dy * dy < TRAIL_MIN_DIST_SQ) { last.lon = lon; last.lat = lat; return; }
    }
    buf.push({ lon: lon, lat: lat, owner: owner });
    if (buf.length > TRAIL_MAX) buf.shift();
  }

  // One LineString per aircraft; the fade is a line-gradient in maplayers.js.
  function buildTrailFC() {
    var features = [];
    trails.forEach(function (buf, key) {
      if (!buf || buf.length < 2) return;
      var coords = new Array(buf.length);
      for (var j = 0; j < buf.length; j++) coords[j] = [buf[j].lon, buf[j].lat];
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { owner: buf[buf.length - 1].owner || 'unknown', key: key }
      });
    });
    return { type: 'FeatureCollection', features: features };
  }

  function toAircraftFeatureAt(a, lon, lat, key) {
    var own = ownerOf(a);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        callsign: a.callsign || '—', icao: (a.hex || ''), country: a.country || '',
        alt: a.alt, ground: !!a.ground, speed: a.speed, heading: a.heading,
        vertRate: a.vertRate != null ? a.vertRate : null, squawk: a.squawk || '',
        src: a.src, key: key,
        owner: own, ownerName: ownerName(own)
      }
    };
  }

  function pollAircraft() {
    if (!running) return;
    var bb = viewBBox();
    if (!bb) return;
    fetchAircraft(bb).then(function (list) {
      if (!running || list == null) return; // error → keep the dots we have
      acLive = list;
      publishAircraft();
    });
  }

  /* ---------------- upstream-failure backoff ----------------
     A failed fetch clears its bbox gate so the area is retried — but during a
     long outage that meant a full retry on EVERY poll tick AND every pan,
     forever. Track consecutive failures per feed and wait twice as long after
     each one, capped at 15 minutes. */
  var BACKOFF_MAX_MS = 15 * 60 * 1000;
  var backoffs = {}; // feed -> { fails, until }
  function backoffOk(feed) { var b = backoffs[feed]; return !b || Date.now() >= b.until; }
  function backoffFail(feed, baseMs) {
    var b = backoffs[feed] || (backoffs[feed] = { fails: 0, until: 0 });
    b.fails++;
    b.until = Date.now() + Math.min(baseMs * Math.pow(2, b.fails - 1), BACKOFF_MAX_MS);
  }
  function backoffClear(feed) { delete backoffs[feed]; }

  /* ---------------- ground law enforcement (Overpass / OSM) ----------------
     police stations (nodes + buildings) + speed/enforcement cameras + ALPR.
     Each feature carries a `kind` so the map + radar style them apart. */
  function bboxChanged(bb) {
    if (!lastPoliceBbox) return true;
    var movedLat = Math.abs(((bb.minLat + bb.maxLat) / 2) - ((lastPoliceBbox.minLat + lastPoliceBbox.maxLat) / 2));
    var movedLng = Math.abs(((bb.minLng + bb.maxLng) / 2) - ((lastPoliceBbox.minLng + lastPoliceBbox.maxLng) / 2));
    return movedLat > 0.6 || movedLng > 0.6;
  }

  function policeOn() { return !!(S.settings && S.settings.ghostPolice !== false); }
  function fetchPolice() {
    if (!policeRunning || !backoffOk('police')) return;
    var bb = viewBBox();
    if (!bb) return;
    if (lastPoliceBbox && !bboxChanged(bb)) return; // static POIs — skip if same area
    lastPoliceBbox = bb;
    // The 'enforcement' kind covers police stations, speed cameras and the
    // ALPR/surveillance cameras tagged man_made=surveillance. The query itself
    // lives in server/packs/enforcement/overpass.js so it can be cached and
    // shared between riders.
    api(API.overpass, Object.assign({ kind: 'enforcement' }, bboxParams(bb)), FETCH_MS.overpass).then(function (r) {
      if (!r.ok) throw new Error('overpass ' + r.status);
      return r.json();
    }).then(function (j) {
      policeOSM = osmToFeatures(j);
      backoffClear('police');
      publishPolice();
    }).catch(function () {
      // Overpass is flaky (frequent 504s). lastPoliceBbox was set BEFORE the
      // fetch, which would gate out a retry for this exact view — clear it so a
      // later tick / map move tries this area again. The backoff keeps that
      // retry polite during a real outage.
      lastPoliceBbox = null;
      backoffFail('police', POLICE_MS);
    });
  }

  // Pure: an Overpass answer → police-layer features. Exported for tests.
  function osmToFeatures(j) {
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
        var stype = tags['surveillance:type'] || tags.surveillance || '';
        kind = 'alpr';
        name = tags.name || (stype ? ('Surveillance · ' + stype) : 'ALPR / surveillance camera');
      } else if (tags.amenity === 'police') {
        // A police STATION is a permanent building, NOT a live officer sighting —
        // its own kind so it is never styled, labelled or counted as a hotspot
        // like an actual patrol. 'police' is reserved for live sightings.
        kind = 'station';
        name = tags.name || tags['name:en'] || 'Police station';
      } else { continue; }
      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name: name, kind: kind }
      });
    }
    return feats;
  }

  /* ---------------- live police (via /api/enforcement/waze) ----------------
     The server merges Waze (if keyed), the collector's findings and recent
     rider reports into one FeatureCollection. Live sightings are transient,
     so we poll faster (WAZE_MS) and on a separate bbox gate from the static
     POIs. Only opted in when the server reports it has something to serve. */
  function wazeOn() { return !!(E.caps && E.caps.waze); }
  function wazeBboxChanged(bb) {
    if (!lastWazeBbox) return true;
    var dLat = Math.abs(bb.minLat - lastWazeBbox.minLat), dLng = Math.abs(bb.minLng - lastWazeBbox.minLng);
    return dLat > 0.15 || dLng > 0.15;
  }
  var lastWazeAt = 0;
  function fetchWaze() {
    if (!policeRunning || !wazeOn() || !backoffOk('waze')) return;
    var bb = viewBBox();
    if (!bb) return;
    // Skip only when the view hasn't moved AND the data is still fresh.
    if (lastWazeBbox && !wazeBboxChanged(bb) && Date.now() - lastWazeAt < WAZE_MS - 5000) return;
    lastWazeBbox = bb;
    lastWazeAt = Date.now();
    api(API.waze, bboxParams(bb)).then(function (r) { if (!r.ok) throw new Error('waze ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!policeRunning) return;
        // The proxy already classified alerts; only police belong on this layer.
        policeWaze = ((fc && fc.features) || []).filter(function (f) {
          return f.properties && f.properties.kind === 'police';
        });
        backoffClear('waze');
        publishPolice();
      }).catch(function () { lastWazeBbox = null; lastWazeAt = 0; backoffFail('waze', WAZE_MS); });
  }

  /* ---------------- other riders' police reports (socket) ----------------
     The server fans an 'enforcement:report' to riders within NEARBY_KM who
     hold this pack. Held for CROWD_TTL_MS on this layer; the server has
     already fed the sighting into the hotspot model and into the live feed
     every other rider polls. */
  function pruneCrowd() {
    var cut = Date.now() - CROWD_TTL_MS;
    policeCrowd = policeCrowd.filter(function (c) { return c.at > cut; });
    if (policeCrowd.length > CROWD_MAX) policeCrowd.splice(0, policeCrowd.length - CROWD_MAX);
  }
  function addCrowd(rec) {
    policeCrowd.push(rec);
    pruneCrowd();
    publishPolice();
  }
  function crowdFeatures() {
    pruneCrowd();
    return policeCrowd.map(function (c) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: {
          kind: 'police', name: c.label || 'Police sighting', label: c.label || 'Police sighting',
          crowd: !c.reported, reported: !!c.reported, when: new Date(c.at).toISOString()
        }
      };
    });
  }
  function onReport(m) {
    if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number') return;
    if (!isFinite(m.lat) || !isFinite(m.lng) || Math.abs(m.lat) > 90 || Math.abs(m.lng) > 180) return;
    if (m.from && A.net && A.net.myId && m.from.id === A.net.myId()) return; // own echo — drawn at report time
    addCrowd({ lng: m.lng, lat: m.lat, label: typeof m.label === 'string' ? m.label.slice(0, 48) : 'Police sighting', at: Date.now() });
    if (running) toast('Police reported nearby' + (m.from && m.from.name ? ' by ' + m.from.name : ''), 'info');
  }
  // The rider reports police at their own position (radar dock button).
  var lastReportAt = 0;
  function reportPolice() {
    var pos = A.sim && A.sim.playerPos ? A.sim.playerPos() : null;
    if (!pos) { toast('No position yet. Tap the locate button first', 'warn'); return false; }
    if (!A.net || !A.net.isLive || !A.net.isLive()) { toast('Reports need a live connection', 'warn'); return false; }
    var now = Date.now();
    if (now - lastReportAt < 20000) { toast('Already reported — give it a moment', 'info'); return false; }
    lastReportAt = now;
    A.net.send({ t: 'enforcement:report', lat: pos[1], lng: pos[0], label: 'Police sighting' });
    addCrowd({ lng: pos[0], lat: pos[1], label: 'Police sighting', reported: true, at: now });
    toast('Police reported · riders nearby can see it', 'success');
    return true;
  }
  if (A.net && A.net.on) A.net.on('enforcement:report', onReport);

  // Merge static OSM POIs + live sightings + rider reports into the single
  // police source. Either source failing keeps its last-good cache.
  function publishPolice() {
    var L = layers();
    if (!L) return;
    L.setPoliceData({
      type: 'FeatureCollection',
      features: policeOSM.concat(policeWaze, crowdFeatures())
    });
  }

  // Idempotent — safe to call on start, on caps arriving, and on the toggle.
  function startPolice() {
    if (!running || !policeOn()) return;
    if (!policeRunning) { policeRunning = true; lastPoliceBbox = null; lastWazeBbox = null; }
    fetchPolice();
    if (wazeOn()) fetchWaze();
    if (!poTimer) poTimer = U.poll(fetchPolice, POLICE_MS);
    if (wazeOn() && !wzTimer) wzTimer = U.poll(fetchWaze, WAZE_MS);
    publishPolice();
  }
  function stopPolice() {
    policeRunning = false;
    poTimer = U.unpoll(poTimer);
    wzTimer = U.unpoll(wzTimer);
    policeOSM = []; policeWaze = [];
    if (layers()) layers().setPoliceData(emptyFC());
  }

  /* ---------------- police probability hotspots (server-accumulated) ----------------
     Where police are USUALLY seen at the current hour — derived server-side
     from accumulated sightings (server/packs/enforcement/hotspots.js). Empty
     until the server has gathered enough observations. */
  function hotspotsOn() {
    return !!(E.caps && E.caps.hotspots) && (S.settings.ghostHotspots !== false);
  }
  function hotBboxChanged(bb) {
    if (!lastHotBbox) return true;
    var dLat = Math.abs(bb.minLat - lastHotBbox.minLat), dLng = Math.abs(bb.minLng - lastHotBbox.minLng);
    return dLat > 0.3 || dLng > 0.3;
  }
  // null = "now" (live local hour); 0..23 = a previewed hour via the legend scrubber.
  var hotPreviewHour = null;
  var lastHotAt = 0;
  function hotHour() { return hotPreviewHour == null ? new Date().getHours() : hotPreviewHour; }
  function fetchHotspots() {
    if (!hotRunning || !hotspotsOn() || !backoffOk('hot')) return;
    // Hotspots hit OUR server (cheap in-memory scan), so query a much wider box
    // than the external feeds.
    var bb = viewBBox(80);
    if (!bb) return;
    if (lastHotBbox && !hotBboxChanged(bb) && Date.now() - lastHotAt < HOT_MS - 10000) return;
    lastHotBbox = bb;
    lastHotAt = Date.now();
    // The viewer's LOCAL hour (or a previewed hour) — police patterns are
    // local ("morning rush" = local morning), not UTC. The server folds ±1h.
    api(API.hotspots, Object.assign({ hour: hotHour() }, bboxParams(bb)))
      .then(function (r) { if (!r.ok) throw new Error('hotspots ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!hotRunning) return;
        backoffClear('hot');
        if (layers()) layers().setHotspotData(fc && fc.type === 'FeatureCollection' ? fc : emptyFC());
        updateLegendCount(fc && fc.features ? fc.features.length : 0);
      }).catch(function () { lastHotBbox = null; lastHotAt = 0; backoffFail('hot', HOT_MS); });
  }
  // Force an immediate refetch at the current preview hour (bypasses the pan
  // gate AND the failure backoff — an explicit scrub is a user action).
  function refreshHotspots() { lastHotBbox = null; backoffClear('hot'); updateLegendHour(); fetchHotspots(); }

  function startHotspots() {
    if (!running || !hotspotsOn()) return;
    if (hotRunning) { fetchHotspots(); return; }
    hotRunning = true;
    lastHotBbox = null;
    fetchHotspots();
    if (!hotTimer) hotTimer = U.poll(fetchHotspots, HOT_MS);
  }
  function stopHotspots() {
    hotRunning = false;
    hotTimer = U.unpoll(hotTimer);
    if (layers()) layers().setHotspotData(emptyFC());
  }

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
    if (!on && !legendEl) return; // nothing to hide yet
    ensureLegend();
    legendEl.hidden = !on;
    if (on) updateLegendHour();
  }

  /* ---------------- events ---------------- */
  // "Police on map" toggled — start/stop the police layer while the radar runs.
  ST.on('ghostpolice', function () {
    if (!running) return;
    if (policeOn()) startPolice(); else stopPolice();
  });
  // "Police hotspots" toggled.
  ST.on('ghosthotspots', function () {
    if (!running) return;
    if (hotspotsOn()) { startHotspots(); showLegend(true); }
    else { stopHotspots(); showLegend(false); }
  });
  // Server caps land after boot.js probes them — (re)start the loops that
  // depend on them. Both calls are idempotent on later events.
  ST.on('enforcement:caps', function () {
    if (!running) return;
    startPolice();
    startHotspots();
    showLegend(hotspotsOn());
  });
  // The map view changed (pan/zoom, or first ready) — refetch for the new
  // area. fetch* are bbox-gated, so unmoved/tiny nudges are no-ops.
  ST.on('mapmoved', function () {
    if (!running) return;
    if (policeRunning) { fetchPolice(); if (wazeOn()) fetchWaze(); }
    if (hotRunning) fetchHotspots();
  });

  function start() {
    if (running) return;
    running = true;
    acLive = []; acMerged = []; trails.clear();
    lastHotBbox = null;
    // immediate first fetch, then one interval matched to the proxy's cache
    pollAircraft();
    acTimer = U.poll(pollAircraft, AIRCRAFT_MS);
    startPolice();
    startHotspots();
    showLegend(hotspotsOn());
  }

  function stop() {
    running = false;
    acTimer = U.unpoll(acTimer);
    predTimer = U.unpoll(predTimer);
    showLegend(false);
    // Drop any scrubbed preview hour so the next run tracks "now" again.
    hotPreviewHour = null;
    acLive = [];
    acMerged = [];
    trails.clear();
    stopPolice();
    stopHotspots();
    var L = layers();
    if (L) { L.setAircraftData(emptyFC()); L.setAircraftTrailData(emptyFC()); }
  }

  E.ghost = {
    start: start, stop: stop, isRunning: function () { return running; },
    clampBBox: clampBBox, osmToFeatures: osmToFeatures,
    reportPolice: reportPolice, refreshHotspots: refreshHotspots,
    // test surface
    _onReport: onReport,
    _state: function () { return { running: running, police: policeRunning, hotspots: hotRunning, crowd: policeCrowd.length, legend: !!legendEl && !legendEl.hidden }; }
  };
})();
