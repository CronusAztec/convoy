/* Convoy — overlays feature pack (packs/overlays, server/packs/overlays.js).
   `npm test` (test/run.js picks up test/packs-*.test.js), or:
     node test/packs-overlays.test.js

   What is pinned, and why:
     O1  the contract — the manifest validates through the real registry, the
         server half loads, every file is listed
     O2  the client in the real page — mounted through the loader's own
         mountFragment + eval'd in order against a fake MapLibre map: settings
         registered (all off), sources/layers added once per style load, the
         settings hook renders the section, the ⚠ control shows only while held,
         the report picker drops a local pin AND sends overlays:report, an
         incoming overlays:hazard draws a pin (own echo dropped), tile URLs carry
         the pack token, stand-down on the 'packs' event clears everything
     O3  pure pieces — scanHazards thresholds, alertPoint, movedFar
     O4  the server half against a fake ctx — caps/incidents/tile without a key,
         bbox validation, the token-auth tile route is declared so, the report
         handler's proximity gate, rate limit, kind allowlist, label cleaning,
         fan-out only to nearby holders outside a block pair, and malformed
         frames that must not throw
     O5  tomtom-extras.toFeatures — kinds mapped, jams dropped, cap honoured */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

const PACK = 'overlays';
const DIR = path.join(ROOT, 'packs', PACK);
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'pack.json'), 'utf8'));

(async function main() {
  /* ================= O1 ================= */
  group('O1 — the contract');
  {
    const packs = require('../server/packs');
    let err = null;
    try { packs._reset(); packs.load({ hello() {}, pos() {} }); } catch (e) { err = e; }
    ok('the registry loads packs/ with overlays in it (no collision, manifest valid)', !err && packs.has(PACK), err && err.message);
    const half = require('../server/packs/overlays.js');
    ok('the server half is id "overlays" with caps/incidents/traffic routes and the overlays:report handler',
      half.id === PACK && half.routes.length === 3 && Object.keys(half.ws).join() === 'overlays:report');
    ok('the traffic tile route authenticates by the signed file token (a raster tile cannot carry a bearer)',
      half.routes[2][3] && half.routes[2][3].auth === 'token' && /traffic/.test(half.routes[2][1].source));
    const onDisk = fs.readdirSync(DIR).filter((f) => /\.(js|css|html)$/.test(f)).sort();
    const listed = [].concat(manifest.scripts, manifest.styles, manifest.fragments.map((f) => f.file)).sort();
    ok('every file on disk is in pack.json', JSON.stringify(onDisk) === JSON.stringify(listed), onDisk.join(',') + ' vs ' + listed.join(','));
    ok('nothing regulated: legal is null', manifest.legal === null);
  }

  /* ================= O2 ================= */
  group('O2 — the client in the real page');
  const { win, doc, A } = H.bootRealUi();
  A.store.load();
  A.ui.init();
  // A fake MapLibre map: records sources, layers, images, visibility.
  function fakeMap() {
    const sources = {}, layers = {}, images = {}, layout = {};
    return {
      isStyleLoaded: () => true,
      getSource: (id) => sources[id] || null,
      addSource: (id, def) => { sources[id] = { def, data: def.data, tiles: def.tiles ? def.tiles.slice() : null, setData(d) { this.data = d; }, setTiles(t) { this.tiles = t; } }; },
      getLayer: (id) => layers[id] || null,
      addLayer: (l) => { layers[l.id] = l; },
      hasImage: (id) => !!images[id],
      addImage: (id) => { images[id] = 1; },
      setLayoutProperty: (id, k, v) => { layout[id] = v; },
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      getBounds: () => ({ getWest: () => -0.5, getSouth: () => 51.2, getEast: () => 0.3, getNorth: () => 51.8 }),
      queryRenderedFeatures: () => [],
      _sources: sources, _layers: layers, _layout: layout, _images: images
    };
  }
  const fm = fakeMap();
  A.mapview.map = () => fm;
  // The signed-in holder of the pack, as the loader would see it.
  const FETCHES = [];
  const fakeFetch = (url, opts) => {
    FETCHES.push({ url: String(url), method: (opts && opts.method) || 'GET', auth: opts && opts.headers && opts.headers.Authorization, body: opts && opts.body });
    const reply = (status, obj) => Promise.resolve({ ok: status < 400, status, json: async () => obj });
    if (/\/api\/overlays\/caps$/.test(url)) return reply(200, { traffic: true, incidents: true });
    if (/\/api\/overlays\/incidents$/.test(url)) return reply(200, { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 51.5] }, properties: { kind: 'accident', label: 'Accident', color: '#ff3b3b', tomtom: true } }] });
    if (/rainviewer/.test(url)) return reply(200, { host: 'https://tilecache.rainviewer.com', radar: { past: [{ path: '/v2/radar/1' }] } });
    if (/open-meteo/.test(url)) return reply(200, { current: { weather_code: 45, precipitation: 6, snowfall: 0, wind_speed_10m: 10, temperature_2m: 8 } });
    if (/weather\.gov/.test(url)) return reply(200, { features: [] });
    return reply(404, {});
  };
  win.fetch = fakeFetch; global.fetch = fakeFetch;
  A.store.setAuth({ token: 'tok-holder', username: 'holder' });
  // Pretend the loader fetched a manifest naming this pack (has() reads it).
  const SENT = [];
  A.net.send = (m) => SENT.push(m);
  A.net.isLive = () => true;
  A.net.myId = () => 'me1';
  A.sim.playerPos = () => [-0.1, 51.5];
  let held = true;
  A.packs.has = (id) => id === PACK && held;
  A.packs.holds = A.packs.has;
  A.packs.token = (id) => (id === PACK ? 'TOK.SIG' : null);
  A.packs.tokenAgeMs = () => 1000;
  A.packs.authHeaders = (json) => Object.assign({ Authorization: 'Bearer tok-holder' }, json ? { 'Content-Type': 'application/json' } : {});
  let registered = null;
  A.packs.register = (id, def) => { registered = { id, def }; };

  manifest.fragments.forEach((f) => A.packs._mountFragment({ mount: f.mount, position: f.position, html: fs.readFileSync(path.join(DIR, f.file), 'utf8') }));
  manifest.scripts.forEach((f) => win.eval(fs.readFileSync(path.join(DIR, f), 'utf8')));
  ok('the ⚠ control is mounted after #ctl-global, hidden until init decides', !!doc.getElementById('ctl-hazard') && doc.getElementById('ctl-hazard').previousElementSibling.id === 'ctl-global' && doc.getElementById('ctl-hazard').hidden);
  ok('settings registered, all off', A.state.settings.showWeather === false && A.state.settings.showTraffic === false && A.state.settings.showHazards === false && A.state.settings.weatherLayer === 'rain');
  ok('the pack registered its init with A.packs.register("overlays")', registered && registered.id === PACK && typeof registered.def.init === 'function');
  registered.def.init();
  await H.sleep(20);
  ok('init fetched the caps with the bearer', FETCHES.some((f) => /\/api\/overlays\/caps$/.test(f.url) && f.auth === 'Bearer tok-holder'));
  ok('held → the ⚠ control is shown', doc.getElementById('ctl-hazard').hidden === false);
  A.overlays.ensure(fm);
  ok('ensure(map) adds the weather/traffic rasters and the hazard source + two layers, hidden by default',
    !!fm._sources.weather && !!fm._sources.traffic && !!fm._sources.hazards && !!fm._layers['hazard-circle'] && !!fm._layers['hazard-icon'] &&
    fm._layers.weather.layout.visibility === 'none' && fm._layers.traffic.layout.visibility === 'none');
  A.overlays.ensure(fm);
  ok('ensure() is idempotent (a second style.load adds nothing twice)', Object.keys(fm._layers).length === 4 && Object.keys(fm._sources).length === 3);
  ok('the traffic tile template carries the pack token for the token-auth route', /\/api\/overlays\/traffic\/\{z\}\/\{x\}\/\{y\}\.png\?t=TOK\.SIG$/.test(fm._sources.traffic.def.tiles[0]), fm._sources.traffic.def.tiles[0]);

  A.store.setSetting('showWeather', true, 'weather');
  await H.sleep(20);
  ok('weather on → RainViewer frame fetched, tiles re-pointed at the frame, layer visible',
    FETCHES.some((f) => /rainviewer/.test(f.url)) && /\/v2\/radar\/1\/512\/\{z\}\/\{x\}\/\{y\}\/4\/1_1\.png$/.test(fm._sources.weather.tiles[0]) && fm._layout.weather === 'visible', JSON.stringify(fm._sources.weather.tiles));
  A.store.setSetting('weatherLayer', 'wind', 'weatherlayer');
  ok('radar colour change re-points the tiles (scheme 7)', /\/7\/1_1\.png$/.test(fm._sources.weather.tiles[0]));
  A.store.setSetting('showTraffic', true, 'traffic');
  ok('traffic on (server has a key) → layer visible with a cache-busted, tokened template',
    fm._layout.traffic === 'visible' && /\?t=TOK\.SIG&_v=\d+$/.test(fm._sources.traffic.tiles[0]), String(fm._sources.traffic.tiles));
  A.store.setSetting('showHazards', true, 'hazards');
  await H.sleep(30);
  const hz = () => fm._sources.hazards.data.features;
  ok('hazards on → Open-Meteo conditions become pins (heavy rain + fog here) and incidents arrive with the bearer',
    hz().some((f) => f.properties.kind === 'rain') && hz().some((f) => f.properties.kind === 'fog') && hz().some((f) => f.properties.tomtom) &&
    FETCHES.some((f) => /\/api\/overlays\/incidents$/.test(f.url) && f.method === 'POST' && f.auth === 'Bearer tok-holder' && /bottomLeft/.test(f.body)), JSON.stringify(hz().map((f) => f.properties.kind)));

  // The report picker.
  doc.getElementById('ctl-hazard').click();
  const picker = doc.getElementById('hazard-report');
  ok('the ⚠ control opens the report picker with no police button (that is the enforcement pack\'s)',
    !!picker && picker.hidden === false && picker.querySelectorAll('.hazard-btn').length === 6 && !picker.querySelector('.hazard-btn[data-kind="police"]'));
  picker.querySelector('.hazard-btn[data-kind="ice"]').click();
  ok('tapping a kind drops a local pin at the rider (stamped with their id) and sends overlays:report',
    hz().some((f) => f.properties.kind === 'ice' && f.properties.reported && f.properties.by === 'me1') &&
    SENT.length === 1 && SENT[0].t === 'overlays:report' && SENT[0].kind === 'ice' && SENT[0].lat === 51.5 && SENT[0].lng === -0.1, JSON.stringify(SENT));
  await H.sleep(230);
  ok('…and the picker closes', picker.hidden === true);

  // Incoming reports.
  const before = hz().length;
  A.overlays.addReportedHazard({ lat: 51.51, lng: -0.09, kind: 'fog', label: 'Thick fog', by: 'rider2' });
  A.overlays.addReportedHazard({ lat: 51.51, lng: -0.09, kind: 'ice', by: 'me1' });          // our own echo
  A.overlays.addReportedHazard({ lat: 'x', lng: -0.09, kind: 'ice', by: 'rider3' });          // malformed
  A.overlays.addReportedHazard({ lat: 51.52, lng: -0.08, kind: 'constructor', by: 'rider4' }); // unknown kind → hazard
  ok('an incoming hazard draws a crowd pin; our own echo and a malformed frame are dropped; an unknown kind becomes "hazard"',
    hz().length === before + 2 && hz().some((f) => f.properties.crowd && f.properties.label === 'Thick fog') && hz().some((f) => f.properties.by === 'rider4' && f.properties.kind === 'hazard'));
  ok('the pure pieces: scanHazards thresholds', (() => {
    const s = A.overlays._scanHazards;
    const pos = [0, 0];
    return s({ precipitation: 4 }, pos).map((f) => f.properties.kind).join() === 'rain' &&
      s({ snowfall: 1, temperature_2m: 0 }, pos).map((f) => f.properties.kind).join() === 'snow,ice' &&
      s({ wind_speed_10m: 50 }, pos).map((f) => f.properties.kind).join() === 'wind' &&
      s({ weather_code: 48 }, pos).map((f) => f.properties.kind).join() === 'fog' &&
      s(null, pos).length === 0 && s({ precipitation: 3.9, wind_speed_10m: 49 }, pos).length === 0;
  })());
  ok('alertPoint: a point is itself, a polygon its ring centroid, no geometry → null',
    A.overlays._alertPoint({ type: 'Point', coordinates: [1, 2] })[0] === 1 &&
    JSON.stringify(A.overlays._alertPoint({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] })) === '[1,1]' &&
    A.overlays._alertPoint(null) === null);
  ok('movedFar: a pan or a zoom beyond the threshold refetches, a wobble does not',
    A.overlays._movedFar(null, {}, 0.2) === true &&
    A.overlays._movedFar({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }, { minLat: 0.05, minLng: 0.05, maxLat: 1.05, maxLng: 1.05 }, 0.2) === false &&
    A.overlays._movedFar({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }, { minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 }, 0.2) === true);

  // Settings section through the hook.
  A.ui.openPanel('profile');
  await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 2000);
  const host = doc.getElementById('settings-host');
  ok('the "Map overlays" settings section renders through the hook with its four controls', /Map overlays/.test(host.textContent) && /Radar color/.test(host.textContent) && /Hazards/.test(host.textContent));

  // Stand-down.
  held = false;
  A.store.emit('packs', A.packs.state());
  ok('the \'packs\' event with the pack no longer held hides the control, hides the layers and clears the pins',
    doc.getElementById('ctl-hazard').hidden === true && fm._layout.weather === 'none' && fm._layout.traffic === 'none' && hz().length === 0);
  A.overlays.openReport();
  ok('openReport() refuses while unheld', doc.getElementById('hazard-report').hidden === true);
  held = true;
  A.store.emit('packs', A.packs.state());
  await H.sleep(20);
  ok('held again → the control is back and the layers the settings ask for return', doc.getElementById('ctl-hazard').hidden === false && fm._layout.weather === 'visible');

  /* ================= O4 ================= */
  group('O4 — the server half against a fake ctx');
  const half = require('../server/packs/overlays.js');
  const sent = [];
  const limits = {};
  const clients = new Map();
  const mk = (id, pos, packs, ip) => { const c = { id, pos, ip: ip || '10.0.0.1', packs: new Set(packs || [PACK]), profile: { name: id } }; clients.set(id, c); return c; };
  const ctx = {
    json: (res, status, obj) => { res.status = status; res.body = obj; },
    clientIp: () => '203.0.113.9',
    rateOk: (key, n) => { limits[key] = (limits[key] || 0) + 1; return limits[key] <= n; },
    validPos: (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90,
    B: { haversine: (a, b) => { const dx = (a[0] - b[0]) * 111000 * Math.cos(a[1] * Math.PI / 180), dy = (a[1] - b[1]) * 111000; return Math.sqrt(dx * dx + dy * dy); } },
    send: (c, m) => sent.push([c.id, m]),
    cleanText: (v, max, dflt) => (typeof v === 'string' && v.trim() ? v.replace(/[<>]/g, '').slice(0, max) : dflt),
    liteOf: (c) => ({ id: c.id, name: c.profile.name }),
    NEARBY_KM: 30,
    clients,
    blockedPair: (a, b) => (a.id === 'reporter' && b.id === 'blocked') || (a.id === 'blocked' && b.id === 'reporter'),
    CORS_HEADERS: { 'Access-Control-Allow-Origin': '*' }
  };
  delete process.env.TOMTOM_KEY;
  {
    const res = {};
    await half.routes[0][2]({ method: 'GET' }, res, [], { id: 'u' }, ctx);
    ok('caps without a key: traffic and incidents false', res.status === 200 && res.body.traffic === false && res.body.incidents === false);
    const r2 = {};
    await half.routes[1][2]({ method: 'POST' }, r2, [], { id: 'u' }, ctx, { bottomLeft: [0, 51], topRight: [1, 52] });
    ok('incidents without a key: 503, not an upstream call', r2.status === 503);
    const r3 = {};
    await half.routes[1][2]({ method: 'POST' }, r3, [], { id: 'u' }, ctx, { bottomLeft: ['a', 51], topRight: [1, 52] });
    const r4 = {};
    await half.routes[1][2]({ method: 'POST' }, r4, [], { id: 'u' }, ctx, null);
    const r5 = {};
    await half.routes[1][2]({ method: 'POST' }, r5, [], { id: 'u' }, ctx, { bottomLeft: [2, 51], topRight: [1, 52] });
    ok('incidents: a bad, missing or inverted bbox is a 400', r3.status === 400 && r4.status === 400 && r5.status === 400);
    const tileRes = { writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    await half.routes[2][2]({ method: 'GET' }, tileRes, ['', '13', '1410', '3273'], { id: 'u' }, ctx);
    ok('a tile without a key: 503', tileRes.status === 503);
    const bad = { writeHead(s) { this.status = s; }, end() {} };
    await half.routes[2][2]({ method: 'GET' }, bad, ['', '3', '9', '1'], { id: 'u' }, ctx);
    ok('a tile out of bounds for its zoom: 400 before any quota is spent', bad.status === 400);
    const budget = { writeHead(s) { this.status = s; }, end() {} };
    process.env.TOMTOM_KEY = 'k';
    limits['ovl-tile:203.0.113.9'] = 300;
    await half.routes[2][2]({ method: 'GET' }, budget, ['', '13', '1410', '3273'], { id: 'u' }, ctx);
    ok('the 301st tile in a minute from one IP is 429 (shared rateOk bucket)', budget.status === 429);
    delete process.env.TOMTOM_KEY;
  }
  {
    const reporter = mk('reporter', [-0.1, 51.5]);
    mk('near', [-0.12, 51.52]);
    mk('far', [2.5, 48.8]);
    mk('nopack', [-0.11, 51.51], []);
    mk('blocked', [-0.11, 51.49]);
    const h = half.ws['overlays:report'];
    h(reporter, { lat: 51.505, lng: -0.1, kind: 'ice', label: 'Black <ice>' }, ctx);
    const got = sent.filter((s) => s[1].t === 'overlays:hazard').map((s) => s[0]);
    ok('a report fans out only to the nearby holder: not the far rider, not the one without the pack, not the blocked pair',
      got.join() === 'near', got.join());
    const frame = sent.find((s) => s[1].t === 'overlays:hazard')[1];
    ok('the frame carries the reporter (liteOf + by), the cleaned label and the kind', frame.by === 'reporter' && frame.from.id === 'reporter' && frame.label === 'Black ice' && frame.kind === 'ice');
    sent.length = 0;
    h(reporter, { lat: 52.9, lng: -0.1, kind: 'ice' }, ctx);
    ok('a report far from the reporter\'s own position is refused with an err frame to them alone', sent.length === 1 && sent[0][0] === 'reporter' && sent[0][1].t === 'err');
    sent.length = 0;
    h(reporter, { lat: 51.505, lng: -0.1, kind: 'constructor', label: 42 }, ctx);
    ok('an unknown kind becomes "hazard", a non-string label becomes empty', sent[0][1].kind === 'hazard' && sent[0][1].label === '');
    sent.length = 0;
    let threw = null;
    try {
      h(reporter, null, ctx); h(reporter, {}, ctx); h(reporter, { lat: 'a', lng: 'b' }, ctx); h(reporter, { lat: NaN, lng: 1 }, ctx);
      h(reporter, { lat: 51.5, lng: -0.1, kind: ['x'], label: { a: 1 } }, ctx); h({ id: 'nopos', ip: '1.1.1.1', packs: new Set([PACK]) }, { lat: 51.5, lng: -0.1 }, ctx);
    } catch (e) { threw = e; }
    ok('malformed frames never throw (null, empty, strings, NaN, arrays, a socket with no position)', threw === null, threw && threw.message);
    sent.length = 0;
    limits['ovl-report:10.0.0.1'] = 20;
    h(reporter, { lat: 51.505, lng: -0.1, kind: 'fog' }, ctx);
    ok('the 21st report in a minute from one IP is refused', sent.length === 1 && /slow down/.test(sent[0][1].msg));
  }

  /* ================= O5 ================= */
  group('O5 — tomtom-extras.toFeatures');
  {
    const x = require('../server/packs/overlays/tomtom-extras.js');
    const fc = x.toFeatures({ incidents: [
      { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }, properties: { iconCategory: 1, events: [{ description: 'Pile-up' }] } },
      { geometry: { type: 'Point', coordinates: [5, 5] }, properties: { iconCategory: 6 } },      // jam: dropped
      { geometry: { type: 'Point', coordinates: [6, 6] }, properties: { iconCategory: 'constructor' } },
      { geometry: null, properties: { iconCategory: 5 } },
      { geometry: { type: 'Point', coordinates: [7, 7] }, properties: { iconCategory: 14 } }
    ] });
    ok('kinds map, a LineString pins at its midpoint, jams/unknown/no-geometry are dropped, the label is the first event',
      fc.features.length === 2 && fc.features[0].properties.kind === 'accident' && fc.features[0].properties.label === 'Pile-up' &&
      JSON.stringify(fc.features[0].geometry.coordinates) === '[1,1]' && fc.features[1].properties.kind === 'stopped');
    ok('a malformed upstream body is null (→ 502), not a throw', x.toFeatures({}) === null && x.toFeatures(null) === null);
    const many = { incidents: [] };
    for (let i = 0; i < 400; i++) many.incidents.push({ geometry: { type: 'Point', coordinates: [i, i] }, properties: { iconCategory: 1 } });
    ok('the pin count is capped at ' + x.INCIDENT_CAP, x.toFeatures(many).features.length === x.INCIDENT_CAP);
  }

  process.exit(report());
})().catch((e) => { console.error(e); process.exit(1); });
