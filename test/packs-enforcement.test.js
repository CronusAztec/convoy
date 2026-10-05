/* Convoy — the enforcement feature pack (packs/enforcement + server/packs/enforcement.js).
   `npm test` (test/run.js picks up test/packs-<id>.test.js by name), or:
     node test/packs-enforcement.test.js

   WHAT IS PINNED, AND WHY. The pack is the enforcement feature set that the
   store cut withdrew, restored on the hook points the core exposes. The
   compliance argument (packs/README.md) only holds if the pack really is
   served, not shipped, and really does gate what is regulated:

     A  the manifest is valid for the registry, the files obey the pack
        discipline (every fetch through U.fetchT, pollers through U.poll, no
        backdrop-filter, no font under 12px, the one infinite animation on
        transform), and every element id a script asks for resolves on the
        page AS MOUNTED by the fragments
     B  the real loader (js/packs.js) mounts the pack against the real core
        chain in jsdom: settings land with the right defaults, the HUD and
        controls mount, the settings section renders, the legality notice
        gates the radar and the route-avoid switch, the pack stands down on
        sign-out and comes back on the next grant
     C–D  the old client suites, ported: the view-bbox clamp (ghostbbox) and the
        range-ring push guard (radarrings)
     E  the server half against a fake ctx: every route, malformed input,
        rate limits, the kill switches, the 'enforcement:report' handler's
        proximity gate, budget, block pairs and holder-only fan-out
     F–H  the old server suites, ported: aircraft, overpass, hotspots (now with
        persistence through a fake ctx.db.query)
     I  the boundary: the scraped hosts live in police-finder.js and nowhere
        else, never in anything a rider's device can receive — the pack
        included; the collectors reach the model without an HTTP ingest
     J  the collector inbox */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

const PACK = path.join(ROOT, 'packs', 'enforcement');
const SERVER = path.join(ROOT, 'server', 'packs', 'enforcement');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readPack = (f) => fs.readFileSync(path.join(PACK, f), 'utf8');
const manifest = JSON.parse(readPack('pack.json'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-enf-'));

// Registry validation reads packs/ from this env at require time.
process.env.CONVOY_PACKS_DIR = path.join(ROOT, 'packs');
delete process.env.CONVOY_PACKS_SERVER_DIR;
delete process.env.ENFORCEMENT_COLLECTOR;
delete process.env.ENFORCEMENT_INBOX_DIR;
delete process.env.OPENWEBNINJA_KEY;
delete process.env.RAPIDAPI_KEY;

(async function main() {

  /* ================= A — manifest + discipline ================= */
  group('A — packs/enforcement/pack.json is valid for the registry and the files obey the pack discipline');
  {
    const registry = require('../server/packs');
    let err = null, m = null;
    try { m = registry._validateManifest('enforcement', manifest); } catch (e) { err = e; }
    ok('the manifest validates (id, title, blurb, scripts, styles, fragments all present on disk)', !err && !!m, err && err.message);
    ok('legal key is "radar" and the blurb is the one the task names', m && m.legal === 'radar' && /radar HUD with sonar/.test(m.blurb));
    ok('settings.js is the FIRST script and boot.js the LAST (register + init run after the whole pack loaded)',
      manifest.scripts[0] === 'settings.js' && manifest.scripts[manifest.scripts.length - 1] === 'boot.js', manifest.scripts.join(','));
    ok('the controls fragment mounts after #ctl-global, the HUD appends to body',
      manifest.fragments.some((f) => f.file === 'controls.html' && f.mount === '#ctl-global' && f.position === 'after') &&
      manifest.fragments.some((f) => f.file === 'hud.html' && f.mount === 'body' && f.position === 'append'));
    ok('#ctl-global exists in the current index.html (the mount point is real)', /id="ctl-global"/.test(read('index.html')));

    const scripts = manifest.scripts.map((s) => ({ name: s, src: readPack(s) }));
    const bare = scripts.filter((s) => /(^|[^A-Za-z0-9_.$])fetch\(/.test(s.src)).map((s) => s.name);
    ok('no pack script calls fetch() bare — every request goes through U.fetchT', bare.length === 0, bare.join(','));
    ok('ghost.js runs its visual pollers through U.poll/unpoll, never setInterval', !/setInterval\(/.test(readPack('ghost.js')) && /U\.poll\(/.test(readPack('ghost.js')));
    ok('every script is an IIFE that hangs off window.App and exports only on A.enforcement',
      scripts.every((s) => /^\(function \(\) \{\s*'use strict';\s*var A = window\.App;/m.test(s.src.replace(/^\/\*[\s\S]*?\*\/\s*/, ''))) &&
      scripts.every((s) => !/^\s*(var|let|const|function)\s+\w+/m.test(s.src.replace(/^\/\*[\s\S]*?\*\/\s*/, '').replace(/^\(function \(\) \{[\s\S]*$/m, ''))));
    ok('no pack script reaches A.lazy or A.appBoot (the pack loads eagerly)', scripts.every((s) => !/A\.lazy\b|A\.appBoot/.test(s.src)));
    ok('no pack script mentions Bluetooth, BLE, SABRE or the detector plugin', scripts.every((s) => !/bluetooth|\bBLE\b|SABRE|RadarDetector|detectorAuto|detectorUpload/i.test(s.src)));
    ok('every socket type the pack sends or listens for is namespaced enforcement:',
      scripts.every((s) => (s.src.match(/t:\s*'([a-z:]+)'/g) || []).every((x) => /t:\s*'enforcement:/.test(x))) &&
      scripts.every((s) => (s.src.match(/A\.net\.on\('([^']+)'/g) || []).every((x) => /'enforcement:/.test(x))));
    ok('every HTTP path the pack calls is under /api/enforcement/ (plus the core\'s nothing else)',
      scripts.every((s) => (s.src.match(/'\/api\/[a-z/-]+'/g) || []).every((x) => /^'\/api\/enforcement\//.test(x))));

    const css = readPack('enforcement.css');
    ok('the stylesheet has no backdrop-filter', !/backdrop-filter/.test(css));
    const small = (css.match(/font-size:\s*([\d.]+)px/g) || []).map((x) => parseFloat(x.replace(/[^\d.]/g, ''))).filter((n) => n < 12);
    ok('no font-size below 12px', small.length === 0, small.join(','));
    const infinite = (css.match(/animation:[^;]*infinite/g) || []);
    ok('exactly one infinite animation (the sweep), and its keyframes touch only transform', infinite.length === 1 && /rsRotate/.test(infinite[0]) &&
      /@keyframes rsRotate \{\s*to \{ transform: rotate\(360deg\); \}\s*\}/.test(css), infinite.join(' | '));
    ok('the HUD markup is hidden unless body.radar-on', /#radar-alerts, #radar-side, #radar-dock \{ display: none; \}/.test(css) && /body\.radar-on #radar-dock \{ display: flex; \}/.test(css));
  }

  /* ================= B — the real loader, the real core chain ================= */
  group('B — js/packs.js mounts the pack in jsdom: settings, fragments, the settings section, the legality gate, stand-down');
  let A, win, doc, E, FETCHES = [];
  {
    const booted = H.bootRealUi();
    win = booted.win; doc = booted.doc; A = booted.A;
    A.store.load();
    A.ui.init();

    // Every element id a script asks for must resolve on the page as mounted —
    // check the fragments first (they mount before the scripts run).
    manifest.fragments.forEach((f) => A.packs._mountFragment({ mount: f.mount, position: f.position, html: readPack(f.file) }));
    const wanted = new Set();
    manifest.scripts.forEach((s) => (readPack(s).match(/getElementById\('([^']+)'\)/g) || []).forEach((x) => wanted.add(x.replace(/.*\('|'\)/g, ''))));
    const missing = [...wanted].filter((id) => !doc.getElementById(id));
    ok('every document.getElementById(...) in the pack resolves on the mounted page (' + wanted.size + ' ids)', missing.length === 0, 'missing: ' + missing.join(','));
    const ctl = doc.getElementById('ctl-radar');
    ok('#ctl-radar and #ctl-loop sit in the right-hand control column directly after #ctl-global',
      !!ctl && ctl.previousElementSibling && ctl.previousElementSibling.id === 'ctl-global' && ctl.parentNode.classList.contains('map-controls') &&
      ctl.nextElementSibling && ctl.nextElementSibling.id === 'ctl-loop');
    ok('the HUD (#radar-alerts, #radar-side, #radar-dock, #radar-fx, #radar-sweep) is in <body>',
      ['radar-alerts', 'radar-side', 'radar-dock', 'radar-fx', 'radar-sweep'].every((id) => doc.getElementById(id) && doc.getElementById(id).parentNode === doc.body));
    ok('the mounted controls start hidden (nothing shows before the grant is known)', ctl.hidden === true && doc.getElementById('ctl-loop').hidden === true);
    // Mount again the way the loader will (idempotent markup is not required;
    // the loader mounts once) — remove our pre-mount so the real load is clean.
    ['ctl-radar', 'ctl-loop', 'radar-alerts', 'radar-side', 'radar-dock', 'radar-fx', 'radar-sweep'].forEach((id) => { const el = doc.getElementById(id); if (el) el.remove(); });

    // A scripted server: the manifest with THIS pack, the caps probe, and empty answers for the data routes.
    let manifestStatus = 200;
    const packManifest = () => ({
      packs: [{ id: 'enforcement', title: manifest.title, blurb: manifest.blurb, legal: 'radar',
        scripts: manifest.scripts.map((s) => '/packs/enforcement/' + s + '?t=T1'),
        styles: manifest.styles.map((s) => '/packs/enforcement/' + s + '?t=T1'),
        fragments: manifest.fragments.map((f) => ({ mount: f.mount, position: f.position, html: readPack(f.file) })) }],
      available: []
    });
    const fakeFetch = (url, opts) => {
      FETCHES.push({ url: String(url), method: (opts && opts.method) || 'GET', auth: opts && opts.headers && opts.headers.Authorization });
      const reply = (status, obj) => Promise.resolve({ ok: status < 400, status, json: async () => obj });
      if (/\/api\/packs\/catalog$/.test(url)) return reply(200, { packs: [] });
      if (/\/api\/packs$/.test(url)) return reply(manifestStatus, manifestStatus === 200 ? packManifest() : { error: 'unauthorized' });
      if (/\/api\/enforcement\/caps/.test(url)) return reply(200, { waze: true, wazeKey: false, hotspots: true, aircraft: true, overpass: true });
      if (/\/api\/enforcement\/hotspots/.test(url)) return reply(200, { type: 'FeatureCollection', features: [] });
      if (/\/api\/enforcement\/aircraft/.test(url)) return reply(200, { aircraft: [] });
      if (/\/api\/enforcement\//.test(url)) return reply(200, { type: 'FeatureCollection', features: [], elements: [] });
      return reply(404, {});
    };
    global.fetch = fakeFetch; win.fetch = fakeFetch;
    // jsdom never loads a stylesheet: fire the link's onload like group F of test/packs.test.js.
    const realAppend = doc.head.appendChild.bind(doc.head);
    doc.head.appendChild = (el) => { const r = realAppend(el); if (el.tagName === 'LINK' && el.onload) setTimeout(() => el.onload(), 0); return r; };
    const loadErrors = [];
    const realErr = console.error;
    console.error = (...a) => { loadErrors.push(a.map(String).join(' ')); };

    A.packs.init();
    A.store.setAuth({ token: 'tok-held', username: 'holder' });   // 'auth' → sync() → GET /api/packs → load
    await H.waitFor(() => A.packs.has('enforcement') && A.enforcement && A.enforcement.caps, 5000);
    console.error = realErr;
    E = A.enforcement;
    ok('the loader fetched the manifest with the bearer, ran the 7 scripts in order and the pack registered + initialised',
      A.packs.has('enforcement') && !!E && !!E.map && !!E.ghost && !!E.radar && !!E.routing && !!E.ui && typeof E.init === 'function',
      loadErrors.join('\n') || ('has=' + A.packs.has('enforcement')));
    ok('no error was logged while the pack loaded', loadErrors.filter((l) => !/network disabled/.test(l)).length === 0, loadErrors.join('\n'));
    const S = A.state;
    ok('settings registered with the right defaults: regulated ones OFF (radar, avoidPolice), the filters and sonar as before',
      S.settings.radar === false && S.settings.avoidPolice === false && S.settings.radarGhost === false &&
      S.settings.sonarVol === 0.8 && S.settings.heartSense === 'normal' && S.settings.pingRate === 'normal' &&
      S.settings.ghostPolice === true && S.settings.ghostCamera === true && S.settings.ghostAlpr === true && S.settings.ghostHotspots === true &&
      S.settings.ghostAir === true && S.settings.ghostHeli === true &&
      ['ghostAirCiv', 'ghostAirMil', 'ghostAirPolice', 'ghostAirEms', 'ghostAirUnknown'].every((k) => S.settings[k] === true),
      JSON.stringify(S.settings));
    ok('setSetting() accepts the pack keys', (A.store.setSetting('pingRate', 'fast'), S.settings.pingRate === 'fast' && (A.store.setSetting('pingRate', 'normal'), true)));
    ok('the fragments were mounted by the loader (controls after #ctl-global, HUD in body) and the controls are now visible (held)',
      doc.getElementById('ctl-radar') && doc.getElementById('ctl-radar').previousElementSibling.id === 'ctl-global' &&
      doc.getElementById('radar-dock') && doc.getElementById('radar-dock').parentNode === doc.body &&
      doc.getElementById('ctl-radar').hidden === false && doc.getElementById('ctl-loop').hidden === false);
    ok('the caps probe went to POST /api/enforcement/caps with the bearer and landed on A.enforcement.caps',
      FETCHES.some((f) => /\/api\/enforcement\/caps$/.test(f.url) && f.method === 'POST' && f.auth === 'Bearer tok-held') && E.caps && E.caps.waze === true && E.caps.hotspots === true);
    ok('with the radar off nothing runs: no HUD, no loops, no layers', !doc.body.classList.contains('radar-on') && !E.ghost.isRunning() && !E.radar.isActive() && E._applied() === false);

    // The settings section renders through the 'settings' hook.
    A.ui.openPanel('profile');
    await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 3000);
    const host = doc.getElementById('settings-host');
    const text = host ? host.textContent : '';
    ok('the Settings box carries the pack\'s sections: Enforcement awareness, Routing, Radar audio, Police & cameras, Aircraft',
      ['Enforcement awareness', 'Avoid police & cameras', 'Radar audio', 'Police & cameras', 'Aircraft', 'Unidentified', 'Police hotspots', 'ALPR cameras'].every((t) => text.indexOf(t) >= 0), text.slice(0, 200));
    ok('…before the core\'s Feature packs section', text.indexOf('Enforcement awareness') < text.indexOf('Feature packs'));
    const rowOf = (title) => Array.from(host.querySelectorAll('.setting-row')).find((r) => r.querySelector('.setting-text b') && r.querySelector('.setting-text b').textContent === title);
    const radarRow = rowOf('Radar'), avoidRow = rowOf('Avoid police & cameras');
    const radarToggle = radarRow && radarRow.querySelector('.toggle');
    ok('the Radar and Avoid toggles render off', !!radarToggle && !radarToggle.classList.contains('on') && !!avoidRow && !avoidRow.querySelector('.toggle').classList.contains('on'));

    // The legality gate.
    A.store.setConsent({ passenger: true, age: true, terms: true });
    radarToggle.click();
    let card = doc.querySelector('.modal-card');
    ok('switching the radar on opens the notice (the OLD text: title, Germany/France/…, "Never use it to evade") and has NOT switched it on',
      !!card && /Before you turn on radar/.test(card.textContent) && /Germany, France, Switzerland and Austria/.test(card.textContent) &&
      /Never use it to evade/.test(card.textContent) && /terms#features/.test(card.innerHTML) && S.settings.radar === false && !E.ghost.isRunning());
    Array.from(card.querySelectorAll('button')).find((b) => /Not now/.test(b.textContent)).click();
    ok('"Not now" leaves the radar off AND puts the toggle back', S.settings.radar === false && !radarToggle.classList.contains('on') && !A.store.featureAcked('radar'));
    radarToggle.click();
    card = doc.querySelector('.modal-card');
    Array.from(card.querySelectorAll('button')).find((b) => /I understand/.test(b.textContent)).click();
    await H.sleep(10);
    ok('"I understand" acknowledges and switches the radar on: setting, body.radar-on, loops, HUD, control lit',
      S.settings.radar === true && A.store.featureAcked('radar') && doc.body.classList.contains('radar-on') &&
      E.ghost.isRunning() && E.radar.isActive() && E._applied() === true &&
      doc.getElementById('ctl-radar').classList.contains('active') && doc.getElementById('ctl-radar').getAttribute('aria-pressed') === 'true');
    const st = E.ghost._state();
    ok('with caps saying hotspots + a live feed exist, the police and hotspot loops are armed and the legend shows', st.police === true && st.hotspots === true && st.legend === true, JSON.stringify(st));
    ok('the radar alert stack rendered its empty state on the first tick', /Scanning/.test(doc.getElementById('radar-alerts').textContent), doc.getElementById('radar-alerts').innerHTML.slice(0, 80));

    // The map control turns it off without a gate, and back on without a notice (acknowledged).
    doc.getElementById('ctl-radar').click();
    ok('#ctl-radar turns the radar off: setting, HUD, loops', S.settings.radar === false && !doc.body.classList.contains('radar-on') && !E.ghost.isRunning() && !E.radar.isActive());
    doc.getElementById('ctl-radar').click();
    const ob = doc.getElementById('onboarding');
    ok('…and back on without the notice (acknowledged under this Terms version): the overlay host is hidden or closing, never re-opened',
      S.settings.radar === true && (ob.hidden || ob.classList.contains('closing')) && E.ghost.isRunning(),
      'radar=' + S.settings.radar + ' hidden=' + ob.hidden + ' closing=' + ob.classList.contains('closing') + ' running=' + E.ghost.isRunning());
    // Avoid-police passes the same gate; acknowledged ⇒ immediate.
    avoidRow.querySelector('.toggle').click();
    ok('the Avoid police & cameras toggle proceeds through legalGate("radar") — already acknowledged, so at once', S.settings.avoidPolice === true);

    // The radar dock's STOP goes through the same funnel.
    doc.getElementById('radar-stop').click();
    ok('the HUD\'s STOP button turns the radar off through the funnel', S.settings.radar === false && !E.radar.isActive());

    // radarGhost pairs Invisible mode with the radar.
    A.store.setSetting('radarGhost', true);
    E.ui.setRadar(true);
    ok('with "Go invisible with the radar" on, switching the radar on also switches Invisible mode on (A.ui.applyGhost)', S.settings.radar === true && S.settings.ghost === true);
    E.ui.setRadar(false);
    ok('…and off again with it', S.settings.radar === false && S.settings.ghost === false);
    A.store.setSetting('radarGhost', false);

    // Another rider's report lands on the police layer through the pack's own socket type.
    const before = E.ghost._state().crowd;
    E.ghost._onReport({ t: 'enforcement:report', from: { id: 'u-other', name: 'Zed' }, lat: 34.05, lng: -118.25, label: 'Police sighting' });
    E.ghost._onReport({ t: 'enforcement:report', lat: 'x', lng: -118.25 });
    E.ghost._onReport({ t: 'enforcement:report', lat: 95, lng: 200 });
    ok('an inbound enforcement:report with valid coords is kept; malformed ones are dropped', E.ghost._state().crowd === before + 1);
    ok('the police layer cache carries it as a live police feature', E.map._cache.police.features.some((f) => f.properties.kind === 'police' && f.properties.crowd === true));
    ok('A.net.on refused nothing: the pack\'s type is not a core message (the handler registered)', (function () { let hit = 0; A.net.on('enforcement:report', () => { hit++; }); return hit === 0; })());

    // The routes hook never alters the list and only schedules work when it may.
    const routes = [{ distance: 1000, duration: 100, coords: [[-118.25, 34.05], [-118.245, 34.05], [-118.24, 34.05]], steps: [] }];
    A.store.setSetting('avoidPolice', false);
    ok('A.routing.hook("routes") returns the list untouched', E.routing._routesHook(routes, { from: [-118.25, 34.05], to: [-118.24, 34.05] }) === routes);
    ok('policeHits counts POIs within 160 m of a route vertex and ignores the rest',
      E.routing.policeHits(routes[0].coords, [[-118.2505, 34.05], [-118.0, 34.5]]) === 1 && E.routing.policeHits(routes[0].coords, []) === 0);
    const wps = E.routing.detourWaypoints(routes[0].coords, [[-118.25, 34.0505]]);
    ok('detourWaypoints builds three widening offsets on the side AWAY from the POI', wps.length === 3 && wps.every((w) => w[1] < 34.05), JSON.stringify(wps));
    ok('…and none when no POI sits on the route', E.routing.detourWaypoints(routes[0].coords, [[-118.0, 34.5]]).length === 0);

    // Stand down: the session is gone (401 on the manifest) → 'packs' → nothing held.
    E.ui.setRadar(true);
    manifestStatus = 401;
    await A.packs.sync();
    // The core bus can skip this pack's 'packs' subscriber (a detached settings
    // host's listener unsubscribes itself mid-emit); boot.js's watchdog closes
    // the gap within 2 s, so give it that long.
    await H.waitFor(() => E._applied() === false, 3000);
    ok('on sign-out the pack stands down: HUD off, loops stopped, controls hidden — while the setting itself is left alone',
      !A.packs.has('enforcement') && !doc.body.classList.contains('radar-on') && !E.ghost.isRunning() && !E.radar.isActive() &&
      doc.getElementById('ctl-radar').hidden === true && doc.getElementById('ctl-loop').hidden === true && S.settings.radar === true,
      'has=' + A.packs.has('enforcement') + ' radarOn=' + doc.body.classList.contains('radar-on') + ' running=' + E.ghost.isRunning() + ' active=' + E.radar.isActive() +
      ' ctlHidden=' + doc.getElementById('ctl-radar').hidden + ' setting=' + S.settings.radar + ' applied=' + E._applied());
    // …and comes back on the next grant without re-running the scripts.
    manifestStatus = 200;
    const scriptsBefore = FETCHES.filter((f) => /\/api\/packs$/.test(f.url)).length;
    await A.packs.sync();
    ok('the next sync re-holds the pack and the radar resumes from the persisted setting (no script re-run, one more manifest fetch)',
      A.packs.has('enforcement') && E.ghost.isRunning() && doc.body.classList.contains('radar-on') && doc.getElementById('ctl-radar').hidden === false &&
      FETCHES.filter((f) => /\/api\/packs$/.test(f.url)).length === scriptsBefore + 1);
    E.ui.setRadar(false);
    ok('a persisted "on" without an acknowledgement under the current Terms starts OFF (boot guard) — featureAcked is per Terms version',
      (function () { A.state.consent.version = '0.0'; const r = !A.store.featureAcked('radar'); A.state.consent.version = A.store.LEGAL_VERSION; return r; })());
    A.ui.closePanels();
  }

  /* ================= C — ported: the view-bbox clamp ================= */
  group('C — ported test/ghostbbox.test.js: the box ghost.js is willing to ask an upstream about');
  {
    const c = (b, lim) => E.ghost.clampBBox(b, lim);
    const LIM = 4, HOT = 80;
    const WORLD = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
    const show = (b) => JSON.stringify(b);
    ok('the world-wrapped intro view at the 4° clamp → null (the production bug: a lng -2…2 box nobody looked at)', c(WORLD, LIM) === null);
    ok('and at the hotspots\' 80° clamp → null', c(WORLD, HOT) === null);
    ok('an over-wrapped view (lng -540..540) is also null', c({ minLat: -85, minLng: -540, maxLat: 85, maxLng: 540 }, LIM) === null);
    const region = { minLat: 30, minLng: -10, maxLat: 42, maxLng: 2 };
    const r = c(region, LIM);
    ok('a 12° regional view still returns a box clamped to exactly 4° around the centre',
      !!r && Math.abs((r.maxLat - r.minLat) - LIM) < 1e-9 && Math.abs((r.maxLng - r.minLng) - LIM) < 1e-9 &&
      Math.abs((r.minLat + r.maxLat) / 2 - 36) < 1e-9 && Math.abs((r.minLng + r.maxLng) / 2 - (-4)) < 1e-9, show(r));
    ok('and the server accepts what the client will send', !!r && !!require(path.join(SERVER, 'overpass.js')).parseBbox(r));
    ok('exactly 16° (the threshold) is still accepted; 16.1° is refused',
      !!c({ minLat: 20, minLng: 20, maxLat: 36, maxLng: 36 }, LIM) && c({ minLat: 20, minLng: 20, maxLat: 36.1, maxLng: 36 }, LIM) === null);
    const s = c({ minLat: 51.5, minLng: -0.13, maxLat: 51.52, maxLng: -0.11 }, LIM);
    ok('a street-level view passes through unchanged', !!s && s.minLat === 51.5 && s.minLng === -0.13 && s.maxLat === 51.52 && s.maxLng === -0.11);
    const h = c({ minLat: 25, minLng: -125, maxLat: 50, maxLng: -65 }, HOT);
    ok('a 60° country view at the 80° clamp is returned unclamped', !!h && h.minLng === -125 && h.maxLng === -65);
    ok('blow-ups on one axis, zero-area, inverted, NaN and missing bounds are all refused',
      c({ minLat: 0, minLng: 10, maxLat: 40, maxLng: 12 }, LIM) === null && c({ minLat: 10, minLng: 0, maxLat: 12, maxLng: 40 }, LIM) === null &&
      c({ minLat: 10, minLng: 10, maxLat: 10, maxLng: 11 }, LIM) === null && c({ minLat: 12, minLng: 10, maxLat: 10, maxLng: 11 }, LIM) === null &&
      c({ minLat: NaN, minLng: 10, maxLat: 12, maxLng: 11 }, LIM) === null && c(null, LIM) === null && c(undefined, LIM) === null);
    const feats = E.ghost.osmToFeatures({ elements: [
      { type: 'node', lat: 1, lon: 2, tags: { amenity: 'police', name: 'Central' } },
      { type: 'way', center: { lat: 3, lon: 4 }, tags: { highway: 'speed_camera', maxspeed: '50' } },
      { type: 'node', lat: 5, lon: 6, tags: { 'man_made': 'surveillance', 'surveillance:type': 'ALPR' } },
      { type: 'node', lat: 7, lon: 8, tags: { amenity: 'cafe' } },
      { type: 'node', tags: { amenity: 'police' } }
    ] });
    ok('osmToFeatures: a station is kind "station" (never a live sighting), a camera "camera", surveillance "alpr"; other tags and position-less elements are dropped',
      feats.length === 3 && feats[0].properties.kind === 'station' && feats[0].properties.name === 'Central' &&
      feats[1].properties.kind === 'camera' && /50/.test(feats[1].properties.name) && feats[2].properties.kind === 'alpr' && /ALPR/.test(feats[2].properties.name));
  }

  /* ================= D — ported: the range-ring push guard ================= */
  group('D — ported test/radarrings.test.js: setRingsData is pushed only when the rings actually changed');
  {
    const src = readPack('radar.js');
    const ast = acorn.parse(src, { ecmaVersion: 2020 });
    const sanctioned = ['pushRings', 'setActive'];
    const callSites = [];
    const fnStack = [];
    walk.recursive(ast, null, {
      FunctionDeclaration(node, state, c) { fnStack.push(node.id ? node.id.name : fnStack[fnStack.length - 1] || '(anon)'); c(node.body, state); fnStack.pop(); },
      FunctionExpression(node, state, c) { if (node.id) { fnStack.push(node.id.name); c(node.body, state); fnStack.pop(); } else c(node.body, state); },
      CallExpression(node, state, c) {
        if (node.callee.type === 'MemberExpression' && node.callee.property && node.callee.property.type === 'Identifier' && node.callee.property.name === 'setRingsData') {
          callSites.push({ enclosingFn: fnStack[fnStack.length - 1] || '(top-level)', node });
        }
        node.arguments.forEach((a) => c(a, state));
        c(node.callee, state);
      }
    });
    const unsanctioned = callSites.filter((s) => sanctioned.indexOf(s.enclosingFn) === -1);
    ok('structural: every setRingsData( call site in radar.js is inside pushRings() or setActive() (' + callSites.length + ' found)', callSites.length >= 2 && unsanctioned.length === 0,
      unsanctioned.map((s) => 'in ' + s.enclosingFn + '() at ' + s.node.start).join('; '));

    // Behavioural, against the live pack: count pushes through the pack's own map layer surface.
    let ringsCalls = 0, lastFc = null;
    const realSetRings = E.map.setRingsData;
    E.map.setRingsData = (fc) => { ringsCalls++; lastFc = fc; realSetRings(fc); };
    let pos = [-122.4194, 37.7749];
    const realPlayerPos = A.sim.playerPos, realHeading = A.sim.playerHeading;
    A.sim.playerPos = () => pos.slice(); A.sim.playerHeading = () => 0;
    E.radar.setActive(true);
    ok('activating the radar pushes the rings exactly once (the immediate on-engage render)', ringsCalls === 1, 'ringsCalls=' + ringsCalls);
    for (let i = 0; i < 43; i++) E.radar._tick();
    ok('43 ticks (30 s) parked at the same spot produce ZERO additional pushes', ringsCalls === 1, 'ringsCalls=' + ringsCalls);
    pos = [-122.4194, 37.77500];
    E.radar._tick();
    ok('moving ~10 m triggers exactly one additional push', ringsCalls === 2, 'ringsCalls=' + ringsCalls);
    pos = [-122.41940003, 37.77500004];
    E.radar._tick();
    ok('sub-metre GPS jitter (< 5-decimal precision) does not trigger a push', ringsCalls === 2, 'ringsCalls=' + ringsCalls);
    E.radar.setActive(false);
    ok('deactivating pushes the empty FeatureCollection', ringsCalls === 3 && lastFc && lastFc.features.length === 0);
    E.radar.setActive(true);
    ok('re-engaging from the SAME position still pushes real rings (lastRingSig was reset on deactivate)', ringsCalls === 4 && lastFc.features.length === 3);
    E.radar.setActive(false);
    E.map.setRingsData = realSetRings; A.sim.playerPos = realPlayerPos; A.sim.playerHeading = realHeading;

    // The threat board, against synthetic layer data.
    E.map.setAircraftData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.42, 37.78] }, properties: { callsign: 'RCH471', owner: 'military', ownerName: 'Military', alt: 3000, speed: 120, key: 'a1' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.41, 37.775] }, properties: { callsign: 'N123', owner: 'civilian', ownerName: 'Civilian', alt: 500, speed: 20, key: 'h1' } }
    ] });
    E.map.setPoliceData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.418, 37.776] }, properties: { kind: 'station', name: 'Mission Station' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.417, 37.774] }, properties: { kind: 'camera', name: 'Speed camera' } }
    ] });
    A.sim.playerPos = () => [-122.4194, 37.7749]; A.sim.playerHeading = () => 0;
    const targets = E.radar._gatherTargets();
    ok('the board gathers aircraft (a heli by the low+slow rule) and ground kinds, nearest first',
      targets.length === 4 && targets.some((t) => t.kind === 'heli') && targets.some((t) => t.kind === 'air' && t.owner === 'military') &&
      targets.some((t) => t.kind === 'station') && targets.some((t) => t.kind === 'camera') && targets[0].dist <= targets[1].dist, JSON.stringify(targets.map((t) => t.kind)));
    A.store.setSetting('ghostAirMil', false);
    ok('an owner filter removes that class from the board (the same switch governs the map dot)', !E.radar._gatherTargets().some((t) => t.owner === 'military'));
    A.store.setSetting('ghostAirMil', true);
    A.store.setSetting('ghostCamera', false);
    ok('…and the camera toggle removes cameras', !E.radar._gatherTargets().some((t) => t.kind === 'camera'));
    A.store.setSetting('ghostCamera', true);
    ok('computeRisk caps at 25 and weighs nearer targets more', E.radar._computeRisk(targets) > 0 && E.radar._computeRisk(new Array(40).fill(targets[0])) === 25);
    A.sim.playerPos = realPlayerPos; A.sim.playerHeading = realHeading;
    E.map.setAircraftData(null); E.map.setPoliceData(null);
    ok('the map layer surface exposes the owner tables the settings legend reads', E.map.AIRCRAFT_OWNERS.length === 5 && E.map.AIRCRAFT_COLORS.military === '#ff3b3b' && /Unidentified/.test(E.map.AIRCRAFT_LABELS.unknown));
    ok('the click hook consumes nothing while the layers are hidden', E.map._onClick({ point: { x: 0, y: 0 } }, { getLayer: () => true, queryRenderedFeatures: () => [{}] }) === false);
  }
  // Leave the pack quiet before the server groups so no poller fires into a different fetch stub.
  E.ui.setRadar(false);
  global.fetch = undefined;

  /* ================= E — the server half ================= */
  group('E — server/packs/enforcement.js against a fake ctx: routes, malformed input, kill switches, the report handler');
  const mod = require('../server/packs/enforcement.js');
  const hotspots = require(path.join(SERVER, 'hotspots.js'));
  const agent = require(path.join(SERVER, 'agent.js'));
  const bots = require('../server/bots');
  const overrides = {};
  const sentAll = [];
  const buckets = new Map();
  let rateDeny = false;
  const ctx = {
    clients: new Map(), NEARBY_KM: 30, B: bots,
    send: (c, msg) => { (c.sent = c.sent || []).push(msg); sentAll.push([c.id, msg]); },
    rateOk: (key, max) => { if (rateDeny) return false; const n = (buckets.get(key) || 0) + 1; buckets.set(key, n); return n <= max; },
    validPos: (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && isFinite(p[0]) && p[0] >= -180 && p[0] <= 180 && typeof p[1] === 'number' && isFinite(p[1]) && p[1] >= -85 && p[1] <= 85,
    cleanText: (v, max, d) => (typeof v === 'string' && v.trim() ? v.replace(/[<>]/g, '').trim().slice(0, max) : (d || '')),
    liteOf: (r) => ({ id: r.id, name: r.name || 'Rider', emoji: '' }),
    blockedPair: (a, b) => !!((a.blocks && a.blocks.has(b.id)) || (b.blocks && b.blocks.has(a.id))),
    clientIp: (req) => req.ip || '1.2.3.4',
    json: (res, status, obj) => { res.status = status; res.body = obj; },
    flags: { pick: (name, d) => (Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : d) }
  };
  {
    ok('the half is shaped for the registry: id, init, routes [method, regex, fn], ws.enforcement:report',
      mod.id === 'enforcement' && typeof mod.init === 'function' && Array.isArray(mod.routes) &&
      mod.routes.every((r) => r[0] === 'POST' && r[1] instanceof RegExp && typeof r[2] === 'function') && typeof mod.ws['enforcement:report'] === 'function');
    ok('every route is POST under /api/enforcement/ (pack routes are only dispatched on POST, and the namespace is the pack\'s)',
      mod.routes.every((r) => /^\^\\\/api\\\/enforcement\\\//.test(r[1].source)), mod.routes.map((r) => r[1].source).join(' '));
    ok('the six routes: caps, aircraft, overpass, waze, hotspots, agent/status',
      ['caps', 'aircraft', 'overpass', 'waze', 'hotspots', 'agent\\/status'].every((p) => mod.routes.some((r) => r[1].source.indexOf(p) >= 0)));
    let threw = null;
    try { mod.init(ctx); } catch (e) { threw = e; }
    ok('init(ctx) with no database and no collector env boots in memory-only mode without throwing', !threw && mod._collectors().length === 0 && hotspots.status().persisted === false, threw && threw.message);
    ok('the source never requires the core server or the store internals', !/require\('\.\.\/server'\)|require\('\.\.\/store'\)|require\('\.\.\/db'\)/.test(read('server/packs/enforcement.js')));
  }
  const call = async (urlPath, extra) => {
    const route = mod.routes.find((r) => r[1].test(urlPath.split('?')[0]));
    if (!route) return { status: -1 };
    const req = Object.assign({ method: 'POST', url: urlPath, headers: {} }, extra || {});
    const res = {};
    await route[2](req, res, urlPath.split('?')[0].match(route[1]), { id: 'u-held', username: 'holder' }, ctx);
    return res;
  };
  const BOX = 'minLat=33.8&minLng=-118.3&maxLat=33.95&maxLng=-118.1';
  let upstream = [];
  function stubFetch(script) {
    global.fetch = (url) => {
      upstream.push(String(url));
      const next = script.shift();
      if (!next) return Promise.reject(new Error('no scripted response'));
      if (next instanceof Error) return Promise.reject(next);
      if (next instanceof Response) return Promise.resolve(next);
      return Promise.resolve({ ok: next.status >= 200 && next.status < 300, status: next.status, json: () => Promise.resolve(next.body || {}), text: () => Promise.resolve(JSON.stringify(next.body || {})), headers: { get: () => null } });
    };
  }
  {
    const r = await call('/api/enforcement/caps');
    ok('caps answers what the server can serve: a live feed (local store) even with no key, no Waze key, hotspots/aircraft/overpass on',
      r.status === 200 && r.body.waze === true && r.body.wazeKey === false && r.body.hotspots === true && r.body.aircraft === true && r.body.overpass === true, JSON.stringify(r.body));
    overrides.hotspots = false;
    ok('a kill switch on the Flags board shows in caps', (await call('/api/enforcement/caps')).body.hotspots === false);
    delete overrides.hotspots;
  }
  {
    ok('qs(): a malformed percent-escape yields {} (→ 400), first value wins, keys without "=" are empty',
      JSON.stringify(mod._qs({ url: '/x?a=%E0%A4%A' })) === '{}' && mod._qs({ url: '/x?a=1&a=2&b' }).a === '1' && mod._qs({ url: '/x?a=1&a=2&b' }).b === '');
    ok('bboxOf(): numeric strings only — empty, words, NaN and missing corners are refused',
      mod._bboxOf({ minLat: '1', minLng: '2', maxLat: '3', maxLng: '4' }).maxLng === 4 && mod._bboxOf({ minLat: '', minLng: '2', maxLat: '3', maxLng: '4' }) === null &&
      mod._bboxOf({ minLat: 'x', minLng: '2', maxLat: '3', maxLng: '4' }) === null && mod._bboxOf({ minLat: '1', minLng: '2', maxLat: '3' }) === null);
    const ac = require(path.join(SERVER, 'aircraft.js'));
    ac._reset();
    let r = await call('/api/enforcement/aircraft?minLat=99&minLng=0&maxLat=100&maxLng=1');
    ok('aircraft: an out-of-range bbox is a 400 and never reaches upstream', r.status === 400);
    r = await call('/api/enforcement/aircraft?minLat=1');
    ok('aircraft: a missing corner is a 400', r.status === 400);
    r = await call('/api/enforcement/aircraft?' + BOX + '&minLat=%E0%A4%A');
    ok('aircraft: a malformed query is a 400', r.status === 400);
    const row = new Array(17).fill(null); row[0] = 'a1'; row[1] = 'SWA1'; row[2] = 'United States'; row[4] = 1700000000; row[5] = -118.2; row[6] = 33.9; row[7] = 1000; row[8] = false; row[9] = 100; row[10] = 90;
    stubFetch([{ status: 200, body: { states: [row] } }]);
    r = await call('/api/enforcement/aircraft?' + BOX);
    ok('aircraft: a good bbox reaches OpenSky once and answers the classified rows', r.status === 200 && r.body.aircraft.length === 1 && r.body.aircraft[0].owner === 'civilian' && upstream.length === 1 && /opensky/.test(upstream[0]), JSON.stringify(r.body));
    r = await call('/api/enforcement/aircraft?minLat=33.82&minLng=-118.28&maxLat=33.93&maxLng=-118.15');
    ok('aircraft: a nearby rider is served from the cell cache (no second upstream call)', r.status === 200 && r.body.cached === true && upstream.length === 1);
    overrides.aircraft = false;
    ok('aircraft: killed on the Flags board → 503', (await call('/api/enforcement/aircraft?' + BOX)).status === 503);
    delete overrides.aircraft;
    rateDeny = true;
    ok('aircraft: over the rider\'s budget → 429 (ctx.rateOk)', (await call('/api/enforcement/aircraft?' + BOX)).status === 429);
    rateDeny = false;
  }
  {
    const op = require(path.join(SERVER, 'overpass.js'));
    op._coolReset();
    let r = await call('/api/enforcement/overpass?kind=nodes&' + BOX);
    ok('overpass: an unknown kind is a 400 — the caller picks a KIND, never a query', r.status === 400);
    r = await call('/api/enforcement/overpass?kind=constructor&' + BOX);
    ok('overpass: "constructor" is not a kind either', r.status === 400);
    r = await call('/api/enforcement/overpass?kind=police&minLat=-80&minLng=-170&maxLat=80&maxLng=170');
    ok('overpass: the whole world is a 400', r.status === 400);
    upstream = [];
    stubFetch([new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 33.9, lon: -118.2, tags: { amenity: 'police' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })]);
    r = await call('/api/enforcement/overpass?kind=enforcement&' + BOX);
    ok('overpass: a good lookup answers the upstream body', r.status === 200 && r.body.elements.length === 1 && upstream.length === 1, JSON.stringify(r.body));
    r = await call('/api/enforcement/overpass?kind=enforcement&' + BOX);
    ok('overpass: the same box again is a cache hit (no fetch)', r.status === 200 && upstream.length === 1);
    op._coolReset();
    stubFetch([new Response('busy', { status: 504 }), new Response('busy', { status: 504 })]);
    const realErr = console.error; console.error = () => {};
    r = await call('/api/enforcement/overpass?kind=road&minLat=40&minLng=10&maxLat=40.1&maxLng=10.1');
    console.error = realErr;
    ok('overpass: every mirror failing is a 502 (the client treats it as "skip this layer")', r.status === 502);
    op._coolReset();
  }
  {
    hotspots._reset(); hotspots.init({});
    agent._reset();
    let r = await call('/api/enforcement/waze?minLat=1');
    ok('waze: a bad bbox is a 400', r.status === 400);
    r = await call('/api/enforcement/waze?minLat=0&minLng=0&maxLat=20&maxLng=20');
    ok('waze: a box over 12° is a 400', r.status === 400);
    r = await call('/api/enforcement/waze?' + BOX);
    ok('waze: with no key the live feed still answers 200 with the local store (empty) and upstream:false', r.status === 200 && r.body.type === 'FeatureCollection' && r.body.features.length === 0 && r.body.upstream === false);
    agent.ingest([{ type: 'police', lat: 33.9, lng: -118.2, label: 'Checkpoint <b>x</b>', source: 'citizen' }, { type: 'hazard', lat: 1, lng: 1 }, { lat: 1, lng: 1, type: 'police' }, { type: 'police', lat: 'x', lng: 1 }]);
    r = await call('/api/enforcement/waze?' + BOX);
    ok('waze: a collector finding in the box is served, label sanitised, credited as a feed (agent:true), and recorded into the hotspot model',
      r.status === 200 && r.body.features.length === 1 && r.body.features[0].properties.label === 'Checkpoint bx/b' && r.body.features[0].properties.agent === true && hotspots.count() >= 1, JSON.stringify(r.body));
    ok('agent.ingest rejects hazard items (overlays pack) and bad coords, accepts police', (function () { const x = agent.ingest([{ type: 'hazard', lat: 1, lng: 1 }, { type: 'police', lat: 1, lng: 1 }]); return x.accepted === 1 && x.rejected.length === 1 && /overlays/.test(x.rejected[0].reason); })());
    process.env.OPENWEBNINJA_KEY = 'test-key';
    upstream = [];
    stubFetch([{ status: 200, body: { status: 'OK', data: { alerts: [{ type: 'POLICE', latitude: 33.85, longitude: -118.25, street: 'Main', num_thumbs_up: 2, alert_reliability: 7, publish_datetime_utc: '2026-10-05T00:00:00Z' }, { type: 'JAM', latitude: 1, longitude: 1 }] } } }]);
    const before = hotspots.count();
    r = await call('/api/enforcement/waze?' + BOX);
    ok('waze: with a key the licensed upstream is called with the key header, police alerts become features credited to Waze, merged with the local store, and recorded',
      r.status === 200 && r.body.features.length === 2 && r.body.features.some((f) => f.properties.waze === true && f.properties.label === 'Police (Waze)') && hotspots.count() === before + 1 && /openwebninja/.test(upstream[0]), JSON.stringify(r.body));
    const w = require(path.join(SERVER, 'waze.js'));
    ok('waze: the key never leaves the server (no key in the response)', JSON.stringify(r.body).indexOf('test-key') < 0 && w.hasKey());
    stubFetch([{ status: 429 }]);
    r = await call('/api/enforcement/waze?minLat=40&minLng=10&maxLat=40.1&maxLng=10.1');
    ok('waze: an upstream 429 with nothing local is a 429 (the client backs off)', r.status === 429);
    r = await call('/api/enforcement/waze?' + BOX);
    ok('waze: during the upstream cooldown the local store still answers 200 for a box that has sightings', r.status === 200 && r.body.upstream === false && r.body.features.length >= 1);
    overrides.waze = false;
    r = await call('/api/enforcement/waze?' + BOX);
    ok('waze: killed on the Flags board → local store only, no upstream call', r.status === 200 && r.body.upstream === false);
    delete overrides.waze;
    delete process.env.OPENWEBNINJA_KEY;
  }
  {
    hotspots._reset(); hotspots.init({});
    let r = await call('/api/enforcement/hotspots?minLat=1');
    ok('hotspots: a bad bbox is a 400', r.status === 400);
    r = await call('/api/enforcement/hotspots?' + BOX + '&hour=99');
    ok('hotspots: a bad hour falls back to "now" and answers an (empty) FeatureCollection', r.status === 200 && r.body.type === 'FeatureCollection' && r.body.features.length === 0);
    const now = Date.now();
    const hour = ((new Date(now).getUTCHours() + Math.round(-118.2 / 15)) % 24 + 24) % 24;
    hotspots.record(-118.2, 33.9, now); hotspots.record(-118.2, 33.9, now - 16 * 60 * 1000); hotspots.record(-118.2, 33.9, now - 32 * 60 * 1000);
    r = await call('/api/enforcement/hotspots?' + BOX + '&hour=' + hour);
    ok('hotspots: three sightings at one cell surface as a probability pin at the sighting\'s local hour',
      r.status === 200 && r.body.features.length === 1 && r.body.features[0].properties.kind === 'hotspot' && r.body.features[0].properties.count === 3 && r.body.features[0].properties.prob > 0, JSON.stringify(r.body));
    overrides.hotspots = false;
    ok('hotspots: killed → an empty collection, not an error', (await call('/api/enforcement/hotspots?' + BOX)).body.features.length === 0);
    delete overrides.hotspots;
    r = await call('/api/enforcement/agent/status');
    ok('agent/status answers the live counts and module stats (holder-gated like every route; the X-Agent-Key probe is gone)',
      r.status === 200 && r.body.ok === true && typeof r.body.live.police === 'number' && typeof r.body.hotspots.observations === 'number' && r.body.wazeKey === false && Array.isArray(r.body.collectors));
    ok('no route or file in the half reads an AGENT_KEY', !/AGENT_KEY/.test(read('server/packs/enforcement.js')) && !/AGENT_KEY/.test(read('server/packs/enforcement/agent.js')));
  }
  {
    // The report handler.
    hotspots._reset(); hotspots.init({}); agent._reset();
    const mk = (id, pos, packs, extra) => Object.assign({ id, ip: '9.9.9.' + id.length, pos, packs: new Set(packs), sent: [], name: id }, extra || {});
    const me = mk('me', [-118.25, 34.05], ['enforcement']);
    const near = mk('near', [-118.26, 34.06], ['enforcement']);
    const nearNoPack = mk('nopack', [-118.26, 34.06], []);
    const far = mk('far', [-117.0, 35.0], ['enforcement']);
    const blocked = mk('blocked', [-118.24, 34.04], ['enforcement'], { blocks: new Set(['me']) });
    const noPos = mk('nopos', null, ['enforcement']);
    [me, near, nearNoPack, far, blocked, noPos].forEach((c) => ctx.clients.set(c.id, c));
    const h = mod.ws['enforcement:report'];
    h(me, { t: 'enforcement:report', lat: 'x', lng: 1 }, ctx);
    h(me, { t: 'enforcement:report', lat: 95, lng: 1 }, ctx);
    h(me, null, ctx);
    ok('malformed or out-of-range coords are dropped silently', hotspots.count() === 0 && sentAll.length === 0);
    h(me, { t: 'enforcement:report', lat: 35.0, lng: -117.0, label: 'x' }, ctx);
    ok('a report far from the reporter\'s own position is refused with an err frame (proximity gate, REPORT_MAX_M=' + mod.REPORT_MAX_M + ')', hotspots.count() === 0 && me.sent.length === 1 && /near you/.test(me.sent[0].msg));
    me.sent.length = 0;
    h(me, { t: 'enforcement:report', lat: 34.052, lng: -118.252, label: '<script>Cop</script> here' }, ctx);
    ok('a valid report is recorded into the model and the live store', hotspots.count() === 1 && agent.counts().police === 1);
    ok('…fanned out ONLY to nearby riders who hold the pack and are not in a block pair, with the reporter\'s lite and the sanitised label',
      near.sent.length === 1 && near.sent[0].t === 'enforcement:report' && near.sent[0].from.id === 'me' && near.sent[0].label === 'scriptCop/script here' && near.sent[0].lat === 34.052 &&
      nearNoPack.sent.length === 0 && far.sent.length === 0 && blocked.sent.length === 0 && noPos.sent.length === 0 && me.sent.length === 0,
      JSON.stringify({ near: near.sent, nopack: nearNoPack.sent, far: far.sent, blocked: blocked.sent }));
    const nextPoll = await call('/api/enforcement/waze?' + BOX.replace('33.8', '33.5').replace('33.95', '34.5'));
    ok('the report is served to every holder\'s next live-feed poll, credited as a rider report', nextPoll.status === 200 && nextPoll.body.features.some((f) => f.properties.crowd === true && f.properties.label === 'scriptCop/script here'));
    rateDeny = true;
    h(me, { t: 'enforcement:report', lat: 34.052, lng: -118.252 }, ctx);
    ok('over the per-IP budget → an err frame and nothing recorded', hotspots.count() === 1 && me.sent.length === 1 && /slow down/.test(me.sent[0].msg));
    rateDeny = false;
    ctx.clients.clear();
  }

  /* ================= F — ported: aircraft ================= */
  group('F — ported test/aircraft.test.js: server/packs/enforcement/aircraft.js');
  {
    const ac = require(path.join(SERVER, 'aircraft.js'));
    const state = (icao, cs, lat, lon) => { const row = new Array(17).fill(null); row[0] = icao; row[1] = cs; row[2] = 'United States'; row[4] = 1700000000; row[5] = lon; row[6] = lat; row[7] = 1000; row[8] = false; row[9] = 100; row[10] = 90; row[11] = 0; row[14] = '1200'; return row; };
    ok('no / blank / null callsign is unknown', ac.classify('') === 'unknown' && ac.classify('   ') === 'unknown' && ac.classify(null) === 'unknown');
    ok('airline flights and registrations are civilian', ['SWA1426', 'BC743', 'DAL45J', 'N963PM', 'XBMQK'].every((c) => ac.classify(c) === 'civilian'));
    ok('air-arm callsigns are military', ['RCH471', 'CNV4961', 'ASCOT4521', 'rch471'].every((c) => ac.classify(c) === 'military'));
    ok('law enforcement and EMS callsigns are placed', ac.classify('SHERIFF12') === 'police' && ac.classify('CBP210') === 'police' && ac.classify('LIFEFLIGHT2') === 'ems' && ac.classify('COASTGUARD6031') === 'ems');
    const tactical = ['LOST25', 'BULET47', 'SCRCH52', 'RDSTRM16', 'VRTX19', 'INTEL24', 'SHWK769', 'BATT43'];
    ok('tactical callsigns are NEVER called civilian (the regression that forced the rewrite)', tactical.every((c) => ac.classify(c) !== 'civilian'), tactical.map((c) => c + '=' + ac.classify(c)).join(','));
    ok('every answer is one of the five buckets', ['', 'SWA1', 'RCH1', 'LOST25', 'N1'].every((c) => ac.OWNERS.indexOf(ac.classify(c)) >= 0));
    ok('bbox validation: good passes; null, non-numeric, inverted, out-of-range, planet-sized and zero-area are refused',
      !!ac.validBbox({ minLat: 33, minLng: -119, maxLat: 34, maxLng: -118 }) && ac.validBbox(null) === null &&
      ac.validBbox({ minLat: 'a', minLng: 0, maxLat: 1, maxLng: 1 }) === null && ac.validBbox({ minLat: 34, minLng: -119, maxLat: 33, maxLng: -118 }) === null &&
      ac.validBbox({ minLat: -95, minLng: 0, maxLat: 10, maxLng: 1 }) === null && ac.validBbox({ minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 }) === null &&
      ac.validBbox({ minLat: 33, minLng: -118, maxLat: 33, maxLng: -118 }) === null);
    const a = ac.rowToAircraft(state('A22233', 'RCH471 ', 33.8, -118.1));
    ok('a state row becomes a normalized contact (hex lowercased, callsign trimmed, owner stamped, fix time from last_contact)',
      a.hex === 'a22233' && a.callsign === 'RCH471' && a.lat === 33.8 && a.lon === -118.1 && a.owner === 'military' && a.at === 1700000000 * 1000 && ac.rowToAircraft(state('x', 'y', null, null)) === null);
    ac._reset(); upstream = [];
    stubFetch([{ status: 429 }, { status: 200, body: { states: [] } }]);
    const first = await ac.states({ minLat: 40, minLng: -75, maxLat: 41, maxLng: -74 });
    const second = await ac.states({ minLat: 50, minLng: -5, maxLat: 51, maxLng: -4 });
    ok('a 429 is reported as rate-limited and the next request does NOT reach upstream during the cooldown', first.error === 'rate-limited' && second.error === 'rate-limited' && upstream.length === 1 && ac.status().cooldown > 0);
    ac._reset();
    stubFetch([{ status: 200, body: { states: [state('keep', 'SWA9', 45.5, -73.6)] } }, { status: 500 }]);
    const bbox = { minLat: 45.4, minLng: -73.7, maxLat: 45.6, maxLng: -73.5 };
    const good = await ac.states(bbox);
    await new Promise((r) => setTimeout(r, ac.CACHE_MS + 50));
    const failed = await ac.states(bbox);
    ok('an upstream 500 keeps the last good sky, honestly marked stale, with the error recorded', good.rows.length === 1 && failed.rows && failed.rows.length === 1 && failed.stale === true && /500/.test(ac.status().lastError));
    ac._reset();
    stubFetch([{ status: 500 }]);
    const r = await ac.states({ minLat: 1, minLng: 1, maxLat: 2, maxLng: 2 });
    ok('with nothing cached, a failure is an error rather than an empty sky', r.error === 'upstream' && !r.rows);
  }

  /* ================= G — ported: overpass ================= */
  group('G — ported test/overpass.test.js: server/packs/enforcement/overpass.js guard rails + mirror demotion');
  {
    const overpass = require(path.join(SERVER, 'overpass.js'));
    const LA = { minLat: 34.03, minLng: -118.30, maxLat: 34.09, maxLng: -118.20 };
    const box = (over) => Object.assign({}, LA, over || {});
    overpass._coolReset();
    ok('only the app\'s own three lookups exist', ['police', 'enforcement', 'road'].every((k) => overpass.hasKind(k)) && ['', 'nodes', 'POLICE', 'constructor', '__proto__', 'toString'].every((k) => !overpass.hasKind(k)));
    const ql = overpass.KINDS.police('34.0,-118.3,34.1,-118.2');
    ok('the query is Overpass QL built server-side, carries the bbox and caps what it returns', ql.indexOf('[out:json]') === 0 && ql.indexOf('34.0,-118.3,34.1,-118.2') > 0 && /out center \d+;$/.test(ql));
    ok('enforcement includes surveillance (ALPR); road includes stops and signals; police avoidance stays narrow',
      overpass.KINDS.enforcement('B').indexOf('man_made"="surveillance') > 0 && overpass.KINDS.road('B').indexOf('highway"="stop') > 0 && overpass.KINDS.police('B').indexOf('highway"="stop') < 0);
    ok('parseBbox: a city view passes; missing, non-object, missing corner, numeric STRINGS, NaN, Infinity, null are refused',
      !!overpass.parseBbox(LA) && overpass.parseBbox(undefined) === null && overpass.parseBbox('34,-118,35,-117') === null &&
      overpass.parseBbox({ minLat: 34, minLng: -118, maxLat: 35 }) === null && overpass.parseBbox(box({ minLat: '34.03' })) === null &&
      overpass.parseBbox(box({ minLat: NaN })) === null && overpass.parseBbox(box({ maxLng: Infinity })) === null && overpass.parseBbox(box({ minLng: null })) === null);
    ok('parseBbox: out-of-range, inverted, zero-area and the whole world are refused',
      overpass.parseBbox(box({ maxLat: 91 })) === null && overpass.parseBbox(box({ minLng: -181 })) === null &&
      overpass.parseBbox({ minLat: 40, minLng: 10, maxLat: 30, maxLng: 20 }) === null && overpass.parseBbox({ minLat: 34, minLng: -118, maxLat: 34, maxLng: -118 }) === null &&
      overpass.parseBbox({ minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 }) === null);
    const M = overpass.MAX_SPAN_DEG;
    const centre = 19.599999999999998;
    ok('the span limit is at least the client\'s 4° clamp, accepts exactly the limit and a floating-point hair over it, refuses meaningfully more',
      M >= 4 && !!overpass.parseBbox({ minLat: 10, minLng: 10, maxLat: 10 + M, maxLng: 10 + M }) &&
      !!overpass.parseBbox({ minLat: centre - M / 2, minLng: -2, maxLat: centre + M / 2, maxLng: 2 }) &&
      overpass.parseBbox({ minLat: 10, minLng: 10, maxLat: 10 + M + 0.01, maxLng: 11 }) === null);
    let calls = 0;
    global.fetch = () => { calls++; return Promise.reject(new Error('should not be called')); };
    const rs = await Promise.all([overpass.query('nope', LA), overpass.query('police', { minLat: 'x' }), overpass.query('police', undefined), overpass.query('road', { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 })]);
    ok('bad input is refused without reaching Overpass', rs[0].error === 'unknown-kind' && rs[1].error === 'bad-bbox' && rs[2].error === 'bad-bbox' && rs[3].error === 'bad-bbox' && calls === 0);

    const jsonRes = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
    const textRes = (text, status) => new Response(text, { status: status || 200 });
    const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
    const at = (k) => ({ minLat: 40 + k, minLng: 10, maxLat: 40.06 + k, maxLng: 10.1 });
    async function drive(kind, bbox, script) {
      const realFetch = global.fetch, realErr = console.error, realWarn = console.warn;
      const errors = [], warns = [], hosts = [];
      let n = 0;
      global.fetch = (url) => { hosts.push(new URL(url).host); const step = script[n++]; if (typeof step === 'function') return Promise.resolve().then(step); return Promise.resolve(step); };
      console.error = (...a) => errors.push(a.join(' '));
      console.warn = (...a) => warns.push(a.join(' '));
      try { const r = await overpass.query(kind, bbox); return { r, errors, warns, hosts }; }
      finally { global.fetch = realFetch; console.error = realErr; console.warn = realWarn; }
    }
    const n0 = (o, k) => (o && o[k]) || 0;
    overpass._coolReset();
    const b0 = overpass.stats();
    const d = await drive('enforcement', at(0), [textRes('rate limited', 429), () => { throw timeoutErr(); }]);
    const line = d.errors.join('\n');
    ok('a total failure: {error:"upstream"}, ONE error line naming each mirror, http:429 and timeout, elapsed ms, the session tallies',
      d.r.error === 'upstream' && d.errors.length === 1 && d.hosts.length === b0.mirrors && d.hosts.every((h) => line.indexOf(h) >= 0) &&
      line.indexOf(d.hosts[0] + ' http:429 ') >= 0 && line.indexOf(d.hosts[1] + ' timeout ') >= 0 && (line.match(/ \d+ms\b/g) || []).length === d.hosts.length && /\(session ok=\d+ fail=\d+\)/.test(line), line);
    const a0 = overpass.stats();
    ok('stats(): fail +1 per query (not per attempt), byReason counted http:429 and timeout, byMirror charged each host',
      a0.fail === b0.fail + 1 && a0.ok === b0.ok && n0(a0.byReason, 'http:429') === n0(b0.byReason, 'http:429') + 1 && n0(a0.byReason, 'timeout') === n0(b0.byReason, 'timeout') + 1 &&
      d.hosts.every((h) => n0((a0.byMirror || {})[h], 'fail') === n0((b0.byMirror || {})[h], 'fail') + 1));
    overpass._coolReset();
    const d2 = await drive('enforcement', at(1), [() => { throw netErr(); }, jsonRes({ elements: [{ type: 'node', id: 1, lat: 41.02, lon: 10.05, tags: { amenity: 'police' } }] })]);
    ok('a partial failure: the body comes back fresh, no error line, one warn naming the failed mirror (net:TypeError) and the one that served',
      !!(d2.r.body && d2.r.body.elements.length === 1) && d2.r.cached === false && d2.errors.length === 0 && d2.warns.length === 1 &&
      d2.warns[0].indexOf(d2.hosts[0] + ' net:TypeError ') >= 0 && d2.warns[0].indexOf('served by ' + d2.hosts[1]) >= 0, d2.warns.join('\n'));
    overpass._coolReset();
    const d3 = await drive('road', at(3), [textRes('<html><body>Gateway busy</body></html>', 200), jsonRes({ remark: 'runtime error: query timed out' })]);
    ok('a non-JSON 200 is "body:", JSON without elements[] is "shape", on one capped line', d3.errors[0].indexOf(d3.hosts[0] + ' body:') >= 0 && d3.errors[0].indexOf(d3.hosts[1] + ' shape ') >= 0 && d3.errors[0].indexOf('\n') < 0 && d3.errors[0].length < 400, d3.errors[0]);
    const HOSTS = overpass.MIRROR_HOSTS, H0 = HOSTS[0], H1 = HOSTS[1];
    ok('MIRROR_HOSTS (two by default), mirrorOrder(now), COOL_MS and the _coolReset() seam are exported', Array.isArray(HOSTS) && HOSTS.length === 2 && typeof overpass.mirrorOrder === 'function' && overpass.COOL_MS === 120000);
    overpass._coolReset();
    const e1 = await drive('enforcement', at(10), [() => { throw timeoutErr(); }, jsonRes({ elements: [] })]);
    const e2 = await drive('enforcement', at(11), [jsonRes({ elements: [] })]);
    ok('a mirror that just timed out goes to the back: the NEXT query asks the one that served, first time, no warn', e1.hosts[0] === H0 && e1.hosts[1] === H1 && e2.hosts[0] === H1 && e2.hosts.length === 1 && e2.warns.length === 0, e2.hosts.join('→'));
    overpass._coolReset();
    const f1 = await drive('police', at(12), [() => { throw netErr(); }, () => { throw netErr(); }]);
    const f2 = await drive('police', at(13), [() => { throw netErr(); }, () => { throw netErr(); }]);
    ok('demote, never skip: with every mirror cooling, every mirror is still attempted and stats().cooling lists both', f1.hosts.length === 2 && f2.hosts.length === 2 && f2.r.error === 'upstream' && JSON.stringify(overpass.stats().cooling) === JSON.stringify(HOSTS));
    overpass._coolReset();
    const g1 = await drive('road', at(14), [() => { throw timeoutErr(); }, jsonRes({ elements: [] })]);
    const g2 = await drive('road', at(15), [() => { throw netErr(); }, jsonRes({ elements: [] })]);
    const g3 = await drive('road', at(16), [jsonRes({ elements: [] })]);
    ok('a success clears the demoted mirror\'s cooldown and the failure charges the other; the following query is back to declaration order',
      g1.hosts[0] === H0 && g2.hosts[0] === H1 && g2.hosts[1] === H0 && JSON.stringify(overpass.stats().cooling) === JSON.stringify([H1]) && g3.hosts[0] === H0 && g3.hosts.length === 1);
    const now = 1000000;
    const order = (st, t) => { overpass._coolReset(st); return JSON.stringify(overpass.mirrorOrder(t === undefined ? now : t)); };
    ok('pure mirrorOrder(now): nothing cooling → [0,1]; host 0 cooling → [1,0]; expired → [0,1]; a cooldown ending exactly now is over; ties keep declaration order; sooner-expiring first',
      order({}) === '[0,1]' && order({ [H0]: now + 1 }) === '[1,0]' && order({ [H0]: now + 1 }, now + 2) === '[0,1]' && order({ [H0]: now }) === '[0,1]' &&
      order({ [H0]: now + 5, [H1]: now + 5 }) === '[0,1]' && order({ [H0]: now + 9, [H1]: now + 5 }) === '[1,0]');
    overpass._coolReset({ [H1]: Date.now() + 60000 });
    const s = overpass.stats(); s.cooling.push('mutated'); s.byReason.timeout = 999;
    ok('stats() hands out copies: mutating the result does not touch the live table', JSON.stringify(overpass.stats().cooling) === JSON.stringify([H1]) && overpass.stats().byReason.timeout !== 999);
    overpass._coolReset();
    const modPath = path.join(SERVER, 'overpass.js');
    const sp = spawnSync(process.execPath, ['-e', 'console.log(require(' + JSON.stringify(modPath) + ').COOL_MS)'], { env: Object.assign({}, process.env, { OVERPASS_COOL_MS: '5000' }), encoding: 'utf8' });
    ok('COOL_MS is overridable through OVERPASS_COOL_MS (a fresh process reports 5000) and the README documents it', sp.status === 0 && sp.stdout.trim() === '5000' && /OVERPASS_COOL_MS/.test(readPack('README.md')), (sp.stdout + sp.stderr).trim());
    const src = read('server/packs/enforcement/overpass.js');
    ok('source pins: the cooldown is set inside failed(), the loop iterates mirrorOrder(Date.now()), a success clears it where the mirror is credited',
      /coolUntil\[MIRROR_HOSTS\[i\]\] = Date\.now\(\) \+ COOL_MS;/.test(src) && src.indexOf('for (const i of mirrorOrder(Date.now())) {') > 0 &&
      /mirrorTally\(MIRROR_HOSTS\[i\]\)\.ok\+\+;\n\s*delete coolUntil\[MIRROR_HOSTS\[i\]\];/.test(src) && src.indexOf('for (let i = 0; i < MIRRORS.length; i++)') < 0);
  }
  global.fetch = undefined;

  /* ================= H — ported: hotspots ================= */
  group('H — ported test/hotspots.test.js + persistence: server/packs/enforcement/hotspots.js');
  {
    hotspots._reset(); hotspots.init({});
    const CAP = hotspots.RECENT_CELL_MAX, HYS = CAP >> 4;
    ok('the cap is the old one (300000)', CAP === 300000);
    for (let i = 0; i < CAP + 50000; i++) hotspots.record((i % 360000) * 0.001 - 180, Math.floor(i / 360000) * 0.001 - 85, Date.now());
    ok('the dedup map stays ≤ cap + hysteresis after CAP+50k distinct cells', hotspots.dedupSize() <= CAP + HYS, 'dedupSize=' + hotspots.dedupSize());
    const before = hotspots.dedupSize();
    const ts = Date.now();
    hotspots.record(12.3456, 45.6789, ts);
    hotspots.record(12.3456, 45.6789, ts + 1000);
    ok('a repeat sighting in the same 15-min bucket is collapsed', hotspots.dedupSize() === before + 1);
    const b2 = hotspots.dedupSize();
    hotspots.record(12.3456, 45.6789, ts + 16 * 60 * 1000);
    ok('the same spot in a new 15-min window counts again', hotspots.dedupSize() === b2 + 1);
    ok('bad input is refused: non-numbers, NaN, out of range', !hotspots.record('1', 2, ts) && !hotspots.record(NaN, 2, ts) && !hotspots.record(200, 2, ts) && !hotspots.record(1, 95, ts));
    const q = hotspots.query(12.34, 45.67, 12.35, 45.68, new Date(ts).getUTCHours());
    ok('query returns a FeatureCollection', q && q.type === 'FeatureCollection');
    ok('the in-memory observation buffer is capped (hysteresis) — ' + hotspots.count(), hotspots.count() <= 200000 * 1.05);

    // Persistence through a fake ctx.db.query.
    hotspots._reset();
    const sql = [];
    let failNext = false;
    const query = async (text, params) => {
      sql.push({ text, params });
      if (failNext) { failNext = false; throw new Error('db down'); }
      if (/^select/.test(text)) return { rows: [{ lng: '-118.2', lat: '33.9', ts: String(Date.now() - 60000) }, { lng: '-118.2', lat: '33.9', ts: String(Date.now() - 60000 - 20 * 60 * 1000) }] };
      return { rows: [] };
    };
    const loaded = await hotspots.init({ query });
    ok('init({query}) loads the horizon\'s rows from public.enforcement_sightings into the model', loaded === 2 && hotspots.count() === 2 && hotspots.status().persisted === true && /from public\.enforcement_sightings where ts > \$1/.test(sql[0].text));
    hotspots.record(-117.5, 33.1, Date.now()); hotspots.record(-117.6, 33.2, Date.now());
    ok('record() with a database queues the rows (the hot path stays synchronous)', hotspots._pending() === 2);
    await hotspots.flush();
    const ins = sql.find((s) => /^insert into public\.enforcement_sightings/.test(s.text));
    ok('flush() inserts the batch in ONE multi-row statement with (lng, lat, ts, cell) per row', !!ins && ins.params.length === 8 && /values \(\$1,\$2,\$3,\$4\),\(\$5,\$6,\$7,\$8\)$/.test(ins.text) && hotspots._pending() === 0, ins && ins.text);
    failNext = true;
    hotspots.record(-117.7, 33.3, Date.now());
    const realErr = console.error; console.error = () => {};
    await hotspots.flush();
    console.error = realErr;
    ok('a failing insert is logged and dropped — never thrown, never retried into a storm', hotspots._pending() === 0 && /db down/.test(hotspots.status().lastError));
    const removed = hotspots.prune();
    ok('prune() keeps everything inside the horizon and issues the delete for the rest', removed === 0 && sql.some((s) => /^delete from public\.enforcement_sightings where ts < \$1/.test(s.text)));
    const file = path.join(TMP, 'hotspots.json');
    fs.writeFileSync(file, JSON.stringify([{ lng: -118.0, lat: 34.0, ts: Date.now() - 5000 }, { lng: 'x' }]));
    const imp = hotspots.importJson(file);
    ok('importJson() carries the pre-cut hotspots.json into the model, skipping junk', imp.imported === 1 && imp.total === 2);
    hotspots._reset(); hotspots.init({});
    const MIG = read('server/migrations/007_enforcement.sql');
    ok('migration 007 creates public.enforcement_sightings (lng, lat, ts bigint, cell) with a ts index and RLS on',
      /create table if not exists public\.enforcement_sightings[\s\S]*lng\s+double precision[\s\S]*ts\s+bigint not null[\s\S]*cell\s+text not null/.test(MIG) &&
      /create index if not exists enforcement_sightings_ts_idx on public\.enforcement_sightings \(ts\)/.test(MIG) && /alter table public\.enforcement_sightings enable row level security/.test(MIG));
    ok('hotspots.js persists through the query function it is handed, never through a file of its own', !/writeFile|renameSync|hotspots\.json'/.test(read('server/packs/enforcement/hotspots.js').replace(/\/\*[\s\S]*?\*\//g, '')) || /importJson/.test(read('server/packs/enforcement/hotspots.js')));
  }

  /* ================= I — ported: boundary ================= */
  group('I — ported test/boundary.test.js: scraping stays server-side, in one file, and never reaches a rider');
  {
    const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
    function clientFiles() {
      const out = [];
      const roots = ['index.html', 'js', 'css', 'www/index.html', 'www/js', 'www/css', 'android/app/src/main/assets/public', 'packs/enforcement'];
      for (const r of roots) {
        const abs = path.join(ROOT, r);
        if (!fs.existsSync(abs)) continue;
        if (fs.statSync(abs).isFile()) { out.push(r); continue; }
        (function walkDir(dir, rel) {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name), rp = rel + '/' + e.name;
            if (e.isDirectory()) walkDir(p, rp);
            else if (/\.(js|html|css|json|md)$/i.test(e.name)) out.push(rp);
          }
        })(abs, r);
      }
      return out;
    }
    const SERVER_ONLY = [
      { name: 'Waze private live-map', re: /waze\.com\/live-map|api\/georss/i },
      { name: 'Citizen', re: /citizen\.com/i },
      { name: 'PulsePoint', re: /pulsepoint\.org/i }
    ];
    const files = clientFiles();
    ok('found client files to scan, the pack\'s own files among them', files.length > 40 && files.some((f) => f.indexOf('packs/enforcement/') === 0), files.length + ' files');
    for (const src of SERVER_ONLY) {
      const hits = files.filter((f) => src.re.test(read(f)));
      ok('no client file (the pack included) references ' + src.name, hits.length === 0, hits.length ? 'LEAKED INTO: ' + hits.join(', ') : 'clean');
    }
    const strays = [];
    (function walkDir(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walkDir(p); continue; }
        if (!/\.(js|html)$/i.test(e.name)) continue;
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        if (rel === 'server/packs/enforcement/police-finder.js' || rel.indexOf('test/') === 0 || rel.indexOf('legal/') === 0) continue;
        if (SERVER_ONLY.some((s) => s.re.test(fs.readFileSync(p, 'utf8')))) strays.push(rel);
      }
    })(ROOT);
    ok('only server/packs/enforcement/police-finder.js knows the scraped hosts', strays.length === 0, strays.length ? 'also in: ' + strays.join(', ') : 'confined to the finder');
    const copyWeb = read('scripts/copy-web.js');
    ok('copy-web never copies packs/ or server/', !/['"]packs['"]/.test(copyWeb) && !/['"]server['"]/.test(copyWeb));
    const srv = read('server/server.js');
    ok('server.js does not require the finder or the collector (they run in-process only through the pack\'s init, or as their own unit)',
      !/require\(['"]\.\/police-finder/.test(srv) && !/require\(['"]\.\/collect-hotspots/.test(srv) && !/packs\/enforcement/.test(srv));
    const finder = read('server/packs/enforcement/police-finder.js');
    ok('the finder delivers through a sink, never an HTTP ingest: no /api/agent/update, no X-Agent-Key, no FINDER_URL', !/\/api\/agent\/update|X-Agent-Key|FINDER_URL/.test(finder) && /start\(opts\)/.test(finder) && /writeInbox/.test(finder));
    ok('the unit samples exist beside the pack, run the finder standalone into the inbox over the local disk, and name no URL',
      fs.existsSync(path.join(SERVER, 'convoy-police-finder.service')) && fs.existsSync(path.join(SERVER, 'convoy-collector.service')) &&
      /ENFORCEMENT_INBOX_DIR=\/var\/lib\/convoy\/enforcement-inbox/.test(read('server/packs/enforcement/convoy-police-finder.service')) &&
      !/https?:\/\/localhost|FINDER_URL|COLLECT_URL/.test(read('server/packs/enforcement/convoy-police-finder.service') + read('server/packs/enforcement/convoy-collector.service')) &&
      !exists('deploy/convoy-police-finder.service'));
    const wazeSrc = read('server/packs/enforcement/waze.js');
    ok('the licensed Waze path still credits Waze; the scraped keyless path uses a neutral label', /Police \(Waze\)/.test(wazeSrc) && !/Police \(Waze\)/.test(finder) && /'Police reported'/.test(finder));
    ok('the finder\'s pure helpers still export: fillBbox substitutes every placeholder; parseGoogleIncidents keeps only police entries from GeoJSON and flat arrays',
      (function () {
        const f = require(path.join(SERVER, 'police-finder.js'));
        const region = { name: 'x', bbox: [-118.5, 33.5, -118.0, 34.0] };
        const u = f.fillBbox('u?a={minLat}&b={minLng}&c={maxLat}&d={maxLng}&e={cLat}&f={cLng}', region);
        const geo = f.parseGoogleIncidents({ features: [{ geometry: { coordinates: [-118.2, 34.0] }, properties: { type: 'police' } }, { geometry: { coordinates: [-118.2, 34.0] }, properties: { type: 'construction', description: 'lane closed' } }] });
        const flat = f.parseGoogleIncidents({ incidents: [{ lat: 34, lng: -118, description: 'Speed trap on 5' }, { lat: 34, lng: -118, title: 'Crash' }] });
        return u === 'u?a=33.5&b=-118.5&c=34&d=-118&e=33.75&f=-118.25' && geo.length === 1 && flat.length === 1 && /Speed trap/.test(flat[0].label) &&
          JSON.stringify(f.regionsForCycle([1, 2, 3, 4, 5], 1, 2)) === '[3,4]' && JSON.stringify(f.regionsForCycle([1, 2, 3, 4, 5], 2, 2)) === '[5,1]';
      })());
    ok('requiring the finder or the collector has no side effects (no sweep starts)', (function () { require(path.join(SERVER, 'collect-hotspots.js')); return mod._collectors().length === 0; })());
    ok('the pack directory holds no server module and no secrets (only the manifest, fragments, stylesheet, scripts and the README, which the registry never serves)',
      fs.readdirSync(PACK).every((f) => /^(pack\.json|README\.md|[a-z]+\.(js|css|html))$/.test(f)) &&
      !/OPENWEBNINJA|AGENT_KEY|sb_secret_/.test(fs.readdirSync(PACK).filter((f) => f !== 'README.md').map(readPack).join('')) &&
      !/\bmd\b/.test(read('server/packs/index.js').match(/const SERVABLE = \/[^\n]*/)[0]));
  }

  /* ================= J — the inbox ================= */
  group('J — the collector inbox: one atomic file per batch in, ingested and deleted');
  {
    hotspots._reset(); hotspots.init({}); agent._reset();
    const dir = path.join(TMP, 'inbox');
    const name = agent.writeInbox(dir, [{ type: 'police', lat: 34.0, lng: -118.0, label: 'Checkpoint' }, { type: 'hotspot', lat: 34.1, lng: -118.1 }]);
    fs.writeFileSync(path.join(dir, '0-bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, '1-half.json.tmp'), '{"items":[{"type":"police","lat":1,"lng":1}]}');
    ok('writeInbox writes <ts>-<rand>.json via a .tmp rename', /^\d+-[a-z0-9]+\.json$/.test(name) && fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, name + '.tmp')));
    const r = agent.scanInbox(dir);
    ok('scanInbox ingests the complete file (2 accepted), sets the malformed one aside as .bad, leaves the .tmp alone, deletes what it ate',
      r.accepted === 2 && r.rejected === 1 && !fs.existsSync(path.join(dir, name)) && fs.existsSync(path.join(dir, '0-bad.json.bad')) && fs.existsSync(path.join(dir, '1-half.json.tmp')) &&
      agent.counts().police === 1 && hotspots.count() === 2, JSON.stringify(r));
    ok('writeInbox with nothing to send writes nothing', agent.writeInbox(dir, []) === null);
    ok('scanInbox on a missing directory is a no-op', agent.scanInbox(path.join(TMP, 'nope')).files === 0);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  mod._stop();
  report();
  // bootRealUi()'s jsdom window, the pack's pollers and the store's sweeps keep
  // timers armed; the verdict is printed, so leave the way test/packs.test.js does.
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
