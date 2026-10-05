/* Convoy — enforcement pack: police-avoiding routes and the cruise-loop planner
   (the hunks the 2026-10-04 cut took out of js/routing.js).

   POLICE AVOIDANCE rides A.routing.hook('routes'): the core fetches the
   alternatives and draws the fastest one at once (snappy); this hook captures
   the list and, in the background, pulls police stations + speed cameras
   (OpenStreetMap through the server's Overpass proxy) across the routes'
   bounding box, counts how many sit within POLICE_AVOID_M of each candidate,
   and quietly swaps in the cleanest one through A.routing.applyRoute — or
   builds its own waypoint detour around the worst on-route POI when every
   alternative passes one. Keyless, and off by default (settings.js).

   THE CRUISE LOOP is one tap → a route that leaves from where the rider is
   and loops back to the same spot, scored keyless via Overpass (police and
   cameras heavily penalised, stop signs and signals penalised, size mildly).
   If Overpass is down, the loop with the highest average speed wins.

   OSRM is called directly for the extra geometry (the via and the multi-point
   loop), as the core's keyless fallback does; the pack carries its own copy of
   the step parser because the core keeps parseSteps private. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util;
  var E = (A.enforcement = A.enforcement || {});

  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var OSRM_MS = 9000;          // a hung OSRM used to leave the UI stuck forever
  var OVERPASS_MS = 75000;     // the server tries 2 mirrors × 30 s before answering
  var POLICE_AVOID_M = 160;    // a route coord within this of a police/camera POI counts as a "pass"
  var OVERPASS = '/api/enforcement/overpass';

  function api(path, params, ms) { return E.api(path, params, ms); }
  function fetchJSON(url, opts, ms) {
    return U.fetchT(url, opts, ms).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Flatten OSRM legs→steps into one ordered cue list keyed by distance-along-
  // route. Mirrors js/routing.js parseSteps so a detour carries the same voice
  // cues the core's own routes do.
  function parseSteps(route) {
    var cues = [];
    var dist = 0;
    (route.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (st) {
        var m = (st.maneuver || {});
        cues.push({ at: dist, type: m.type, mod: m.modifier, name: st.name || '', exit: m.exit });
        dist += st.distance || 0;
      });
    });
    return cues;
  }
  function osrmRoute(r) {
    return { distance: r.distance, duration: r.duration, coords: r.geometry.coordinates, steps: parseSteps(r) };
  }

  // The bounding box of a set of routes, padded, or null when it is too wide
  // to ask Overpass about.
  function routesBbox(routes, pad, maxSpan) {
    var minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
    routes.forEach(function (r) {
      r.coords.forEach(function (c) {
        if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      });
    });
    minLat -= pad; minLng -= pad; maxLat += pad; maxLng += pad;
    if ((maxLat - minLat) > maxSpan || (maxLng - minLng) > maxSpan) return null;
    return { minLat: minLat, minLng: minLng, maxLat: maxLat, maxLng: maxLng };
  }
  function elementCoord(e) {
    var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
    var lon = e.lon != null ? e.lon : (e.center && e.center.lon);
    return (lat != null && lon != null) ? [lon, lat] : null;
  }

  /* ---------------- police / speed-camera avoidance ---------------- */
  var lastPolice = null; // AbortController for the most recent Overpass query
  function fetchPoliceForRoutes(routes) {
    // Cross-country routes would make a huge Overpass query — skip avoidance there.
    var bb = routesBbox(routes, 0.01, 3);
    if (!bb) return Promise.resolve(null);
    if (lastPolice) { try { lastPolice.abort(); } catch (e) {} }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    lastPolice = ctrl;
    var params = { kind: 'police', minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng };
    return api(OVERPASS, params, OVERPASS_MS).then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .then(function (j) {
        var pts = [], els = (j && j.elements) || [];
        for (var i = 0; i < els.length; i++) { var c = elementCoord(els[i]); if (c) pts.push(c); }
        return pts;
      }).catch(function () { return null; }); // null = couldn't fetch (keep fastest route)
  }

  // How many police/camera POIs the route passes within POLICE_AVOID_M. Hash the
  // route's vertices into a coarse lat/lng grid whose cell is ~POLICE_AVOID_M
  // across, then test each POI only against the vertices in its own cell and
  // the eight around it. Same answer as the nested loop, near-linear.
  function policeHits(coords, police) {
    if (!police || !police.length || !coords || !coords.length) return 0;
    var midLat = coords[(coords.length / 2) | 0][1];
    var dLat = POLICE_AVOID_M / 111320;
    var dLng = POLICE_AVOID_M / (111320 * Math.max(0.05, Math.cos(midLat * Math.PI / 180)));
    var grid = Object.create(null);
    for (var c = 0; c < coords.length; c += 2) { // sample every other vertex (geometry is dense)
      var v = coords[c];
      var key = Math.floor(v[0] / dLng) + ',' + Math.floor(v[1] / dLat);
      (grid[key] || (grid[key] = [])).push(v);
    }
    var hits = 0;
    for (var p = 0; p < police.length; p++) {
      var pt = police[p];
      var gx = Math.floor(pt[0] / dLng), gy = Math.floor(pt[1] / dLat);
      var near = false;
      for (var ox = -1; ox <= 1 && !near; ox++) {
        for (var oy = -1; oy <= 1 && !near; oy++) {
          var bucket = grid[(gx + ox) + ',' + (gy + oy)];
          if (!bucket) continue;
          for (var i = 0; i < bucket.length; i++) {
            if (U.haversine(pt, bucket[i]) <= POLICE_AVOID_M) { near = true; break; }
          }
        }
      }
      if (near) hits++;
    }
    return hits;
  }

  // Single route through a via point — forces a detour around police.
  function routeVia(from, via, to) {
    var url = OSRM + from[0] + ',' + from[1] + ';' + via[0] + ',' + via[1] + ';' + to[0] + ',' + to[1] +
      '?overview=full&geometries=geojson&steps=true&alternatives=false';
    return fetchJSON(url, null, OSRM_MS).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('no route');
      return osrmRoute(j.routes[0]);
    });
  }

  // Via points offset perpendicular to the route, AWAY from the police POI that
  // sits most squarely on it. Several candidate offsets (a 700m nudge often
  // snaps back to the same road in a dense grid, so wider detours too).
  function detourWaypoints(coords, police) {
    var bestP = null, bestD = Infinity, bestI = 0;
    for (var p = 0; p < police.length; p++) {
      for (var c = 0; c < coords.length; c += 2) {
        var d = U.haversine(police[p], coords[c]);
        if (d < bestD) { bestD = d; bestP = police[p]; bestI = c; }
      }
    }
    if (!bestP || bestD > POLICE_AVOID_M) return [];
    var i = bestI, j = i + 2 < coords.length ? i + 2 : Math.max(0, i - 2);
    var heading = U.bearing(coords[i], coords[j]);
    var rel = U.relBearing(coords[i], heading, bestP);     // + police on the right, − on the left
    var side = ((rel >= 0 ? heading - 90 : heading + 90) % 360 + 360) % 360;
    return [700, 1400, 2200].map(function (off) { return U.destPoint(coords[i], side, off); });
  }

  function superseded(lngLat) {
    return !S.route || S.route.dest[0] !== lngLat[0] || S.route.dest[1] !== lngLat[1];
  }

  // Background pass: pull police/cameras near the route, then adopt the cleanest
  // option — the best alternative, or a waypoint detour we build ourselves.
  function refinePoliceAvoid(from, lngLat, routes, fastest) {
    return fetchPoliceForRoutes(routes).then(function (police) {
      if (!police || !police.length || superseded(lngLat)) return;
      var fastestHits = policeHits(fastest.coords, police);
      var label = (S.route && S.route.label) || 'Destination';

      var commit = function (chosen, chosenHits) {
        if (superseded(lngLat)) return;
        if (chosen !== fastest && chosenHits < fastestHits) {
          var extraMin = Math.round((chosen.duration - fastest.duration) / 60);
          A.routing.applyRoute(chosen, label, lngLat, { noFit: true });
          A.ui.toast('Routed around ' + (fastestHits - chosenHits) + ' police/camera' +
            ((fastestHits - chosenHits) > 1 ? 's' : '') + (extraMin > 0 ? ' · +' + extraMin + ' min' : ''), 'success');
        } else if (chosenHits > 0) {
          A.ui.toast(chosenHits + ' police/camera' + (chosenHits > 1 ? 's' : '') +
            ' near this route · best available', 'info');
        }
      };

      // 1) cleanest of whatever alternatives came back
      var best = routes.map(function (r) { return { r: r, hits: policeHits(r.coords, police) }; })
        .sort(function (a, b) { return a.hits - b.hits || a.r.duration - b.r.duration; })[0];
      // Clean already, or so saturated a single detour won't help → stop here.
      if (best.hits === 0 || best.hits > 4) { commit(best.r, best.hits); return; }

      // 2) build detours around the worst on-route POI; keep the cleanest that
      //    isn't an absurd detour, stopping early once we reach zero police.
      var wps = detourWaypoints(best.r.coords, police);
      if (!wps.length) { commit(best.r, best.hits); return; }
      var winner = best;
      return new Promise(function (resolve) {
        (function tryNext(k) {
          if (k >= wps.length || superseded(lngLat)) { commit(winner.r, winner.hits); resolve(); return; }
          routeVia(from, wps[k], lngLat).then(function (cand) {
            var ch = policeHits(cand.coords, police);
            if (ch < winner.hits && cand.duration < fastest.duration * 2) winner = { r: cand, hits: ch };
            if (winner.hits === 0) { commit(winner.r, winner.hits); resolve(); }
            else tryNext(k + 1);
          }).catch(function () { tryNext(k + 1); });
        })(0);
      });
    }).catch(function () { /* a failed refinement keeps the fastest route */ });
  }

  // The hook: never alters the list (the core draws routes[0] at once); it
  // only schedules the background refinement for a plain destination request.
  function routesHook(routes, req) {
    try {
      if (!S.settings || !S.settings.avoidPolice) return routes;
      if (!A.packs || !A.packs.has('enforcement')) return routes;
      if (!req || !req.from || !req.to || !routes || !routes.length) return routes;
      if (S.trip && S.trip.active) return routes;   // a mid-trip reroute keeps the trip's own route
      var from = req.from.slice(), to = req.to.slice(), fastest = routes[0];
      // A macrotask: the core applies routes[0] in the microtask right after
      // this hook returns, and the refinement must see S.route already set.
      setTimeout(function () { refinePoliceAvoid(from, to, routes, fastest); }, 0);
    } catch (e) { /* never take the route down with us */ }
    return routes;
  }
  A.routing.hook('routes', routesHook);

  /* ---------------- cruise loop ---------------- */
  var LOOP_CELL_STOP = 0.0005;    // ~50 m grid for stop signs / signals (they sit ON the road)
  var LOOP_CELL_POLICE = 0.0015;  // ~150 m grid for police / cameras (near the road counts)
  var loopBusy = false;

  // OSRM route through an ordered coord list (loop = start … waypoints … start).
  // continue_straight=true stops OSRM from U-turning back down the same road at
  // a via point, which would fold the loop onto itself.
  function osrmMulti(coordsList) {
    var path = coordsList.map(function (c) { return c[0] + ',' + c[1]; }).join(';');
    var url = OSRM + path + '?overview=full&geometries=geojson&steps=true&alternatives=false&continue_straight=true';
    return fetchJSON(url, null, OSRM_MS).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('no route');
      return osrmRoute(j.routes[0]);
    });
  }

  // Four candidate loops: circle-ish waypoint fans to the right of travel, the
  // left, ahead, and behind. Radius is sized so the road distance of the loop
  // lands near the target (straight-line perimeter ≈ 4R, roads add ~30%).
  function loopCandidates(from, heading, targetM) {
    var R = Math.max(500, targetM / 5.2);
    return [heading + 90, heading - 90, heading, heading + 180].map(function (d) {
      var wps = [-60, 0, 60].map(function (off) {
        return U.destPoint(from, ((d + off) % 360 + 360) % 360, R);
      });
      return [from, wps[0], wps[1], wps[2], from];
    });
  }

  // Stop signs, traffic signals, police + cameras across the candidates' bbox.
  // null = Overpass unavailable (callers fall back to average-speed scoring).
  function fetchLoopPois(routes) {
    var bb = routesBbox(routes, 0.005, 2);
    if (!bb) return Promise.resolve(null);
    var params = { kind: 'road', minLat: bb.minLat, minLng: bb.minLng, maxLat: bb.maxLat, maxLng: bb.maxLng };
    return api(OVERPASS, params, OVERPASS_MS).then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .then(function (j) {
        var out = { police: [], stops: [], signals: [] };
        ((j && j.elements) || []).forEach(function (e) {
          var c = elementCoord(e);
          if (!c) return;
          var t = e.tags || {};
          if (t.amenity === 'police' || t.highway === 'speed_camera') out.police.push(c);
          else if (t.highway === 'stop') out.stops.push(c);
          else if (t.highway === 'traffic_signals') out.signals.push(c);
        });
        return out;
      }).catch(function () { return null; });
  }

  // Approximate proximity counting on a rounded lat/lng grid. A POI counts as
  // "on the route" when its cell or any neighbour holds a route vertex.
  function gridIndex(coords, cell) {
    var idx = {};
    for (var i = 0; i < coords.length; i++) {
      idx[Math.round(coords[i][0] / cell) + ':' + Math.round(coords[i][1] / cell)] = 1;
    }
    return idx;
  }
  function gridHits(idx, pts, cell) {
    if (!pts || !pts.length) return 0;
    var hits = 0;
    for (var p = 0; p < pts.length; p++) {
      var gx = Math.round(pts[p][0] / cell), gy = Math.round(pts[p][1] / cell);
      var near = false;
      for (var dx = -1; dx <= 1 && !near; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          if (idx[(gx + dx) + ':' + (gy + dy)]) { near = true; break; }
        }
      }
      if (near) hits++;
    }
    return hits;
  }

  // Lower = better ride. One police pass ≈ five traffic lights.
  function scoreLoop(r, pois, targetM) {
    var out = { police: 0, stops: 0, signals: 0, total: 0 };
    var sizePenalty = Math.abs(r.distance - targetM) / targetM * 10;
    if (pois) {
      out.police = gridHits(gridIndex(r.coords, LOOP_CELL_POLICE), pois.police, LOOP_CELL_POLICE);
      out.stops = gridHits(gridIndex(r.coords, LOOP_CELL_STOP), pois.stops, LOOP_CELL_STOP);
      out.signals = gridHits(gridIndex(r.coords, LOOP_CELL_STOP), pois.signals, LOOP_CELL_STOP);
      out.total = out.police * 15 + out.signals * 3 + out.stops * 2 + sizePenalty;
    } else {
      // No POI data — higher average speed = fewer stops per meter.
      out.total = -(r.distance / Math.max(r.duration, 1)) + sizePenalty;
    }
    return out;
  }

  function planLoop(targetM) {
    if (loopBusy) return Promise.resolve(false);
    var from = A.sim.playerPos();
    if (!from) { A.ui.toast('No position yet. Tap the locate button first', 'warn'); return Promise.resolve(false); }
    loopBusy = true;
    if (S.trip && S.trip.active) A.routing.endTrip(false);
    A.ui.toast('Planning a cruise loop…', 'info');
    var heading = A.sim.playerHeading() || 0;
    var cands = loopCandidates(from, heading, targetM);
    return Promise.all(cands.map(function (c) { return osrmMulti(c).catch(function () { return null; }); }))
      .then(function (routes) {
        routes = routes.filter(function (r) { return r && r.distance > targetM * 0.3; });
        if (!routes.length) throw new Error('no loops');
        return fetchLoopPois(routes).then(function (pois) {
          var best = null, bestScore = null;
          routes.forEach(function (r) {
            var sc = scoreLoop(r, pois, targetM);
            if (!best || sc.total < bestScore.total) { best = r; bestScore = sc; }
          });
          A.routing.applyRoute(best, 'Cruise loop', from.slice());
          var extra;
          if (pois) {
            var quiet = [];
            quiet.push(bestScore.police ? bestScore.police + ' police/cam on route' : 'no police on route');
            var sl = bestScore.signals + bestScore.stops;
            quiet.push(sl ? sl + ' lights/stops' : 'no lights or stop signs');
            extra = quiet.join(' · ');
          } else {
            extra = 'smoothest of ' + routes.length + ' loops';
          }
          A.ui.toast('Cruise loop ready · ' + U.fmtDist(best.distance, S.settings.units) +
            ' · ' + U.fmtDur(best.duration) + ' · ' + extra, 'success');
          return true;
        });
      })
      .catch(function () {
        A.ui.toast('Could not plan a loop from here. Try again in a moment', 'warn');
        return false;
      })
      .then(function (ok) { loopBusy = false; return ok; });
  }

  // Loop-size chooser, anchored at the rider's position on the map.
  function promptLoop() {
    var from = A.sim.playerPos();
    if (!from) { A.ui.toast('No position yet. Tap the locate button first', 'warn'); return; }
    var km = S.settings.units === 'km';
    var opts = km ? [[8000, '8 km'], [16000, '16 km'], [32000, '32 km']]
      : [[8000, '5 mi'], [16000, '10 mi'], [32000, '20 mi']];
    var card = U.el('div', 'pop-card pop-prompt');
    card.innerHTML =
      '<div class="prompt-label"><span class="prompt-pin">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7"/><path d="M17.5 2.8v3.7h3.7"/></svg></span>' +
      '<span class="prompt-name">Cruise loop · back to here</span></div>' +
      '<div class="pop-sub">Loops you back around while avoiding police, stop signs &amp; traffic lights.</div>' +
      '<div class="pop-actions" id="loop-sizes"></div>' +
      '<div class="pop-actions"></div>';
    var sizes = card.querySelector('#loop-sizes');
    opts.forEach(function (o) {
      var b = U.el('button', 'btn btn-primary btn-small', '~' + o[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        A.mapview.closePopup();
        planLoop(o[0]);
      });
      sizes.appendChild(b);
    });
    var no = U.el('button', 'btn btn-ghost btn-small', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', function () { A.mapview.closePopup(); });
    card.querySelectorAll('.pop-actions')[1].appendChild(no);
    A.mapview.openPopup(from, card);
  }

  E.routing = {
    promptLoop: promptLoop,
    planLoop: planLoop,
    policeHits: policeHits,
    detourWaypoints: detourWaypoints,
    fetchPoliceForRoutes: fetchPoliceForRoutes,
    refinePoliceAvoid: refinePoliceAvoid,
    loopCandidates: loopCandidates,
    scoreLoop: scoreLoop,
    gridIndex: gridIndex,
    gridHits: gridHits,
    POLICE_AVOID_M: POLICE_AVOID_M,
    // test surface
    _routesHook: routesHook, _parseSteps: parseSteps
  };
})();
