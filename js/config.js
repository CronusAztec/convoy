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

  // Both lazy loaders below read the live ?v= stamp off config.js's own
  // <script> tag rather than hardcoding it, so the next stamp bump can't
  // silently break the fetch.
  function liveStamp() {
    var tag = document.querySelector('script[src*="config.js?v="]');
    var i = tag ? tag.src.indexOf('?v=') : -1;
    return i >= 0 ? tag.src.slice(i) : '';
  }

  // T1.5a: js/data.js (car/paint/name/city catalog, ~16 KB gzip) is off the
  // boot path — every consumer site (js/ui.js, js/party.js) reads it inside
  // a function, never at parse time. ensure() injects the script once and
  // caches the promise (via A.util.loadOnce, which also retries on a failed
  // load — see js/util.js) so repeat callers (idle warm + panel opens) share
  // one load.
  A.data.ensure = function () {
    if (A.data.loaded) return Promise.resolve(A.data);
    // The whole chain (script load + map-to-A.data) is the thing cached by
    // loadOnce, not just the loadScript() half — two overlapping callers must
    // get back the SAME promise object, and a bare .then() on a shared cached
    // promise would hand each caller a distinct derived promise instead.
    return A.util.loadOnce('data', function () {
      return A.util.loadScript('js/data.js' + liveStamp()).then(function () { return A.data; });
    });
  };

  // Task 3: js/voice.js (walkie-talkie, ~15.6 KB gzip) is lazy too. Unlike
  // A.data, nothing captures a `var V = A.voice;` at parse time, so there is
  // no object to seed ahead of time — this just resolves to A.voice once the
  // injected script has run and defined it.
  A.voiceLoader = A.voiceLoader || {};
  A.voiceLoader.ensure = function () {
    if (A.voice) return Promise.resolve(A.voice);
    return A.util.loadOnce('voice', function () {
      return A.util.loadScript('js/voice.js' + liveStamp()).then(function () { return A.voice; });
    });
  };

  // Generic lazy-module factory (cycle 4): the same shape as A.data.ensure /
  // A.voiceLoader.ensure above, generalised so a third and fourth module don't
  // each need their own hand-rolled copy. `check()` returns the loaded module
  // (or a falsy value if it hasn't landed yet) — the module itself is what
  // assigns `A.<key>` when its script runs, same as every module in the app.
  A.lazy = A.lazy || {};
  A.lazy.module = function (key, check) {
    return function () {
      var have = check();
      if (have) return Promise.resolve(have);
      return A.util.loadOnce(key, function () {
        return A.util.loadScript('js/' + key + '.js' + liveStamp()).then(check);
      });
    };
  };
  A.lazy.scanners = A.lazy.module('scanners', function () { return A.scanners; });
  A.lazy.radar = A.lazy.module('radar', function () { return A.radar; });
})();
