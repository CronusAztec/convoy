/* Convoy — feature pack "perf" (Performance timers: dragy meter, side-by-side
   racing, the top-speed quest, best times on profiles).
   `npm test` (test/run.js picks up test/packs-<id>.test.js by name), or:
   node test/packs-perf.test.js

   WHAT IS PINNED HERE. The pack is the pre-cut js/racetimer.js + dragy.js +
   race.js + quest.js and the server's race / PB handlers, re-homed under
   packs/perf/ and server/packs/perf.js and written to the core's hook points,
   so the suite loads it the way js/packs.js does — fragments mounted, scripts
   eval'd in order in the real jsdom page, the registered init run — and
   proves:
     A. the manifest validates against server/packs/index.js, every file is
        listed, the server half loads and collides with nothing;
     B. the stylesheet and scripts keep the core's discipline;
     C. the timing core: a standing 0–60 at constant acceleration lands on the
        analytic time, a ¼ mile solves the quadratic and reads the trap, a
        rolling start brackets its `from`, a sustained stop aborts;
     D. in the page: settings registered OFF by default, the chip / HUD / quest
        card mount hidden, the settings section renders through the 'settings'
        hook and its switch goes through the legality notice (the old
        FEATURE_NOTICES.perf text under the key 'race'), the chip tap opens the
        meter, a run produces a result + history + a PB over the socket, the
        profile page and the public-profile overlay carry the bests sections
        and the Challenge button through the hooks, the race lobby → countdown →
        HUD → results chain renders from server state, an invite becomes a
        toast, and losing the grant (the 'packs' event) or switching the
        setting off stands everything down;
     E. the quest: two consistent fixes set a record, a glitch does not, the
        60–100 timer scores a pull, and it idles when the pack is off;
     F. the server half against a fake ctx: stats load from the two tables and
        write through, GET /api/perf/dragy/pb is gated, every socket handler
        validates its input and never throws on garbage, the PB fan-out goes
        only to scoped holders (hidden from an unverified viewer), and the race
        lifecycle — the three cases of the old test/race-lifecycle.js (cancel
        from the lobby records nothing, host leaving during the countdown
        records nothing, a race that ran still records) plus the join /
        proximity / block / fix-relay / invite / rate-limit / close paths. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, near, report, ROOT } = H;

const ID = 'perf';
const PACK_DIR = path.join(ROOT, 'packs', ID);
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
process.env.CONVOY_PACKS_DIR = path.join(ROOT, 'packs');
process.env.RACE_COUNTDOWN_MS = '3000';
const packs = require('../server/packs');
const MPH = 1 / 2.2369362921;

(async function main() {

  /* ================= A — manifest + files ================= */
  group('A — packs/perf/pack.json: validates, lists every file, the server half loads and collides with nothing');
  {
    let v = null, err = null;
    try { v = packs._validateManifest(ID, manifest); } catch (e) { err = e; }
    ok('the manifest validates against server/packs/index.js', !err && v && v.id === ID, err && err.message);
    ok('id/title/blurb/legal are what the catalogue shows',
      manifest.id === ID && manifest.title === 'Performance timers' && /drag timer/.test(manifest.blurb) && /quest/.test(manifest.blurb) && manifest.legal === 'race');
    ok('four scripts in order (racetimer, dragy, race, quest), one stylesheet, the chip into #chips and the HUD into body',
      v && v.scripts.join() === 'racetimer.js,dragy.js,race.js,quest.js' && v.styles.join() === 'perf.css' &&
      v.fragments.length === 2 && v.fragments[0].mount === '#chips' && v.fragments[0].position === 'append' && /id="chip-dragy"/.test(v.fragments[0].html) &&
      v.fragments[1].mount === 'body' && v.fragments[1].position === 'append' && /id="race-hud"/.test(v.fragments[1].html) && /id="hud-quest"/.test(v.fragments[1].html));
    const onDisk = fs.readdirSync(PACK_DIR).filter((f) => f !== 'pack.json' && f !== 'README.md').sort();
    const listed = [].concat(manifest.scripts, manifest.styles, manifest.fragments.map((f) => f.file)).sort();
    ok('every file in the pack directory is listed in the manifest (nothing stray, nothing unserved)', onDisk.join() === listed.join(), onDisk.join() + ' vs ' + listed.join());
    ok('README.md is there and names every env key and the migration', (() => {
      const r = fs.readFileSync(path.join(PACK_DIR, 'README.md'), 'utf8');
      return /RACE_FIX_BUDGET/.test(r) && /RACE_FIX_IP_BUDGET/.test(r) && /RACE_COUNTDOWN_MS/.test(r) && /RACE_TEARDOWN_MS/.test(r) && /005_perf_stats\.sql/.test(r);
    })());
    ok('the migration creates both tables with RLS and the profiles cascade', (() => {
      const sql = fs.readFileSync(path.join(ROOT, 'server', 'migrations', '005_perf_stats.sql'), 'utf8');
      return /create table if not exists public\.user_stats/.test(sql) && /create table if not exists public\.dragy_pbs/.test(sql) &&
        (sql.match(/references public\.profiles\(id\) on delete cascade/g) || []).length === 2 &&
        /alter table public\.user_stats enable row level security/.test(sql) && /alter table public\.dragy_pbs\s+enable row level security/.test(sql);
    })());
    let mod = null, reqErr = null;
    try { mod = require('../server/packs/perf.js'); } catch (e) { reqErr = e; }
    ok('server/packs/perf.js loads with id "perf", routes under /api/perf/ and every ws type prefixed perf:',
      !reqErr && mod && mod.id === ID && mod.routes.every((r) => /^\^\\\/api\\\/perf\\\//.test(r[1].source)) &&
      Object.keys(mod.ws).length === 11 && Object.keys(mod.ws).every((t) => t.indexOf('perf:') === 0) &&
      typeof mod.onHello === 'function' && typeof mod.onClose === 'function', reqErr && reqErr.message);
    const src = fs.readFileSync(path.join(ROOT, 'server', 'packs', 'perf.js'), 'utf8');
    ok('the half never requires the core server, never exits, rate-limits through ctx.rateOk and persists only through ctx.db.query',
      !/require\((['"])\.\.\/server(\.js)?\1\)/.test(src) && !/process\.exit\(/.test(src) && /ctx\.rateOk\(/.test(src) && /ctx\.db\.query\(/.test(src) && !/require\(['"]\.\.\/(db|store)['"]\)/.test(src));
    let ids = null, loadErr = null;
    try { ids = packs.load({ hello() {}, pos() {}, wave() {} }); } catch (e) { loadErr = e; }
    if (loadErr && !new RegExp('packs/' + ID + '[/.]').test(loadErr.message)) {
      console.log('  (note) another pack failed to load, not ours: ' + loadErr.message);
      ok('server/packs load(): our manifest is not the one that failed', true);
    } else {
      ok('server/packs load() lists the pack, list() carries its public fields, and every perf: ws type is dispatchable', !loadErr && ids.indexOf(ID) >= 0 &&
        packs.list().some((p) => p.id === ID && p.title === 'Performance timers' && p.legal === 'race') &&
        Object.keys(mod.ws).every((t) => typeof packs.wsHandler(t) === 'function'), loadErr && loadErr.message);
    }
  }

  /* ================= B — discipline ================= */
  group('B — perf.css / the four scripts keep the core\'s discipline');
  {
    const css = fs.readFileSync(path.join(PACK_DIR, 'perf.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const sizes = Array.from(css.matchAll(/font-size:\s*([\d.]+)px/g)).map((m) => parseFloat(m[1]));
    ok('no font-size below 12px (' + sizes.length + ' declarations)', sizes.length > 0 && sizes.every((s) => s >= 12), sizes.filter((s) => s < 12).join(','));
    ok('no font shorthand below 12px either', !/font:\s*[^;]*\b(?:[0-9]|1[01])(?:\.\d+)?px/.test(css));
    ok('no backdrop-filter', !/backdrop-filter/.test(css));
    const infinite = Array.from(css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)).map((m) => m[1]);
    const framesOk = infinite.every((name) => {
      const m = new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\}\\s*\\}').exec(css);
      if (!m) return false;
      const props = Array.from(m[1].matchAll(/([a-z-]+)\s*:/g)).map((p) => p[1]);
      return props.length > 0 && props.every((p) => p === 'opacity' || p === 'transform');
    });
    ok('every infinite animation (' + infinite.join(',') + ') keys only opacity/transform, and [data-anim="off"] stops it', infinite.length > 0 && framesOk && /\[data-anim="off"\] \.race-countdown/.test(css));
    ok('the classes the core no longer carries are here (.u-ava-mini, .pf-empty, .pf-pb-table, .race-hud, .hud-quest)',
      ['.u-ava-mini', '.pf-empty', '.pf-pb-table', '.race-hud', '.hud-quest'].every((c) => css.indexOf(c) >= 0));
    for (const s of manifest.scripts) {
      const js = fs.readFileSync(path.join(PACK_DIR, s), 'utf8');
      ok(s + ': one IIFE, strict, no bare fetch(), exports only on window.App',
        /^\(function \(\) \{\s*'use strict';/m.test(js) && !/(^|[^.\w])fetch\(/.test(js) && !/\bwindow\.\w+\s*=/.test(js.replace(/window\.App\b/g, '')));
    }
    const first = fs.readFileSync(path.join(PACK_DIR, 'racetimer.js'), 'utf8');
    const last = fs.readFileSync(path.join(PACK_DIR, 'quest.js'), 'utf8');
    ok('the FIRST script registers the settings and the notice; the LAST registers the pack and every script listens for the packs event',
      /ST\.registerSettings\(\{ perfEnabled: false, showQuest: true \}\)/.test(first) && /registerFeatureNotice\(LEGAL_KEY/.test(first) && /var LEGAL_KEY = 'race'/.test(first) &&
      /A\.packs\.register\(P\.PACK/.test(last) && manifest.scripts.slice(1).every((s) => /ST\.on\('packs'/.test(fs.readFileSync(path.join(PACK_DIR, s), 'utf8'))));
    ok('every socket type the client sends or handles is perf:-prefixed', (() => {
      const all = manifest.scripts.map((s) => fs.readFileSync(path.join(PACK_DIR, s), 'utf8')).join('\n');
      const types = Array.from(all.matchAll(/\bt: '([\w:]+)'/g)).map((m) => m[1]).concat(Array.from(all.matchAll(/A\.net\.on\('([\w:]+)'/g)).map((m) => m[1]));
      return types.length >= 14 && types.every((t) => t.indexOf('perf:') === 0);
    })());
    ok('the fragments carry no inline style (the chip dot is a class in perf.css)', !/style=/.test(fs.readFileSync(path.join(PACK_DIR, 'chip.html'), 'utf8')) && !/style=/.test(fs.readFileSync(path.join(PACK_DIR, 'hud.html'), 'utf8')) && /\.dot-dragy/.test(css));
    ok('the only hidden-page setInterval is the race:fix relay, which transmits (not a fetch)', (() => {
      const js = fs.readFileSync(path.join(PACK_DIR, 'race.js'), 'utf8');
      return (js.match(/setInterval\(/g) || []).length === 1 && !/fetchT\(/.test(js);
    })());
  }

  /* ================= the page ================= */
  const { win, doc, A } = H.bootRealUi();
  A.store.load();
  A.ui.init();
  // Every toast the pack raises, in order. The core's #toasts keeps only the
  // three newest, so a long run's record toasts would evict the one a check
  // is looking for; the log does not.
  const TOASTS = [];
  const realToast = A.ui.toast;
  A.ui.toast = (msg, type) => { TOASTS.push(String(msg)); return realToast.call(A.ui, msg, type); };
  // The map is not up in jsdom: a remote rider must not need a marker.
  A.mapview.addNpc = () => {};
  A.mapview.removeNpc = () => {};
  A.mapview.map = () => null;
  const SENT = [];
  const netLive = { on: true };
  A.net.send = (m) => { SENT.push(m); };
  A.net.isLive = () => netLive.on;
  A.net.myId = () => 'me';
  const INBOUND = {};
  const realOn = A.net.on;
  A.net.on = (t, fn) => { INBOUND[t] = fn; return realOn.call(A.net, t, fn); };
  let pos = [-118.2437, 34.0522];
  A.sim.playerPos = () => (pos ? pos.slice() : null);
  A.sim.hasRealPos = () => !!pos;
  A.sim.playerHeading = () => 90;
  const FETCHES = [];
  let statsAnswer = { status: 200, body: { ok: true, stats: { pb: { quarter: { time: 13.1, trap: 46, when: 1 } }, runs: 3, wins: 1 } } };
  const fakeFetch = (url, opts) => {
    FETCHES.push({ url: String(url), opts });
    if (/\/api\/perf\/dragy\/pb$/.test(url)) return Promise.resolve({ ok: statsAnswer.status < 400, status: statsAnswer.status, json: async () => statsAnswer.body });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
  win.fetch = fakeFetch;
  try { global.fetch = fakeFetch; } catch (e) { /* ignore */ }
  let holding = true;
  A.packs.has = (id) => id === ID && holding;
  const defs = {};
  const realRegister = A.packs.register;
  A.packs.register = function (id, def) { defs[id] = def; return realRegister.call(A.packs, id, def); };
  const before = new Set(Object.getOwnPropertyNames(win));
  manifest.fragments.forEach((f) => A.packs._mountFragment({ mount: f.mount, position: f.position, html: fs.readFileSync(path.join(PACK_DIR, f.file), 'utf8') }));
  let evalErr = null;
  try { manifest.scripts.forEach((s) => win.eval(fs.readFileSync(path.join(PACK_DIR, s), 'utf8'))); } catch (e) { evalErr = e; }
  const leaked = Object.getOwnPropertyNames(win).filter((k) => !before.has(k));
  const toasts = () => TOASTS.slice();
  const modalCard = () => doc.querySelector('#onboarding .modal-card');
  const clickBtn = (root, re) => { const b = Array.from(root.querySelectorAll('button')).find((x) => re.test(x.textContent)); if (b) b.click(); return !!b; };
  const sentOf = (t) => SENT.filter((m) => m.t === t);

  /* ================= C — the timing core ================= */
  group('C — racetimer.js: the timing core, fed synthetic fixes');
  {
    ok('the scripts run in the real page without throwing', !evalErr, evalErr && (evalErr.stack || evalErr.message));
    ok('no new globals', leaked.length === 0, leaked.join(','));
    ok('A.racetimer / A.perf / A.dragy / A.race / A.quest are exported with the old surfaces',
      typeof A.racetimer.make === 'function' && Array.isArray(A.racetimer.PRESETS) && A.racetimer.PRESETS.length === 8 && typeof A.racetimer.modeById === 'function' &&
      ['gate', 'held', 'enabled', 'active', 'getStats', 'adoptStats', 'remoteStats', 'fetchOwnStats', 'requestStats'].every((k) => typeof A.perf[k] === 'function') &&
      ['open', 'close', 'setMode', 'modes', 'modeLabel', 'modeById', 'bestsFromStats', 'pbRowsHtml'].every((k) => typeof A.dragy[k] === 'function') &&
      ['create', 'join', 'challenge', 'setReady', 'start', 'leave', 'endEarly', 'onState', 'onInvite', 'onFix', 'onErr', 'active'].every((k) => typeof A.race[k] === 'function') &&
      ['init', 'records', 'reset'].every((k) => typeof A.quest[k] === 'function'));
    const T0 = 1700000000000;
    const feedRun = (t, accel, from, hz, secs) => {
      // v = from + a·τ from a standing (or rolling) start, sampled at hz for secs
      const step = 1000 / hz;
      for (let i = 0; i <= secs * hz; i++) {
        const tau = i / hz;
        const v = tau === 0 && from === 0 ? 0 : from + accel * tau;
        t.feed({ pos: [-118.2437 + 0.00001 * i, 34.0522], speed: v, t: T0 + i * step });
      }
    };
    let launched = 0, fin = null;
    const t60 = A.racetimer.make(A.racetimer.modeById('0-60'), { onLaunch: () => launched++, onFinish: (r) => { fin = r; } });
    t60.resetArm();
    ok('a fresh timer is armed, unstaged, progress 0', t60.state().phase === 'arm' && !t60.state().staged && t60.state().progress === 0);
    t60.feed({ pos: [-118.2437, 34.0522], speed: 0, t: T0 - 2000 });
    t60.feed({ pos: [-118.2437, 34.0522], speed: 0, t: T0 - 1000 });
    ok('two stationary fixes stage it', t60.state().staged === true && t60.state().phase === 'arm');
    feedRun(t60, 4, 0, 10, 8);
    // Under constant a from the EPS crossing (v=0.3 at τ=0.075 s): the 60 mph crossing at τ=6.706 s → 6.631 s after launch
    const expect60 = (60 * MPH - 0.3) / 4;
    ok('standing 0–60 at 4 m/s² launches once and finishes', launched === 1 && !!fin && fin.modeId === '0-60' && t60.state().phase === 'done');
    near('…on the analytic time', fin ? fin.time : 0, expect60, 0.03, 's');
    ok('a done timer ignores further fixes until re-armed', (t60.feed({ pos: [0, 0], speed: 0, t: T0 + 20000 }), t60.state().phase === 'done'));
    let q = null;
    const tq = A.racetimer.make(A.racetimer.modeById('quarter'), { onFinish: (r) => { q = r; } });
    tq.resetArm();
    tq.feed({ pos: [-118.2437, 34.0522], speed: 0, t: T0 - 2000 });
    tq.feed({ pos: [-118.2437, 34.0522], speed: 0, t: T0 - 1000 });
    feedRun(tq, 5, 0, 10, 16);
    // d = v0·τ + ½aτ² with v0 = 0.3 → τ = (-v0 + sqrt(v0² + 2aD)) / a
    const D = 1609.344 / 4, tauQ = (-0.3 + Math.sqrt(0.09 + 2 * 5 * D)) / 5;
    ok('a ¼ mile finishes with a trap speed', !!q && q.modeId === 'quarter' && q.trap != null);
    near('…time solved from the quadratic', q ? q.time : 0, tauQ, 0.03, 's');
    near('…trap read at the solved instant (v0 + a·τ)', q ? q.trap : 0, 0.3 + 5 * tauQ, 0.3, 'm/s');
    let roll = null;
    const tr = A.racetimer.make(A.racetimer.modeById('60-130'), { onFinish: (r) => { roll = r; } });
    tr.resetArm();
    for (let i = 0; i <= 40; i++) tr.feed({ pos: [-118.2437, 34.0522 + 0.0001 * i], speed: 20 + i * 1.5, t: T0 + i * 1000 });
    ok('a rolling 60–130 brackets its `from` on the way up and finishes', !!roll && roll.modeId === '60-130' && roll.trap === null);
    near('…time = (130−60 mph) / 1.5 m/s²', roll ? roll.time : 0, (130 * MPH - 60 * MPH) / 1.5, 0.02, 's');
    let aborted = 0;
    const ta = A.racetimer.make(A.racetimer.modeById('0-100'), { onAbort: () => aborted++ });
    ta.resetArm();
    ta.feed({ pos: [0, 0], speed: 0, t: T0 });
    ta.feed({ pos: [0, 0], speed: 0, t: T0 + 1000 });
    ta.feed({ pos: [0, 0], speed: 5, t: T0 + 2000 });
    ok('(launched)', ta.state().phase === 'run');
    ta.feed({ pos: [0, 0], speed: 0.2, t: T0 + 3000 });
    ta.feed({ pos: [0, 0], speed: 0.2, t: T0 + 4000 });
    ta.feed({ pos: [0, 0], speed: 0.2, t: T0 + 5000 });
    ok('a sustained stop mid-run aborts and re-arms', aborted === 1 && ta.state().phase === 'arm' && ta.state().prev === undefined);
    const tg = A.racetimer.make(A.racetimer.modeById('0-60'));
    tg.resetArm();
    let gErr = null;
    try { tg.feed(null); tg.feed({}); tg.feed({ pos: [0, 0], speed: -4, t: 'x' }); tg.feed({ pos: [0, 0], speed: NaN }); } catch (e) { gErr = e; }
    ok('feed() survives garbage', !gErr && tg.state().phase === 'arm', gErr && gErr.message);
    let mErr = null;
    try { A.racetimer.make(null); } catch (e) { mErr = e; }
    ok('make() without a mode throws (a programming error, not a rider path)', !!mErr);
    ok('Doppler missing: speed is derived from the position delta', (() => {
      const t = A.racetimer.make(A.racetimer.modeById('0-30'));
      t.resetArm();
      t.feed({ pos: [-118.2437, 34.0522], speed: null, t: T0 });
      t.feed({ pos: [-118.2437, 34.0522], speed: null, t: T0 + 1000 });
      t.feed({ pos: [-118.2437, 34.0522 + 0.0002], speed: null, t: T0 + 2000 });   // ~22 m in 1 s
      // ~22 m/s is already past 30 mph, so the one segment launches AND finishes
      return t.state().liveSpeed > 15 && t.state().phase === 'done' && t.state().result.modeId === '0-30';
    })());
  }

  /* ================= D — in the page ================= */
  group('D — in the page: settings, chip, notice, settings section, the meter, profile hooks, the race chain, stand-down');
  {
    ok('registerSettings: perfEnabled defaults OFF, showQuest ON, and setSetting() accepts both',
      A.state.settings.perfEnabled === false && A.state.settings.showQuest === true &&
      (A.store.setSetting('showQuest', true), A.store.setSetting('perfEnabled', false), true));
    const js = manifest.scripts.map((s) => fs.readFileSync(path.join(PACK_DIR, s), 'utf8')).join('\n');
    const ids = Array.from(js.matchAll(/document\.getElementById\('([\w-]+)'\)/g)).map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
    ok('every document.getElementById in the pack resolves on the page as mounted, or is an id the pack assigns (' + ids.join(',') + ')',
      ids.every((id) => !!doc.getElementById(id) || id === 'pf-times'), ids.filter((id) => !doc.getElementById(id)).join(','));
    const chip = doc.getElementById('chip-dragy');
    const hud = doc.getElementById('race-hud');
    const quest = doc.getElementById('hud-quest');
    const chipIds = chip ? Array.from(chip.parentNode.children).map((e) => e.id) : [];
    ok('the chip is in #chips after the core\'s chips and hidden; #race-hud and #hud-quest are on body, hidden',
      !!chip && chip.parentNode.id === 'chips' && chipIds.indexOf('chip-dragy') > chipIds.indexOf('chip-global') && chip.hidden === true &&
      !!hud && hud.parentNode === doc.body && hud.hidden === true && !!quest && quest.parentNode === doc.body && quest.hidden === true, chipIds.join(','));

    /* ---- the notice ---- */
    A.store.setConsent({ passenger: true, age: true, terms: true });
    let proceeded = 0, cancelled = 0;
    A.ui.legalGate('race', () => proceeded++, () => cancelled++);
    let card = modalCard();
    ok('registerFeatureNotice(\'race\'): legalGate opens the OLD notice text (title, lede, the three points)',
      proceeded === 0 && !!card && /Track and private land only/.test(card.textContent) && /measure acceleration from GPS/.test(card.textContent) &&
      /closed course, private land, or a licensed track/.test(card.textContent) && /street racing/.test(card.textContent) && /passenger/.test(card.textContent), card && card.textContent.slice(0, 200));
    clickBtn(card, /Not now/);
    ok('"Not now" cancels and nothing is acknowledged', cancelled === 1 && !A.store.featureAcked('race'));

    /* ---- init: the registered def, as the loader runs it ---- */
    ok('A.packs.register(\'perf\', { init }) was called by the LAST script', !!defs[ID] && typeof defs[ID].init === 'function');
    A.store.setAuth({ token: 'tok', username: 'me', expiresAt: Date.now() + 3600000 });
    let initErr = null;
    try { defs[ID].init(); } catch (e) { initErr = e; }
    ok('init() runs; chip and quest card stay hidden while the setting is off', !initErr && chip.hidden === true && quest.hidden === true, initErr && initErr.message);
    await H.waitFor(() => FETCHES.some((f) => /\/api\/perf\/dragy\/pb$/.test(f.url)), 2000);
    const f0 = FETCHES.find((f) => /\/api\/perf\/dragy\/pb$/.test(f.url));
    ok('init() seeds the rider\'s own stats: GET /api/perf/dragy/pb through fetchT with the bearer', !!f0 && f0.opts && f0.opts.signal && f0.opts.headers.Authorization === 'Bearer tok');
    await H.waitFor(() => !!A.perf.getStats('self'), 2000);
    ok('…and adopts the answer (A.perf.getStats(\'self\'))', !!A.perf.getStats('self') && A.perf.getStats('self').runs === 3 && A.perf.getStats('self').pb.quarter.time === 13.1);
    chip.click();
    ok('a tap on the (hidden) chip while the setting is off opens nothing', !doc.getElementById('dragy'));
    ok('A.race.create() while the setting is off refuses with a toast and sends nothing', A.race.create('quarter') === false && SENT.length === 0 && /Switch on Performance timers/.test(toasts().join(' ')));

    /* ---- the Settings section, through the hook ---- */
    A.ui.openPanel('profile');
    await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 2000);
    const host = doc.getElementById('settings-host');
    const row = Array.from(host.querySelectorAll('.setting-row')).find((r) => /^Performance timers/.test(r.textContent));
    const toggle = row && row.querySelector('.toggle');
    const qrow = Array.from(host.querySelectorAll('.setting-row')).find((r) => /Top speed quest/.test(r.textContent));
    ok('the "Performance timers" section renders in Settings: the master switch (off), the quest switch (on), the note',
      !!toggle && !toggle.classList.contains('on') && !!qrow && qrow.querySelector('.toggle').classList.contains('on') && /closed course/.test(host.textContent));
    const labels = Array.from(host.querySelectorAll('.section-label')).map((l) => l.textContent);
    ok('…placed before the Feature packs section', labels.indexOf('Performance timers') >= 0 && labels.indexOf('Performance timers') < labels.indexOf('Feature packs'), labels.join('|'));
    ok('the profile page carries the "Fastest times" section through the \'profile\' hook, with the tally and the server PB',
      /Fastest times/.test(doc.getElementById('profile-body').textContent) && !!doc.getElementById('pf-times') &&
      /3.*runs/.test(doc.getElementById('pf-times').textContent) && /13\.10s/.test(doc.getElementById('pf-times').textContent) && /¼ mile/.test(doc.getElementById('pf-times').textContent));
    toggle.click();
    card = modalCard();
    ok('switching it on opens the legality notice first and does NOT change the setting', !!card && /Track and private land/.test(card.textContent) && A.state.settings.perfEnabled === false);
    clickBtn(card, /Not now/);
    ok('"Not now" puts the switch back; chip and quest stay hidden', !toggle.classList.contains('on') && toggle.getAttribute('aria-checked') === 'false' && A.state.settings.perfEnabled === false && chip.hidden === true && quest.hidden === true);
    toggle.click();
    clickBtn(modalCard(), /I understand/);
    ok('"I understand" acknowledges, switches the setting on, shows the chip and the quest card',
      A.store.featureAcked('race') && A.state.settings.perfEnabled === true && toggle.classList.contains('on') && chip.hidden === false && quest.hidden === false);
    const saved = JSON.parse(win.localStorage.getItem('convoy.v1'));
    ok('the setting and the acknowledgement persist', saved.settings.perfEnabled === true && !!(saved.featureAck && saved.featureAck.race));
    A.ui.closePanels();

    /* ---- the meter ---- */
    chip.click();
    const dragy = doc.getElementById('dragy');
    ok('the chip tap (acknowledged) opens the meter: a dialog with the 8 presets, 0–60 selected (miles)',
      !!dragy && dragy.hidden === false && dragy.getAttribute('role') === 'dialog' && dragy.querySelectorAll('.dragy-mode').length === 8 &&
      dragy.querySelector('.dragy-mode.active').getAttribute('data-id') === '0-60' && A.dragy.isOpen());
    const T0 = Date.now() - 20000;
    const fix = (i, v) => A.store.emit('gpsfix', { pos: [-118.2437 + 0.00001 * i, 34.0522], speed: v, t: T0 + i * 100 });
    fix(0, 0); fix(1, 0);
    ok('two stationary fixes stage the meter', A.dragy._state().staged === true && A.dragy._state().phase === 'arm');
    for (let i = 2; i <= 90; i++) fix(i, (i - 1) * 0.4);   // 4 m/s²
    await H.waitFor(() => A.dragy._state().phase === 'done', 2000);
    const r = A.dragy._state().result;
    ok('a run finishes: result with splits (60 ft, 0–30), a PB badge, the headline and the history row',
      !!r && r.modeId === '0-60' && r.pb === true && !!r.splits['60ft'] && !!r.splits['0-30'] &&
      dragy.querySelector('#dragy-result').hidden === false && /PB/.test(dragy.querySelector('.dragy-headline').textContent) &&
      dragy.querySelectorAll('.dragy-run').length === 1 && /0–60 mph/.test(dragy.querySelector('.dragy-run').textContent));
    near('…on the analytic time', r ? r.time : 0, (60 * MPH - 0.3) / 4, 0.03, 's');
    const hist = JSON.parse(win.localStorage.getItem('convoy.dragy.v1'));
    ok('the run is in localStorage history (convoy.dragy.v1)', Array.isArray(hist) && hist.length === 1 && hist[0].modeId === '0-60');
    const pbMsg = sentOf('perf:dragy:pb')[0];
    ok('a signed-in PB goes to the server over the socket as perf:dragy:pb { modeId, time, trap:null }', !!pbMsg && pbMsg.modeId === '0-60' && Math.abs(pbMsg.time - r.time) < 1e-9 && pbMsg.trap === null);
    INBOUND['perf:stats']({ t: 'perf:stats', id: 'self', stats: { pb: { '0-60': { time: r.time, trap: null, when: 1 }, quarter: { time: 13.1, trap: 46, when: 1 } }, runs: 3, wins: 1 } });
    ok('the server\'s perf:stats echo is adopted', A.perf.getStats('self').pb['0-60'].time === r.time);
    clickBtn(dragy, /Re-arm/);
    ok('Re-arm: phase back to arm, result hidden', A.dragy._state().phase === 'arm' && dragy.querySelector('#dragy-result').hidden === true);
    A.dragy.setMode('quarter');
    ok('setMode(): the ¼ mile tab is active', dragy.querySelector('.dragy-mode.active').getAttribute('data-id') === 'quarter');
    dragy.querySelector('#dragy-close').click();
    await H.waitFor(() => dragy.hidden === true, 2000);
    ok('close: the overlay hides and the meter goes idle', dragy.hidden === true && !A.dragy.isOpen() && A.dragy._state().phase === 'idle');

    /* ---- the public-profile overlay: bests + Challenge ---- */
    A.sim.remoteAdd({ id: 'n1', name: 'Nia', handle: 'nia', emoji: 3, vibe: 'x', account: 'nia', car: { year: 2020, make: 'Honda', model: 'Civic', paint: '#ff0000', finish: 'Gloss' }, pos: [-118.2440, 34.0525], heading: 0 });
    ok('(a nearby rider exists)', !!A.sim.getNpc('n1'));
    SENT.length = 0;
    A.ui.openProfileOverlay('n1');
    card = modalCard();
    ok('the overlay carries the bests strip, "Best dragy times" (empty) and asks the server for the rider\'s stats (perf:stats:get)',
      !!card && card.classList.contains('profile-overlay') && /Best dragy times/.test(card.textContent) && /No timed runs yet/.test(card.textContent) &&
      /bests/.test(card.querySelector('.pf-po-strip').textContent) && sentOf('perf:stats:get').length === 1 && sentOf('perf:stats:get')[0].id === 'n1');
    const bestsLabel = Array.from(card.querySelectorAll('.section-label')).map((l) => l.textContent);
    ok('…slotted before the "Car" section', bestsLabel.indexOf('Best dragy times') >= 0 && bestsLabel.indexOf('Best dragy times') < bestsLabel.indexOf('Car'), bestsLabel.join('|'));
    INBOUND['perf:dragy:pb']({ t: 'perf:dragy:pb', id: 'n1', stats: { pb: { quarter: { time: 11.9, trap: 52, when: 1 } }, runs: 7, wins: 2 } });
    ok('a perf:dragy:pb for that rider re-renders the open overlay in place (11.90s, trap 116 mph, 7 races, 2 wins)',
      /11\.90s/.test(card.textContent) && /trap 116 mph/.test(card.textContent) && /7races/.test(card.querySelector('.pf-po-strip').textContent.replace(/\s/g, '')) && A.perf.getStats('n1').wins === 2, card.textContent.slice(0, 300));
    INBOUND['perf:stats']({ t: 'perf:stats', id: 'n1', stats: null });
    ok('perf:stats { id, stats: null } (a guest, or hidden from an unverified viewer) clears what we held', A.perf.getStats('n1') === null);
    const challengeBtn = Array.from(card.querySelectorAll('button')).find((b) => /Challenge to race/.test(b.textContent));
    ok('the "Challenge to race" button is on the action row (profile-overlay hook)', !!challengeBtn && challengeBtn.parentNode.classList.contains('pf-po-actions'));
    challengeBtn.click();
    ok('Challenge: creates a ¼ mile race (perf:race:create) and closes the overlay', sentOf('perf:race:create').length === 1 && sentOf('perf:race:create')[0].modeId === 'quarter' && doc.getElementById('onboarding').classList.contains('closing'));
    await H.waitFor(() => doc.getElementById('onboarding').hidden === true, 2000);

    /* ---- the race chain, from server state ---- */
    const mem = (id, name, extra) => Object.assign({ id, name, emoji: 1, paint: '#fff', ready: false, finished: false, time: null, trap: null, dnf: false }, extra || {});
    const state = (status, members, extra) => ({ t: 'perf:race:state', race: Object.assign({ id: 'rabc', modeId: 'quarter', host: 'me', status, startedAt: 0, isHost: true, members }, extra || {}) });
    INBOUND['perf:race:state'](state('lobby', [mem('me', 'Me')]));
    card = modalCard();
    ok('lobby state → the lobby card: title, ¼ mile pill, roster with (you), Ready, Start (disabled: one racer), Leave, the host hint',
      !!card && /Your race lobby/.test(card.textContent) && /¼ mile/.test(card.querySelector('.race-mode-pill').textContent) && card.querySelectorAll('.race-member').length === 1 &&
      /\(you\)/.test(card.textContent) && Array.from(card.querySelectorAll('button')).some((b) => /Start race/.test(b.textContent) && b.disabled) && /Challenge from a rider/.test(card.textContent));
    ok('…and the pending challenge invite went out as perf:race:invite { to }', sentOf('perf:race:invite').length === 1 && sentOf('perf:race:invite')[0].to === 'n1');
    clickBtn(card, /^Ready$/);
    ok('Ready sends perf:race:ready { on:true }', sentOf('perf:race:ready').length === 1 && sentOf('perf:race:ready')[0].on === true);
    INBOUND['perf:race:state'](state('lobby', [mem('me', 'Me', { ready: true }), mem('n1', 'Nia', { ready: true })]));
    card = modalCard();
    ok('two ready racers: Start enabled, "Not ready" offered', Array.from(card.querySelectorAll('button')).some((b) => /Start race/.test(b.textContent) && !b.disabled) && /Not ready/.test(card.textContent) && card.querySelectorAll('.tag-live').length === 2);
    clickBtn(card, /Start race/);
    ok('Start sends perf:race:start', sentOf('perf:race:start').length === 1);
    INBOUND['perf:race:state'](state('countdown', [mem('me', 'Me', { ready: true }), mem('n1', 'Nia', { ready: true })], { startedAt: Date.now() + 2500 }));
    card = modalCard();
    ok('countdown state → the countdown in the card (3)', !!card && /^3$/.test(card.querySelector('.race-countdown').textContent.trim()));
    INBOUND['perf:race:state'](state('running', [mem('me', 'Me', { ready: true }), mem('n1', 'Nia', { ready: true })], { startedAt: Date.now() }));
    await H.waitFor(() => hud.hidden === false && hud.querySelectorAll('.race-row').length === 2, 2000);
    ok('running → the lobby closes, #race-hud shows with a row per racer (self first), one timer per racer armed',
      hud.hidden === false && hud.querySelectorAll('.race-row').length === 2 && hud.querySelector('.race-row').classList.contains('race-row-self') &&
      Object.keys(A.race._timers()).sort().join() === 'me,n1' && A.race._timers().me.state().phase === 'arm' && A.race.active());
    await H.waitFor(() => sentOf('perf:race:fix').length >= 1, 2000);
    const fx = sentOf('perf:race:fix')[0];
    ok('the ~10 Hz relay sends perf:race:fix { lng, lat, speed, heading, acc, ts } from the player position', !!fx && fx.lng === pos[0] && fx.lat === pos[1] && fx.heading === 90 && typeof fx.ts === 'number');
    INBOUND['perf:race:fix']({ t: 'perf:race:fix', from: 'n1', lng: -118.2440, lat: 34.0525, speed: 0, ts: Date.now() - 2000 });
    INBOUND['perf:race:fix']({ t: 'perf:race:fix', from: 'n1', lng: -118.2440, lat: 34.0525, speed: 0, ts: Date.now() - 1000 });
    INBOUND['perf:race:fix']({ t: 'perf:race:fix', from: 'n1', lng: -118.2440, lat: 34.0526, speed: 9, ts: Date.now() });
    ok('a remote perf:race:fix feeds that racer\'s timer (staged, then launched)', A.race._timers().n1.state().phase === 'run' && A.race._timers().n1.state().liveSpeed === 9);
    const T1 = Date.now() - 20000;
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 0, t: T1 });
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 0, t: T1 + 100 });
    for (let i = 2; i <= 170; i++) A.store.emit('gpsfix', { pos: [-118.2437 + 0.00001 * i, 34.0522], speed: (i - 1) * 0.5, t: T1 + i * 100 });
    await H.waitFor(() => sentOf('perf:race:finish').length === 1, 2000);
    const finMsg = sentOf('perf:race:finish')[0];
    ok('our own gpsfix stream times the ¼ mile and reports perf:race:finish { time, trap }', !!finMsg && finMsg.time > 10 && finMsg.time < 15 && finMsg.trap > 40 && /You finished in/.test(toasts().join(' ')));
    A.race._paintHud();
    ok('the HUD shows our finish (🏁) and the other racer\'s progress', /🏁/.test(hud.textContent) && /Nia/.test(hud.textContent));
    INBOUND['perf:race:state'](state('finished', [mem('me', 'Me', { finished: true, time: finMsg.time, trap: finMsg.trap }), mem('n1', 'Nia', { finished: true, dnf: true })]));
    card = modalCard();
    await H.waitFor(() => hud.hidden === true, 2000);
    ok('finished → the HUD hides and the results card lists 🥇 Me with the time + trap + PB, Nia as DNF, and the race is over',
      hud.hidden === true && !!card && /Results/.test(card.textContent) && /🥇/.test(card.textContent) && card.querySelector('.race-result-self') &&
      /DNF/.test(card.querySelector('.race-result-dnf').textContent) && /PB/.test(card.textContent) && !A.race.active() && Object.keys(A.race._timers()).length === 0);
    clickBtn(card, /Done/);
    await H.waitFor(() => doc.getElementById('onboarding').hidden === true, 2000);

    /* ---- an invite ---- */
    INBOUND['perf:race:invite']({ t: 'perf:race:invite', from: 'n1', fromName: 'Nia', raceId: 'rzzz', modeId: '0-60' });
    const inv = doc.querySelector('#toasts .toast-invite');
    ok('an inbound perf:race:invite becomes a Join/Pass toast naming the rider and the race', !!inv && /Nia/.test(inv.textContent) && /0–60 mph race/.test(inv.textContent));
    clickBtn(inv, /Join/);
    ok('Join sends perf:race:join { id } (the notice is already acknowledged)', sentOf('perf:race:join').length === 1 && sentOf('perf:race:join')[0].id === 'rzzz');
    INBOUND['perf:err']({ t: 'perf:err', msg: 'That race is gone' });
    ok('perf:err is toasted', /That race is gone/.test(toasts().join(' ')));
    INBOUND['perf:race:state']({ t: 'perf:race:state', race: null });
    ok('race:null with no race open is a no-op', !A.race.active() && doc.getElementById('onboarding').hidden === true);

    /* ---- stand-down: the grant goes away ---- */
    INBOUND['perf:race:state'](state('lobby', [mem('me', 'Me')]));
    chip.click();
    ok('(a lobby and the meter are open)', !!modalCard() && A.dragy.isOpen());
    holding = false;
    SENT.length = 0;
    let emitErr = null;
    try { A.store.emit('packs', A.packs.state()); } catch (e) { emitErr = e; }
    await H.waitFor(() => dragy.hidden === true && doc.getElementById('onboarding').hidden === true, 2000);
    // No perf:race:leave frame here: the grant is gone, so the pack sends
    // nothing (the server would drop it anyway) and simply forgets the race.
    ok('the packs event with A.packs.has(\'perf\') false forgets the race without a frame, closes the lobby and the meter, hides the chip, the HUD and the quest card',
      !emitErr && sentOf('perf:race:leave').length === 0 && !A.race.active() && dragy.hidden === true && chip.hidden === true && hud.hidden === true && quest.hidden === true && doc.getElementById('onboarding').hidden === true, emitErr && emitErr.message);
    chip.click();
    A.dragy.open();
    ok('…and neither the chip nor open() shows anything while the pack is not held', dragy.hidden === true && A.race.create('quarter') === false);
    holding = true;
    A.store.emit('packs', A.packs.state());
    ok('the grant coming back shows the chip and the quest card again (the setting is still on)', chip.hidden === false && quest.hidden === false);

    /* ---- stand-down: the setting goes off ---- */
    chip.click();
    INBOUND['perf:race:state'](state('lobby', [mem('me', 'Me')]));
    SENT.length = 0;
    A.store.setSetting('perfEnabled', false);
    await H.waitFor(() => dragy.hidden === true, 2000);
    ok('switching the setting off closes the meter, leaves the race, hides the chip and the quest card', dragy.hidden === true && sentOf('perf:race:leave').length === 1 && chip.hidden === true && quest.hidden === true);
    A.dragy.setEnabled(true);
    ok('setEnabled(true) (post-acknowledgement) shows the chip', A.state.settings.perfEnabled === true && chip.hidden === false);

    /* ---- offline / no position ---- */
    netLive.on = false;
    ok('create() offline refuses with a toast', A.race.create('0-60') === false && /live connection/.test(toasts().join(' ')));
    netLive.on = true;
    pos = null;
    ok('challenge() without a position refuses with a toast', A.race.challenge('n1') === false && /Set your location/.test(toasts().join(' ')));
    pos = [-118.2437, 34.0522];

    /* ---- handlers never throw on garbage ---- */
    let hErr = null;
    try {
      ['perf:race:state', 'perf:race:invite', 'perf:race:fix', 'perf:err', 'perf:dragy:pb', 'perf:stats'].forEach((t) => {
        INBOUND[t](null); INBOUND[t]({}); INBOUND[t]({ t, race: 'x', id: 7, stats: 'nope', from: {}, lng: 'a' });
      });
      A.store.emit('setting', null); A.store.emit('setting', { key: 'other' }); A.store.emit('packs', undefined); A.store.emit('perf:stats', null);
      A.store.emit('gpsfix', null); A.store.emit('gpsfix', {});
      A.race.onFix({ from: 'nobody', lng: 1, lat: 1 }); A.race.leave(); A.race.leave(); A.dragy.close(); A.dragy.close();
      A.perf.remoteStats(null, {}); A.perf.remoteStats('self', {}); A.perf.adoptStats('garbage'); A.perf.requestStats(null);
    } catch (e) { hErr = e; }
    ok('every inbound handler and event listener survives garbage input', !hErr, hErr && (hErr.stack || hErr.message));
    ok('the bests table sorts by preset order and falls back to the raw id; empty → "No timed runs yet"', (() => {
      const rows = A.dragy.bestsFromStats({ pb: { quarter: { time: 12 }, '0-60': { time: 5 }, weird: { time: 1 }, bad: { time: 'x' } } }, false);
      return rows.map((r) => r.modeId).join() === '0-60,quarter,weird' && /weird/.test(A.dragy.pbRowsHtml(rows)) && /No timed runs yet/.test(A.dragy.pbRowsHtml([]));
    })());
  }

  /* ================= E — the quest ================= */
  group('E — quest.js: top-speed records, the glitch filter, the 60–100 pull, idle when the pack is off');
  {
    const quest = doc.getElementById('hud-quest');
    A.quest.reset();
    const nTop = () => toasts().filter((m) => /New top speed/.test(m)).length;
    const n0 = nTop();   // the race run in D already climbed to a top speed
    ok('fresh: the card reads — / top mph / 60–100: —', quest.hidden === false && doc.getElementById('qs-v').textContent === '—' && /top mph/.test(doc.getElementById('qs-l').textContent) && /60–100: —/.test(doc.getElementById('qs-s').textContent));
    const T = Date.now() - 60000;
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 30, t: T });
    ok('a lone fix only baselines (no record yet)', A.quest.records().topMs === 0 && nTop() === n0);
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 31, t: T + 1000 });
    ok('a second consistent fix within 4 s sets the record (31 m/s → 69 mph), the card flashes and a toast lands',
      A.quest.records().topMs === 31 && doc.getElementById('qs-v').textContent === '69' && quest.classList.contains('quest-flash') && nTop() === n0 + 1 && /New top speed: 69 mph/.test(toasts()[toasts().length - 1]), toasts().slice(-2).join(' | '));
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 120, t: T + 2000 });
    ok('an implausible jump (31 → 120 m/s in 1 s, > 1.5 g) is dropped', A.quest.records().topMs === 31);
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 200, t: T + 3000 });
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 200, t: T + 4000 });
    ok('a > 335 mph fix is never a record', A.quest.records().topMs === 31);
    ok('the record persists (convoy.quest.v1)', JSON.parse(win.localStorage.getItem('convoy.quest.v1')).topMs === 31);
    // A 60–100 pull: below 60 mph, then up through 100 at 2 m/s².
    const t = A.quest._timer();
    ok('the 60–100 timer is armed while the quest is on', !!t && t.state().phase === 'arm');
    const T2 = Date.now() - 30000;
    for (let i = 0; i <= 30; i++) A.store.emit('gpsfix', { pos: [-118.2437, 34.0522 + 0.0001 * i], speed: 24 + i * 1, t: T2 + i * 1000 });
    const rec = A.quest.records();
    ok('dip below 60, floor it through 100: the pull is timed and becomes the record, the timer re-arms', rec.t60100 != null && t.state().phase === 'arm' && /Quest: fastest 60–100/.test(toasts().join(' ')));
    near('…time = (100−60 mph) / 1 m/s²', rec.t60100 || 0, (100 * MPH - 60 * MPH) / 1, 0.05, 's');
    A.store.setSetting('showQuest', false);
    ok('showQuest off hides the card and idles the timer', quest.hidden === true && t.state().phase === 'idle');
    A.store.setSetting('showQuest', true);
    ok('…and back on re-arms it', quest.hidden === false && t.state().phase === 'arm');
    // 23 fixes beat the record on the way up; the toast is throttled to one per
    // 8 s of fixes (the card still flashes on each), so 1–4 toasts, never 23.
    ok('the climbing pull raised the top speed too (54 m/s), with the toast throttled (not one per fix)',
      A.quest.records().topMs === 54 && nTop() - n0 - 1 >= 1 && nTop() - n0 - 1 <= 4, String(A.quest.records().topMs) + ' / ' + (nTop() - n0 - 1));
    const topBefore = A.quest.records().topMs;
    A.store.setSetting('perfEnabled', false);
    ok('the regulated switch off idles the quest too (a 60–100 pull is a timed run)', quest.hidden === true && t.state().phase === 'idle');
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 100, t: Date.now() });
    A.store.emit('gpsfix', { pos: [-118.2437, 34.0522], speed: 101, t: Date.now() + 1000 });
    ok('…and no fix scores while it is off', A.quest.records().topMs === topBefore);
    A.store.setSetting('perfEnabled', true);
  }

  /* ================= F — the server half ================= */
  group('F — server/packs/perf.js against a fake ctx: stats, the gated route, every handler, the race lifecycle (the old race-lifecycle cases)');
  {
    // The SAME module instance packs.load() registered in group A, so the route
    // reached through packs.handleApi() below reads the stats this init() loads.
    const mod = require('../server/packs/perf.js');
    const clients = new Map();
    const hits = new Map();
    const deferred = [];
    const DB = { writes: [], fail: false, rows: { user_stats: [{ user_id: 'u-a', runs: 2, wins: 1 }], dragy_pbs: [{ user_id: 'u-a', mode_id: '0-60', time_s: 6.2, trap: null, when_ms: 5 }, { user_id: 'u-a', mode_id: 'bogus', time_s: 1, trap: null, when_ms: 5 }] } };
    const accounts = { 'u-a': { id: 'u-a' }, 'u-b': { id: 'u-b' }, 'u-c': { id: 'u-c' }, 'u-z': { id: 'u-z' } };
    const blocks = new Set();
    const users = { 'tok-a': { id: 'u-a', username: 'alpha' }, 'tok-z': { id: 'u-z', username: 'zed' } };
    const grants = { 'u-a': ['perf'], 'u-z': [] };
    const ctx = {
      clients, online: new Map(), bots: new Map(),
      send: (c, m) => { c.frames.push(m); },
      rateOk: (key, max, win) => { const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < win); hits.set(key, arr); if (arr.length >= max) return false; arr.push(now); return true; },
      getRider: (id) => clients.get(id) || null,
      riderName: (c) => (c.bot ? c.name : c.profile.name),
      blockedPair: (a, b) => !!(a && b && a.userId && b.userId && (blocks.has(a.userId + '|' + b.userId) || blocks.has(b.userId + '|' + a.userId))),
      gated: (c) => !!(c && c.gatedViewer),
      validPos: (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && isFinite(p[0]) && Math.abs(p[0]) <= 180 && typeof p[1] === 'number' && isFinite(p[1]) && Math.abs(p[1]) <= 85,
      num: (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d),
      defer: (fn, ms) => { const t = { fn, ms, fired: false, unref() { return t; } }; deferred.push(t); return t; },
      json: (res, status, obj) => { res.status = status; res.body = obj; },
      bearer: (req) => ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '') || null,
      userFromToken: (tok) => users[tok] || null,
      clientIp: (req) => (req.headers && req.headers['x-ip']) || '1.1.1.1',
      store: { getById: (id) => accounts[id] || null, hasPack: (uid, id) => !!(grants[uid] && grants[uid].indexOf(id) >= 0), packsOf: (uid) => (grants[uid] || []).slice(), packHolders: () => 1 },
      db: { query: async (sql, params) => {
        if (DB.fail) throw new Error('db down');
        if (/^select user_id, runs, wins/.test(sql)) return { rows: DB.rows.user_stats };
        if (/^select user_id, mode_id/.test(sql)) return { rows: DB.rows.dragy_pbs };
        DB.writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rows: [] };
      } },
      flags: { pick: (name, d) => d },
      B: { haversine: (a, b) => { const R = 6371000, toR = Math.PI / 180, dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); } },
      NEARBY_KM: 30
    };
    const fire = () => { const f = deferred.filter((t) => !t.fired); f.forEach((t) => { t.fired = true; t.fn(); }); return f.length; };
    const mk = (id, o) => {
      const c = Object.assign({ id, ip: '10.0.0.' + id, pos: [-118.25, 34.05], userId: null, username: null, bot: false,
        profile: { name: 'R' + id, emoji: 1, car: { paint: '#fff' } }, known: new Set(), packs: new Set(['perf']), frames: [], ws: { readyState: 1 } }, o || {});
      clients.set(id, c);
      return c;
    };
    const last = (c, t) => c.frames.filter((m) => m.t === t).pop();
    const states = (c) => c.frames.filter((m) => m.t === 'perf:race:state').map((m) => (m.race ? m.race.status : 'null'));
    const clear = (...cs) => cs.forEach((c) => { c.frames.length = 0; });
    const h = (t, c, m) => { let e = null; try { mod.ws[t](c, m, ctx); } catch (x) { e = x; } return e; };

    /* ---- init: stats load ---- */
    mod._reset();
    mod.init(ctx);
    await H.sleep(20);
    const st = mod._state();
    ok('init() loads public.user_stats and public.dragy_pbs through ctx.db.query into the pack\'s own map (an unknown mode row is skipped)',
      st.stats.size === 1 && st.stats.get('u-a').runs === 2 && st.stats.get('u-a').wins === 1 && st.stats.get('u-a').pb['0-60'].time === 6.2 && !st.stats.get('u-a').pb.bogus);
    ok('nothing was written at boot', DB.writes.length === 0);

    /* ---- the route, through the real gate ---- */
    packs._setCtx(ctx);
    const call = async (tok, urlPath, ip) => { const res = {}; const handled = await packs.handleApi({ method: 'GET', url: urlPath, headers: Object.assign({}, tok ? { authorization: 'Bearer ' + tok } : {}, ip ? { 'x-ip': ip } : {}) }, res, urlPath); return { handled, res }; };
    let r = await call('tok-a', '/api/perf/dragy/pb');
    ok('GET /api/perf/dragy/pb: a holder gets 200 { ok, stats } — their own PBs and counters', r.handled && r.res.status === 200 && r.res.body.ok && r.res.body.stats.runs === 2 && r.res.body.stats.pb['0-60'].time === 6.2, JSON.stringify(r.res));
    r = await call(null, '/api/perf/dragy/pb');
    ok('…no bearer → 401', r.handled && r.res.status === 401);
    r = await call('tok-z', '/api/perf/dragy/pb');
    ok('…an account without the pack → 403 pack-required', r.handled && r.res.status === 403 && r.res.body.pack === 'perf');
    r = await call('tok-a', '/api/perf/dragy/pb', '9.9.9.9');
    for (let i = 0; i < 60; i++) await call('tok-a', '/api/perf/dragy/pb', '9.9.9.9');
    r = await call('tok-a', '/api/perf/dragy/pb', '9.9.9.9');
    ok('…rate-limited per IP (429 after 60/min)', r.handled && r.res.status === 429);
    const POST = {}; const postHandled = await packs.handleApi({ method: 'POST', url: '/api/perf/dragy/pb', headers: { authorization: 'Bearer tok-a' } }, POST, '/api/perf/dragy/pb');
    ok('POST /api/perf/dragy/pb is not a route (the upload is the perf:dragy:pb socket message: a pack route cannot read a body)', postHandled === false);

    /* ---- dragy:pb + fan-out ---- */
    const A1 = mk('a', { userId: 'u-a', username: 'alpha' });
    const B1 = mk('b', { userId: 'u-b', username: 'bravo', pos: [-118.2505, 34.0505] });
    const G = mk('g');                                           // a guest
    const V = mk('v', { userId: 'u-c', pos: [-118.26, 34.06] });   // a viewer scoping A
    const NV = mk('nv', { userId: 'u-c', gatedViewer: true });     // an unverified viewer scoping A
    const NH = mk('nh', { packs: new Set() });                     // scoping A, no pack
    V.known.add('a'); NV.known.add('a'); NH.known.add('a'); B1.known.add('a');
    ok('perf:dragy:pb from a guest is ignored', h('perf:dragy:pb', G, { modeId: '0-60', time: 5 }) === null && G.frames.length === 0 && st.stats.size === 1);
    [{ modeId: 'nope', time: 5 }, { modeId: '0-60', time: 0 }, { modeId: '0-60', time: 601 }, { modeId: '0-60', time: 'x' }, { modeId: '0-60', time: 5, trap: -1 }, { modeId: '0-60', time: 5, trap: 999 }, null, 'str', 42]
      .forEach((m) => h('perf:dragy:pb', A1, m));
    ok('malformed PBs (bad mode / time / trap, null, a string) are ignored without a throw or a write', A1.frames.length === 0 && DB.writes.length === 0 && st.stats.get('u-a').pb['0-60'].time === 6.2);
    h('perf:dragy:pb', A1, { modeId: '0-60', time: 7.0 });
    ok('a slower time than the stored PB is not persisted but the stats are echoed', st.stats.get('u-a').pb['0-60'].time === 6.2 && DB.writes.length === 0 && last(A1, 'perf:stats').id === 'self');
    clear(A1, V, NV, NH, B1);
    h('perf:dragy:pb', A1, { modeId: 'quarter', time: 12.5, trap: 48.2 });
    const w = DB.writes[0];
    ok('a new PB: stored, written through with the "only if better" upsert, echoed to the sender as perf:stats { id:\'self\' }',
      st.stats.get('u-a').pb.quarter.time === 12.5 && st.stats.get('u-a').pb.quarter.trap === 48.2 && DB.writes.length === 1 &&
      /insert into public\.dragy_pbs/.test(w.sql) && /where excluded\.time_s < public\.dragy_pbs\.time_s/.test(w.sql) && w.params[0] === 'u-a' && w.params[1] === 'quarter' && w.params[2] === 12.5 &&
      last(A1, 'perf:stats').id === 'self' && last(A1, 'perf:stats').stats.pb.quarter.time === 12.5);
    ok('…fanned out as perf:dragy:pb { id, stats } only to holders scoping A: the verified viewer gets the stats, the unverified viewer gets null, the non-holder and the sender get nothing',
      last(V, 'perf:dragy:pb') && last(V, 'perf:dragy:pb').id === 'a' && last(V, 'perf:dragy:pb').stats.pb.quarter.time === 12.5 &&
      last(NV, 'perf:dragy:pb') && last(NV, 'perf:dragy:pb').stats === null && NH.frames.length === 0 && A1.frames.filter((m) => m.t === 'perf:dragy:pb').length === 0 && last(B1, 'perf:dragy:pb').id === 'a');
    clear(A1);
    for (let i = 0; i < 40; i++) h('perf:dragy:pb', A1, { modeId: '0-30', time: 3 - i * 0.01 });
    ok('perf:dragy:pb is rate-limited per IP (30/min)', A1.frames.filter((m) => m.t === 'perf:stats').length <= 30);
    DB.fail = true;
    let dErr = null;
    try { h('perf:dragy:pb', B1, { modeId: '0-60', time: 4 }); await H.sleep(5); } catch (e) { dErr = e; }
    ok('a failing database write is logged, never thrown; the in-memory stats still move', !dErr && st.stats.get('u-b').pb['0-60'].time === 4);
    DB.fail = false;

    /* ---- stats:get ---- */
    clear(V);
    h('perf:stats:get', V, { id: 'a' });
    ok('perf:stats:get answers a rider\'s stats', last(V, 'perf:stats').id === 'a' && last(V, 'perf:stats').stats.pb.quarter.time === 12.5);
    h('perf:stats:get', V, { id: 'g' });
    ok('…null for a guest', last(V, 'perf:stats').id === 'g' && last(V, 'perf:stats').stats === null);
    clear(V); h('perf:stats:get', V, { id: 'nobody' }); h('perf:stats:get', V, {}); h('perf:stats:get', V, null); h('perf:stats:get', V, { id: 7 });
    ok('…an unknown id answers null, garbage answers nothing', V.frames.filter((m) => m.t === 'perf:stats').length === 1 && last(V, 'perf:stats').stats === null);
    clear(NV); h('perf:stats:get', NV, { id: 'a' });
    ok('…null to an unverified viewer', last(NV, 'perf:stats').stats === null);
    blocks.add('u-c|u-a'); clear(V); h('perf:stats:get', V, { id: 'a' });
    ok('…silently nothing across a block', V.frames.length === 0);
    blocks.delete('u-c|u-a');

    /* ---- onHello / onClose ---- */
    clear(A1);
    mod.onHello(A1, ctx);
    ok('onHello hands a signed-in holder its own stats; a guest gets nothing', last(A1, 'perf:stats').id === 'self' && last(A1, 'perf:stats').stats.runs === 2 && (mod.onHello(G, ctx), G.frames.length === 0));

    /* ---- the race lifecycle: the three old cases ---- */
    const lobbyWith = (host, joiner) => {
      clear(host, joiner);
      h('perf:race:create', host, { modeId: '0-60' });
      const created = last(host, 'perf:race:state');
      if (!created || !created.race) return null;
      h('perf:race:join', joiner, { id: created.race.id });
      hits.clear();
      h('perf:race:ready', host, { on: true });
      h('perf:race:ready', joiner, { on: true });
      return created.race.id;
    };
    const runsOf = (uid) => (st.stats.get(uid) || { runs: 0, wins: 0 });
    const beforeA = Object.assign({}, runsOf('u-a')), beforeB = Object.assign({}, runsOf('u-b'));
    const writesBefore = DB.writes.length;

    // A. cancelling from the lobby records nothing
    let id = lobbyWith(A1, B1);
    ok('A: lobby stood up — both ready, host sees isHost, the joiner does not', !!id && last(A1, 'perf:race:state').race.members.every((m) => m.ready) && last(A1, 'perf:race:state').race.isHost === true && last(B1, 'perf:race:state').race.isHost === false);
    clear(A1, B1);
    h('perf:race:end', A1, {});
    ok('A: cancel from the lobby → both get race:null exactly once and a perf:err saying nothing was recorded; nobody sees "finished"',
      states(A1).join() === 'null' && states(B1).join() === 'null' && /nothing recorded/.test(last(A1, 'perf:err').msg) && /nothing recorded/.test(last(B1, 'perf:err').msg) && !st.races.has(id) && !st.raceOf.has('a') && !st.raceOf.has('b'));
    ok('A: no run or win was counted, nothing was written', runsOf('u-a').runs === beforeA.runs && runsOf('u-b').runs === beforeB.runs && DB.writes.length === writesBefore);

    // B. host leaving during the countdown records nothing
    id = lobbyWith(A1, B1);
    clear(A1, B1);
    h('perf:race:start', A1, {});
    ok('B: start → countdown with a startedAt ~RACE_COUNTDOWN_MS ahead and a deferred green light', last(A1, 'perf:race:state').race.status === 'countdown' && last(A1, 'perf:race:state').race.startedAt > Date.now() + 2000 && deferred.some((t) => !t.fired && t.ms === 3000));
    h('perf:race:leave', A1, {});
    ok('B: host leaves mid-countdown → B is torn down (race:null once), never handed a leaderboard', states(B1).filter((s) => s === 'null').length === 1 && states(B1).indexOf('finished') < 0 && !st.races.has(id));
    fire();
    ok('B: the green light firing later finds no race and does nothing', B1.frames.filter((m) => m.t === 'perf:race:state').length === 2);
    ok('B: no run or win was counted', runsOf('u-a').runs === beforeA.runs && runsOf('u-b').runs === beforeB.runs && DB.writes.length === writesBefore);

    // C. a race that actually runs still records  <- the control
    id = lobbyWith(A1, B1);
    clear(A1, B1);
    h('perf:race:start', A1, {});
    ok('C: start (host only — the joiner\'s start is ignored)', (h('perf:race:start', B1, {}), last(A1, 'perf:race:state').race.status === 'countdown'));
    fire();
    const running = last(A1, 'perf:race:state');
    ok('C: the deferred green light flips the race to running for everyone', running.race.status === 'running' && last(B1, 'perf:race:state').race.status === 'running');
    clear(A1, B1);
    h('perf:race:fix', A1, { lng: -118.2501, lat: 34.0501, speed: 12.5, heading: 400, acc: 3, ts: 'x' });
    const relayed = last(B1, 'perf:race:fix');
    ok('C: a perf:race:fix is relayed to the other racer only, validated (heading clamped, ts coerced), never echoed', !!relayed && relayed.from === 'a' && relayed.speed === 12.5 && relayed.heading === 360 && typeof relayed.ts === 'number' && A1.frames.filter((m) => m.t === 'perf:race:fix').length === 0);
    h('perf:race:fix', A1, { lng: 'x', lat: 34 }); h('perf:race:fix', A1, { lng: 500, lat: 34 }); h('perf:race:fix', A1, null);
    ok('C: an invalid position is dropped', B1.frames.filter((m) => m.t === 'perf:race:fix').length === 1);
    h('perf:race:finish', A1, { time: 5.5, trap: 60 });
    ok('C: A finishes 5.5 s — recorded, state re-broadcast, A\'s run counted (+1) and fanned', last(B1, 'perf:race:state').race.members.find((m) => m.id === 'a').time === 5.5 && runsOf('u-a').runs === beforeA.runs + 1);
    h('perf:race:finish', A1, { time: 4.0 });
    ok('C: a second finish from the same racer is ignored', last(B1, 'perf:race:state').race.members.find((m) => m.id === 'a').time === 5.5);
    clear(A1, B1);
    h('perf:race:end', A1, {});
    const done = last(A1, 'perf:race:state');
    const me = done && done.race.members.find((x) => x.id === 'a');
    const them = done && done.race.members.find((x) => x.id === 'b');
    ok('C: host ends → the race finishes properly for both', !!done && done.race.status === 'finished' && last(B1, 'perf:race:state').race.status === 'finished');
    ok('C: A recorded as finished with the time and trap', !!(me && me.finished && me.time === 5.5 && me.trap === 60));
    ok('C: B recorded as a DNF  <- a real race must still record', !!(them && them.dnf && them.finished && them.time === null));
    ok('C: the ledger: A runs+1 wins+1, B runs+1 wins+0, written through as SQL increments', runsOf('u-a').runs === beforeA.runs + 1 && runsOf('u-a').wins === beforeA.wins + 1 && runsOf('u-b').runs === beforeB.runs + 1 && runsOf('u-b').wins === beforeB.wins &&
      DB.writes.slice(writesBefore).filter((x) => /set runs = public\.user_stats\.runs \+ 1/.test(x.sql)).length === 2 && DB.writes.slice(writesBefore).filter((x) => /set wins = public\.user_stats\.wins \+ 1/.test(x.sql)).length === 1);
    ok('C: each racer is told their own new counters (perf:stats self)', last(A1, 'perf:stats').id === 'self' && last(A1, 'perf:stats').stats.wins === beforeA.wins + 1 && last(B1, 'perf:stats').id === 'self' && last(B1, 'perf:stats').stats.runs === beforeB.runs + 1);
    ok('C: the race stays for the leaderboard grace, then the deferred teardown drops it', st.races.has(id) && (fire(), !st.races.has(id) && !st.raceOf.has('a') && !st.raceOf.has('b')));

    /* ---- join / proximity / block / full / invite / ready ---- */
    clear(A1, B1);
    h('perf:race:create', A1, { modeId: 'quarter' });
    id = last(A1, 'perf:race:state').race.id;
    const FAR = mk('far', { userId: 'u-c', pos: [-117.0, 34.05] });
    h('perf:race:join', FAR, { id });
    ok('join: a rider outside NEARBY_KM of the host is refused', /Too far/.test(last(FAR, 'perf:err').msg) && last(A1, 'perf:race:state').race.members.length === 1);
    const NOPOS = mk('np', { pos: null });
    h('perf:race:join', NOPOS, { id });
    ok('join: no position → "Set your location first"', /location/.test(last(NOPOS, 'perf:err').msg));
    h('perf:race:join', B1, { id: 'rnope' }); h('perf:race:join', B1, {}); h('perf:race:join', B1, null);
    ok('join: an unknown race → "That race is gone"; garbage never throws', /gone/.test(last(B1, 'perf:err').msg) && h('perf:race:join', B1, 'x') === null);
    blocks.add('u-a|u-b');
    h('perf:race:join', B1, { id });
    ok('join: a blocked pair is refused with a wording that names no one', /can.t join this race/.test(last(B1, 'perf:err').msg) && last(A1, 'perf:race:state').race.members.length === 1);
    blocks.delete('u-a|u-b');
    h('perf:race:join', B1, { id });
    ok('join: the joiner lands in the roster of both', last(A1, 'perf:race:state').race.members.length === 2 && last(B1, 'perf:race:state').race.members.map((m) => m.id).join() === 'a,b');
    const extras = [];
    for (let i = 0; i < 7; i++) { const c = mk('x' + i, { userId: 'u-c' }); extras.push(c); h('perf:race:join', c, { id }); }
    ok('join: the race fills at RACE_MAX (8) and the ninth is refused', last(A1, 'perf:race:state').race.members.length === 8 && /full/.test(last(extras[6], 'perf:err').msg));
    extras.forEach((c) => { h('perf:race:leave', c, {}); clients.delete(c.id); });
    ok('leave: the extras are gone from the roster', last(A1, 'perf:race:state').race.members.length === 2);
    clear(B1);
    hits.clear();
    h('perf:race:ready', B1, { on: true }); h('perf:race:ready', B1, { on: false });
    ok('ready: flips are throttled to one per 500 ms (the second is dropped)', B1.frames.filter((m) => m.t === 'perf:race:state').length === 1 && last(B1, 'perf:race:state').race.members.find((m) => m.id === 'b').ready === true);
    clear(A1, B1);
    h('perf:race:invite', B1, { to: 'far' });
    ok('invite: only the host can invite', FAR.frames.filter((m) => m.t === 'perf:race:invite').length === 0);
    h('perf:race:invite', A1, { to: 'far' });
    ok('invite: a target outside NEARBY_KM → "Too far to challenge"', /Too far to challenge/.test(last(A1, 'perf:err').msg));
    const NHN = mk('nhn', { userId: 'u-c', packs: new Set(), pos: [-118.251, 34.051] });
    h('perf:race:invite', A1, { to: 'nhn' });
    ok('invite: a target without the pack → "can\'t race yet" to the host, nothing to the target', /can.t race yet/.test(last(A1, 'perf:err').msg) && NHN.frames.length === 0);
    const T3 = mk('t3', { userId: 'u-c', pos: [-118.251, 34.051] });
    h('perf:race:invite', A1, { to: 't3' });
    ok('invite: a nearby holder gets perf:race:invite { from, fromName, raceId, modeId }', last(T3, 'perf:race:invite') && last(T3, 'perf:race:invite').raceId === id && last(T3, 'perf:race:invite').modeId === 'quarter' && last(T3, 'perf:race:invite').fromName === 'Ra');
    blocks.add('u-c|u-a'); clear(T3, A1);
    h('perf:race:invite', A1, { to: 't3' });
    ok('invite: silently dropped across a block', T3.frames.length === 0 && A1.frames.length === 0);
    blocks.delete('u-c|u-a');
    h('perf:race:invite', A1, { to: 'a' }); h('perf:race:invite', A1, {}); h('perf:race:invite', A1, null);
    ok('invite: self / garbage never throws or sends', A1.frames.length === 0);
    h('perf:race:create', A1, { modeId: 'nope' });
    ok('create: a bad mode → "Pick a race type"', /Pick a race type/.test(last(A1, 'perf:err').msg));
    h('perf:race:fix', A1, { lng: -118.25, lat: 34.05 });
    ok('fix: ignored while the race is not running', B1.frames.filter((m) => m.t === 'perf:race:fix').length === 0);

    /* ---- fix relay: block mid-race, rate limit ---- */
    clear(A1, B1);
    h('perf:race:ready', A1, { on: true }); hits.clear(); h('perf:race:ready', B1, { on: true });
    h('perf:race:start', A1, {});
    fire();
    ok('(running again)', last(A1, 'perf:race:state').race.status === 'running');
    blocks.add('u-b|u-a');
    clear(B1);
    h('perf:race:fix', A1, { lng: -118.25, lat: 34.05, speed: 3 });
    ok('fix: a block made mid-race stops the stream on the very next frame', B1.frames.filter((m) => m.t === 'perf:race:fix').length === 0);
    blocks.delete('u-b|u-a');
    hits.clear(); clear(B1);
    for (let i = 0; i < mod._constants.RACE_FIX_BUDGET + 50; i++) h('perf:race:fix', A1, { lng: -118.25, lat: 34.05, speed: 3 });
    ok('fix: the per-connection budget (' + mod._constants.RACE_FIX_BUDGET + '/min) drops the excess', B1.frames.filter((m) => m.t === 'perf:race:fix').length === mod._constants.RACE_FIX_BUDGET);
    h('perf:race:finish', A1, { time: 'x' }); h('perf:race:finish', A1, { time: -1 }); h('perf:race:finish', A1, null);
    ok('finish: a bad time is ignored', !last(A1, 'perf:race:state').race.members.find((m) => m.id === 'a').finished);

    /* ---- onClose: the host disconnecting mid-race ends it ---- */
    clear(A1, B1);
    const bRuns = runsOf('u-b').runs, aRuns = runsOf('u-a').runs;
    mod.onClose(A1, ctx);
    ok('onClose(host) mid-race: the host is DNF\'d and counted, the race ends, B (no finish) is DNF\'d too, nobody wins',
      last(B1, 'perf:race:state').race.status === 'finished' && last(B1, 'perf:race:state').race.members.every((m) => m.dnf) && runsOf('u-a').runs === aRuns + 1 && runsOf('u-b').runs === bRuns + 1 && runsOf('u-b').wins === beforeB.wins);
    fire();
    ok('…and the deferred teardown clears every map', st.races.size === 0 && st.raceOf.size === 0);
    ok('onClose for a socket in no race is a no-op', (mod.onClose(G, ctx), mod.onClose(null, ctx), true));

    /* ---- host leaving the lobby promotes the next; a lobby of one that leaves is dropped ---- */
    clear(A1, B1);
    h('perf:race:create', A1, { modeId: '0-60' });
    h('perf:race:join', B1, { id: last(A1, 'perf:race:state').race.id });
    h('perf:race:leave', A1, {});
    ok('leave: the host leaving the lobby promotes the joiner to host', last(B1, 'perf:race:state').race.isHost === true && last(B1, 'perf:race:state').race.members.length === 1);
    h('perf:race:leave', B1, {});
    ok('…and the last racer leaving drops the race', st.races.size === 0 && st.raceOf.size === 0);

    /* ---- one race at a time; create while in a race leaves the old one ---- */
    h('perf:race:create', A1, { modeId: '0-60' });
    const first = last(A1, 'perf:race:state').race.id;
    h('perf:race:create', A1, { modeId: 'quarter' });
    ok('create while in a race leaves the old one (dropped, it was empty) and opens the new', !st.races.has(first) && st.races.size === 1 && st.raceOf.get('a') !== first);
    h('perf:race:leave', A1, {});

    /* ---- the sweep ---- */
    h('perf:race:create', A1, { modeId: '0-60' });
    const stale = st.races.get(st.raceOf.get('a'));
    stale.createdAt = Date.now() - 31 * 60 * 1000;
    clear(A1);
    delete accounts['u-c'];
    mod._sweep();
    ok('sweep: a lobby older than 30 min is abandoned (race:null + "expired"), stats of a deleted account are pruned', st.races.size === 0 && /expired/.test(last(A1, 'perf:err').msg) && !st.stats.has('u-c') && st.stats.has('u-a'));

    /* ---- every handler survives garbage, from any socket shape ---- */
    let gErr = null;
    const junk = [undefined, null, 'x', 7, [], {}, { id: {} }, { modeId: [] }, { lng: [], lat: {} }, { time: {} }, { to: 1 }, { on: 'yes' }];
    try {
      Object.keys(mod.ws).forEach((t) => junk.forEach((m) => { mod.ws[t](A1, m, ctx); mod.ws[t](G, m, ctx); mod.ws[t](mk('bare'), m, ctx); }));
    } catch (e) { gErr = e; }
    ok('every ws handler survives every junk payload from a holder, a guest and a bare socket', !gErr, gErr && (gErr.stack || gErr.message));
    ok('the fan-out never reached the non-holder', NH.frames.length === 0);
    mod._reset();
  }

  process.exit(report());
})().catch((e) => { console.error(e); process.exit(1); });
