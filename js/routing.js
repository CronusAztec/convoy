/* Convoy — destination search (Nominatim), routing (OSRM), trip lifecycle + ETA card */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  var OVERPASS = 'https://overpass-api.de/api/interpreter';
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
  function geocode(q) {
    if (lastGeocode) { try { lastGeocode.abort(); } catch (e) {} }
    var ctrl = new AbortController(); lastGeocode = ctrl;
    var url = NOMINATIM + '/search?format=jsonv2&limit=6&accept-language=en&q=' + encodeURIComponent(q);
    return fetchJSON(url, { signal: ctrl.signal }).then(function (rows) {
      return rows.map(function (r) {
        var parts = (r.display_name || '').split(', ');
        return {
          label: parts[0] || r.display_name,
          sub: parts.slice(1, 4).join(', '),
          lng: parseFloat(r.lon),
          lat: parseFloat(r.lat)
        };
      });
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
    var box = minLat + ',' + minLng + ',' + maxLat + ',' + maxLng;
    var q = '[out:json][timeout:20];(' +
      'node["amenity"="police"](' + box + ');' +
      'way["amenity"="police"](' + box + ');' +
      'node["highway"="speed_camera"](' + box + ');' +
      ');out center 400;';
    if (lastPolice) { try { lastPolice.abort(); } catch (e) {} }
    var ctrl = new AbortController(); lastPolice = ctrl;
    return fetch(OVERPASS, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
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
  function policeHits(coords, police) {
    if (!police || !police.length) return 0;
    var hits = 0;
    for (var p = 0; p < police.length; p++) {
      var pt = police[p], near = false;
      for (var c = 0; c < coords.length; c += 2) { // sample every other vertex (full geometry is dense)
        if (U.haversine(pt, coords[c]) <= POLICE_AVOID_M) { near = true; break; }
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

  // position + bearing at progress meters along the line (cached segment index)
  function posAt(line, m) {
    var coords = line.coords, cum = line.cum;
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
    var bestM = 0, bestD = Infinity, bestPt = coords[0];
    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i], b = coords[i + 1];
      // project pos onto segment ab (planar — fine at route scale)
      var ax = a[0], ay = a[1], bx = b[0], by = b[1], px = pos[0], py = pos[1];
      var dx = bx - ax, dy = by - ay;
      var segLen2 = dx * dx + dy * dy;
      var t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0;
      t = Math.max(0, Math.min(1, t));
      var cx = ax + t * dx, cy = ay + t * dy;
      var d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d < bestD) {
        bestD = d;
        bestM = cum[i] + t * Math.max(cum[i + 1] - cum[i], 0);
        bestPt = [cx, cy];
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
      A.ui.toast('Could not reach the routing service — check your connection', 'warn');
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
    var side = (rel >= 0 ? heading - 90 : heading + 90 + 360) % 360; // steer to the opposite side
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
            ' near this route — best available', 'info');
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
      line: { coords: r.coords, cum: r.cum, total: r.distance, _idx: 0 },
      cueIdx: 0,        // index of the next maneuver cue to announce
      warnedIdx: -1     // last maneuver we gave an advance warning for
    };
    document.getElementById('ctl-recenter').hidden = S.trip.follow;
    renderEtaCard();
    A.ui.toast('Navigation started — following your drive', 'success');
    speak('Starting route to ' + (r.label || 'your destination') + '.');
    if (S.party && S.party.members.length) {
      A.party.systemMsg('Trip started — convoy rolling to ' + r.label);
    }
    ST.emit('trip', S.trip);
  }

  // Speed multiplier: 1× = live GPS (real driving); 5/20× = preview playback of
  // the route. Switching above 1× flips the trip into playback (live=false) so the
  // simulated dot takes over; switching back to 1× re-engages real GPS. Single
  // source of truth — also reflects the active chip + refreshes the ETA readout.
  function setMult(m) {
    if (!S.trip || !S.trip.active) return;
    S.trip.mult = m;
    S.trip.live = (m === 1);
    var chips = document.querySelectorAll('.speed-chip');
    chips.forEach(function (c) { c.classList.toggle('active', +c.dataset.mult === m); });
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
    A.ui.toast('Off route — recalculating…', 'info');
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
      S.trip.line = { coords: r.coords, cum: S.route.cum, total: r.distance, _idx: 0 };
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
      var mult = trip.mult || 1;
      function chip(m, lbl) { return '<button class="speed-chip' + (m === mult ? ' active' : '') + '" data-mult="' + m + '">' + lbl + '</button>'; }
      card.innerHTML =
        '<div class="eta-main">' +
        '  <div class="eta-dest">' + U.esc(r.label) + ' <span class="eta-live" id="trip-live" hidden>● LIVE</span></div>' +
        '  <div class="eta-meta"><span id="trip-remain">—</span> · ETA <span id="trip-eta">—</span></div>' +
        '  <div class="progress"><i id="trip-bar"></i></div>' +
        '</div>' +
        '<div class="eta-actions">' +
        '  <div class="speed-chips" title="1× follows your real GPS; 5×/20× preview the route">' +
        chip(1, 'Live') + chip(5, '5×') + chip(20, '20×') +
        '  </div>' +
        '  <button class="btn btn-end" id="eta-end">End</button>' +
        '</div>';
      card.querySelectorAll('.speed-chip').forEach(function (c) {
        c.addEventListener('click', function () { setMult(+c.dataset.mult); });
      });
      card.querySelector('#eta-end').addEventListener('click', function () { endTrip(false); });
      updateTripUI();
    }
    card.hidden = false;
    requestAnimationFrame(function () { card.classList.add('show'); });
  }

  function updateTripUI() {
    var trip = S.trip, r = S.route;
    if (!trip || !r) return;
    var remain = Math.max(0, trip.line.total - trip.progress);
    var secs = remain / (trip.baseSpeed * trip.mult);
    var remEl = document.getElementById('trip-remain');
    var etaEl = document.getElementById('trip-eta');
    var bar = document.getElementById('trip-bar');
    if (remEl) remEl.textContent = U.fmtDist(remain, S.settings.units) + ' left';
    if (etaEl) etaEl.textContent = U.fmtClock(new Date(Date.now() + secs * 1000));
    if (bar) bar.style.width = U.clamp(trip.progress / trip.line.total * 100, 0, 100) + '%';
    // LIVE badge: lit only once real GPS is actually driving the trip.
    var liveEl = document.getElementById('trip-live');
    if (liveEl) liveEl.hidden = !(trip.live && trip.gotFix);
  }

  A.routing = {
    geocode: geocode,
    promptRoute: promptRoute,
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
    previewVoice: function () { navVoice = null; speak('Navigation voice ready. Turn left in 300 feet.'); }
  };
})();
