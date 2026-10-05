/* Convoy — enforcement pack: map sources, layers, popups and tap handling.

   The hunks this restores lived in js/mapview.js before the 2026-10-04 cut:
   the aircraft / aircraft-trail / police / hotspots / rings sources, their
   layers, the AIRCRAFT_OWNERS paint table and filter, the five setters the
   data modules call (setAircraftData, setAircraftTrailData, setPoliceData,
   setHotspotData, setRingsData), the three popups, and the tap handling that
   put an enforcement pin ahead of tap-to-route.

   The core is not edited. Layers are stacked through A.mapview.onStyle(fn),
   which runs after the core's own layers on every style.load (and at once if
   the style is already up, so a pack that lands mid-session sees the same
   sequence); taps come through A.mapview.onClick(fn) — return true to consume
   one. Everything the other pack modules need is exported on
   A.enforcement.map, never on A.mapview. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store;
  var E = (A.enforcement = A.enforcement || {});

  /* The five aircraft ownership categories and their paint. One table, read by
     the layer paint, the popup and the settings legend, so a colour can never
     disagree with itself across three files. Order is the legend order: most
     notable first, routine traffic last. */
  var AIRCRAFT_OWNERS = ['military', 'police', 'ems', 'unknown', 'civilian'];
  var AIRCRAFT_COLORS = {
    military: '#ff3b3b',
    police: '#3b82f6',
    ems: '#22c55e',
    unknown: '#f59e0b',
    civilian: '#e8edf6'
  };
  var AIRCRAFT_LABELS = {
    military: 'Military',
    police: 'Law enforcement',
    ems: 'EMS / medevac',
    unknown: 'Unidentified',
    civilian: 'Civilian'
  };
  // '#rrggbb' + alpha -> 'rgba(r,g,b,a)'. line-gradient stops need real colour
  // values; there is no opacity channel to lean on the way line-opacity gave us.
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* The map's aircraft category filter, read from the SAME settings the radar
     board uses (ghostAirMil / -Police / -Ems / -Civ / -Unknown). One switch,
     one meaning: it governs both the map dot and the board. */
  var OWNER_SETTING = {
    military: 'ghostAirMil',
    police: 'ghostAirPolice',
    ems: 'ghostAirEms',
    civilian: 'ghostAirCiv',
    unknown: 'ghostAirUnknown'
  };

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // Layer data survives style switches via this cache (setStyle wipes sources).
  var cache = {
    aircraft: emptyFC(),
    aircraftTrail: emptyFC(),   // fading motion trails for aircraft
    police: emptyFC(),
    hotspots: emptyFC(),        // police probability hotspots
    rings: emptyFC()            // radar range circles
  };
  var layersOn = false;         // what setGhostLayersVisible() last said; re-applied on every style

  function map() { return A.mapview && A.mapview.map ? A.mapview.map() : null; }
  function radarOn() { return !!(S.settings && S.settings.radar); }

  function addSrc(m, id, data, extra) {
    if (m.getSource(id)) return;
    var def = { type: 'geojson', data: data };
    if (extra) Object.assign(def, extra);
    m.addSource(id, def);
  }
  // `before` puts the layer UNDER an existing one. MapLibre draws in insertion
  // order, so without it a layer added later is always on top no matter what a
  // comment claims about intent.
  function addLayer(m, def, before) {
    if (m.getLayer(def.id)) return;
    if (before && m.getLayer(before)) m.addLayer(def, before);
    else m.addLayer(def);
  }
  function setData(id, fc) {
    var m = map();
    var src = m && m.getSource(id);
    if (src) src.setData(fc);
  }

  /* ---------------- layers ----------------
     Runs on every style.load, after the core's own layers. Order within the
     pack: rings first (under everything), then hotspots, police, aircraft
     trails, aircraft points — so a hard pin always draws over a soft halo and
     a dot over its own tail. */
  function ensureLayers(m) {
    addSrc(m, 'rings', cache.rings);
    addSrc(m, 'hotspots', cache.hotspots);
    addSrc(m, 'police', cache.police);
    addSrc(m, 'aircraft', cache.aircraft);
    // `lineMetrics` is what makes ['line-progress'] available, and that is what
    // turns the trail fade into a real gradient instead of a staircase.
    addSrc(m, 'aircraft-trail', cache.aircraftTrail, { lineMetrics: true });

    // ----- RADAR RINGS: concentric range circles around the player -----
    addLayer(m, {
      id: 'radar-rings-glow', type: 'line', source: 'rings',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-blur': 7, 'line-opacity': 0.3 }
    });
    addLayer(m, {
      id: 'radar-rings', type: 'line', source: 'rings',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['coalesce', ['get', 'width'], 1.6],
        'line-opacity': ['coalesce', ['get', 'opacity'], 0.85]
      }
    });

    // Probability hotspots, drawn as two stacked layers so the area reads clearly
    // AND the exact spot is unambiguous: a coloured halo whose radius grows with
    // probability, then a small solid dot with a white ring at the cell centre.
    addLayer(m, {
      id: 'police-hotspots', type: 'circle', source: 'hotspots',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'prob'], 0, 12, 0.5, 22, 1, 36],
        'circle-color': ['interpolate', ['linear'], ['get', 'prob'],
          0, '#22c55e', 0.5, '#f59e0b', 1, '#ef4444'],
        'circle-opacity': ['interpolate', ['linear'], ['get', 'prob'], 0, 0.28, 1, 0.42],
        'circle-blur': 0.9
      }
    });
    addLayer(m, {
      id: 'police-hotspots-core', type: 'circle', source: 'hotspots',
      paint: {
        'circle-radius': 4.5,
        'circle-color': ['interpolate', ['linear'], ['get', 'prob'],
          0, '#16a34a', 0.5, '#d97706', 1, '#dc2626'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 1,
        'circle-stroke-opacity': 1
      }
    });

    // Ground enforcement: camera=amber, alpr=red, station=slate (static
    // building), police=bright blue (LIVE sighting, default).
    addLayer(m, {
      id: 'police-points', type: 'circle', source: 'police',
      paint: {
        'circle-color': ['match', ['get', 'kind'], 'camera', '#ffcf2e', 'alpr', '#ff3b3b', 'station', '#64748b', '#3b82f6'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-radius': 5.5,
        'circle-opacity': 0.95
      }
    });

    // Aircraft colour is ownership, five ways: military=red · police=blue ·
    // ems=green · civilian=silver · unknown=amber. The classified categories are
    // drawn larger and more solid than routine civilian traffic.
    addLayer(m, {
      id: 'aircraft-points', type: 'circle', source: 'aircraft',
      paint: {
        'circle-color': ['match', ['get', 'owner'],
          'military', AIRCRAFT_COLORS.military,
          'police', AIRCRAFT_COLORS.police,
          'ems', AIRCRAFT_COLORS.ems,
          'unknown', AIRCRAFT_COLORS.unknown,
          AIRCRAFT_COLORS.civilian],
        'circle-stroke-color': ['match', ['get', 'owner'],
          'civilian', 'rgba(255,255,255,.65)',
          '#ffffff'],
        'circle-stroke-width': ['match', ['get', 'owner'],
          'civilian', 1,
          1.6],
        'circle-radius': ['match', ['get', 'owner'],
          'civilian', 5,
          'unknown', 6.5,
          7],
        'circle-opacity': ['match', ['get', 'owner'],
          'civilian', 0.72,
          0.95],
        'circle-blur': 0.25
      }
    });
    /* Each trail is ONE LineString faded with line-gradient. It cannot read a
       feature property, so ownership colour comes from one thin layer per
       category — five layers, each drawing a handful of lines, under the dots. */
    AIRCRAFT_OWNERS.forEach(function (owner) {
      var c = AIRCRAFT_COLORS[owner];
      addLayer(m, {
        id: 'aircraft-trail-' + owner,
        type: 'line',
        source: 'aircraft-trail',
        filter: ['==', ['get', 'owner'], owner],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 12, 2.6, 16, 3.4],
          'line-blur': 0.6,
          'line-gradient': ['interpolate', ['linear'], ['line-progress'],
            0, rgba(c, 0),
            0.35, rgba(c, 0.16),
            0.7, rgba(c, 0.45),
            1, rgba(c, 0.85)]
        }
      }, 'aircraft-points');   // under the dots
    });
    // Apply the saved category filter the moment the layer exists, and the
    // current visibility — a style switch mid-radar must not blank the HUD.
    setAircraftFilter();
    setGhostLayersVisible(layersOn || radarOn());
    setRingsVisible(layersOn || radarOn());
  }

  function enabledOwners() {
    return AIRCRAFT_OWNERS.filter(function (o) { return S.settings[OWNER_SETTING[o]] !== false; });
  }
  function setAircraftFilter() {
    var m = map();
    if (!m || !m.getLayer || !m.getLayer('aircraft-points')) return;
    var list = enabledOwners();
    var all = list.length === AIRCRAFT_OWNERS.length;
    m.setFilter('aircraft-points', all ? null : ['in', ['get', 'owner'], ['literal', list]]);
    // Trails carry `owner` and live in one layer per category, so a hidden
    // category takes its own tail with it.
    AIRCRAFT_OWNERS.forEach(function (o) {
      var id = 'aircraft-trail-' + o;
      if (!m.getLayer(id)) return;
      var show = layersOn && list.indexOf(o) >= 0;
      m.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    });
  }

  function setAircraftData(fc) { cache.aircraft = fc || emptyFC(); setData('aircraft', cache.aircraft); }
  function setAircraftTrailData(fc) { cache.aircraftTrail = fc || emptyFC(); setData('aircraft-trail', cache.aircraftTrail); }
  function setPoliceData(fc) { cache.police = fc || emptyFC(); setData('police', cache.police); }
  function setHotspotData(fc) { cache.hotspots = fc || emptyFC(); setData('hotspots', cache.hotspots); }
  // Every enforcement layer shows or hides together: the whole set is gated on
  // the pack's `radar` setting now (police and hotspots used to be always-on).
  function setGhostLayersVisible(on) {
    layersOn = !!on;
    var m = map();
    if (!m || !m.getLayer) return;
    var ids = ['aircraft-points', 'police-points', 'police-hotspots', 'police-hotspots-core'];
    AIRCRAFT_OWNERS.forEach(function (o) { ids.push('aircraft-trail-' + o); });
    ids.forEach(function (id) {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
    // Re-apply the per-category filter so an owner the rider switched off does
    // not come back visible just because the radar was toggled.
    if (on) setAircraftFilter();
  }
  // The radar HUD reads the current layers to build its alert list.
  function getGhostData() { return { aircraft: cache.aircraft, police: cache.police }; }
  function setRingsData(fc) { cache.rings = fc || emptyFC(); setData('rings', cache.rings); }
  function setRingsVisible(on) {
    var m = map();
    if (!m || !m.getLayer) return;
    ['radar-rings', 'radar-rings-glow'].forEach(function (id) {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }

  /* ---------------- popups ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function relAgo(ts) {
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function showAircraftPopup(props, lngLat) {
    var card = U.el('div', 'pop-card');
    var altStr = props.alt != null
      ? (S.settings.units === 'km' ? Math.round(props.alt) + ' m' : Math.round(props.alt * 3.28084) + ' ft')
      : '—';
    var spdStr = props.speed != null
      ? (S.settings.units === 'km' ? Math.round(props.speed * 3.6) + ' km/h' : Math.round(props.speed * 2.23694) + ' mph')
      : '—';
    // Ownership drives the avatar colour + a headline tag so it is the first
    // thing you read. Each of the five categories gets a distinct paint.
    var ownColor = AIRCRAFT_COLORS[props.owner] || AIRCRAFT_COLORS.civilian;
    var ownName = props.ownerName || 'Unidentified';
    var climb = props.vertRate != null && Math.abs(props.vertRate) > 0.5
      ? (props.vertRate > 0 ? 'Climbing' : 'Descending') : '';
    // An unidentified contact is exactly the case where the rider wants the raw
    // data, so show what we DO have — hex, squawk — instead of a blank card.
    var sub = props.country
      || (props.icao ? 'ICAO ' + String(props.icao).toUpperCase() : '')
      || 'Unknown origin';
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + ownColor + '">' + U.riderIcon(0, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.callsign || '—') + '</div>' +
      '  <div class="u-handle">' + U.esc(sub) + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' +
      '<span class="tag tag-live"><span class="dot dot-live" style="background:' + ownColor + '"></span>' + U.esc(ownName) + '</span>' +
      (props.ground ? '<span class="tag">On ground</span>' : '<span class="tag">Airborne</span>') +
      (climb ? '<span class="tag">' + climb + '</span>' : '') +
      '<span class="tag">Altitude ' + altStr + '</span>' +
      '<span class="tag">Speed ' + spdStr + '</span>' +
      (props.heading != null ? '<span class="tag">HDG ' + Math.round(props.heading) + '°</span>' : '') +
      (props.squawk ? '<span class="tag">Squawk ' + U.esc(props.squawk) + '</span>' : '') +
      (props.icao ? '<span class="tag">ICAO ' + U.esc(String(props.icao).toUpperCase()) + '</span>' : '') +
      '<span class="tag tag-delayed"><span class="dot dot-global"></span>Live · OpenSky</span>' +
      '</div>';
    A.mapview.openPopup(lngLat, card);
  }

  function showPolicePopup(props, lngLat) {
    var kind = props.kind;
    // kinds: 'camera' (speed cam), 'alpr' (surveillance), 'station' (OSM police
    // building), 'police' (LIVE sighting from Waze / a rider / the collector —
    // the only kind that feeds hotspots). Each gets its own colour, label,
    // icon and source credit.
    var meta = kind === 'alpr' ? { color: '#ff3b3b', sub: 'ALPR / surveillance camera', icon: 4, src: 'OpenStreetMap' }
      : kind === 'camera' ? { color: '#ffcf2e', sub: 'Speed / enforcement camera', icon: 7, src: 'OpenStreetMap' }
      : kind === 'station' ? { color: '#64748b', sub: 'Police station', icon: 1, src: 'OpenStreetMap' }
      : { color: '#3b82f6', sub: 'Live police sighting', icon: 1,
          src: props.waze ? 'Waze' : props.agent ? 'Live data feed' : props.reported ? 'You reported this' : 'Rider report' };
    var name = props.name || props.label || (kind === 'station' ? 'Police station' : 'Police');
    var card = U.el('div', 'pop-card');
    var when = props.when ? new Date(props.when) : null;
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + meta.color + '">' + U.riderIcon(meta.icon, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(name) + '</div>' +
      '  <div class="u-handle">' + meta.sub + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' +
      (when && !isNaN(when) ? '<span class="tag tag-delayed">' + relAgo(when.getTime()) + '</span>' : '') +
      '<span class="tag tag-delayed"><span class="dot dot-global"></span>' + U.esc(meta.src) + '</span></div>';
    A.mapview.openPopup(lngLat, card);
  }

  // A probability hotspot pin. Shows the likelihood + how many sightings back it,
  // and roughly when it was last seen. Probabilities are derived from real
  // accumulated sightings (server/packs/enforcement/hotspots.js).
  function showHotspotPopup(props, lngLat) {
    var prob = Math.round((props.prob || 0) * 100);
    var count = props.count || 0;
    var hour = props.hour != null ? props.hour : -1;
    var ago = props.latest ? 'last seen ' + relAgo(props.latest) : '';
    var color = prob >= 67 ? '#ef4444' : (prob >= 34 ? '#f59e0b' : '#22c55e');
    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + color + '">' + U.riderIcon(6, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">Police hotspot</div>' +
      '  <div class="u-handle">~' + prob + '% likely here' +
           (props.allHours ? ' · seen at various hours' : (hour >= 0 ? ' · ' + pad2(hour) + ':00' : '')) + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' +
        '<span class="tag"><span class="dot" style="background:' + color + '"></span>Based on ' + count + ' sighting' + (count === 1 ? '' : 's') + '</span>' +
        (ago ? '<span class="tag tag-delayed">' + ago + '</span>' : '') +
      '</div>';
    A.mapview.openPopup(lngLat, card);
  }

  /* ---------------- taps ----------------
     Runs before the core's own click handling (after its global-driver
     layers). Enforcement pins win over tap-to-route; the crisp hotspot core
     dot is listed first so a tap on the exact spot always wins. */
  function onClick(e, m) {
    if (!layersOn) return false;
    var gLayers = ['aircraft-points', 'police-points', 'police-hotspots-core', 'police-hotspots']
      .filter(function (id) { return m.getLayer(id); });
    if (!gLayers.length) return false;
    var gf = m.queryRenderedFeatures(e.point, { layers: gLayers });
    var hit = null;
    for (var gi = 0; gi < gf.length; gi++) {
      var cand = gf[gi];
      if (cand.layer && cand.layer.id === 'police-hotspots') {
        // The halo is a big soft circle (up to ~36px radius) that can blanket whole
        // blocks — only claim the tap near its centre, otherwise fall through so
        // tap-to-route still works inside hotspot areas.
        var cpt = m.project(cand.geometry.coordinates.slice());
        var hdx = cpt.x - e.point.x, hdy = cpt.y - e.point.y;
        if (hdx * hdx + hdy * hdy > 16 * 16) continue;
      }
      hit = cand;
      break;
    }
    if (!hit) return false;
    var ll = hit.geometry.coordinates.slice();
    var lid = hit.layer && hit.layer.id;
    if (lid === 'police-points') showPolicePopup(hit.properties, ll);
    else if (lid === 'police-hotspots' || lid === 'police-hotspots-core') showHotspotPopup(hit.properties, ll);
    else showAircraftPopup(hit.properties, ll);
    return true;
  }

  if (A.mapview && A.mapview.onStyle) A.mapview.onStyle(ensureLayers);
  if (A.mapview && A.mapview.onClick) A.mapview.onClick(onClick);

  E.map = {
    setAircraftData: setAircraftData,
    setAircraftTrailData: setAircraftTrailData,
    setPoliceData: setPoliceData,
    setHotspotData: setHotspotData,
    setGhostLayersVisible: setGhostLayersVisible,
    getGhostData: getGhostData,
    setRingsData: setRingsData,
    setRingsVisible: setRingsVisible,
    setAircraftFilter: setAircraftFilter,
    showAircraftPopup: showAircraftPopup,
    showPolicePopup: showPolicePopup,
    showHotspotPopup: showHotspotPopup,
    AIRCRAFT_OWNERS: AIRCRAFT_OWNERS,
    AIRCRAFT_COLORS: AIRCRAFT_COLORS,
    AIRCRAFT_LABELS: AIRCRAFT_LABELS,
    // test surface
    _onClick: onClick, _ensureLayers: ensureLayers, _cache: cache
  };
})();
