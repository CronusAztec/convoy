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
    links: emptyFC(),
    global: emptyFC(),
    aircraft: emptyFC(),
    police: emptyFC(),
    rings: emptyFC()    // ghost-mode radar range circles
  };

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function styleUrl() {
    var s = S.settings.mapStyle;
    if (s === 'auto') return ST.themeResolved() === 'dark' ? STYLES.dark : STYLES.voyager;
    return STYLES[s] || STYLES.dark;
  }

  /* =================== init =================== */
  function init() {
    map = new maplibregl.Map({
      container: 'map',
      style: styleUrl(),
      center: S.playerStart,
      zoom: 13.4,
      pitch: 0,
      bearing: 0,
      maxPitch: 70,
      attributionControl: false,
      fadeDuration: 150
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.on('style.load', ensureLayers);
    map.on('click', onMapClick);
    map.on('rotate', updateCompass);
    // Reclassify global drivers once the camera settles (newly loaded tiles let us
    // detect residential land that wasn't rendered before). 'idle' guards the loop:
    // setData re-renders → idle, but we only act when a real move set needRefilter.
    map.on('moveend', function () { needRefilter = true; });
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
      function ready() { if (done) return; done = true; resolve(); }
      map.on('load', ready);
      map.on('idle', ready);
      setTimeout(ready, 6000);
    });
  }

  /* =================== layers =================== */
  function ensureLayers() {
    var dark = ST.themeResolved() === 'dark';
    var accent = S.settings.accent;

    addSrc('route', cache.route);
    addSrc('links', cache.links);
    addSrc('global', cache.global, { cluster: true, clusterRadius: 46, clusterMaxZoom: 9 });
    addSrc('aircraft', cache.aircraft);
    addSrc('police', cache.police);
    addSrc('rings', cache.rings);

    // ----- ROUTE: stacked neon light-trail (bloom → core → hot center) -----
    // Wide, soft outer bloom (chromatic haze)
    addLayer({
      id: 'route-glow', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': accent, 'line-blur': 18, 'line-opacity': dark ? 0.32 : 0.22,
        'line-width': zw(20, 34)
      }
    });
    // Mid bloom — tighter, brighter
    addLayer({
      id: 'route-bloom', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': accent, 'line-blur': 8, 'line-opacity': dark ? 0.55 : 0.4,
        'line-width': zw(11, 18)
      }
    });
    // Dark core underlay so the bright neon reads as a tube of light, not a smear
    addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#04070d' : '#ffffff',
        'line-opacity': 0.92, 'line-width': zw(7, 12)
      }
    });
    // Bright neon body
    addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': accent, 'line-width': zw(4, 7.5), 'line-blur': 0.6 }
    });
    // White-hot center filament
    addLayer({
      id: 'route-core', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': zw(1.2, 2.2), 'line-opacity': 0.92 }
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

    // ----- GHOST MODE: aircraft (silver) + police stations (blue) -----
    addLayer({
      id: 'aircraft-points', type: 'circle', source: 'aircraft',
      paint: {
        'circle-color': '#e8edf6',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-radius': 6,
        'circle-opacity': 0.9,
        'circle-blur': 0.3
      }
    });
    addLayer({
      id: 'police-points', type: 'circle', source: 'police',
      paint: {
        // camera=amber, alpr=red, police=blue (default). Each enforcement kind
        // reads apart at a glance in the Ghost radar HUD.
        'circle-color': ['match', ['get', 'kind'], 'camera', '#ffcf2e', 'alpr', '#ff3b3b', '#3b82f6'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-radius': 5.5,
        'circle-opacity': 0.95
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
  function addLayer(def) {
    if (map.getLayer(def.id)) return;
    map.addLayer(def);
  }
  function setData(id, fc) {
    var src = map && map.getSource(id);
    if (src) src.setData(fc);
  }

  function setRouteData(fc) { cache.route = fc || emptyFC(); setData('route', cache.route); }
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
  function isResidential(coord) {
    if (!map || !map.isStyleLoaded()) return false;
    var ids = landuseLayerIds();
    if (!ids.length) return false;
    var p;
    try { p = map.project(coord); } catch (e) { return false; }
    var cv = map.getCanvas();
    if (p.x < 0 || p.y < 0 || p.x > cv.clientWidth || p.y > cv.clientHeight) return false; // off-screen
    var feats;
    try { feats = map.queryRenderedFeatures(p, { layers: ids }); } catch (e) { return false; }
    for (var i = 0; i < feats.length; i++) {
      var pr = feats[i].properties || {};
      var cls = pr.class || pr.landuse || pr.type || pr.subclass || '';
      if (RESIDENTIAL_RE.test(cls)) return true;
    }
    return false;
  }

  // Drop global drivers that fall on residential land, then publish the rest.
  function applyGlobalFilter() {
    var feats = globalRaw.features || [];
    var out = feats.length ? feats.filter(function (f) {
      var c = f.geometry && f.geometry.coordinates;
      return !(c && isResidential(c));
    }) : feats;
    cache.global = { type: 'FeatureCollection', features: out };
    setData('global', cache.global);
  }

  function setGlobalVisible(on) {
    ['global-clusters', 'global-points'].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }

  function setAircraftData(fc) { cache.aircraft = fc || emptyFC(); setData('aircraft', cache.aircraft); }
  function setPoliceData(fc) { cache.police = fc || emptyFC(); setData('police', cache.police); }
  function setGhostLayersVisible(on) {
    ['aircraft-points', 'police-points'].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
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
    map.setPaintProperty('route-line', 'line-color', accent);
    map.setPaintProperty('route-bloom', 'line-color', accent);
    map.setPaintProperty('route-glow', 'line-color', accent);
    map.setPaintProperty('convoy-links', 'line-color', accent);
    map.setPaintProperty('convoy-links-glow', 'line-color', accent);
  }

  /* =================== markers (dots) =================== */
  // Inline dot for popups / profile preview (background-color so the CSS gloss gradient shows)
  function carDot(paint, size) {
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
    if (filter === 'sight') return 'c-sight';
    if (filter === 'road') return 'c-road';
    return 'c-near';
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
      '<div class="m-dot ' + cat + '" style="width:' + size + 'px;height:' + size + 'px;background-color:' + opts.paint + '"></div>';
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
        '<svg viewBox="0 0 24 24">' +
          '<path d="M12 1.5 22 21 12 17 2 21Z" fill="var(--accent)" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/>' +
          '<path d="M12 6 17.5 17.5 12 15 6.5 17.5Z" fill="#ffffff" opacity=".9"/>' +
        '</svg>' +
      '</div>';
    destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
  }
  function removeDest() {
    if (destMarker) { destMarker.remove(); destMarker = null; }
  }

  /* =================== popups =================== */
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
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + npc.car.paint + '">' + U.riderIcon(npc.emoji, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(npc.name) + '</div>' +
      '  <div class="u-handle">@' + U.esc(npc.handle) + ' · ' + dist + ' away</div></div>' +
'</div>' +
'<div class="pop-car"><span class="pop-car-svg">' + carDot(npc.car.paint, 13) + '</span>' +
      '  <span>' + npc.car.year + ' ' + U.esc(npc.car.make) + ' ' + U.esc(npc.car.model) +
      '  <i class="paint-dot" style="background:' + npc.car.paint + '"></i> ' + U.esc(npc.car.paintName) + ' · ' + npc.car.finish + '</span>' +
'</div>' +
'<div class="pop-tags"><span class="tag tag-live"><span class="dot dot-live"></span>' +
      (npc.mode === 'parked' ? 'Parked' : 'Cruising') + '</span>' +
      (npc.car.body ? '<span class="tag">' + U.esc(npc.car.body) + '</span>' : '') +
      (npc.car.drive ? '<span class="tag">' + U.esc(npc.car.drive) + (npc.car.hp ? ' · ' + npc.car.hp + 'hp' : '') + '</span>' : '') +
      (npc.car.exhaust && npc.car.exhaust !== 'Stock' ? '<span class="tag">' + U.esc(npc.car.exhaust) + '</span>' : '') +
      '<span class="tag">' + U.esc(npc.vibe) + '</span></div>' +
'<div class="pop-actions"></div>';

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
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:#e8edf6">' + U.riderIcon(0, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.callsign) + '</div>' +
      '  <div class="u-handle">' + U.esc(props.country || props.acType || props.reg || 'Unknown origin') + '</div></div>' +
      '</div>' +
      '<div class="pop-tags">' +
      (props.ground ? '<span class="tag">On ground</span>' : '<span class="tag tag-live"><span class="dot dot-live"></span>Airborne</span>') +
      (props.acType ? '<span class="tag">Type ' + U.esc(props.acType) + '</span>' : '') +
      (props.reg ? '<span class="tag">Reg ' + U.esc(props.reg) + '</span>' : '') +
      (props.mil ? '<span class="tag">⚑ Military</span>' : '') +
      '<span class="tag">Altitude ' + altStr + '</span>' +
      '<span class="tag">Speed ' + spdStr + '</span>' +
      (props.heading != null ? '<span class="tag">HDG ' + Math.round(props.heading) + '°</span>' : '') +
      '<span class="tag tag-delayed"><span class="dot dot-global"></span>Live · ' +
        (props.src === 'adsbx' ? 'ADS-B Exchange' : 'OpenSky') + '</span>' +
      '</div>';
    openPopup(lngLat, card);
  }

  function showPolicePopup(props, lngLat) {
    var cam = props.kind === 'camera';
    var alpr = props.kind === 'alpr';
    var color = alpr ? '#ff3b3b' : (cam ? '#ffcf2e' : '#3b82f6');
    var sub = alpr ? 'ALPR / surveillance camera' : (cam ? 'Speed / enforcement camera' : 'Police station');
    var iconIdx = alpr ? 4 : (cam ? 7 : 1); // avatar glyph per kind
    var card = U.el('div', 'pop-card');
    card.innerHTML =
      '<div class="pop-head">' +
      '  <div class="u-ava" style="--paint:' + color + '">' + U.riderIcon(iconIdx, { size: 20 }) + '</div>' +
      '  <div class="pop-id"><div class="u-name">' + U.esc(props.name) + '</div>' +
      '  <div class="u-handle">' + sub + '</div></div>' +
      '</div>' +
      '<div class="pop-tags"><span class="tag tag-delayed"><span class="dot dot-global"></span>OpenStreetMap</span></div>';
    openPopup(lngLat, card);
  }

  /* =================== map click → route prompt =================== */
  function onMapClick(e) {
    // ghost layers first (aircraft, police) — only present while ghost mode is on
    var gLayers = ['aircraft-points', 'police-points'].filter(function (id) { return map.getLayer(id); });
    if (gLayers.length) {
      var gf = map.queryRenderedFeatures(e.point, { layers: gLayers });
      if (gf.length) {
        var hit = gf[0];
        var ll = hit.geometry.coordinates.slice();
        if (hit.layer && hit.layer.id === 'police-points') showPolicePopup(hit.properties, ll);
        else showAircraftPopup(hit.properties, ll);
        return;
      }
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
  function wireControls() {
    document.getElementById('ctl-zoom-in').addEventListener('click', function () {
      map.zoomTo(map.getZoom() + 1, { duration: ST.dur(280) });
    });
    document.getElementById('ctl-zoom-out').addEventListener('click', function () {
      map.zoomTo(map.getZoom() - 1, { duration: ST.dur(280) });
    });
    document.getElementById('ctl-compass').addEventListener('click', function () {
      if (A.sim) A.sim.breakFollow();
      map.easeTo({ bearing: 0, pitch: 0, duration: ST.dur(620) });
    });
    document.getElementById('ctl-locate').addEventListener('click', locate);
    document.getElementById('ctl-recenter').addEventListener('click', function () {
      A.sim.resumeFollow();
    });

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
        map.easeTo({ center: pos, zoom: 14, duration: ST.dur(900) });
        A.ui.toast('Riders refreshed around your location', 'success');
      },
      function () {
        A.ui.toast('Location blocked (needs https/localhost) — staying in demo city', 'warn');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
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

  function jumpCam(opts) { map.jumpTo(opts); }
  function easeCam(opts) { map.easeTo(opts); }
  function flyToUser(pos) {
    map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 14.6), duration: ST.dur(800) });
  }
  // Continuous nav follow — keep the player centered as real GPS fixes arrive.
  // Eases center only (keeps the user's zoom/bearing); short duration so successive
  // fixes blend smoothly. Programmatic ⇒ won't trip the user-pan follow-break.
  function followPlayer(pos) {
    if (!map) return;
    map.easeTo({ center: pos, duration: ST.dur(650) });
  }

  A.mapview = {
    init: init,
    map: function () { return map; },
    applyStyle: applyStyle,
    applyAccent: applyAccent,
    setRouteData: setRouteData,
    setLinksData: setLinksData,
    setGlobalData: setGlobalData,
    setGlobalVisible: setGlobalVisible,
    setAircraftData: setAircraftData,
    setPoliceData: setPoliceData,
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
    followPlayer: followPlayer,
    createPlayerMarker: createPlayerMarker,
    refreshPlayer: refreshPlayer,
    setPlayer: setPlayer,
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
