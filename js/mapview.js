/* Convoy — MapLibre map: styles, layers, markers, popups, camera */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var STYLES = {
    voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    liberty: 'https://tiles.openfreemap.org/styles/liberty',
    bright: 'https://tiles.openfreemap.org/styles/bright'
  };

  var map = null;
  var playerMarker = null;
  var destMarker = null;
  var popupRef = null;
  var npcMarkers = {}; // id -> {marker, el}
  var tilesWarned = false;

  // Global-feed residential filter: hide global drivers sitting on residential land.
  var globalRaw = { type: 'FeatureCollection', features: [] }; // unfiltered feed (cache.global = filtered view)
  var landuseIds = null;   // cached basemap landuse fill-layer ids (recomputed per style)
  var needRefilter = false; // a camera move happened — reclassify global drivers on next idle
  var RESIDENTIAL_RE = /residential|suburb|neighbou?rhood/i;

  /* The five aircraft ownership categories and their paint. One table, read by
     the layer paint, the popup and the legend, so a colour can never disagree
     with itself across three files. Order is the legend order: most notable
     first, routine traffic last. */
  var AIRCRAFT_OWNERS = ['military', 'police', 'ems', 'unknown', 'civilian'];
  var AIRCRAFT_COLORS = {
    military: '#ff3b3b',
    police: '#3b82f6',
    ems: '#22c55e',
    unknown: '#f59e0b',
    civilian: '#e8edf6'
  };
  // '#rrggbb' + alpha -> 'rgba(r,g,b,a)'. line-gradient stops need real colour
  // values; there is no opacity channel to lean on the way line-opacity gave us.
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  var AIRCRAFT_LABELS = {
    military: 'Military',
    police: 'Law enforcement',
    ems: 'EMS / medevac',
    unknown: 'Unidentified',
    civilian: 'Civilian'
  };

  // Layer data survives style switches via this cache (setStyle wipes sources)
  var cache = {
    route: emptyFC(),
    trail: emptyFC(),   // drive-log replay breadcrumb (js/triplog.js)
    links: emptyFC(),
    global: emptyFC(),
    aircraft: emptyFC(),
    aircraftTrail: emptyFC(),   // fading motion trails for aircraft (ghost mode)
    police: emptyFC(),
    hotspots: emptyFC(),   // police probability hotspots (ghost mode)
    rings: emptyFC()    // ghost-mode radar range circles
  };

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function styleUrl() {
    var s = S.settings.mapStyle;
    if (s === 'auto') {
      // A theme can pin its own basemap (recolored to match in ensureLayers).
      var def = A.themes && A.themes.get(ST.themeResolved());
      if (def && def.map && def.map.base && U.own(STYLES, def.map.base)) return STYLES[def.map.base];
      return ST.themeIsDark() ? STYLES.dark : STYLES.voyager;
    }
    return U.own(STYLES, s) ? STYLES[s] : STYLES.dark;
  }

  /* =================== init =================== */
  function init() {
    // Globe boot intro: no location is ever persisted, so until the user shares
    // a real position (⌖ button or a live GPS fix) we boot fully zoomed out on a
    // 3D globe; the first fix flies down to street level (landIntro). Needs
    // MapLibre ≥5 (setProjection) and is skipped when animations are off.
    introMode = S.settings.anim !== false &&
      typeof maplibregl.Map.prototype.setProjection === 'function';
    map = new maplibregl.Map({
      container: 'map',
      style: styleUrl(),
      center: introMode ? [S.playerStart[0], 22] : S.playerStart,
      zoom: introMode ? 1.1 : 13.4,
      pitch: 0,
      bearing: 0,
      maxPitch: 70,
      attributionControl: false,
      fadeDuration: 150
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    if (introMode) {
      map.on('style.load', applyGlobe); // setStyle wipes projection — re-apply every load
      // 'load' can hang on a slow glyph fetch (same reason boot below falls back
      // to 'idle' + timeout) — start the spin on whichever fires first.
      map.once('idle', startIntroSpin);
      setTimeout(startIntroSpin, 2500);
    }

    // Space environment (starfield behind the globe + day/night terminator).
    // Must init BEFORE the ensureLayers listener below so the night overlay's
    // style.load handler runs first and our data layers stack on top of it.
    if (A.space) A.space.init(map);

    map.on('style.load', ensureLayers);
    map.on('click', onMapClick);
    map.on('rotate', updateCompass);
    // Reclassify global drivers once the camera settles (newly loaded tiles let us
    // detect residential land that wasn't rendered before). 'idle' guards the loop:
    // setData re-renders → idle, but we only act when a real move set needRefilter.
    map.on('moveend', function () {
      needRefilter = true;
      // Tell the always-on layers (police, hotspots) the view changed so they can
      // refetch for the new area. They're bbox-gated, so a tiny nudge is a no-op.
      if (ST && ST.emit) ST.emit('mapmoved');
    });
    map.on('idle', function () { if (needRefilter) { needRefilter = false; applyGlobalFilter(); } });

    // Tile/network failures shouldn't crash anything — surface once
    map.on('error', function (e) {
      if (tilesWarned) return;
      var msg = e && e.error && e.error.message ? e.error.message : '';
      if (/Failed to fetch|NetworkError|ERR_/i.test(msg)) {
        tilesWarned = true;
        if (A.ui) A.ui.toast('Map tiles need an internet connection', 'warn');
      }
    });

    // User-initiated camera moves break trip follow (programmatic ones have no originalEvent)
    ['dragstart', 'rotatestart', 'pitchstart'].forEach(function (ev) {
      map.on(ev, function (e) {
        if (e && e.originalEvent && A.sim) A.sim.breakFollow();
      });
    });

    wireControls();

    // Boot once the map is ready. 'load' is ideal, but a hung sprite/glyph fetch on a flaky
    // connection can keep it from firing — so fall back to 'idle' and a hard timeout, otherwise
    // the whole app (markers, auth, panels) would never appear. Markers don't need glyphs.
    return new Promise(function (resolve) {
      var done = false;
      function ready() {
        if (done) return; done = true;
        // Kick the always-on layers once on first ready, in case the map loaded at a
        // static center and never fired 'moveend' (e.g. routecaps raced map init).
        if (ST && ST.emit) ST.emit('mapmoved');
        resolve();
      }
      map.on('load', ready);
      map.on('idle', ready);
      setTimeout(ready, 6000);
    });
  }

  /* =================== layers =================== */
  function ensureLayers() {
    var dark = ST.themeIsDark();
    var accent = S.settings.accent;
    // The nav line uses the theme's GPS color when it defines one (GTA's waypoint
    // purple), otherwise the accent.
    var routeCol = (A.themes && A.themes.routeColor()) || accent;

    // Skin the basemap to the active theme (GTA V etc.) before stacking our layers.
    // Re-runs on every style.load, so it survives style switches.
    if (A.themes) A.themes.applyMapTheme(map);

    addSrc('route', cache.route);
    addSrc('trail', cache.trail);
    addSrc('links', cache.links);
    addSrc('global', cache.global, { cluster: true, clusterRadius: 46, clusterMaxZoom: 9 });
    addSrc('aircraft', cache.aircraft);
    addSrc('police', cache.police);
    addSrc('hotspots', cache.hotspots);
    addSrc('rings', cache.rings);

    // ----- ROUTE: one solid GTA V-style GPS line -----
    // A single flat line in the theme's GPS color (GTA waypoint purple on that
    // theme, else the accent). No glow/bloom/filament stack — reads exactly like
    // the in-game minimap trail.
    addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': routeCol, 'line-width': zw(5, 9), 'line-opacity': 0.95 }
    });

    // ----- DRIVE-LOG TRAIL: dotted breadcrumb of a recorded trip -----
    addLayer({
      id: 'trail-line', type: 'line', source: 'trail',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': routeCol, 'line-width': zw(3, 5),
        'line-opacity': 0.8, 'line-dasharray': [0.1, 1.8]
      }
    });

    // ----- CONVOY LINKS: dashed neon with a soft underglow -----
    addLayer({
      id: 'convoy-links-glow', type: 'line', source: 'links',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': accent, 'line-width': 5,
        'line-blur': 6, 'line-opacity': dark ? 0.35 : 0.22
      }
    });
    addLayer({
      id: 'convoy-links', type: 'line', source: 'links',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': accent, 'line-width': 2,
        'line-dasharray': [0.5, 2.2], 'line-opacity': 0.9
      }
    });

    // ----- GLOBAL DRIVERS: hollow neon amber rings -----
    addLayer({
      id: 'global-clusters', type: 'circle', source: 'global',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': 'rgba(255,176,0,.05)',
        'circle-stroke-color': 'rgba(255,176,0,.7)',
        'circle-stroke-width': 1.4,
        'circle-blur': 0.4,
        'circle-radius': ['step', ['get', 'point_count'], 13, 8, 19, 20, 26]
      }
    });
    addLayer({
      id: 'global-points', type: 'circle', source: 'global',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': 'rgba(255,176,0,0)',
        'circle-radius': 5.5,
        'circle-opacity': 0.9,
        'circle-stroke-color': '#ffb000',
        'circle-stroke-width': 1.8,
        'circle-blur': 0.6
      }
    });

    setGlobalVisible(S.settings.showGlobal);

    // ----- RADAR RINGS (ghost mode): concentric range circles around the player -----
    // Drawn before the ghost points so targets/markers render on top of the rings.
    addLayer({
      id: 'radar-rings-glow', type: 'line', source: 'rings',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-blur': 7, 'line-opacity': 0.3 }
    });
    addLayer({
      id: 'radar-rings', type: 'line', source: 'rings',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['coalesce', ['get', 'width'], 1.6],
        'line-opacity': ['coalesce', ['get', 'opacity'], 0.85]
      }
    });
    setRingsVisible(!!(S.settings && S.settings.ghost));

    // ----- GHOST MODE: aircraft + police stations (blue) -----
    // Aircraft colour is ownership, five ways:
    //   military=red · police=blue · ems=green · civilian=silver · unknown=amber
    // Unknown gets its own colour rather than falling in with civilian, because
    // it means something different: the server could not identify the contact,
    // and on a layer whose job is telling a rider what is overhead, "we don't
    // know" is information. Size and opacity carry it too — the classified
    // categories are drawn larger and more solid than routine civilian traffic,
    // so a red or amber dot pulls the eye across a screen full of airliners.
    addLayer({
      id: 'aircraft-points', type: 'circle', source: 'aircraft',
      paint: {
        'circle-color': ['match', ['get', 'owner'],
          'military', '#ff3b3b',
          'police', '#3b82f6',
          'ems', '#22c55e',
          'unknown', '#f59e0b',
          '#e8edf6'], /* civilian default = silver */
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
    // Aircraft motion trails: a line source fed by ghost.js's predictor. Each
    // feature is a LineString of recent predicted positions with a per-segment
    // opacity so the tail fades into the dot's current position.
    //
    // It belongs UNDER the dot, and the old comment said so — but the layer was
    // added after aircraft-points, and MapLibre draws in insertion order, so the
    // comet tail was actually painting over the aircraft it trails. The explicit
    // `before` is what the comment always meant.
    // `lineMetrics` is what makes ['line-progress'] available, and that is what
    // turns the fade into a real gradient instead of a staircase.
    addSrc('aircraft-trail', cache.aircraftTrail, { lineMetrics: true });
    /* Each trail is ONE LineString faded with line-gradient.

       It used to be thirteen separate segment features per aircraft, each with
       its own flat opacity and width stepped up toward the head. That is a
       staircase, not a fade: every step was visible, and the round line-caps
       left a bead at each joint — the blocky, chopped look. It also meant
       ~1,300 features re-parsed by MapLibre five times a second.

       line-gradient interpolates continuously along the line, so the tail
       dissolves. Its one limitation is that it cannot read a feature property,
       so ownership colour comes from one thin layer per category instead of
       ['get','color'] — five layers, each drawing a handful of lines, bought
       with a fade that has no seams in it. */
    AIRCRAFT_OWNERS.forEach(function (owner) {
      var c = AIRCRAFT_COLORS[owner];
      addLayer({
        id: 'aircraft-trail-' + owner,
        type: 'line',
        source: 'aircraft-trail',
        filter: ['==', ['get', 'owner'], owner],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 12, 2.6, 16, 3.4],
          'line-blur': 0.6,
          // 0 = oldest point, 1 = the aircraft itself. Eased rather than linear
          // so the tail fades into the background instead of ending on an edge.
          'line-gradient': ['interpolate', ['linear'], ['line-progress'],
            0, rgba(c, 0),
            0.35, rgba(c, 0.16),
            0.7, rgba(c, 0.45),
            1, rgba(c, 0.85)]
        }
      }, 'aircraft-points');   // under the dots
    });
    // Apply the saved category filter the moment the layer exists — otherwise a
    // rider who turned a category off last session sees it back on every launch
    // until they touch the switch again.
    setAircraftFilter();
    addLayer({
      id: 'police-points', type: 'circle', source: 'police',
      paint: {
        // camera=amber, alpr=red, station=slate (static building), police=bright blue
        // (LIVE sighting, default). Live police pop; stations read as muted infrastructure.
        'circle-color': ['match', ['get', 'kind'], 'camera', '#ffcf2e', 'alpr', '#ff3b3b', 'station', '#64748b', '#3b82f6'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-radius': 5.5,
        'circle-opacity': 0.95
      }
    });
    // Probability hotspots, drawn as two stacked layers so the area reads clearly
    // AND the exact spot is unambiguous:
    //   1) 'police-hotspots' — a coloured halo whose radius grows with probability,
    //      giving the "roughly here" footprint.
    //   2) 'police-hotspots-core' — a small solid dot with a white ring at the exact
    //      cell centre, so the precise location is obvious.
    // Both sit BENEATH the live police pins (added first → lower z) so a hard
    // live-sighting pin still draws on top.
    addLayer({
      id: 'police-hotspots', type: 'circle', source: 'hotspots',
      paint: {
        // radius grows with probability; bigger = more sightings at this hour
        'circle-radius': ['interpolate', ['linear'], ['get', 'prob'], 0, 12, 0.5, 22, 1, 36],
        // green(low) → amber(mid) → red(high), heatmap-style
        'circle-color': ['interpolate', ['linear'], ['get', 'prob'],
          0, '#22c55e', 0.5, '#f59e0b', 1, '#ef4444'],
        // Clearly visible ambient footprint (was near-invisible at 0.2 / soft stroke).
        'circle-opacity': ['interpolate', ['linear'], ['get', 'prob'], 0, 0.28, 1, 0.42],
        // No stroke. A 2px hard-edged ring drawn at the nominal radius of a
        // circle whose FILL is blurred by 0.65 puts a crisp outline in the
        // middle of a soft glow — the halo fades out, then a sharp ring appears
        // floating in it. That contradiction is most of why the hotspot layer
        // read as blocky. The exact coordinate is already marked by the crisp
        // core dot in the layer below, so the ring was carrying no information
        // the map did not already show.
        'circle-blur': 0.9
      }
    });
    addLayer({
      id: 'police-hotspots-core', type: 'circle', source: 'hotspots',
      paint: {
        // Small, crisp, fixed-size dot marking the EXACT hotspot coordinate.
        'circle-radius': 4.5,
        'circle-color': ['interpolate', ['linear'], ['get', 'prob'],
          0, '#16a34a', 0.5, '#d97706', 1, '#dc2626'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 1,
        'circle-stroke-opacity': 1
      }
    });
    setGhostLayersVisible(!!(S.settings && S.settings.ghost));

    // Basemap (re)loaded → recompute landuse layer ids and reclassify global drivers
    // once tiles settle, so the residential filter tracks the new style.
    landuseIds = null;
    needRefilter = true;
  }

  // zoom-interpolated line width
  function zw(min, max) {
    return ['interpolate', ['linear'], ['zoom'], 10, min * 0.55, 14, min, 18, max];
  }

  function addSrc(id, data, extra) {
    if (map.getSource(id)) return;
    var def = { type: 'geojson', data: data };
    if (extra) Object.assign(def, extra);
    map.addSource(id, def);
  }
  // `before` puts the layer UNDER an existing one. MapLibre draws in insertion
  // order, so without it a layer added later is always on top no matter what a
  // comment claims about intent.
  function addLayer(def, before) {
    if (map.getLayer(def.id)) return;
    if (before && map.getLayer(before)) map.addLayer(def, before);
    else map.addLayer(def);
  }
  function setData(id, fc) {
    var src = map && map.getSource(id);
    if (src) src.setData(fc);
  }

  function setRouteData(fc) { cache.route = fc || emptyFC(); setData('route', cache.route); }
  function setTrailData(fc) { cache.trail = fc || emptyFC(); setData('trail', cache.trail); }
  function setLinksData(fc) { cache.links = fc || emptyFC(); setData('links', cache.links); }
  function setGlobalData(fc) { globalRaw = fc || emptyFC(); applyGlobalFilter(); }

  // Basemap fill layers drawn from the vector 'landuse' source-layer (per active style).
  function landuseLayerIds() {
    if (landuseIds !== null) return landuseIds;
    if (!map) return [];
    var layers = (map.getStyle() && map.getStyle().layers) || [];
    landuseIds = layers.filter(function (l) {
      return l['source-layer'] === 'landuse' && (l.type === 'fill' || l.type === 'fill-extrusion');
    }).map(function (l) { return l.id; });
    return landuseIds;
  }

  // Is this coordinate sitting on residential land? Uses the basemap's rendered
  // landuse polygons (queryRenderedFeatures hit-tests the polygon for us). Only
  // meaningful for points inside the loaded viewport; fails open (false) otherwise.
  //
  // Memoized by quantized coordinate: queryRenderedFeatures is a GPU readback, and
  // applyGlobalFilter calls this once per global driver. Without the cache a single
  // feed refresh (dozens of drivers) re-ran the same expensive query for dots that
  // hadn't moved. The key is rounded to ~11m (3 decimals) so a driver drifting a
  // few meters reuses the result; the cache is invalidated on every camera move
  // (residential classification is view-dependent — off-screen fails open).
  var residentialCache = {};
  var residentialCacheKey = '';
  function isResidential(coord) {
    if (!map || !map.isStyleLoaded()) return false;
    var ids = landuseLayerIds();
    if (!ids.length) return false;
    var p;
    try { p = map.project(coord); } catch (e) { return false; }
    var cv = map.getCanvas();
    if (p.x < 0 || p.y < 0 || p.x > cv.clientWidth || p.y > cv.clientHeight) return false; // off-screen
    // Quantize the lng/lat so near-identical positions share a result. 3 decimals
    // ≈ 11m at the equator — finer than the dots ever move between refreshes.
    var qkey = coord[0].toFixed(3) + ',' + coord[1].toFixed(3);
    // Invalidate the whole cache when the view changes (a coord's residential-ness
    // depends on whether its tile is loaded, which changes with pan/zoom).
    var viewKey = Math.round(map.getZoom()) + '|' + p.x.toFixed(0) + '|' + p.y.toFixed(0);
    if (viewKey !== residentialCacheKey) { residentialCacheKey = viewKey; residentialCache = {}; }
    if (qkey in residentialCache) return residentialCache[qkey];
    var feats;
    try { feats = map.queryRenderedFeatures(p, { layers: ids }); } catch (e) { return false; }
    var hit = false;
    for (var i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      var cls = pr.class || pr.landuse || pr.type || pr.subclass || '';
      if (RESIDENTIAL_RE.test(cls)) { hit = true; break; }
    }
    residentialCache[qkey] = hit;
    return hit;
  }

  // Drop global drivers that fall on residential land, then publish the rest.
  // Debounced: setData re-renders → fires 'idle' → which used to re-trigger this
  // filter, causing a feedback loop of GPU queries. Coalescing to one run per
  // frame breaks the cycle while still keeping the filter fresh after a pan.
  var filterScheduled = false;
  function applyGlobalFilter() {
    if (filterScheduled) return;
    filterScheduled = true;
    requestAnimationFrame(function () {
      filterScheduled = false;
      // Read globalRaw HERE, not at schedule time. Capturing it up front meant a
      // feed refresh landing inside the coalescing window was filtered out of
      // existence: applyGlobalFilter returned early (already scheduled) and the
      // pending pass then published the stale snapshot it had closed over.
      var raw = globalRaw;
      var feats = raw.features || [];
      var out = feats.length ? feats.filter(function (f) {
        var c = f.geometry && f.geometry.coordinates;
        return !(c && isResidential(c));
      }) : feats;
      tweenGlobal({ type: 'FeatureCollection', features: out });
    });
  }

  // Tween global dots between feed refreshes. The server re-sends the whole
  // layer every ~45s and dots used to teleport to their new spots; instead,
  // riders (keyed by name+car — the feed has no ids) ease from their last
  // rendered position to the new one. New/removed dots still pop in/out.
  var GLOBAL_TWEEN_MS = 1200;
  var GLOBAL_TWEEN_MAX = 150;  // beyond this many movers, skip animating (clustered source re-indexes per frame)
  var globalPrevPos = {};      // key -> [lng,lat] last rendered
  var globalTweenRaf = null;
  function renderGlobal(fc) { cache.global = fc; setData('global', fc); }
  function tweenGlobal(targetFC) {
    if (globalTweenRaf) { cancelAnimationFrame(globalTweenRaf); globalTweenRaf = null; }
    var feats = targetFC.features || [];
    var moves = [];
    var nextPos = {};
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i], p = f.properties || {};
      var key = (p.name || '') + '|' + (p.car || '');
      var to = f.geometry.coordinates.slice();
      nextPos[key] = to;
      var from = globalPrevPos[key];
      if (from && (from[0] !== to[0] || from[1] !== to[1])) moves.push({ f: f, from: from, to: to });
    }
    globalPrevPos = nextPos;
    if (!moves.length || moves.length > GLOBAL_TWEEN_MAX || !(S.settings && S.settings.anim)) {
      renderGlobal(targetFC);
      return;
    }
    var t0 = performance.now();
    function step(now) {
      var t = Math.min((now - t0) / GLOBAL_TWEEN_MS, 1);
      var e = t * (2 - t); // easeOutQuad
      for (var j = 0; j < moves.length; j++) {
        var mv = moves[j];
        mv.f.geometry.coordinates = [
          mv.from[0] + (mv.to[0] - mv.from[0]) * e,
          mv.from[1] + (mv.to[1] - mv.from[1]) * e
        ];
      }
      renderGlobal(targetFC);
      globalTweenRaf = t < 1 ? requestAnimationFrame(step) : null;
    }
    globalTweenRaf = requestAnimationFrame(step);
  }

  function setGlobalVisible(on) {
    ['global-clusters', 'global-points'].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }

  /* The map's aircraft category filter, read from the SAME settings the radar
     board uses (ghostAirMil / -Police / -Ems / -Civ / -Unknown).

     Those keys used to gate the threat board only, while every category was
     drawn on the map regardless — so turning "Civilian" off quietened the board
     and changed nothing you could see. One switch, one meaning: it now governs
     both. */
  var OWNER_SETTING = {
    military: 'ghostAirMil',
    police: 'ghostAirPolice',
    ems: 'ghostAirEms',
    civilian: 'ghostAirCiv',
    unknown: 'ghostAirUnknown'
  };
  function enabledOwners() {
    return AIRCRAFT_OWNERS.filter(function (o) { return S.settings[OWNER_SETTING[o]] !== false; });
  }
  function setAircraftFilter() {
    if (!map || !map.getLayer || !map.getLayer('aircraft-points')) return;
    var list = enabledOwners();
    var all = list.length === AIRCRAFT_OWNERS.length;
    map.setFilter('aircraft-points', all ? null : ['in', ['get', 'owner'], ['literal', list]]);
    // Trails now carry `owner` and live in one layer per category, so a hidden
    // category takes its own tail with it. Turning one category off used to hide
    // EVERY trail, because the old segment features had no owner to filter on.
    var ghostOn = !!(S.settings && S.settings.ghost);
    AIRCRAFT_OWNERS.forEach(function (o) {
      var id = 'aircraft-trail-' + o;
      if (!map.getLayer(id)) return;
      var show = ghostOn && list.indexOf(o) >= 0;
      map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    });
  }

  function setAircraftData(fc) { cache.aircraft = fc || emptyFC(); setData('aircraft', cache.aircraft); }
  function setAircraftTrailData(fc) { cache.aircraftTrail = fc || emptyFC(); setData('aircraft-trail', cache.aircraftTrail); }
  function setPoliceData(fc) { cache.police = fc || emptyFC(); setData('police', cache.police); }
  function setHotspotData(fc) { cache.hotspots = fc || emptyFC(); setData('hotspots', cache.hotspots); }
  function setGhostLayersVisible(on) {
    // NB: 'police-hotspots' AND 'police-points' are intentionally NOT toggled here —
    // both are always-on layers, independent of ghost mode. Police pins show
    // everywhere (gated by the "Police stations" setting); ghost mode only adds the
    // aircraft layer (points + trails) and the hotspot legend/scrubber over them.
    var ids = ['aircraft-points'];
    AIRCRAFT_OWNERS.forEach(function (o) { ids.push('aircraft-trail-' + o); });
    ids.forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
    // Re-apply the per-category filter so an owner the rider switched off does
    // not come back visible just because ghost mode was toggled.
    if (on) setAircraftFilter();
  }
  // Radar HUD reads the current ghost layers to build its alert list.
  function getGhostData() { return { aircraft: cache.aircraft, police: cache.police }; }
  function setRingsData(fc) { cache.rings = fc || emptyFC(); setData('rings', cache.rings); }
  function setRingsVisible(on) {
    ['radar-rings', 'radar-rings-glow'].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }

  // Ghost Mode: dim/phase the player marker so it reads as invisible.
  function setPlayerGhost(on) {
    if (!playerMarker) return;
    playerMarker.getElement().classList.toggle('ghost', !!on);
  }

  // diff:false forces a full style load so 'style.load' fires and ensureLayers
  // re-adds our sources/layers (diff mode would silently drop them)
  function applyStyle() { if (map) map.setStyle(styleUrl(), { diff: false }); }

  function applyAccent() {
    if (!map || !map.getLayer('route-line')) return;
    var accent = S.settings.accent;
    var routeCol = (A.themes && A.themes.routeColor()) || accent;
    map.setPaintProperty('route-line', 'line-color', routeCol);
    map.setPaintProperty('convoy-links', 'line-color', accent);
    map.setPaintProperty('convoy-links-glow', 'line-color', accent);
  }

  /* =================== markers (dots) =================== */
  // Inline dot for popups / profile preview (background-color so the CSS gloss gradient shows)
  function carDot(paint, size) {
    paint = U.safePaint(paint);
    return '<span class="car-dot" style="width:' + size + 'px;height:' + size +
      'px;background-color:' + paint + '"></span>';
  }

  // ----- marker category colors -----
  // You = blue. Friends = amber. Other riders = green, brightening with proximity:
  // radius < road < sight (the active nearby filter). Global feed dots are a
  // separate MapLibre layer (hollow amber) and stay untouched.
  function dotCategoryClass(npc) {
    if (npc.member) return 'c-friend';        // convoy member → friend color
    if (npc.account && (S.friends || []).some(function (f) { return f.username === npc.account; })) return 'c-friend';
    var filter = A.ui ? A.ui.nearbyFilter() : 'radius';
    if (filter === 'radius') return 'c-near';
    // Road/sight: only riders that actually MATCH the active filter get the
    // brighter category color — everyone else stays base green, so the map
    // shows who is on your road / in sight at a glance.
    if (A.ui && A.ui.nearbyMatches && !A.ui.nearbyMatches(npc)) return 'c-near';
    return filter === 'sight' ? 'c-sight' : 'c-road';
  }

  // Apply category classes to every NPC marker. Called when the filter changes
  // or friends/membership updates. Player is always blue (set at creation).
  function reclassifyMarkers() {
    Object.keys(npcMarkers).forEach(function (id) {
      var rec = npcMarkers[id];
      if (!rec) return;
      var npc = A.sim.getNpc(id);
      if (!npc) return;
      var dot = rec.el.querySelector('.m-dot');
      if (dot) dot.className = 'm-dot ' + dotCategoryClass(npc);
    });
  }

  function makeCarEl(opts) {
    var root = U.el('div', 'm-car' + (opts.player ? ' m-player' : ''));
    var size = opts.player ? 18 : 14;
    var cat = opts.player ? 'c-you' : (opts.category || 'c-near');
    root.innerHTML = '<div class="m-ring"></div>' +
      '<div class="m-dot ' + cat + '" style="width:' + size + 'px;height:' + size + 'px;background-color:' + U.safePaint(opts.paint) + '"></div>';
    return root;
  }

  function createPlayerMarker(pos) {
    var car = S.profile.car;
    var el = makeCarEl({ paint: car.paint, finish: car.finish, player: true });
    playerMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat(pos).addTo(map);
    return playerMarker;
  }

  function refreshPlayer() {
    if (!playerMarker) return;
    var dot = playerMarker.getElement().querySelector('.m-dot');
    if (dot) dot.style.backgroundColor = S.profile.car.paint;
  }

  function setPlayer(pos, brg) {
    if (!playerMarker) return;
    playerMarker.setLngLat(pos);
    if (brg != null) playerMarker.setRotation(brg);
  }

  /* =================== convoy rally point =================== */
  var rallyMarker = null;
  // rally = { lng, lat, label, byName } or null to remove the flag.
  function setRallyPoint(rally) {
    if (!rally) {
      if (rallyMarker) { rallyMarker.remove(); rallyMarker = null; }
      return;
    }
    var pos = [rally.lng, rally.lat];
    if (!rallyMarker) {
      var el = document.createElement('div');
      el.className = 'rally-marker';
      el.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 21V4"/><path d="M5 4h11l-2.2 3.5L16 11H5"/></svg>';
      el.addEventListener('click', function (e) { e.stopPropagation(); showRallyPopup(); });
      rallyMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(pos).addTo(map);
    } else {
      rallyMarker.setLngLat(pos);
    }
    rallyMarker._rally = rally;
  }

  function showRallyPopup() {
    var rally = rallyMarker && rallyMarker._rally;
    if (!rally) return;
    var pos = [rally.lng, rally.lat];
    var card = U.el('div', 'pop-card pop-prompt');
    card.innerHTML =
      '<div class="prompt-label"><span class="prompt-pin">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2.2 3.5L16 11H5"/></svg>' +
      '</span><span class="prompt-name">' + U.esc(rally.label || 'Rally point') +
      ' · by ' + U.esc(rally.byName || 'convoy') + '</span></div>' +
      '<div class="pop-actions"></div>';
    var actions = card.querySelector('.pop-actions');
    var go = U.el('button', 'btn btn-primary btn-small', 'Route here');
    go.addEventListener('click', function () {
      closePopup();
      A.routing.setDestination(pos, rally.label || 'Rally point');
    });
    actions.appendChild(go);
    var clear = U.el('button', 'btn btn-ghost btn-small', 'Clear rally');
    clear.addEventListener('click', function () {
      closePopup();
      if (A.party && A.party.clearRally) A.party.clearRally();
    });
    actions.appendChild(clear);
    openPopup(pos, card);
  }

  function addNpc(npc) {
    var el = makeCarEl({ paint: npc.car.paint, finish: npc.car.finish, player: false, category: dotCategoryClass(npc) });
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      showNpcPopup(npc.id);
    });
    var m = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat(npc.pos).setRotation(npc.heading).addTo(map);
    npcMarkers[npc.id] = { marker: m, el: el };
  }

  function updateNpc(id, pos, brg) {
    var rec = npcMarkers[id];
    if (!rec) return;
    rec.marker.setLngLat(pos);
    rec.marker.setRotation(brg);
    rec.el.style.visibility = projectsClean(pos) ? '' : 'hidden';
  }

  // On a pitched camera, points behind the view plane get mirrored into the
  // viewport by the DOM-marker projection. A projection that doesn't round-trip
  // back to the same place is bogus — hide that marker for the frame.
  // The pitch is read once per animation frame and cached (pitchCache), so a
  // tight per-NPC loop doesn't re-query map state for every marker.
  var pitchCache = { at: 0, low: true };
  function framePitchLow() {
    var now = 0;
    try { now = performance.now(); } catch (e) { now = Date.now(); }
    if (now - pitchCache.at > 16) {           // ~one frame
      pitchCache.at = now;
      pitchCache.low = map.getPitch() < 5;
    }
    return pitchCache.low;
  }
  function projectsClean(pos) {
    if (framePitchLow()) return true;
    var back = map.unproject(map.project(pos));
    return U.haversine(pos, [back.lng, back.lat]) < 30;
  }

  function removeNpc(id) {
    var rec = npcMarkers[id];
    if (!rec) return;
    rec.marker.remove();
    delete npcMarkers[id];
  }

  function setNpcMember(id, isMember) {
    var rec = npcMarkers[id];
    if (rec) rec.el.classList.toggle('m-member', !!isMember);
    reclassifyMarkers(); // members get the friend color
  }

  /* =================== destination marker =================== */
  function addDest(lngLat) {
    removeDest();
    var el = U.el('div', 'm-dest');
    el.innerHTML =
      '<div class="m-dest-ring"></div>' +
      '<div class="m-dest-pulse"></div>' +
      '<div class="m-dest-pin">' +
        // Google-Maps-style teardrop pin: rounded head, pointed tip (anchored at the
        // exact location), white inner dot. Themed with --accent so it still reads as Convoy.
        '<svg viewBox="0 0 24 34">' +
          '<path d="M12 .9C6.2.9 1.5 5.6 1.5 11.4c0 7.3 8.4 18.7 9.9 20.6a.75.75 0 0 0 1.2 0c1.5-1.9 9.9-13.3 9.9-20.6C22.5 5.6 17.8.9 12 .9Z" fill="var(--accent)" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>' +
          '<circle cx="12" cy="11.4" r="4.3" fill="#ffffff"/>' +
        '</svg>' +
      '</div>';
    destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
  }
  function removeDest() {
    if (destMarker) { destMarker.remove(); destMarker = null; }
  }

  /* =================== popups =================== */
  // Avatars go straight into a src="…" attribute inside innerHTML, so a prefix
  // test (/^data:image\//) is not enough — `data:image/x",onerror="…` passes it.
  // This mirrors the server's sanitizeAvatar() exactly, so the client no longer
  // depends on the server being the only thing standing between a rider record
  // and an attribute-injection sink.
  var AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  function safeAvatar(v) {
    return typeof v === 'string' && v.length <= 24000 && AVATAR_RE.test(v);
  }

  function closePopup() {
    if (popupRef) { popupRef.remove(); popupRef = null; }
  }

  function openPopup(lngLat, dom) {
    closePopup();
    popupRef = new maplibregl.Popup({ closeButton: false, offset: 22, maxWidth: '330px' })
      .setLngLat(lngLat).setDOMContent(dom).addTo(map);
    return popupRef;
  }

  function showNpcPopup(id) {
    var npc = A.sim.getNpc(id);
    if (!npc) return;
    var dist = U.fmtDist(U.haversine(A.sim.playerPos(), npc.pos), S.settings.units);
    var member = npc.member, invited = npc.invited;
    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head" id="pop-head-' + id + '">' +
      '  <div class="u-ava" style="--paint:' + U.safePaint(npc.car.paint) + '">' +
      (safeAvatar(npc.avatar)
        ? '<img class="ava-img" src="' + npc.avatar + '" alt=""/>'
        : U.riderIcon(npc.emoji, { size: 20 })) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(npc.name) + '</div>' +
      '  <div class="u-handle">@' + U.esc(npc.handle) + ' · ' + dist + ' away</div></div>' +
      '<span class="pop-more" title="View profile"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></span>' +
'</div>' +
'<div class="pop-car"><span class="pop-car-svg">' + carDot(npc.car.paint, 13) + '</span>' +
      '  <span>' + npc.car.year + ' ' + U.esc(npc.car.make) + ' ' + U.esc(npc.car.model) +
      (npc.car.trim ? ' ' + U.esc(npc.car.trim) : '') +
      '  <i class="paint-dot" style="background:' + U.safePaint(npc.car.paint) + '"></i> ' + U.esc(npc.car.paintName) + ' · ' + U.safeFinish(npc.car.finish) + '</span>' +
'</div>' +
'<div class="pop-tags"><span class="tag tag-live"><span class="dot dot-live"></span>' +
      (npc.mode === 'parked' ? 'Parked' : 'Cruising') + '</span>' +
      (npc.car.body ? '<span class="tag">' + U.esc(npc.car.body) + '</span>' : '') +
      (npc.car.drive ? '<span class="tag">' + U.esc(npc.car.drive) + (npc.car.hp ? ' · ' + npc.car.hp + 'hp' : '') + '</span>' : '') +
      (npc.car.exhaust && npc.car.exhaust !== 'Stock' ? '<span class="tag">' + U.esc(npc.car.exhaust) + '</span>' : '') +
      '<span class="tag">' + U.esc(npc.vibe) + '</span></div>' +
'<div class="pop-actions"></div>';

    // Tapping the popup header opens the full Instagram-style profile overlay.
    card.querySelector('#pop-head-' + id).addEventListener('click', function (e) {
      if (e.target.closest('.pop-actions')) return; // don't steal button taps
      A.mapview.closePopup();
      if (A.ui && A.ui.openProfileOverlay) A.ui.openProfileOverlay(id);
    });

    var actions = card.querySelector('.pop-actions');
    var inviteBtn = U.el('button', 'btn btn-primary btn-small');
    if (member) { inviteBtn.textContent = 'In your convoy ✓'; inviteBtn.disabled = true; }
    else if (invited) { inviteBtn.textContent = 'Invited…'; inviteBtn.disabled = true; }
    else {
      inviteBtn.textContent = 'Invite to convoy';
      inviteBtn.addEventListener('click', function () {
        A.party.invite(npc.id);
        inviteBtn.textContent = 'Invited…';
        inviteBtn.disabled = true;
      });
    }
    var waveBtn = U.el('button', 'btn btn-ghost btn-small', 'Wave');
    waveBtn.addEventListener('click', function () {
      waveBtn.disabled = true;
      A.ui.toast('You waved at ' + npc.name, 'info');
      if (A.net && A.net.isLive()) {
        A.net.sendWave(npc.id); // their wave back arrives as a server message
      } else {
        setTimeout(function () { A.ui.toast(npc.name + ' waved back', 'success'); }, U.randInt(900, 2200));
      }
    });
    actions.appendChild(inviteBtn);
    actions.appendChild(waveBtn);

    // Add-friend (only for signed-in riders, when you're signed in and not already friends)
    if (npc.account && A.auth && A.auth.isLoggedIn() && npc.account !== A.auth.username()) {
      var already = (S.friends || []).some(function (f) { return f.username === npc.account; });
      var friendBtn = U.el('button', 'btn btn-ghost btn-small');
      if (already) { friendBtn.textContent = 'Already friends'; friendBtn.disabled = true; }
      else {
        friendBtn.textContent = 'Add friend';
        friendBtn.addEventListener('click', function () {
          A.net.sendFriendAdd(npc.account);
          friendBtn.textContent = 'Request sent';
          friendBtn.disabled = true;
        });
      }
      var row2 = U.el('div', 'pop-actions');
      row2.appendChild(friendBtn);
      card.appendChild(row2);
    }

    openPopup(npc.pos, card);
  }

  function showGlobalPopup(props, lngLat) {
    var card = U.el('div', 'pop-card');
    var statusTag = props.online
      ? '<span class="tag tag-live"><span class="dot dot-live"></span>Online</span>'
      : '<span class="tag"><span class="dot" style="background:var(--text-dim)"></span>Offline</span>';
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:#ffb000">' + U.riderIcon(props.emoji, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.name) + '</div>' +
      '  <div class="u-handle">' + U.esc(props.city) + '</div></div>' +
      '</div>' +
      '<div class="pop-car"><span>' + U.esc(props.car) + '</span></div>' +
      '<div class="pop-tags">' + statusTag +
      '<span class="tag tag-delayed"><span class="dot dot-global"></span>Seen ' +
      props.seenMin + ' min ago</span><span class="tag">Delayed feed</span></div>';
    openPopup(lngLat, card);
  }

  // Ghost Mode popups — aircraft (OpenSky) + police stations (OSM).
  function showAircraftPopup(props, lngLat) {
    var card = U.el('div', 'pop-card');
    var altStr = props.alt != null
      ? (S.settings.units === 'km' ? Math.round(props.alt) + ' m' : Math.round(props.alt * 3.28084) + ' ft')
      : '—';
    var spdStr = props.speed != null
      ? (S.settings.units === 'km' ? Math.round(props.speed * 3.6) + ' km/h' : Math.round(props.speed * 2.23694) + ' mph')
      : '—';
    // Ownership drives the avatar color + a headline tag so it's the first thing
    // you read. Each of the five categories gets a distinct paint.
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
    openPopup(lngLat, card);
  }

  function showPolicePopup(props, lngLat) {
    var kind = props.kind;
    // kinds: 'camera' (speed cam), 'alpr' (surveillance), 'station' (OSM police
    // building), 'police' (LIVE sighting from Waze/crowd — the only kind that feeds
    // hotspots). Each gets its own color, label, icon and source credit.
    var meta = kind === 'alpr' ? { color: '#ff3b3b', sub: 'ALPR / surveillance camera', icon: 4, src: 'OpenStreetMap' }
      : kind === 'camera' ? { color: '#ffcf2e', sub: 'Speed / enforcement camera', icon: 7, src: 'OpenStreetMap' }
      : kind === 'station' ? { color: '#64748b', sub: 'Police station', icon: 1, src: 'OpenStreetMap' }
      : { color: '#3b82f6', sub: 'Live police sighting', icon: 1, src: props.waze ? 'Waze' : 'Rider report' };
    var name = props.name || props.label || (kind === 'station' ? 'Police station' : 'Police');
    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + meta.color + '">' + U.riderIcon(meta.icon, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(name) + '</div>' +
      '  <div class="u-handle">' + meta.sub + '</div></div>' +
      '</div>' +
      '<div class="pop-tags"><span class="tag tag-delayed"><span class="dot dot-global"></span>' + meta.src + '</span></div>';
    openPopup(lngLat, card);
  }

  // A probability hotspot pin. Shows the likelihood + how many sightings back it,
  // and roughly when it was last seen. Probabilities are derived from real
  // accumulated sightings (server/hotspots.js), not a static dataset.
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
    openPopup(lngLat, card);
  }

  // Hazard pin → a description popup, mirroring the police/hotspot dots. The label is
  // the human description (e.g. "Accident", "Flood Warning", "Heavy rain") and the tag
  // credits the source it came from.
  var HZ_WEATHER = { rain: 1, snow: 1, ice: 1, wind: 1, fog: 1, flood: 1, alert: 1 };
  function showHazardPopup(props, lngLat) {
    props = props || {};
    var color = props.color || '#ff5a3c';
    var src = props.waze ? 'Waze'
      : props.tomtom ? 'TomTom traffic'
      : props.alert ? 'NWS weather alert'
      : props.crowd ? 'Reported by a rider'
      : props.reported ? 'You reported this'
      : props.agent ? 'Live data feed'
      : 'Local conditions';
    var cat = HZ_WEATHER[props.kind] ? 'Weather' : 'Road hazard';

    // Which way is it, and how far — relative to where the rider is right now.
    var me = A.sim && A.sim.playerPos && A.sim.playerPos();
    var dirText = '';
    if (me && lngLat && (me[0] !== lngLat[0] || me[1] !== lngLat[1])) {
      var dist = U.haversine(me, lngLat);
      dirText = U.fmtDist(dist, S.settings.units) + ' to the ' + compass8(U.bearing(me, lngLat));
    }
    // Location detail (street / city) when the source provides it.
    var place = [props.street, props.city].filter(function (s) { return s; }).map(U.esc).join(', ');

    // Extra source detail: Waze crowd confidence + how fresh the report is.
    var extra = [];
    if (dirText) extra.push('<span class="tag"><span class="dot" style="background:' + color + '"></span>' + dirText + '</span>');
    if (props.reliability) extra.push('<span class="tag">Confidence ' + Math.round(props.reliability) + '/10</span>');
    // Coerce: `thumbs` comes straight off the upstream Waze payload and was the
    // one remote value interpolated into HTML without escaping or coercion.
    var thumbs = Math.max(0, Math.round(Number(props.thumbs) || 0));
    if (thumbs) extra.push('<span class="tag">' + thumbs + ' confirmed</span>');
    if (props.when) { var w = new Date(props.when); if (!isNaN(w)) extra.push('<span class="tag tag-delayed">' + relAgo(w.getTime()) + '</span>'); }

    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + color + '">' + U.riderIcon(6, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.label || 'Hazard') + '</div>' +
      '  <div class="u-handle">' + cat + (place ? ' · ' + place : '') + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' + extra.join('') +
        '<span class="tag tag-delayed"><span class="dot dot-global"></span>' + U.esc(src) + '</span>' +
      '</div>';
    openPopup(lngLat, card);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // 8-point compass name for a bearing in degrees (0 = north).
  function compass8(deg) {
    var names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  function relAgo(ts) {
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  /* =================== map click → route prompt =================== */
  function onMapClick(e) {
    // always-on enforcement layers first (aircraft, police pins, hotspot dot + halo).
    // The crisp core dot is listed first so a tap on the exact spot always wins.
    var gLayers = ['aircraft-points', 'police-points', 'police-hotspots-core', 'police-hotspots'].filter(function (id) { return map.getLayer(id); });
    if (gLayers.length) {
      var gf = map.queryRenderedFeatures(e.point, { layers: gLayers });
      var hit = null;
      for (var gi = 0; gi < gf.length; gi++) {
        var cand = gf[gi];
        if (cand.layer && cand.layer.id === 'police-hotspots') {
          // The halo is a big soft circle (up to ~36px radius) that can blanket whole
          // blocks — only claim the tap near its centre, otherwise fall through so
          // tap-to-route still works inside hotspot areas. (The core dot has no such
          // guard: it's small and precise, so any hit on it opens the popup.)
          var cpt = map.project(cand.geometry.coordinates.slice());
          var hdx = cpt.x - e.point.x, hdy = cpt.y - e.point.y;
          if (hdx * hdx + hdy * hdy > 16 * 16) continue;
        }
        hit = cand;
        break;
      }
      if (hit) {
        var ll = hit.geometry.coordinates.slice();
        var lid = hit.layer && hit.layer.id;
        if (lid === 'police-points') showPolicePopup(hit.properties, ll);
        else if (lid === 'police-hotspots' || lid === 'police-hotspots-core') showHotspotPopup(hit.properties, ll);
        else showAircraftPopup(hit.properties, ll);
        return;
      }
    }

    // hazards (weather, TomTom incidents, NWS alerts, rider reports) — tap for a description
    var hzLayers = ['hazard-icon', 'hazard-circle'].filter(function (id) { return map.getLayer(id); });
    if (hzLayers.length) {
      var hf = map.queryRenderedFeatures(e.point, { layers: hzLayers });
      if (hf.length) { showHazardPopup(hf[0].properties, hf[0].geometry.coordinates.slice()); return; }
    }

    // global driver layers next
    var layers = ['global-clusters', 'global-points'].filter(function (id) { return map.getLayer(id); });
    var feats = layers.length ? map.queryRenderedFeatures(e.point, { layers: layers }) : [];
    if (feats.length) {
      var f = feats[0];
      if (f.properties && f.properties.cluster) {
        var src = map.getSource('global');
        // MapLibre GL ≥3 returns a Promise here (the old callback form was removed),
        // so a tap on a cluster used to silently do nothing. Use the Promise.
        var center = f.geometry.coordinates;
        Promise.resolve(src.getClusterExpansionZoom(f.properties.cluster_id)).then(function (zoom) {
          map.easeTo({ center: center, zoom: zoom + 0.4, duration: ST.dur(650) });
        }).catch(function () {});
      } else {
        showGlobalPopup(f.properties, f.geometry.coordinates.slice());
      }
      return;
    }

    if (popupRef) { closePopup(); return; }
    A.routing.promptRoute([e.lngLat.lng, e.lngLat.lat]);
  }

  function wireCursorFor(layerId) {
    map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });
  }

  /* =================== controls =================== */
  // Every control is null-guarded the way ctl-global always was: one missing or
  // mis-typed id in a page variant used to throw here and left the WHOLE control
  // bar (plus the map.on('load') cursor wiring below) unwired.
  function wireControls() {
    var zIn = document.getElementById('ctl-zoom-in');
    if (zIn) zIn.addEventListener('click', function () {
      map.zoomTo(map.getZoom() + 1, { duration: ST.dur(280) });
    });
    var zOut = document.getElementById('ctl-zoom-out');
    if (zOut) zOut.addEventListener('click', function () {
      map.zoomTo(map.getZoom() - 1, { duration: ST.dur(280) });
    });
    var cmp = document.getElementById('ctl-compass');
    if (cmp) cmp.addEventListener('click', function () {
      if (A.sim) A.sim.breakFollow();
      map.easeTo({ bearing: 0, pitch: 0, duration: ST.dur(620) });
    });
    // A drag, a wheel zoom or a pinch is the rider taking over — drop any
    // programmatic claim so the follow camera and their input stop fighting.
    map.on('dragstart', releaseCamera);
    map.on('zoomstart', function (e) { if (e && e.originalEvent) releaseCamera(); });
    var loc = document.getElementById('ctl-locate');
    if (loc) loc.addEventListener('click', locate);
    var rec = document.getElementById('ctl-recenter');
    if (rec) rec.addEventListener('click', function () {
      A.sim.resumeFollow();
    });
    // The globe control mirrors the Global chip — it's in the map controls but
    // previously had no handler, so tapping it did nothing.
    var globe = document.getElementById('ctl-global');
    if (globe) globe.addEventListener('click', function () { ST.setShowGlobal(!S.settings.showGlobal); });

    map.on('load', function () {
      ['global-clusters', 'global-points'].forEach(function (id) {
        if (map.getLayer(id)) wireCursorFor(id);
      });
    });
  }

  function updateCompass() {
    var needle = document.getElementById('compass-needle');
    if (needle) needle.style.transform = 'rotate(' + (-map.getBearing()) + 'deg)';
  }

  function locate() {
    if (!navigator.geolocation) {
      A.ui.toast('Geolocation is not available here', 'warn');
      return;
    }
    A.ui.toast('Finding you…', 'info');
    navigator.geolocation.getCurrentPosition(
      function (p) {
        var pos = [p.coords.longitude, p.coords.latitude];
        A.sim.relocatePlayer(pos);
        if (!landIntro(pos, LOCATE_ZOOM)) swoopTo(pos, LOCATE_ZOOM);
        A.ui.toast('Riders refreshed around your location', 'success');
      },
      function () {
        // Denied/unavailable: don't strand the user on the globe — settle into the demo city.
        landIntro(S.playerStart, 13.4);
        A.ui.toast('Location blocked (needs https/localhost). Staying in demo city', 'warn');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  /* =================== globe boot intro =================== */
  // Boot state: whole planet in view, drifting slowly. Consumed by landIntro()
  // when the first real location arrives. introMode is set in init().
  var introMode = false;

  // Globe projection + a thin atmosphere halo that fades out by city zoom.
  function applyGlobe() {
    try { map.setProjection({ type: 'globe' }); } catch (e) { }
    try {
      map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 7, 0] });
    } catch (e) { }
  }

  // Slow eastward drift, chained in short linear easeTo steps on 'moveend'
  // (a single big-lng ease is a no-op — MapLibre normalizes the target back to
  // the same longitude). The chain dies on user touch, on landing, or once the
  // camera is off the globe (zoom > 4, e.g. the user flew to a rider).
  var spinStarted = false, spinStop = false;
  function startIntroSpin() {
    if (!introMode || spinStarted) return;
    spinStarted = true;
    ['mousedown', 'touchstart', 'wheel'].forEach(function (ev) {
      map.getCanvas().addEventListener(ev, function () { spinStop = true; }, { once: true, passive: true });
    });
    map.on('moveend', spinStep);
    spinStep();
  }
  function spinStep() {
    if (spinStop || !introMode || map.getZoom() > 4 || map.isMoving()) return;
    var c = map.getCenter();
    map.easeTo({ center: [c.lng + 8, c.lat], duration: 5000, easing: function (t) { return t; } });
  }

  // First real position after a globe boot → cinematic fly-down to street level.
  // Returns true if it handled the camera (callers skip their normal ease).
  function landIntro(pos, zoom) {
    if (!introMode || !map) return false;
    introMode = false;
    map.flyTo({
      center: pos, zoom: zoom || 15, pitch: 0, bearing: 0,
      duration: ST.dur(4600), essential: true
    });
    return true;
  }

  /* =================== camera =================== */
  function fitRoute(coords) {
    if (!coords || coords.length < 2) return;
    var b = coords.reduce(function (acc, c) { return acc.extend(c); },
      new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, {
      padding: { top: 130, bottom: 230, left: 90, right: 90 },
      maxZoom: 15.5, duration: ST.dur(950)
    });
  }

  // Decelerating ease. MapLibre's default easeTo curve starts and ends abruptly
  // at short durations, which is what makes repeated follow steps read as ticks
  // rather than as motion.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function jumpCam(opts) { map.jumpTo(opts); }
  function easeCam(opts) { map.easeTo(opts); }

  // Google-Maps-style locate swoop: flyTo's van Wijk arc (pull up, glide, dive
  // back in) instead of a flat linear ease. Always LANDS zoomed IN — the target
  // zoom never drops below minZoom and never below the current zoom, so a rider
  // already at street level is never yanked back out by pressing ⌖ again.
  var LOCATE_ZOOM = 16.5; // street level, same landing zoom as Google Maps' My Location

  /* A deliberate camera move is in flight until this time.

     Locating yourself was not reliably finishing, and this is why: swoopTo runs
     a flyTo that can take several seconds, while every incoming GPS fix calls
     followPlayer -> map.easeTo({center}). easeTo with no zoom cancels the flight
     and keeps whatever zoom the arc happened to be passing through, so pressing
     ⌖ mid-drive would slide you sideways and stop short of street level. The
     closer the fix cadence, the more often it got cut off — which is exactly the
     "not 100% of the time" shape of it.

     So a user-initiated move takes the camera for its duration, and the
     automatic follow yields. moveend clears the claim early, including when the
     rider grabs the map themselves — their pan should win, a background fix
     should not. */
  var camClaimUntil = 0;
  var camClaimToken = 0;
  function claimCamera(ms) {
    camClaimUntil = Date.now() + (ms || 0);
    if (!map) return;
    var token = ++camClaimToken;
    /* Bind the release on the NEXT frame, not now.

       MapLibre dispatches moveend through its render loop, so whatever the
       camera was doing a moment ago (the jumpTo that positioned us, a follow
       step that just landed) can still have a moveend in flight. Registering
       synchronously let that stale event fire immediately and release a claim
       the new flight had only just staked — which is precisely how the locate
       swoop kept getting cut off. One frame is enough for the queue to drain. */
    requestAnimationFrame(function () {
      if (token !== camClaimToken) return;   // superseded by a newer claim
      map.once('moveend', function () {
        if (token === camClaimToken) camClaimUntil = 0;
      });
    });
  }
  function cameraClaimed() { return Date.now() < camClaimUntil; }
  // The rider grabbing the map outranks any claim: their hands beat our arc.
  function releaseCamera() { camClaimUntil = 0; camClaimToken++; }

  function swoopTo(pos, minZoom) {
    var z = Math.max(map.getZoom(), minZoom || LOCATE_ZOOM);
    if (!S.settings.anim) { map.jumpTo({ center: pos, zoom: z, pitch: 0 }); return; }
    map.flyTo({
      center: pos, zoom: z, pitch: 0,
      curve: 1.42,        // arc shape of the swoop (van Wijk ρ — the Google Maps feel)
      speed: 1.6,         // brisker than MapLibre's 1.2 default, like GMaps' locate
      maxDuration: 5000,  // cross-country jumps stay snappy instead of a 20s cruise
      essential: true
    });
    claimCamera(5000);    // maxDuration; moveend releases it sooner in practice
    introMode = false;    // this flight is the landing; don't let the intro re-fly it
  }
  function flyToUser(pos) { swoopTo(pos, 14.6); }

  /* Focus one rider — the ▸ buttons in the Nearby and Convoy lists, and the
     rider popup.

     This used to call flyToUser, which floors the landing zoom at 14.6. From a
     normal map view (roughly 14–15) that is not a zoom at all: the camera slid
     a little and stopped, so it only LOOKED like it worked when you were zoomed
     out far enough for 14.6 to be an actual change — which is to say, when the
     rider was off screen. Focusing a rider is a "take me to them" gesture, so it
     lands at street level like the locate button does.

     It still never zooms OUT: someone already at 18 asking to focus a rider
     wants the camera moved, not their detail thrown away. */
  var RIDER_ZOOM = 16.5;
  function focusRider(pos) {
    if (!pos) return false;
    swoopTo(pos, RIDER_ZOOM);
    return true;
  }

  /* Fit every rider in the convoy (plus you) into one view.

     Returns a result the caller can speak to, because "fit everyone" is not
     always possible: riders scattered across a continent would need a zoom so
     far out that nobody is distinguishable, which is worse than not moving. In
     that case this refuses, reports `spread`, and the edge arrows (js/riderarrows.js)
     take over as the way to know where everyone is. */
  var FIT_MIN_ZOOM = 8.5;   // below this, dots are meaningless — use arrows instead
  function fitRiders(points) {
    if (!map || !points || !points.length) return { ok: false, reason: 'none' };
    if (points.length === 1) { focusRider(points[0]); return { ok: true, single: true }; }
    var b = points.reduce(function (acc, c) { return acc.extend(c); },
      new maplibregl.LngLatBounds(points[0], points[0]));
    var pad = { top: 120, bottom: 200, left: 70, right: 70 };
    var cam = map.cameraForBounds(b, { padding: pad, maxZoom: RIDER_ZOOM });
    if (!cam) return { ok: false, reason: 'nofit' };
    if (cam.zoom < FIT_MIN_ZOOM) return { ok: false, reason: 'spread', zoom: cam.zoom };
    if (!S.settings.anim) { map.jumpTo({ center: cam.center, zoom: cam.zoom }); return { ok: true }; }
    map.fitBounds(b, { padding: pad, maxZoom: RIDER_ZOOM, duration: ST.dur(900), pitch: 0, essential: true });
    claimCamera(ST.dur(900));
    return { ok: true, zoom: cam.zoom };
  }
  // Continuous nav follow — keep the player centered as real GPS fixes arrive.
  // Eases center only (keeps the user's zoom/bearing); short duration so successive
  // fixes blend smoothly. Programmatic ⇒ won't trip the user-pan follow-break.
  function followPlayer(pos) {
    if (!map) return;
    /* The claim check has to come BEFORE landIntro, and landIntro has to be
       consumed rather than merely skipped.

       On a fresh session the globe-boot intro is still armed, so the first GPS
       fix would fly to zoom 15 at the rider's position — overriding a locate or
       a rider-focus the rider had just asked for, and landing two zoom levels
       short of street level. A claimed flight is already taking the camera off
       the globe to a real position, which is the entire job of the intro, so
       the intro is finished either way: mark it done and stay out of the way. */
    if (cameraClaimed()) { introMode = false; return; }
    if (landIntro(pos, 15)) return; // first live GPS fix after a globe boot
    map.easeTo({ center: pos, duration: ST.dur(650), easing: easeOutCubic });
  }

  A.mapview = {
    init: init,
    map: function () { return map; },
    applyStyle: applyStyle,
    applyAccent: applyAccent,
    setRouteData: setRouteData,
    setTrailData: setTrailData,
    setLinksData: setLinksData,
    setGlobalData: setGlobalData,
    setGlobalVisible: setGlobalVisible,
    setAircraftData: setAircraftData,
    setAircraftTrailData: setAircraftTrailData,
    setPoliceData: setPoliceData,
    setHotspotData: setHotspotData,
    setGhostLayersVisible: setGhostLayersVisible,
    getGhostData: getGhostData,
    setRingsData: setRingsData,
    setRingsVisible: setRingsVisible,
    setPlayerGhost: setPlayerGhost,
    addDest: addDest,
    removeDest: removeDest,
    fitRoute: fitRoute,
    jumpCam: jumpCam,
    easeCam: easeCam,
    flyToUser: flyToUser,
    focusRider: focusRider,
    fitRiders: fitRiders,
    setAircraftFilter: setAircraftFilter,
    AIRCRAFT_OWNERS: AIRCRAFT_OWNERS,
    AIRCRAFT_COLORS: AIRCRAFT_COLORS,
    AIRCRAFT_LABELS: AIRCRAFT_LABELS,
    followPlayer: followPlayer,
    createPlayerMarker: createPlayerMarker,
    refreshPlayer: refreshPlayer,
    setPlayer: setPlayer,
    setRallyPoint: setRallyPoint,
    landIntro: landIntro,
    addNpc: addNpc,
    updateNpc: updateNpc,
    removeNpc: removeNpc,
    reclassifyMarkers: reclassifyMarkers,
    setNpcMember: setNpcMember,
    showNpcPopup: showNpcPopup,
    closePopup: closePopup,
    openPopup: openPopup,
    carDot: carDot
  };
})();
