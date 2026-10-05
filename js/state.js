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
    anim: !(typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches),
    glass: 'auto',         // auto | on | off — 'auto' drops backdrop blur on low-memory devices
    showSpace: true,      // stars/planets/moon + day-night shading around the globe
    followCam: true,
    adaptiveZoom: true,   // follow camera eases zoom out at highway speed, in around town
    keepAwake: false,     // Wake Lock — keep the screen on while the app is open
    // Anonymous crash reports + core-loop analytics (js/telemetry.js). ON by
    // default and disclosed in the privacy policy; turning it off stops all
    // sending immediately and drops anything already queued. telemetry.js reads
    // this straight out of localStorage, because it runs before this module.
    diagnostics: true,
    voiceNav: true,       // spoken turn-by-turn navigation during a trip
    navVoiceName: '',     // custom navigator voice ('' = auto-pick a female voice)
    proxVoice: 'off',     // auto voice chat with riders around you: off | radius | sight | road
    // ---- walkie-talkie voice chat (js/voice.js) ----
    // Everything below drives the audio graph directly. Per-rider volume is
    // deliberately NOT here: rider ids are connection-scoped, so a persisted
    // map would key on ids that don't survive a reconnect. It lives in memory
    // for the session and resets, like a mute in any other call app.
    voiceSelfMute: false, // mic held muted regardless of PTT / open / toggle
    voiceDeafen: false,   // silence every peer at once, without dropping the calls
    voiceOutVol: 1,       // master output volume 0..1
    voiceInputId: '',     // chosen microphone deviceId ('' = system default)
    voiceOutputId: '',    // chosen output deviceId ('' = system default; needs setSinkId)
    voiceEc: true,        // echo cancellation
    voiceNs: true,        // noise suppression
    voiceAgc: true,       // automatic gain control
    voiceIsolation: false,// browser voice isolation, where the engine offers it
    voiceLeveler: false,  // compressor on the master bus — evens out a loud rider
    // Invisible mode: hidden from every rider outside your convoy (the server
    // drops you from their scope and from the delayed global feed) and silent on
    // proximity voice. Convoy members still see you.
    ghost: false,
    // Edge arrows pointing at convoy riders who are off screen (js/riderarrows.js).
    // The complement to "fit the convoy": once riders are far enough apart that
    // fitting them all would zoom out past usefulness, arrows are how you still
    // know where everyone is.
    riderArrows: true,
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
    // What this rider agreed to, and when. Kept as a record rather than a
    // boolean because the thing that matters legally is WHICH version of the
    // terms was accepted and at what moment — see LEGAL_VERSION.
    consent: null,         // { version, at, passenger, age, terms }
    // Riders this account has blocked: [{ id (account id), username, name, emoji }].
    // Server-authoritative when signed in — the socket sends the canonical list
    // at join and after every change — and the only copy there is for a guest.
    blocked: [],
    // Session-only, keyed by RIDER id rather than account id. This is how a guest
    // gets hidden at all: they have no durable identity to block, so the best
    // that can be offered is "not for the rest of this session", and the UI says
    // exactly that rather than implying more.
    hiddenRiders: [],
    // Feature legality notices acknowledged, key -> timestamp. Scoped to the
    // Terms version (featureAcked): a new Terms means every notice shows again.
    featureAck: {},
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
      // A throwing subscriber is a real bug that used to be invisible: the bus
      // swallowed it into console.error, where nobody on a phone will ever read
      // it. Log it AND report it — this is one of the highest-yield capture
      // points in the app, since almost every module reaches the UI through here.
      try { list[i](data); } catch (e) {
        console.error('[convoy] handler error for ' + evt, e);
        if (A.telemetry) A.telemetry.capture(e, 'bus:' + evt);
      }
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
      if (saved.consent && saved.consent.version) state.consent = saved.consent;
      if (Array.isArray(saved.blocked)) state.blocked = saved.blocked;
      if (saved.auth && saved.auth.token) state.auth = saved.auth;
      if (saved.featureAck && typeof saved.featureAck === 'object') state.featureAck = saved.featureAck;
      savedSettings = saved.settings || null;
    } catch (e) { console.warn('[convoy] could not load saved state', e); }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        profile: state.profile,
        settings: state.settings,
        onboarded: state.onboarded,
        consent: state.consent,
        // hiddenRiders is deliberately NOT persisted — a rider id is only
        // meaningful for the life of that socket, so keeping it would hide a
        // stranger who happened to be assigned the same id later.
        blocked: state.blocked,
        auth: state.auth,
        featureAck: state.featureAck
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

  /* How bright the theme's panels actually are, as a data-ui attribute.

     Not the same question as the theme registry's `dark` flag: that describes the
     MAP (zelda is parchment, so routes and glows key off it) while its panels are
     near-black. And it can't be answered by listing theme ids either, because the
     custom-theme editor lets a rider pick any surface colour they like.

     So it is measured, once per theme change, off the surface the panels are
     actually painted with. CSS that must stay legible on top of a panel — the
     driving-safety warning, the delete-account warning — keys off [data-ui]
     instead of guessing from the theme name, and every theme added later is
     covered without touching that CSS. */
  function applyUiBrightness() {
    var root = document.documentElement;
    var solid = '';
    try {
      solid = getComputedStyle(root).getPropertyValue('--surface-solid').trim();
    } catch (e) { /* no computed style (tests, detached doc) — fall through */ }
    // --surface-solid is authored as a hex in every theme; anything else (a
    // half-applied stylesheet, an rgb() override) leaves the previous value in
    // place rather than guessing wrong about the safety warning's legibility.
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(solid)) return;
    // luma() is 0..255 perceived brightness; the midpoint splits panel families
    // cleanly (light #eef3fa ≈ 241, frost #f7f9fc ≈ 249, dark #15171b ≈ 23).
    root.setAttribute('data-ui', U.luma(solid) > 140 ? 'light' : 'dark');
  }

  function applyTheme() {
    var t = themeResolved();
    if (A.themes) A.themes.apply(t); // inject the theme's CSS vars/fonts before the attr flips
    document.documentElement.setAttribute('data-theme', t);
    // After data-theme, so the measurement reads the theme that is now live.
    applyUiBrightness();
    emit('theme', t);
  }

  function applyAccent() {
    var hex = state.settings.accent;
    var rgb = U.hexToRgb(hex);
    var root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-rgb', rgb[0] + ',' + rgb[1] + ',' + rgb[2]);
    // Dark accents (Electric Violet, Hot Pink, any custom dark colour) need
    // white ink on accent-backed controls; light ones keep the near-black.
    // Chosen by measured contrast rather than a luma cutoff: luma() weights
    // gamma-encoded channels, so it called hot pink, green, red, purple and blue
    // "dark" and gave them white ink at 2.3-4.0:1. bestInk compares both.
    root.setProperty('--accent-ink', U.bestInk(hex));
    emit('accent', hex);
  }

  function applyAnim() {
    document.documentElement.setAttribute('data-anim', state.settings.anim ? 'on' : 'off');
    emit('anim', state.settings.anim);
  }

  // Blur budget: backdrop-filter is recomputed every frame over a repainting map,
  // so it is the most expensive surface we draw on a phone. 'auto' keeps the glass
  // on capable devices and drops it where it actually costs frames.
  function glassOn() {
    var v = state.settings.glass;
    if (v === 'on') return true;
    if (v === 'off') return false;
    if (typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-transparency: reduce)').matches) return false;
    var mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : null;
    return !(typeof mem === 'number' && mem <= 4);
  }
  function applyGlass() {
    document.documentElement.setAttribute('data-glass', glassOn() ? 'on' : 'off');
    emit('glass', glassOn());
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
  // Generic setter for the toggle/value settings (voice chat, camera, scenery).
  // All do the same thing: set, persist, emit a 'setting' event (plus an
  // optional specific one) so any interested module can react.
  /* ---------------- feature packs: late settings ----------------
     A pack (js/packs.js) arrives after load() has run, so its defaults land in
     two places: DEFAULT_SETTINGS, so setSetting() accepts the keys, and the live
     settings — where a value this rider saved earlier wins over the default. */
  var savedSettings = null;   // the raw saved settings block, for late registrations
  function registerSettings(defaults) {
    if (!defaults || typeof defaults !== 'object') return;
    Object.keys(defaults).forEach(function (k) {
      if (!(k in DEFAULT_SETTINGS)) DEFAULT_SETTINGS[k] = U.deepClone(defaults[k]);
      if (!(k in state.settings)) {
        state.settings[k] = savedSettings && (k in savedSettings) ? savedSettings[k] : U.deepClone(defaults[k]);
      }
    });
  }

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

  /* ---------- legal consent ----------
     LEGAL_VERSION is the version of the Terms and Privacy Policy this build
     ships against, and it is the whole mechanism: bumping it invalidates every
     stored consent, so the gate reappears and everyone re-accepts before they
     can ride. Bump it whenever either document changes materially, and keep it
     in step with the version printed at the top of legal/terms.html. */
  var LEGAL_VERSION = '1.3';

  // TRUE only for a consent recorded against the CURRENT documents, with every
  // box actually ticked. An older version, or a partial record, reads as no
  // consent at all — which is the point.
  function hasConsent() {
    var c = state.consent;
    return !!(c && c.version === LEGAL_VERSION && c.passenger && c.age && c.terms);
  }

  /* A feature legality notice (A.ui.legalGate) counts as read once per Terms
     version — an acknowledgement given under an older Terms is void. */
  function featureAcked(key) {
    var c = state.consent;
    if (!c || c.version !== LEGAL_VERSION) return false;
    return !!(state.featureAck && state.featureAck[key]);
  }
  function ackFeature(key) {
    if (!state.featureAck || typeof state.featureAck !== 'object') state.featureAck = {};
    state.featureAck[key] = Date.now();
    save();
  }

  function setConsent(rec) {
    state.consent = {
      version: LEGAL_VERSION,
      at: Date.now(),
      passenger: !!(rec && rec.passenger),
      age: !!(rec && rec.age),
      terms: !!(rec && rec.terms)
    };
    save();
    return state.consent;
  }

  /* ---------- blocking ----------
     Two tiers, because two kinds of rider exist.

     An ACCOUNT block is durable and symmetric and the server owns it: setBlocks
     replaces the local copy with what the socket sent, and the server refuses to
     relay anything between the two either way. addBlock/removeBlock update
     locally first so the UI responds immediately, then the socket confirms.

     A GUEST has no durable id, so there is nothing to write down. hideRider is
     the honest alternative: the rider's id is suppressed on THIS device for the
     rest of the session, and the UI says that rather than implying a real block.
     Rider ids are recycled per socket, which is why this is never persisted. */

  function blockedIds() { return state.blocked.map(function (b) { return b.id; }); }

  function isBlockedAccount(userId) {
    if (!userId) return false;
    for (var i = 0; i < state.blocked.length; i++) {
      if (state.blocked[i].id === userId) return true;
    }
    return false;
  }

  /* Matching is by USERNAME, not by account id.

     A rider record from the realtime feed carries `account` (the username) and
     deliberately does not carry the account uuid — see riderRecord in
     server/server.js. The username is already public, it is what the UI shows,
     and there is no rename feature for it to drift under. Sending the uuid to
     every nearby client purely so this check could use it would hand out a
     stable cross-session identifier for no gain.

     A rider anonymised by the email gate has account: null, so they read as
     unblockable here — which is honest, since you cannot tell who they are. If
     you had already blocked them the server filters them out before the record
     is ever built, so they never reach this check at all. */
  function isBlockedUsername(username) {
    if (!username) return false;
    for (var i = 0; i < state.blocked.length; i++) {
      if (state.blocked[i].username === username) return true;
    }
    return false;
  }

  // Does this rider record need hiding? Checks the durable account block and the
  // session-only rider hide. `npc` is a rider record from the realtime feed.
  function isBlockedRider(npc) {
    if (!npc) return false;
    if (npc.id && state.hiddenRiders.indexOf(npc.id) >= 0) return true;
    return isBlockedUsername(npc.account || npc.username || null);
  }

  function setBlocks(list) {
    state.blocked = Array.isArray(list) ? list.slice() : [];
    save();
    emit('blocked', state.blocked);
  }

  function addBlock(entry) {
    if (!entry || !entry.id || isBlockedAccount(entry.id)) return;
    state.blocked.push(entry);
    save();
    emit('blocked', state.blocked);
  }

  function removeBlock(userId) {
    var next = state.blocked.filter(function (b) { return b.id !== userId; });
    if (next.length === state.blocked.length) return;
    state.blocked = next;
    save();
    emit('blocked', state.blocked);
  }

  function hideRider(riderId) {
    if (!riderId || state.hiddenRiders.indexOf(riderId) >= 0) return;
    state.hiddenRiders.push(riderId);
    emit('blocked', state.blocked);
  }

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
    applyGlass: applyGlass, glassOn: glassOn,
    applyUiBrightness: applyUiBrightness,
    setTheme: setTheme, setAccent: setAccent, setMapStyle: setMapStyle,
    setUnits: setUnits, setShowGlobal: setShowGlobal, setAnim: setAnim,
    setFollowCam: setFollowCam, setVoiceNav: setVoiceNav, setNavVoice: setNavVoice, setGhost: setGhost,
    setSetting: setSetting, setDotColor: setDotColor, resetDotColors: resetDotColors,
    registerSettings: registerSettings, featureAcked: featureAcked, ackFeature: ackFeature,
    saveProfile: saveProfile, setOnboarded: setOnboarded,
    LEGAL_VERSION: LEGAL_VERSION,
    hasConsent: hasConsent, setConsent: setConsent,
    blockedIds: blockedIds, isBlockedAccount: isBlockedAccount, isBlockedUsername: isBlockedUsername,
    isBlockedRider: isBlockedRider,
    setBlocks: setBlocks, addBlock: addBlock, removeBlock: removeBlock, hideRider: hideRider,
    setAuth: setAuth, clearAuth: clearAuth,
    dur: dur
  };
})();
