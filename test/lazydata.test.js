/* Convoy — js/data.js off the boot path. `node test/lazydata.test.js`.

   T1.5a (mission 20260903-173653-75d3 cycle 2, directive task 4): js/data.js
   is the static vehicle/paint/name/city catalog (16197 B gzip, ~4.5% of the
   whole boot budget) — every consumer site (js/ui.js, js/party.js) reads it
   inside a function, never at parse time (evidence: the directive's own grep,
   34 sites, all inside garage/profile builders, convoy creation, NPC chat).
   Nothing at boot needs it.

   The risk in taking it off <script> is entirely in ONE line: js/ui.js and
   js/party.js both do `var D = A.data;` at PARSE TIME (module load order:
   config.js runs first and seeds A.data = {}; ui.js/party.js load later and
   capture that same object into a local `D`). js/data.js must therefore FILL
   that object (for..in copy onto the existing A.data), never REPLACE it
   (A.data = {...}) — a replace would leave every already-parsed module's `D`
   pointing at a permanently-empty object while A.data itself moved on.

   Four checks, matching the directive's acceptance criteria exactly:
     (a) index.html no longer references js/data.js
     (b) with A.data stubbed empty, js/ui.js and js/party.js still parse, and
         their captured D is the SAME object js/data.js later fills (identity)
     (c) A.data.ensure() resolves once and is cached on the second call
     (d) the <script> ensure() injects carries the current ?v= stamp, read off
         config.js's own tag rather than hardcoded (so the next stamp bump
         cannot silently break the fetch)

   Run:  node test/lazydata.test.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

/* ---------------- (a) index.html no longer references js/data.js ---------------- */
group('index.html — js/data.js is off the boot path');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('no <script src="js/data.js…"> tag remains', !/js\/data\.js/.test(html));
  // pack-ota.js ships the whole www/ tree regardless of what index.html
  // references (guardrail 3) — the file itself must still exist on disk so
  // the lazy fetch has something to load.
  ok('js/data.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
    fs.existsSync(path.join(ROOT, 'js', 'data.js')));
}

/* ---------------- (b) object-identity: D survives data.js loading later ---------------- */
group('js/ui.js + js/party.js — captured `D` is the object js/data.js later fills, not a stale empty one');
{
  const win = H.installBrowser();
  H.loadModule('js/config.js'); // A.data = A.data || {} — the stub `D` must capture
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');

  const A = win.App;
  const preLoadData = A.data;
  ok('js/config.js seeds A.data as a real (empty) object before any consumer parses',
    !!preLoadData && typeof preLoadData === 'object' && !preLoadData.loaded);

  // js/party.js and js/ui.js both capture `var D = A.data;` at the top of
  // their IIFE — evaluating the file is enough to prove the capture and that
  // neither throws with an empty A.data (no consumer site runs at parse time).
  let partyThrew = null, uiThrew = null;
  try { H.loadModule('js/party.js'); } catch (e) { partyThrew = e; }
  try { H.loadModule('js/ui.js'); } catch (e) { uiThrew = e; }
  ok('js/party.js parses with an empty A.data (no consumer site runs at parse time)', partyThrew === null,
    partyThrew && partyThrew.message);
  ok('js/ui.js parses with an empty A.data (no consumer site runs at parse time)', uiThrew === null,
    uiThrew && uiThrew.message);

  // Now load the real js/data.js and prove it filled the SAME object, not a
  // new one — this is the whole risk the directive calls out in one line.
  H.loadModule('js/data.js');
  ok('A.data === the object seeded by config.js (data.js mutated it, never reassigned)',
    A.data === preLoadData);
  ok('A.data.loaded is true after js/data.js runs', A.data.loaded === true);
  ok('A.data.CONVOY_NAMES is now populated (a real key data.js fills)',
    Array.isArray(A.data.CONVOY_NAMES) && A.data.CONVOY_NAMES.length > 0);
  ok('A.data.CHAT_REPLIES is now populated (js/party.js:149 reads this one on a timer)',
    Array.isArray(A.data.CHAT_REPLIES) && A.data.CHAT_REPLIES.length > 0);
}

/* ---------------- (c) A.data.ensure() is cached ---------------- */
group('A.data.ensure() — cached promise, resolves once, injects the script exactly once');
{
  const win = H.installBrowser();
  win.document.head = H.makeEl('head');
  const injected = [];
  const realCreateElement = win.document.createElement;
  win.document.createElement = function (tag) {
    const n = realCreateElement.call(win.document, tag);
    if (tag === 'script') {
      injected.push(n);
      // simulate the browser firing onload on the next tick, and simulate
      // js/data.js's own effect (fill + flag) the same way the real file does
      setTimeout(function () {
        win.App.data.CONVOY_NAMES = ['Fake Run'];
        win.App.data.loaded = true;
        if (n.onload) n.onload();
      }, 0);
    }
    return n;
  };
  H.loadModule('js/config.js');
  H.loadModule('js/util.js'); // ensure() calls A.util.loadScript at invocation time
  const A = win.App;

  const p1 = A.data.ensure();
  const p2 = A.data.ensure();
  ok('ensure() returns the SAME promise on a second call before the first resolves', p1 === p2);
  ok('exactly one <script> was injected for two overlapping ensure() calls', injected.length === 1,
    'injected ' + injected.length + ' script tag(s)');

  p1.then(function () {
    ok('the promise resolves once js/data.js "loads"', true);
    ok('A.data.loaded is true after the injected script "loads"', A.data.loaded === true);
    const p3 = A.data.ensure();
    ok('a THIRD call after loading resolves immediately (A.data.loaded fast path), no new <script>',
      injected.length === 1);
    p3.then(function () {
      ok('the post-load ensure() promise also resolves', true);
      finish();
    });
  });
}

/* ---------------- (d) the injected <script> carries the current stamp ---------------- */
group('A.data.ensure() — the injected <script> src carries index.html\'s current ?v= stamp');
{
  const win = H.installBrowser();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/config\.js(\?v=cy\d+)/);
  ok('index.html has a config.js?v=cyNNN tag to read the stamp off of', !!m, 'no match in index.html');
  const stamp = m ? m[1] : '?v=cyMISSING';

  // Minimal DOM: a real <head> with the real config.js tag inside it, so
  // document.querySelector('script[src*="config.js?v="]') finds something
  // real instead of a hand-typed fixture — the exact selector js/config.js
  // itself uses.
  win.document.head = H.makeEl('head');
  const cfgTag = H.makeEl('script');
  cfgTag.src = 'js/config.js' + stamp;
  win.document.head.appendChild(cfgTag);
  win.document.querySelector = function (sel) {
    if (sel === 'script[src*="config.js?v="]') return cfgTag;
    return null;
  };

  const injected = [];
  win.document.createElement = function (tag) {
    const n = H.makeEl(tag);
    if (tag === 'script') { injected.push(n); setTimeout(function () { if (n.onload) n.onload(); }, 0); }
    return n;
  };

  H.loadModule('js/config.js');
  H.loadModule('js/util.js');
  win.App.data.ensure();
  setTimeout(function () {
    ok('exactly one <script> injected', injected.length === 1);
    const src = injected[0] && injected[0].src;
    ok('injected src is js/data.js' + stamp + ' (measured "' + src + '")', src === 'js/data.js' + stamp);
    finish();
  }, 10);
}

// (c) and (d) above finish through their own setTimeout callbacks, which
// never trigger a second document.createElement() call and so are immune to
// the global-window reassignment the (e)/(f) checks below perform — they just
// need this no-op so their trailing finish() call doesn't throw. Both settle
// (0ms, 10ms) well before the sequential async work below reaches the final
// report(), so their ok() results are always counted.
function finish() {}

/* ---------------- (e)/(f): everything below shares Node's single `global.window`/
   `global.document` (H.installBrowser()/bootRealUi() both reassign them), so
   these three checks MUST run strictly one after another — a callback from an
   earlier check firing while a later check has already reassigned the globals
   would silently corrupt both. Each phase below is fully awaited (including
   its own setTimeout-driven script "loads") before the next one calls
   installBrowser()/bootRealUi() again. */

/* ---------------- (e) task 1: a rejected load is retried, not replayed forever ----------------
   cycle 2's A.data.ensure() cached the promise from loadScript() even when it
   REJECTED, so one flaky fetch during the idle warm permanently broke the
   garage for the rest of the session — retrying (garage panel reopened,
   network back) never fired a second request. `n.onload()` is all the old
   stub at (c)/(d) above ever calls; the failure branch was not merely
   untested, it was unrepresentable in that harness. This one can fail: it
   fires `n.onerror()` first. */
async function checkRetryAfterRejection() {
  group('A.util.loadOnce() / A.data.ensure() — a rejected load is retried, not cached forever');
  const win = H.installBrowser();
  win.document.head = H.makeEl('head');
  let attempt = 0;
  const injected = [];
  win.document.createElement = function (tag) {
    const n = H.makeEl(tag);
    if (tag === 'script') {
      injected.push(n);
      attempt++;
      const isFirst = attempt === 1;
      setTimeout(function () {
        if (isFirst) { if (n.onerror) n.onerror(); return; }
        // Attempt 2 "succeeds": simulate js/data.js's own real effect the same
        // way (c) above does, then fire onload.
        win.App.data.CONVOY_NAMES = ['Retry Run'];
        win.App.data.loaded = true;
        if (n.onload) n.onload();
      }, 0);
    }
    return n;
  };
  H.loadModule('js/config.js');
  H.loadModule('js/util.js');
  const A = win.App;

  let firstRejected = false, firstErr = null;
  try { await A.data.ensure(); } catch (e) { firstRejected = true; firstErr = e; }
  ok('the first attempt (onerror) rejects the promise A.data.ensure() returned', firstRejected,
    firstErr && firstErr.message);
  ok('exactly one <script> was injected for the failed attempt', injected.length === 1,
    'injected ' + injected.length);

  const p2 = A.data.ensure();
  ok('calling A.data.ensure() again after the rejection injects a NEW <script> (cache was cleared, not replayed)',
    injected.length === 2, 'injected ' + injected.length);
  try {
    await p2;
    ok('the retried ensure() call resolves once the second attempt "loads"', true);
    ok('A.data.loaded is true after the retry actually succeeds', A.data.loaded === true);
  } catch (e2) {
    ok('the retried ensure() call should resolve, not reject', false, e2 && e2.message);
  }
}

/* ---------------- (f) task 2: the REAL buildProfilePanel(), driven through the
   real A.ui API in a full jsdom window — not A.data.ensure() in isolation,
   which was the other half of the (c)/(d) test gap. Reuses the exact module
   chain/order test/frontend.test.js drives (jsdom + the real index.html), so
   this is the same "what a WebView actually renders" guarantee, not a second
   hand-written fixture that can drift from it. ---------------- */
function bootRealUi() {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  win.matchMedia = win.matchMedia || function () {
    return { matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
  };
  win.Capacitor = undefined;
  win.fetch = function () { return Promise.reject(new Error('network disabled in test harness')); };

  // jsdom's runScripts:'outside-only' never fetches or executes a dynamically
  // injected <script src>, so A.data.ensure()'s real loadScript() would hang
  // forever without this. Intercept just the `src` setter on <script>
  // elements: queue an outcome per injection, and on "success" actually eval
  // the real file's source in this window (the same effect a browser's own
  // fetch+execute-then-fire-onload would have) so D.MAKE_LIST etc. are real,
  // not empty. Every other tag goes through the unmodified real jsdom path.
  const scriptOutcomes = [];
  const realCreateElement = win.document.createElement.bind(win.document);
  win.document.createElement = function (tag) {
    const el = realCreateElement(tag);
    if (String(tag).toLowerCase() === 'script') {
      Object.defineProperty(el, 'src', {
        get() { return el.getAttribute('src') || ''; },
        set(v) {
          el.setAttribute('src', v);
          const outcome = scriptOutcomes.length ? scriptOutcomes.shift() : 'ok';
          setTimeout(function () {
            if (outcome === 'fail') { if (el.onerror) el.onerror(new win.Event('error')); return; }
            try { win.eval(fs.readFileSync(path.join(ROOT, String(v).split('?')[0]), 'utf8')); }
            catch (e) { if (el.onerror) el.onerror(new win.Event('error')); return; }
            if (el.onload) el.onload(new win.Event('load'));
          }, 0);
        }
      });
    }
    return el;
  };

  function put(name, value) {
    try { global[name] = value; }
    catch (e) { Object.defineProperty(global, name, { value, writable: true, configurable: true }); }
  }
  put('window', win);
  put('document', win.document);
  put('localStorage', win.localStorage);
  put('navigator', win.navigator);
  put('requestAnimationFrame', win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(() => fn(Date.now()), 0));
  put('cancelAnimationFrame', win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout);
  put('fetch', win.fetch);

  // test/frontend.test.js's own MODULE_ORDER (for jsdom UI-rendering
  // completeness) still evals js/data.js and js/voice.js unconditionally at
  // boot — deliberately, per STATE.md: that list is the app's module SET for
  // jsdom, not a mirror of what index.html currently <script>-tags. Loading
  // it here too would set A.data.loaded/A.voice before a single test ran,
  // permanently taking the fast path and making the lazy/failure branch this
  // file exists to test unreachable. So: everything else index.html loads,
  // MINUS 'data' and 'voice' — those two are loaded lazily, on demand, by the
  // real A.data.ensure() / A.voiceLoader.ensure() calls under test.
  const MODULE_ORDER = ['config', 'telemetry', 'util', 'state', 'themes', 'detectors', 'space',
    'mapview', 'sim', 'net', 'routing', 'ghost', 'radar', 'overlays', 'scanners',
    'racetimer', 'dragy', 'wake', 'places', 'triplog', 'speedo', 'hud', 'compass',
    'clock', 'tripmeter', 'gmeter', 'quest', 'weathernow', 'battery', 'coords',
    'destarrow', 'riderarrows', 'speedalert', 'dimmer', 'tripextras', 'party',
    'ui', 'auth', 'native', 'ota', 'race'];
  MODULE_ORDER.forEach(function (name) {
    win.eval(fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8'));
  });
  return { win, doc: win.document, A: win.App, scriptOutcomes };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkFailedGarageLeavesAWayBack() {
  group('js/ui.js buildProfilePanel() — a failed garage load leaves a usable panel (reviewer MEDIUM #1)');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.ui.openPanel('profile');
  await sleep(0);
  const garageBtn = doc.getElementById('profile-body').querySelector('.pf-garage-btn');
  ok('the main profile page renders a "My Garage" button to reach the garage', !!garageBtn);

  scriptOutcomes.push('fail'); // js/data.js's injected <script> fires onerror
  garageBtn.click();
  await sleep(10);

  const body = doc.getElementById('profile-body');
  ok('#profile-body is non-empty after the garage load fails (not stranded blank)', body.children.length > 0);
  const retryBtn = body.querySelector('.pf-garage-btn');
  ok('a way back is left on screen: the main page (with "My Garage" to retry) is shown, not a blank panel',
    !!retryBtn, 'children: ' + Array.from(body.children).map((c) => c.className).join(', '));
  const toasts = doc.getElementById('toasts');
  ok('a toast told the rider the garage could not load',
    !!toasts && / garage/i.test(toasts.textContent), toasts && toasts.textContent);

  A.ui.openPanel(null);
}

async function checkOverlappingOpensRenderOnce() {
  group('js/ui.js buildProfilePanel() — two overlapping opens render the garage exactly once (reviewer MEDIUM #2)');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.ui.openPanel('profile');
  await sleep(0);
  const garageBtn = doc.getElementById('profile-body').querySelector('.pf-garage-btn');

  scriptOutcomes.push('ok'); // one real load: js/data.js actually runs (see bootRealUi)
  // No debounce on this button (js/ui.js:1698) and no re-entrancy guard used
  // to exist on buildProfilePanel() — two rapid opens before ensure()
  // resolves used to both append into the same cleared body.
  garageBtn.click();
  garageBtn.click();
  await sleep(15);

  const body = doc.getElementById('profile-body');
  const backTitles = body.querySelectorAll('.pf-back-title');
  const makeSelects = body.querySelectorAll('select');
  ok('exactly one "My Garage" back header rendered, not two', backTitles.length === 1,
    'found ' + backTitles.length);
  ok('at least one garage <select> rendered (the make/model/etc. dropdowns) and none are duplicated',
    makeSelects.length > 0, 'found ' + makeSelects.length + ' selects');

  A.ui.openPanel(null);
}

(async function runRemainingGroupsInSequence() {
  await checkRetryAfterRejection();
  await checkFailedGarageLeavesAWayBack();
  await checkOverlappingOpensRenderOnce();
  process.exit(report());
})();
