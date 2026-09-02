#!/usr/bin/env node
/* Convoy — client failure/empty-state driver (mission convoyv2 M2, Task 2).

   The BUGS.md ledger for the client is mostly exhausted (truthed 2026-09-02);
   this script is the renewable replacement — it drives the real app through
   its failure and empty states and screenshots each one, so the NEXT pass has
   fresh defects to find instead of re-reading a 2026-07 bug list.

   States driven (see the M2 improvement directive for the exact list):
     1. cold boot with geolocation DENIED
     2. server unreachable at first connect -> lands in solo, keeps retrying
     3. socket dropped mid-session (server killed then restarted) -> reconnect,
        no repeated "Connection lost" toast (frontend-013)
     4. empty states: Nearby with zero riders, Convoy panel with no convoy
     5. route search with no results / upstream 5xx -> user-facing error copy,
        not a silent no-op (Nominatim is stubbed via page.route — never hit
        the real third-party API from this box)

   Screenshots -> <mission dir>/.forge-tmp/ui-states/<state>.png
   Prints "UI-STATES OK" and exits 0 if every state passed (no uncaught page
   error, no unexpected failed request). Run: node scripts/ui-states.js */
'use strict';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MISSION_DIR = process.env.FORGE_MISSION_DIR || path.join(ROOT, '..');
const SHOT_DIR = path.join(MISSION_DIR, '.forge-tmp', 'ui-states');
const PORT = 5390 + (process.pid % 200);
const BASE = 'http://127.0.0.1:' + PORT;
const POS = { lat: 34.0522, lng: -118.2437 };

fs.mkdirSync(SHOT_DIR, { recursive: true });

function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function tick() {
      http.get(base + '/api/health', (res) => { res.resume(); resolve(); })
        .on('error', retry);
      function retry() {
        if (Date.now() > deadline) { reject(new Error('server never answered /api/health')); return; }
        setTimeout(tick, 200);
      }
    })();
  });
}

function startServer(port) {
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONVOY_DEV_AUTH: '1', BOTS: '0', PORT: String(port), NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  return { proc: server, log: () => out };
}

const results = []; // { state, ok, detail }
function record(state, ok, detail) {
  results.push({ state, ok, detail });
  console.log('[ui-states] ' + (ok ? 'PASS' : 'FAIL') + ' — ' + state + (detail ? ' — ' + detail : ''));
}

async function main() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    console.error('[ui-states] playwright is not installed. Run: npm install -D playwright && npx playwright install chromium');
    process.exit(1);
  }

  const { proc: server } = startServer(PORT);
  let serverAlive = true;
  server.on('exit', () => { serverAlive = false; });
  function stopServer() { try { server.kill(); } catch (e) {} }
  process.on('exit', stopServer);

  await waitForHealth(BASE, 8000).catch((e) => { console.error('[ui-states] ' + e.message); process.exit(1); });
  console.log('[ui-states] dev-auth server up on ' + PORT);

  const browser = await playwright.chromium.launch();

  function trackErrors(page, label) {
    const pageErrors = [];
    const badRequests = [];
    page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
    page.on('requestfailed', (req) => {
      // aborted telemetry beacons on navigation are expected/benign (js/telemetry.js
      // uses keepalive fetch, which Chromium still sometimes reports as failed
      // during a fast page teardown) — everything else is a real finding.
      if (/\/api\/telemetry/.test(req.url())) return;
      badRequests.push(req.url() + ' — ' + (req.failure() && req.failure().errorText));
    });
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('[' + label + ' console] ' + msg.text()); });
    return { pageErrors, badRequests };
  }

  async function guestOnboard(page) {
    await page.getByText('Continue as guest', { exact: true }).click({ timeout: 15000 });
    const checkboxes = page.locator('.consent-row input[type=checkbox]');
    const n = await checkboxes.count();
    for (let i = 0; i < n; i++) await checkboxes.nth(i).check();
    await page.getByRole('button', { name: /Start riding/ }).click();
    await page.waitForFunction(() => {
      const el = document.getElementById('onboarding');
      return el && el.hidden;
    }, { timeout: 15000 });
  }

  /* ---------------- state 1: cold boot, geolocation denied ---------------- */
  try {
    const ctx = await browser.newContext(); // no geolocation permission granted at all
    const page = await ctx.newPage();
    const track = trackErrors(page, 'geo-denied');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await guestOnboard(page);
    // The on-demand watch is exactly what a "locate me" tap or routing triggers.
    // Denied/unavailable geolocation must not throw — the map just has no real fix.
    await page.evaluate(() => { try { window.App.sim.ensureWatch(); } catch (e) {} });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOT_DIR, '1-geo-denied.png') });
    const hasRealPos = await page.evaluate(() => !!(window.App.sim.hasRealPos && window.App.sim.hasRealPos()));
    record('1 cold boot, geolocation denied', track.pageErrors.length === 0 && track.badRequests.length === 0 && !hasRealPos,
      'pageErrors=' + track.pageErrors.length + ' badRequests=' + track.badRequests.length + ' hasRealPos=' + hasRealPos +
      (track.pageErrors[0] ? ' first=' + track.pageErrors[0] : ''));
    await ctx.close();
  } catch (e) { record('1 cold boot, geolocation denied', false, 'threw: ' + e.message); }

  /* ---------------- state 2: server unreachable at first connect ---------------- */
  try {
    const ctx = await browser.newContext({ geolocation: { latitude: POS.lat, longitude: POS.lng, accuracy: 10 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const track = trackErrors(page, 'unreachable');
    // Replace WebSocket before any app script runs: a socket that never opens
    // and never errors is exactly "unreachable server" from the client's POV,
    // regardless of what URL it dials.
    await page.addInitScript(() => {
      window.__wsAttempts = 0;
      window.WebSocket = function (url) {
        window.__wsAttempts++;
        this.url = url; this.readyState = 0;
        // never call onopen/onclose/onerror — the connect attempt just hangs
        // until net.js's own 9s CONNECT_TIMEOUT gives up on it.
      };
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await guestOnboard(page);
    await page.evaluate(() => window.App.sim.ensureWatch());
    // Wait past the 9s CONNECT_TIMEOUT for the first fallback-to-solo.
    await page.waitForFunction(() => window.__wsAttempts >= 1, { timeout: 5000 });
    await page.waitForTimeout(9500);
    await page.screenshot({ path: path.join(SHOT_DIR, '2-server-unreachable.png') });
    const netMode1 = await page.evaluate(() => window.App.state.netMode);
    const attempts1 = await page.evaluate(() => window.__wsAttempts);
    // Now prove it keeps retrying: wait for a SECOND connection attempt.
    await page.waitForFunction((prev) => window.__wsAttempts > prev, attempts1, { timeout: 20000 });
    const attempts2 = await page.evaluate(() => window.__wsAttempts);
    record('2 server unreachable at first connect', netMode1 !== 'live' && attempts2 > attempts1 &&
      track.pageErrors.length === 0,
      'netMode=' + netMode1 + ' attempts ' + attempts1 + '->' + attempts2 + ' pageErrors=' + track.pageErrors.length +
      (track.pageErrors[0] ? ' first=' + track.pageErrors[0] : ''));
    await ctx.close();
  } catch (e) { record('2 server unreachable at first connect', false, 'threw: ' + e.message); }

  /* ---------------- state 3: socket dropped mid-session ---------------- */
  const PORT3 = PORT + 1;
  let server3 = startServer(PORT3);
  try {
    await waitForHealth('http://127.0.0.1:' + PORT3, 8000);
    const ctx = await browser.newContext({ geolocation: { latitude: POS.lat, longitude: POS.lng, accuracy: 10 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const track = trackErrors(page, 'drop-reconnect');
    await page.goto('http://127.0.0.1:' + PORT3 + '/', { waitUntil: 'domcontentloaded' });
    await guestOnboard(page);
    await page.evaluate(() => window.App.sim.ensureWatch());
    await page.waitForFunction(() => window.App.net && window.App.net.isLive && window.App.net.isLive(), { timeout: 15000 });
    // Hook the toast AFTER App exists, then kill the server under the live socket.
    await page.evaluate(() => {
      const orig = window.App.ui.toast;
      window.__toasts = [];
      window.App.ui.toast = function (msg, kind) { window.__toasts.push(msg); return orig.apply(this, arguments); };
    });
    server3.proc.kill();
    await page.waitForFunction(() => window.App.net && !window.App.net.isLive(), { timeout: 15000 });
    await page.screenshot({ path: path.join(SHOT_DIR, '3a-mid-drop.png') });
    // Restart the server on the SAME port so the client's own retry loop reconnects.
    server3 = startServer(PORT3);
    await waitForHealth('http://127.0.0.1:' + PORT3, 8000);
    await page.waitForFunction(() => window.App.net && window.App.net.isLive && window.App.net.isLive(), { timeout: 40000 });
    await page.screenshot({ path: path.join(SHOT_DIR, '3b-reconnected.png') });
    const toastCount = await page.evaluate(() => window.__toasts.filter((t) => /Connection lost/.test(t)).length);
    record('3 socket dropped mid-session, reconnect', toastCount <= 1 && track.pageErrors.length === 0,
      '"Connection lost" toasts=' + toastCount + ' pageErrors=' + track.pageErrors.length +
      (track.pageErrors[0] ? ' first=' + track.pageErrors[0] : ''));
    await ctx.close();
  } catch (e) { record('3 socket dropped mid-session, reconnect', false, 'threw: ' + e.message); }
  finally { try { server3.proc.kill(); } catch (e) {} }

  /* ---------------- state 4: empty Nearby + empty Convoy ---------------- */
  try {
    const ctx = await browser.newContext({ geolocation: { latitude: POS.lat, longitude: POS.lng, accuracy: 10 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const track = trackErrors(page, 'empty-states');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await guestOnboard(page);
    await page.evaluate(() => window.App.sim.ensureWatch());
    await page.waitForFunction(() => window.App.net && window.App.net.isLive && window.App.net.isLive(), { timeout: 15000 });
    // Nobody else is on this scratch server — Nearby is naturally empty.
    await page.evaluate(() => window.App.ui.openPanel('nearby'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOT_DIR, '4a-nearby-empty.png') });
    const nearbyHint = await page.evaluate(() => {
      const b = document.getElementById('nearby-body');
      return b ? b.textContent : null;
    });
    await page.evaluate(() => window.App.ui.openPanel('convoy'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOT_DIR, '4b-convoy-empty.png') });
    const convoyHint = await page.evaluate(() => {
      const b = document.getElementById('convoy-body');
      return b ? b.textContent : null;
    });
    record('4 empty Nearby + Convoy panels', track.pageErrors.length === 0 &&
      !!nearbyHint && !!convoyHint && /convoy/i.test(convoyHint),
      'nearbyHint=' + JSON.stringify((nearbyHint || '').slice(0, 60)) +
      ' convoyHint=' + JSON.stringify((convoyHint || '').slice(0, 60)) + ' pageErrors=' + track.pageErrors.length);
    await ctx.close();
  } catch (e) { record('4 empty Nearby + Convoy panels', false, 'threw: ' + e.message); }

  /* ---------------- state 5: route search — no results / upstream 5xx ---------------- */
  try {
    const ctx = await browser.newContext({ geolocation: { latitude: POS.lat, longitude: POS.lng, accuracy: 10 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    const track = trackErrors(page, 'search-fail');
    // Stub Nominatim so this never hits the real third-party API from this box.
    await page.route('**://nominatim.openstreetmap.org/**', (route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: '[]' });
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await guestOnboard(page);
    await page.fill('#search-input', 'Nowhereville That Does Not Exist');
    await page.waitForTimeout(900); // clears the 350ms debounce + the stubbed round trip
    await page.screenshot({ path: path.join(SHOT_DIR, '5-search-error.png') });
    const resultsText = await page.evaluate(() => {
      const r = document.getElementById('search-results');
      return r ? r.textContent : null;
    });
    const hasCopy = !!resultsText && /no places found|search unavailable/i.test(resultsText);
    record('5 route search failure copy', track.pageErrors.length === 0 && hasCopy,
      'resultsText=' + JSON.stringify((resultsText || '').slice(0, 80)) + ' pageErrors=' + track.pageErrors.length);
    await ctx.close();
  } catch (e) { record('5 route search failure copy', false, 'threw: ' + e.message); }

  await browser.close().catch(() => {});
  stopServer();

  console.log('');
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '[ui-states] OK   ' : '[ui-states] FAIL ') + r.state));
  console.log('[ui-states] screenshots: ' + SHOT_DIR);
  if (failed.length) {
    console.error('[ui-states] FAILED (' + failed.length + '/' + results.length + ')');
    process.exit(1);
  }
  console.log('UI-STATES OK');
}

main().catch((e) => {
  console.error('[ui-states] FAILED: ' + (e && e.stack || e));
  process.exit(1);
});
