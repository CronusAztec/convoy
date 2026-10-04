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
const { group, ok, report, ROOT, bootRealUi, sleep, waitFor, bootModuleNames } = H;

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

/* ---------------- cycle 9 tasks 1-2: buildCarSetup() — the same bug class as
   renderConvoy() (cycle 8), on the account-creation path. js/ui.js:3300's
   buildCarSetup() read D.NAMES/D.MAKE_LIST/D.MAKES/D.PAINTS/D.VIBES with no
   guard, so tapping "Create account"/"Continue as guest" on the welcome
   screen, or finishing an OAuth sign-in via showOAuthSetup() (entered
   straight from js/auth.js:721/798, bypassing withAuthConfig entirely),
   before js/data.js had loaded threw a TypeError INSIDE a .then() callback
   — an unhandled promise rejection, invisible in a browser and fatal to a
   bare Node process (confirmed: reverting the fix and driving this same
   click path crashes the whole test process before any of its own
   console.log lines run). A synchronous try/catch around .click() cannot
   see this — only a process 'unhandledRejection' listener can, which is
   what withUnhandledRejection() below installs for the duration of each
   check. Reproduced against the pre-fix tree (reverted, ran, restored):
     TypeError: Cannot read properties of undefined (reading 'length')
       at Object.pick (js/util.js:60)
       at buildCarSetup (js/ui.js:3304)
       at buildAuth (js/ui.js:4275)
   Fixed two ways (task 1a+1b): (a) withCatalog() — a shared helper,
   js/ui.js — makes register/guest (via renderAuth) and showOAuthSetup await
   A.data.ensure() before ever calling buildCarSetup(), so the common
   post-warm case (A.data.ensure() resolves synchronously once loaded) is
   unchanged and the rare pre-warm case just waits the extra tens of ms;
   welcome/login/forgot/magic/recover read no catalog and do NOT wait (kept
   out of withAuthConfig itself on purpose — see this cycle's directive's own
   "Considered and rejected"). (b) a tiny built-in catalog
   (FALLBACK_NAMES/FALLBACK_MAKES/FALLBACK_PAINTS/FALLBACK_VIBES, js/ui.js)
   is the last-resort seed for when A.data.ensure() itself rejects (offline,
   CDN hiccup) — (a) alone cannot cover that case, since .catch() lets
   execution continue with D still empty. No self-heal re-render here (unlike
   renderConvoy): the fields this form crashed on are typed/chosen by the
   rider immediately, so replacing the whole card once data.js lands would
   discard whatever they'd already entered. ---------------- */
function withUnhandledRejection(fn) {
  return async function () {
    let caught = null;
    const onRejection = function (reason) { caught = reason; };
    process.on('unhandledRejection', onRejection);
    // Two different failure shapes to catch here, not one: the fixed code throws
    // inside a .then() callback (invisible to try/catch, only the listener above
    // sees it — the entire reason this helper exists), but the PRE-FIX code
    // (proving RED) calls buildCarSetup() synchronously with no promise involved
    // at all, which surfaces as a normal thrown exception instead.
    try { await fn(); } catch (e) { caught = e; } finally { process.removeListener('unhandledRejection', onRejection); }
    return caught;
  };
}

async function checkCreateAccountSurvivesUnloadedData() {
  group('js/ui.js buildCarSetup() via "Create account" — register before js/data.js has loaded raises no unhandled rejection');
  const { doc, A } = bootRealUi();
  ok('A.data.loaded is false — js/data.js has not been fetched yet (the exact precondition of the bug)',
    !A.data.loaded);

  const findRegBtn = function () { return Array.from(doc.querySelectorAll('#onboarding button')).find(function (b) { return b.textContent.trim() === 'Create account'; }); };
  const caught = await withUnhandledRejection(async function () {
    A.ui.showAuth(function () {});
    await waitFor(findRegBtn, 3000); // withAuthConfig()'s A.auth.config() promise resolving (network disabled in this harness) — poll, not a fixed sleep (task 0: a fixed sleep(150) here flaked under box load, see STATE.md §5 cycle 16)
    const regBtn = findRegBtn();
    ok('welcome screen renders a "Create account" button', !!regBtn);
    regBtn.click();
    await waitFor(function () { return !!doc.querySelector('#onboarding input[placeholder="Display name"]'); }, 3000); // renderAuth('register')'s withAuthConfig() + withCatalog()'s A.data.ensure().catch().then() chain
  })();
  ok('tapping "Create account" on a cold/unloaded-data start raises no unhandled rejection', caught === null,
    caught && caught.stack && caught.stack.split('\n').slice(0, 3).join(' | '));

  const nameField = doc.querySelector('#onboarding input[placeholder="Display name"]');
  ok('the car-setup form actually rendered — Display-name field present with a real-catalog value (task 1a: withCatalog() won the race against the click, so this is the real D.NAMES, not the fallback — proves common-case behaviour is unchanged)',
    !!nameField && A.data.NAMES.indexOf(nameField.value) >= 0, nameField && nameField.value);
  const makeSel = doc.querySelector('#onboarding select');
  ok('a Make select actually populated (not stranded on an empty <select>)', !!makeSel && makeSel.options.length > 0);
}

async function checkCreateAccountFallsBackWhenCatalogLoadFails() {
  group('js/ui.js buildCarSetup() via "Create account" — js/data.js genuinely FAILS to load (task 1b: withCatalog()\'s .catch cannot make the catalog appear, only the seed can)');
  const { doc, A, scriptOutcomes } = bootRealUi();

  const findRegBtn = function () { return Array.from(doc.querySelectorAll('#onboarding button')).find(function (b) { return b.textContent.trim() === 'Create account'; }); };
  const caught = await withUnhandledRejection(async function () {
    A.ui.showAuth(function () {});
    await waitFor(findRegBtn, 3000);
    const regBtn = findRegBtn();
    scriptOutcomes.push('fail'); // the one dynamic <script> A.data.ensure() injects, forced to error
    regBtn.click();
    await waitFor(function () { return !!doc.querySelector('#onboarding input[placeholder="Display name"]'); }, 3000);
  })();
  ok('a failed js/data.js load still raises no unhandled rejection', caught === null,
    caught && caught.stack && caught.stack.split('\n').slice(0, 3).join(' | '));
  ok('A.data.loaded is still false — the load genuinely failed, this is not accidentally the success path',
    !A.data.loaded);

  const nameField = doc.querySelector('#onboarding input[placeholder="Display name"]');
  ok('the car-setup form still rendered — Display-name field present with the FALLBACK_NAMES seed (the only way this can be non-blank when the catalog fetch truly failed)',
    !!nameField && A.ui.FALLBACK_NAMES.indexOf(nameField.value) >= 0, nameField && nameField.value);
  const makeSel = doc.querySelector('#onboarding select');
  ok('a Make select still populated from the fallback catalog (not stranded on an empty <select>)', !!makeSel && makeSel.options.length > 0);
}

async function checkGuestSurvivesUnloadedData() {
  group('js/ui.js buildCarSetup() via "Continue as guest" — guest setup before js/data.js has loaded raises no unhandled rejection');
  const { doc, A } = bootRealUi();

  const findGuestBtn = function () { return Array.from(doc.querySelectorAll('#onboarding button')).find(function (b) { return b.textContent.trim() === 'Continue as guest'; }); };
  const caught = await withUnhandledRejection(async function () {
    A.ui.showAuth(function () {});
    await waitFor(findGuestBtn, 3000);
    const guestBtn = findGuestBtn();
    ok('welcome screen renders a "Continue as guest" button', !!guestBtn);
    guestBtn.click();
    await waitFor(function () { return !!doc.querySelector('#onboarding input[placeholder="Display name"]'); }, 3000);
  })();
  ok('tapping "Continue as guest" on a cold/unloaded-data start raises no unhandled rejection', caught === null,
    caught && caught.stack && caught.stack.split('\n').slice(0, 3).join(' | '));

  const nameField = doc.querySelector('#onboarding input[placeholder="Display name"]');
  ok('the guest car-setup form rendered with a real-catalog name (task 1a won the race, same as "Create account")',
    !!nameField && A.data.NAMES.indexOf(nameField.value) >= 0, nameField && nameField.value);
}

async function checkOAuthSetupSurvivesUnloadedData() {
  group('js/ui.js showOAuthSetup() — the entry point that bypasses withAuthConfig entirely — raises no unhandled rejection with js/data.js unloaded');
  const { doc, A } = bootRealUi();
  ok('A.data.loaded is false — js/data.js has not been fetched yet (the exact precondition of the bug)',
    !A.data.loaded);

  const caught = await withUnhandledRejection(async function () {
    A.ui.showOAuthSetup({ suggested: { name: 'Riley' }, email: 'riley@example.com' }, function () {});
    await waitFor(function () { // withCatalog()'s A.data.ensure().catch().then() chain — poll for the catalog-dependent Make select, not a fixed sleep
      var ms = doc.querySelectorAll('#onboarding select')[1];
      return !!ms && ms.options.length > 0;
    }, 3000);
  })();
  ok('showOAuthSetup() raises no unhandled rejection with js/data.js unloaded', caught === null,
    caught && caught.stack && caught.stack.split('\n').slice(0, 3).join(' | '));

  const nameField = doc.querySelector('#onboarding input[placeholder="Display name"]');
  ok('the OAuth car-setup form rendered — Display-name pre-filled from the provider suggestion (defaults.name always wins over any catalog, real or fallback)',
    !!nameField && nameField.value === 'Riley', nameField && nameField.value);
  const makeSel = doc.querySelectorAll('#onboarding select')[1]; // order: Year, Make, Model
  ok('a Make select populated from the real catalog (task 1a won the race)',
    !!makeSel && makeSel.options.length > 0 && A.data.MAKE_LIST.indexOf(makeSel.value) >= 0, makeSel && makeSel.value);
}

async function checkOAuthSetupFallsBackWhenCatalogLoadFails() {
  group('js/ui.js showOAuthSetup() — js/data.js genuinely FAILS to load (task 1b applies to this entry point too)');
  const { doc, A, scriptOutcomes } = bootRealUi();

  const caught = await withUnhandledRejection(async function () {
    scriptOutcomes.push('fail'); // the one dynamic <script> A.data.ensure() injects, forced to error
    A.ui.showOAuthSetup({ suggested: {}, email: 'riley@example.com' }, function () {});
    await waitFor(function () { return !!doc.querySelector('#onboarding input[placeholder="Display name"]'); }, 3000);
  })();
  ok('a failed js/data.js load still raises no unhandled rejection', caught === null,
    caught && caught.stack && caught.stack.split('\n').slice(0, 3).join(' | '));
  ok('A.data.loaded is still false — the load genuinely failed', !A.data.loaded);

  const nameField = doc.querySelector('#onboarding input[placeholder="Display name"]');
  ok('the OAuth car-setup form still rendered — Display-name field present with the FALLBACK_NAMES seed (no provider name suggested this time, so the fallback list is what has to carry it)',
    !!nameField && A.ui.FALLBACK_NAMES.indexOf(nameField.value) >= 0, nameField && nameField.value);
  const makeSel = doc.querySelector('#onboarding select');
  ok('a Make select still populated from the fallback catalog (not stranded on an empty <select>)', !!makeSel && makeSel.options.length > 0);
}

/* ---------------- cycle 9 task 3: close the *class*, not just this instance.
   Cycle 8's own gate (testRealBootGraphSurfaces()) audited by PANEL NAME
   (nearby/convoy/profile) and still missed this cycle's bug, because it never
   clicked anything on the auth screens. The fix here changes the unit of
   audit to "every function in the boot graph that reads D.<CATALOG>",
   derived the same simple way the directive's own reproduction used (track
   the most recently seen `function NAME(` line, flag any subsequent
   `D.UPPER_SNAKE` reference to it) — deliberately not scope-aware, so this
   also (correctly) attributes a getProfile() closure's read to whatever
   named function textually precedes it in the same file. That imprecision is
   fine: the point is not a perfect call graph, it's that NO enclosing
   function can read the catalog without a one-line reason typed into
   DATA_READ_SITES below — the next lazy-module conversion has to earn its
   way past this check by name, not slip through because nobody thought to
   click that particular button. ---------------- */
function scanDataReadSites(html) {
  const FN_RE = /function\s+([A-Za-z_]+)\(/;
  const READ_RE = /(^|[^A-Za-z0-9_.])D\.[A-Z_]+/;
  const sites = {};
  let total = 0;
  bootModuleNames(html).forEach(function (name) {
    const file = path.join(ROOT, 'js', name + '.js');
    if (!fs.existsSync(file)) return;
    let fn = null;
    fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
      const fnMatch = line.match(FN_RE);
      if (fnMatch) fn = fnMatch[1];
      if (READ_RE.test(line)) { sites[fn] = (sites[fn] || 0) + 1; total += 1; }
    });
  });
  return { sites, total };
}

// Every function this scan currently finds, and why it is safe to read the
// lazy catalog. An entry missing here — or a brand-new function the scan
// finds that isn't listed — fails the check by name (below).
const DATA_READ_SITES = {
  buildProfilePanel: 'the A.data.ensure() await itself, before garage/profile render (js/ui.js)',
  buildGaragePage: "reached only through buildProfilePanel()'s A.data.ensure() await",
  randomizeProfileForm: "reached only through buildProfilePanel()'s A.data.ensure() await",
  modelsFor: "already guarded — falls back to ['Other'] when D.MAKES is empty",
  trimsFor: "already guarded — falls back to ['Standard'] when D.VEHICLES is empty",
  buildCarSetup: 'seeded (FALLBACK_NAMES/MAKE_LIST/MAKES/PAINTS/VIBES) + awaited via withCatalog() (cycle 9 task 1)',
  // The scan is not scope-aware: buildCarSetup's own getProfile() closure reads
  // D.VIBES, but textually the nearest preceding `function NAME(` line is its
  // sibling helper refillTrims(), so the scan attributes the read there. Same
  // fix, same reason as buildCarSetup itself — noted so this isn't mistaken
  // for a real gap in refillTrims(), which touches no D.* itself.
  refillTrims: 'attribution artifact of the line-scan for buildCarSetup\'s getProfile() D.VIBES read — same fix as buildCarSetup (cycle 9 task 1)',
  renderConvoy: 'guarded + self-heals once A.data.ensure() resolves (cycle 8)',
  convoyName: 'already guarded inline — falls back to FALLBACK_CONVOY_NAMES (js/party.js)',
  sendChat: 'already guarded inline — falls back to a 3-item reply list (js/party.js)'
};

function checkDataReadSitesAreAllAccountedFor() {
  group('D.<CATALOG> reads in the boot graph — every enclosing function is accounted for by dependency, not by panel name (cycle 9 task 3)');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { sites, total } = scanDataReadSites(html);
  const foundFns = Object.keys(sites);

  // Self-check: a regex/scan that silently matches nothing must not pass
  // silently. Ten functions / 30 reads is what this scan measures against the
  // current tree — see the tolerance note below for why these are floors,
  // not exact pins (this is a pass/fail gate, guardrail 4, not a
  // frontend-baseline.json ratchet).
  ok('the scan is not silently matching nothing — at least 10 enclosing functions found',
    foundFns.length >= 10, 'found ' + foundFns.length + ': ' + foundFns.sort().join(', '));
  ok('the scan is not silently matching nothing — at least 25 individual D.<CATALOG> reads found',
    total >= 25, 'found ' + total);

  const unlisted = foundFns.filter(function (fn) { return !Object.prototype.hasOwnProperty.call(DATA_READ_SITES, fn); });
  ok('every function reading D.<CATALOG> in the boot graph has a one-line reason in DATA_READ_SITES — an unlisted one means a new unguarded read landed',
    unlisted.length === 0, unlisted.length ? 'unlisted: ' + unlisted.join(', ') : 'none');
}

(async function runRemainingGroupsInSequence() {
  await checkRetryAfterRejection();
  await checkFailedGarageLeavesAWayBack();
  await checkOverlappingOpensRenderOnce();
  await checkConvoyPanelSurvivesUnloadedData();
  await checkConvoyPanelSelfHealsOnceDataLands();
  await checkCreateAccountSurvivesUnloadedData();
  await checkCreateAccountFallsBackWhenCatalogLoadFails();
  await checkGuestSurvivesUnloadedData();
  await checkOAuthSetupSurvivesUnloadedData();
  await checkOAuthSetupFallsBackWhenCatalogLoadFails();
  checkDataReadSitesAreAllAccountedFor();
  process.exit(report());
})();
