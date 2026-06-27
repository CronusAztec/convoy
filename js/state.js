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
    vibe: 'Chill cruise',
    car: {
      year: 2022, make: 'Toyota', model: 'Supra',
      paint: '#2f6df6', paintName: 'Velocity Blue', finish: 'Gloss',
      body: 'Coupe', engine: '3.0L', trans: 'Automatic', drive: 'RWD',
      hp: 382, mods: 'None', exhaust: 'Stock'
    }
  };

  var DEFAULT_SETTINGS = {
    theme: 'dark',        // dark | light | auto
    accent: '#9aa3b0',    // neutral slate (was neon cyan #00f0ff)
    mapStyle: 'auto',     // auto | dark | positron | voyager | liberty | bright
    units: 'mi',          // mi | km
    showGlobal: true,
    anim: true,
    followCam: true,
    avoidPolice: true,    // prefer route alternatives that skirt police stations + speed cameras
    voiceNav: true,       // spoken turn-by-turn navigation during a trip
    navVoiceName: '',     // custom navigator voice ('' = auto-pick a female voice)
    ghost: false,         // invisible to other riders; reveal aircraft + police
    // ---- radar sonar (Ghost Mode audio) ----
    sonarVol: 0.8,        // master sonar volume 0..1
    sonarHeart: true,     // heartbeat on/off
    sonarPings: true,     // proximity pings on/off
    sonarStings: true,    // new-contact stings on/off
    heartSense: 'normal', // heartbeat sensitivity: off | low | normal | aggressive
    pingRate: 'normal',   // ambient ping cadence: slow | normal | fast
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
    ghostHotspots: true   // police probability "usually here" heatmap layer
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
  function on(evt, fn) { (subs[evt] = subs[evt] || []).push(fn); }
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
      if (saved.settings) state.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings);
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
    return t;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', themeResolved());
    emit('theme', themeResolved());
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

  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (state.settings.theme === 'auto') applyTheme();
    });
  }

  /* ---------- setters ---------- */
  function setTheme(v) { state.settings.theme = v; save(); applyTheme(); }
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

  function setAuth(token, username, profile) {
    state.auth = { token: token, username: username };
    state.onboarded = true;
    if (profile) {
      state.profile = profile;
      if (!state.profile.handle) state.profile.handle = String(username || 'rider').toLowerCase();
    }
    save();
    emit('profile', state.profile);
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
    on: on, emit: emit,
    themeResolved: themeResolved,
    applyTheme: applyTheme, applyAccent: applyAccent, applyAnim: applyAnim,
    setTheme: setTheme, setAccent: setAccent, setMapStyle: setMapStyle,
    setUnits: setUnits, setShowGlobal: setShowGlobal, setAnim: setAnim,
    setFollowCam: setFollowCam, setVoiceNav: setVoiceNav, setNavVoice: setNavVoice, setGhost: setGhost,
    setSetting: setSetting,
    saveProfile: saveProfile, setOnboarded: setOnboarded,
    setAuth: setAuth, clearAuth: clearAuth,
    dur: dur
  };
})();
