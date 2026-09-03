/* Convoy — platform config.
   Detects whether we're running inside a Capacitor native shell (Android APK)
   or as a regular web page. Exposes A.config so net.js / auth.js can build
   absolute server URLs only when needed — on the web everything stays same-origin. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  // js/data.js loads lazily now (T1.5a) — js/ui.js and js/party.js capture
  // `var D = A.data;` at parse time, so this object must exist before they
  // run and must only ever be FILLED (never reassigned) once data.js lands.
  A.data = A.data || {};

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
    plugins: isNative && cap && cap.Plugins ? cap.Plugins : null,

    // Sentry DSN for crash reports (js/telemetry.js). A DSN is a PUBLIC
    // credential by design — it can only write events into one project — so it
    // ships in client JS the way Sentry's own SDK does. Leave it blank and
    // nothing changes: crashes still go to our own /api/telemetry, which is
    // where the crash-free-sessions number comes from either way. Set it and
    // Sentry additionally gets grouped stack traces, alerting and releases.
    //   https://<publicKey>@<host>/<projectId>
    sentryDsn: '',
    // Flip true in a dev console to echo every captured error locally.
    debugTelemetry: false
    // TomTom routing + traffic is now server-proxied (/api/route, /api/traffic/*)
    // so the key never ships in client JS. The client probes /api/route on boot
    // (net.js does this once the socket is live) and only opts in to TomTom when
    // the server confirms it has a key. No client key → automatic OSRM fallback.
  };

  // T1.5a: js/data.js (car/paint/name/city catalog, ~16 KB gzip) is off the
  // boot path — every consumer site (js/ui.js, js/party.js) reads it inside
  // a function, never at parse time. ensure() injects the script once and
  // caches the promise so repeat callers (idle warm + panel opens) share one
  // load. The ?v= stamp is read off this very script's own tag rather than
  // hardcoded, so the next stamp bump can't silently break the fetch.
  var dataPromise = null;
  A.data.ensure = function () {
    if (A.data.loaded) return Promise.resolve(A.data);
    if (dataPromise) return dataPromise;
    var tag = document.querySelector('script[src*="config.js?v="]');
    var i = tag ? tag.src.indexOf('?v=') : -1;
    var stamp = i >= 0 ? tag.src.slice(i) : '';
    dataPromise = A.util.loadScript('js/data.js' + stamp).then(function () {
      return A.data;
    });
    return dataPromise;
  };
})();
