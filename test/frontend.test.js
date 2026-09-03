/* Convoy — front-end quality harness. `npm run test:frontend`

   Loads the real index.html into jsdom (page's own <script> tags never run —
   runScripts:'outside-only' — so nothing fetches the network); the real
   js/*.js modules are then eval'd into that same window one by one, in the
   exact order index.html loads them (minus the MapLibre CDN script and
   app.js's own DOMContentLoaded wiring, which assumes a live map/socket).
   axe-core runs against the shell and against each panel opened through the
   real A.ui API, so what is asserted is what a WebView actually renders, not
   a hand-written fixture.

   html-validate checks index.html markup validity. Every gate here (markup
   errors, axe violations per surface, the impeccable design-integrity
   detector) is checked against test/frontend-baseline.json, ratchet-DOWN
   only: today's numbers become the ceiling, a later stage lowers them by
   fixing real issues (see STATE.md milestone M3+), and none of them may be
   raised to make a red run green. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { HtmlValidate } = require('html-validate');
const H = require('./harness');

const ROOT = H.ROOT;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BASELINE_PATH = path.join(ROOT, 'test', 'frontend-baseline.json');
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const measured = {};

function atOrBelowBaseline(label, key, count, detail) {
  const cap = baseline[key];
  H.ok(label + ' (' + count + ') is at or below the stored baseline (' + cap + ')',
    count <= cap,
    (detail ? detail + ' — ' : '') + 'baseline is ratchet-down-only: fix the issue, then lower "' + key + '" in test/frontend-baseline.json');
  // Print the detail even on a passing run — this is what lets a stage see
  // the actual per-surface violation id/nodeCount list without guessing or
  // writing a throwaway probe script.
  console.log('    ' + key + ': ' + (detail || 'none'));
  measured[key] = count;
}

/* Module load order, copied from index.html's <script> tags (defer, so this
   IS the execution order). The MapLibre CDN script and app.js are excluded:
   the CDN script needs a network fetch jsdom won't do, and app.js only wires
   a DOMContentLoaded listener that assumes a live map/socket/GPS — nothing
   under test calls into it. */
const MODULE_ORDER = [
  'config', 'telemetry', 'data', 'util', 'state', 'themes', 'detectors', 'space',
  'mapview', 'sim', 'net', 'routing', 'ghost', 'radar', 'overlays', 'scanners',
  'racetimer', 'dragy', 'wake', 'places', 'triplog', 'speedo', 'hud', 'compass',
  'clock', 'tripmeter', 'gmeter', 'quest', 'weathernow', 'battery', 'coords',
  'destarrow', 'riderarrows', 'speedalert', 'dimmer', 'tripextras', 'party',
  'voice', 'ui', 'auth', 'native', 'ota', 'race'
];

function buildWindow() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  // jsdom does not implement matchMedia; several modules (themes/hud/settings)
  // feature-detect prefers-reduced-motion / prefers-color-scheme through it.
  win.matchMedia = win.matchMedia || function () {
    return { matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
  };
  // No CDN script runs (runScripts:'outside-only'), so window.maplibregl is
  // never defined. mapview.js only touches it inside functions that build a
  // live map — none of those are on the paths under test (openPanel, toasts,
  // settings, auth screens) — so an absent global is the honest state, not a
  // gap to paper over with a fake Map class.
  win.Capacitor = undefined;
  // No server is reachable from this harness. auth.js's api() calls fetch()
  // synchronously and chains .then/.catch on the result — a rejecting Promise
  // exercises the same "offline / solo mode" fallback path a real network
  // failure does; leaving fetch undefined would make the *call* throw
  // synchronously instead, which is not the behaviour under test.
  win.fetch = function () { return Promise.reject(new Error('network disabled in test harness')); };
  return dom;
}

function loadModules(win) {
  MODULE_ORDER.forEach((name) => {
    const src = fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8');
    win.eval(src);
  });
  return win.App;
}

async function runAxe(win) {
  win.eval(axeSource);
  const r = await win.axe.run(win.document, { runOnly: { type: 'tag', values: AXE_TAGS } });
  return r.violations;
}

function summarizeViolations(violations) {
  return violations.map((v) => v.id + ' (' + v.nodes.length + ')').join(', ');
}

function installAsGlobals(win) {
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
}

/* ---------------- 1. static shell: html-validate + axe ---------------- */
async function testShell() {
  H.group('index.html — markup validity (html-validate)');
  const htmlvalidate = new HtmlValidate();
  const report = await htmlvalidate.validateFile(path.join(ROOT, 'index.html'));
  const errors = report.results.flatMap((r) => r.messages.filter((m) => m.severity === 2));
  atOrBelowBaseline('html-validate errors', 'htmlValidateErrors', errors.length,
    errors.slice(0, 6).map((e) => 'L' + e.line + ' ' + e.ruleId).join('; ') + (errors.length > 6 ? '; …' : ''));

  H.group('index.html — axe-core WCAG 2.2 AA (closed shell, no script)');
  const dom = buildWindow();
  const violations = await runAxe(dom.window);
  atOrBelowBaseline('axe violations on the closed shell', 'axeViolations_shell', violations.length,
    summarizeViolations(violations));
}

/* ---------------- 1b. document structure sanity (regression for the line-15
   orphan-markup defect: a leftover favicon fragment terminated <head> early,
   pushing every stylesheet/script tag and a stray text node into <body>) ---------------- */
function testDocumentStructure() {
  H.group('index.html — <head>/<body> boundary is intact');
  const dom = buildWindow();
  const doc = dom.window.document;
  const first = doc.body.firstChild;
  const firstIsStrayText = !!first && first.nodeType === 3 && first.textContent.trim().length > 0;
  H.ok('document.body.firstChild is not a non-whitespace text node', !firstIsStrayText,
    first ? first.nodeName + ' ' + JSON.stringify(first.textContent.slice(0, 20)) : 'body is empty');
  H.ok('css/styles.css link parses into <head>', !!doc.head.querySelector('link[href*="styles.css"]'),
    'stylesheet link is missing from <head> — it likely parsed into <body> instead');
  H.ok('no stray top-level <path> elements in <body>', doc.body.querySelectorAll(':scope > path').length === 0,
    'found ' + doc.body.querySelectorAll(':scope > path').length + ' — a leftover SVG fragment escaped into body');
}

/* ---------------- 2. live surfaces: real A.ui panels under jsdom ---------------- */
async function testSurfaces() {
  H.group('js/ui.js — panels render under jsdom (real A.ui API)');
  const dom = buildWindow();
  const win = dom.window;
  installAsGlobals(win);

  let A;
  try {
    A = loadModules(win);
    H.ok('module chain (' + MODULE_ORDER.length + ' modules) loads without throwing', true);
  } catch (e) {
    H.ok('module chain loads without throwing', false, e.stack);
    return;
  }

  // showAuth(onDone) takes a completion CALLBACK, not a mode string — the mode
  // is always 'welcome' on open. To reach the login form for real, the surface
  // below drives the same click path a rider does: close any open panel first
  // (mirrors the real caller at js/ui.js:426, renderFriendsInto's "Log in"
  // button), open the welcome screen, let its async config() probe settle,
  // then click the rendered "Log in" button to render the login form.
  const surfaces = [
    ['nearby', 'nearby panel', () => A.ui.openPanel('nearby')],
    ['convoy', 'convoy panel', () => A.ui.openPanel('convoy')],
    ['profile', 'profile panel', () => A.ui.openPanel('profile')],
    ['authWelcome', 'auth screen — welcome', () => {
      A.ui.openPanel(null);
      if (!A.ui.showAuth) throw new Error('A.ui.showAuth is not exported');
      A.ui.showAuth(function () { });
    }],
    ['authLogin', 'auth screen — login form', () => {
      const loginBtn = Array.from(win.document.querySelectorAll('#onboarding button'))
        .find((b) => b.textContent.trim() === 'Log in');
      if (!loginBtn) throw new Error('"Log in" button not found on the rendered welcome screen');
      loginBtn.click();
    }]
  ];

  for (const [key, label, open] of surfaces) {
    try {
      open();
      // buildAuth()/renderAuth() render behind A.auth.config().then(...) — even
      // with fetch stubbed to reject, that resolves via a fallback .catch a few
      // microtasks later. A macrotask tick flushes the whole chain before axe runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      H.ok(label + ' opens without throwing', true);
    } catch (e) {
      H.ok(label + ' opens without throwing', false, e.stack.split('\n').slice(0, 3).join(' | '));
      continue;
    }
    const violations = await runAxe(win);
    atOrBelowBaseline(label + ' — axe violations', 'axeViolations_' + key, violations.length,
      summarizeViolations(violations));
  }
  A.ui.openPanel(null);
}

/* ---------------- 2b. generated ids stay unique across repeated opens ----------------
   The profile panel is destroyed and rebuilt on every open (see mkRow/mkField in
   js/ui.js). Both use never-resetting module-level counters instead of resetting
   per-build state, specifically so that opening the panel twice in one session
   cannot produce two elements with the same id — a duplicate id is itself an
   axe/html-validate violation, which would silently trade one fixed defect for a
   new one. */
function testGeneratedIdsUnique() {
  H.group('js/ui.js — mkRow/mkField ids stay unique across repeated panel opens');
  const dom = buildWindow();
  const win = dom.window;
  installAsGlobals(win);
  const A = loadModules(win);
  A.ui.openPanel('profile');
  A.ui.openPanel(null);
  A.ui.openPanel('profile');
  const rowIds = Array.from(win.document.querySelectorAll('[id^="row-lbl-"]')).map((n) => n.id);
  const fieldIds = Array.from(win.document.querySelectorAll('[id^="field-ctl-"]')).map((n) => n.id);
  H.ok('no duplicate "row-lbl-" ids after opening the profile panel twice',
    new Set(rowIds).size === rowIds.length, 'ids: ' + rowIds.join(', '));
  H.ok('no duplicate "field-ctl-" ids after opening the profile panel twice',
    new Set(fieldIds).size === fieldIds.length, 'ids: ' + fieldIds.join(', '));
  A.ui.openPanel(null);
}

/* ---------------- 2c. ui-013: closed panels are inert (no phantom tab stops) ----------------
   jsdom does not implement `inert` — no IDL property, no focus-blocking (verified directly:
   `p.inert` is undefined and `.focus()` on a button inside an inert subtree still moves focus
   in jsdom 30.0.1). A behavioural test ("focus() it, assert focus didn't move") would therefore
   fail even against a CORRECT implementation. This models the browser's real tab-order rule
   instead: [inert] and [hidden] subtrees and disabled controls are excluded from sequential
   focus navigation. aria-hidden is deliberately NOT part of that rule — aria-hidden alone never
   removed anything from the tab order, which is exactly why it was never a fix for ui-013. */
const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
function tabbable(doc) {
  return Array.from(doc.querySelectorAll(FOCUSABLE)).filter((el) =>
    !el.disabled && !el.closest('[inert]') && !el.closest('[hidden]'));
}

function testClosedPanelsInert() {
  H.group('js/ui.js — openPanel(): closed panels are inert, not just aria-hidden (ui-013)');
  const dom = buildWindow();
  const win = dom.window;
  installAsGlobals(win);
  const A = loadModules(win);
  const doc = win.document;

  // Visit all three panels (this is what grows the bug: panels are built lazily
  // and never torn down, so a user who has looked at everything once leaves the
  // most stray controls behind), then return to the map.
  A.ui.openPanel('nearby');
  A.ui.openPanel('convoy');
  A.ui.openPanel('profile');
  A.ui.openPanel(null);

  const inClosedPanels = tabbable(doc).filter((el) => el.closest('.panel'));
  H.ok('no tabbable elements remain inside any panel once all are closed (pre-fix: 133)',
    inClosedPanels.length === 0,
    'found ' + inClosedPanels.length + (inClosedPanels.length ? ': ' + inClosedPanels.slice(0, 5).map((e) => e.tagName).join(', ') : ''));

  // Regression guard: prove the fix didn't just make everything inert.
  A.ui.openPanel('profile');
  const inOpenPanel = tabbable(doc).filter((el) => el.closest('.panel.open'));
  H.ok('the OPEN panel is still fully reachable by keyboard (not everything went inert)',
    inOpenPanel.length > 0, 'found ' + inOpenPanel.length + ' tabbable elements');

  const panels = Array.from(doc.querySelectorAll('.panel'));
  H.ok('every closed panel carries [inert]; the open one does not',
    panels.every((p) => p.classList.contains('open') ? !p.hasAttribute('inert') : p.hasAttribute('inert')),
    panels.map((p) => p.dataset.panel + ':' + (p.classList.contains('open') ? 'open' : 'closed') +
      (p.hasAttribute('inert') ? '+inert' : '')).join(', '));
  A.ui.openPanel(null);
}

/* ---------------- 2d. ui-003: #onboarding is a real focus trap ----------------
   showAuth (and the other blocking gates it shares code with — re-consent, password
   reset, OAuth setup) must not be dismissable by Escape or a backdrop click: closing
   those mid-flight strands the rider with no session, or in the re-consent case,
   leaves them using the app under terms they never confirmed. openOverlay's
   user-initiated cards are dismissable by default, with one documented exception
   (the recovery-code card, where a stray Escape would be real data loss). */
async function testModalFocusTrap() {
  H.group('js/ui.js — #onboarding is a focus trap (ui-003)');
  const dom = buildWindow();
  const win = dom.window;
  installAsGlobals(win);
  const A = loadModules(win);
  A.ui.wireDock(); // installs the Tab-wrap / Escape / backdrop-click handlers under test
  const doc = win.document;
  const root = doc.getElementById('onboarding');

  // 1. showAuth(): the shell is inerted; only #onboarding stays tabbable.
  A.ui.showAuth(function () {});
  await new Promise((r) => setTimeout(r, 0)); // let buildAuth()'s config().then(...) settle
  H.ok('showAuth(): #onboarding is not hidden', root.hidden === false);
  const shellChildren = Array.from(doc.body.children).filter((el) =>
    el.id !== 'onboarding' && el.id !== 'toasts' && el.tagName !== 'SCRIPT' && el.tagName !== 'NOSCRIPT');
  H.ok('showAuth(): every other body child is inert',
    shellChildren.length > 0 && shellChildren.every((el) => el.hasAttribute('inert')),
    shellChildren.filter((el) => !el.hasAttribute('inert')).map((el) => el.id || el.className).join(', ') || 'n/a');
  const outside = tabbable(doc).filter((el) => !root.contains(el));
  H.ok('showAuth(): no tabbable element remains outside #onboarding',
    outside.length === 0, 'found ' + outside.length + ': ' + outside.slice(0, 5).map((e) => e.tagName).join(', '));

  // 2. Escape must NOT dismiss the gate — the single most important assertion here.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  H.ok('showAuth(): Escape does not close the gate (root.hidden stays false)', root.hidden === false);

  // Reset to a clean closed state before the openOverlay cases (closeOverlay alone
  // is enough here — it clears shell-inert + starts hiding #onboarding, which is
  // all this test needs; the full closeAuthEnter side effects are irrelevant to it).
  A.ui.closeOverlay();
  await new Promise((r) => setTimeout(r, 400));

  // 3. openOverlay (dismissable by default): Escape starts the close animation.
  //    closeOverlay defers hidden=true by 380ms — assert the synchronous 'closing'
  //    class instead of sleeping past a real timer (a timer race is not deterministic).
  function mkCard() {
    const card = doc.createElement('div');
    const btn = doc.createElement('button'); btn.textContent = 'ok';
    card.appendChild(btn);
    return card;
  }
  A.ui.openOverlayRaw(mkCard());
  await new Promise((r) => setTimeout(r, 0));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  H.ok('openOverlay() + Escape: dismissal begins (root gets "closing")', root.classList.contains('closing'));
  await new Promise((r) => setTimeout(r, 400));

  // 4. openOverlay(card, {dismissable:false}) — the recovery-code exception: Escape does nothing.
  A.ui.openOverlayRaw(mkCard(), { dismissable: false });
  await new Promise((r) => setTimeout(r, 0));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  H.ok('openOverlay(card, {dismissable:false}) + Escape: "closing" is NOT set', !root.classList.contains('closing'));
  A.ui.closeOverlay();
  await new Promise((r) => setTimeout(r, 400));

  // 5. Backdrop click closes; a click on the card itself does not.
  const card3 = mkCard();
  A.ui.openOverlayRaw(card3);
  await new Promise((r) => setTimeout(r, 0));
  card3.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  H.ok('a click on the card does not close the overlay', !root.classList.contains('closing'));
  root.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  H.ok('a click on the backdrop (#onboarding itself) closes the overlay', root.classList.contains('closing'));
  await new Promise((r) => setTimeout(r, 400));

  // 6. Composition guard: a naive "un-inert every body child on close" would
  //    silently revert Task 1 (ui-013) here, with every assertion above still green.
  A.ui.openPanel('nearby');
  A.ui.openPanel(null);
  const closedPanel = doc.querySelector('.panel[data-panel="nearby"]');
  H.ok('composition guard setup: the closed panel is inert before any modal opens',
    closedPanel.hasAttribute('inert'));
  A.ui.openOverlayRaw(mkCard());
  await new Promise((r) => setTimeout(r, 0));
  A.ui.closeOverlay();
  await new Promise((r) => setTimeout(r, 400));
  H.ok('composition guard: the closed panel is still inert after an unrelated modal open/close cycle',
    closedPanel.hasAttribute('inert'));
}

/* ---------------- 2e. ui-003b: the shell ALWAYS restores — an invariant over sequences ----------------
   Cycle 4 shipped a focus trap whose setShellInert(true) recomputed "which body children
   to inert" on every call. A second openOverlay() with no closeOverlay() between — which
   this codebase does routinely (the race lobby re-renders on every state push, block→report,
   a profile overlay refreshing on a stats event, regen-recovery's success card) — found
   nothing left to capture, overwrote the restore list with [], and the eventual close
   restored nothing: all 21 shell children stayed inert until reload, for mouse users too
   (inert blocks hit-testing, measured in real Chromium — see stage-16 directive §3).

   testModalFocusTrap() above never opened a modal twice in a row, so 56/56 stayed green over
   a dead app. The lesson: test the INVARIANT, not the one shape you thought of. After any
   open/close sequence that ends in a close, the only [inert] attributes left on body children
   are the ones openPanel put on closed panels (ui-013). Every row below asserts exactly that,
   each in a fresh window so one leak cannot mask or cause another. */
function strayInert(doc) {
  return Array.from(doc.body.children).filter((el) =>
    el.hasAttribute('inert') && !el.classList.contains('panel'));
}

async function testShellRestoreInvariant() {
  H.group('js/ui.js — the shell always restores after any open/close sequence (ui-003b)');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  function fresh() {
    const dom = buildWindow();
    const win = dom.window;
    installAsGlobals(win);
    const A = loadModules(win);
    const doc = win.document;
    const mkCard = () => {
      const card = doc.createElement('div');
      const btn = doc.createElement('button'); btn.textContent = 'ok';
      card.appendChild(btn);
      return card;
    };
    return { A, doc, win, mkCard, open: (opts) => A.ui.openOverlayRaw(mkCard(), opts), close: () => A.ui.closeOverlay() };
  }
  function describe(list) {
    return 'found ' + list.length + (list.length ? ': ' + list.slice(0, 6).map((e) => e.id || e.tagName).join(', ') + (list.length > 6 ? ', …' : '') : '');
  }

  // a–e: sequences. Each mirrors a real call chain (stage-16 directive §2, chains A–F).
  const rows = [
    { id: 'a', label: 'open → close (the one shape the old test covered)',
      run: async (c) => { c.open(); c.close(); } },
    { id: 'b', label: 'open → open → close (block→report, add/change-email success card)',
      run: async (c) => { c.open(); c.open(); c.close(); } },
    { id: 'c', label: 'open → open → open → close (race lobby + countdown ticks, js/race.js renderLobby)',
      run: async (c) => { c.open(); c.open(); c.open(); c.close(); } },
    { id: 'd', label: 'open → open({dismissable:false}) → close (regen-recovery success card)',
      run: async (c) => { c.open(); c.open({ dismissable: false }); c.close(); } },
    { id: 'e', label: 'showAuth → closeOverlay → open → close (gate handing off to a card, close timer still pending)',
      run: async (c) => { c.A.ui.showAuth(function () {}); await tick(0); c.close(); c.open(); c.close(); } }
  ];
  for (const row of rows) {
    const c = fresh();
    await row.run(c);
    const stray = strayInert(c.doc);
    H.ok('case ' + row.id + ': ' + row.label + ' → no shell child left inert',
      stray.length === 0, describe(stray));
  }

  // f: the panel-composition guard PLUS chaining. Must fail in BOTH directions: a chaining
  // leak (shell stuck) and an over-reaching fix that un-inerts openPanel's closed panels
  // (which would silently revert ui-013).
  {
    const c = fresh();
    c.A.ui.openPanel('nearby');
    c.A.ui.openPanel(null);
    const closedPanel = c.doc.querySelector('.panel[data-panel="nearby"]');
    c.open(); c.open(); c.close();
    const stray = strayInert(c.doc);
    H.ok('case f: openPanel(nearby) → openPanel(null) → open → open → close → no shell child left inert',
      stray.length === 0, describe(stray));
    H.ok('case f: the closed panel KEEPS its own inert after the chained cycle (ui-013 not reverted)',
      closedPanel.hasAttribute('inert'));
  }

  // k: a gate opening INSIDE a pending close. closeAuthEnter → done() → auth.enterApp →
  // showConsentGate runs synchronously, and login never records consent locally (only
  // register/guest/OAuth-setup do), so an existing account signing in on a new device — or
  // after a LEGAL_VERSION bump — opens the re-consent gate while closeAuthEnter's 380ms hide
  // timer is still armed. Pre-fix that timer blanked the gate (hidden, empty) and left the
  // shell inert: a blank overlay over a dead app. closeOverlay() has the identical timer
  // shape, so it stands in for the unexported closeAuthEnter here.
  {
    const c = fresh();
    const root = c.doc.getElementById('onboarding');
    c.A.ui.showAuth(function () {}); await tick(0);
    c.close();
    c.A.ui.showConsentGate(function () {});
    await tick(450); // past the 380ms timer
    H.ok('case k: a gate opened while the previous close timer was pending is still showing 450ms later (not blanked)',
      root.hidden === false && root.children.length > 0, 'hidden=' + root.hidden + ' children=' + root.children.length);
    H.ok('case k: the shell is inert while that gate is up (the trap survived the timer)', strayInert(c.doc).length > 0);
    c.close();
    H.ok('case k: closing the gate restores the shell', strayInert(c.doc).length === 0, describe(strayInert(c.doc)));
  }

  // g–i: the #toasts exemption is scoped to NON-INTERACTIVE content. #toasts stays out of
  // the shell trap so aria-live announcements reach AT behind a modal, but inviteToast()
  // puts live Join/Pass buttons in that same container and a socket push can land one
  // while a gate is up — a rider could join a convoy around the re-consent gate.
  {
    const c = fresh();
    const box = c.doc.getElementById('toasts');
    c.A.ui.inviteToast({ name: 'Ana' }, { name: 'Night run' }, function () {}, function () {});
    c.A.ui.toast('plain announcement', 'info');
    const invite = box.querySelector('.toast-invite');
    const plain = Array.from(box.querySelectorAll('.toast')).find((t) => !t.classList.contains('toast-invite'));
    H.ok('case g setup: an invite toast and a plain toast are on screen before the gate opens', !!invite && !!plain);
    c.A.ui.showAuth(function () {});
    await tick(0);
    H.ok('case g: a .toast-invite already on screen is inert while a gate is up', invite.hasAttribute('inert'));
    H.ok('case g: a plain toast is NOT inert while a gate is up (aria-live must still reach AT)', !plain.hasAttribute('inert'));

    let declined = false, accepted = false;
    c.A.ui.inviteToast({ name: 'Ben' }, { name: 'Coast loop' }, function () { accepted = true; }, function () { declined = true; });
    H.ok('case i: inviteToast() while a gate is up creates no toast node',
      box.querySelectorAll('.toast-invite').length === 1, 'found ' + box.querySelectorAll('.toast-invite').length);
    H.ok('case i: inviteToast() while a gate is up calls onDecline at once (and never onAccept)', declined && !accepted);
    const before = box.querySelectorAll('.toast').length;
    c.A.ui.toast('still announced', 'info');
    H.ok('case i: a plain toast() while a gate is up is still created', box.querySelectorAll('.toast').length === before + 1);

    c.A.ui.closeOverlay();
    H.ok('case h: the invite toast is no longer inert the moment the gate closes', !invite.hasAttribute('inert'));
    await tick(400); // the 380ms hide timer has run: #onboarding is hidden, nothing is gating
    let declinedLate = false;
    c.A.ui.inviteToast({ name: 'Cy' }, { name: 'Dawn patrol' }, function () {}, function () { declinedLate = true; });
    H.ok('case h: an invite arriving after the gate closed is shown normally, not auto-declined',
      box.querySelectorAll('.toast-invite').length === 2 && !declinedLate);
  }

  // j: openOverlay's own {dismissable:false} path is a gate too; a dismissable card is not.
  // Also pins the chained shape (dismissable → non-dismissable with no close between,
  // showRegenRecovery's success card): the invite that arrived under the first card must
  // be re-scanned by the second open, even though the shell trap itself is a no-op then.
  {
    const c = fresh();
    const box = c.doc.getElementById('toasts');
    c.open();
    let declined = false;
    c.A.ui.inviteToast({ name: 'Ana' }, { name: 'Night run' }, function () {}, function () { declined = true; });
    const invite = box.querySelector('.toast-invite');
    H.ok('case j: an invite arriving under a dismissable card is shown and live (a card is not a gate)',
      !!invite && !invite.hasAttribute('inert') && !declined);
    c.open({ dismissable: false });
    H.ok('case j: a chained {dismissable:false} card inerts the invite that arrived under the dismissable one',
      invite.hasAttribute('inert'));
    let declined2 = false;
    c.A.ui.inviteToast({ name: 'Ben' }, { name: 'Coast loop' }, function () {}, function () { declined2 = true; });
    H.ok('case j: a new invite under the {dismissable:false} card is declined, not shown',
      declined2 && box.querySelectorAll('.toast-invite').length === 1);
    c.close();
    H.ok('case j: closeOverlay() un-inerts the invite toast', !invite.hasAttribute('inert'));
  }
}

/* ---------------- 0. baseline ratchet guard: a stage may only LOWER the
   committed caps by fixing a real issue, never raise one to make a red run
   green. Compares the working-tree baseline file against the version last
   committed to HEAD (new keys — e.g. a surface split into two — are allowed). ---------------- */
function testBaselineRatchet() {
  H.group('test/frontend-baseline.json — committed values are a ceiling, never raised');
  let committed;
  try {
    const out = execFileSync('git', ['show', 'HEAD:test/frontend-baseline.json'], { cwd: ROOT, encoding: 'utf8' });
    committed = JSON.parse(out);
  } catch (e) {
    H.ok('baseline ratchet check skipped (git or committed baseline unavailable)', true, e.message);
    return;
  }
  for (const key of Object.keys(committed)) {
    if (typeof committed[key] !== 'number') continue; // e.g. _comment — not a ratcheted metric
    if (!(key in baseline)) continue; // a key may be retired, never silently reappear higher
    H.ok('baseline["' + key + '"] (' + baseline[key] + ') not raised above the committed value (' + committed[key] + ')',
      baseline[key] <= committed[key],
      'a stage may only LOWER this by fixing a real issue, never raise it to turn a red run green');
  }
}

/* ---------------- 3. themes still parse after any CSS/token edit ---------------- */
function testThemes() {
  H.group('js/themes.js — every registered theme still injects a parseable block');
  const dom = buildWindow();
  const win = dom.window;
  installAsGlobals(win);
  const A = loadModules(win);
  if (!A.themes || !A.themes.list) {
    H.ok('A.themes.list() exists', false, 'themes.js did not expose list()');
    return;
  }
  const list = A.themes.list();
  H.ok('at least one theme registered', list.length > 0, 'got ' + list.length);
  list.forEach((t) => {
    let threw = null;
    try { A.themes.apply(t.id || t); } catch (e) { threw = e.message; }
    H.ok('theme "' + (t.id || t) + '" applies without throwing', !threw, threw);
  });
}

/* ---------------- 4. ?v= stamp discipline ---------------- */
function testStamps() {
  H.group('index.html — release stamps are all identical (pack-ota.js requirement)');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const stamps = html.match(/\?v=cy\d+/g) || [];
  const unique = new Set(stamps);
  H.ok('at least one stamped asset', stamps.length > 0, 'found ' + stamps.length);
  H.ok('every ?v= stamp is identical', unique.size === 1, 'found: ' + Array.from(unique).join(', '));
}

/* ---------------- 4b. typography floor (source text, not computed style) ---------------- */
// Functional text below 12px fails legibility in a windscreen-mounted HUD.
// Any exception needs a one-line justification here, not a silent lowering.
var FONT_SIZE_FLOOR_EXCEPTIONS = {
  // '.rd-limit span': 'US speed-limit-sign caption; 12px overflows the 46px badge',
};

function testFontSizeFloor() {
  H.group('css/styles.css — no functional text below a 12px floor (source-text check)');
  // Source-text, not computed-style: this is the only gate that covers the
  // ~61 font-size rules on JS-built panels the detector never renders (it
  // only sees index.html's static markup), vs. the 15 it can see.
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  const matches = css.match(/font-size:\s*[0-9.]+px/g) || [];
  const offenders = matches.filter((m) => {
    const px = parseFloat(m.match(/[0-9.]+/)[0]);
    return px < 12;
  });
  H.ok('at least one font-size declaration found (sanity check)', matches.length > 0,
    'found ' + matches.length);
  H.ok('no font-size below 12px outside the documented exception list (' + offenders.length + ' found)',
    offenders.length === Object.keys(FONT_SIZE_FLOOR_EXCEPTIONS).length,
    'offending declarations: ' + offenders.join(', '));
}

/* ---------------- 5. impeccable design-integrity detector ---------------- */
function testDetector() {
  H.group('impeccable detector — design-integrity antipatterns');
  const detectScript = '/opt/data/skills/creative/impeccable/scripts/detect.mjs';
  if (!fs.existsSync(detectScript)) {
    H.ok('detector script present', false, 'not found at ' + detectScript + ' — skipping gate');
    return;
  }
  let out;
  try {
    out = execFileSync('node', [detectScript, '--json', 'index.html', 'css/styles.css', 'js/ui.js'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    // detect.mjs exits non-zero when it finds antipatterns; stdout still has the JSON.
    out = e.stdout || '';
  }
  const count = (out.match(/"antipattern"/g) || []).length;
  atOrBelowBaseline('detector warnings', 'detectorWarnings', count);
}

(async () => {
  testBaselineRatchet();
  await testShell();
  testDocumentStructure();
  await testSurfaces();
  testGeneratedIdsUnique();
  testClosedPanelsInert();
  await testModalFocusTrap();
  await testShellRestoreInvariant();
  testThemes();
  testStamps();
  testFontSizeFloor();
  testDetector();
  console.log('\nMeasured counts (compare against test/frontend-baseline.json):');
  console.log(JSON.stringify(measured, null, 2));
  process.exit(H.report());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
