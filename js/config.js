/* Convoy — platform config.
   Detects whether we're running inside a Capacitor native shell (Android APK)
   or as a regular web page. Exposes A.config so net.js / auth.js can build
   absolute server URLs only when needed — on the web everything stays same-origin. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  // On native (Capacitor WebView) the origin is https://localhost, so relative
  // /api paths and same-origin websockets would miss the server. Point at the
  // deployed backend instead. On the web this is '' and '' + '/api/x' = '/api/x'.
  var BASE = isNative ? 'https://odoreeci.tech' : '';

  A.config = {
    isNative: isNative,
    base: BASE,
    // Absolute ws/wss URL when native; null tells net.js to derive same-origin.
    wsUrl: BASE ? BASE.replace(/^http/, 'ws') + '/ws' : null,
    plugins: isNative && cap && cap.Plugins ? cap.Plugins : null
    // TomTom routing + traffic is now server-proxied (/api/route, /api/traffic/*)
    // so the key never ships in client JS. The client probes /api/route on boot
    // (net.js does this once the socket is live) and only opts in to TomTom when
    // the server confirms it has a key. No client key → automatic OSRM fallback.
  };
})();
