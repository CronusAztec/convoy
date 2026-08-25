/* Convoy — rider engine: marker store, interpolation, trip motion, follow camera.
   Two rider sources share this engine:
     - solo: local wanderer physics (no server reachable)
     - live: js/net.js feeds positions from the Convoy server
   The rest of the app (ui/party/mapview/routing) never needs to know which is active. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store, D = A.data;

  var TICK_MS = 1000;       // solo physics step / UI refresh cadence
  var GLOBAL_MS = 45000;    // solo global feed refresh
  var NEARBY_N = 14;
  var MAX_RANGE = 5200;
  var MAX_EXTRAP_S = 1.6;   // cap on dead-reckoning prediction past the last known point
  var OFF_ROUTE_M = 55;     // lateral deviation (m) that counts as "off the planned route"
  var OFF_ROUTE_MS = 5000;  // ...sustained this long before we auto-reroute (ignores GPS jitter)

  var player = { pos: S.playerStart.slice(), heading: 0 };
  var npcs = {};            // id -> rider
  var npcOrder = [];
  var solo = false;
  // Local player's dragy stats (PBs + race counters). Mirrors what the server
  // stores; kept in sync via adoptStats() and read by the profile overlay. Stays
  // null for guests.
  var selfStats = null;
  var lastFrame = 0;
  var linksAt = 0;
  var linksSig = ''; // position signature of the last convoy-link build (skip no-op rebuilds)
  var uiTickAt = 0;
  var started = false;
  var globalTimer = null;

  /* ---------------- rider records ---------------- */
  function baseRider(rec) {
    var now = performance.now();
    return {
      id: rec.id,
      name: rec.name,
      handle: rec.handle,
      emoji: rec.emoji,
      avatar: rec.avatar || null, // profile photo data URL (null = insignia glyph)
      vibe: rec.vibe,
      car: rec.car,
      account: rec.account || null, // username when this rider is a signed-in account
      stats: rec.stats || null,     // dragy PBs + race win/run counters (null on guests/bots)
      pos: rec.pos.slice(),
      heading: rec.heading || 0,
      speed: rec.speed || 10,
      mode: rec.mode || 'cruise',
      member: false,
      invited: false,
      prev: { pos: rec.pos.slice(), heading: rec.heading || 0 },
      next: { pos: rec.pos.slice(), heading: rec.heading || 0 },
      tAt: now,
      tDur: TICK_MS,
      lastSet: now,
      // dead-reckoning state: velocity derived from server position deltas
      srvPos: null,
      srvAt: now,
      pSpeed: 0,        // predicted speed, m/s
      pBear: rec.heading || 0
    };
  }

  function addRider(rec) {
    if (npcs[rec.id]) return npcs[rec.id];
    var npc = baseRider(rec);
    npcs[npc.id] = npc;
    npcOrder.push(npc.id);
    A.mapview.addNpc(npc);
    return npc;
  }

  function removeRider(id) {
    var npc = npcs[id];
    if (!npc) return;
    A.mapview.removeNpc(id);
    delete npcs[id];
    var i = npcOrder.indexOf(id);
    if (i >= 0) npcOrder.splice(i, 1);
  }

  function clearRiders() {
    npcOrder.slice().forEach(removeRider);
  }

  // Record a new target; current interpolated state becomes the start point.
  // Velocity is derived from true server position deltas (not the rendered pos),
  // so prediction stays accurate even after we've extrapolated past the last point.
  function setNext(npc, pos, heading, mode) {
    var now = performance.now();
    var parked = mode === 'parked';
    if (parked) {
      // A parked rider is stopped: zero the predicted speed immediately so the
      // marker doesn't jump at the old cruise velocity the moment it flips back
      // to cruise (the extrapolation in frame() reads pSpeed).
      npc.pSpeed = 0;
      if (heading != null) npc.pBear = heading;
    } else if (npc.srvPos) {
      var dts = U.clamp(now - npc.srvAt, 120, 3000) / 1000;
      var moved = U.haversine(npc.srvPos, pos);
      var raw = U.clamp(moved / dts, 0, 70);
      // Exponential smoothing of speed + heading so a driver glides at a steady
      // predicted velocity instead of twitching on each noisy per-tick sample.
      npc.pSpeed = npc.pSpeed > 0.05 ? npc.pSpeed * 0.6 + raw * 0.4 : raw;
      if (moved > 0.6) npc.pBear = U.lerpAngle(npc.pBear, U.bearing(npc.srvPos, pos), 0.5);
      else if (heading != null) npc.pBear = heading;
    } else {
      npc.pSpeed = 0;
      if (heading != null) npc.pBear = heading;
    }
    npc.srvPos = pos.slice();
    npc.srvAt = now;

    npc.prev = {
      pos: (npc.livePos || npc.next.pos).slice(),
      heading: npc.liveBrg != null ? npc.liveBrg : npc.next.heading
    };
    npc.next = { pos: pos.slice(), heading: heading };
    npc.tDur = U.clamp(now - npc.lastSet, 250, 2500);
    npc.tAt = now;
    npc.lastSet = now;
    npc.pos = pos.slice();
    npc.heading = heading;
    if (mode) npc.mode = mode;
  }

  /* ---------------- solo source ---------------- */
  function randomCar() {
    var make = U.pick(D.MAKE_LIST);
    var model = U.pick(D.MAKES[make]);
    var trims = (D.VEHICLES && D.VEHICLES[make] && D.VEHICLES[make][model]) || [];
    var paint = U.pick(D.PAINTS);
    return {
      year: U.randInt(1995, 2026), make: make, model: model,
      trim: trims.length ? U.pick(trims) : '',
      paint: paint.hex, paintName: paint.name, finish: U.pick(D.FINISHES)
    };
  }

  function spawnLocal(center) {
    var name = U.pick(D.NAMES);
    return {
      id: U.uid(),
      name: name,
      handle: name.toLowerCase() + U.randInt(2, 99),
      emoji: U.pick(D.EMOJIS),
      vibe: U.pick(D.VIBES),
      car: randomCar(),
      pos: U.destPoint(center, U.rand(0, 360), U.rand(300, 4200)),
      heading: U.rand(0, 360),
      speed: U.rand(7, 19),
      mode: U.chance(0.22) ? 'parked' : 'cruise'
    };
  }

  // Solo simulation is DISABLED in the production build. Previously this spawned
  // ~14 fake nearby riders + ambient global dots so the app felt populated when
  // the server was unreachable. Now: no fake riders — offline/no-server shows an
  // empty map (just the player marker), which is honest. No crash: the render
  // loop iterates an empty npcOrder. netMode stays 'connecting' so the UI reads
  // truthfully; net.js toasts the real situation.
  function enableSolo() {
    S.netMode = 'connecting';
    ST.emit('nearby:seeded', 0);
  }

  function disableSolo() {
    solo = false;
    if (globalTimer) { clearInterval(globalTimer); globalTimer = null; }
    clearRiders();
  }

  function tick() {
    if (solo) {
      var dt = TICK_MS / 1000;
      var memberIdx = 0;
      npcOrder.forEach(function (id) {
        var npc = npcs[id];
        if (npc.member) stepMember(npc, memberIdx++, dt);
        else stepWanderer(npc, dt);
      });
    }
    ST.emit('tick');
  }

  function stepWanderer(npc, dt) {
    if (npc.mode === 'parked') {
      if (U.chance(0.05)) npc.mode = 'cruise';
      setNext(npc, npc.pos, npc.heading);
      return;
    }
    if (U.chance(0.02)) { npc.mode = 'parked'; setNext(npc, npc.pos, npc.heading); return; }
    var heading = (npc.heading + U.rand(-22, 22) + 360) % 360;
    var d = U.haversine(npc.pos, player.pos);
    if (d > MAX_RANGE) {
      heading = U.lerpAngle(heading, U.bearing(npc.pos, player.pos) + U.rand(-25, 25), 0.45);
    }
    npc.speed = U.clamp(npc.speed + U.rand(-1.5, 1.5), 6, 21);
    setNext(npc, U.destPoint(npc.pos, heading, npc.speed * dt), heading);
  }

  function stepMember(npc, idx, dt) {
    var trailBrg = (player.heading + 180) % 360;
    var target = U.destPoint(player.pos, trailBrg, 60 + 70 * (idx + 1));
    target = U.destPoint(target, (player.heading + 90) % 360, (idx % 2 === 0 ? 16 : -16));
    var d = U.haversine(npc.pos, target);
    if (d < 6) { setNext(npc, npc.pos, npc.heading); return; }
    var speed = U.clamp(d * 0.5, 3, d > 700 ? 60 : 34);
    var heading = U.lerpAngle(npc.heading, U.bearing(npc.pos, target), 0.55);
    setNext(npc, U.destPoint(npc.pos, heading, Math.min(speed * dt, d)), heading);
  }

  // Persistent moving global drivers for solo mode. Seeded once, then stepped
  // each refresh so they visibly drift around their city instead of teleporting.
  var ambientDrivers = null;
  function ensureAmbient() {
    if (ambientDrivers) return;
    ambientDrivers = [];
    D.CITIES.forEach(function (c) {
      var n = U.randInt(3, 7);
      for (var i = 0; i < n; i++) {
        ambientDrivers.push({
          name: U.pick(D.NAMES) + ' ' + U.pick(['R.', 'K.', 'M.', 'T.', 'S.', 'J.']),
          emoji: U.pick(D.EMOJIS),
          carStr: (function () { var cr = randomCar(); return cr.year + ' ' + cr.make + ' ' + cr.model; })(),
          city: c[0],
          base: [c[1], c[2]],
          pos: U.destPoint([c[1], c[2]], U.rand(0, 360), U.rand(400, 9000)),
          heading: U.rand(0, 360),
          speed: U.rand(7, 19),
          online: true,
          lastSeen: Date.now() - U.randInt(0, 6) * 60000
        });
      }
    });
  }

  function stepAmbientLocal(a, dt) {
    if (!a.online) {
      if (U.chance(0.04)) {
        a.online = true; a.lastSeen = Date.now();
        a.pos = U.destPoint(a.base, U.rand(0, 360), U.rand(400, 9000));
        a.heading = U.rand(0, 360); a.speed = U.rand(7, 19);
      }
      return;
    }
    var d = U.haversine(a.pos, a.base);
    if (d > 11000) { a.pos = U.destPoint(a.base, U.rand(0, 360), U.rand(400, 9000)); a.heading = U.rand(0, 360); return; }
    if (Date.now() - a.lastSeen > U.randInt(8, 22) * 60000 && U.chance(0.03)) { a.online = false; return; }
    a.heading = (a.heading + U.rand(-22, 22) + 360) % 360;
    if (d > 9000) a.heading = U.lerpAngle(a.heading, U.bearing(a.pos, a.base) + U.rand(-25, 25), 0.45);
    a.speed = U.clamp(a.speed + U.rand(-1.5, 1.5), 6, 21);
    a.pos = U.destPoint(a.pos, a.heading, a.speed * dt);
    a.lastSeen = Date.now();
  }

  function buildLocalGlobal() {
    ensureAmbient();
    var dt = GLOBAL_MS / 1000;
    var feats = [];
    ambientDrivers.forEach(function (a) {
      stepAmbientLocal(a, dt);
      if (!a.online) return;
      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: a.pos.slice() },
        properties: {
          name: a.name, emoji: a.emoji, car: a.carStr, city: a.city,
          seenMin: U.randInt(3, 9), online: true
        }
      });
    });
    A.mapview.setGlobalData({ type: 'FeatureCollection', features: feats });
  }

  /* ---------------- live source api (used by net.js) ---------------- */
  function remoteAdd(rec) { addRider(rec); ST.emit('nearby:seeded', npcOrder.length); }
  function remoteRemove(id) { removeRider(id); ST.emit('nearby:seeded', npcOrder.length); }
  function remoteTick(rows) {
    // rows: [[id, lng, lat, heading, parked], ...]
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var npc = npcs[r[0]];
      if (npc) setNext(npc, [r[1], r[2]], r[3], r[4] ? 'parked' : 'cruise');
    }
  }
  function remoteProfile(id, profile) {
    var npc = npcs[id];
    if (!npc) return;
    npc.name = profile.name;
    npc.handle = profile.handle;
    npc.emoji = profile.emoji;
    npc.avatar = profile.avatar || null;
    npc.vibe = profile.vibe;
    npc.car = profile.car;
    A.mapview.removeNpc(id);
    A.mapview.addNpc(npc);
    if (npc.member) A.mapview.setNpcMember(id, true);
    ST.emit('nearby:seeded', npcOrder.length);
  }

  // Stats arrived over the wire (a rider set a dragy PB). Update the NPC record
  // and nudge any open profile view to refresh.
  function remoteStats(id, stats) {
    var npc = npcs[id];
    if (!npc) return;
    npc.stats = stats || null;
    ST.emit('stats', { id: id, stats: stats });
  }

  /* ---------------- trip motion + follow camera ---------------- */
  var camBearing = 0;
  var gpsFollow = true; // keep the camera centered on real GPS fixes (until the user pans)
  var adaptivePauseUntil = 0; // manual zoom during a trip pauses adaptive zoom until this perf-time

  function stepTrip(now, dt) {
    var trip = S.trip;
    if (!trip || !trip.active) return;

    // Live GPS navigation: once a real fix has arrived (trip.gotFix, set by the
    // geolocation watch / native bridge), the rider's ACTUAL position drives
    // progress — we snap it onto the route via progressAt. Until the first fix,
    // or in preview playback (mult > 1, live=false), advance the simulated dot so
    // the trip never freezes when there's no GPS (desktop demo, denied permission).
    var at;
    var liveDriven = trip.live && trip.gotFix;
    var showPos = player.pos;
    if (liveDriven) {
      // Dead-reckon the displayed position between ~1 Hz fixes (same coast-down
      // profile as the NPC extrapolation) so the car glides down the road while
      // navigating instead of hopping fix-to-fix. player.pos (state/network)
      // stays the last REAL fix; prediction drift is capped at MAX_EXTRAP_S and
      // is far below OFF_ROUTE_M, so it can never trigger a bogus reroute.
      if (gpsPred && gpsPred.speed != null && gpsPred.speed > MOVING_MS) {
        var pAge = (Date.now() - gpsPred.at) / 1000;
        if (pAge > 0 && pAge <= MAX_EXTRAP_S) {
          var pSpd = gpsPred.speed * (1 - 0.4 * (pAge / MAX_EXTRAP_S));
          var pBrg = gpsPred.heading != null ? gpsPred.heading : player.heading || 0;
          showPos = U.destPoint(gpsPred.pos, pBrg, pSpd * pAge);
        }
      }
      var snap = A.routing.nearestOnRoute(trip.line, showPos);
      // Monotonic: GPS jitter must not drag progress backwards along the route.
      trip.progress = Math.max(trip.progress, snap.m);
      at = A.routing.posAt(trip.line, trip.progress);
      A.mapview.setPlayer(showPos, at.brg); // marker on the (predicted) fix, arrow down-route
      // Off-route → debounced auto-reroute. Require the deviation to persist so GPS
      // jitter or a brief lane straddle doesn't trigger a needless recalculation.
      var nearEnd = (trip.line.total - trip.progress) < 40;
      if (snap.devM > OFF_ROUTE_M && !nearEnd) {
        if (!trip.offSince) trip.offSince = now;
        else if (now - trip.offSince > OFF_ROUTE_MS) { trip.offSince = 0; A.routing.reroute(); }
      } else {
        trip.offSince = 0;
      }
    } else {
      trip.progress += trip.baseSpeed * trip.mult * dt;
      at = A.routing.posAt(trip.line, trip.progress);
      player.pos = at.pos;
      player.heading = at.brg;
      A.mapview.setPlayer(at.pos, at.brg);
    }

    if (trip.follow) {
      camBearing = U.lerpAngle(camBearing, at.brg, 1 - Math.pow(0.004, dt));
      var cam = { center: liveDriven ? showPos : at.pos, bearing: camBearing };
      if (trip.camIntro) {
        var map = A.mapview.map();
        var z = U.lerp(map.getZoom(), 15.8, 1 - Math.pow(0.02, dt));
        var p = U.lerp(map.getPitch(), 54, 1 - Math.pow(0.02, dt));
        cam.zoom = z; cam.pitch = p;
        if (Math.abs(z - 15.8) < 0.05 && Math.abs(p - 54) < 0.5) trip.camIntro = false;
      } else if (S.settings.adaptiveZoom && now > adaptivePauseUntil) {
        // Speed-adaptive follow zoom: ease out on the highway for lookahead, back
        // in around town for detail. A manual wheel/pinch zoom pauses this for a
        // while so the camera never fights the rider's fingers.
        var v = liveDriven ? ((gpsPred && gpsPred.speed) || 0) : trip.baseSpeed * trip.mult;
        var tz = U.clamp(16.4 - (v / 38) * 2.6, 13.8, 16.4); // 0 m/s → 16.4 … 38 m/s (~85 mph) → 13.8
        var cz = A.mapview.map().getZoom();
        if (Math.abs(cz - tz) > 0.08) cam.zoom = U.lerp(cz, tz, 1 - Math.pow(0.25, dt));
      }
      A.mapview.jumpCam(cam);
    }

    if (now - uiTickAt > 250) {
      uiTickAt = now;
      A.routing.updateTripUI();
    }

    // Voice navigation: announce turns/continues as they're crossed. Checked
    // every frame so high speed multipliers never skip a maneuver.
    if (A.routing.announceCues) A.routing.announceCues(trip.progress);

    if (trip.progress >= trip.line.total) A.routing.endTrip(true);
  }

  function breakFollow() {
    var trip = S.trip, changed = false;
    if (trip && trip.active && trip.follow) { trip.follow = false; changed = true; }
    if (gpsFollow) { gpsFollow = false; changed = true; } // user panned away from their GPS position
    if (changed) {
      var r = document.getElementById('ctl-recenter');
      if (r) r.hidden = false;
    }
  }

  function resumeFollow() {
    var trip = S.trip;
    if (trip && trip.active) {
      trip.follow = true;
      trip.camIntro = true;
      camBearing = A.mapview.map().getBearing();
    }
    gpsFollow = true;                    // resume tracking my real GPS position too
    A.mapview.followPlayer(player.pos);  // recenter on me now
    var r = document.getElementById('ctl-recenter');
    if (r) r.hidden = true;
  }

  /* ---------------- render loop ---------------- */
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    var dt = Math.min((now - (lastFrame || now)) / 1000, 0.1);
    lastFrame = now;

    npcOrder.forEach(function (id) {
      var npc = npcs[id];
      var elapsed = now - npc.tAt;
      var t = elapsed / npc.tDur;
      var pos, brg;
      if (t <= 1) {
        // smoothly interpolate between the last two known points
        pos = U.lerpPos(npc.prev.pos, npc.next.pos, t);
        brg = U.lerpAngle(npc.prev.heading, npc.next.heading, t);
      } else if (npc.pSpeed > 0.6 && npc.mode !== 'parked') {
        // no fresh data yet — dead-reckon forward along the smoothed velocity (capped). Ease the
        // speed down as the gap grows so the car coasts to a glide instead of overshooting and
        // snapping back when the next update lands.
        var extrap = Math.min((elapsed - npc.tDur) / 1000, MAX_EXTRAP_S);
        var s = npc.pSpeed * (1 - 0.4 * (extrap / MAX_EXTRAP_S));
        pos = U.destPoint(npc.next.pos, npc.pBear, s * extrap);
        brg = npc.pBear;
      } else {
        pos = npc.next.pos;
        brg = npc.next.heading;
      }
      A.mapview.updateNpc(id, pos, brg);
      npc.livePos = pos;
      npc.liveBrg = brg;
    });

    // Player dead-reckoning: glide the marker forward along the last GPS fix's
    // velocity so the car moves smoothly between ~1 Hz fixes instead of hopping.
    // Same coast-down profile as the NPC extrapolation above. Purely visual —
    // player.pos (state, network, routing) stays the last REAL fix. Trips own
    // the marker via stepTrip, so prediction only runs outside an active trip.
    if (gpsPred && !(S.trip && S.trip.active)) {
      var pAge = (Date.now() - gpsPred.at) / 1000;
      if (gpsPred.speed != null && gpsPred.speed > MOVING_MS && pAge > 0 && pAge <= MAX_EXTRAP_S) {
        var pSpd = gpsPred.speed * (1 - 0.4 * (pAge / MAX_EXTRAP_S));
        A.mapview.setPlayer(U.destPoint(gpsPred.pos, gpsPred.heading || 0, pSpd * pAge), gpsPred.heading);
      }
    }

    stepTrip(now, dt);

    if (S.party && S.party.members.length && now - linksAt > 250) {
      linksAt = now;
      var feats = [];
      // Signature for the no-op skip. Use the LAST SERVER POSITION (npc.pos), not
      // the predicted livePos — livePos shifts every frame via dead-reckoning, so
      // keying on it would force a setData every 250ms even when no rider actually
      // moved. Drawing uses livePos (smooth tether); the gate uses real positions.
      var sig = player.pos[0].toFixed(5) + ',' + player.pos[1].toFixed(5) + '|' + (S.party.id || '') + '|' + S.party.members.length;
      S.party.members.forEach(function (id) {
        var npc = npcs[id];
        if (!npc) return;
        sig += ';' + npc.pos[0].toFixed(5) + ',' + npc.pos[1].toFixed(5);
        feats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [player.pos, npc.livePos || npc.pos] }
        });
      });
      // Skip the map source setData when no rider's real position changed since
      // the last build. The line still tracks livePos at rebuild time; between
      // rebuilds the small prediction drift is invisible against a moving player.
      if (sig !== linksSig) {
        linksSig = sig;
        A.mapview.setLinksData({ type: 'FeatureCollection', features: feats });
      }
    }
  }

  /* ---------------- real GPS ---------------- */
  var watchId = null;
  var lastAccuracy = null;
  // player.pos starts at the demo spawn — flips true the first time a REAL
  // position lands (GPS fix, native fix, or an explicit relocate), so consumers
  // like the search bias can tell "the rider is here" from "nobody knows yet".
  var hasRealPos = false;
  // Last real GPS fix + velocity, for between-fix dead reckoning of the player
  // marker (fixes land ~1/s; without prediction the car visibly hops fix-to-fix).
  var gpsPred = null; // { pos, speed (m/s|null), heading, at }
  var ACCURACY_THRESHOLD = 100; // reject GPS points worse than 100m
  var deniedToldOnce = false;   // "permission denied" is a once-per-session message

  /* ---------------- stationary jitter filter ----------------
     A parked phone's GPS wanders ±5–25m fix to fix, which made the car dot
     dance (and the heading spin) while standing dead still. Hold the dot at an
     anchor until either the receiver reports real Doppler speed — instant on
     launch, so timed runs never start late — or the fix escapes an
     accuracy-scaled hold radius (covers devices that never report speed).
     Only the DISPLAYED/shared position is filtered; dragy and the other
     gpsfix consumers still get the raw fix. */
  var MOVING_MS = 1.2; // m/s of speed that counts as actually moving (~2.7 mph)
  var holdPos = null;  // [lng,lat] anchor while parked
  // Last raw fix, used to derive speed when the receiver reports no Doppler.
  var lastRaw = null;  // { pos, t }
  function steadyFix(pos, acc, speed, t) {
    t = t || Date.now();
    // Derive speed from the position delta when Doppler is missing. Without this
    // the hold gate never released on Doppler-less hardware: a car doing 20 mph
    // covers ~9 m between 1 Hz fixes, under the 12–30 m gate, so the marker sat
    // frozen and only jumped once it had drifted a whole gate-width down the road.
    var eff = speed;
    if (eff == null && lastRaw) {
      var dt = (t - lastRaw.t) / 1000;
      if (dt > 0.2 && dt < 6) eff = U.haversine(lastRaw.pos, pos) / dt;
    }
    lastRaw = { pos: pos.slice(), t: t };

    if (eff != null && eff > MOVING_MS) { holdPos = null; return pos; }
    if (!holdPos) { holdPos = pos.slice(); return pos; }
    var gate = Math.max(12, Math.min(30, acc != null ? acc : 20));
    if (U.haversine(holdPos, pos) <= gate) return holdPos; // parked — hold still
    holdPos = pos.slice(); // walked/coasted out of the hold circle — re-anchor
    return pos;
  }

  function updateGpsDot(accuracy) {
    lastAccuracy = accuracy;
    var dot = document.getElementById('gps-dot');
    if (!dot) return;
    if (accuracy == null) dot.className = 'gps-dot gps-none';
    else if (accuracy <= 25) dot.className = 'gps-dot gps-good';
    else if (accuracy <= 100) dot.className = 'gps-dot gps-ok';
    else dot.className = 'gps-dot gps-poor';
    dot.title = accuracy != null ? ('GPS ±' + Math.round(accuracy) + 'm') : 'No GPS fix';
  }

  function startWatch() {
    if (watchId != null || !navigator.geolocation) return;
    // Inside the Capacitor shell, request the Android location permission before
    // starting the watch — otherwise watchPosition never delivers fixes.
    if (A.config.isNative && A.config.plugins && A.config.plugins.Geolocation) {
      A.config.plugins.Geolocation.requestPermissions().then(beginWatch, beginWatch);
    } else {
      beginWatch();
    }
  }

  function beginWatch() {
    if (watchId != null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(function (p) {
      // A simulated (preview) trip owns the camera/position; a LIVE trip is the
      // opposite — it WANTS the real fix, so stepTrip can drive progress from it.
      var liveTrip = S.trip && S.trip.active && S.trip.live;
      if (S.trip && S.trip.active && !S.trip.live) return;
      var acc = p.coords.accuracy;
      updateGpsDot(acc);
      if (acc != null && acc > ACCURACY_THRESHOLD) return; // skip inaccurate readings
      var raw = [p.coords.longitude, p.coords.latitude];
      // Doppler speed first — heading + the jitter filter both key off it.
      var fixSpeed = (p.coords.speed != null && !isNaN(p.coords.speed) && p.coords.speed >= 0) ? p.coords.speed : null;
      // Heading only updates while actually moving — stationary GPS courses are
      // noise and used to spin the car marker at a stoplight.
      if (fixSpeed != null && fixSpeed > MOVING_MS &&
          p.coords.heading != null && !isNaN(p.coords.heading)) player.heading = p.coords.heading;
      var pos = steadyFix(raw, acc, fixSpeed, p.timestamp);
      player.pos = pos;
      hasRealPos = true;
      if (liveTrip) S.trip.gotFix = true; // stepTrip now snaps this real position onto the route
      gpsPred = { pos: pos, speed: fixSpeed, heading: player.heading, at: Date.now() };
      // Feed the performance meter (dragy.js) the RAW fix: the timer needs true
      // position deltas; only the displayed/shared position is jitter-held.
      ST.emit('gpsfix', {
        pos: raw,
        speed: fixSpeed,
        acc: acc,
        heading: player.heading,
        t: p.timestamp || Date.now()
      });
      // Outside a trip we place the marker / follow here; during a live trip
      // stepTrip owns the marker + follow camera (centred on the real fix).
      if (!liveTrip) {
        A.mapview.setPlayer(pos, player.heading);
        // Globe boot: the first real fix lands the intro even with follow-cam off.
        if (A.mapview.landIntro) A.mapview.landIntro(pos, 15);
        if (gpsFollow && S.settings.followCam) A.mapview.followPlayer(pos);
      }
    }, function (err) {
      // 1 = denied, 2 = position unavailable, 3 = timeout. Timeout was unhandled,
      // so the GPS pill kept showing the last good accuracy indefinitely after the
      // receiver stopped answering — it read "fix healthy" with no fix at all.
      // watchPosition can re-fire PERMISSION_DENIED on every attempt, so say it once.
      if (err.code === 1) {
        if (!deniedToldOnce) { deniedToldOnce = true; A.ui.toast('Location permission denied', 'warn'); }
        updateGpsDot(null);
      } else updateGpsDot(null);
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
  }

  function relocatePlayer(pos) {
    player.pos = pos.slice();
    holdPos = null; // fresh location — drop the stationary anchor
    lastRaw = null; // ...and the delta baseline, so the jump isn't read as speed
    hasRealPos = true; // an explicit relocate is as good as a fix for "the rider is here"
    A.mapview.setPlayer(pos, player.heading);
    if (solo) {
      npcOrder.forEach(function (id) {
        var npc = npcs[id];
        npc.pos = npc.member
          ? U.destPoint(pos, U.rand(0, 360), U.rand(80, 300))
          : U.destPoint(pos, U.rand(0, 360), U.rand(300, 4200));
        npc.prev = { pos: npc.pos.slice(), heading: npc.heading };
        npc.next = { pos: npc.pos.slice(), heading: npc.heading };
        npc.livePos = null;
        A.mapview.updateNpc(id, npc.pos, npc.heading);
      });
    } else if (A.net) {
      A.net.sendPosNow(); // server re-scopes riders around the new position
    }
    startWatch();
    ST.emit('tick');
  }

  // Apply a position fix that originates OUTSIDE the WebView's own watchPosition —
  // namely the native background-location foreground service (js/native.js). Mirrors
  // the in-WebView watch handler so the player marker, gpsfix consumers (dragy, radar)
  // and follow-cam behave identically whether the fix came from JS or native code.
  function externalFix(f) {
    if (!f || typeof f.lng !== 'number' || typeof f.lat !== 'number') return;
    // A simulated (preview) trip owns the camera/position; a LIVE trip wants the
    // real fix so stepTrip can drive progress from it (mirrors the watch handler).
    var liveTrip = S.trip && S.trip.active && S.trip.live;
    if (S.trip && S.trip.active && !S.trip.live) return;
    var raw = [f.lng, f.lat];
    var fixSpeed = (f.speed != null && f.speed >= 0) ? f.speed : null;
    // Same stationary gates as the in-WebView watch: heading + position hold.
    if (fixSpeed != null && fixSpeed > MOVING_MS &&
        f.bearing != null && !isNaN(f.bearing)) player.heading = f.bearing;
    var pos = steadyFix(raw, (typeof f.accuracy === 'number') ? f.accuracy : null, fixSpeed, f.time);
    player.pos = pos;
    hasRealPos = true;
    gpsPred = {
      pos: pos,
      speed: fixSpeed,
      heading: player.heading,
      at: Date.now()
    };
    if (liveTrip) S.trip.gotFix = true;
    if (typeof f.accuracy === 'number') { lastAccuracy = f.accuracy; updateGpsDot(f.accuracy); }
    ST.emit('gpsfix', {
      pos: raw,
      speed: fixSpeed,
      acc: (typeof f.accuracy === 'number') ? f.accuracy : null,
      heading: player.heading,
      t: f.time || Date.now()
    });
    if (!liveTrip) {
      A.mapview.setPlayer(pos, player.heading);
      // Globe boot: the first real fix lands the intro even with follow-cam off.
      if (A.mapview.landIntro) A.mapview.landIntro(pos, 15);
      if (gpsFollow && S.settings.followCam) A.mapview.followPlayer(pos);
    }
  }

  /* ---------------- api ---------------- */
  var tickTimer = null;
  function start() {
    if (started) return;
    started = true;
    A.mapview.createPlayerMarker(player.pos);
    tickTimer = setInterval(tick, TICK_MS);
    requestAnimationFrame(frame);
    // A manual wheel/pinch zoom wins over adaptive zoom for a while (see stepTrip).
    try {
      var cc = A.mapview.map().getCanvasContainer();
      cc.addEventListener('wheel', function () { adaptivePauseUntil = performance.now() + 12000; }, { passive: true });
      cc.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches.length > 1) adaptivePauseUntil = performance.now() + 12000;
      }, { passive: true });
    } catch (e) { }
    // Pause the solo physics tick while the tab is hidden: it used to keep
    // running in the background, so NPC tAt timestamps drifted and riders
    // visibly "jumped" on refocus. The rAF loop already no-ops when hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      } else if (!tickTimer) {
        tickTimer = setInterval(tick, TICK_MS);
        tick(); // catch up immediately on return
      }
    });
  }

  function getNearbySorted() {
    return npcOrder.map(function (id) { return npcs[id]; })
      .map(function (npc) {
        return { npc: npc, dist: U.haversine(player.pos, npc.livePos || npc.pos) };
      })
      .sort(function (a, b) { return a.dist - b.dist; });
  }

  /* ---------------- proximity matching ----------------
     Shared definition of "around the driver" — the Nearby panel filters, the
     filter-aware map dot colors, and proximity voice chat all use this so a
     rider shown as "in sight" is exactly the rider voice auto-connects to.
       radius — within 2 km in any direction
       road   — same street corridor (small cross-track) up to 4 km ahead/behind
       sight  — inside the forward field of view within 400 m */
  var PROX = {
    radius: { range: 2000 },
    road:   { range: 4000, cross: 60 },
    sight:  { range: 400,  fov: 70 }
  };

  // margin (default 1) scales the distance limits — voice passes >1 as an exit
  // threshold so peers don't flap in/out of scope right at the boundary.
  function proximityMatch(npc, mode, margin) {
    var cfg = PROX[mode];
    if (!cfg || !npc) return false;
    var m = margin || 1;
    var pos = npc.livePos || npc.pos;
    if (!pos || !player.pos) return false;
    if (U.haversine(player.pos, pos) > cfg.range * m) return false;
    if (mode === 'road') return U.crossTrack(player.pos, player.heading, pos) <= cfg.cross * m;
    if (mode === 'sight') return Math.abs(U.relBearing(player.pos, player.heading, pos)) <= cfg.fov;
    return true;
  }

  function proximityIds(mode, margin) {
    var out = [];
    for (var i = 0; i < npcOrder.length; i++) {
      var npc = npcs[npcOrder[i]];
      if (npc && proximityMatch(npc, mode, margin)) out.push(npc.id);
    }
    return out;
  }

  A.sim = {
    start: start,
    enableSolo: enableSolo,
    disableSolo: disableSolo,
    isSolo: function () { return solo; },
    playerHeading: function () { return player.heading; },
    getNpc: function (id) { return npcs[id]; },
    getByUsername: function (username) {
      if (!username) return null;
      for (var i = 0; i < npcOrder.length; i++) {
        var n = npcs[npcOrder[i]];
        if (n.account && n.account === username) return n;
      }
      return null;
    },
    getNearbySorted: getNearbySorted,
    proximityMatch: proximityMatch,   // shared "around the driver" test (nearby filters + voice)
    proximityIds: proximityIds,
    count: function () { return npcOrder.length; },
    relocatePlayer: relocatePlayer,
    externalFix: externalFix,
    ensureWatch: startWatch,   // start the foreground GPS watch on demand (idempotent)
    playerPos: function () { return player.pos ? player.pos.slice() : null; }, // live rider position, for nearby search bias
    hasRealPos: function () { return hasRealPos; }, // false until a real fix/relocate replaces the demo spawn
    lastAccuracy: function () { return lastAccuracy; },
    breakFollow: breakFollow,
    resumeFollow: resumeFollow,
    remoteAdd: remoteAdd,
    remoteRemove: remoteRemove,
    remoteTick: remoteTick,
    remoteProfile: remoteProfile,
    remoteStats: remoteStats,
    // Stats for a rider by NPC id; pass 'self' (or null) for the local player's
    // own stats. The player's own stats aren't stored on an NPC — they live in a
    // dedicated slot kept in sync by adoptStats().
    getStats: function (id) {
      if (id == null || id === 'self') return selfStats;
      var npc = npcs[id];
      return npc ? npc.stats : null;
    },
    // Adopt authoritative stats for the local player (from /api/dragy/pb or a
    // dragy:pb echo) and notify any open profile view.
    adoptStats: function (stats) {
      selfStats = stats || null;
      ST.emit('stats', { id: 'self', stats: selfStats });
    }
  };
})();
