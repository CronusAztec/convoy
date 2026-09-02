#!/usr/bin/env node
/* Convoy — two-client Nearby Voice smoke test.

   Boots a local dev server (CONVOY_DEV_AUTH=1, no Supabase needed), opens two
   headless Chromium pages with fake media devices and fake geolocation ~300 m
   apart, takes each through the guest onboarding flow, turns on "Auto voice
   chat" (radius mode) on both, and asserts they link: each side's
   A.voice.getProxMode() reports 'radius' and each side ends up with the other
   in A.sim.proximityIds('radius') — the same set voice.js uses to decide who
   to call. Prints "SMOKE OK" and exits 0 on success, otherwise exits 1 with a
   description of what didn't happen.

   Run: node scripts/smoke.js   (installs its own devDependency: playwright) */
'use strict';

// This box's global PLAYWRIGHT_BROWSERS_PATH points at a root-owned, read-only
// cache with no full Chromium (only chrome-headless-shell, which lacks the
// fake-media flags this test needs). "0" makes Playwright use its own
// node_modules/playwright-core/.local-browsers instead, which `npx playwright
// install chromium` (run once, see README) can actually write to.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 5187 + (process.pid % 200); // avoid colliding with a stray leftover server
const BASE = 'http://127.0.0.1:' + PORT;

// Two points ~300 m apart (north-south along a meridian; 0.0027 deg lat ~ 300 m).
const POS_A = { lat: 34.0522, lng: -118.2437 };
const POS_B = { lat: 34.0549, lng: -118.2437 };

function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function tick() {
      http.get(BASE + '/api/health', (res) => {
        if (res.statusCode === 200) { res.resume(); resolve(); return; }
        res.resume();
        retry();
      }).on('error', retry);
      function retry() {
        if (Date.now() > deadline) { reject(new Error('server never answered /api/health')); return; }
        setTimeout(tick, 200);
      }
    })();
  });
}

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.error('[smoke] playwright is not installed. Run: npm install -D playwright && npx playwright install chromium');
    process.exit(1);
  }

  console.log('[smoke] starting dev server on port ' + PORT + ' (CONVOY_DEV_AUTH=1, BOTS=0)…');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONVOY_DEV_AUTH: '1', BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  let exitedEarly = false;
  server.on('exit', (code) => {
    if (!finished) { exitedEarly = true; console.error('[smoke] server exited early (code ' + code + '):\n' + serverOut); }
  });
  let finished = false;

  function stopServer() { finished = true; try { server.kill(); } catch (e) { /* already gone */ } }

  try {
    await waitForHealth(8000);
  } catch (e) {
    stopServer();
    console.error('[smoke] FAILED: ' + e.message + '\n' + serverOut);
    process.exit(1);
  }
  console.log('[smoke] server is up.');

  const browser = await playwright.chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });

  async function makeRider(label, geo) {
    const ctx = await browser.newContext({
      permissions: ['geolocation', 'microphone'],
      geolocation: { latitude: geo.lat, longitude: geo.lng, accuracy: 10 }
    });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[' + label + ' console] ' + msg.text());
    });
    page.on('pageerror', (err) => console.log('[' + label + ' pageerror] ' + err.message));
    page.on('requestfailed', (req) => console.log('[' + label + ' requestfailed] ' + req.url() + ' — ' + (req.failure() && req.failure().errorText)));
    page.on('response', (res) => { if (res.status() >= 400) console.log('[' + label + ' http ' + res.status() + '] ' + res.url()); });
    page.on('websocket', (ws) => {
      console.log('[' + label + ' ws] opening ' + ws.url());
      ws.on('close', () => console.log('[' + label + ' ws] closed'));
      ws.on('socketerror', (e) => console.log('[' + label + ' ws error] ' + e));
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    async function step(name, fn) {
      try { return await fn(); }
      catch (e) {
        console.error('[' + label + '] step failed: ' + name + ' — ' + e.message);
        throw e;
      }
    }

    // Guest onboarding: welcome -> guest form -> three consents -> start riding.
    await step('click Continue as guest', () =>
      page.getByText('Continue as guest', { exact: true }).click({ timeout: 15000 }));
    const checkboxes = page.locator('.consent-row input[type=checkbox]');
    await step('check consent boxes', async () => {
      const n = await checkboxes.count();
      for (let i = 0; i < n; i++) await checkboxes.nth(i).check();
    });
    await step('click Start riding', () =>
      page.getByRole('button', { name: /Start riding/ }).click());

    // enterApp() hides the onboarding overlay and boots App (net.connect(), sim.start()).
    await step('onboarding closes', () => page.waitForFunction(() => {
      const el = document.getElementById('onboarding');
      return el && el.hidden;
    }, { timeout: 15000 }));

    // The GPS watch only starts on demand (a "locate me" tap, or routing on
    // native) — kick it off directly, exactly what that on-demand path does.
    await page.evaluate(() => window.App.sim.ensureWatch());

    // Wait for a real GPS fix to reach the app (Playwright's fake geolocation
    // feeds navigator.geolocation.watchPosition, same as a real device) and for
    // the websocket to go live — voice proximity needs both.
    try {
      await step('sim has real pos + net is live', () => page.waitForFunction(() => {
        return window.App && window.App.sim && window.App.sim.hasRealPos && window.App.sim.hasRealPos() &&
          window.App.net && window.App.net.isLive && window.App.net.isLive();
      }, { timeout: 15000 }));
    } catch (e) {
      const diag = await page.evaluate(() => ({
        hasApp: !!window.App,
        hasRealPos: !!(window.App && window.App.sim && window.App.sim.hasRealPos && window.App.sim.hasRealPos()),
        isLive: !!(window.App && window.App.net && window.App.net.isLive && window.App.net.isLive()),
        playerPos: window.App && window.App.sim && window.App.sim.playerPos && window.App.sim.playerPos()
      }));
      console.log('[' + label + ' diag] ' + JSON.stringify(diag));
      throw e;
    }

    console.log('[smoke] ' + label + ' is live with a real GPS fix.');
    return { ctx, page };
  }

  let riderA, riderB;
  try {
    riderA = await makeRider('A', POS_A);
    riderB = await makeRider('B', POS_B);

    // Turn on Nearby Voice (radius mode) on both sides.
    await riderA.page.evaluate(() => window.App.voice.setProxMode('radius'));
    await riderB.page.evaluate(() => window.App.voice.setProxMode('radius'));

    // voice.js re-evaluates proximity every 3s (PROX_POLL_MS) and on every
    // 'rider:add' broadcast; give it a few polls' worth of headroom.
    async function seesOther(page) {
      return page.waitForFunction(() => {
        return window.App.sim.proximityIds('radius').length > 0;
      }, { timeout: 20000 });
    }
    await seesOther(riderA.page);
    await seesOther(riderB.page);

    const modeA = await riderA.page.evaluate(() => window.App.voice.getProxMode());
    const modeB = await riderB.page.evaluate(() => window.App.voice.getProxMode());
    if (modeA !== 'radius' || modeB !== 'radius') {
      throw new Error('proxMode did not stick: A=' + modeA + ' B=' + modeB);
    }

    const aSeesB = await riderA.page.evaluate(() => window.App.sim.proximityIds('radius').length);
    const bSeesA = await riderB.page.evaluate(() => window.App.sim.proximityIds('radius').length);
    if (!aSeesB || !bSeesA) {
      throw new Error('proximity sets empty: A sees ' + aSeesB + ', B sees ' + bSeesA);
    }

    console.log('[smoke] both riders see each other in radius (' + aSeesB + '/' + bSeesA + ').');
    console.log('SMOKE OK');
  } finally {
    if (riderA) await riderA.ctx.close().catch(() => {});
    if (riderB) await riderB.ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    stopServer();
  }
}

main().catch((e) => {
  console.error('[smoke] FAILED: ' + e.message);
  process.exit(1);
});
