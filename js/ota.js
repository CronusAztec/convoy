/* Convoy — OTA live-update client (the hotfix path for the Android shell).

   The web app gets fixes by reload: the server serves index.html no-cache and
   every asset carries a ?v= stamp. The APK is the frozen half — its www/ was
   zipped in at build time — so until now a JS fix meant a full rebuild + store
   review. This module is the JS half of the bridge; the native half is
   LiveUpdatePlugin.java (registered as the "LiveUpdate" plugin).

   The contract with the plugin is three calls and one event:

     init()     once per boot — kicks the plugin's single update check
                (POST /api/ota {platform, versions} — no device identifier,
                keeping the Play Data Safety "Device IDs: No" answer true)
     ready()    called when the app finished booting WITHOUT throwing. This is
                the health handshake: a downloaded bundle only becomes the
                permanent one after the app built from it checks in. If ready()
                never arrives, the plugin reverts to the previous bundle (or
                the APK's builtin assets) on its own 15s watchdog — even across
                process death, because the "staged, unconfirmed" state is
                persisted before it is ever served.
     info()     diagnostics for the drill + telemetry.

   Bundles are NEVER swapped mid-session: a downloaded update is served on the
   NEXT app launch, so a fix can never yank the WebView out from under an
   active ride. The plugin refuses anything but https, verifies the zip's
   sha256 against the manifest, and blocks a version that failed the handshake
   from being staged twice.

   On the web this whole module is inert — there is nothing to update when the
   server already serves the current files. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  function plugin() {
    var p = A.config && A.config.plugins ? A.config.plugins : null;
    return p && p.LiveUpdate ? p.LiveUpdate : null;
  }

  var wired = false;   // addListener only once per page

  function track(name, data) {
    try { if (A.telemetry && A.telemetry.track) A.telemetry.track(name, data); }
    catch (e) { /* never let diagnostics break the updater */ }
  }

  function toast(msg, kind) {
    try { if (A.ui && A.ui.toast) A.ui.toast(msg, kind || 'info'); }
    catch (e) { /* same */ }
  }

  A.ota = {
    /* Returns true when the native updater is present and was poked. Safe to
       call on the web: returns false and does nothing. */
    init: function () {
      var p = plugin();
      if (!p) return false;
      if (!wired && p.addListener) {
        wired = true;
        try {
          p.addListener('state', function (s) {
            if (!s || !s.t) return;
            if (s.t === 'staged') {
              // The only state a rider ever needs to know about: a fix is
              // downloaded and lands next launch. No action required.
              toast('Convoy update ready — applies next launch');
              track('ota_staged', { version: s.version });
            } else if (s.t === 'reverted') {
              toast('Update problem detected — rolled back to the last good version', 'warn');
              track('ota_reverted', { version: s.version, to: s.to || '' });
            } else if (s.t === 'failed') {
              // Silent for the rider (nothing changed for them), but the
              // operator needs the failed delivery in the dashboard.
              track('ota_failed', { error: String(s.error || '').slice(0, 80) });
            }
          });
        } catch (e) { /* older bridge without listener proxy — events optional */ }
      }
      try {
        p.check({ base: A.config.base || '' });
      } catch (e) {
        track('ota_failed', { error: 'check threw' });
      }
      return true;
    },

    /* Called at the END of a successful boot (js/app.js). The one bit of
       ordering that matters in this file: never call it from a catch path —
       a bundle whose boot threw is exactly the bundle the watchdog exists
       to catch. */
    ready: function () {
      var p = plugin();
      if (!p) return false;
      try { p.notifyReady(); } catch (e) { return false; }
      return true;
    },

    /* Diagnostics (drill + console): what bundle is running / staged. */
    info: function () {
      var p = plugin();
      if (!p) return Promise.resolve({ active: '', builtin: true, web: true });
      try { return p.info(); } catch (e) { return Promise.resolve({ error: 'unavailable' }); }
    }
  };
})();
