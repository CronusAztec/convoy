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
  // Through our own server, not overpass-api.de directly: that endpoint sends
  // no Access-Control-Allow-Origin header, so the browser blocks the response
  // before this code can read it. The proxy also caches, so every rider in an
  // area shares one upstream query. See server/overpass.js.
  var OVERPASS_PROXY = (A.config ? A.config.base : '') + '/api/overpass';

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
  var running = false;       // ghost mode (aircraft layer) — police + hotspots run independently
  var policeRunning = false; // police layer runs ALWAYS-ON (like hotspots), not just in ghost mode

  // Per-source aircraft caches (raw normalized objects). Each source refreshes on its
  // own cadence and republishes the merged set; a failed poll keeps that source's
  // last-good list so dots don't flicker.
  var acAdsbx = [], acOpenSky = [];
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
  var trails = {};          // key -> [{lon,lat,at}]  (most-recent last)
  // Owner → trail color. Mirrors the dot colors in mapview.js so a trail reads
  // as belonging to its dot.
  function trailColor(owner) {
    return owner === 'military' ? '#ff3b3b'
      : owner === 'police' ? '#3b82f6'
      : owner === 'ems' ? '#22c55e'
      : '#e8edf6'; // civilian silver
  }
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
    var lim = maxDeg || MAX_BBOX_DEG;
    var b = m.getBounds();
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var minLat = Math.max(-90, sw.lat), maxLat = Math.min(90, ne.lat);
    var minLng = Math.max(-180, sw.lng), maxLng = Math.min(180, ne.lng);
    // if the world wraps (tiny zoom), shrink to a manageable box around center
    var cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
    if (maxLat - minLat > lim) { minLat = cLat - lim / 2; maxLat = cLat + lim / 2; }
    if (maxLng - minLng > lim) { minLng = cLng - lim / 2; maxLng = cLng + lim / 2; }
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
       gs(knots), track(deg), category(A1..A7), dbFlags(&1=military, &2=interesting) } */
  var KNOTS_MS = 0.514444, FT_M = 0.3048;

  /* ---------------- ownership classification ----------------
     Classify each aircraft into one of: civilian | military | police | ems.
     Sources of truth, in priority order:
       - ADS-B Exchange dbFlags bit 0 (1)  → military (authoritative database flag)
       - dbFlags bit 1 (2) "interesting"   → LADD/special-interest; combined with a
         government/police callsign prefix it's law-enforcement
       - callsign heuristics               → EMS/medevac (LIFEFLIGHT, Lifeguard,
         Med-, air-ambulance) and police rotor callsigns (ROTO, PD, STATE, BELL)
       - rotorcraft + low-and-slow         → likely police/EMS (not civilian traffic)
     Returns { owner, name } where owner is the stable key the filters + styling
     switch on, and name is the human label for popups. Civilian is the default. */
  var POLICE_CS = /^(ROTO|PD|STATE|STATETROOPER|CAPOLICE|CHP|DPS|STATEPOLICE|SHERIFF|CBP|BP|BPA|FBI|USMS|USMARSHAL|DEA|HSI|ATF|HSI|USCG|COASTGUARD|GUARD)\b/i;
  var EMS_CS = /^(LIFE|LIFEGUARD|MED|MEDEVAC|AIRAMB|AIRAMBULANCE|AMB|HOSP|GUARD| Rescue|RESCUE|EMSA|AMR)\b/i;
  function classifyOwner(a) {
    var cs = a.callsign || '';
    // dbFlags only flows from ADSBx; OpenSky has no equivalent (mil stays false).
    var flags = a.dbFlags || 0;
    if (a.mil || (flags & 1)) return { owner: 'military', name: 'Military' };
    // "Interesting" LADD flag + a police-style callsign → law-enforcement.
    if ((flags & 2) && POLICE_CS.test(cs)) return { owner: 'police', name: 'Law enforcement' };
    // Callsign-based EMS detection (medevac/air-ambulance).
    if (EMS_CS.test(cs)) return { owner: 'ems', name: 'EMS / medevac' };
    // Police rotor callsign without the LADD flag — still suspicious.
    if (POLICE_CS.test(cs)) return { owner: 'police', name: 'Law enforcement' };
    // Rotorcraft low-and-slow with no other signal is ambiguous; tag it police-tinted
    // only if it carries a tactical-looking callsign, otherwise civilian. (A news
    // or traffic heli would read as civilian here, which is the safer default.)
    return { owner: 'civilian', name: 'Civilian' };
  }

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
          reg: '', acType: '', category: '', mil: false, src: 'opensky',
          // lastContact is seconds-since-epoch (server fix time). Predictions age
          // from this, so an OpenSky row that's already a few seconds stale still
          // extrapolates from when it was actually true.
          at: s[3] ? s[3] * 1000 : Date.now()
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
          // dbFlags: bit0=military, bit1=LADD/interesting (LE/gov). Keep the raw
          // bits so classifyOwner can branch on either; `mil` stays as a boolean
          // for back-compat with existing consumers (radar.js, popups).
          dbFlags: typeof a.dbFlags === 'number' ? a.dbFlags : 0,
          mil: !!(a.dbFlags & 1), src: 'adsbx',
          at: Date.now() // ADSBx point has no server timestamp; treat arrival as fix time
        });
      }
      return out;
    }).catch(function () { return null; });
  }

  function publishAircraft() {
    // Merge the two sources by ICAO hex (ADSBx first ⇒ it keeps the slot on a
    // collision: it carries type/reg/military). Store the merged set so the
    // predictor can re-extrapolate it on its own cadence without re-merging.
    var lists = [acAdsbx, acOpenSky];
    var byKey = {}, order = [];
    for (var L = 0; L < lists.length; L++) {
      for (var i = 0; i < lists[L].length; i++) {
        var a = lists[L][i];
        var k = a.hex || ('_' + a.lat.toFixed(4) + ',' + a.lon.toFixed(4));
        if (k in byKey) continue;
        byKey[k] = a; order.push(k);
      }
    }
    acMerged = order.map(function (k) {
      var a = byKey[k];
      return { key: k, a: a };
    });
    predictTick(); // push the freshly-merged set immediately (no 200ms wait)
    if (running && !predTimer) predTimer = setInterval(predictTick, PREDICT_MS);
  }

  // Re-extrapolate every aircraft forward to "now" from its last real fix, then
  // publish. Dots glide between the 3–12s upstream polls instead of teleporting.
  // Grounded or heading/speed-less aircraft hold still (a plane on the apron, or
  // a source that didn't report kinematics, shouldn't invent a velocity).
  function predictTick() {
    if (!A.mapview || !A.mapview.setAircraftData) return;
    var now = Date.now();
    var feats = [];
    var seen = {};
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
      feats.push(toAircraftFeatureAt(a, lon, lat, entry.key));
      // Extend the flight path only for airborne, moving aircraft (a parked/hovering
      // dot shouldn't grow a tail). Ground/stationary keys get pruned below.
      if (moving) { seen[entry.key] = true; pushTrailPoint(entry.key, lon, lat, classifyOwner(a).owner); }
    }
    A.mapview.setAircraftData({ type: 'FeatureCollection', features: feats });
    // Drop trails for aircraft that left the set or stopped moving, then repaint.
    for (var k in trails) { if (!seen[k]) delete trails[k]; }
    if (A.mapview.setAircraftTrailData) A.mapview.setAircraftTrailData(buildTrailFC());
  }

  // Append a position to an aircraft's trail ring buffer. Near-duplicate points
  // (< TRAIL_MIN_DIST_M) just update the head so the tail never stacks up in place.
  function pushTrailPoint(key, lon, lat, owner) {
    var buf = trails[key] || (trails[key] = []);
    var last = buf[buf.length - 1];
    if (last && U.haversine([last.lon, last.lat], [lon, lat]) < TRAIL_MIN_DIST_M) {
      last.lon = lon; last.lat = lat; return;
    }
    buf.push({ lon: lon, lat: lat, owner: owner });
    if (buf.length > TRAIL_MAX) buf.shift();
  }

  // Render each trail as a chain of short segments whose opacity + width ramp from
  // faint/thin at the tail to bright/thick at the head — a comet tail behind the dot.
  function buildTrailFC() {
    var features = [];
    for (var key in trails) {
      var buf = trails[key];
      if (!buf || buf.length < 2) continue;
      var color = trailColor(buf[buf.length - 1].owner);
      for (var j = 1; j < buf.length; j++) {
        var t = j / (buf.length - 1); // 0 = tail … 1 = head
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[buf[j - 1].lon, buf[j - 1].lat], [buf[j].lon, buf[j].lat]] },
          properties: { color: color, opacity: 0.12 + 0.6 * t, width: 1.5 + 1.8 * t }
        });
      }
    }
    return { type: 'FeatureCollection', features: features };
  }

  // Writes the ALREADY-predicted coordinates (so the predictor and a one-shot
  // publish share one geometry path) and stamps a stable `key` the radar board
  // can track across repaints. Ownership is classified from
  // the source record `a` and stamped on the feature so map/radar/popup all read
  // the same owner without re-classifying in three places.
  function toAircraftFeatureAt(a, lon, lat, key) {
    var own = classifyOwner(a);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        callsign: a.callsign || a.reg || '—', icao: (a.hex || ''), country: a.country || '',
        alt: a.alt, ground: !!a.ground, speed: a.speed, heading: a.heading,
        reg: a.reg || '', acType: a.acType || '', category: a.category || '',
        mil: !!a.mil, src: a.src, key: key,
        owner: own.owner, ownerName: own.name
      }
    };
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
    fetch(OVERPASS_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'enforcement',
        bbox: { minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng }
      })
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
      // The backoff keeps that retry polite during a real outage.
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
    fetch((A.config ? A.config.base : '') + '/api/waze', {
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
    fetch((A.config ? A.config.base : '') + '/api/hotspots', {
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
    acAdsbx = []; acOpenSky = [];
    lastHotBbox = null;
    // immediate first fetch, then per-source intervals (ADSBx fast, OpenSky slow)
    pollAdsbx();
    pollOpenSky();
    // Police + hotspots run independently (always-on); ghost mode just adds the
    // aircraft layer and reveals the hotspot legend. Ensure both are live here too.
    startPolice();
    if (hotspotsOn()) { startHotspots(); showLegend(true); }
    adTimer = setInterval(pollAdsbx, ADSBX_MS);
    osTimer = setInterval(pollOpenSky, OPENSKY_MS);
  }

  function stop() {
    running = false;
    if (adTimer) { clearInterval(adTimer); adTimer = null; }
    if (osTimer) { clearInterval(osTimer); osTimer = null; }
    if (predTimer) { clearInterval(predTimer); predTimer = null; }
    showLegend(false);   // hide the legend, but the hotspot layer stays (always-on)
    // Drop any scrubbed preview hour so the always-on layer tracks "now" again —
    // otherwise the heatmap freezes at the previewed hour with no legend to fix it.
    if (hotPreviewHour != null) { hotPreviewHour = null; refreshHotspots(); }
    acAdsbx = [];
    acOpenSky = [];
    acMerged = [];
    trails = {};
    // Clear ONLY the ghost-scoped aircraft layer (dots + flight paths). Police +
    // hotspots are always-on and keep running (their own lifecycles own clearing them).
    if (A.mapview && A.mapview.setAircraftData) A.mapview.setAircraftData(emptyFC());
    if (A.mapview && A.mapview.setAircraftTrailData) A.mapview.setAircraftTrailData(emptyFC());
  }

  A.ghost = { start: start, stop: stop, isRunning: function () { return running; } };
})();
