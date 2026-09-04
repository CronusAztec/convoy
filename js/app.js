/* Convoy — boot */
(function () {
  'use strict';
  var A = window.App;

  // Default-OFF HUD instruments (js/state.js:41-49) — each module is fetched
  // lazily via A.lazy.<key> (js/config.js) the moment its setting first goes
  // truthy, instead of unconditionally on every cold boot. Table order must
  // match js/hud.js's rank table (tripmeter, gmeter, weathernow, battery,
  // coords, destarrow — the two without a rail card, speedalert/dimmer,
  // don't need a rank entry).
  var LAZY_INSTRUMENTS = [
    ['showTripmeter', 'tripmeter'], ['showGforce', 'gmeter'],
    ['showWeatherNow', 'weathernow'], ['showBattery', 'battery'],
    ['showCoords', 'coords'], ['showDestArrow', 'destarrow'],
    ['speedAlert', 'speedalert'], ['nightDim', 'dimmer']
  ];
  // Closure-scoped rather than a flag on the module object: keeps the "has
  // this been woken" bookkeeping out of the module's own namespace, and
  // guards the init() call (loadOnce already dedupes the script fetch itself).
  var wokenInstruments = {};
  function wakeInstrument(key) {
    if (wokenInstruments[key]) return;
    wokenInstruments[key] = true;
    A.lazy[key]().then(function (m) { if (m && m.init) m.init(); }).catch(function () {});
  }
  function wakeLazyInstruments() {
    LAZY_INSTRUMENTS.forEach(function (pair) {
      if (A.state.settings[pair[0]]) wakeInstrument(pair[1]);
    });
    // A setting can be flipped on later from Settings — wake the module the
    // first time that happens. Once loaded, the module's own ST.on('setting')
    // handler (e.g. js/battery.js:44) takes over every subsequent toggle, so
    // this listener must not also react once wokenInstruments[key] is set.
    A.store.on('setting', function (s) {
      for (var i = 0; i < LAZY_INSTRUMENTS.length; i++) {
        if (LAZY_INSTRUMENTS[i][0] === s.key && s.val) { wakeInstrument(LAZY_INSTRUMENTS[i][1]); break; }
      }
    });
  }
  // js/tripextras.js (ETA-card extras) isn't gated on a boolean setting like
  // the eight above — it activates on trip/route activity, which state.js
  // never persists (S.route starts null every boot), so the first real
  // 'route'/'trip' event is always live user action, never a boot-time replay.
  // Wake it on whichever of the two fires first, then stop listening.
  var tripextrasWoken = false;
  var offTripextrasRoute, offTripextrasTrip;
  function wakeTripextras() {
    if (tripextrasWoken) return;
    tripextrasWoken = true;
    offTripextrasRoute(); offTripextrasTrip();
    A.lazy.tripextras().then(function (m) { if (m && m.init) m.init(); }).catch(function () {});
  }
  function wakeTripextrasOnFirstRouteOrTrip() {
    offTripextrasRoute = A.store.on('route', wakeTripextras);
    offTripextrasTrip = A.store.on('trip', wakeTripextras);
  }
  // js/riderarrows.js (edge arrows to off-screen convoy riders) has nothing to
  // draw until the rider is actually in a convoy. S.party starts null every
  // boot (state.js:158, same shape as S.route) and 'party' also fires on a
  // LEAVE (party.js's leave() sets S.party = null then emits), so this must
  // check the value, not just react to the event — otherwise the very first
  // party event of a session that happens to be "no convoy" would wake the
  // module for nothing. A party resume after reconnect (net.js's applyParty())
  // sets S.party THEN emits 'party', so it is caught by this same listener,
  // no separate boot-time check needed. Once woken, init() ends with its own
  // schedule() call, so no catch-up refresh() is needed (unlike tripextras).
  var riderarrowsWoken = false;
  var offRiderarrowsParty;
  function wakeRiderarrows() {
    if (riderarrowsWoken || !A.state.party) return;
    riderarrowsWoken = true;
    offRiderarrowsParty();
    A.lazy.riderarrows().then(function (m) { if (m && m.init) m.init(); }).catch(function () {});
  }
  function wakeRiderarrowsOnFirstParty() {
    offRiderarrowsParty = A.store.on('party', wakeRiderarrows);
  }
  // js/vitals.js: woken at load+idle like A.data/A.voice below, not on a bus
  // event — it has nothing to observe until the page has painted, and
  // reports itself once at session end via A.telemetry.beforeEnd().
  function wakeVitalsOnLoadIdle() {
    A.lazy.vitals().then(function (m) { if (m && m.init) m.init(); }).catch(function () {});
  }
  // Test seam only (test/lazyinstruments.test.js) — app.js otherwise exports
  // nothing on A, since everything else here is boot-time side effects wired
  // through DOMContentLoaded/load listeners that a test can't safely trigger
  // (they assume a live map/socket/GPS). Calling these here does not change
  // runtime behaviour: they still run from inside the real DOMContentLoaded
  // handler below at the same point in boot order.
  A.appBoot = {
    LAZY_INSTRUMENTS: LAZY_INSTRUMENTS, wakeInstrument: wakeInstrument, wakeLazyInstruments: wakeLazyInstruments,
    wakeTripextras: wakeTripextras, wakeTripextrasOnFirstRouteOrTrip: wakeTripextrasOnFirstRouteOrTrip,
    wakeRiderarrows: wakeRiderarrows, wakeRiderarrowsOnFirstParty: wakeRiderarrowsOnFirstParty,
    wakeVitalsOnLoadIdle: wakeVitalsOnLoadIdle
  };

  window.addEventListener('DOMContentLoaded', function () {
    A.store.load();
    // Straight after load() so the reporter can see the rider's opt-out, and
    // before anything else gets a chance to throw. Its error handlers were
    // installed back at script-load time; this only starts the session and
    // wires the funnel.
    if (A.telemetry) A.telemetry.init();
    // OTA check first of all: it is fully async and must not depend on the map
    // or any later step — a hotfix channel that only fires when the app is
    // healthy cannot fix the app. ready() is confirmed at the END of boot.
    if (A.ota) A.ota.init();
    A.store.applyTheme();
    A.store.applyAccent();
    A.store.applyAnim();
    A.store.applyGlass();
    A.store.applyDotColors();

    // One-time boot glitch flash — sells the "HUD powering on" feel.
    // Respects the animation setting; cleans itself up after running.
    if (A.state.settings.anim) {
      var boot = document.getElementById('hud-boot');
      if (boot) {
        boot.classList.add('fire');
        boot.addEventListener('animationend', function () { boot.classList.remove('fire'); }, { once: true });
      }
    }

    A.mapview.init().then(function () {
      if (A.telemetry) A.telemetry.step('map_ready');
      A.sim.start();   // player marker + render loop (map runs under the auth screen)
      A.ui.init();     // wire panels/dock/search (no modal yet)
      if (A.overlays) A.overlays.init(); // weather/traffic/hazard map overlays
      if (A.native) A.native.init();     // native bridge: bg location + BLE radar + SABRE (no-op on web)
      if (A.wake) A.wake.init();         // keep-screen-awake setting
      if (A.places) A.places.init();     // saved places + parking pin
      if (A.triplog) A.triplog.init();   // trip recorder / drive log
      if (A.speedo) A.speedo.init();     // HUD speedometer
      // Instrument HUD cards — order here (and LAZY_INSTRUMENTS below, for the
      // default-off ones) sets their top-to-bottom order in the rail; see
      // js/hud.js's rank table, which must be kept in the same order.
      if (A.compass) A.compass.init();
      if (A.clock) A.clock.init();
      if (A.quest) A.quest.init();       // Top Speed Quest — top speed + fastest 60–100
      wakeLazyInstruments();             // tripmeter/gmeter/weathernow/battery/coords/destarrow/speedalert/dimmer
      wakeRiderarrowsOnFirstParty();     // edge arrows to off-screen convoy riders, loaded on first real party
      wakeTripextrasOnFirstRouteOrTrip(); // ETA-card weather + share + save, loaded on first route/trip
      A.auth.boot();   // decide: show auth screen, or enter app + connect (net.connect)
      // OTA handshake, deliberately LAST and only on the success path: the
      // bundle that is running proved it can boot (map up, UI wired, auth
      // decided). A bundle that threw anywhere above must never be confirmed —
      // that is what the plugin's watchdog counts.
      if (A.ota) A.ota.ready();
    }).catch(function (e) {
      // The map failing to initialise is the worst crash this app has: the rider
      // gets a black screen and nothing after this line runs. It used to be an
      // unhandled rejection with no route off the device.
      if (A.telemetry) A.telemetry.capture(e, 'mapview.init');
      if (A.ui && A.ui.toast) A.ui.toast('The map failed to load. Try reopening Convoy.', 'warn');
      // NOTE: no A.ota.ready() here on purpose — see the comment above it.
    });
  });

  // T1.5a idle warm: js/data.js (car/paint/name/city catalog) is off the boot
  // path now. Fetch it once boot is out of the way so it is already sitting
  // in A.data by the time any human opens the garage or profile panel — same
  // load+idle shape js/telemetry.js uses for its first flush (reused, not
  // reinvented). Ignored on purpose: buildProfilePanel()/buildGaragePage()
  // await A.data.ensure() themselves for the rider who beats this warm.
  window.addEventListener('load', function () {
    var ric = window.requestIdleCallback || function (cb) { setTimeout(cb, 1); };
    ric(function () { if (A.data && A.data.ensure) A.data.ensure().catch(function () {}); });
  }, { once: true });

  // Task 3 (cycle 3): js/voice.js (walkie-talkie) is off the boot path too —
  // same warm-then-init shape as A.data above. No convoy can exist in the
  // first seconds of boot, and every A.voice consumer except this init call
  // is already `if (A.voice)`-guarded and already degrades to a silent no-op
  // when voice hasn't loaded, so warming it at idle and initing it once
  // loaded costs nothing a rider can notice.
  window.addEventListener('load', function () {
    var ric = window.requestIdleCallback || function (cb) { setTimeout(cb, 1); };
    ric(function () {
      if (A.voiceLoader && A.voiceLoader.ensure) {
        A.voiceLoader.ensure().then(function (v) { if (v && v.init) v.init(); }).catch(function () {});
      }
    });
  }, { once: true });

  window.addEventListener('load', function () {
    var ric = window.requestIdleCallback || function (cb) { setTimeout(cb, 1); };
    ric(wakeVitalsOnLoadIdle);
  }, { once: true });
})();
