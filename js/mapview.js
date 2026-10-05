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

  // Layer data survives style switches via this cache (setStyle wipes sources)
  var cache = {
    route: emptyFC(),
    trail: emptyFC(),   // drive-log replay breadcrumb (js/triplog.js)
    links: emptyFC(),
    global: emptyFC(),
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
  // MapLibre arrives from a CDN <script>; when that script never lands,
  // `maplibregl` is an undeclared global and initMap()'s body below throws
  // SYNCHRONOUSLY — before any Promise exists to reject. js/app.js's .catch()
  // is attached to our return value, so it would never see a throw that
  // happens producing that value. Convert the sync throw into a rejection so
  // the one handler that knows what to do about a dead map actually runs.
  function init() {
    try { return initMap(); } catch (e) { return Promise.reject(e); }
  }

  function initMap() {
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

    // Basemap (re)loaded → recompute landuse layer ids and reclassify global drivers
    // once tiles settle, so the residential filter tracks the new style.
    landuseIds = null;
    needRefilter = true;

    // Feature packs stack their own sources/layers here, after the core's, so
    // they too survive a style switch.
    runStyleHooks();
  }

  /* ---------------- extension points (feature packs) ----------------
     onStyle(fn): fn(map) runs after the core layers on every style.load, and
     at once if the style is already up — a pack that loads mid-session sees
     the same sequence as one present from boot. onClick(fn): fn(e, map) runs
     before the core's own click handling; return true to consume the tap. */
  var styleHooks = [], clickHooks = [];
  function runStyleHooks() {
    for (var i = 0; i < styleHooks.length; i++) {
      try { styleHooks[i](map); } catch (e) { console.error('[convoy mapview] style hook', e); }
    }
  }
  function onStyle(fn) {
    styleHooks.push(fn);
    if (map && typeof map.isStyleLoaded === 'function' && map.isStyleLoaded()) {
      try { fn(map); } catch (e) { console.error('[convoy mapview] style hook', e); }
    }
  }
  function onClick(fn) { clickHooks.push(fn); }

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

  // Invisible mode: dim/phase the player marker so it reads as hidden.
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

  /* =================== map click → route prompt =================== */
  function onMapClick(e) {
    // global driver layers first
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

    for (var i = 0; i < clickHooks.length; i++) {
      try { if (clickHooks[i](e, map) === true) return; } catch (err) { console.error('[convoy mapview] click hook', err); }
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
    onStyle: onStyle,
    onClick: onClick,
    applyStyle: applyStyle,
    applyAccent: applyAccent,
    setRouteData: setRouteData,
    setTrailData: setTrailData,
    setLinksData: setLinksData,
    setGlobalData: setGlobalData,
    setGlobalVisible: setGlobalVisible,
    setPlayerGhost: setPlayerGhost,
    addDest: addDest,
    removeDest: removeDest,
    fitRoute: fitRoute,
    jumpCam: jumpCam,
    easeCam: easeCam,
    flyToUser: flyToUser,
    focusRider: focusRider,
    fitRiders: fitRiders,
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
