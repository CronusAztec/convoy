/* Convoy — feature pack "scanners" (Police scanners via OpenMHz).
   `npm test` (test/run.js picks up test/packs-<id>.test.js by name), or:
   node test/packs-scanners.test.js

   WHAT IS PINNED HERE. The pack is the pre-cut js/scanners.js re-homed under
   packs/scanners/ and written to the core's hook points, so the suite loads
   it the way js/packs.js does — fragments mounted, scripts eval'd in order in
   the real jsdom page, the registered init run — and proves:
     A. the manifest validates against server/packs/index.js and the pack has
        no server half (OpenMHz is keyless and called from the client);
     B. the stylesheet keeps the core's discipline (no font below 12px, no
        backdrop-filter, infinite animation on opacity/transform only) and the
        script fetches only through U.fetchT;
     C. in the page: settings registered OFF by default (the legacy volume
        migrates), the chip mounts into #chips hidden, the Settings section
        renders through the 'settings' hook and its switch goes through the
        legality notice (the old FEATURE_NOTICES.scanner text), the chip tap
        opens the directory, a row streams calls back-to-back through one
        <audio>, pause/volume/stop work, autoplay refusal asks for a tap, the
        upstream being down degrades to one line, and losing the grant (the
        'packs' event) or switching the setting off stops the audio and hides
        the chip;
     D. the server side has nothing to answer for this pack: no routes, no
        socket handlers. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

const ID = 'scanners';
const PACK_DIR = path.join(ROOT, 'packs', ID);
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
process.env.CONVOY_PACKS_DIR = path.join(ROOT, 'packs');
const packs = require('../server/packs');

(async function main() {

  /* ================= A — manifest + files ================= */
  group('A — packs/scanners/pack.json: validates, lists every file, no server half (client-direct OpenMHz)');
  {
    let v = null, err = null;
    try { v = packs._validateManifest(ID, manifest); } catch (e) { err = e; }
    ok('the manifest validates against server/packs/index.js', !err && v && v.id === ID, err && err.message);
    ok('id/title/blurb/legal are what the catalogue shows',
      manifest.id === ID && manifest.title === 'Police scanners' && /OpenMHz/.test(manifest.blurb) && manifest.legal === 'scanners');
    ok('one script (scanners.js), one stylesheet, the chip fragment mounted into #chips (append)',
      v && v.scripts.join() === 'scanners.js' && v.styles.join() === 'scanners.css' &&
      v.fragments.length === 1 && v.fragments[0].mount === '#chips' && v.fragments[0].position === 'append' && /id="chip-scan"/.test(v.fragments[0].html));
    const onDisk = fs.readdirSync(PACK_DIR).filter((f) => f !== 'pack.json' && f !== 'README.md').sort();
    const listed = [].concat(manifest.scripts, manifest.styles, manifest.fragments.map((f) => f.file)).sort();
    ok('every file in the pack directory is listed in the manifest (nothing stray, nothing unserved)', onDisk.join() === listed.join(), onDisk.join() + ' vs ' + listed.join());
    ok('README.md is there', fs.existsSync(path.join(PACK_DIR, 'README.md')));
    ok('no server half: server/packs/scanners.js and server/packs/scanners/ do not exist (keyless upstream, called from the client)',
      !fs.existsSync(path.join(ROOT, 'server', 'packs', ID + '.js')) && !fs.existsSync(path.join(ROOT, 'server', 'packs', ID)));
    // The whole registry, as the server boots it. Another pack mid-write in
    // the same tree must not fail THIS suite, but a problem in ours must.
    let ids = null, loadErr = null;
    try { ids = packs.load({}); } catch (e) { loadErr = e; }
    if (loadErr && !new RegExp('packs/' + ID + '[/.]').test(loadErr.message)) {
      console.log('  (note) another pack failed to load, not ours: ' + loadErr.message);
      ok('server/packs load(): our manifest is not the one that failed', true);
    } else {
      ok('server/packs load() lists the pack and list() carries its public fields', !loadErr && ids.indexOf(ID) >= 0 &&
        packs.list().some((p) => p.id === ID && p.title === 'Police scanners' && p.legal === 'scanners'), loadErr && loadErr.message);
    }
  }

  /* ================= B — discipline ================= */
  group('B — scanners.css / scanners.js keep the core\'s discipline');
  {
    const css = fs.readFileSync(path.join(PACK_DIR, 'scanners.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');   // rules, not comments
    const sizes = Array.from(css.matchAll(/font-size:\s*([\d.]+)px/g)).map((m) => parseFloat(m[1]));
    ok('no font-size below 12px (' + sizes.length + ' declarations)', sizes.length > 0 && sizes.every((s) => s >= 12), sizes.join(','));
    ok('no backdrop-filter', !/backdrop-filter/.test(css));
    const infinite = Array.from(css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)).map((m) => m[1]);
    const framesOk = infinite.every((name) => {
      const m = new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\}\\s*\\}').exec(css);
      if (!m) return false;
      const props = Array.from(m[1].matchAll(/([a-z-]+)\s*:/g)).map((p) => p[1]);
      return props.length > 0 && props.every((p) => p === 'opacity' || p === 'transform');
    });
    ok('every infinite animation (' + infinite.join(',') + ') keys only opacity/transform', infinite.length > 0 && framesOk);
    ok('[data-anim="off"] stops the live dot', /\[data-anim="off"\][^{]*\.sp-live/.test(css));

    const js = fs.readFileSync(path.join(PACK_DIR, 'scanners.js'), 'utf8');
    ok('every fetch goes through U.fetchT (no bare fetch())', !/(^|[^.\w])fetch\(/.test(js) && /U\.fetchT\(/.test(js));
    ok('one IIFE, strict, exports only on window.App', /^\(function \(\) \{\s*'use strict';/m.test(js) && /\bA\.scanners = \{/.test(js) && !/\bwindow\.\w+\s*=/.test(js.replace(/window\.App\b/g, '')));
    ok('the pack registers through A.packs.register(\'scanners\') and listens for the packs event',
      /A\.packs\.register\((PACK|'scanners')/.test(js) && /var PACK = 'scanners'/.test(js) && /ST\.on\('packs'/.test(js));
    ok('the chip fragment has no inline style (the dot is a class in scanners.css)', !/style=/.test(fs.readFileSync(path.join(PACK_DIR, 'chip.html'), 'utf8')) && /\.dot-scan/.test(css));
  }

  /* ================= C — the client, through the real core chain ================= */
  group('C — in the page: settings, notice, chip, settings section, directory, player, degrade, stand-down');
  {
    const { win, doc, A } = H.bootRealUi();
    A.store.load();
    A.ui.init();

    /* ---- fakes: the network and <audio>, installed before the pack runs ---- */
    const FETCHES = [];
    const net = { down: false, geo: 'us' };
    const SYSTEMS = [
      { shortName: 'lafd', name: 'LA City Fire', description: 'Fire dispatch', state: 'CA', city: 'Los Angeles', clientCount: 90 },
      { shortName: 'sdpd', name: 'San Diego PD', description: 'police', state: 'CA', city: 'San Diego', clientCount: 40 },
      { shortName: 'lapd', name: 'LAPD Metro', description: 'Los Angeles Police dispatch', state: 'CA', city: 'Los Angeles', clientCount: 300 },
      { shortName: 'nypd', name: 'NYPD Citywide', description: 'police', state: 'NY', city: 'New York', clientCount: 900 },
      { shortName: 'chp', name: 'CHP Southern', description: 'Highway Patrol', state: 'CA', city: 'Los Angeles', clientCount: 20 }
    ];
    const T0 = Date.parse('2026-10-05T10:00:00Z');
    const call = (i, extra) => Object.assign({ _id: 'c' + i, time: new Date(T0 + i * 10000).toISOString(), url: 'https://media.openmhz.com/lapd/' + i + '.m4a', talkgroupNum: 101, len: 3 + i }, extra || {});
    let CALLS = [call(1), call(2), call(3), call(4), call(5), call(6)];
    const reply = (status, obj) => Promise.resolve({ ok: status < 400, status, json: async () => obj });
    const fakeFetch = (url, opts) => {
      FETCHES.push({ url: String(url), opts });
      if (net.down) return Promise.reject(new Error('ECONNRESET'));
      if (/nominatim\.openstreetmap\.org\/reverse/.test(url)) {
        return reply(200, net.geo === 'us'
          ? { address: { 'ISO3166-2-lvl4': 'US-CA', state: 'California', city: 'Los Angeles', country_code: 'us' } }
          : { address: { 'ISO3166-2-lvl4': 'DE-BY', state: 'Bayern', city: 'München', country_code: 'de' } });
      }
      if (/api\.openmhz\.com\/systems$/.test(url)) return reply(200, { systems: SYSTEMS });
      if (/api\.openmhz\.com\/lapd\/talkgroups$/.test(url)) return reply(200, { talkgroups: [{ num: 101, alpha: 'LAPD DISPATCH' }] });
      if (/api\.openmhz\.com\/lapd\/calls$/.test(url)) return reply(200, { calls: CALLS.slice().reverse() });   // newest first, like the real API
      if (/api\.openmhz\.com\/\w+\/(talkgroups|calls)$/.test(url)) return reply(200, { calls: [], talkgroups: [] });
      return reply(404, {});
    };
    win.fetch = fakeFetch;
    try { global.fetch = fakeFetch; } catch (e) { /* ignore */ }

    const audios = [];
    function FakeAudio() { this.volume = 1; this.paused = true; this.src = ''; this.preload = ''; this.plays = 0; this.playFail = false; this._l = {}; audios.push(this); }
    FakeAudio.prototype.addEventListener = function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); };
    FakeAudio.prototype.play = function () { this.plays++; if (this.playFail) return Promise.reject(new Error('NotAllowedError')); this.paused = false; return Promise.resolve(); };
    FakeAudio.prototype.pause = function () { this.paused = true; };
    FakeAudio.prototype.load = function () {};
    FakeAudio.prototype.removeAttribute = function (k) { if (k === 'src') this.src = ''; };
    FakeAudio.prototype.fire = function (t) { (this._l[t] || []).slice().forEach((fn) => fn()); };
    win.Audio = FakeAudio;

    let pos = [-118.2437, 34.0522];
    A.sim.playerPos = () => (pos ? pos.slice() : null);

    /* ---- the loader, by hand: fragments → (styles) → scripts → init ---- */
    let holding = true;
    A.packs.has = (id) => id === ID && holding;   // what js/packs.js answers once the manifest and scripts have landed
    const defs = {};
    const realRegister = A.packs.register;
    A.packs.register = function (id, def) { defs[id] = def; return realRegister.call(A.packs, id, def); };
    win.localStorage.setItem('convoy.scanner.vol', '0.4');   // the pre-cut build's volume key
    const before = new Set(Object.getOwnPropertyNames(win));
    manifest.fragments.forEach((f) => A.packs._mountFragment({ mount: f.mount, position: f.position, html: fs.readFileSync(path.join(PACK_DIR, f.file), 'utf8') }));
    let evalErr = null;
    try { manifest.scripts.forEach((s) => win.eval(fs.readFileSync(path.join(PACK_DIR, s), 'utf8'))); } catch (e) { evalErr = e; }
    ok('the scripts run in the real page without throwing', !evalErr, evalErr && (evalErr.stack || evalErr.message));
    const leaked = Object.getOwnPropertyNames(win).filter((k) => !before.has(k));
    ok('no new globals', leaked.length === 0, leaked.join(','));
    ok('A.scanners is exported with the old surface (open/close/find/isPolice/stop)',
      !!A.scanners && ['open', 'close', 'find', 'isPolice', 'stop'].every((k) => typeof A.scanners[k] === 'function'));

    /* ---- settings ---- */
    ok('registerSettings: scannersEnabled defaults OFF', A.state.settings.scannersEnabled === false);
    ok('registerSettings: scannerVol seeded from the old localStorage key (0.4), else 0.9', A.state.settings.scannerVol === 0.4, String(A.state.settings.scannerVol));
    A.store.setSetting('scannerVol', 0.9);
    A.store.setSetting('scannersEnabled', false);
    ok('setSetting() accepts both keys', A.state.settings.scannerVol === 0.9 && A.state.settings.scannersEnabled === false);

    /* ---- every getElementById in the pack resolves on the page as mounted ---- */
    const js = fs.readFileSync(path.join(PACK_DIR, 'scanners.js'), 'utf8');
    const ids = Array.from(js.matchAll(/document\.getElementById\('([\w-]+)'\)/g)).map((m) => m[1]);
    ok('every document.getElementById in the pack resolves (' + ids.join(',') + ')', ids.length > 0 && ids.every((id) => !!doc.getElementById(id)), ids.filter((id) => !doc.getElementById(id)).join(','));
    const chip = doc.getElementById('chip-scan');
    const chipIds = chip ? Array.from(chip.parentNode.children).map((e) => e.id) : [];
    ok('the chip is mounted into #chips after the core\'s LIVE and Global chips and starts hidden',
      !!chip && chip.parentNode.id === 'chips' && chipIds.indexOf('chip-global') >= 0 && chipIds.indexOf('chip-scan') > chipIds.indexOf('chip-global') && chip.hidden === true, chipIds.join(','));

    /* ---- the notice ---- */
    A.store.setConsent({ passenger: true, age: true, terms: true });
    let proceeded = 0, cancelled = 0;
    A.ui.legalGate('scanners', () => proceeded++, () => cancelled++);
    let card = doc.querySelector('#onboarding .modal-card');
    ok('registerFeatureNotice(\'scanners\'): legalGate opens the OLD notice text (title, OpenMHz lede, the six states)',
      proceeded === 0 && !!card && /Before you listen in/.test(card.textContent) && /streamed from OpenMHz/.test(card.textContent) &&
      /Florida, Indiana, Kentucky, Minnesota, New York and New Jersey/.test(card.textContent) && /escape an offence/.test(card.textContent), card && card.textContent.slice(0, 200));
    Array.from(card.querySelectorAll('button')).find((b) => /Not now/.test(b.textContent)).click();
    ok('"Not now" cancels and nothing is acknowledged', cancelled === 1 && !A.store.featureAcked('scanners'));

    /* ---- init: the registered def, as the loader runs it ---- */
    ok('A.packs.register(\'scanners\', { init }) was called', !!defs[ID] && typeof defs[ID].init === 'function');
    let initErr = null;
    try { defs[ID].init(); } catch (e) { initErr = e; }
    ok('init() runs; the chip stays hidden while the setting is off', !initErr && chip.hidden === true, initErr && initErr.message);
    chip.click();
    ok('a tap on the (hidden) chip while the setting is off opens nothing', !doc.getElementById('scanners-overlay'));

    /* ---- the Settings section, through the hook ---- */
    A.ui.openPanel('profile');
    await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 2000);
    const host = doc.getElementById('settings-host');
    const row = Array.from(host.querySelectorAll('.setting-row')).find((r) => /Police scanners/.test(r.textContent));
    const toggle = row && row.querySelector('.toggle');
    ok('the "Police scanners" section renders in Settings with a switch, off, and the OpenMHz note',
      /Police scanners/.test(host.textContent) && !!toggle && !toggle.classList.contains('on') && /OpenMHz/.test(host.textContent) && /restricted in some states/.test(host.textContent));
    const packsLabel = Array.from(host.querySelectorAll('.section-label')).map((l) => l.textContent);
    ok('…placed before the Feature packs section', packsLabel.indexOf('Police scanners') >= 0 && packsLabel.indexOf('Police scanners') < packsLabel.indexOf('Feature packs'), packsLabel.join('|'));
    toggle.click();
    card = doc.querySelector('#onboarding .modal-card');
    ok('switching it on opens the legality notice first and does NOT change the setting', !!card && /Before you listen in/.test(card.textContent) && A.state.settings.scannersEnabled === false);
    Array.from(card.querySelectorAll('button')).find((b) => /Not now/.test(b.textContent)).click();
    ok('"Not now" puts the switch back and leaves the chip hidden', !toggle.classList.contains('on') && toggle.getAttribute('aria-checked') === 'false' && A.state.settings.scannersEnabled === false && chip.hidden === true);
    toggle.click();
    card = doc.querySelector('#onboarding .modal-card');
    Array.from(card.querySelectorAll('button')).find((b) => /I understand/.test(b.textContent)).click();
    ok('"I understand" acknowledges, switches the setting on, and the chip appears', A.store.featureAcked('scanners') && A.state.settings.scannersEnabled === true && toggle.classList.contains('on') && chip.hidden === false);
    const saved = JSON.parse(win.localStorage.getItem('convoy.v1'));
    ok('the setting and the acknowledgement persist', saved.settings.scannersEnabled === true && !!(saved.featureAck && saved.featureAck.scanners));
    A.ui.closePanels();

    /* ---- degrade first (a failure is never cached): upstream down, no location ---- */
    net.down = true;
    let r = await A.scanners.find(true);
    ok('find(): OpenMHz unreachable → { error: "fetch" }, no throw', r && r.error === 'fetch');
    chip.click();
    const overlay = doc.getElementById('scanners-overlay');
    ok('the chip tap (acknowledged) opens the directory overlay at once', !!overlay && overlay.hidden === false && overlay.getAttribute('role') === 'dialog');
    await H.waitFor(() => /reach the scanner directory/.test(overlay.querySelector('#scanner-list').textContent), 2000);
    ok('…which says in one line that the directory is unreachable', /Couldn’t reach the scanner directory/.test(overlay.querySelector('#scanner-list').textContent));
    net.down = false;
    pos = null;
    r = await A.scanners.find(true);
    ok('find(): no position → { error: "no-location" }', r && r.error === 'no-location');
    A.scanners.open();
    await H.waitFor(() => /locate button/.test(overlay.querySelector('#scanner-list').textContent), 2000);
    ok('…and the directory asks for a position', /Tap the locate button/.test(overlay.querySelector('#scanner-list').textContent));
    pos = [-118.2437, 34.0522];

    /* ---- the directory ---- */
    const nFetch = FETCHES.length;
    A.scanners.open();
    await H.waitFor(() => overlay.querySelectorAll('.scanner-item').length > 0, 2000);
    const rows = Array.from(overlay.querySelectorAll('.scanner-item'));
    ok('open(): reverse-geocodes + pulls /systems, both through fetchT (a deadline signal on each)',
      FETCHES.slice(nFetch).some((f) => /nominatim/.test(f.url)) && FETCHES.slice(nFetch).some((f) => /openmhz\.com\/systems/.test(f.url)) &&
      FETCHES.slice(nFetch).every((f) => f.opts && f.opts.signal), JSON.stringify(FETCHES.slice(nFetch).map((f) => f.url)));
    ok('the list holds only the rider\'s state (4 of 5), law enforcement first, same city before other cities, then most-listened',
      rows.map((e) => e.dataset.sn).join() === 'lapd,chp,sdpd,lafd', rows.map((e) => e.dataset.sn).join());   // lapd (LA, 300) > chp (LA, 20) > sdpd (SD, 40) > lafd (fire)
    ok('the heading shows where "near you" resolved to', overlay.querySelector('#scanner-sub').textContent === 'Los Angeles, CA');
    ok('rows are buttons, escaped, with the law-enforcement tag and listener count', rows[0].tagName === 'BUTTON' && /LAPD Metro/.test(rows[0].textContent) && /law enforcement/.test(rows[0].textContent) && /300 listening/.test(rows[0].textContent) && !/law enforcement/.test(rows[3].textContent));
    ok('isPolice(): police / sheriff / PD / highway patrol yes, fire no',
      A.scanners.isPolice({ name: 'Metro Police' }) && A.scanners.isPolice({ name: 'County Sheriff' }) && A.scanners.isPolice({ name: 'Somewhere PD' }) &&
      A.scanners.isPolice({ name: 'x', description: 'Highway Patrol' }) && !A.scanners.isPolice({ name: 'City Fire' }) && !A.scanners.isPolice(null));
    const n2 = FETCHES.length;
    r = await A.scanners.find();
    ok('find() answers from the 5-minute cache without a request', r && r.systems.length === 4 && FETCHES.length === n2);

    /* ---- the player ---- */
    rows[0].click();
    await H.waitFor(() => audios.length === 1 && audios[0].plays === 1, 2000);
    const a = audios[0];
    const player = overlay.querySelector('#scanner-player');
    ok('tapping a row builds ONE <audio>, seeds the 4 newest calls oldest-first and plays the first', audios.length === 1 && a.src === CALLS[2].url && a.plays === 1 && a.volume === 0.9, a.src);
    ok('the player bar shows: title, talkgroup name (not "TG 101"), live dot on, 3 queued, the row marked playing',
      player.hidden === false && overlay.querySelector('#sp-title').textContent === 'LAPD Metro' && /LAPD DISPATCH/.test(overlay.querySelector('#sp-now').textContent) &&
      overlay.querySelector('#sp-live').classList.contains('on') && overlay.querySelector('#sp-queue').textContent === '+3 queued' && rows[0].classList.contains('playing'),
      overlay.querySelector('#sp-now').textContent + ' / ' + overlay.querySelector('#sp-queue').textContent);
    ok('the talkgroup and calls fetches are /<shortName>/… through fetchT', FETCHES.some((f) => /openmhz\.com\/lapd\/talkgroups$/.test(f.url) && f.opts.signal) && FETCHES.some((f) => /openmhz\.com\/lapd\/calls$/.test(f.url) && f.opts.signal));
    ok('the calls poller is armed (a plain interval: it feeds audio, so it must survive a hidden page)', !!A.scanners._player.poll);
    a.fire('ended');
    ok('"ended" plays the next queued call on the same element', a.src === CALLS[3].url && a.plays === 2 && overlay.querySelector('#sp-queue').textContent === '+2 queued');
    a.fire('error');
    ok('a bad clip is skipped', a.src === CALLS[4].url && a.plays === 3 && overlay.querySelector('#sp-queue').textContent === '+1 queued');
    CALLS = CALLS.concat([call(7), call(8, { emergency: true })]);
    A.scanners._pollCalls(false);
    await H.waitFor(() => overlay.querySelector('#sp-queue').textContent === '+3 queued', 2000);
    ok('a poll appends only calls newer than the last one queued (2 new → +3 queued)', overlay.querySelector('#sp-queue').textContent === '+3 queued', overlay.querySelector('#sp-queue').textContent);
    const spToggle = overlay.querySelector('#sp-toggle');
    spToggle.click();
    ok('pause: the element pauses and the button offers Play', a.paused === true && spToggle.getAttribute('aria-label') === 'Play');
    spToggle.click();
    ok('resume: play() again, button offers Pause', a.paused === false && a.plays === 4 && spToggle.getAttribute('aria-label') === 'Pause');
    const volEl = overlay.querySelector('#sp-vol');
    volEl.value = '0.3';
    volEl.dispatchEvent(new win.Event('input', { bubbles: true }));
    ok('the volume slider sets the element and persists through the scannerVol setting', a.volume === 0.3 && A.state.settings.scannerVol === 0.3 && JSON.parse(win.localStorage.getItem('convoy.v1')).settings.scannerVol === 0.3);
    A.store.setSetting('scannerVol', 0.9);
    overlay.querySelector('#sp-stop').click();
    ok('stop: audio paused and unloaded, poller cleared, player hidden, no row marked', a.paused === true && a.src === '' && !A.scanners._player.poll && player.hidden === true && !overlay.querySelector('.scanner-item.playing'));

    a.playFail = true;
    rows[0].click();   // lapd again: the system with calls in the fixture
    await H.waitFor(() => /Tap ▶/.test(overlay.querySelector('#sp-now').textContent), 2000);
    ok('autoplay refused (no gesture survived the fetch): the bar asks for a tap and offers Play', /Tap ▶ to start audio/.test(overlay.querySelector('#sp-now').textContent) && spToggle.getAttribute('aria-label') === 'Play' && audios.length === 1);
    a.playFail = false;
    overlay.querySelector('#scanner-close').click();
    await H.waitFor(() => overlay.hidden === true, 2000);
    ok('close: the overlay fades and hides, the audio stops with it', overlay.hidden === true && a.paused === true && !A.scanners._player.sys);

    /* ---- a Terms bump voids the acknowledgement: no audio without a current one ---- */
    A.scanners.open();
    await H.waitFor(() => overlay.querySelectorAll('.scanner-item').length > 0, 2000);
    const LV = A.store.LEGAL_VERSION;
    A.state.consent.version = '0.0';
    const playsBefore = a.plays;
    overlay.querySelector('.scanner-item').click();
    ok('a row tap after a Terms bump closes the directory and shows the notice instead of playing',
      a.plays === playsBefore && !!doc.querySelector('#onboarding .modal-card') && /Before you listen in/.test(doc.querySelector('#onboarding .modal-card').textContent) && !A.scanners._player.sys);
    Array.from(doc.querySelector('#onboarding .modal-card').querySelectorAll('button')).find((b) => /Not now/.test(b.textContent)).click();
    A.state.consent.version = LV;
    await H.waitFor(() => overlay.hidden === true, 2000);

    /* ---- stand-down: the grant goes away ---- */
    chip.click();
    await H.waitFor(() => overlay.hidden === false && overlay.querySelectorAll('.scanner-item').length > 0, 2000);
    overlay.querySelector('.scanner-item').click();
    await H.waitFor(() => a.paused === false, 2000);
    ok('(playing again)', a.paused === false && !!A.scanners._player.sys);
    holding = false;
    let emitErr = null;
    try { A.store.emit('packs', A.packs.state()); } catch (e) { emitErr = e; }
    await H.waitFor(() => overlay.hidden === true, 2000);
    ok('the packs event with A.packs.has(\'scanners\') false stops the audio, closes the directory and hides the chip',
      !emitErr && a.paused === true && !A.scanners._player.sys && !A.scanners._player.poll && overlay.hidden === true && chip.hidden === true, emitErr && emitErr.message);
    chip.click();
    A.scanners.open();
    ok('…and neither the chip nor open() shows anything while the pack is not held', overlay.hidden === true);
    holding = true;
    A.store.emit('packs', A.packs.state());
    ok('the grant coming back shows the chip again (the setting is still on)', chip.hidden === false);

    /* ---- stand-down: the setting goes off ---- */
    chip.click();
    await H.waitFor(() => overlay.hidden === false && overlay.querySelectorAll('.scanner-item').length > 0, 2000);
    overlay.querySelector('.scanner-item').click();
    await H.waitFor(() => a.paused === false, 2000);
    A.store.setSetting('scannersEnabled', false);
    await H.waitFor(() => overlay.hidden === true, 2000);
    ok('switching the setting off stops the audio, closes the directory and hides the chip', a.paused === true && !A.scanners._player.sys && overlay.hidden === true && chip.hidden === true);
    chip.click();
    ok('…and a chip tap does nothing', overlay.hidden === true);
    A.scanners.setEnabled(true);
    ok('setEnabled(true) (post-acknowledgement) shows the chip', A.state.settings.scannersEnabled === true && chip.hidden === false);

    /* ---- handlers never throw on garbage ---- */
    let hErr = null;
    try {
      A.store.emit('setting', null); A.store.emit('setting', { key: 'other' }); A.store.emit('packs', undefined);
      A.scanners._startListen(null); A.scanners._startListen({});
      A.scanners.stop(); A.scanners.close(); A.scanners.close();
    } catch (e) { hErr = e; }
    ok('the setting/packs handlers and the player survive garbage input', !hErr, hErr && hErr.message);

    /* ---- outside the US (last: an empty answer IS cached) ---- */
    net.geo = 'de';
    r = await A.scanners.find(true);
    ok('find(): a position outside the US yields an empty list, not an error', r && !r.error && r.systems.length === 0 && r.loc.country === 'DE');
    A.scanners.open();
    await H.waitFor(() => /OpenMHz covers the US/.test(overlay.querySelector('#scanner-list').textContent), 2000);
    ok('…and the directory says OpenMHz covers the US', /No live scanner feeds found for your area\. OpenMHz covers the US\./.test(overlay.querySelector('#scanner-list').textContent));
    A.scanners.close();
  }

  /* ================= D — the server side ================= */
  group('D — server half: none. No route under /api/scanners, no scanners:* socket handler (OpenMHz is keyless, client-direct)');
  {
    const users = { 'tok-held': { id: 'u-held', username: 'holder' } };
    const ctx = {
      flags: { pick: (name, d) => d },
      store: { hasPack: () => true, packsOf: () => [ID], packHolders: () => 1 },
      bearer: (req) => ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '') || null,
      userFromToken: (tok) => users[tok] || null,
      json: (res, status, obj) => { res.status = status; res.body = obj; }
    };
    packs._setCtx(ctx);
    const res = {};
    let handled = null, err = null;
    try { handled = await packs.handleApi({ method: 'GET', url: '/api/scanners/systems', headers: { authorization: 'Bearer tok-held' } }, res, '/api/scanners/systems'); } catch (e) { err = e; }
    ok('GET /api/scanners/* is not a pack route (falls through to the server\'s 404)', !err && handled === false, err && err.message);
    ok('no scanners:* socket handler is registered', packs.wsHandler('scanners:calls') === null && packs.wsHandler('scanners:find') === null);
    ok('the old build had no server proxy for OpenMHz either: the client calls api.openmhz.com directly (connect-src/media-src https:)',
      /api\.openmhz\.com/.test(fs.readFileSync(path.join(PACK_DIR, 'scanners.js'), 'utf8')) && /media-src 'self' blob: https:/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
  }

  process.exit(report());
})().catch((e) => { console.error(e); process.exit(1); });
