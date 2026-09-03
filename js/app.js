/* Convoy — boot */
(function () {
  'use strict';
  var A = window.App;

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
      A.voice.init();  // walkie-talkie: listen for convoy membership to start/stop voice
      if (A.overlays) A.overlays.init(); // weather/traffic/hazard map overlays
      if (A.native) A.native.init();     // native bridge: bg location + BLE radar + SABRE (no-op on web)
      if (A.wake) A.wake.init();         // keep-screen-awake setting
      if (A.places) A.places.init();     // saved places + parking pin
      if (A.triplog) A.triplog.init();   // trip recorder / drive log
      if (A.speedo) A.speedo.init();     // HUD speedometer
      // Instrument HUD cards — order here sets their top-to-bottom order in the rail.
      if (A.compass) A.compass.init();
      if (A.clock) A.clock.init();
      if (A.tripmeter) A.tripmeter.init();
      if (A.gmeter) A.gmeter.init();
      if (A.quest) A.quest.init();       // Top Speed Quest — top speed + fastest 60–100
      if (A.weathernow) A.weathernow.init();
      if (A.battery) A.battery.init();
      if (A.coords) A.coords.init();
      if (A.destarrow) A.destarrow.init();
      if (A.riderarrows) A.riderarrows.init(); // edge arrows to off-screen convoy riders
      if (A.speedalert) A.speedalert.init(); // overspeed banner (no rail card)
      if (A.dimmer) A.dimmer.init();         // night-drive glare overlay
      if (A.tripextras) A.tripextras.init(); // ETA-card weather + share + save
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
})();
