/* Convoy — boot */
(function () {
  'use strict';
  var A = window.App;

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
  // reports itself once, at the earlier of session end (A.telemetry.beforeEnd())
  // or a 20s-after-wake timer (cycle 23: 'end' alone never fired on real devices).
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
      if (A.native) A.native.init();     // native bridge: background GPS + sign-in deep links (no-op on web)
      if (A.wake) A.wake.init();         // keep-screen-awake setting
      wakeRiderarrowsOnFirstParty();     // edge arrows to off-screen convoy riders, loaded on first real party
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
