/* Convoy — app state, persistence, theming, event bus */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util;
  var KEY = 'convoy.v1';

  var DEFAULT_PROFILE = {
    name: 'Riley',
    handle: 'riley',
    emoji: 0,
    avatar: '',           // profile photo as a small data:image URL ('' = insignia glyph)
    vibe: 'Cruising',
    car: {
      // trim stays '' by default: older saves merge over this object, and a
      // non-empty default would stamp a Supra trim onto whatever car they drive.
      year: 2022, make: 'Toyota', model: 'Supra', trim: '',
      paint: '#2f6df6', paintName: 'Velocity Blue', finish: 'Gloss',
      body: 'Coupe', engine: '3.0L', trans: 'Automatic', drive: 'RWD',
      hp: 382, mods: 'None', exhaust: 'Stock'
    }
  };

  var DEFAULT_SETTINGS = {
    theme: 'dark',        // auto (system) | sun (daylight) | any theme id in js/themes.js (dark, light, gta5, …)
    accent: '#9aa3b0',    // neutral slate (was neon cyan #00f0ff)
    mapStyle: 'auto',     // auto | dark | positron | voyager | liberty | bright
    units: 'mi',          // mi | km
    showGlobal: true,
    anim: true,
    showSpace: true,      // stars/planets/moon + day-night shading around the globe
    followCam: true,
    adaptiveZoom: true,   // follow camera eases zoom out at highway speed, in around town
    showSpeedo: true,     // HUD speedometer (js/speedo.js)
    keepAwake: false,     // Wake Lock — keep the screen on while the app is open
    autoParkPin: true,    // drop a parking pin automatically when a trip arrives
    // ---- instrument HUD cards (js/hud.js rail + per-widget modules) ----
    showCompass: true,    // heading rose (js/compass.js)
    showClock: true,      // local time + next sun event (js/clock.js)
    showTripmeter: false, // session distance + moving time (js/tripmeter.js)
    showGforce: false,    // GPS-derived g-force meter (js/gmeter.js)
    showWeatherNow: false,// current conditions at your position (js/weathernow.js)
    showBattery: false,   // device battery level (js/battery.js)
    showCoords: false,    // live lat/lng, tap to copy (js/coords.js)
    showDestArrow: false, // arrow to the active route destination (js/destarrow.js)
    showQuest: true,      // Top Speed Quest — all-time top speed + fastest 60–100 (js/quest.js)
    speedAlert: 0,        // overspeed alert threshold in current units; 0 = off (js/speedalert.js)
    nightDim: 0,          // night-drive glare dimmer 0..0.7 (js/dimmer.js)
    avoidPolice: true,    // prefer route alternatives that skirt police stations + speed cameras
    voiceNav: true,       // spoken turn-by-turn navigation during a trip
    navVoiceName: '',     // custom navigator voice ('' = auto-pick a female voice)
    proxVoice: 'off',     // auto voice chat with riders around you: off | radius | sight | road
    ghost: false,         // invisible to other riders; reveal aircraft + police
    // ---- radar sonar (Ghost Mode audio) ----
    sonarVol: 0.8,        // master sonar volume 0..1
    sonarHeart: true,     // heartbeat on/off
    sonarPings: true,     // proximity pings on/off
    sonarStings: true,    // new-contact stings on/off
    sonarSpoken: true,    // voice callout ("Police ahead, 1.2 miles") on a new contact
    heartSense: 'normal', // heartbeat sensitivity: off | low | normal | aggressive
    pingRate: 'normal',   // ambient ping cadence: slow | normal | fast
    // ---- hardware radar detector (BLE, native only) ----
    detectorAuto: true,   // auto-connect a paired detector when Ghost Mode turns on
    // Opt-IN. When a paired detector alerts, this publishes the rider's EXACT
    // position to everyone within 30km, into the server's permanent hotspot
    // model, and out to any installed SABRE host — with no confirmation step.
    // That is not a decision to make on someone's behalf by default.
    detectorUpload: false, // share likely-police detections to the crowd map
    detectorId: '',       // remembered BLE device id (MAC) of the chosen detector
    detectorName: '',     // ...and its display name, for the settings label
    // ---- data overlay layers ----
    showWeather: false,   // Open-Meteo precipitation tiles
    weatherLayer: 'rain', // rain | temp | wind
    showTraffic: false,   // traffic-flow heatmap (needs a provider key in radar.js)
    showHazards: false,   // hazard pins (weather + user-reported)
    // ---- ghost target filters (which Ghost-Mode targets are tracked/alerted) ----
    ghostPolice: true,
    ghostCamera: true,
    ghostAir: true,
    ghostHeli: true,
    // ---- aircraft ownership filters (independent of the airplane/heli shape filter) ----
    // Each gates a class of aircraft on the radar board. All default on; turning one
    // off hides that class from the threat list + sonar (the map dot stays unless
    // its shape filter ghostAir/ghostHeli is also off). See radar.js kindAllowed.
    ghostAirCiv: true,      // civilian aircraft
    ghostAirMil: true,      // military
    ghostAirPolice: true,   // law-enforcement (police planes + rotor units)
    ghostAirEms: true,      // EMS / medevac / air-ambulance
    ghostHotspots: true,  // police probability "usually here" heatmap layer
    // ---- map rider-dot colors (recolor the 5 rider categories live) ----
    // Each maps to a CSS var (--dot-you, --dot-friend, …) written inline on :root.
    // Keys here mirror the var suffix. Defaults match the originals in styles.css.
    dotColors: {
      you: '#2f80ff',      // the player
      friend: '#ffb000',   // friends + convoy members
      near: '#2faa55',     // other riders — nearby/radius filter
      road: '#36c065',     // other riders — on your road
      sight: '#3ce07a'     // other riders — in sight ahead
    }
  };

  // Demo spawn: Los Angeles (geolocation requires https/localhost; ⌖ button upgrades to real position)
  var SPAWN = [-118.2517 + (Math.random() - 0.5) * 0.02, 34.0480 + (Math.random() - 0.5) * 0.02];

  var state = {
    profile: U.deepClone(DEFAULT_PROFILE),
    settings: U.deepClone(DEFAULT_SETTINGS),
    onboarded: false,
    auth: null,            // { token, username } when signed in
    friends: [],           // [{id, username, name, emoji, paint, online}] (server-synced)
    friendReqs: [],        // incoming friend requests [{id, username, name, emoji, paint}]
    netMode: 'connecting', // connecting | live | solo
    party: null,    // {name, emoji, members:[npcId], chat:[{from,text,t}]}
    route: null,    // {label, dest:[lng,lat], distance, duration, coords, cum}
    trip: null,     // {active, progress, baseSpeed, mult, follow, camIntro, line:{coords,cum,total}}
    playerStart: SPAWN
  };

  /* ---------- event bus ---------- */
  var subs = {};
  // Returns an unsubscribe function. ui.js's profile overlay already called the
  // return value to detach its one-shot 'stats' listener; on() returned nothing,
  // so that call threw and the listener leaked — one more every time a profile
  // was opened, each re-rendering a closed overlay on every stats broadcast.
  function on(evt, fn) {
    (subs[evt] = subs[evt] || []).push(fn);
    return function () { off(evt, fn); };
  }
  function off(evt, fn) {
    var list = subs[evt];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete subs[evt];
  }
  function emit(evt, data) {
    var list = subs[evt] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('[convoy] handler error for ' + evt, e); }
    }
  }

  /* ---------- persistence ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved.profile) {
        state.profile = Object.assign({}, DEFAULT_PROFILE, saved.profile);
        state.profile.car = Object.assign({}, DEFAULT_PROFILE.car, saved.profile.car || {});
      }
      if (saved.settings) {
        state.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings);
        // Deep-merge dotColors so a save missing any key (older client, partial
        // edit) falls back to that key's default instead of clobbering the whole
        // object to undefined.
        if (saved.settings.dotColors) {
          state.settings.dotColors = Object.assign(
            {}, DEFAULT_SETTINGS.dotColors, saved.settings.dotColors);
        }
      }
      // Neutral-theme migration: anyone still on the old neon-cyan default moves to the new neutral accent.
      if (state.settings.accent === '#00f0ff') state.settings.accent = DEFAULT_SETTINGS.accent;
      state.onboarded = !!saved.onboarded;
      if (saved.auth && saved.auth.token) state.auth = saved.auth;
    } catch (e) { console.warn('[convoy] could not load saved state', e); }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        profile: state.profile,
        settings: state.settings,
        onboarded: state.onboarded,
        auth: state.auth
      }));
    } catch (e) { /* storage full/blocked — non-fatal */ }
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { }
    location.reload();
  }

  /* ---------- theming ---------- */
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function themeResolved() {
    var t = state.settings.theme;
    if (t === 'auto') return media && media.matches ? 'light' : 'dark';
    if (t === 'sun') {
      // Follow the actual sun at the rider's position (demo spawn until a real fix).
      var pos = (A.sim && A.sim.playerPos && A.sim.playerPos()) || state.playerStart;
      return U.isDaylight(pos[1], pos[0]) ? 'light' : 'dark';
    }
    if (A.themes && !A.themes.get(t)) return 'dark'; // stale/unknown id in an old save
    return t;
  }

  // Whether the resolved theme is dark-based — drives map/route contrast choices.
  function themeIsDark() {
    var t = themeResolved();
    return A.themes ? A.themes.isDark(t) : t !== 'light';
  }

  function applyTheme() {
    var t = themeResolved();
    if (A.themes) A.themes.apply(t); // inject the theme's CSS vars/fonts before the attr flips
    document.documentElement.setAttribute('data-theme', t);
    emit('theme', t);
  }

  function applyAccent() {
    var hex = state.settings.accent;
    var rgb = U.hexToRgb(hex);
    var root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-rgb', rgb[0] + ',' + rgb[1] + ',' + rgb[2]);
    emit('accent', hex);
  }

  function applyAnim() {
    document.documentElement.setAttribute('data-anim', state.settings.anim ? 'on' : 'off');
    emit('anim', state.settings.anim);
  }

  // Write the 5 rider-dot colors to CSS vars on :root. The category rules in
  // styles.css read var(--dot-<key>), so this recolors every rider marker on the
  // map live (no marker rebuild needed — CSS var changes cascade instantly).
  // Robust to a partially-stored dotColors: any missing key keeps its default.
  function applyDotColors() {
    var d = state.settings.dotColors || DEFAULT_SETTINGS.dotColors;
    var root = document.documentElement.style;
    root.setProperty('--dot-you', d.you);
    root.setProperty('--dot-friend', d.friend);
    root.setProperty('--dot-near', d.near);
    root.setProperty('--dot-road', d.road);
    root.setProperty('--dot-sight', d.sight);
  }
  // Set one dot color. `key` is one of you|friend|near|road|sight.
  function setDotColor(key, hex) {
    if (!state.settings.dotColors || !(key in DEFAULT_SETTINGS.dotColors)) return;
    state.settings.dotColors[key] = hex;
    save();
    applyDotColors();
    emit('dotcolor', { key: key, hex: hex });
  }
  function resetDotColors() {
    state.settings.dotColors = U.deepClone(DEFAULT_SETTINGS.dotColors);
    save();
    applyDotColors();
    emit('dotcolor', null);
  }

  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (state.settings.theme === 'auto') applyTheme();
    });
  }

  // Sun-synced theme: re-check every minute so the dusk/dawn flip lands on time.
  setInterval(function () {
    if (state.settings.theme !== 'sun') return;
    if (document.documentElement.getAttribute('data-theme') !== themeResolved()) applyTheme();
  }, 60000);

  /* ---------- setters ---------- */
  function setTheme(v) {
    var prevDef = A.themes && A.themes.get(themeResolved());
    state.settings.theme = v;
    save();
    applyTheme();
    // Accent bookkeeping: adopt the new theme's signature accent when it defines one;
    // when it doesn't, only clear an accent the previous theme set — a custom pick survives.
    var def = A.themes && A.themes.get(themeResolved());
    if (def && def.accent) setAccent(def.accent);
    else if (prevDef && prevDef.accent && state.settings.accent === prevDef.accent) {
      setAccent(DEFAULT_SETTINGS.accent);
    }
  }
  function setAccent(hex) { state.settings.accent = hex; save(); applyAccent(); }
  function setMapStyle(v) { state.settings.mapStyle = v; save(); emit('mapstyle', v); }
  function setUnits(v) { state.settings.units = v; save(); emit('units', v); }
  function setShowGlobal(v) { state.settings.showGlobal = v; save(); emit('global', v); }
  function setAnim(v) { state.settings.anim = v; save(); applyAnim(); }
  function setFollowCam(v) { state.settings.followCam = v; save(); }
  function setVoiceNav(v) { state.settings.voiceNav = v; save(); emit('voicenav', v); }
  function setNavVoice(name) { state.settings.navVoiceName = name || ''; save(); emit('navvoice', name || ''); }
  function setGhost(v) { state.settings.ghost = v; save(); emit('ghost', v); }
  // Generic setter for the many new toggle/value settings (radar audio, layers,
  // ghost filters). All do the same thing: set, persist, emit a 'setting' event
  // (plus an optional specific one) so any interested module can react.
  function setSetting(key, val, evt) {
    if (!(key in DEFAULT_SETTINGS)) return;   // refuse unknown keys
    state.settings[key] = val;
    save();
    emit('setting', { key: key, val: val });
    if (evt) emit(evt, val);
  }
  function saveProfile(p) {
    state.profile = p;
    if (!state.profile.handle) state.profile.handle = (p.name || 'rider').toLowerCase().replace(/[^a-z0-9]/g, '');
    save();
    emit('profile', p);
  }
  function setOnboarded() { state.onboarded = true; save(); }

  // `session` is a Supabase session as reshaped by the server:
  //   { token, refreshToken, expiresAt, username, profile, email, emailVerified, provider }
  // The access token is short-lived (an hour by default), so the refresh token
  // and expiry have to be persisted alongside it — without them a returning
  // rider would be signed out every time their token aged out.
  // Fields absent from `session` keep their current value, so a refresh that
  // only rotates tokens doesn't have to restate the username or profile.
  function setAuth(session) {
    session = session || {};
    var prev = state.auth || {};
    // `email`, `emailVerified` and `provider` cannot use the `a || b` fallback
    // the others do: false and null are meaningful values here (an address that
    // is NOT yet confirmed, an account with no address at all), and `||` would
    // silently keep the previous one. Merge on presence instead.
    var has = function (k) { return Object.prototype.hasOwnProperty.call(session, k); };
    state.auth = {
      token: session.token || prev.token || null,
      refreshToken: session.refreshToken || prev.refreshToken || null,
      expiresAt: session.expiresAt || prev.expiresAt || 0,
      username: session.username || prev.username || null,
      email: has('email') ? (session.email || null) : (prev.email || null),
      emailVerified: has('emailVerified') ? !!session.emailVerified : !!prev.emailVerified,
      provider: has('provider') ? (session.provider || 'password') : (prev.provider || 'password')
    };
    state.onboarded = true;
    // Only fan a 'profile' emit out when the profile CONTENT changed. Token
    // refreshes and /api/me round-trips re-call setAuth with the same profile,
    // and the emit forwards to the server as a full `profile` frame (avatar
    // data URL included) that fans out to every nearby rider — hourly, per
    // rider, for nothing.
    var profileChanged = true;
    if (session.profile) {
      profileChanged = state.profile !== session.profile &&
        JSON.stringify(state.profile) !== JSON.stringify(session.profile);
      state.profile = session.profile;
      if (!state.profile.handle) state.profile.handle = String(state.auth.username || 'rider').toLowerCase();
    } else if (prev && state.profile) {
      profileChanged = false;   // tokens-only update (a refresh): nothing to re-broadcast
    }
    save();
    if (profileChanged) emit('profile', state.profile);
    emit('auth', state.auth);
  }

  function clearAuth() {
    state.auth = null;
    state.onboarded = false; // next boot shows the auth screen again
    save();
    emit('auth', null);
  }

  // Animation-aware duration (0 when animations are off)
  function dur(ms) { return state.settings.anim ? ms : 0; }

  A.state = state;
  A.store = {
    load: load, save: save, reset: reset,
    on: on, off: off, emit: emit,
    themeResolved: themeResolved, themeIsDark: themeIsDark,
    applyTheme: applyTheme, applyAccent: applyAccent, applyAnim: applyAnim, applyDotColors: applyDotColors,
    setTheme: setTheme, setAccent: setAccent, setMapStyle: setMapStyle,
    setUnits: setUnits, setShowGlobal: setShowGlobal, setAnim: setAnim,
    setFollowCam: setFollowCam, setVoiceNav: setVoiceNav, setNavVoice: setNavVoice, setGhost: setGhost,
    setSetting: setSetting, setDotColor: setDotColor, resetDotColors: resetDotColors,
    saveProfile: saveProfile, setOnboarded: setOnboarded,
    setAuth: setAuth, clearAuth: clearAuth,
    dur: dur
  };
})();
