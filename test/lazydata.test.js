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
const { group, ok, report, ROOT, bootRealUi, sleep, waitFor } = H;

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

/* ---------------- cycle 5: js/race.js + js/dragy.js off the boot path ---------------- */
group('index.html — js/race.js and js/dragy.js are off the boot path');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('no <script src="js/race.js…"> tag remains', !/js\/race\.js/.test(html));
  ok('no <script src="js/dragy.js…"> tag remains', !/js\/dragy\.js/.test(html));
  ok('js/race.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
    fs.existsSync(path.join(ROOT, 'js', 'race.js')));
  ok('js/dragy.js still exists on disk (fetched lazily, still shipped in the OTA bundle)',
    fs.existsSync(path.join(ROOT, 'js', 'dragy.js')));
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
// bootRealUi/sleep/waitFor moved to test/harness.js cycle 7 (shared with the
// new test/leaks.test.js — same jsdom boot path, "what a WebView actually
// renders", not two hand-written fixtures that can drift from each other).

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

/* ---------------- cycle 4: js/scanners.js + js/radar.js off the boot path
   (directive task 3). Same bootRealUi() harness; MODULE_ORDER above already
   excludes 'radar' and 'scanners' so their lazy path is reachable. ---------- */

async function checkScannerSecondTapAfterLoadRunsGateOnce() {
  group('js/scanners.js — a tap after the module has already loaded runs the legal gate once, not twice (the shim-removal bug)');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.ui.init(); // wires the js/ui.js shim onto #chip-scan (production does this from js/app.js)
  var gateCalls = 0;
  // Both the js/ui.js shim and js/scanners.js's own self-wiring call
  // A.ui.legalGate('scanner', ...) — spying here catches whichever listener(s)
  // are actually attached to the chip at the moment each click fires, which is
  // exactly what this test needs to distinguish "one gate call" from "two".
  A.ui.legalGate = function () { gateCalls++; };
  const chip = doc.getElementById('chip-scan');
  scriptOutcomes.push('ok'); // js/scanners.js actually loads and self-wires #chip-scan
  chip.click(); // tap 1: only the shim is wired yet -> one A.lazy.scanners() call
  await sleep(15); // cross the load boundary: js/scanners.js has now parsed
  chip.click(); // tap 2: a single later tap
  await sleep(10);
  ok('two total taps (one before load, one after) call the legal gate exactly twice, not three times ' +
    '(three would mean the second tap fired both the leftover shim and the module\'s own listener)',
    gateCalls === 2, 'gateCalls=' + gateCalls);
}

async function checkScannerFailedLoadRetries() {
  group('js/scanners.js — a failed load leaves #chip-scan clickable with a toast, and a retry (loadOnce clears its cache on rejection) opens the directory');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.ui.init(); // wires the js/ui.js shim onto #chip-scan (production does this from js/app.js)
  A.state.consent = { version: '1.2' };
  A.state.featureAck = { scanner: Date.now() }; // skip the legal-notice modal so open() runs directly
  const chip = doc.getElementById('chip-scan');
  scriptOutcomes.push('fail'); // js/scanners.js's injected <script> fires onerror
  chip.click();
  await sleep(15);
  const toasts = doc.getElementById('toasts');
  ok('a toast told the rider scanners could not load', !!toasts && /scanner/i.test(toasts.textContent),
    toasts && toasts.textContent);
  ok('#chip-scan is still in the DOM with the shim still attached (no permanent break)', !!chip);

  scriptOutcomes.push('ok'); // retry: the real file loads this time
  chip.click();
  await sleep(15);
  const overlay = doc.getElementById('scanners-overlay');
  ok('the retry succeeds and opens the scanner directory', !!overlay && overlay.hidden === false);
}

async function checkNativeAlertReachesRadarWithGhostOff() {
  group('js/native.js — a BLE detector alert reaches js/radar.js (pulling the lazy module in) even with Ghost Mode off — the alerting-regression guard');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.state.settings.ghost = false;
  ok('js/radar.js has not been loaded yet (Ghost Mode was never turned on)', !A.radar);

  var alertCb;
  A.config.plugins = {
    RadarDetector: {
      addListener: function (ev, cb) { if (ev === 'alert') alertCb = cb; },
      startScan: function () { return Promise.resolve({ scanning: true }); }
    }
  };
  await A.native.startDetector();
  ok('the native alert listener is wired', typeof alertCb === 'function');

  scriptOutcomes.push('ok'); // js/radar.js loads, pulled in by the alert (not dropped)
  alertCb({ band: 'Ka', strength: 9 });
  await sleep(20);
  ok('the alert pulled js/radar.js in even though Ghost Mode is off', !!A.radar);

  // Turn the HUD on after the fact (as if the rider enables Ghost Mode later)
  // and confirm the alert that arrived while it was off is still there, not
  // silently dropped by the naive `if (A.radar)` guard the lazy migration
  // could otherwise have introduced. This harness never runs A.mapview.init()
  // (no real MapLibre instance), so stub the two ring-layer calls setActive()
  // makes — unrelated to what this check is about, and always guarded by
  // `if (A.mapview...)` in production where the map is guaranteed live by now.
  A.mapview.setRingsVisible = function () {};
  A.mapview.setRingsData = function () {};
  A.radar.setActive(true);
  const banner = doc.getElementById('radar-alerts').innerHTML;
  ok('the detector alert that arrived before Ghost Mode was on renders once the HUD turns on',
    /Ka-band/.test(banner) && /RADAR/.test(banner), banner);
}

async function checkGhostPersistedOnBootLoadsRadarImmediately() {
  group('js/ui.js init() — S.settings.ghost persisted true ends with A.radar.setActive(true) having been called, loaded immediately not at idle');
  const { A, scriptOutcomes } = bootRealUi();
  A.state.settings.ghost = true;
  scriptOutcomes.push('ok'); // js/radar.js loads
  // Same test-harness gap as the check above: no real MapLibre instance here.
  // init()'s ghost-boot block also touches setGhostLayersVisible/setPlayerGhost
  // before ever reaching the radar call this check is actually about.
  A.mapview.setRingsVisible = function () {};
  A.mapview.setRingsData = function () {};
  A.mapview.setGhostLayersVisible = function () {};
  A.mapview.setPlayerGhost = function () {};
  A.ui.init();
  await sleep(20);
  ok('A.radar was loaded immediately at boot because Ghost Mode was already persisted on', !!A.radar);
  ok('A.radar.isActive() is true after boot', !!A.radar && A.radar.isActive());
}

/* ---------------- cycle 5 task 1: the reviewer MEDIUM — a rapid double-tap on
   #chip-scan (no await between clicks) before the module resolves used to
   attach two .then() callbacks, both firing the legal gate. bootRealUi's
   default script-load delay is 0ms, which resolves before a second synchronous
   click can even happen — raised to 20ms here (mirroring the reviewer's own
   probe) so the second click genuinely lands before the first load settles. ---------------- */
async function checkScannerRapidDoubleTapBeforeLoadRunsGateOnce() {
  group('js/ui.js — #chip-scan rapid double-tap (no await between clicks) before the module loads runs the legal gate exactly once (reviewer MEDIUM)');
  const { doc, A, scriptOutcomes } = bootRealUi({ scriptDelayMs: 20 });
  A.ui.init(); // wires the js/ui.js shim onto #chip-scan
  var gateCalls = 0;
  A.ui.legalGate = function () { gateCalls++; };
  const chip = doc.getElementById('chip-scan');
  scriptOutcomes.push('ok'); // js/scanners.js loads, 20ms later
  chip.click(); // tap 1: attaches A.lazy.scanners().then(...)
  chip.click(); // tap 2, no await: fires while the shim is still attached (RED before the fix)
  await sleep(30);
  ok('two rapid taps before the module resolved ran the legal gate exactly once, not twice',
    gateCalls === 1, 'gateCalls=' + gateCalls);
}

/* ---------------- cycle 5 task 3: same shape, applied to the NEW #chip-dragy
   shim (written with the fix from the start — this proves it, not just the
   scanner one). ---------------- */
async function checkDragyRapidDoubleTapBeforeLoadRunsGateOnce() {
  group('js/ui.js — #chip-dragy rapid double-tap (no await between clicks) before the module loads runs the legal gate exactly once');
  const { doc, A, scriptOutcomes } = bootRealUi({ scriptDelayMs: 20 });
  A.ui.init(); // wires the js/ui.js shim onto #chip-dragy
  var gateCalls = 0;
  A.ui.legalGate = function () { gateCalls++; };
  const chip = doc.getElementById('chip-dragy');
  scriptOutcomes.push('ok'); // js/dragy.js loads, 20ms later
  chip.click();
  chip.click();
  await sleep(30);
  ok('two rapid taps before the module resolved ran the legal gate exactly once, not twice',
    gateCalls === 1, 'gateCalls=' + gateCalls);
}

/* ---------------- cycle 5 task 2: js/race.js off the boot path. The three
   js/net.js handlers ('race:state'/'race:invite'/'race:fix') are INBOUND
   message paths (guardrail 6, same shape as the native BLE-alert sites cycle
   4 guarded) — this drives a real 'race:invite' frame through the REAL
   js/net.js message table (a fake WebSocket, exactly like test/net.test.js
   uses) to prove the module gets pulled in, not silently dropped. ---------- */
async function checkRaceInviteNotDropped() {
  group("js/net.js race:invite — arrives through the real message table and pulls the lazy js/race.js module in (an inbound message must not be dropped)");
  const { win, A, scriptOutcomes } = bootRealUi();
  ok('A.race has not been loaded yet', !A.race);

  const sockets = [];
  win.WebSocket = class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  };
  A.net.connect();
  const s = sockets[0];
  s.readyState = 1;
  s.onopen(); // sets ws = socket, so the message-guard (ws !== socket) passes

  scriptOutcomes.push('ok'); // js/dragy.js loads (A.lazy.race's own dependency, Trap A)
  scriptOutcomes.push('ok'); // js/race.js loads
  s.onmessage({ data: JSON.stringify({ t: 'race:invite', fromName: 'Ghost', modeId: 'quarter', raceId: 'r1' }) });
  await waitFor(function () { return !!A.race; }, 2000);
  ok('the inbound race:invite pulled js/race.js in instead of silently no-oping because A.race was not loaded yet',
    !!A.race);
}

/* "Challenge to race" used to be gated on A.race already being loaded
   (`if (A.race && A.race.challenge)`), which would have hidden the button
   from every profile overlay the instant race.js left the boot path. It must
   render unconditionally and load the module on click instead. */
async function checkChallengeButtonLoadsRaceLazily() {
  group('js/ui.js buildProfileOverlay() — "Challenge to race" renders even before js/race.js has loaded, and loads it (plus its dragy dependency) on click');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.mapview.addNpc = function () {};
  A.sim.remoteAdd({
    id: 'npc2', name: 'Rival', handle: 'rival', emoji: '🏁', vibe: 'Racing',
    car: { year: 2021, make: 'Test', model: 'Car' }, pos: [0, 0], heading: 0
  });
  ok('A.race has not been loaded yet', !A.race);

  A.ui.openProfileOverlay('npc2');
  const raceBtn = Array.prototype.filter.call(
    doc.querySelectorAll('.pf-po-actions button'),
    function (b) { return /Challenge to race/.test(b.textContent); }
  )[0];
  ok('"Challenge to race" is rendered even though js/race.js has not loaded yet', !!raceBtn);

  A.net.isLive = function () { return true; };
  A.sim.hasRealPos = function () { return true; };
  scriptOutcomes.push('ok'); // js/dragy.js loads (A.lazy.race's own dependency)
  scriptOutcomes.push('ok'); // js/race.js loads
  raceBtn.click();
  await waitFor(function () { return !!A.race; }, 2000);
  ok('clicking "Challenge to race" loaded js/race.js', !!A.race);
}

/* ---------------- cycle 5 task 3: js/dragy.js off the boot path ---------------- */

/* Trap A: js/race.js's modeById() falls back to A.racetimer.modeById, which
   only js/dragy.js ever sets (js/dragy.js:500). Without the dependency wiring
   in A.lazy.race (js/config.js), a race started by a rider who never opened
   the dragy chip would resolve no mode and silently never begin. */
async function checkRaceLoadsDragyDependencyTrapA() {
  group('js/config.js A.lazy.race() — Trap A: loads js/dragy.js as a dependency first, so the shared mode table is populated (a race would otherwise silently never start)');
  const { A, scriptOutcomes } = bootRealUi();
  ok('A.dragy has not loaded yet', !A.dragy);
  ok('A.race has not loaded yet', !A.race);

  scriptOutcomes.push('ok'); // js/dragy.js loads first (the dependency)
  scriptOutcomes.push('ok'); // js/race.js loads second
  const r = await A.lazy.race();
  ok('A.lazy.race() loaded js/dragy.js as a dependency before resolving', !!A.dragy);
  ok('A.lazy.race() resolved with the real js/race.js module', !!A.race && r === A.race);
  const mode = A.racetimer && A.racetimer.modeById && A.racetimer.modeById('quarter');
  ok('the shared mode table is populated: A.racetimer.modeById resolves a real mode (Trap A closed)',
    !!mode, JSON.stringify(mode));
}

/* With dragy unloaded, the overlay must still render (degraded — raw mode ids,
   no sort order), then re-render in place with human labels once it lands. */
async function checkProfileOverlayRendersDragyLabelsOnceLoaded() {
  group('js/ui.js openProfileOverlay() — public overlay degrades without js/dragy.js, then re-renders with human mode labels once it loads');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.mapview.addNpc = function () {};
  A.sim.remoteAdd({
    id: 'npc1', name: 'Ghost', handle: 'ghost', emoji: '👻', vibe: 'Cruising',
    car: { year: 2020, make: 'Test', model: 'Car' }, pos: [0, 0], heading: 0,
    stats: { pb: { quarter: { time: 12.3, trap: 40 } } }
  });
  ok('A.dragy has not loaded yet', !A.dragy);

  scriptOutcomes.push('ok'); // js/dragy.js loads
  A.ui.openProfileOverlay('npc1');
  const bestsBefore = doc.querySelector('.pf-po-bests').textContent;
  ok('before js/dragy.js loads, the bests section shows the raw mode id (degraded, not broken)',
    /quarter/.test(bestsBefore), bestsBefore);

  await sleep(30);
  const bestsAfter = doc.querySelector('.pf-po-bests').textContent;
  ok('once js/dragy.js loads, the overlay re-renders with a human label + dragy sort order from A.dragy.modes()',
    A.dragy.modes().some(function (m) { return bestsAfter.indexOf(m.label) >= 0; }), bestsAfter);
}

/* ---------------- cycle 8 task 1: the directive's own found-and-fixed defect
   — js/ui.js:620's renderConvoy() read D.CONVOY_NAMES synchronously with no
   guard, so opening the Convoy panel before the idle warm (or a failed warm,
   swallowed by js/app.js's .catch(function(){})) landed js/data.js threw a
   TypeError and left #convoy-body EMPTY (body.innerHTML='' runs before the
   throw). Fixed by reusing js/party.js's FALLBACK_CONVOY_NAMES (now exported
   on A.party) for the first paint, then self-healing via A.data.ensure() once
   real data lands (mirrors buildProfilePanel()'s openName re-render guard). ---------------- */
async function checkConvoyPanelSurvivesUnloadedData() {
  group('js/ui.js renderConvoy() — opening Convoy before js/data.js has loaded does not throw and paints a real hero, not a blank panel');
  const { doc, A } = bootRealUi();
  ok('A.data.loaded is false — js/data.js has not been fetched yet (the exact precondition of the bug)',
    !A.data.loaded);

  let threw = null;
  try { A.ui.openPanel('convoy'); } catch (e) { threw = e; }
  ok('A.ui.openPanel(\'convoy\') does not throw with js/data.js unloaded', threw === null,
    threw && threw.stack.split('\n').slice(0, 2).join(' | '));

  const body = doc.getElementById('convoy-body');
  ok('#convoy-body is non-empty after opening (not stranded blank by the throw)', body.children.length > 0);
  const nameInput = body.querySelector('input.input');
  ok('the convoy-name placeholder is one of js/party.js\'s FALLBACK_CONVOY_NAMES (real DOM, not just "no exception")',
    !!nameInput && A.party.FALLBACK_CONVOY_NAMES.indexOf(nameInput.placeholder) >= 0,
    nameInput && nameInput.placeholder);
}

async function checkConvoyPanelSelfHealsOnceDataLands() {
  group('js/ui.js renderConvoy() — once A.data.ensure() resolves, the panel re-renders in place with a real catalog name');
  const { doc, A, scriptOutcomes } = bootRealUi();
  A.ui.openPanel('convoy');
  const before = doc.getElementById('convoy-body').querySelector('input.input').placeholder;
  ok('before the load resolves, the placeholder is still a fallback name (sanity check on the setup)',
    A.party.FALLBACK_CONVOY_NAMES.indexOf(before) >= 0, before);

  scriptOutcomes.push('ok'); // js/data.js actually loads (bootRealUi evals the real file, see harness.js)
  await A.data.ensure();
  await sleep(0); // let the .then() re-render scheduled by renderConvoy() run

  const after = doc.getElementById('convoy-body').querySelector('input.input').placeholder;
  ok('A.data.loaded is true after ensure() resolves', A.data.loaded === true);
  ok('after the load, the placeholder is drawn from the real D.CONVOY_NAMES catalog, not the 3-item fallback (proves the self-heal re-render actually ran)',
    A.data.CONVOY_NAMES.indexOf(after) >= 0 && A.party.FALLBACK_CONVOY_NAMES.length < A.data.CONVOY_NAMES.length,
    'after="' + after + '" fallbackLen=' + A.party.FALLBACK_CONVOY_NAMES.length + ' realLen=' + A.data.CONVOY_NAMES.length);
}

(async function runRemainingGroupsInSequence() {
  await checkRetryAfterRejection();
  await checkFailedGarageLeavesAWayBack();
  await checkOverlappingOpensRenderOnce();
  await checkScannerSecondTapAfterLoadRunsGateOnce();
  await checkScannerFailedLoadRetries();
  await checkNativeAlertReachesRadarWithGhostOff();
  await checkGhostPersistedOnBootLoadsRadarImmediately();
  await checkScannerRapidDoubleTapBeforeLoadRunsGateOnce();
  await checkDragyRapidDoubleTapBeforeLoadRunsGateOnce();
  await checkRaceInviteNotDropped();
  await checkChallengeButtonLoadsRaceLazily();
  await checkRaceLoadsDragyDependencyTrapA();
  await checkProfileOverlayRendersDragyLabelsOnceLoaded();
  await checkConvoyPanelSurvivesUnloadedData();
  await checkConvoyPanelSelfHealsOnceDataLands();
  process.exit(report());
})();
