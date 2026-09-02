/* Convoy — native bridge (Capacitor Android plugins) with graceful web fallback.
   Wires the Android-only native plugins to the web app. On the web — or when a
   plugin is missing — EVERY method is a safe no-op, so the browser build behaves
   exactly as before. The plugins live in android/app/src/main/java/tech/odoreeci/convoy/.

     BackgroundLocation — foreground GPS service; 'fix' events keep the player
                          position live while the app is backgrounded / screen off.
                          Started on native boot, piped into A.sim.externalFix().
     RadarDetector      — hardware radar detector over BLE; 'alert' (band/strength)
                          + 'state' (connected) events. Started with Ghost Mode,
                          surfaced in the Ghost radar HUD via A.radar.setDetectorAlert().
     Sabre              — crowd police/hazard alerts relayed from an on-device SABRE
                          host app; 'crowd' events. Started with Ghost Mode.
     Voice              — RECORD_AUDIO permission ahead of getUserMedia().
     Auth               — social sign-in: opens the provider in a Custom Tab and
                          delivers the deep link back as a 'redirect' event, plus
                          'link' for the reset/verify/magic/change links Convoy
                          emails (App Links). Used by js/auth.js; on the web both
                          arrive in the URL instead and this is never touched.

   NOTE: the BLE frame parser is best-effort against the public esclib notes and the
   SABRE protocol is unverified — both need a real device + hardware/host to validate.
   The web fallback makes none of that matter for the browser build. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, ST = A.store;

  function isNative() { return !!(A.config && A.config.isNative); }
  function get(name) {
    var p = A.config && A.config.plugins ? A.config.plugins : null;
    return p && p[name] ? p[name] : null;
  }
  function toast(msg, kind) { if (A.ui && A.ui.toast) A.ui.toast(msg, kind || 'info'); }

  var bg = { running: false }, det = { scanning: false, connected: false, family: null }, sab = { listening: false };
  var wired = { bg: false, det: false, sab: false, auth: false, authLink: false }; // addListener only once per plugin

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

  /* ---------------- hardware radar detector (BLE) ---------------- */
  // Wire the plugin's push events exactly once (state + alert). Called by every
  // entry point (auto-scan, connect-by-id) so listeners exist before we connect.
  function wireDetector(p) {
    if (wired.det) return;
    wired.det = true;
    p.addListener('state', function (s) {
      det.connected = !!(s && s.connected);
      det.family = s && s.family || null;
      toast(det.connected ? ('Radar detector connected' + (det.family ? ' (' + det.family + ')' : ''))
        : 'Radar detector disconnected', det.connected ? 'success' : 'info');
      ST.emit('detector:state', { connected: det.connected, family: det.family });
      if (!det.connected && A.radar && A.radar.clearDetectorAlert) A.radar.clearDetectorAlert();
    });
    p.addListener('alert', function (a) {
      if (!a || !a.band) return;
      // Hand the FULL alert to the radar HUD, which classifies it (cop vs speed
      // reader), drives the sonar/board, and uploads high-confidence police
      // contacts to the shared map.
      if (A.radar && A.radar.onDetectorAlert) A.radar.onDetectorAlert(a);
      else if (A.radar && A.radar.setDetectorAlert) A.radar.setDetectorAlert(a.band, a.strength || 0);
    });
    // Streamed during listDevices() — surface into any open device picker.
    p.addListener('device', function (d) { if (d && d.id) ST.emit('detector:device', d); });
  }

  function startDetector() {
    var p = get('RadarDetector'); if (!p) return Promise.resolve(false);
    wireDetector(p);
    return p.startScan()
      .then(function (r) { det.scanning = !!(r && r.scanning); return det.scanning; })
      .catch(function (e) { toast('Radar detector: ' + ((e && e.message) || 'unavailable'), 'warn'); return false; });
  }
  function stopDetector() {
    var p = get('RadarDetector'); if (!p) return;
    p.stopScan().catch(function () {});
    det.scanning = false; det.connected = false;
    if (A.radar && A.radar.clearDetectorAlert) A.radar.clearDetectorAlert();
  }

  // Enumerate nearby BLE devices for the picker. Resolves to an array of
  // { id, name, rssi, compatible, brand, family, stream }; 'detector:device'
  // events also stream in live as they're discovered.
  function listDetectors() {
    var p = get('RadarDetector'); if (!p || !p.listDevices) return Promise.resolve([]);
    wireDetector(p);
    return p.listDevices()
      .then(function (r) { return (r && r.devices) || []; })
      .catch(function (e) { toast('Scan failed: ' + ((e && e.message) || 'unavailable'), 'warn'); return []; });
  }
  // Connect to a specific detector chosen in the picker. `family` (from the
  // same listDevices entry) keeps alert events shaped like the auto-connect
  // path's — without it the picker path emitted family-less alerts for the
  // same device the scan path reports with one.
  function connectDetector(id, family) {
    var p = get('RadarDetector'); if (!p || !p.connect) return Promise.resolve(false);
    wireDetector(p);
    return p.connect({ id: id, family: family || undefined })
      .then(function () { return true; })
      .catch(function (e) { toast('Connect failed: ' + ((e && e.message) || 'unavailable'), 'warn'); return false; });
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

  /* ---------------- SABRE crowd alerts ---------------- */
  function startSabre() {
    var p = get('Sabre'); if (!p) return Promise.resolve(false);
    if (!wired.sab) {
      wired.sab = true;
      p.addListener('crowd', function (c) {
        var payload = c && c.payload;
        ST.emit('native:crowd', payload);
        // Crowd reports carry a location → drop them onto the map's hazard layer if present.
        if (payload && A.overlays && A.overlays.addReportedHazard &&
            typeof payload.lat === 'number' && typeof payload.lng === 'number') {
          A.overlays.addReportedHazard(payload);
        } else if (payload && payload.label) {
          toast('Crowd alert: ' + payload.label, 'info');
        }
      });
    }
    return p.startListening()
      .then(function (r) { sab.listening = !!(r && r.listening); return sab.listening; })
      .catch(function () { return false; });
  }
  function stopSabre() {
    var p = get('Sabre'); if (!p) return;
    p.stopListening().catch(function () {}); sab.listening = false;
  }
  // Report a crowd alert (police/hazard) back out to any installed SABRE host.
  function publishCrowd(payload) {
    var p = get('Sabre'); if (!p) return false;
    try { p.publish({ payload: payload || {} }); return true; } catch (e) { return false; }
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
    var p = get('Auth');
    if (!p || !url) return Promise.resolve(false);
    return p.open({ url: url }).then(function () { return true; })
      .catch(function (e) {
        toast((e && e.message) || 'Could not open the browser to sign in', 'warn');
        return false;
      });
  }

  // Subscribe to the redirect coming back from the provider. Wired ONCE — the
  // plugin retains the event until a listener attaches, which is what covers the
  // cold-start case where Android killed the app behind the Custom Tab and the
  // deep link is what relaunched it.
  function onAuthRedirect(cb) {
    var p = get('Auth');
    if (!p || wired.auth) return false;
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
    var p = get('Auth');
    if (!p || wired.authLink) return false;
    wired.authLink = true;
    p.addListener('link', function (r) { cb(r || {}); });
    return true;
  }

  /* ---------------- lifecycle ---------------- */
  function init() {
    if (!isNative()) return; // web build: A.native exists but everything is a no-op
    startBackgroundLocation(); // keep position live in the background from boot
    // Radar detector + crowd alerts ride with Ghost Mode (the radar HUD).
    // Connect the remembered device if the user picked one, else auto-scan for
    // the first supported detector — both only when auto-connect is enabled.
    function detectorOn() {
      if (S.settings.detectorAuto === false) return;
      if (S.settings.detectorId) connectDetector(S.settings.detectorId);
      else startDetector();
    }
    ST.on('ghost', function (on) {
      if (on) { detectorOn(); startSabre(); }
      else { stopDetector(); stopSabre(); }
    });
    if (S.settings.ghost) { detectorOn(); startSabre(); }
  }

  A.native = {
    init: init,
    isNative: isNative,
    startBackgroundLocation: startBackgroundLocation, stopBackgroundLocation: stopBackgroundLocation,
    startDetector: startDetector, stopDetector: stopDetector,
    listDetectors: listDetectors, connectDetector: connectDetector,
    startSabre: startSabre, stopSabre: stopSabre, publishCrowd: publishCrowd,
    openAuthUrl: openAuthUrl, onAuthRedirect: onAuthRedirect, onAuthLink: onAuthLink,
    ensureMic: ensureMic,
    state: function () { return { native: isNative(), bg: bg, det: det, sab: sab }; }
  };
})();
