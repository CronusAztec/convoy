/* Convoy — destination search (Nominatim), routing (OSRM), trip lifecycle + ETA card */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  // OpenStreetMap lookups go through our own server, NOT to overpass-api.de
  // directly: that endpoint sends no Access-Control-Allow-Origin header, so a
  // browser request to it is blocked before the response is ever readable. The
  // proxy also caches, so riders in the same area share one upstream query.
  // Callers name a KIND ('police' | 'enforcement' | 'road'); see server/overpass.js.
  var OVERPASS_PROXY = (A.config ? A.config.base : '') + '/api/overpass';
  var FETCH_TIMEOUT_MS = 9000; // a hung OSRM/Nominatim used to leave the UI stuck forever
  var POLICE_AVOID_M = 160;    // a route coord within this of a police/camera POI counts as a "pass"

  // TomTom Routing: traffic-aware durations + real alternatives (the public OSRM
  // has neither). The TomTom key is a server secret now — routing.js POSTs to our
  // own /api/route proxy and the server forwards to TomTom with the key injected.
  // We only opt in when the server reports it has a key (probed in net.js on
  // connect and cached on A.config.routeCaps.routing); otherwise OSRM stays the
  // keyless fallback. Overlays/heatmap uses the same gate (overlays.js).
  function useTomTom() { return !!(A.config && A.config.routeCaps && A.config.routeCaps.routing); }
  var ROUTE_PROXY = (A.config ? A.config.base : '') + '/api/route';

  // Map a TomTom guidance maneuver to the {type,mod} vocabulary cueText() speaks.
  // Anything unmapped falls through to a type cueText ignores (no announcement).
  function ttManeuver(mv) {
    switch (mv) {
      case 'DEPART': case 'DEPART_LEFT': case 'DEPART_RIGHT': return { type: 'depart' };
      case 'ARRIVE': case 'ARRIVE_LEFT': case 'ARRIVE_RIGHT': return { type: 'arrive' };
      case 'STRAIGHT': return { type: 'continue', mod: 'straight' };
      case 'TURN_LEFT': return { type: 'turn', mod: 'left' };
      case 'TURN_RIGHT': return { type: 'turn', mod: 'right' };
      case 'SHARP_LEFT': return { type: 'turn', mod: 'sharp left' };
      case 'SHARP_RIGHT': return { type: 'turn', mod: 'sharp right' };
      case 'BEAR_LEFT': case 'KEEP_LEFT': return { type: 'turn', mod: 'slight left' };
      case 'BEAR_RIGHT': case 'KEEP_RIGHT': return { type: 'turn', mod: 'slight right' };
      case 'MAKE_UTURN': return { type: 'turn', mod: 'uturn' };
      case 'MERGE': case 'MERGE_LEFT': return { type: 'merge', mod: 'left' };
      case 'MERGE_RIGHT': return { type: 'merge', mod: 'right' };
      case 'TAKE_EXIT': case 'MOTORWAY_EXIT_LEFT': return { type: 'off ramp', mod: 'left' };
      case 'MOTORWAY_EXIT_RIGHT': return { type: 'off ramp', mod: 'right' };
      case 'KEEP_LEFT_AT_FORK': case 'FORK_LEFT': return { type: 'fork', mod: 'left' };
      case 'KEEP_RIGHT_AT_FORK': case 'FORK_RIGHT': return { type: 'fork', mod: 'right' };
      case 'ENTER_ROUNDABOUT': case 'ROUNDABOUT_LEFT': case 'ROUNDABOUT_RIGHT':
      case 'ROUNDABOUT_CROSS': case 'ROUNDABOUT_BACK': return { type: 'roundabout' };
      default: return { type: mv || '' }; // unknown → cueText returns null (silent)
    }
  }

  function parseTomTomSteps(g) {
    if (!g || !g.instructions) return [];
    return g.instructions.map(function (ins) {
      var m = ttManeuver(ins.maneuver);
      return { at: ins.routeOffsetInMeters || 0, type: m.type, mod: m.mod, name: ins.street || '', exit: ins.roundaboutExitNumber };
    });
  }

  // Normalize a TomTom route into the same shape OSRM routes use elsewhere.
  function ttNormalize(rt) {
    var coords = [];
    (rt.legs || []).forEach(function (leg) {
      (leg.points || []).forEach(function (p) { coords.push([p.longitude, p.latitude]); });
    });
    var s = rt.summary || {};
    return {
      distance: s.lengthInMeters,
      duration: s.travelTimeInSeconds,            // traffic-aware when traffic=true
      trafficDelay: s.trafficDelayInSeconds || 0, // seconds added by congestion
      coords: coords,
      steps: parseTomTomSteps(rt.guidance)
    };
  }

  // fetch + JSON with a timeout. abortSignal lets a caller cancel an in-flight
  // request (e.g. a newer search supersedes an older one) so out-of-order
  // responses can't overwrite the latest result.
  function fetchJSON(url, opts) {
    opts = opts || {};
    var ctrl = opts.signal ? null : new AbortController();
    var signal = opts.signal || (ctrl && ctrl.signal);
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FETCH_TIMEOUT_MS);
    // Forward method/headers/body so POST-JSON calls (the /api/route proxy) work
    // alongside the plain GETs. signal is always set explicitly below.
    var init = { signal: signal };
    if (opts.method) init.method = opts.method;
    if (opts.headers) init.headers = opts.headers;
    if (opts.body) init.body = opts.body;
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- geocoding ---------------- */
  var lastGeocode = null; // AbortController for the most recent search, so a new query cancels it
  // Where the user is looking — bias address search to here so results are local,
  // not global. Prefer the live GPS position, fall back to the map center.
  function searchAnchor() {
    // player.pos starts at the demo spawn — only trust it once a real fix (or an
    // explicit relocate) has landed, otherwise every search would be biased to
    // the spawn city instead of where the user is actually looking.
    var trusted = A.sim && A.sim.hasRealPos && A.sim.hasRealPos();
    var p = trusted && A.sim.playerPos ? A.sim.playerPos() : null;
    if (p && isFinite(p[0]) && isFinite(p[1])) return { lng: p[0], lat: p[1] };
    var m = A.mapview && A.mapview.map ? A.mapview.map() : null;
    if (m && m.getCenter) { var c = m.getCenter(); return { lng: c.lng, lat: c.lat }; }
    return null;
  }
  function geocode(q) {
    if (lastGeocode) { try { lastGeocode.abort(); } catch (e) {} }
    var ctrl = new AbortController(); lastGeocode = ctrl;
    var a = searchAnchor();
    // ~0.9° (~100km) half-window around the user — a metro-sized box.
    var d = 0.9;
    function run(bounded) {
      // Pull more rows than we show so the local-distance sort has candidates to
      // pick the nearest from (Nominatim returns its own relevance order otherwise).
      var url = NOMINATIM + '/search?format=jsonv2&limit=10&accept-language=en&q=' + encodeURIComponent(q);
      if (a) {
        url += '&viewbox=' + (a.lng - d) + ',' + (a.lat - d) + ',' + (a.lng + d) + ',' + (a.lat + d);
        // bounded=1 HARD-restricts to that box so a generic query ("coffee", "Main St")
        // returns the LOCAL match instead of a strongly-named place across the country.
        if (bounded) url += '&bounded=1';
      }
      return fetchJSON(url, { signal: ctrl.signal });
    }
    // Local + global passes in PARALLEL: the bounded box keeps generic queries
    // ("coffee", "Main St") local, while the global pass keeps strongly-named far
    // places ("Las Vegas", "Eiffel Tower") findable — a partial local match must
    // never shadow the real destination (a bounded-first-then-widen sequence did
    // exactly that whenever the box contained ANY match). Local results rank
    // first (nearest first), then global ones in Nominatim's relevance order.
    // BOTH passes swallow their own failure. The bounded pass used to reject
    // straight through Promise.all, so one flaky local request threw away a
    // perfectly good global result and the box just said "Search unavailable".
    var reqs = a
      ? [run(true).catch(function () { return []; }), run(false).catch(function () { return []; })]
      : [run(false)];
    return Promise.all(reqs).then(function (res) {
      var localRows = a ? (res[0] || []) : [];
      var globalRows = a ? (res[1] || []) : (res[0] || []);
      function toItem(r) {
        var parts = (r.display_name || '').split(', ');
        var lng = parseFloat(r.lon), lat = parseFloat(r.lat);
        return {
          _id: r.place_id || ((r.osm_type || '') + '/' + (r.osm_id || '') + '/' + r.display_name),
          label: parts[0] || r.display_name,
          sub: parts.slice(1, 4).join(', '),
          lng: lng,
          lat: lat,
          // cos-lat-corrected squared distance to the user (0 when no anchor) for sorting
          _d: a ? (function () {
            var dx = (lng - a.lng) * Math.cos(a.lat * Math.PI / 180), dy = lat - a.lat;
            return dx * dx + dy * dy;
          })() : 0
        };
      }
      var out = localRows.map(toItem);
      out.sort(function (x, y) { return x._d - y._d; });
      out = out.slice(0, 4); // leave room for global names below
      var seen = {};
      for (var i = 0; i < out.length; i++) seen[out[i]._id] = 1;
      globalRows.map(toItem).forEach(function (it) {
        if (!seen[it._id]) { seen[it._id] = 1; out.push(it); }
      });
      return out.slice(0, 6);
    });
  }

  function reverseLabel(lngLat) {
    var url = NOMINATIM + '/reverse?format=jsonv2&accept-language=en&lat=' + lngLat[1] + '&lon=' + lngLat[0];
    return fetchJSON(url).then(function (r) {
      if (r && r.address) {
        return r.address.road || r.address.neighbourhood || r.address.suburb ||
          (r.display_name || '').split(', ')[0] || 'Dropped pin';
      }
      return 'Dropped pin';
    }).catch(function () { return 'Dropped pin'; });
  }

  /* ---------------- OSRM ---------------- */
  var lastRoute = null; // AbortController for the most recent route request
  // steps=true so we get turn-by-turn maneuver data for voice navigation.
  // alternatives=3 so the police-avoidance pass has detours to choose from.
  function osrmRoutes(from, to, signal) {
    var url = OSRM + from[0] + ',' + from[1] + ';' + to[0] + ',' + to[1] +
      '?overview=full&geometries=geojson&steps=true&alternatives=3';
    return fetchJSON(url, { signal: signal }).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('no route');
      return j.routes.map(function (r) {
        return {
          distance: r.distance,
          duration: r.duration,
          coords: r.geometry.coordinates,
          steps: parseSteps(r)
        };
      });
    });
  }

  function fetchRoutes(from, to) {
    if (lastRoute) { try { lastRoute.abort(); } catch (e) {} }
    var ctrl = new AbortController(); lastRoute = ctrl;
    if (useTomTom()) {
      // Server proxy injects the TomTom key; client never sees it. The proxy
      // forwards &traffic=true&maxAlternatives=2 for plain A→B requests. If the
      // proxy is unreachable OR TomTom rejects (bad key, quota, upstream down),
      // fall back to keyless OSRM so routing never hard-fails.
      return fetchJSON(ROUTE_PROXY, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, to: to })
      }).then(function (j) {
        if (!j.routes || !j.routes.length) throw new Error('no route');
        return j.routes.map(ttNormalize);
      }).catch(function () { return osrmRoutes(from, to, ctrl.signal); });
    }
    return osrmRoutes(from, to, ctrl.signal);
  }

  /* ---------------- police / speed-camera avoidance ----------------
     Keyless: pull police stations + speed cameras (OpenStreetMap via Overpass)
     across the routes' bounding box, then count how many sit within
     POLICE_AVOID_M of each candidate route. We render the fastest route first
     (snappy), then quietly switch to the cleanest alternative if one is better. */
  var lastPolice = null; // AbortController for the most recent Overpass query
  function fetchPoliceForRoutes(routes) {
    var minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
    routes.forEach(function (r) {
      r.coords.forEach(function (c) {
        if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      });
    });
    var pad = 0.01;
    minLat -= pad; minLng -= pad; maxLat += pad; maxLng += pad;
    // Cross-country routes would make a huge Overpass query — skip avoidance there.
    if ((maxLat - minLat) > 3 || (maxLng - minLng) > 3) return Promise.resolve(null);
    if (lastPolice) { try { lastPolice.abort(); } catch (e) {} }
    var ctrl = new AbortController(); lastPolice = ctrl;
    return fetch(OVERPASS_PROXY, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'police',
        bbox: { minLat: minLat, minLng: minLng, maxLat: maxLat, maxLng: maxLng }
      })
    }).then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .then(function (j) {
        var pts = [], els = (j && j.elements) || [];
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
          var lon = e.lon != null ? e.lon : (e.center && e.center.lon);
          if (lat != null && lon != null) pts.push([lon, lat]);
        }
        return pts;
      }).catch(function () { return null; }); // null = couldn't fetch (keep fastest route)
  }

  // How many police/camera POIs the route passes within POLICE_AVOID_M.
  //
  // This used to be a straight nested loop: up to 400 Overpass POIs against every
  // other route vertex, repeated for each of three candidate routes — on the order
  // of a million haversine calls on the main thread, right at the moment the user
  // is waiting for a route to draw. Instead, hash the route's vertices into a
  // coarse lat/lng grid whose cell is ~POLICE_AVOID_M across, then test each POI
  // only against the vertices in its own cell and the eight around it. Same
  // answer, near-linear.
  function policeHits(coords, police) {
    if (!police || !police.length || !coords || !coords.length) return 0;
    // Cell size in degrees: latitude is ~111.32 km/deg; longitude shrinks with
    // cos(lat), so size the lng step at the route's mid-latitude.
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

  // Flatten OSRM legs→steps into one ordered cue list keyed by distance-along-route.
  // Each cue: { at: metersFromStart, type: maneuverType, mod: modifier, name: roadName, exit: roundaboutExit }
  function parseSteps(route) {
    var cues = [];
    var dist = 0;
    (route.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (st) {
        var m = (st.maneuver || {});
        cues.push({
          at: dist,
          type: m.type,            // turn | new name | depart | arrive | merge | on ramp | off ramp | fork | end of road | continue | roundabout | rotary
          mod: m.modifier,         // left | right | sharp left | sharp right | slight left | slight right | straight | uturn
          name: st.name || '',
          exit: m.exit
        });
        dist += st.distance || 0;
      });
    });
    return cues;
  }

  /* ---------------- voice navigation ----------------
     Web Speech API (speechSynthesis). Speaks turn/continue/arrive cues with
     distance phrasing. Falls back silently if unavailable. The "stop" cue is
     the arrival maneuver. Guarded by S.settings.voiceNav (toggle in Settings). */
  var speech = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;
  var navVoice = null;
  var navVoiceName = '';       // custom voice override (S.settings.navVoiceName), '' = auto female
  var navEnabled = true;       // mirrors S.settings.voiceNav

  // Substrings that identify a female system voice across macOS/iOS, Windows, Android & Chrome.
  // The Web Speech spec has no gender field, so we infer from the voice name.
  var FEMALE_HINTS = ['female', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'allison',
    'susan', 'zoe', 'nicky', 'serena', 'catherine', 'zira', 'hazel', 'aria', 'jenny', 'michelle',
    'linda', 'eva', 'sonia', 'libby', 'nancy', 'clara', 'natasha', 'emma', 'amber', 'salli',
    'joanna', 'kendra', 'kimberly', 'ivy', 'ana', 'ava', 'kate'];

  function voiceIsFemale(v) {
    var n = (v.name || '').toLowerCase();
    if (/\bfemale\b/.test(n)) return true;
    return FEMALE_HINTS.some(function (h) { return n.indexOf(h) >= 0; });
  }

  // Names that mark a modern neural/natural voice that sounds human (vs. robotic SAPI).
  var NEURAL_HINTS = ['natural', 'neural', 'online', 'google', 'siri', 'premium', 'enhanced'];
  function voiceIsNeural(v) {
    var n = (v.name || '').toLowerCase();
    return NEURAL_HINTS.some(function (h) { return n.indexOf(h) >= 0; });
  }
  // Higher = more human + female-preferred → the best available "AI human" voice.
  function voiceScore(v) { return (voiceIsNeural(v) ? 3 : 0) + (voiceIsFemale(v) ? 1 : 0); }

  function englishVoices() {
    if (!speech) return [];
    return (speech.getVoices() || []).filter(function (v) { return /^en(-|_)/i.test(v.lang); });
  }

  // For the Settings picker: English voices, most human-sounding first.
  function listVoices() {
    return englishVoices()
      .map(function (v) { return { name: v.name, lang: v.lang, female: voiceIsFemale(v), neural: voiceIsNeural(v) }; })
      .sort(function (a, b) {
        return (voiceScore({ name: b.name }) - voiceScore({ name: a.name })) || a.name.localeCompare(b.name);
      });
  }

  // Navigator voice priority: explicit custom pick → highest-scoring (neural + female) English voice.
  function pickVoice() {
    if (!speech) return null;
    if (navVoice) return navVoice;
    var all = speech.getVoices();
    if (!all || !all.length) return null;
    if (navVoiceName) {
      var custom = all.filter(function (v) { return v.name === navVoiceName; })[0];
      if (custom) { navVoice = custom; return navVoice; }
    }
    var en = all.filter(function (v) { return /^en(-|_)/i.test(v.lang); });
    var pool = (en.length ? en : all).slice().sort(function (a, b) { return voiceScore(b) - voiceScore(a); });
    navVoice = pool[0] || null;
    return navVoice;
  }

  function setVoiceName(name) {
    navVoiceName = name || '';
    navVoice = null;            // force a re-pick on next speak
    pickVoice();
  }

  // Voices load asynchronously in most browsers — re-select once the list is ready.
  if (speech && typeof speech.addEventListener === 'function') {
    speech.addEventListener('voiceschanged', function () { navVoice = null; pickVoice(); });
  }

  // Self-hosted neural TTS (Piper on the server) → genuinely human voice. Falls back to
  // the on-device speechSynthesis voice if the server TTS is unavailable or errors.
  var navAudio = (typeof Audio !== 'undefined') ? new Audio() : null;
  var ttsServer = null;          // null = unknown, true = use Piper, false = on-device synth

  // Same-origin on the web; the deployed backend inside Capacitor (origin is
  // https://localhost there, so a relative /api/tts would never reach the server
  // and the neural voice could never engage on the shipped Android app).
  function ttsBase() { return (A.config && A.config.base) || ''; }

  function probeTts() {
    if (typeof fetch !== 'function' || !navAudio) { ttsServer = false; return; }
    fetch(ttsBase() + '/api/tts/health').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { ttsServer = !!(j && j.ok); })
      .catch(function () { ttsServer = false; });
  }

  function synthSpeak(text) {
    if (!speech) return;
    try {
      speech.cancel();              // never overlap cues
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1; u.pitch = 1.05; u.volume = 1;
      speech.speak(u);
    } catch (e) { /* non-fatal: some environments block synthesis */ }
  }

  function serverSpeak(text) {
    if (!navAudio) { synthSpeak(text); return; }
    fetch(ttsBase() + '/api/tts?text=' + encodeURIComponent(text))
      .then(function (r) { if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); })
      .then(function (blob) {
        try { navAudio.pause(); } catch (e) { }
        if (navAudio._url) { try { URL.revokeObjectURL(navAudio._url); } catch (e) { } }
        navAudio._url = URL.createObjectURL(blob);
        navAudio.src = navAudio._url;
        var p = navAudio.play();
        if (p && p.catch) p.catch(function () { });
      })
      .catch(function () { synthSpeak(text); }); // server TTS failed → on-device fallback
  }

  function speak(text) {
    if (!navEnabled || !text) return;
    if (ttsServer === true) serverSpeak(text);
    else synthSpeak(text);          // false / still-probing → on-device voice
  }

  // OSRM maneuver → human phrasing. Returns null for cues we don't voice.
  function cueText(cue) {
    var name = cue.name ? (' onto ' + cue.name) : '';
    var mod = cue.mod || '';
    switch (cue.type) {
      case 'depart':
        return null; // no "depart" announcement
      case 'arrive':
        return 'You have arrived at your destination.';
      case 'turn':
        if (mod === 'left') return 'Turn left' + name + '.';
        if (mod === 'right') return 'Turn right' + name + '.';
        if (mod === 'sharp left') return 'Make a sharp left turn' + name + '.';
        if (mod === 'sharp right') return 'Make a sharp right turn' + name + '.';
        if (mod === 'slight left') return 'Keep slightly left' + name + '.';
        if (mod === 'slight right') return 'Keep slightly right' + name + '.';
        if (mod === 'uturn') return 'Make a U-turn' + name + '.';
        return 'Turn' + name + '.';
      case 'new name':
        return mod === 'straight' ? ('Continue onto ' + (cue.name || 'the next road') + '.') : null;
      case 'continue':
        if (mod === 'straight' || !mod) return 'Continue straight' + name + '.';
        if (mod === 'slight left') return 'Continue slightly left' + name + '.';
        if (mod === 'slight right') return 'Continue slightly right' + name + '.';
        return 'Continue' + name + '.';
      case 'merge':
        return 'Merge' + (mod === 'left' || mod === 'right' ? ' ' + mod : '') + name + '.';
      case 'on ramp':
        return 'Take the on ramp' + (mod === 'left' || mod === 'right' ? ' on the ' + mod : '') + name + '.';
      case 'off ramp':
        return 'Take the off ramp' + (mod === 'left' || mod === 'right' ? ' on the ' + mod : '') + name + '.';
      case 'fork':
        if (mod === 'left') return 'Keep left at the fork' + name + '.';
        if (mod === 'right') return 'Keep right at the fork' + name + '.';
        return 'Stay centered at the fork' + name + '.';
      case 'end of road':
        if (mod === 'left') return 'Turn left at the end of the road' + name + '.';
        if (mod === 'right') return 'Turn right at the end of the road' + name + '.';
        return 'Continue at the end of the road' + name + '.';
      case 'roundabout':
      case 'rotary':
        var ex = cue.exit != null ? (' Take the ' + ordinal(cue.exit) + ' exit.') : ' Proceed through the roundabout.';
        return 'Enter the roundabout.' + ex;
      default:
        return null;
    }
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Distance phrasing for an advance cue ("In 500 feet, turn right…").
  function distPrefix(meters, units) {
    if (units === 'km') {
      if (meters < 50) return '';
      if (meters < 1000) return 'In ' + Math.round(meters / 10) * 10 + ' meters, ';
      return 'In ' + (meters / 1000).toFixed(1) + ' kilometers, ';
    }
    var ft = meters * 3.28084;
    if (ft < 150) return '';
    if (ft < 0.5 * 5280) return 'In ' + Math.round(ft / 50) * 50 + ' feet, ';
    return 'In ' + (ft / 5280).toFixed(1) + ' miles, ';
  }

  function setNavEnabled(on) {
    navEnabled = !!on;
    if (!navEnabled && speech) speech.cancel();
  }

  function isNavSupported() { return !!speech || !!navAudio; }
  function stopSpeaking() {
    if (speech) try { speech.cancel(); } catch (e) { }
    if (navAudio) try { navAudio.pause(); } catch (e) { }
  }
  probeTts(); // detect self-hosted neural TTS once at load

  function cumulative(coords) {
    var cum = new Array(coords.length);
    cum[0] = 0;
    for (var i = 1; i < coords.length; i++) {
      cum[i] = cum[i - 1] + U.haversine(coords[i - 1], coords[i]);
    }
    return cum;
  }

  // The trip line's own length, measured the SAME way progress is.
  //
  // progress comes from nearestOnRoute(), which can never exceed cum[last] (the
  // haversine sum of the polyline vertices). line.total used to be the PROVIDER's
  // road distance instead, which is computed independently and never reconciled
  // with the polyline. Whenever the provider's number came out larger — even by a
  // metre — three things broke:
  //   - arrival (sim.js: progress >= line.total) became unreachable, so a live-GPS
  //     trip never self-terminated: no "you have arrived", no auto parking pin,
  //     and the card sat on "X left" forever;
  //   - "distance left" never reached zero and the progress bar never filled;
  //   - in preview playback, progress DOES run past cum[last], and posAt() then
  //     interpolated with t > 1, flying the marker past the final coordinate.
  // Measuring both ends of the comparison on the same line removes all three.
  // S.route.distance keeps the provider's figure for display.
  function lineTotal(cum, fallback) {
    return (cum && cum.length) ? cum[cum.length - 1] : (fallback || 0);
  }

  // position + bearing at progress meters along the line (cached segment index)
  function posAt(line, m) {
    var coords = line.coords, cum = line.cum;
    // A degenerate line (a 1-point "route" from a provider hiccup) used to throw
    // here on coords[1], which killed the whole trip render loop.
    if (!coords || !coords.length) return { pos: [0, 0], brg: 0 };
    if (coords.length < 2) return { pos: coords[0].slice(), brg: 0 };
    if (m <= 0) return { pos: coords[0].slice(), brg: U.bearing(coords[0], coords[1]) };
    if (m >= line.total) {
      var n = coords.length;
      return { pos: coords[n - 1].slice(), brg: U.bearing(coords[n - 2], coords[n - 1]) };
    }
    var i = line._idx || 0;
    if (cum[i] > m) i = 0;
    while (i < coords.length - 2 && cum[i + 1] < m) i++;
    line._idx = i;
    var segLen = Math.max(cum[i + 1] - cum[i], 0.001);
    var t = (m - cum[i]) / segLen;
    return { pos: U.lerpPos(coords[i], coords[i + 1], t), brg: U.bearing(coords[i], coords[i + 1]) };
  }

  // Snap a REAL position onto the route line. Returns BOTH the distance-along-
  // route (meters — drives live-GPS progress, ETA, and voice cues) and the lateral
  // deviation (meters — how far off the line the rider is, used for off-route
  // detection / auto-reroute). Finds the nearest segment, then the closest point
  // on it. Planar projection is fine at route scale; deviation is converted back
  // to meters via haversine. Coarse (segment-level) is fine — cues warn ~250m out.
  function nearestOnRoute(line, pos) {
    var coords = line.coords, cum = line.cum;
    if (!coords || coords.length < 2) return { m: 0, devM: 0 };
    // Equirectangular projection about the rider's latitude. A degree of
    // longitude is only cos(lat) as long as a degree of latitude — at 34° N
    // that's 0.83, at 51° N (London) 0.63. Projecting raw lng/lat as if the
    // grid were square stretched every east–west segment, so the "nearest"
    // segment could be the wrong one and the lateral deviation read up to ~40%
    // high on an east–west road. That deviation drives the 55 m off-route test,
    // so the error showed up as spurious auto-reroutes while driving straight.
    var kx = Math.max(1e-6, Math.cos(pos[1] * Math.PI / 180)); // guard the poles
    var bestM = 0, bestD = Infinity, bestPt = coords[0];
    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i], b = coords[i + 1];
      var ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1];
      var px = pos[0] * kx, py = pos[1];
      var dx = bx - ax, dy = by - ay;
      var segLen2 = dx * dx + dy * dy;
      var t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0;
      t = Math.max(0, Math.min(1, t));
      var cx = ax + t * dx, cy = ay + t * dy;
      var d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d < bestD) {
        bestD = d;
        bestM = cum[i] + t * Math.max(cum[i + 1] - cum[i], 0);
        bestPt = [cx / kx, cy];   // back to real lng/lat for the haversine below
      }
    }
    return { m: Math.max(0, Math.min(line.total, bestM)), devM: U.haversine(pos, bestPt) };
  }
  function progressAt(line, pos) { return nearestOnRoute(line, pos).m; }

  /* ---------------- route prompt (map click) ---------------- */
  function promptRoute(lngLat) {
    var card = U.el('div', 'pop-card pop-prompt');
    card.innerHTML =
      '<div class="prompt-label"><span class="prompt-pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12A7 7 0 0 0 5 9c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg></span><span class="prompt-name">Dropped pin</span></div>' +
      '<div class="pop-actions"></div>';
    var actions = card.querySelector('.pop-actions');
    var go = U.el('button', 'btn btn-primary btn-small', 'Route here');
    var no = U.el('button', 'btn btn-ghost btn-small', 'Cancel');
    var nameEl = card.querySelector('.prompt-name');

    reverseLabel(lngLat).then(function (label) { nameEl.textContent = label; });

    go.addEventListener('click', function () {
      A.mapview.closePopup();
      setDestination(lngLat, nameEl.textContent || 'Dropped pin');
    });
    no.addEventListener('click', function () { A.mapview.closePopup(); });
    actions.appendChild(go);
    // In a convoy the dropped pin can also become the shared rally point.
    if (S.party) {
      var rallyBtn = U.el('button', 'btn btn-ghost btn-small', 'Rally here');
      rallyBtn.addEventListener('click', function () {
        A.mapview.closePopup();
        A.party.setRally(lngLat, nameEl.textContent || 'Rally point');
      });
      actions.appendChild(rallyBtn);
    }
    actions.appendChild(no);
    A.mapview.openPopup(lngLat, card);
  }

  /* ---------------- destination / route ---------------- */
  // Commit a chosen route to state + map. opts.noFit keeps the current camera
  // (used when a background police-avoid swap replaces the already-framed route).
  function applyRoute(r, label, lngLat, opts) {
    S.route = {
      label: label || 'Destination',
      dest: lngLat.slice(),
      distance: r.distance,
      duration: r.duration,
      traffic: r.trafficDelay || 0, // seconds of delay live traffic added (TomTom)
      coords: r.coords,
      cum: cumulative(r.coords),
      steps: r.steps || []
    };
    A.mapview.setRouteData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords } }]
    });
    A.mapview.addDest(lngLat);
    if (!(opts && opts.noFit)) A.mapview.fitRoute(r.coords);
    renderEtaCard();
    ST.emit('route', S.route);
  }

  function setDestination(lngLat, label) {
    if (S.trip && S.trip.active) endTrip(false);
    A.mapview.closePopup();
    A.ui.toast('Calculating route…', 'info');

    var from = A.sim.playerPos();
    fetchRoutes(from, lngLat).then(function (routes) {
      var fastest = routes[0];
      applyRoute(fastest, label, lngLat);                 // show the fastest route right away
      if (S.settings.avoidPolice) refinePoliceAvoid(from, lngLat, label, routes, fastest);
    }).catch(function () {
      A.ui.toast('Could not reach the routing service. Check your connection', 'warn');
    });
  }

  // Single route through a via point — forces a detour around police.
  function routeVia(from, via, to) {
    if (useTomTom()) {
      // Proxy skips maxAlternatives when a via is present (a forced detour).
      // Fall back to OSRM if the proxy/TomTom fails, just like fetchRoutes.
      return fetchJSON(ROUTE_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from, via: via, to: to })
      }).then(function (j) {
        if (!j.routes || !j.routes.length) throw new Error('no route');
        return ttNormalize(j.routes[0]);
      }).catch(function () { return osrmVia(from, via, to); });
    }
    return osrmVia(from, via, to);
  }

  function osrmVia(from, via, to) {
    var url = OSRM + from[0] + ',' + from[1] + ';' + via[0] + ',' + via[1] + ';' + to[0] + ',' + to[1] +
      '?overview=full&geometries=geojson&steps=true&alternatives=false';
    return fetchJSON(url).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('no route');
      var r = j.routes[0];
      return { distance: r.distance, duration: r.duration, coords: r.geometry.coordinates, steps: parseSteps(r) };
    });
  }

  // Via points offset perpendicular to the route, AWAY from the police POI that
  // sits most squarely on it — re-routing through one bends the path around it.
  // Returns several candidate offsets (a 700m nudge often snaps back to the same
  // road in a dense grid, so we also try wider detours).
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
    // Steer to the opposite side. Normalize into 0..360 — `heading - 90` went
    // negative for any heading under 90°, which is legal input to destPoint but
    // made the value meaningless to read or log.
    var side = ((rel >= 0 ? heading - 90 : heading + 90) % 360 + 360) % 360;
    return [700, 1400, 2200].map(function (off) { return U.destPoint(coords[i], side, off); });
  }

  function superseded(lngLat) {
    return !S.route || S.route.dest[0] !== lngLat[0] || S.route.dest[1] !== lngLat[1];
  }

  // Background pass: pull police/cameras near the route, then adopt the cleanest
  // option — the best OSRM alternative, or a waypoint detour we build ourselves.
  function refinePoliceAvoid(from, lngLat, label, routes, fastest) {
    fetchPoliceForRoutes(routes).then(function (police) {
      if (!police || !police.length || superseded(lngLat)) return;
      var fastestHits = policeHits(fastest.coords, police);

      var commit = function (chosen, chosenHits) {
        if (superseded(lngLat)) return;
        if (chosen !== fastest && chosenHits < fastestHits) {
          var extraMin = Math.round((chosen.duration - fastest.duration) / 60);
          applyRoute(chosen, label, lngLat, { noFit: true });
          A.ui.toast('Routed around ' + (fastestHits - chosenHits) + ' police/camera' +
            ((fastestHits - chosenHits) > 1 ? 's' : '') + (extraMin > 0 ? ' · +' + extraMin + ' min' : ''), 'success');
        } else if (chosenHits > 0) {
          A.ui.toast(chosenHits + ' police/camera' + (chosenHits > 1 ? 's' : '') +
            ' near this route · best available', 'info');
        }
      };

      // 1) cleanest of whatever alternatives OSRM returned
      var best = routes.map(function (r) { return { r: r, hits: policeHits(r.coords, police) }; })
        .sort(function (a, b) { return a.hits - b.hits || a.r.duration - b.r.duration; })[0];
      // Clean already, or so saturated a single detour won't help → stop here.
      if (best.hits === 0 || best.hits > 4) { commit(best.r, best.hits); return; }

      // 2) build detours around the worst on-route POI; keep the cleanest that
      //    isn't an absurd detour. Try progressively wider offsets in sequence,
      //    stopping early once we reach zero police.
      var wps = detourWaypoints(best.r.coords, police);
      if (!wps.length) { commit(best.r, best.hits); return; }
      var winner = best;
      (function tryNext(k) {
        if (k >= wps.length || superseded(lngLat)) { commit(winner.r, winner.hits); return; }
        routeVia(from, wps[k], lngLat).then(function (cand) {
          var ch = policeHits(cand.coords, police);
          if (ch < winner.hits && cand.duration < fastest.duration * 2) winner = { r: cand, hits: ch };
          if (winner.hits === 0) commit(winner.r, winner.hits);
          else tryNext(k + 1);
        }).catch(function () { tryNext(k + 1); });
      })(0);
    });
  }

  /* ---------------- cruise loop ----------------
     One tap → a route that leaves from where the rider is and loops back to the
     same spot. Candidate loops are built through waypoints on a rough circle in
     four directions, then scored keyless via Overpass:
       · police stations + speed cameras  — heavily penalized (avoid cops)
       · stop signs + traffic signals     — penalized (a good cruise avoids
                                            stop-and-go side streets)
       · distance from the requested size — mild penalty
     If Overpass is down, the loop with the highest average speed wins — fewer
     lights/stops per meter IS a faster route per meter. */
  var LOOP_CELL_STOP = 0.0005;    // ~50 m grid for stop signs / signals (they sit ON the road)
  var LOOP_CELL_POLICE = 0.0015;  // ~150 m grid for police / cameras (near the road counts)
  var loopBusy = false;

  // OSRM route through an ordered coord list (loop = start … waypoints … start).
  // continue_straight=true stops OSRM from U-turning back down the same road at
  // a via point, which would fold the loop onto itself.
  function osrmMulti(coordsList, signal) {
    var path = coordsList.map(function (c) { return c[0] + ',' + c[1]; }).join(';');
    var url = OSRM + path + '?overview=full&geometries=geojson&steps=true&alternatives=false&continue_straight=true';
    return fetchJSON(url, { signal: signal }).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('no route');
      var r = j.routes[0];
      return { distance: r.distance, duration: r.duration, coords: r.geometry.coordinates, steps: parseSteps(r) };
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
    var minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
    routes.forEach(function (r) {
      r.coords.forEach(function (c) {
        if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      });
    });
    var pad = 0.005;
    minLat -= pad; minLng -= pad; maxLat += pad; maxLng += pad;
    if ((maxLat - minLat) > 2 || (maxLng - minLng) > 2) return Promise.resolve(null);
    return fetch(OVERPASS_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'road',
        bbox: { minLat: minLat, minLng: minLng, maxLat: maxLat, maxLng: maxLng }
      })
    }).then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .then(function (j) {
        var out = { police: [], stops: [], signals: [] };
        ((j && j.elements) || []).forEach(function (e) {
          var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
          var lon = e.lon != null ? e.lon : (e.center && e.center.lon);
          if (lat == null || lon == null) return;
          var t = e.tags || {};
          if (t.amenity === 'police' || t.highway === 'speed_camera') out.police.push([lon, lat]);
          else if (t.highway === 'stop') out.stops.push([lon, lat]);
          else if (t.highway === 'traffic_signals') out.signals.push([lon, lat]);
        });
        return out;
      }).catch(function () { return null; });
  }

  // Approximate proximity counting on a rounded lat/lng grid — exact distances
  // would be POIs × vertices haversines (millions for a city-sized loop). A POI
  // counts as "on the route" when its cell or any neighbor holds a route vertex.
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
    if (loopBusy) return;
    var from = A.sim.playerPos();
    if (!from) { A.ui.toast('No position yet. Tap the locate button first', 'warn'); return; }
    loopBusy = true;
    if (S.trip && S.trip.active) endTrip(false);
    A.ui.toast('Planning a cruise loop…', 'info');
    var heading = A.sim.playerHeading() || 0;
    var cands = loopCandidates(from, heading, targetM);
    Promise.all(cands.map(function (c) { return osrmMulti(c).catch(function () { return null; }); }))
      .then(function (routes) {
        routes = routes.filter(function (r) { return r && r.distance > targetM * 0.3; });
        if (!routes.length) throw new Error('no loops');
        return fetchLoopPois(routes).then(function (pois) {
          var best = null, bestScore = null;
          routes.forEach(function (r) {
            var sc = scoreLoop(r, pois, targetM);
            if (!best || sc.total < bestScore.total) { best = r; bestScore = sc; }
          });
          applyRoute(best, 'Cruise loop', from.slice());
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
        });
      })
      .catch(function () {
        A.ui.toast('Could not plan a loop from here. Try again in a moment', 'warn');
      })
      .finally(function () { loopBusy = false; });
  }

  // Loop-size chooser, anchored at the rider's position on the map.
  function promptLoop() {
    var from = A.sim.playerPos();
    if (!from) { A.ui.toast('No position yet. Tap the locate button first', 'warn'); return; }
    var km = S.settings.units === 'km';
    // [meters, label] — sized for a quick spin / a proper cruise / a long ride
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
      b.addEventListener('click', function () {
        A.mapview.closePopup();
        planLoop(o[0]);
      });
      sizes.appendChild(b);
    });
    var no = U.el('button', 'btn btn-ghost btn-small', 'Cancel');
    no.addEventListener('click', function () { A.mapview.closePopup(); });
    card.querySelectorAll('.pop-actions')[1].appendChild(no);
    A.mapview.openPopup(from, card);
  }

  function clearRoute() {
    if (S.trip && S.trip.active) endTrip(false);
    S.route = null;
    A.mapview.setRouteData(null);
    A.mapview.removeDest();
    var card = document.getElementById('eta-card');
    card.classList.remove('show');
    card.hidden = true;
    ST.emit('route', null);
  }

  /* ---------------- trip ---------------- */
  function startTrip() {
    var r = S.route;
    if (!r) return;
    S.trip = {
      active: true,
      progress: 0,
      baseSpeed: r.distance / Math.max(r.duration, 1),
      mult: 1,            // 1× = live GPS (real position drives the trip); >1 = preview playback
      live: true,         // follow the rider's REAL GPS position, not a simulated dot
      gotFix: false,      // flips true on the first real GPS fix; until then we play the sim dot
      offSince: 0,        // perf-now ts when the rider first went off-route (0 = on route)
      follow: S.settings.followCam,
      camIntro: true,
      line: { coords: r.coords, cum: r.cum, total: lineTotal(r.cum, r.distance), _idx: 0 },
      cueIdx: 0,        // index of the next maneuver cue to announce
      warnedIdx: -1     // last maneuver we gave an advance warning for
    };
    document.getElementById('ctl-recenter').hidden = S.trip.follow;
    // On native (the real driving app) make sure the foreground GPS watch is live so
    // the trip follows the rider's actual position. On web we keep the tap-to-locate
    // flow so a desktop demo can preview a route without being yanked to home GPS.
    if (A.config && A.config.isNative && A.sim && A.sim.ensureWatch) A.sim.ensureWatch();
    renderEtaCard();
    A.ui.toast('Navigation started. Following your drive', 'success');
    speak('Starting route to ' + (r.label || 'your destination') + '.');
    if (S.party && S.party.members.length) {
      A.party.systemMsg('Trip started. Convoy rolling to ' + r.label);
    }
    ST.emit('trip', S.trip);
  }

  // Speed multiplier: 1× = live GPS (real driving); >1× = preview playback of the
  // route (the simulated dot takes over; back to 1× re-engages real GPS). The UI
  // chips were removed from the trip card — navigation always follows real GPS —
  // but the hook stays for programmatic/demo use via A.routing.setMult.
  function setMult(m) {
    if (!S.trip || !S.trip.active) return;
    S.trip.mult = m;
    S.trip.live = (m === 1);
    updateTripUI();
  }

  // Off-route auto-reroute (live-GPS nav). The rider drifted off the planned line
  // (missed turn, detour, lane onto a different road) — recompute from the current
  // real position to the SAME destination and swap the trip onto the new line
  // without ending it. Guarded so overlapping triggers can't stack fetches.
  var rerouting = false;
  function reroute() {
    if (rerouting || !S.trip || !S.trip.active || !S.route) return;
    rerouting = true;
    var dest = S.route.dest.slice(), label = S.route.label;
    var from = A.sim.playerPos();
    A.ui.toast('Off route. Recalculating…', 'info');
    fetchRoutes(from, dest).then(function (routes) {
      if (!S.trip || !S.trip.active || !routes || !routes.length) return; // trip ended / no route
      var r = routes[0];
      S.route = {
        label: label, dest: dest, distance: r.distance, duration: r.duration,
        traffic: r.trafficDelay || 0, coords: r.coords, cum: cumulative(r.coords), steps: r.steps || []
      };
      A.mapview.setRouteData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords } }]
      });
      // Swap the trip onto the new line; progress restarts at the current origin.
      S.trip.line = { coords: r.coords, cum: S.route.cum, total: lineTotal(S.route.cum, r.distance), _idx: 0 };
      S.trip.progress = 0;
      S.trip.cueIdx = 0;
      S.trip.warnedIdx = -1;
      S.trip.offSince = 0;
      S.trip.baseSpeed = r.distance / Math.max(r.duration, 1);
      renderEtaCard();
      speak('Recalculating route.');
      ST.emit('route', S.route);
      ST.emit('trip', S.trip);
    }).catch(function () { /* keep the old line; next off-route tick retries */ })
      .finally(function () { rerouting = false; });
  }

  function endTrip(arrived) {
    var label = S.route ? S.route.label : '';
    if (arrived) speak('You have arrived at ' + (label || 'your destination') + '.');
    else stopSpeaking();
    S.trip = null;
    document.getElementById('ctl-recenter').hidden = true;
    A.mapview.easeCam({ pitch: 0, duration: ST.dur(800) });
    if (arrived) {
      A.ui.toast('You arrived at ' + label, 'success');
      if (S.party && S.party.members.length) A.party.systemMsg('Convoy arrived at ' + label);
      clearRoute();
    } else {
      renderEtaCard();
    }
    ST.emit('trip', null);
  }

  // Called every trip tick from sim.js. Speaks maneuvers whose distance-along-
  // route has been crossed since the last call, plus one advance warning for the
  // next turn. Robust to high speed multipliers (multiple cues per frame).
  function announceCues(progress) {
    var trip = S.trip, r = S.route;
    if (!trip || !r || !r.steps || !r.steps.length) return;
    var units = S.settings.units;
    var steps = r.steps;

    // 1) Advance warning for the upcoming maneuver (once, ~250m / ~800ft out).
    var nx = trip.cueIdx;
    if (nx < steps.length) {
      var next = steps[nx];
      var ahead = next.at - progress;
      var warnDist = units === 'km' ? 250 : 240; // ~800ft
      if (next.type !== 'depart' && next.type !== 'arrive' && ahead <= warnDist && trip.warnedIdx < nx) {
        var txt = cueText(next);
        if (txt) speak(distPrefix(ahead, units) + txt.charAt(0).toLowerCase() + txt.slice(1));
        trip.warnedIdx = nx;
      }
    }

    // 2) Immediate cues: speak every maneuver we've now crossed.
    while (trip.cueIdx < steps.length && steps[trip.cueIdx].at <= progress) {
      var c = steps[trip.cueIdx];
      // skip the advance-warned maneuver's immediate repeat if it's the same
      if (trip.warnedIdx !== trip.cueIdx) {
        var t = cueText(c);
        if (t) speak(t);
      }
      trip.cueIdx++;
    }
  }

  /* ---------------- ETA card ---------------- */
  function renderEtaCard() {
    var card = document.getElementById('eta-card');
    var r = S.route;
    if (!r) { card.hidden = true; card.classList.remove('show'); return; }
    var trip = S.trip;

    if (!trip) {
      var arrive = new Date(Date.now() + r.duration * 1000);
      var tnote = (r.traffic && r.traffic >= 60) ? ' · +' + Math.round(r.traffic / 60) + ' min traffic' : '';
      card.innerHTML =
        '<div class="eta-main">' +
        '  <div class="eta-dest">' + U.esc(r.label) + '</div>' +
        '  <div class="eta-meta">' + U.fmtDist(r.distance, S.settings.units) + ' · ' +
        U.fmtDur(r.duration) + ' · arrive ' + U.fmtClock(arrive) + tnote + '</div>' +
        '</div>' +
        '<div class="eta-actions">' +
        '  <button class="btn btn-primary" id="eta-start">Start ride</button>' +
        '  <button class="icon-btn" id="eta-clear" aria-label="Clear route"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
        '</div>';
      card.querySelector('#eta-start').addEventListener('click', startTrip);
      card.querySelector('#eta-clear').addEventListener('click', clearRoute);
    } else {
      card.innerHTML =
        '<div class="eta-main">' +
        '  <div class="eta-dest">' + U.esc(r.label) + ' <span class="eta-live" id="trip-live" hidden>● LIVE</span></div>' +
        '  <div class="eta-meta"><span id="trip-remain">—</span> · ETA <span id="trip-eta">—</span></div>' +
        '  <div class="progress"><i id="trip-bar"></i></div>' +
        '</div>' +
        '<div class="eta-actions">' +
        '  <button class="btn btn-end" id="eta-end">End</button>' +
        '</div>';
      card.querySelector('#eta-end').addEventListener('click', function () { endTrip(false); });
      updateTripUI();
    }
    card.hidden = false;
    requestAnimationFrame(function () { card.classList.add('show'); });
  }

  // Seconds still to drive. A zero-length route (or a provider returning
  // distance 0) made baseSpeed 0, so remain/0 was Infinity and `new Date(NaN)`
  // rendered the ETA as "Invalid Date". Fall back to a walking-pace floor and
  // cap the horizon so the card always shows a real clock time.
  function remainingSecs(trip, remain) {
    var pace = (trip.baseSpeed || 0) * (trip.mult || 1);
    if (!(pace > 0.1)) pace = 0.1;
    return U.clamp(remain / pace, 0, 86400 * 7);
  }

  function updateTripUI() {
    var trip = S.trip, r = S.route;
    if (!trip || !r) return;
    var total = trip.line.total || 0;
    var remain = Math.max(0, total - trip.progress);
    var secs = remainingSecs(trip, remain);
    var remEl = document.getElementById('trip-remain');
    var etaEl = document.getElementById('trip-eta');
    var bar = document.getElementById('trip-bar');
    if (remEl) remEl.textContent = U.fmtDist(remain, S.settings.units) + ' left';
    if (etaEl) etaEl.textContent = U.fmtClock(new Date(Date.now() + secs * 1000));
    if (bar) bar.style.width = (total > 0 ? U.clamp(trip.progress / total * 100, 0, 100) : 0) + '%';
    // LIVE badge: lit only once real GPS is actually driving the trip.
    var liveEl = document.getElementById('trip-live');
    if (liveEl) liveEl.hidden = !(trip.live && trip.gotFix);
  }

  A.routing = {
    geocode: geocode,
    promptRoute: promptRoute,
    promptLoop: promptLoop,   // cruise-loop size chooser (ctl-loop button)
    planLoop: planLoop,       // loop route from here back to here, avoiding cops/stops/lights
    setDestination: setDestination,
    clearRoute: clearRoute,
    startTrip: startTrip,
    endTrip: endTrip,
    setMult: setMult,
    reroute: reroute,
    posAt: posAt,
    progressAt: progressAt,
    nearestOnRoute: nearestOnRoute,
    updateTripUI: updateTripUI,
    renderEtaCard: renderEtaCard,
    announceCues: announceCues,
    setNavEnabled: setNavEnabled,
    setVoiceName: setVoiceName,
    listVoices: listVoices,
    isNavSupported: isNavSupported,
    stopSpeaking: stopSpeaking,
    // Speak OUTSIDE navigation (radar callouts, alerts): same voice pipeline but
    // bypasses the voiceNav toggle — callers gate on their own setting.
    say: function (text) {
      if (!text) return;
      if (ttsServer === true) serverSpeak(text);
      else synthSpeak(text);
    },
    previewVoice: function () { navVoice = null; speak('Navigation voice ready. Turn left in 300 feet.'); }
  };
})();
