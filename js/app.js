/* Convoy — boot */
(function () {
  'use strict';
  var A = window.App;

  window.addEventListener('DOMContentLoaded', function () {
    A.store.load();
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
      if (A.speedalert) A.speedalert.init(); // overspeed banner (no rail card)
      if (A.dimmer) A.dimmer.init();         // night-drive glare overlay
      if (A.tripextras) A.tripextras.init(); // ETA-card weather + share + save
      A.auth.boot();   // decide: show auth screen, or enter app + connect (net.connect)
    });
  });
})();
