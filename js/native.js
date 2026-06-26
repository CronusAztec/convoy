/* Convoy — native bridge (Capacitor Android plugins) with graceful web fallback.
   Wires three Android-only native plugins to the web app. On the web — or when a
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

  var bg = { running: false }, det = { scanning: false, connected: false }, sab = { listening: false };
  var wired = { bg: false, det: false, sab: false }; // addListener only once per plugin

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
  function startDetector() {
    var p = get('RadarDetector'); if (!p) return Promise.resolve(false);
    if (!wired.det) {
      wired.det = true;
      p.addListener('state', function (s) {
        det.connected = !!(s && s.connected);
        toast(det.connected ? 'Radar detector connected' : 'Radar detector disconnected',
          det.connected ? 'success' : 'info');
        if (!det.connected && A.radar && A.radar.clearDetectorAlert) A.radar.clearDetectorAlert();
      });
      p.addListener('alert', function (a) {
        if (!a || !a.band) return;
        if (A.radar && A.radar.setDetectorAlert) A.radar.setDetectorAlert(a.band, a.strength || 0);
      });
    }
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

  /* ---------------- lifecycle ---------------- */
  function init() {
    if (!isNative()) return; // web build: A.native exists but everything is a no-op
    startBackgroundLocation(); // keep position live in the background from boot
    // Radar detector + crowd alerts ride with Ghost Mode (the radar HUD).
    ST.on('ghost', function (on) {
      if (on) { startDetector(); startSabre(); }
      else { stopDetector(); stopSabre(); }
    });
    if (S.settings.ghost) { startDetector(); startSabre(); }
  }

  A.native = {
    init: init,
    isNative: isNative,
    startBackgroundLocation: startBackgroundLocation, stopBackgroundLocation: stopBackgroundLocation,
    startDetector: startDetector, stopDetector: stopDetector,
    startSabre: startSabre, stopSabre: stopSabre, publishCrowd: publishCrowd,
    state: function () { return { native: isNative(), bg: bg, det: det, sab: sab }; }
  };
})();
