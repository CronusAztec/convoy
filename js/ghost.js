/* Convoy — Ghost Mode data sources.
   Fetchers for live aircraft and nearby police stations (OpenStreetMap via
   Overpass). Runs only while Ghost Mode is on. All fetches degrade gracefully:
   a network error or empty result simply yields an empty layer (no crash, no
   stale data).

   Aircraft go through OUR server (/api/aircraft), not upstream directly. They
   used to be fetched here from two hosts and the layer was dead in every
   deployment, for two separate reasons:

     OpenSky        sends `Access-Control-Allow-Origin: https://opensky-network.org`,
                    so a browser read is refused by CORS every single time. The
                    request never completed, which is why nothing appeared and
                    nothing errored visibly.
     airplanes.live now returns 403 to everyone, server included.

   server/aircraft.js does the fetching, caching and ownership classification,
   so the sky arrives here already sorted into military / police / ems /
   civilian / unknown.

   Overpass:  https://wiki.openstreetmap.org/wiki/Overpass_API          (amenity=police POIs) */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, U = A.util;

  // Aircraft via our own server — see the header. The proxy caches per area, so
  // every rider near each other shares one upstream poll. See server/aircraft.js.
  var AIRCRAFT_PROXY = (A.config ? A.config.base : '') + '/api/aircraft';
  // Through our own server, not overpass-api.de directly: that endpoint sends
  // no Access-Control-Allow-Origin header, so the browser blocks the response
  // before this code can read it. The proxy also caches, so every rider in an
  // area shares one upstream query. See server/overpass.js.
  var OVERPASS_PROXY = (A.config ? A.config.base : '') + '/api/overpass';

  // Matches the server's own 8s cache: asking faster only burns our own rate
  // limit for an answer that cannot have changed. Between polls the predictor
  // below dead-reckons the dots so they glide rather than teleport.
  var AIRCRAFT_MS = 8000;
  var POLICE_MS = 90000;     // 90s — POIs are static; refetch when bounds move
  var WAZE_MS = 60000;       // 60s — live Waze police sightings (transient; faster than static POIs)
  var HOT_MS = 5 * 60 * 1000; // 5 min — probability stats change hourly, so slow is fine
  var MAX_BBOX_DEG = 4;      // never query more than a ~4° box (avoid hammering the API)

  var acTimer = null;
  var poTimer = null;
  var wzTimer = null;
  var hotTimer = null;
  var lastPoliceBbox = null; // {minLat,minLng,maxLat,maxLng} last queried
  var lastWazeBbox = null;   // separate bbox gate — Waze refreshes faster than static POIs
  var lastHotBbox = null;    // hotspots refetch on a wider pan than live sightings
  var running = false;       // ghost mode (aircraft layer) — police + hotspots run independently
  var policeRunning = false; // police layer runs ALWAYS-ON (like hotspots), not just in ghost mode

  // Last good aircraft list from the proxy. A failed poll keeps it, so a single
  // upstream hiccup doesn't blink every dot off the map.
  var acLive = [];
  // Merged + dead-reckoned aircraft snapshot, republished at PREDICT_MS. The two
  // upstream polls only fire every 3–12s; between them the dots would teleport in
  // jumps. Each carries speed+heading, so we extrapolate forward (cap PREDICT_MAX_S)
  // to glide smoothly. The radar board reads this via getGhostData(), so predicted
  // positions drive the threat list + sonar too. Keyed by ICAO hex (stable) so the
  // board's per-target tracking (closing rate, "new contact" sting) survives a repaint.
  var acMerged = [];
  var predTimer = null;
  var PREDICT_MS = 200;     // ~5 Hz — smooth motion without burning a setData per frame
  var PREDICT_MAX_S = 30;   // never drift a dot more than 30s past its last real fix
  // Motion trails. Each prediction tick appends the aircraft's current position to
  // a per-key ring buffer; the trail is rendered as a fading polyline (older
  // segments more transparent) so the dot leaves a comet tail that dissolves.
  var TRAIL_MAX = 14;       // points per aircraft (~2.8s of history at 5Hz) — short, ephemeral
  var TRAIL_MIN_DIST_M = 25; // skip a point if the aircraft moved less than this since the last (no stacking)
  // key -> [{lon,lat,owner}] (most-recent last). A Map, not a plain object:
  // predictTick prunes departed aircraft every tick, and `delete` on an object
  // forces V8 into dictionary mode for the whole shape — on the exact structure
  // being rewritten 5 times a second.
  var trails = new Map();
  // Reused across ticks: which trail keys were touched this pass. A fresh object
  // per tick was one more allocation on a 5 Hz path, and clear() is cheaper than
  // building a new one.
  var seenKeys = new Set();
  // NB: trail colour is no longer decided here. It is a line-gradient per owner
  // layer in mapview.js, reading the same AIRCRAFT_COLORS table the dots use —
  // one source of truth instead of a duplicate palette that could drift.
  // Police layer = static OSM POIs (stations/cameras/ALPR) MERGED with live Waze
  // police sightings. Each source caches independently; publishPolice() merges them
  // so a stale Waze poll never blanks the static POIs (and vice-versa).
  var policeOSM = [], policeWaze = [];

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }

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
  // describing anything the rider can see. At 4x the clamp the box is 1/16th
  // of the visible area; on the intro globe the view is 90x the clamp and the
  // box collapses to lng -2..2 at longitude 0 — a query about the Gulf of
  // Guinea, sent on every intro frame, whose failures then back off the
  // rider's REAL area for up to 15 minutes (see backoffFail below; BUGS.md
  // frontend-019). Not a view worth asking about; every caller already treats
  // null as "skip this tick".
  var WIDE_VIEW_FACTOR = 4;

  // Pure: raw view bounds -> the box we are willing to query, or null. Exported
  // on A.ghost for tests only (test/ghostbbox.test.js).
  function clampBBox(b, lim) {
    if (!b) return null;
    var minLat = Math.max(-90, b.minLat), maxLat = Math.min(90, b.maxLat);
    var minLng = Math.max(-180, b.minLng), maxLng = Math.min(180, b.maxLng);
    // Degenerate (zero-area, inverted, NaN) bounds are not a view either.
    if (!(maxLat > minLat) || !(maxLng > minLng)) return null;
    if (maxLat - minLat > lim * WIDE_VIEW_FACTOR) return null;
    if (maxLng - minLng > lim * WIDE_VIEW_FACTOR) return null;
    // A wide but real view (a whole region on screen): shrink to a manageable
    // box around the centre, exactly as before.
    var cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
    if (maxLat - minLat > lim) { minLat = cLat - lim / 2; maxLat = cLat + lim / 2; }
    if (maxLng - minLng > lim) { minLng = cLng - lim / 2; maxLng = cLng + lim / 2; }
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  /* ---------------- aircraft (via our own /api/aircraft proxy) ----------------
     The server does the fetching and the ownership classification, so a row
     arrives here already carrying `owner`: military | police | ems | civilian |
     unknown. Nothing is re-classified on this side — one place decides, and the
     map, the radar board and the popup all read the same answer.

     Row shape (server/aircraft.js rowToAircraft):
       { hex, callsign, country, lat, lon, alt(m), ground, speed(m/s),
         heading(deg), vertRate(m/s), squawk, owner, at(ms), src } */

  // Display names for the five buckets. `unknown` is a real answer, not a
  // fallback for a bug: a contact with no callsign, or one flying a tactical
  // callsign the server will not guess at, genuinely is unidentified.
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
    return U.fetchT(AIRCRAFT_PROXY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bbox: { minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng }
      })
    }, U.FETCH_TIMEOUT.aircraft).then(function (r) {
      if (!r.ok) throw new Error('aircraft ' + r.status);
      return r.json();
    }).then(function (j) {
      return (j && j.aircraft) || [];
    }).catch(function () { return null; }); // null = errored (vs [] = empty sky)
  }

  function publishAircraft() {
    // One source now, so there is nothing to merge — just key each contact so
    // the predictor and the radar board can track it across repaints. ICAO hex
    // is the identity; a contact without one falls back to its position.
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
    if (running && !predTimer) predTimer = setInterval(predictTick, PREDICT_MS);
  }

  // Re-extrapolate every aircraft forward to "now" from its last real fix, then
  // publish. Dots glide between the 3–12s upstream polls instead of teleporting.
  // Grounded or heading/speed-less aircraft hold still (a plane on the apron, or
  // a source that didn't report kinematics, shouldn't invent a velocity).
  function predictTick() {
    if (!A.mapview || !A.mapview.setAircraftData) return;
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
      // Extend the flight path only for airborne, moving aircraft (a parked/hovering
      // dot shouldn't grow a tail). Ground/stationary keys get pruned below.
      if (moving) { seenKeys.add(entry.key); pushTrailPoint(entry.key, lon, lat, ownerOf(a)); }
    }
    A.mapview.setAircraftData({ type: 'FeatureCollection', features: feats });
    // Drop trails for aircraft that left the set or stopped moving, then repaint.
    // Map.delete during its own iteration is well-defined (unlike splicing an
    // array you are walking), so this needs no copy of the key list.
    trails.forEach(function (_, k) { if (!seenKeys.has(k)) trails.delete(k); });
    if (A.mapview.setAircraftTrailData) A.mapview.setAircraftTrailData(buildTrailFC());
  }

  // Append a position to an aircraft's trail ring buffer. Near-duplicate points
  // (< TRAIL_MIN_DIST_M) just update the head so the tail never stacks up in place.
  //
  // The distance test is inlined rather than calling U.haversine, which takes
  // two [lon,lat] ARRAYS — building them here allocated two throwaway arrays per
  // aircraft per tick, 5 times a second, purely to ask "did this move 25 m?".
  // At trail scale (tens of metres) a flat equirectangular approximation is
  // exact enough to answer that, and comparing squared metres skips the sqrt as
  // well. Nothing downstream sees the distance; only the threshold matters.
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

  // One LineString per aircraft. The fade is a line-gradient in mapview.js
  // (paint, evaluated on ['line-progress']), not something baked into the
  // geometry here — which is why this no longer emits a feature per segment
  // with a hand-stepped opacity on each. Same trail, continuous fade, and about
  // a thirteenth of the features for MapLibre to re-parse every tick.
  function buildTrailFC() {
    var features = [];
    trails.forEach(function (buf, key) {
      if (!buf || buf.length < 2) return;
      var coords = new Array(buf.length);
      for (var j = 0; j < buf.length; j++) coords[j] = [buf[j].lon, buf[j].lat];
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        // `owner` is what selects the coloured layer; `key` keeps a trail
        // identifiable across repaints for anything that wants to track one.
        properties: { owner: buf[buf.length - 1].owner || 'unknown', key: key }
      });
    });
    return { type: 'FeatureCollection', features: features };
  }

  // Writes the ALREADY-predicted coordinates (so the predictor and a one-shot
  // publish share one geometry path) and stamps a stable `key` the radar board
  // can track across repaints. Ownership arrives already decided by the server
  // and is stamped on the feature, so map/radar/popup all read one answer.
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
     long outage (Overpass 504s for hours) that meant a full retry on EVERY poll
     tick AND every pan, forever. Track consecutive failures per feed and wait
     twice as long after each one, capped at 15 minutes. */
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
     police stations (nodes + buildings) + speed/enforcement cameras. Each feature
     carries a `kind` ('police' | 'camera') so the map + radar style them apart. */
  function bboxChanged(bb) {
    if (!lastPoliceBbox) return true;
    // refetch if the view center moved more than ~half the last box, or grew a lot
    var movedLat = Math.abs(((bb.minLat + bb.maxLat) / 2) - ((lastPoliceBbox.minLat + lastPoliceBbox.maxLat) / 2));
    var movedLng = Math.abs(((bb.minLng + bb.maxLng) / 2) - ((lastPoliceBbox.minLng + lastPoliceBbox.maxLng) / 2));
    return movedLat > 0.6 || movedLng > 0.6;
  }

  // Police layer shows ALWAYS (independent of ghost mode), gated only by the
  // "Police stations" setting. OSM POIs are keyless; Waze adds live sightings.
  function policeOn() { return !!(S.settings && S.settings.ghostPolice !== false); }
  function fetchPolice() {
    if (!policeRunning || !backoffOk('police')) return;
    var bb = viewBBox();
    if (!bb) return;
    if (lastPoliceBbox && !bboxChanged(bb)) return; // static POIs — skip if same area
    lastPoliceBbox = bb;
    // The 'enforcement' kind covers police stations, speed cameras and the
    // ALPR/surveillance cameras DeFlock contributes (336K+ license-plate readers,
    // tagged man_made=surveillance in OSM). One query, one fetch — they are all
    // static enforcement POIs on the same cadence. The query itself lives in
    // server/overpass.js so it can be cached and shared between riders.
    U.fetchT(OVERPASS_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'enforcement',
        bbox: { minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng }
      })
    }, U.FETCH_TIMEOUT.overpass).then(function (r) {
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
          // A police STATION is a permanent building, NOT a live officer sighting —
          // give it its own kind so it's never styled, labelled, or (critically)
          // counted as a hotspot like an actual patrol. 'police' is reserved for
          // live sightings (Waze + crowd reports), which are what feed hotspots.
          kind = 'station';
          name = tags.name || tags['name:en'] || 'Police station';
        } else { continue; }
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { name: name, kind: kind }
        });
      }
      policeOSM = feats;       // cache static POIs; publishPolice() merges with Waze
      backoffClear('police');
      publishPolice();
    }).catch(function () {
      // Overpass is flaky (frequent 504s). lastPoliceBbox was set BEFORE the fetch,
      // which would gate out a retry for this exact view — clear it so a later
      // tick / map move tries this area again instead of showing a stale city.
      // The backoff keeps that retry polite during a real outage. A stalled
      // socket lands here too: fetchT's deadline (FETCH_TIMEOUT.overpass) rejects
      // it, so a hang can no longer leave this latch set for the whole ride
      // (frontend-020; test/fetchtimeout.test.js runs this path).
      lastPoliceBbox = null;
      backoffFail('police', POLICE_MS);
    });
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
  var lastWazeAt = 0; // when the last Waze request was issued (age gate below)
  function fetchWaze() {
    if (!policeRunning || !wazeOn() || !backoffOk('waze')) return;
    var bb = viewBBox();
    if (!bb) return;
    // Skip only when the view hasn't moved AND the data is still fresh. Without
    // the age check the bbox gate starved the 60s poll while parked/driving
    // locally — sightings never refreshed, expired pins never dropped.
    if (lastWazeBbox && !wazeBboxChanged(bb) && Date.now() - lastWazeAt < WAZE_MS - 5000) return;
    lastWazeBbox = bb;
    lastWazeAt = Date.now();
    U.fetchT((A.config ? A.config.base : '') + '/api/waze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat] })
    }).then(function (r) { if (!r.ok) throw new Error('waze ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!policeRunning) return;
        // The proxy already classified alerts into {kind,label,color}; only police
        // belong on the Ghost police layer — hazards have their own layer.
        policeWaze = ((fc && fc.features) || []).filter(function (f) {
          return f.properties && f.properties.kind === 'police';
        });
        backoffClear('waze');
        publishPolice();
      }).catch(function () { lastWazeBbox = null; lastWazeAt = 0; backoffFail('waze', WAZE_MS); /* retry this area later (see fetchPolice) */ });
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

  // Independent always-on lifecycle (mirrors startHotspots): the police layer is
  // present whenever the setting allows, not only in ghost mode. Idempotent — safe
  // to call on load, on routecaps (Waze cap arrives late), and on the setting toggle.
  function startPolice() {
    if (!policeOn()) return;
    if (!policeRunning) { policeRunning = true; lastPoliceBbox = null; lastWazeBbox = null; }
    fetchPolice();
    if (wazeOn()) fetchWaze();
    // Idempotent timer arming — also covers the case where Waze's cap only became
    // known (routecaps) AFTER policeRunning was first set, so wzTimer wasn't armed yet.
    if (!poTimer) poTimer = setInterval(fetchPolice, POLICE_MS);
    if (wazeOn() && !wzTimer) wzTimer = setInterval(fetchWaze, WAZE_MS);
  }
  function stopPolice() {
    policeRunning = false;
    if (poTimer) { clearInterval(poTimer); poTimer = null; }
    if (wzTimer) { clearInterval(wzTimer); wzTimer = null; }
    policeOSM = []; policeWaze = [];
    if (A.mapview && A.mapview.setPoliceData) A.mapview.setPoliceData(emptyFC());
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
  // Hotspots run INDEPENDENTLY of ghost mode — they're a subtle always-on map layer
  // (the legend/scrubber only surface in ghost mode). hotRunning gates the loop.
  var hotRunning = false;
  var lastHotAt = 0; // when the last hotspot request was issued (age gate below)
  function hotHour() { return hotPreviewHour == null ? new Date().getHours() : hotPreviewHour; }
  function fetchHotspots() {
    if (!hotRunning || !hotspotsOn() || !backoffOk('hot')) return;
    // Hotspots hit OUR server (cheap in-memory scan), so query a much wider box
    // than the external feeds — zoomed out to a state/country view, the layer
    // still shows every hotspot instead of a 4° window around the map center.
    var bb = viewBBox(80);
    if (!bb) return;
    // Same freshness rule as fetchWaze: an unmoved view still refetches once the
    // data is a full cycle old, so the layer tracks the growing model AND the
    // rolling hour-of-day without needing a big pan to wake it up.
    if (lastHotBbox && !hotBboxChanged(bb) && Date.now() - lastHotAt < HOT_MS - 10000) return;
    lastHotBbox = bb;
    lastHotAt = Date.now();
    // Pass the viewer's LOCAL hour (or a previewed hour) — police patterns are
    // local ("morning rush" = local morning), not UTC. The server folds ±1h.
    var hour = hotHour();
    U.fetchT((A.config ? A.config.base : '') + '/api/hotspots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLeft: [bb.minLng, bb.minLat], topRight: [bb.maxLng, bb.maxLat], hour: hour })
    }).then(function (r) { if (!r.ok) throw new Error('hotspots ' + r.status); return r.json(); })
      .then(function (fc) {
        if (!hotRunning) return;
        backoffClear('hot');
        if (A.mapview && A.mapview.setHotspotData) A.mapview.setHotspotData(fc || emptyFC());
        updateLegendCount(fc && fc.features ? fc.features.length : 0);
      }).catch(function () { lastHotBbox = null; lastHotAt = 0; backoffFail('hot', HOT_MS); /* retry this area later */ });
  }
  // Force an immediate refetch at the current preview hour (bypasses the pan gate
  // AND the failure backoff — an explicit scrub is a user action, not a poll).
  function refreshHotspots() { lastHotBbox = null; backoffClear('hot'); updateLegendHour(); fetchHotspots(); }

  // Independent lifecycle: start/stop the hotspot fetch loop on its own, so the
  // layer is present whenever the cap + setting allow — not only in ghost mode.
  function startHotspots() {
    if (!hotspotsOn()) return;
    if (hotRunning) { fetchHotspots(); return; }
    hotRunning = true;
    lastHotBbox = null;
    fetchHotspots();
    if (!hotTimer) hotTimer = setInterval(fetchHotspots, HOT_MS);
  }
  function stopHotspots() {
    hotRunning = false;
    if (hotTimer) { clearInterval(hotTimer); hotTimer = null; }
    if (A.mapview && A.mapview.setHotspotData) A.mapview.setHotspotData(emptyFC());
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
    ensureLegend();
    legendEl.hidden = !on;
    if (on) updateLegendHour();
  }
  if (A.store && A.store.on) {
    // User toggled "Police hotspots" — start/stop the always-on loop (legend only
    // shows while ghost mode is on).
    A.store.on('ghosthotspots', function () {
      if (hotspotsOn()) { startHotspots(); showLegend(!!(S.settings && S.settings.ghost)); }
      else { stopHotspots(); showLegend(false); }
    });
    // User toggled "Police stations" — start/stop the always-on police layer.
    A.store.on('ghostpolice', function () {
      if (policeOn()) startPolice(); else stopPolice();
    });
    // Caps (Waze) are only known after net.js probes /api/route/caps — (re)start the
    // always-on loops the moment they land. Both calls are idempotent on later events.
    A.store.on('routecaps', function () { startHotspots(); startPolice(); });
    // The map view changed (pan/zoom, or first ready) — refetch the always-on layers
    // for the new area. fetch* are bbox-gated, so unmoved/tiny nudges are no-ops.
    A.store.on('mapmoved', function () {
      if (policeRunning) { fetchPolice(); if (wazeOn()) fetchWaze(); }
      if (hotRunning) fetchHotspots();
    });
  }
  // Try once at load too (covers a cached/early routeCaps); no-op until ready.
  startHotspots();
  startPolice();

  function start() {
    if (running) return;
    if (!S || !S.settings || !S.settings.ghost) return;
    running = true;
    acLive = [];
    lastHotBbox = null;
    // immediate first fetch, then one interval matched to the proxy's cache
    pollAircraft();
    // Police + hotspots run independently (always-on); ghost mode just adds the
    // aircraft layer and reveals the hotspot legend. Ensure both are live here too.
    startPolice();
    if (hotspotsOn()) { startHotspots(); showLegend(true); }
    acTimer = setInterval(pollAircraft, AIRCRAFT_MS);
  }

  function stop() {
    running = false;
    if (acTimer) { clearInterval(acTimer); acTimer = null; }
    if (predTimer) { clearInterval(predTimer); predTimer = null; }
    showLegend(false);   // hide the legend, but the hotspot layer stays (always-on)
    // Drop any scrubbed preview hour so the always-on layer tracks "now" again —
    // otherwise the heatmap freezes at the previewed hour with no legend to fix it.
    if (hotPreviewHour != null) { hotPreviewHour = null; refreshHotspots(); }
    acLive = [];
    acMerged = [];
    trails = {};
    // Clear ONLY the ghost-scoped aircraft layer (dots + flight paths). Police +
    // hotspots are always-on and keep running (their own lifecycles own clearing them).
    if (A.mapview && A.mapview.setAircraftData) A.mapview.setAircraftData(emptyFC());
    if (A.mapview && A.mapview.setAircraftTrailData) A.mapview.setAircraftTrailData(emptyFC());
  }

  A.ghost = { start: start, stop: stop, isRunning: function () { return running; }, clampBBox: clampBBox };
})();
