/* Convoy — native bridge (Capacitor plugins) with graceful web fallback.
   Wires the native plugins to the web app. On the web — or when a plugin is
   missing — EVERY method is a safe no-op, so the browser build behaves exactly
   as before. The Android plugins live in android/app/src/main/java/tech/odoreeci/convoy/,
   the iOS ones in ios/App/App/.

     BackgroundLocation — foreground GPS service (Android) / background location
                          updates (iOS); 'fix' events keep the player position
                          live while the app is backgrounded / screen off.
                          Started on native boot, piped into A.sim.externalFix().
     Voice              — RECORD_AUDIO permission ahead of getUserMedia() (Android
                          only; iOS prompts from the WebView itself).
     Auth               — social sign-in: opens the provider in the system browser
                          (Custom Tab / SFSafariViewController) and delivers the
                          deep link back as a 'redirect' event, plus 'link' for
                          the reset/verify/magic/change links Convoy emails (App
                          Links / Universal Links). Used by js/auth.js; on the web
                          both arrive in the URL instead and this is never touched.
                          On iOS the same two events are synthesised here from the
                          official @capacitor/app `appUrlOpen` event, with
                          @capacitor/browser carrying the outbound half. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, ST = A.store;

  function isNative() { return !!(A.config && A.config.isNative); }
  function platform() { return (A.config && A.config.platform) || 'web'; }
  function get(name) {
    var p = A.config && A.config.plugins ? A.config.plugins : null;
    return p && p[name] ? p[name] : null;
  }
  function toast(msg, kind) { if (A.ui && A.ui.toast) A.ui.toast(msg, kind || 'info'); }

  var bg = { running: false };
  var wired = { bg: false, auth: false, authLink: false }; // addListener only once per plugin

  /* ---------------- background location ---------------- */
  function startBackgroundLocation() {
    var p = get('BackgroundLocation');
    if (!p) return Promise.resolve(false);
    if (!wired.bg) {
      wired.bg = true;
      p.addListener('fix', function (f) {
        if (!f || typeof f.lng !== 'number') return;
        if (A.sim && A.sim.externalFix) {
          A.sim.externalFix({
            lng: f.lng, lat: f.lat, accuracy: f.accuracy,
            speed: (f.speed != null && f.speed >= 0) ? f.speed : null,
            bearing: f.bearing, time: f.time
          });
        }
      });
    }
    return p.start()
      .then(function (r) { bg.running = !!(r && r.running); return bg.running; })
      .catch(function () { return false; });
  }
  function stopBackgroundLocation() {
    var p = get('BackgroundLocation'); if (!p) return;
    p.stop().catch(function () {}); bg.running = false;
  }

  /* ---------------- microphone permission ---------------- */
  // The Android WebView only grants getUserMedia() once RECORD_AUDIO is already
  // held, so voice.js calls this immediately before its first getUserMedia().
  // On the web (and if the plugin is missing) it resolves true and the browser's
  // own permission prompt handles things exactly as before.
  function ensureMic() {
    var p = get('Voice');
    if (!p || !p.ensure) return Promise.resolve(true);
    return p.ensure().then(function (r) { return !!(r && r.granted); }).catch(function () { return false; });
  }

  /* ---------------- social sign-in ----------------
     On the web a provider sign-in is a page navigation. Inside the APK neither
     end of that works: Google refuses OAuth in an embedded WebView, and the
     WebView's https://localhost origin is not somewhere a provider can redirect
     back to. So the round-trip goes out to a Custom Tab and comes back as a
     deep link, which AuthPlugin forwards here. See android/.../AuthPlugin.java. */

  // Open the provider URL in the system browser. Resolves false when there is no
  // plugin (web build) so the caller can fall back to navigating the page.
  function openAuthUrl(url) {
    if (!url) return Promise.resolve(false);
    // Android: the first-party AuthPlugin (Custom Tab). iOS has no such plugin;
    // the official Browser plugin's SFSafariViewController does the same job
    // and the system hands the custom-scheme redirect straight back to the app.
    var p = get('Auth') || get('Browser');
    if (!p || !p.open) return Promise.resolve(false);
    return p.open({ url: url }).then(function () { return true; })
      .catch(function (e) {
        toast((e && e.message) || 'Could not open the browser to sign in', 'warn');
        return false;
      });
  }

  /* iOS has no AuthPlugin: both inbound links arrive through the official
     @capacitor/app plugin's `appUrlOpen` event instead — the custom-scheme
     OAuth redirect (tech.odoreeci.convoy://auth?code=…&cvst=…) and the
     Universal Links Convoy emails (https://odoreeci.tech/l/<kind>?token=…).
     This parses them into the SAME event shapes AuthPlugin.java emits, so
     js/auth.js runs one handler for both platforms. Only used when no Auth
     plugin exists: on Android the App plugin would see the same intents and
     every redirect would be handled twice. The event is retained by the plugin
     until a listener attaches, which covers the cold-start case. */
  var AUTH_SCHEME = 'tech.odoreeci.convoy';
  var AUTH_HOST = 'auth';
  var LINK_PREFIX = '/l/';
  var LINK_KINDS = ['reset', 'verify', 'magic', 'change'];
  var urlOpenCbs = { redirect: null, link: null };
  var urlOpenWired = false;
  function appHosts() {
    var base = (A.config && A.config.base) || '';
    var m = /^https?:\/\/([^/]+)/.exec(base);
    if (!m) return [];
    var host = m[1].toLowerCase();
    return host.indexOf('www.') === 0 ? [host, host.slice(4)] : [host, 'www.' + host];
  }
  function parseAppUrl(raw) {
    var u;
    try { u = new URL(raw); } catch (e) { return null; }
    var q = u.searchParams;
    if (u.protocol === AUTH_SCHEME + ':' && (u.host || u.hostname || '').toLowerCase() === AUTH_HOST) {
      return { kind: 'redirect', data: {
        code: q.get('code') || '', state: q.get('cvst') || '',
        error: q.get('error') || '', errorDescription: q.get('error_description') || ''
      } };
    }
    // Mailed link. HOST CHECK, same as AuthPlugin.java: any app can hand this
    // one a URL, and a token from a hostile host must never select a code path.
    if (u.protocol === 'https:' && appHosts().indexOf(u.hostname.toLowerCase()) >= 0 &&
        u.pathname.indexOf(LINK_PREFIX) === 0) {
      var kind = u.pathname.slice(LINK_PREFIX.length).replace(/\/$/, '');
      var token = q.get('token') || '';
      if (LINK_KINDS.indexOf(kind) >= 0 && token) return { kind: 'link', data: { kind: kind, token: token } };
    }
    return null;
  }
  function wireAppUrlOpen() {
    if (urlOpenWired) return true;
    var app = get('App');
    if (!app || !app.addListener) return false;
    urlOpenWired = true;
    app.addListener('appUrlOpen', function (ev) {
      var parsed = parseAppUrl(ev && ev.url);
      if (!parsed) return;
      // The provider round-trip ran in SFSafariViewController; the app is back
      // in front now, so dismiss the sheet rather than leave it over the map.
      if (parsed.kind === 'redirect') {
        var b = get('Browser');
        if (b && b.close) b.close().catch(function () {});
      }
      var cb = urlOpenCbs[parsed.kind];
      if (cb) cb(parsed.data);
    });
    return true;
  }

  // Subscribe to the redirect coming back from the provider. Wired ONCE — the
  // plugin retains the event until a listener attaches, which is what covers the
  // cold-start case where Android killed the app behind the Custom Tab and the
  // deep link is what relaunched it.
  function onAuthRedirect(cb) {
    if (wired.auth) return false;
    var p = get('Auth');
    if (!p) {
      if (!wireAppUrlOpen()) return false;   // web build, or no App plugin either
      wired.auth = true;
      urlOpenCbs.redirect = function (r) { cb(r || {}); };
      return true;
    }
    wired.auth = true;
    p.addListener('redirect', function (r) { cb(r || {}); });
    return true;
  }

  // Subscribe to a MAILED link opened on this device — password reset, email
  // confirmation, sign-in link, email change. Android routes those to the app
  // as App Links; the payload is { kind, token }. Same retention reasoning as
  // above, and more relevant here: opening a link from a mail app usually
  // cold-starts Convoy.
  function onAuthLink(cb) {
    if (wired.authLink) return false;
    var p = get('Auth');
    if (!p) {
      if (!wireAppUrlOpen()) return false;
      wired.authLink = true;
      urlOpenCbs.link = function (r) { cb(r || {}); };
      return true;
    }
    wired.authLink = true;
    p.addListener('link', function (r) { cb(r || {}); });
    return true;
  }

  /* ---------------- lifecycle ---------------- */
  function init() {
    if (!isNative()) return; // web build: A.native exists but everything is a no-op
    startBackgroundLocation(); // keep position live in the background from boot
  }

  A.native = {
    init: init,
    isNative: isNative,
    startBackgroundLocation: startBackgroundLocation, stopBackgroundLocation: stopBackgroundLocation,
    openAuthUrl: openAuthUrl, onAuthRedirect: onAuthRedirect, onAuthLink: onAuthLink,
    ensureMic: ensureMic,
    platform: platform,
    parseAppUrl: parseAppUrl, // exposed for tests: the iOS deep-link parser
    state: function () { return { native: isNative(), platform: platform(), bg: bg }; }
  };
})();
