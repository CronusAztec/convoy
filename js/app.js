/* Convoy — boot */
(function () {
  'use strict';
  var A = window.App;

  window.addEventListener('DOMContentLoaded', function () {
    A.store.load();
    A.store.applyTheme();
    A.store.applyAccent();
    A.store.applyAnim();

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
      A.auth.boot();   // decide: show auth screen, or enter app + connect (net.connect)
    });
  });
})();
