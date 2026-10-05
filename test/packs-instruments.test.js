/* Convoy — instruments feature pack (packs/instruments).
   `npm test` (test/run.js picks up test/packs-*.test.js), or:
     node test/packs-instruments.test.js

   What is pinned:
     I1  the contract — manifest valid through the real registry, every file
         listed, no server half, nothing regulated
     I2  in the real page, through the loader's own mountFragment + the scripts
         eval'd in order: settings registered with the old defaults, the rail
         built in rank order, body.pack-instruments as the one visibility
         switch, the Ⓟ control, and each instrument's behaviour from the same
         bus events the core emits: speedo (Doppler → mph), tripmeter (deltas,
         teleports rejected), g-meter (plausibility clamp), overspeed (banner
         + beep hysteresis), dimmer, destination arrow (route-gated), route-card
         extras (share/save buttons, arrival weather through U.fetchT), drive
         log (a trip recorded from 'trip'/'tick' and persisted), parking pin
         (auto on arrival, Ⓟ toggles), the settings and profile sections through
         the hooks, stand-down on the 'packs' event */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

const PACK = 'instruments';
const DIR = path.join(ROOT, 'packs', PACK);
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'pack.json'), 'utf8'));

(async function main() {
  group('I1 — the contract');
  {
    const packs = require('../server/packs');
    let err = null;
    try { packs._reset(); packs.load({ hello() {}, pos() {} }); } catch (e) { err = e; }
    ok('the registry loads packs/ with instruments in it', !err && packs.has(PACK), err && err.message);
    const onDisk = fs.readdirSync(DIR).filter((f) => /\.(js|css|html)$/.test(f)).sort();
    const listed = [].concat(manifest.scripts, manifest.styles, manifest.fragments.map((f) => f.file)).sort();
    ok('every file on disk is in pack.json (' + onDisk.length + ')', JSON.stringify(onDisk) === JSON.stringify(listed));
    ok('hud.js is first (it registers the settings and the rail every widget needs) and ui.js last', manifest.scripts[0] === 'hud.js' && manifest.scripts[manifest.scripts.length - 1] === 'ui.js');
    ok('no server half, nothing regulated', !fs.existsSync(path.join(ROOT, 'server', 'packs', PACK + '.js')) && manifest.legal === null);
  }

  group('I2 — the client in the real page');
  const { win, doc, A } = H.bootRealUi();
  A.store.load();
  A.ui.init();
  // Fakes: a map, MapLibre's Marker/Popup, fetch (Open-Meteo), the pack loader's view.
  const markers = [];
  win.maplibregl = {
    Marker: function (o) { this.o = o; this.setLngLat = (p) => { this.p = p; return this; }; this.addTo = () => { markers.push(this); this.on = true; return this; }; this.remove = () => { this.on = false; }; },
    Popup: function () { this.setLngLat = () => this; this.setDOMContent = (el) => { this.el = el; return this; }; this.addTo = () => this; this.remove = () => {}; }
  };
  const fm = { getBearing: () => 90, on() {}, flyTo() { this.flew = true; }, getZoom: () => 14 };
  A.mapview.map = () => fm;
  A.mapview.setTrailData = (d) => { fm.trail = d; };
  A.mapview.fitRoute = () => {};
  const FETCHES = [];
  const fakeFetch = (url) => {
    FETCHES.push(String(url));
    const reply = (obj) => Promise.resolve({ ok: true, status: 200, json: async () => obj });
    if (/hourly=/.test(url)) return reply({ hourly: { time: [new Date(Date.now() + 600000).toISOString()], temperature_2m: [61], precipitation_probability: [40], weather_code: [2] } });
    if (/current=/.test(url)) return reply({ current: { temperature_2m: 64, weather_code: 2 } });
    return reply({});
  };
  win.fetch = fakeFetch; global.fetch = fakeFetch;
  let curPos = [-0.1, 51.5];
  A.sim.playerPos = () => curPos.slice();
  A.sim.playerHeading = () => 45;
  let held = true;
  A.packs.has = (id) => id === PACK && held;
  A.packs.holds = A.packs.has;
  let registered = null;
  A.packs.register = (id, def) => { registered = { id, def }; };
  const toasts = [];
  A.ui.toast = (m) => toasts.push(m);

  manifest.fragments.forEach((f) => A.packs._mountFragment({ mount: f.mount, position: f.position, html: fs.readFileSync(path.join(DIR, f.file), 'utf8') }));
  let evalErr = null;
  try { manifest.scripts.forEach((f) => win.eval(fs.readFileSync(path.join(DIR, f), 'utf8'))); } catch (e) { evalErr = e; }
  ok('all ' + manifest.scripts.length + ' scripts evaluate against the real core chain', evalErr === null, evalErr && (evalErr.stack || evalErr.message));
  const st = A.state.settings;
  ok('settings registered with the old defaults (speedo/compass/clock on, the rest off, alert 0, dimmer 0, auto park on)',
    st.showSpeedo === true && st.showCompass === true && st.showClock === true && st.showTripmeter === false && st.showGforce === false &&
    st.showWeatherNow === false && st.showBattery === false && st.showCoords === false && st.showDestArrow === false &&
    st.speedAlert === 0 && st.nightDim === 0 && st.autoParkPin === true);
  ok('init registered through A.packs.register("instruments")', registered && registered.id === PACK);
  registered.def.init();
  ok('held → body.pack-instruments is on and the Ⓟ control is shown', doc.body.classList.contains('pack-instruments') && doc.getElementById('ctl-park').hidden === false);
  const rail = doc.getElementById('hud-rail');
  const ranks = Array.from(rail.children).map((c) => c.dataset.rank);
  ok('the rail holds the eight rail cards in rank order (' + ranks.join(' ') + ')',
    JSON.stringify(ranks) === JSON.stringify(['hud-compass', 'hud-clock', 'hud-trip', 'hud-gmeter', 'hud-weather', 'hud-battery', 'hud-coords', 'hud-dest']));
  ok('only the default-on cards are visible (compass, clock); battery hides itself without the API',
    rail.querySelector('.hud-compass').style.display === '' && rail.querySelector('.hud-clock').style.display === '' &&
    rail.querySelector('.hud-trip').style.display === 'none' && rail.querySelector('.hud-battery').style.display === 'none');
  ok('the clock renders a time and the next sun event', /\d/.test(doc.getElementById('clk-v').textContent) && /(sunrise|sunset|polar)/.test(doc.getElementById('clk-s').textContent));
  ok('the compass reads the GPS heading (45° NE)', doc.getElementById('cmp-deg').textContent === '45°' && doc.getElementById('cmp-card').textContent === 'NE');

  // Speedometer: Doppler speed in m/s → mph.
  const t0 = Date.now();
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0, speed: 20, heading: 45 });
  ok('speedo: 20 m/s reads 45 mph', doc.getElementById('speedo-v').textContent === '45' && doc.getElementById('speedo-u').textContent === 'mph');

  // Tripmeter: real deltas, teleports rejected.
  A.store.setSetting('showTripmeter', true);
  curPos = [-0.1, 51.501];                                       // ~111 m north
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0 + 5000, speed: 20, heading: 0 });
  const m1 = A.tripmeter._meters();
  curPos = [0.5, 51.9];                                          // a 60 km teleport in 5 s
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0 + 10000, speed: 20, heading: 0 });
  ok('tripmeter: a 111 m leg counts, a 60 km teleport in 5 s does not', m1 > 100 && m1 < 125 && A.tripmeter._meters() === m1, m1 + ' → ' + A.tripmeter._meters());

  // G-meter: plausible accel recorded, an implausible spike dropped.
  A.store.setSetting('showGforce', true);
  curPos = [-0.1, 51.5];
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0 + 20000, speed: 10, heading: 0 });
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0 + 21000, speed: 15, heading: 0 });
  const p1 = A.gmeter._peak();
  A.store.emit('gpsfix', { pos: curPos.slice(), t: t0 + 22000, speed: 45, heading: 0 });   // +30 m/s in 1 s = 3 g: noise
  ok('g-meter: +5 m/s in 1 s → 0.51 g peak; a 3 g spike is rejected', p1 > 0.5 && p1 < 0.52 && A.gmeter._peak() === p1, p1 + ' → ' + A.gmeter._peak());

  // Overspeed: banner tracks the limit, the beep re-arms 2 units below.
  A.store.setSetting('speedAlert', 30);
  const banner = doc.getElementById('overspeed-banner');
  A.speedalert._onSpeed(15);    // 33.55 mph → "34 mph"
  const on1 = banner.classList.contains('on'), armedAfter = A.speedalert._armed();
  A.speedalert._onSpeed(13.2);  // 29.5 mph: under the limit, inside the 2 mph hysteresis
  const off1 = !banner.classList.contains('on'), stillDisarmed = !A.speedalert._armed();
  A.speedalert._onSpeed(12);    // 26.8 mph: re-arm
  ok('overspeed: banner on at 34 mph (beep fired, disarmed), off at 29.5 (still disarmed), re-armed at 27',
    on1 && !armedAfter && off1 && stillDisarmed && A.speedalert._armed() && /34 mph/.test(banner.textContent), banner.textContent);
  A.store.setSetting('speedAlert', 0);

  // Dimmer.
  A.store.setSetting('nightDim', 0.3);
  const dim = doc.getElementById('night-dim');
  ok('night dimmer: 0.3 → the scrim is shown at opacity .3; 0 hides it', dim.style.opacity === '0.3' && dim.style.display === '' && (A.store.setSetting('nightDim', 0), dim.style.display === 'none'));

  // Destination arrow + route-card extras.
  A.store.setSetting('showDestArrow', true);
  ok('destination arrow hides without a route', rail.querySelector('.hud-dest').style.display === 'none');
  A.state.route = { label: 'Brighton Pier', dest: [-0.14, 50.82], distance: 85000, duration: 5400, coords: [], cum: [] };
  A.routing.renderEtaCard();
  A.store.emit('route', A.state.route);
  await H.sleep(20);
  const card = doc.getElementById('eta-card');
  ok('with a route: the arrow shows with the straight-line distance', rail.querySelector('.hud-dest').style.display === '' && /mi/.test(doc.getElementById('da-s').textContent));
  ok('the route card gets the share and save buttons, and the arrival weather line through U.fetchT',
    !!card.querySelector('#eta-share') && !!card.querySelector('#eta-save') && /on arrival/.test((card.querySelector('#eta-wx') || {}).textContent || '') &&
    FETCHES.some((u) => /hourly=/.test(u)), (card.querySelector('#eta-wx') || {}).textContent);
  card.querySelector('#eta-save').click();
  ok('saving the place stars it and the profile list knows it', card.querySelector('#eta-save').classList.contains('saved') && A.places.list().length === 1 && A.places.list()[0].label === 'Brighton Pier');
  ok('share text names the destination and the ETA', /Heading to Brighton Pier, ETA .*Sent from Convoy/.test(A.tripextras._shareText()));

  // Drive log: a trip recorded from the bus, persisted, finalized on arrival.
  A.state.trip = { active: true, live: true, gotFix: true, baseSpeed: 20, mult: 1, line: { total: 85000 }, progress: 0 };
  A.store.emit('trip', A.state.trip);
  ok('a trip starting begins a recording', A.triplog._recording());
  const lat0 = 51.5;
  // The recorder samples on the 1 Hz tick and needs wall time between samples (dt > 0).
  for (let i = 0; i < 5; i++) { curPos = [-0.1, lat0 + i * 0.001]; A.triplog._sample(); await H.sleep(12); }
  A.state.trip = null; A.state.route = null;
  A.store.emit('trip', null);
  const log = A.triplog.list();
  ok('arriving finalizes it: one logged trip of ~440 m, odometer advanced, persisted to localStorage',
    log.length === 1 && log[0].dist > 400 && log[0].dist < 480 && log[0].arrived === true && A.triplog.stats().odoM === log[0].dist &&
    JSON.parse(win.localStorage.getItem('convoy.triplog.v1')).trips.length === 1, JSON.stringify(log[0] && { dist: log[0].dist, arrived: log[0].arrived }));
  ok('…and the auto parking pin dropped where the trip ended (a marker on the map, the Ⓟ control lit)',
    !!A.places.park() && markers.length === 1 && markers[0].on && doc.getElementById('ctl-park').classList.contains('active') && toasts.some((t) => /Parking pin dropped at your destination/.test(t)));
  doc.getElementById('ctl-park').click();
  ok('Ⓟ with a pin flies to the car', fm.flew === true);
  A.places.clearPark();
  ok('clearing lifts the marker and the control', !A.places.park() && markers[0].on === false && !doc.getElementById('ctl-park').classList.contains('active'));
  doc.getElementById('ctl-park').click();
  ok('Ⓟ with no pin drops one at the rider', !!A.places.park() && markers.length === 2);
  ok('the tripmeter ignored the recorder\'s samples (no gpsfix) — the two are independent', A.tripmeter._meters() === m1);

  // Hooks: settings + profile.
  A.ui.openPanel('profile');
  await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 2000);
  const host = doc.getElementById('settings-host');
  const pbody = doc.getElementById('profile-body');
  ok('the "Instruments" settings section renders through the hook (nine switches, dimmer, overspeed, auto park)',
    /Instruments/.test(host.textContent) && /Night dimmer/.test(host.textContent) && /Overspeed alert/.test(host.textContent) && /Auto parking pin/.test(host.textContent));
  ok('the profile page gets the Drive log (with the trip) and Saved places (with the pier)',
    /Drive log/.test(pbody.textContent) && /Brighton Pier/.test(pbody.querySelector('.drive-log').textContent) && /Saved places/.test(pbody.textContent) && /Brighton Pier/.test(pbody.querySelector('.saved-places').textContent));

  // Stand-down.
  held = false;
  A.store.emit('packs', {});
  ok('the \'packs\' event with the pack no longer held drops body.pack-instruments, hides Ⓟ and lifts the marker',
    !doc.body.classList.contains('pack-instruments') && doc.getElementById('ctl-park').hidden === true && markers[1].on === false);
  A.speedalert._onSpeed(40);
  ok('…and the overspeed banner stays off while unheld', !banner.classList.contains('on'));
  held = true;
  A.store.emit('packs', {});
  ok('held again → the switch and the control come back', doc.body.classList.contains('pack-instruments') && doc.getElementById('ctl-park').hidden === false);

  process.exit(report());
})().catch((e) => { console.error(e); process.exit(1); });
