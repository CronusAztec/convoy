/* Convoy — enforcement pack: settings (first script in packs/enforcement/pack.json).

   Every setting the pack reads is registered here, before any other pack
   module runs, so A.store.setSetting() accepts the keys and a value the rider
   saved in an earlier session wins over the default (js/state.js
   registerSettings). The keys are the ones the pre-cut build used (js/state.js
   at a1de6fd) — a rider's old preferences carry straight over — plus the
   pack's own master switch.

   REGULATED ⇒ OFF BY DEFAULT. `radar` is the switch that paints enforcement
   markers and runs the HUD; `avoidPolice` reads the same enforcement data to
   steer routes. Both start off and both pass A.ui.legalGate('radar', …) on the
   way on (packs/enforcement/ui.js). The per-kind filters below only narrow
   what the radar shows once it is on, so their defaults stay as they were. */
(function () {
  'use strict';
  var A = window.App;
  var E = (A.enforcement = A.enforcement || {});

  A.store.registerSettings({
    // ---- the pack's own switches ----
    radar: false,         // enforcement layers + the radar HUD (legal-gated; regulated ⇒ off)
    radarGhost: false,    // also switch Invisible mode on/off with the radar (the old Ghost Mode pairing)
    avoidPolice: false,   // prefer route alternatives that skirt police stations + speed cameras (legal-gated)
    // ---- radar sonar (HUD audio) ----
    sonarVol: 0.8,        // master sonar volume 0..1
    sonarHeart: true,     // heartbeat on/off
    sonarPings: true,     // proximity pings on/off
    sonarStings: true,    // new-contact stings on/off
    sonarSpoken: true,    // voice callout ("Police ahead, 1.2 miles") on a new contact
    heartSense: 'normal', // heartbeat sensitivity: off | low | normal | aggressive
    pingRate: 'normal',   // ambient ping cadence: slow | normal | fast
    // ---- ground target filters (which radar targets are tracked/alerted) ----
    ghostPolice: true,    // stations, cameras-as-police, live sightings
    ghostCamera: true,    // speed / enforcement cameras
    ghostAlpr: true,      // ALPR / surveillance cameras (OSM man_made=surveillance)
    ghostHotspots: true,  // police probability "usually here" layer
    // ---- aircraft shape filters (airplane vs helicopter, board only) ----
    ghostAir: true,
    ghostHeli: true,
    // ---- aircraft ownership filters (map dot AND radar board) ----
    ghostAirCiv: true,      // civilian aircraft
    ghostAirMil: true,      // military
    ghostAirPolice: true,   // law-enforcement (police planes + rotor units)
    ghostAirEms: true,      // EMS / medevac / air-ambulance
    // Contacts the classifier will not guess at: no callsign, or a tactical one
    // that is neither an airline flight number nor a registration. Kept ON by
    // default — an unidentified aircraft overhead is the interesting case.
    ghostAirUnknown: true
  });

  // Server capabilities for this pack (POST /api/enforcement/caps), filled by
  // boot.js once the pack is held. Read by ghost.js to decide whether the live
  // Waze layer and the hotspot layer have anything behind them.
  E.caps = E.caps || null;
})();
