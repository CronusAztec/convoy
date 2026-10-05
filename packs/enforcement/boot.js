/* Convoy — enforcement pack: boot (last script in packs/enforcement/pack.json).

   Registers the pack with the loader and, once the whole pack has loaded,
   applies what the settings say: the `radar` switch starts the data loops
   (ghost.js), the map layers (maplayers.js) and the HUD (radar.js) — and
   stops them again. Everything hangs off two bus events:

     'enforcement:radar'  the setting changed (ui.js doSetRadar)
     'packs'              what the account holds changed (sign-out, a revoke,
                          a kill switch on the next sync) — the pack stands
                          its UI down the moment A.packs.has('enforcement')
                          turns false, and comes back when it turns true

   Loaded code cannot be unloaded in-page, so "standing down" means: every
   poller stopped, every layer emptied and hidden, the HUD off, the two map
   controls hidden. The server stops serving the pack's data at the same
   moment, so nothing would come back even if a loop kept asking. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, ST = A.store, U = A.util;
  var E = (A.enforcement = A.enforcement || {});

  var CAPS = '/api/enforcement/caps';
  var applied = null;   // what apply() last did, so a repeated event is a no-op
  var inited = false;

  function held() { return !!(A.packs && A.packs.has && A.packs.has('enforcement')); }

  function apply() {
    var on = held() && !!S.settings.radar;
    if (E.ui && E.ui.syncControls) E.ui.syncControls();
    if (on === applied) return;
    applied = on;
    try {
      if (E.map) { E.map.setGhostLayersVisible(on); E.map.setRingsVisible(on); }
      if (on) {
        if (E.ghost) E.ghost.start();
        if (E.radar) E.radar.setActive(true);
      } else {
        if (E.radar) E.radar.setActive(false);
        if (E.ghost) E.ghost.stop();
      }
    } catch (e) {
      console.error('[enforcement] apply', e);
      if (A.telemetry) A.telemetry.capture(e, 'packs.enforcement.apply');
    }
  }

  // What the server can serve this pack: whether a live-police feed exists
  // (a Waze key or the collector) and whether hotspots are enabled. Read once
  // per grant; ghost.js re-arms its loops on the 'enforcement:caps' event.
  var DEFAULT_CAPS = { waze: false, hotspots: false, aircraft: true, overpass: true };
  function probeCaps() {
    if (!held() || !E.api) return Promise.resolve(E.caps);
    return E.api(CAPS, {}).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      E.caps = j && typeof j === 'object'
        ? { waze: !!j.waze, hotspots: !!j.hotspots, aircraft: j.aircraft !== false, overpass: j.overpass !== false }
        : Object.assign({}, DEFAULT_CAPS);
      ST.emit('enforcement:caps', E.caps);
      return E.caps;
    }).catch(function () {
      // A failed probe leaves the keyless layers (aircraft, OSM) working and
      // the keyed ones off until the next grant event retries it.
      E.caps = E.caps || Object.assign({}, DEFAULT_CAPS);
      ST.emit('enforcement:caps', E.caps);
      return E.caps;
    });
  }

  function init() {
    if (inited) return;
    inited = true;
    // A persisted "on" is only honoured when the legality notice was
    // acknowledged under the CURRENT Terms (js/state.js featureAcked). Otherwise
    // the radar starts off and the rider re-enables it — and reads the notice.
    if (S.settings.radar && !(ST.featureAcked && ST.featureAcked('radar'))) ST.setSetting('radar', false);
    ST.on('enforcement:radar', apply);
    ST.on('packs', function () { apply(); if (held()) probeCaps(); });
    // Belt and braces for the bus: A.store.emit walks the live subscriber
    // array, and the core's Feature-packs section subscribes to 'packs' with
    // a listener that unsubscribes ITSELF mid-emit once its settings host is
    // detached — which shifts the array and skips the subscriber after it.
    // When that subscriber is this one, a sign-out would leave the HUD up
    // until the next event. A visual-only poll that only acts when the
    // applied state and the truth disagree closes that gap within 2 s.
    U.poll(function () {
      if (applied !== null && applied !== (held() && !!S.settings.radar)) apply();
    }, 2000);
    probeCaps().then(apply, apply);
    apply();
  }

  A.packs.register('enforcement', { init: init });
  E.init = init;
  // test surface
  E._applied = function () { return applied; };
  E._probeCaps = probeCaps;
})();
