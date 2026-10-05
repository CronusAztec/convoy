/* Convoy — enforcement pack: the legality notice, the settings sections, the
   radar on/off funnel and the two map controls (the hunks the 2026-10-04 cut
   took out of js/ui.js: FEATURE_NOTICES.radar, applyGhost's radar half, the
   "Radar audio" / "Police & cameras" / "Aircraft" / "Routing" sections,
   #ctl-ghost and #ctl-loop).

   Ghost mode used to be one switch doing two things: go invisible AND run the
   radar. Invisible mode stayed in the core (A.ui.applyGhost); the radar is
   this pack's own `radar` setting. "Go invisible with the radar" (radarGhost)
   restores the old pairing for anyone who wants it, by calling the core's
   applyGhost alongside the radar switch.

   Turning the radar ON is the moment enforcement markers appear, so the
   legality notice (A.ui.legalGate) sits here, in the one funnel every entry
   point passes through — the settings toggle, the map control, a persisted
   state at boot. Turning it OFF is never gated. The route-avoidance toggle
   and the cruise loop read the same enforcement data and pass the same gate. */
(function () {
  'use strict';
  var A = window.App;
  var S = A.state, U = A.util, ST = A.store;
  var E = (A.enforcement = A.enforcement || {});

  // The notice, as the pre-cut build worded it (js/ui.js FEATURE_NOTICES.radar).
  // Only the feature's name changed in the lede: "Ghost Mode" is now "Radar".
  A.ui.registerFeatureNotice('radar', {
    title: 'Before you turn on radar',
    lede: 'Radar shows police stations, speed and ALPR cameras, and enforcement ' +
      'hotspots from public data.',
    points: [
      'Warning a <b>driver</b> about speed cameras or police is restricted or illegal in ' +
        'several countries, including Germany, France, Switzerland and Austria. Know the ' +
        'rule where you are.',
      'A marker doesn\'t mean anyone is there, and an empty map doesn\'t mean nobody is. ' +
        'This data is incomplete and often out of date.',
      'Never use it to evade or interfere with law enforcement.'
    ]
  });

  // Drive a kit.toggle from outside. mkToggle flips itself on click, so when
  // the change is refused after the fact (a declined notice) the only way back
  // to the truth is to set it explicitly.
  function setToggle(btn, on) {
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /* ---------------- the radar funnel ---------------- */
  // `onCancel` matters for callers that own their own visual state: the map
  // control and the HUD redraw from S.settings.radar on the 'enforcement:radar'
  // event, so a declined gate leaves them correct by doing nothing. A settings
  // toggle does NOT — it flips its own class on click — so it passes a revert.
  function setRadar(on, onCancel) {
    if (on) { A.ui.legalGate('radar', function () { doSetRadar(true); }, onCancel); return; }
    doSetRadar(false);
  }
  function doSetRadar(on) {
    on = !!on;
    var was = !!S.settings.radar;
    ST.setSetting('radar', on, 'enforcement:radar');   // persists + emits → boot.js applies
    // The old Ghost Mode pairing, opt-in: invisible to other riders while the
    // radar runs, visible again when it stops.
    if (S.settings.radarGhost && A.ui.applyGhost) {
      if (on && !S.settings.ghost) A.ui.applyGhost(true);
      else if (!on && was && S.settings.ghost) A.ui.applyGhost(false);
    }
    if (on !== was) A.ui.toast(on ? 'Radar on · enforcement layers active' : 'Radar off', 'info');
  }

  /* ---------------- the two map controls ---------------- */
  function syncControls() {
    var held = !!(A.packs && A.packs.has && A.packs.has('enforcement'));
    var radarBtn = document.getElementById('ctl-radar');
    var loopBtn = document.getElementById('ctl-loop');
    if (radarBtn) {
      radarBtn.hidden = !held;
      var on = held && !!S.settings.radar;
      radarBtn.classList.toggle('active', on);
      radarBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (loopBtn) loopBtn.hidden = !held;
  }
  A.ui.addHook('init', function () {
    var radarBtn = document.getElementById('ctl-radar');
    if (radarBtn) radarBtn.addEventListener('click', function () { setRadar(!S.settings.radar); });
    var loopBtn = document.getElementById('ctl-loop');
    if (loopBtn) loopBtn.addEventListener('click', function () {
      // Same gate as the radar: the loop is scored on police and camera positions.
      A.ui.legalGate('radar', function () { if (E.routing && E.routing.promptLoop) E.routing.promptLoop(); });
    });
    syncControls();
  });

  /* ---------------- settings ---------------- */
  function buildAircraftSettings(body, kit) {
    var MV = E.map || {};
    var owners = MV.AIRCRAFT_OWNERS || ['military', 'police', 'ems', 'unknown', 'civilian'];
    var colors = MV.AIRCRAFT_COLORS || {};
    var labels = MV.AIRCRAFT_LABELS || {};
    var KEYS = {
      military: 'ghostAirMil',
      police: 'ghostAirPolice',
      ems: 'ghostAirEms',
      unknown: 'ghostAirUnknown',
      civilian: 'ghostAirCiv'
    };
    var SUBS = {
      military: 'Transports, tankers, tactical callsigns',
      police: 'Law-enforcement aircraft and rotor units',
      ems: 'Air ambulances and rescue helicopters',
      unknown: 'No callsign, or one we will not guess at',
      civilian: 'Airliners and private aircraft'
    };

    body.appendChild(U.el('div', 'section-label', 'Aircraft'));

    owners.forEach(function (o) {
      // A coloured dot in the row title is the legend — the same colour the map
      // draws — so there is no separate key to cross-reference while driving.
      var title = U.el('span', 'air-cat');
      var dot = U.el('span', 'air-dot');
      dot.style.color = colors[o] || '#e8edf6';
      title.appendChild(dot);
      title.appendChild(document.createTextNode(labels[o] || o));

      var row = kit.row(labels[o] || o, SUBS[o], kit.toggle(
        S.settings[KEYS[o]] !== false,
        function (v) {
          ST.setSetting(KEYS[o], v);
          if (MV.setAircraftFilter) MV.setAircraftFilter();
        }));
      // Swap the plain bold title for the dotted one.
      var b = row.querySelector('b');
      if (b) { b.textContent = ''; b.appendChild(title); }
      body.appendChild(row);
    });

    body.appendChild(U.el('div', 'hint-card',
      '<b>Unidentified</b> is a real answer, not a bug. Live ADS-B carries no ownership ' +
      'field, so a contact is placed by its callsign — and one that is neither an ' +
      'airline flight number nor a registration is left unidentified rather than ' +
      'quietly filed as civilian. Aircraft show only while the <b>radar</b> is on.'));

    // Shape filter — genuinely separate from ownership, and only the board uses it.
    body.appendChild(kit.row('Rank airplanes on the radar', 'Fixed-wing contacts on the threat board',
      kit.toggle(S.settings.ghostAir !== false, function (v) { ST.setSetting('ghostAir', v); })));
    body.appendChild(kit.row('Rank helicopters on the radar', 'Rotor contacts on the threat board',
      kit.toggle(S.settings.ghostHeli !== false, function (v) { ST.setSetting('ghostHeli', v); })));
  }

  A.ui.addHook('settings', function (body, kit) {
    /* ---- the pack's own switches ---- */
    body.appendChild(U.el('div', 'section-label', 'Enforcement awareness'));
    var radarToggle = kit.toggle(!!S.settings.radar, function (v) {
      // Revert the switch if the legality notice is declined — see setRadar.
      setRadar(v, function () { setToggle(radarToggle, !!S.settings.radar); });
    });
    body.appendChild(kit.row('Radar',
      'Aircraft, police stations, cameras and hotspots on the map, with the radar HUD and sonar', radarToggle));
    body.appendChild(kit.row('Go invisible with the radar',
      'Switch Invisible mode on and off together with the radar',
      kit.toggle(!!S.settings.radarGhost, function (v) { ST.setSetting('radarGhost', v); })));
    body.appendChild(U.el('div', 'hint-card',
      'Where you are decides whether warning a driver about police or cameras is legal. ' +
      'The notice shows once, when the radar first switches on; the full detail is in Terms §5.'));

    /* ---- Routing ---- */
    body.appendChild(U.el('div', 'section-label', 'Routing'));
    var avoidToggle = kit.toggle(!!S.settings.avoidPolice, function (v) {
      if (!v) { ST.setSetting('avoidPolice', false); return; }
      A.ui.legalGate('radar', function () { ST.setSetting('avoidPolice', true); },
        function () { setToggle(avoidToggle, false); });
    });
    body.appendChild(kit.row('Avoid police & cameras',
      'Pick a detour around police stations and speed cameras when one exists', avoidToggle));

    /* ---- Radar audio ---- */
    body.appendChild(U.el('div', 'section-label', 'Radar audio'));
    var volSlider = U.el('input', 'input');
    volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05';
    volSlider.value = S.settings.sonarVol != null ? S.settings.sonarVol : 0.8;
    volSlider.style.width = '100%';
    volSlider.addEventListener('input', function () { ST.setSetting('sonarVol', parseFloat(volSlider.value)); });
    body.appendChild(kit.field('Sonar volume', volSlider));
    body.appendChild(kit.row('Heartbeat', 'Risk-driven pulse when threats are near',
      kit.toggle(S.settings.sonarHeart !== false, function (v) { ST.setSetting('sonarHeart', v); })));
    body.appendChild(kit.field('Heartbeat sensitivity', kit.segmented([
      { label: 'Off', value: 'off' },
      { label: 'Low', value: 'low' },
      { label: 'Normal', value: 'normal' },
      { label: 'Aggressive', value: 'aggressive' }
    ], S.settings.heartSense, function (v) { ST.setSetting('heartSense', v); })));
    body.appendChild(kit.row('Proximity pings', 'Spatial ticks while the board is quiet',
      kit.toggle(S.settings.sonarPings !== false, function (v) { ST.setSetting('sonarPings', v); })));
    body.appendChild(kit.field('Ping rate', kit.segmented([
      { label: 'Slow', value: 'slow' },
      { label: 'Normal', value: 'normal' },
      { label: 'Fast', value: 'fast' }
    ], S.settings.pingRate, function (v) { ST.setSetting('pingRate', v); })));
    body.appendChild(kit.row('Contact stings', 'Alert when a new threat becomes closest',
      kit.toggle(S.settings.sonarStings !== false, function (v) { ST.setSetting('sonarStings', v); })));
    body.appendChild(kit.row('Spoken alerts', 'Voice callout: "Police ahead, 1.2 miles"',
      kit.toggle(S.settings.sonarSpoken !== false, function (v) { ST.setSetting('sonarSpoken', v); })));

    /* ---- Ground targets ---- */
    body.appendChild(U.el('div', 'section-label', 'Police & cameras'));
    body.appendChild(kit.row('Police on map', 'Stations, live sightings and rider reports while the radar is on',
      kit.toggle(S.settings.ghostPolice !== false, function (v) { ST.setSetting('ghostPolice', v, 'ghostpolice'); })));
    body.appendChild(kit.row('Speed cameras', 'Fixed enforcement cameras as their own pins',
      kit.toggle(S.settings.ghostCamera !== false, function (v) { ST.setSetting('ghostCamera', v); })));
    body.appendChild(kit.row('ALPR cameras', 'Licence-plate readers and surveillance cameras',
      kit.toggle(S.settings.ghostAlpr !== false, function (v) { ST.setSetting('ghostAlpr', v); })));
    body.appendChild(kit.row('Police hotspots', 'Heatmap of where police are usually seen at this hour',
      kit.toggle(S.settings.ghostHotspots !== false, function (v) { ST.setSetting('ghostHotspots', v, 'ghosthotspots'); })));

    /* ---- Aircraft ---- */
    buildAircraftSettings(body, kit);
  });

  E.ui = {
    setRadar: setRadar,
    syncControls: syncControls,
    // test surface
    _setToggle: setToggle
  };
})();
