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

  const surfaces = [
    ['nearby', 'nearby panel', () => A.ui.openPanel('nearby')],
    ['convoy', 'convoy panel', () => A.ui.openPanel('convoy')],
    ['profile', 'profile panel', () => A.ui.openPanel('profile')],
    ['auth', 'auth screen', () => A.ui.showAuth && A.ui.showAuth('login')]
  ];

  for (const [key, label, open] of surfaces) {
    try {
      open();
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
  await testShell();
  await testSurfaces();
  testThemes();
  testStamps();
  testDetector();
  console.log('\nMeasured counts (compare against test/frontend-baseline.json):');
  console.log(JSON.stringify(measured, null, 2));
  process.exit(H.report());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
