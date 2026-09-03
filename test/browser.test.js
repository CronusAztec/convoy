/* Convoy — real-browser smoke test: the shell is clickable again after chained modals (ui-003b).
   `npm test` (test/run.js). SKIPs with exit 0 when no headless Chromium is on this machine.

   Why a browser at all: jsdom neither hit-tests nor implements `inert`, so a stuck-inert
   shell — cycle 4's setShellInert bug, every body child left inert after openOverlay →
   openOverlay → closeOverlay, map/dock/topbar dead to mouse AND keyboard until reload —
   is visible to test/frontend.test.js only as an attribute. This suite asks the one
   question only a browser can answer: does a click over the dock still reach the dock?

   No library and no npm dependency: the chrome-headless-shell binary Playwright dropped
   under ~/.cache/ms-playwright (STATE.md "Headless Chromium — working recipe") is driven
   with --dump-dom over a file:// fixture built from the real index.html, and the in-page
   probe writes its result into a <pre> that is parsed back out. Do not add playwright to
   package.json for this; do not make the suite fail when the binary is simply absent. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./harness');

const ROOT = H.ROOT;

/* ~/.cache/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell
   (rev 1234 on this box, 2026-09-03). Newest revision wins; CONVOY_CHROMIUM overrides. */
function findChromium() {
  const override = process.env.CONVOY_CHROMIUM;
  if (override) return fs.existsSync(override) ? override : null;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  const revs = fs.readdirSync(base).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse();
  for (const d of revs) {
    const bin = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

const BIN = findChromium();
if (!BIN) {
  console.log('SKIP test/browser.test.js — no headless Chromium under ~/.cache/ms-playwright/chromium_headless_shell-*/ ' +
    '(STATE.md "Headless Chromium — working recipe"); nothing asserted, exit 0.');
  process.exit(0);
}

/* Runs inside the fixture page after every module has loaded. Same chained shape the
   race lobby and block→report produce; the hit-test is document.elementFromPoint over
   the centre of #dock, which an inert (or covered) dock cannot receive. */
const PROBE = `
(function () {
  var out = {};
  function hit(sel) {
    var el = document.querySelector(sel);
    if (!el) return { target: null, inside: false, missing: sel };
    var r = el.getBoundingClientRect();
    var t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { target: t ? t.tagName + (t.id ? '#' + t.id : '') : null, inside: !!(t && el.contains(t)),
      rect: [r.left, r.top, r.width, r.height].map(Math.round) };
  }
  function card() {
    var d = document.createElement('div'); d.className = 'modal-card';
    var b = document.createElement('button'); b.textContent = 'ok'; d.appendChild(b);
    return d;
  }
  function stray() {
    return [].filter.call(document.body.children, function (el) {
      return el.hasAttribute('inert') && !el.classList.contains('panel');
    }).map(function (el) { return el.id || el.tagName; });
  }
  function done() { document.getElementById('probe-result').textContent = JSON.stringify(out); }
  try {
    var A = window.App;
    A.ui.wireDock();
    out.before = hit('#dock');
    A.ui.openOverlayRaw(card());
    A.ui.openOverlayRaw(card());
    out.during = hit('#dock');
    out.duringStray = stray().length;
    A.ui.closeOverlay();
    setTimeout(function () {
      out.after = hit('#dock');
      out.afterStray = stray();
      done();
    }, 500);
  } catch (e) { out.error = String((e && e.stack) || e); done(); }
})();
`;

function buildFixture() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const fileRoot = 'file://' + ROOT + '/';
  // A file:// page has an opaque origin, so the page's own CSP 'self' would block its own
  // scripts and stylesheet. The policy is not under test here (test/serverpolicy.test.js is).
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
  // Nothing external: font/CDN links would hold the load event open on a box without network.
  html = html.replace(/<link[^>]+href="https?:\/\/[^"]*"[^>]*>\s*/gi, '');
  html = html.replace(/href="css\/([^"?]+)(\?[^"]*)?"/g, (m, f) => 'href="' + fileRoot + 'css/' + f + '"');
  // The page's own module order, minus the MapLibre CDN script and app.js (whose
  // DOMContentLoaded wiring assumes a live map/socket/GPS) — the same subset
  // test/frontend.test.js loads, read from index.html rather than duplicated.
  const scripts = [];
  html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>\s*/g, (m, src) => {
    const f = src.replace(/\?.*$/, '');
    if (/^js\//.test(f) && f !== 'js/app.js') scripts.push(f);
    return '';
  });
  html = html.replace('</body>',
    scripts.map((f) => '<script src="' + fileRoot + f + '"></script>').join('\n') +
    '\n<pre id="probe-result" hidden></pre>\n<script>' + PROBE + '</script>\n</body>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-browser-'));
  const file = path.join(dir, 'fixture.html');
  fs.writeFileSync(file, html);
  return { dir, file, scripts: scripts.length };
}

function runChromium(file) {
  return execFileSync(BIN, [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=390,844', '--virtual-time-budget=1500', '--dump-dom', 'file://' + file
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
}

function parseProbe(dom) {
  const m = dom.match(/<pre id="probe-result"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m || !m[1].trim()) return null;
  return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

H.group('real browser (chrome-headless-shell) — the shell is clickable again after chained modals (ui-003b)');
console.log('  binary: ' + BIN);
const fx = buildFixture();
let res = null;
let failure = null;
try { res = parseProbe(runChromium(fx.file)); }
catch (e) { failure = e.message; }
finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }

H.ok('the fixture (' + fx.scripts + ' module scripts from index.html) ran and the probe reported back',
  !!res && !res.error, failure || (res && res.error) || 'no probe output in the dumped DOM');
if (res && !res.error) {
  H.ok('control: before any modal, a hit-test over #dock lands inside #dock', res.before.inside, JSON.stringify(res.before));
  H.ok('control: with two chained cards open, the same hit-test does NOT reach #dock (the modal covers it)',
    !res.during.inside, JSON.stringify(res.during));
  H.ok('after openOverlayRaw ×2 → closeOverlay(): the hit-test over #dock lands inside #dock again (the shell is clickable)',
    res.after.inside, JSON.stringify(res.after));
  H.ok('after close: no body child carries [inert] except closed panels', res.afterStray.length === 0,
    'stray: ' + res.afterStray.join(', '));
}
process.exit(H.report());
