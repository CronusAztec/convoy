/* Convoy — lab performance bench (aspect P-A, milestone P0a). `node test/perf-bench.js`.

   Answers "how expensive is a cold first load, and how expensive is sitting idle
   on the map shell" with real numbers from a real browser, so every later
   milestone in this aspect has a before/after instead of a guess (STATE.md
   guardrail 5: "no number, no claim").

   Recipe (STATE.md §5 P0a, the cycle-56 measurement that first produced the
   705 ms / 2-long-task baseline in HISTORY.md "C1 measured baseline"):
     - an in-process HTTP server on 127.0.0.1 (port 0 = OS-assigned) serves the
       real repo tree, so every asset is exactly what production would ship
       except for one HTML change (below);
     - on the '/' response only, the CSP <meta> is stripped and two inline
       scripts are spliced in — COUNTERS (wraps setInterval/setTimeout/
       requestAnimationFrame and observes 'longtask' entries) right after
       <head>, and PROBE (reads performance timing + the counters and writes
       JSON into a <pre id="__probe">) right before </body>. Nothing else
       differs from what index.html actually ships;
     - the chrome-headless-shell binary under ~/.cache/ms-playwright (same one
       test/browser.test.js drives) reads --host-resolver-rules just fine even
       though the full chrome-linux64/chrome binary hangs indefinitely on
       --dump-dom in this container regardless of flags (tried: about:blank,
       with/without --virtual-time-budget, with/without --host-resolver-rules —
       confirmed a container issue with the full binary, not this bench) —
       launched with --host-resolver-rules="MAP * 127.0.0.1, EXCLUDE localhost", so the six
       external origins in index.html (fonts.g*, cdn.jsdelivr.net, tile hosts)
       resolve back to our own server and 404/connection-refuse immediately —
       "same-origin only" without editing index.html;
     - --dump-dom --virtual-time-budget=<N> drives the page through navigation,
       resource loads, 'load', and the PROBE's own setTimeout entirely inside
       Chromium's virtual clock, then prints the final DOM once. Boot mode
       (no flags) still uses this path.
     - --idle does NOT use virtual time (cycle 17 fix). Under
       --virtual-time-budget there is no compositor driving BeginFrames, so
       requestAnimationFrame callbacks fire roughly once per 10 *virtual*
       seconds regardless of what the page does — a standalone probe proved
       this (one rAF fire in 10 virtual seconds on a page that does nothing
       but rAF-loop). That made every previous --idle number, including the
       ones behind T1.1's "bench confirmation pending" caveat, a false
       reading: the UNFIXED js/sim.js (re-arms rAF every frame, forever)
       measured *lower* (rafPerSec 0) than the FIXED one (0.03) because both
       were really measuring "how many virtual frames Chromium chose to
       produce", not the app's own behaviour. --idle now drives the page over
       a real-time Chrome DevTools Protocol session (raw WebSocket + fetch,
       both Node globals, no new dependency): spawn Chromium with
       --remote-debugging-port=0, read the assigned port from
       <profile-dir>/DevToolsActivePort, open a CDP WebSocket, Page.navigate,
       poll (host-side, real time) for window.__idleStarted, then sleep the
       real event loop for IDLE_WINDOW_MS and read the counters back with one
       Runtime.evaluate. A frame-production counter (window.__frames, counted
       through the ORIGINAL requestAnimationFrame captured before IDLE_COUNTERS
       wraps it, so counting frames never inflates the "armed" count) guards
       against the same failure mode ever passing silently again: if
       framesPerSec < 1 the run is real-time but still not rendering, and the
       bench reports `invalid` instead of a number.
     - CPU throttling (Emulation.setCPUThrottlingRate) is DevTools-protocol
       only — no CLI flag. Cycle 17 gave --idle a CDP session, so `--cpu N`
       now works for --idle (Emulation.setCPUThrottlingRate before
       Page.navigate). Boot mode still runs at the --dump-dom virtual-time
       path and has no CDP session, so `--cpu` is not wired there.

   No new dependency: http/fs/path/zlib/child_process are all Node built-ins,
   the same set test/browser.test.js uses. SKIPs with exit 0 (never fails
   `npm test`) when no ~/.cache/ms-playwright/chromium_headless_shell-<rev>/ is
   on the box, or when CONVOY_CHROMIUM points at a missing file — the exact same
   findChromium() as test/browser.test.js. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');
const H = require('./harness');

const ROOT = H.ROOT;
const FETCH_MAPLIBRE = process.argv.includes('--fetch-maplibre');

/* test/.cache/ — a gitignored, refillable local copy of the two MapLibre
   files index.html loads from jsdelivr, so `--idle` can boot a REAL map
   instead of crashing out of ~90% of js/app.js's boot chain the moment
   `maplibregl` 404s (see the header note above and the reviewer finding this
   fixes). Populated once via `--fetch-maplibre` (one fetch per file, never
   implicit, never retried — COMMON RULES #8, shared production IP); absent by
   default on a fresh checkout, which is fine — see startServer() below. */
const CACHE_DIR = path.join(ROOT, 'test', '.cache');
const MAPLIBRE_JS = 'maplibre-gl-5.24.0.min.js';
const MAPLIBRE_CSS = 'maplibre-gl-5.24.0.min.css';
const MAPLIBRE_CDN_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.js';
const MAPLIBRE_CDN_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.css';

async function fetchMaplibreCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const [url, name] of [[MAPLIBRE_CDN_JS, MAPLIBRE_JS], [MAPLIBRE_CDN_CSS, MAPLIBRE_CSS]]) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch failed (' + res.status + ') for ' + url);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(CACHE_DIR, name), buf);
    console.log(name + ': ' + buf.length + ' bytes cached');
  }
}

function mapLibreCachePaths() {
  const js = path.join(CACHE_DIR, MAPLIBRE_JS);
  const css = path.join(CACHE_DIR, MAPLIBRE_CSS);
  return (fs.existsSync(js) && fs.existsSync(css)) ? { js, css } : null;
}

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
if (!FETCH_MAPLIBRE && !BIN) {
  console.log('SKIP test/perf-bench.js — no headless Chromium under ~/.cache/ms-playwright/chromium_headless_shell-*/ ' +
    '(STATE.md "Headless Chromium — working recipe"); nothing measured, exit 0.');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

/* window.__lt/__iv/__to/__raf are cumulative counters from page-load, not
   deltas — fine for a one-shot boot measurement (COUNTERS below, used as-is
   in boot mode). --idle needs a different starting line: with a real MapLibre
   (mapLib:"local"), the whole boot chain (A.sim.start()'s rAF loop, HUD
   cards, …) only starts once js/mapview.js's init() resolves, which can be
   several seconds into the page's life — counting from page load would mix
   real boot cost into the "idle" number. idleCounters() below gates every
   counter behind window.__idleStarted, which flips true the moment
   A.telemetry.step('map_ready') is observed (monkey-patched on) or after a
   7 s fallback (1 s past js/mapview.js's own 6 s "boot must always continue"
   timeout) — whichever comes first. Same gate whether mapLib is local or
   absent: with it absent, js/mapview.js's init() rejects (Task 1's fix) and
   'map_ready' is never stepped, so idle counting always starts at the 7 s
   fallback there — a consistent, comparable cutoff either way. */
const COUNTERS = '<script>\n' +
  'window.__iv=0;window.__to=0;window.__raf=0;window.__lt=0;\n' +
  'var _si=window.setInterval;window.setInterval=function(){window.__iv++;return _si.apply(window,arguments)};\n' +
  'var _st=window.setTimeout;window.setTimeout=function(){window.__to++;return _st.apply(window,arguments)};\n' +
  'var _rq=window.requestAnimationFrame;window.requestAnimationFrame=function(){window.__raf++;return _rq.apply(window,arguments)};\n' +
  'try{new PerformanceObserver(function(l){window.__lt+=l.getEntries().length}).observe({type:"longtask",buffered:true})}catch(e){}\n' +
  '</script>';

const IDLE_COUNTERS = '<script>\n' +
  'window.__iv=0;window.__to=0;window.__raf=0;window.__lt=0;window.__frames=0;\n' +
  'window.__idleStarted=false;window.__mapReadyMs=null;\n' +
  'var _si=window.setInterval;window.setInterval=function(){if(window.__idleStarted)window.__iv++;return _si.apply(window,arguments)};\n' +
  'var _st=window.setTimeout;window.setTimeout=function(){if(window.__idleStarted)window.__to++;return _st.apply(window,arguments)};\n' +
  'var _rq=window.requestAnimationFrame;window.requestAnimationFrame=function(){if(window.__idleStarted)window.__raf++;return _rq.apply(window,arguments)};\n' +
  // Frame-production sanity guard (cycle 17): counts REAL compositor frames
  // through the un-wrapped native rAF, independent of window.__raf above, so
  // a run that never renders (see the --virtual-time-budget failure mode in
  // the header comment) can be told apart from one that genuinely idles.
  '(function f(){if(window.__idleStarted)window.__frames++;_rq(f)})();\n' +
  'try{new PerformanceObserver(function(l){if(window.__idleStarted)window.__lt+=l.getEntries().length}).observe({type:"longtask",buffered:true})}catch(e){}\n' +
  '(function(){\n' +
  '  var waited=0;\n' +
  '  function tryWrap(){\n' +
  '    if(window.App&&window.App.telemetry&&!window.App.telemetry.__benchWrapped){\n' +
  '      var orig=window.App.telemetry.step;\n' +
  '      window.App.telemetry.step=function(name){\n' +
  '        if(name==="map_ready"&&window.__mapReadyMs===null)window.__mapReadyMs=performance.now();\n' +
  '        return orig.apply(this,arguments);\n' +
  '      };\n' +
  '      window.App.telemetry.__benchWrapped=true;\n' +
  '    }\n' +
  '  }\n' +
  '  function poll(){\n' +
  '    tryWrap();\n' +
  '    waited+=50;\n' +
  '    if(window.__mapReadyMs!==null||waited>=7000){window.__idleStarted=true;return;}\n' +
  '    setTimeout(poll,50);\n' +
  '  }\n' +
  '  poll();\n' +
  '})();\n' +
  '</script>';

function probeScript(delayMs) {
  return '<script>\n' +
    'window.addEventListener("load",function(){setTimeout(function(){\n' +
    '  var nav=performance.getEntriesByType("navigation")[0]||{};\n' +
    '  var out={\n' +
    '    dcl:Math.round(nav.domContentLoadedEventEnd||0),\n' +
    '    load:Math.round(nav.loadEventEnd||0),\n' +
    '    longTasks:window.__lt||0,\n' +
    '    rafArmed:window.__raf||0,\n' +
    '    intervalsArmed:window.__iv||0,\n' +
    '    timeoutsArmed:window.__to||0,\n' +
    '    idle:false\n' +
    '  };\n' +
    '  var p=document.createElement("pre");p.id="__probe";p.hidden=true;p.textContent=JSON.stringify(out);\n' +
    '  document.body.appendChild(p);\n' +
    '},' + delayMs + ')});\n' +
    '</script>';
}

/* In-process server on an OS-assigned port. Every request is logged so the
   bench can report requests/gzipBytes/apiCalls without trusting the browser's
   own (CSP-stripped, non-production) Resource Timing entries for byte counts —
   we already have the real bytes on the way out. */
function startServer(delayMs, idle, mapLibLocal) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const isApi = p.startsWith('/api/');
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(ROOT, rel);
    let body = null;
    if (file.startsWith(ROOT + path.sep) || file === path.join(ROOT, 'index.html')) {
      try { if (fs.statSync(file).isFile()) body = fs.readFileSync(file); } catch (e) { /* 404 below */ }
    }
    if (!body) {
      requests.push({ url: p, status: 404, bytes: 0, gz: 0, api: isApi });
      res.writeHead(404);
      return res.end('nf');
    }
    if (p === '/') {
      let html = body.toString('utf8');
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
      html = html.replace('<head>', '<head>\n' + (idle ? IDLE_COUNTERS : COUNTERS));
      // Idle mode reads window state directly over CDP (runIdleCdp below), so
      // it needs no page-side <pre id="__probe"> writer — only boot mode still
      // dumps the DOM and needs one.
      if (!idle) html = html.replace('</body>', probeScript(delayMs) + '\n</body>');
      if (mapLibLocal) {
        html = html.replace(MAPLIBRE_CDN_JS, '/test/.cache/' + MAPLIBRE_JS);
        html = html.replace(MAPLIBRE_CDN_CSS, '/test/.cache/' + MAPLIBRE_CSS);
      }
      body = Buffer.from(html);
    }
    const gz = zlib.gzipSync(body, { level: 9 }).length;
    requests.push({ url: p, status: 200, bytes: body.length, gz, api: isApi });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

/* Async on purpose: execFileSync would block this process's single event loop
   for the whole navigation, which is exactly the loop that has to stay free to
   accept the in-process server's HTTP connections — a same-process deadlock
   that looks like a hung browser (chrome never gets a single request; the
   server's own request log stays empty) until execFileSync's timeout kills it. */
function runChromium(url, virtualTimeBudget) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, [
      '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
      '--window-size=390,844', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
      '--virtual-time-budget=' + virtualTimeBudget, '--dump-dom', url
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    // Kill timer derived from the caller's own budget (cycle 17: the old
    // hardcoded 30000 was briefly shorter than a 45000ms virtualTimeBudget a
    // now-removed --idle path used — a latent hazard, not the false-green bug
    // itself, which was virtual time producing no frames at all; see header).
    const killMs = Math.max(30000, virtualTimeBudget + 15000);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('chrome timed out after ' + killMs + 'ms')); }, killMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('chrome exited ' + code));
      resolve(out);
    });
  });
}

function parseProbe(dom) {
  const m = dom.match(/<pre id="__probe"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m || !m[1].trim()) return null;
  return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Real-time CDP session for --idle (cycle 17 — see header comment for why
   virtual time can't measure rendering at all). Spawned detached so
   closeCdp() can SIGKILL the whole process group: headless Chrome forks
   zygote/gpu/network/renderer children that a plain child.kill() on the
   parent PID alone leaves as orphans (confirmed on this box — three defunct
   chrome-headless children survived the old --idle path's runs). */
/* CONVOY_CDP_TIMEOUT_MS: how long a single CDP send() waits for a response before
   rejecting (cycle 18). 5s default is generous given the ~200ms round-trip cadence
   observed; overridable so task 3's fault-injection proof can force the timeout path
   without waiting 5s per run. */
const CDP_SEND_TIMEOUT_MS = Number(process.env.CONVOY_CDP_TIMEOUT_MS) || 5000;

// Last-resort net (cycle 18, coverage completed cycle 19): every openCdp() session is
// added to this set as soon as its child process is spawned — *before* the DevTools
// handshake even starts, not only after a full successful connection — so both a
// connect-phase failure (fail(), below) and a throw outside runIdleCdp()'s try/finally
// get their Chrome process tree and temp --user-data-dir reaped, either explicitly via
// closeCdp() or by the process.on('exit') net below. Cycle 18 only covered the
// post-connection path (a session already in this set); a connect-phase failure used to
// reject before ever being added, leaking a detached Chrome + a /tmp/cprof-cdp-* dir on
// every DevToolsActivePort/json-list/no-page-target failure (found by the cycle-18
// review, fixed here — see the CONVOY_CHROMIUM fault-injection test in package.json's
// perf-bench notes / the cycle-19 report).
const LIVE_CDP_SESSIONS = new Set();
process.on('exit', () => { for (const s of LIVE_CDP_SESSIONS) closeCdp(s); });

function openCdp(bin) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cprof-cdp-'));
    const child = spawn(bin, [
      '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
      '--window-size=390,844', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
      '--user-data-dir=' + dir, '--remote-debugging-port=0', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    // Tracked from the moment the child exists — not only once the handshake finishes —
    // so every fail() path below has a real session to hand to closeCdp().
    const session = { child, dir, ws: null, send: null };
    LIVE_CDP_SESSIONS.add(session);
    let settled = false;
    // fail() is a no-op after the session has resolved (settled=true) — this is
    // deliberate for the *connect* phase (retrying/erroring before we have a usable
    // session makes no sense once callers already hold one). Past that point,
    // ws.onclose/ws.onerror below are what surfaces a dead socket, by rejecting every
    // in-flight send() instead of silently doing nothing. Every connect-phase fail()
    // now tears the process/dir down itself via closeCdp() before rejecting.
    const fail = (e) => { if (!settled) { settled = true; closeCdp(session); reject(e); } };
    child.on('error', fail);
    (async () => {
      let port = null;
      for (let i = 0; i < 100 && !port; i++) {
        try {
          const first = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
          if (first) port = first;
        } catch (e) { /* not written yet */ }
        if (!port) await sleep(100);
      }
      if (!port) return fail(new Error('DevToolsActivePort never appeared within 10s'));
      let list;
      try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); }
      catch (e) { return fail(e); }
      const target = list.find((t) => t.type === 'page');
      if (!target) return fail(new Error('no page target in /json/list'));
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      session.ws = ws;
      const pending = new Map();
      let nextId = 0;
      const rejectAllPending = (err) => {
        for (const { reject: rej } of pending.values()) rej(err);
        pending.clear();
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
      };
      ws.onerror = () => { fail(new Error('CDP WebSocket error')); rejectAllPending(new Error('CDP WebSocket error')); };
      ws.onclose = () => rejectAllPending(new Error('CDP WebSocket closed with a send() still pending'));
      // Bounded the same as a CDP send() — an open that never fires would otherwise
      // suspend this IIFE forever while still holding the child process (review HIGH).
      let openTimer;
      const openTimeout = new Promise((_, rej) => {
        openTimer = setTimeout(() => rej(new Error('CDP WebSocket did not open within ' + CDP_SEND_TIMEOUT_MS + 'ms')), CDP_SEND_TIMEOUT_MS);
      });
      try {
        await Promise.race([new Promise((res) => { ws.onopen = res; }), openTimeout]);
      } catch (e) { return fail(e); } finally { clearTimeout(openTimer); }
      const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('CDP send timed out after ' + CDP_SEND_TIMEOUT_MS + 'ms: ' + method + ' (id ' + id + ')'));
          }
        }, CDP_SEND_TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); }
        });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
      session.send = send;
      if (!settled) {
        settled = true;
        resolve(session);
      }
    })();
  });
}

function closeCdp(session) {
  LIVE_CDP_SESSIONS.delete(session);
  try { if (session.ws) session.ws.close(); } catch (e) { /* already closed, or never opened */ }
  try { process.kill(-session.child.pid, 'SIGKILL'); } catch (e) { try { session.child.kill('SIGKILL'); } catch (e2) { /* already dead */ } }
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

/* Drives one --idle navigation in real time over CDP: navigate, poll
   window.__idleStarted host-side (map_ready or IDLE_COUNTERS' 7s fallback),
   sleep the real event loop for windowMs, then read every counter back with
   one Runtime.evaluate. cpuRate > 1 throttles via Emulation before
   navigation (task 4, --cpu). */
// Performance.getMetrics deltas (task 1, cycle 22): reads Chromium's own
// layout/style-recalc counters straddling the idle window, so T2.4b's
// containment claim ("fewer layouts on this app") is a number, not a guess.
// Degrade-never-throw (directive): any failure of Performance.enable or
// either getMetrics call leaves every new key null and perfDomain:false —
// it must never fail the run or the gate. metricsOf() tolerates both the
// bare {metrics:[...]} shape Performance.getMetrics actually returns through
// this file's already-unwrapped send() and a defensively-checked {result:
// {metrics:[...]}} shape, since this is the first caller in the file to use
// a CDP method whose result isn't itself named "result".
function metricsOf(m) {
  const arr = (m && Array.isArray(m.metrics)) ? m.metrics : (m && m.result && Array.isArray(m.result.metrics)) ? m.result.metrics : null;
  if (!arr) return null;
  const o = {};
  for (const entry of arr) o[entry.name] = entry.value;
  return o;
}

async function runIdleCdp(bin, url, windowMs, cpuRate) {
  const session = await openCdp(bin);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    if (cpuRate && cpuRate > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    let perfDomain = true;
    try { await session.send('Performance.enable'); } catch (e) { perfDomain = false; }
    await session.send('Page.navigate', { url });
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < 20000) {
      const r = await session.send('Runtime.evaluate', { expression: 'window.__idleStarted===true', returnByValue: true });
      if (r && r.result && r.result.value === true) { started = true; break; }
      await sleep(200);
    }
    if (!started) return { failure: 'window.__idleStarted never became true within 20s of real time' };

    let m0 = null;
    if (perfDomain) {
      try { m0 = metricsOf(await session.send('Performance.getMetrics')); if (!m0) perfDomain = false; } catch (e) { perfDomain = false; }
    }

    await sleep(windowMs);

    let m1 = null;
    if (perfDomain) {
      try { m1 = metricsOf(await session.send('Performance.getMetrics')); if (!m1) perfDomain = false; } catch (e) { perfDomain = false; }
    }

    const r = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify({longTasks:window.__lt||0,rafArmed:window.__raf||0,' +
        'intervalsArmed:window.__iv||0,timeoutsArmed:window.__to||0,frames:window.__frames||0,' +
        'mapReady:window.__mapReadyMs!==null,mapReadyMs:window.__mapReadyMs===null?null:Math.round(window.__mapReadyMs),' +
        'simStarted:!!(window.App&&window.App.sim)})',
      returnByValue: true
    });
    if (!r || !r.result || typeof r.result.value !== 'string') return { failure: 'CDP Runtime.evaluate returned no usable result' };
    const probe = JSON.parse(r.result.value);

    if (perfDomain && m0 && m1) {
      probe.perfDomain = true;
      probe.layoutCount = (m1.LayoutCount || 0) - (m0.LayoutCount || 0);
      probe.recalcStyleCount = (m1.RecalcStyleCount || 0) - (m0.RecalcStyleCount || 0);
      probe.layoutDurationMs = round2(((m1.LayoutDuration || 0) - (m0.LayoutDuration || 0)) * 1000);
      probe.recalcStyleDurationMs = round2(((m1.RecalcStyleDuration || 0) - (m0.RecalcStyleDuration || 0)) * 1000);
      probe.layoutObjects = Math.round(m1.LayoutObjects || 0);
      probe.nodes = Math.round(m1.Nodes || 0);
    } else {
      probe.perfDomain = false;
      probe.layoutCount = null;
      probe.recalcStyleCount = null;
      probe.layoutDurationMs = null;
      probe.recalcStyleDurationMs = null;
      probe.layoutObjects = null;
      probe.nodes = null;
    }
    return probe;
  } finally {
    closeCdp(session);
  }
}

const IDLE_WINDOW_MS = 30000;

/* One run: fresh server (so its request log starts empty) + one navigation.
   mapLib: null (cache cold, unchanged legacy behaviour) or the cache paths
   from mapLibreCachePaths() (splice in a real MapLibre, --idle only). */
async function oneRun(idle, mapLib, cpuRate) {
  const delayMs = idle ? IDLE_WINDOW_MS : 300;
  const virtualTimeBudget = idle ? 45000 : 1500; // boot mode only now; --idle no longer uses virtual time
  const { server, requests, port } = await startServer(delayMs, idle, !!mapLib);
  let probe = null;
  let failure = null;
  try {
    if (idle) {
      probe = await runIdleCdp(BIN, 'http://127.0.0.1:' + port + '/', IDLE_WINDOW_MS, cpuRate);
      if (probe && probe.failure) { failure = probe.failure; probe = null; }
    } else {
      probe = parseProbe(await runChromium('http://127.0.0.1:' + port + '/', virtualTimeBudget));
    }
  } catch (e) { failure = e.message; }
  finally { server.close(); }
  if (failure || !probe) return { failure: failure || 'no probe output' };

  // The C1 recipe's own log showed a duplicate '/' request (the navigation
  // plus a second internal fetch of the same document); dedupe it so
  // `requests` counts distinct assets, not the request-log's raw length.
  let seenRoot = false;
  const deduped = requests.filter((r) => {
    if (r.url === '/') { if (seenRoot) return false; seenRoot = true; }
    return true;
  });
  const assets = deduped.filter((r) => r.status === 200 && !r.api);
  const apiCalls = deduped.filter((r) => r.api).length;
  const gzipBytes = assets.reduce((s, r) => s + r.gz, 0);

  if (idle) {
    return {
      frames: probe.frames, rafArmed: probe.rafArmed, longTasks: probe.longTasks,
      mapReady: probe.mapReady === true, mapReadyMs: typeof probe.mapReadyMs === 'number' ? probe.mapReadyMs : null,
      simStarted: probe.simStarted === true,
      perfDomain: probe.perfDomain === true,
      layoutCount: probe.layoutCount, recalcStyleCount: probe.recalcStyleCount,
      layoutDurationMs: probe.layoutDurationMs, recalcStyleDurationMs: probe.recalcStyleDurationMs,
      layoutObjects: probe.layoutObjects, nodes: probe.nodes
    };
  }
  return {
    dcl: probe.dcl, load: probe.load, longTasks: probe.longTasks,
    requests: assets.length, gzipBytes, apiCalls,
    rafArmed: probe.rafArmed, intervalsArmed: probe.intervalsArmed, timeoutsArmed: probe.timeoutsArmed,
    mapReady: probe.mapReady === true, mapReadyMs: typeof probe.mapReadyMs === 'number' ? probe.mapReadyMs : null
  };
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function medianOf(runs, key) {
  return median(runs.map((r) => r[key]));
}

function round2(n) { return Math.round(n * 100) / 100; }

async function bench(idle, runCount, mapLib, cpuRate) {
  const runs = [];
  for (let i = 0; i < runCount; i++) {
    const r = await oneRun(idle, mapLib, cpuRate);
    if (r.failure) throw new Error('run ' + (i + 1) + '/' + runCount + ' failed: ' + r.failure);
    runs.push(r);
  }
  if (idle) {
    const windowSecs = IDLE_WINDOW_MS / 1000;
    const medFrames = medianOf(runs, 'frames');
    const medRaf = medianOf(runs, 'rafArmed');
    const framesPerSec = round2(medFrames / windowSecs);
    // Sanity guard (cycle 17): a run that produces no real frames cannot tell
    // a fixed rAF loop from a broken one — both read ~0 (see header comment,
    // this is exactly the bug that made the previous --idle number a
    // false-green). Report the failure explicitly instead of a number.
    const idleObj = {
      mapReady: runs.every((r) => r.mapReady), mapReadyMs: medianOf(runs, 'mapReadyMs'),
      simStarted: runs.every((r) => r.simStarted),
      framesPerSec, longTasks30s: medianOf(runs, 'longTasks')
    };
    if (framesPerSec >= 1) {
      idleObj.rafArmedPerSec = round2(medRaf / windowSecs);
      idleObj.rafPerFrame = round2(medRaf / Math.max(medFrames, 1));
    } else {
      idleObj.rafArmedPerSec = null;
      idleObj.rafPerFrame = null;
      idleObj.invalid = 'no frame production (framesPerSec < 1) — this run is not rendering; rafArmedPerSec/rafPerFrame are unmeasured, not zero';
    }
    // Performance.getMetrics deltas (task 1): degrade to nulls, never throw,
    // if any run's CDP session couldn't read the Performance domain.
    idleObj.perfDomain = runs.every((r) => r.perfDomain === true);
    if (idleObj.perfDomain) {
      const medLayoutCount = medianOf(runs, 'layoutCount');
      idleObj.layoutCount = medLayoutCount;
      idleObj.recalcStyleCount = medianOf(runs, 'recalcStyleCount');
      idleObj.layoutDurationMs = round2(medianOf(runs, 'layoutDurationMs'));
      idleObj.recalcStyleDurationMs = round2(medianOf(runs, 'recalcStyleDurationMs'));
      idleObj.layoutObjects = medianOf(runs, 'layoutObjects');
      idleObj.nodes = medianOf(runs, 'nodes');
      idleObj.layoutsPerSec = round2(medLayoutCount / windowSecs);
    } else {
      idleObj.layoutCount = null;
      idleObj.recalcStyleCount = null;
      idleObj.layoutDurationMs = null;
      idleObj.recalcStyleDurationMs = null;
      idleObj.layoutObjects = null;
      idleObj.nodes = null;
      idleObj.layoutsPerSec = null;
    }
    return {
      mode: 'idle', cspStripped: true, runs: runCount, mapLib: mapLib ? 'local' : 'absent',
      cpu: cpuRate || 1, idle: idleObj
    };
  }
  return {
    mode: 'boot', cspStripped: true, cpu: 1, runs: runCount,
    dcl: medianOf(runs, 'dcl'), load: medianOf(runs, 'load'), longTasks: medianOf(runs, 'longTasks'),
    jsExecMs: null, // needs CDP Profiler (Emulation has no CLI flag) — stretch, not measured by --dump-dom
    requests: medianOf(runs, 'requests'), gzipBytes: medianOf(runs, 'gzipBytes'), apiCalls: medianOf(runs, 'apiCalls')
  };
}

/* Geometry gate (task 2b, cycle 22): a fixed allowlist of structural container
   selectors, each matched element's getBoundingClientRect() (rounded to whole
   pixels) plus computed overflow/zIndex/position. This replaces a screenshot
   gate for T2.4b's containment risk: `contain: layout|paint|size` and
   `content-visibility` only ever go wrong by moving/clipping element geometry,
   never by silently changing pixels a rect comparison can't see — see the
   cycle-22 directive's "Why this work order" section. A selector matching zero
   elements is recorded as count:0, not dropped, so a selector that stops
   matching at runtime is itself a regression signal. */
const GEO_SELECTORS = [
  '.hud-rail', '.hud-card', '.panel', '.panel-head', '.panel-body',
  '.modal-backdrop', '.modal-card', '.chips', '.dock', '#map', '.topbar', '.speedo', '.hud-overlay'
];

async function runGeometryCdp(bin, url) {
  const session = await openCdp(bin);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Page.navigate', { url });
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < 20000) {
      const r = await session.send('Runtime.evaluate', { expression: 'window.__idleStarted===true', returnByValue: true });
      if (r && r.result && r.result.value === true) { started = true; break; }
      await sleep(200);
    }
    if (!started) return { failure: 'window.__idleStarted never became true within 20s of real time' };
    // Let one just-finished boot layout settle before measuring — the same
    // 500ms-class gap --idle's own map-ready/7s fallback already tolerates.
    await sleep(500);
    const expr = 'JSON.stringify((' + JSON.stringify(GEO_SELECTORS) + ').map(function(sel){\n' +
      '  var els=document.querySelectorAll(sel);var rects=[];\n' +
      '  for(var i=0;i<els.length;i++){\n' +
      '    var r=els[i].getBoundingClientRect();var cs=getComputedStyle(els[i]);\n' +
      '    rects.push({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),\n' +
      '      overflow:cs.overflow,zIndex:cs.zIndex,position:cs.position});\n' +
      '  }\n' +
      '  return {selector:sel,count:els.length,rects:rects};\n' +
      '}))';
    const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (!r || !r.result || typeof r.result.value !== 'string') return { failure: 'CDP Runtime.evaluate returned no usable geometry result' };
    return { elements: JSON.parse(r.result.value) };
  } finally {
    closeCdp(session);
  }
}

// 1px tolerance on rect fields (directive task 2b); overflow/zIndex/position
// compared exactly since containment risk includes clip/stacking, not just size.
function compareGeometry(base, cur) {
  const baseBySel = {};
  for (const g of base) baseBySel[g.selector] = g;
  let geoElements = 0;
  let geoDiffs = 0;
  const firstDiffs = [];
  for (const curGroup of cur) {
    const baseGroup = baseBySel[curGroup.selector] || { rects: [] };
    const n = Math.max(curGroup.rects.length, baseGroup.rects.length);
    for (let i = 0; i < n; i++) {
      geoElements++;
      const b = baseGroup.rects[i];
      const c = curGroup.rects[i];
      if (!b || !c) {
        geoDiffs++;
        if (firstDiffs.length < 5) firstDiffs.push(curGroup.selector + '[' + i + ']: ' + (!b ? 'missing in baseline' : 'missing now'));
        continue;
      }
      const diffFields = [];
      for (const f of ['x', 'y', 'w', 'h']) if (Math.abs(b[f] - c[f]) > 1) diffFields.push(f);
      if (b.overflow !== c.overflow) diffFields.push('overflow');
      if (b.zIndex !== c.zIndex) diffFields.push('zIndex');
      if (b.position !== c.position) diffFields.push('position');
      if (diffFields.length) {
        geoDiffs++;
        if (firstDiffs.length < 5) firstDiffs.push(curGroup.selector + '[' + i + ']: ' + diffFields.join(','));
      }
    }
  }
  return { geoElements, geoDiffs, firstDiffs };
}

async function runGeometryMode(args) {
  const outIdx = args.indexOf('--geo-out');
  const cmpIdx = args.indexOf('--geo-cmp');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const cmpPath = cmpIdx >= 0 ? args[cmpIdx + 1] : null;
  if (!outPath && !cmpPath) {
    console.error('--geometry requires --geo-out <path> or --geo-cmp <path>');
    process.exit(1);
    return;
  }
  const mapLib = mapLibreCachePaths();
  // One retry on a fresh session/navigation: observed on this shared box, a
  // getBoundingClientRect()+getComputedStyle sweep taken right as the map/HUD
  // are still settling can occasionally exceed CDP_SEND_TIMEOUT_MS under
  // contention (STATE.md "Bench noise: CDP timings on a shared box vary
  // ±10%") — a fresh attempt has always cleared it in practice. Two straight
  // failures is reported honestly, never retried silently into a third.
  let result = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    const { server, port } = await startServer(0, true, !!mapLib);
    try {
      result = await runGeometryCdp(BIN, 'http://127.0.0.1:' + port + '/');
    } catch (e) {
      lastErr = e;
    } finally {
      server.close();
    }
  }
  if (!result) {
    console.log(JSON.stringify({ mode: 'geometry', failure: (lastErr && lastErr.message) || 'unknown geometry measurement failure' }));
    process.exit(1);
    return;
  }
  if (result.failure) {
    console.log(JSON.stringify({ mode: 'geometry', failure: result.failure }));
    process.exit(1);
    return;
  }
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(result.elements));
    console.log(JSON.stringify({
      mode: 'geometry', wrote: outPath,
      geoElements: result.elements.reduce((s, g) => s + g.count, 0)
    }));
  } else {
    const base = JSON.parse(fs.readFileSync(cmpPath, 'utf8'));
    const cmp = compareGeometry(base, result.elements);
    console.log(JSON.stringify(Object.assign({ mode: 'geometry' }, cmp)));
    process.exit(cmp.geoDiffs > 0 ? 1 : 0);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--geometry')) { await runGeometryMode(args); return; }
  const idle = args.includes('--idle');
  const runsIdx = args.indexOf('--runs');
  const runCount = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 3;
  const cpuIdx = args.indexOf('--cpu');
  const cpuRate = cpuIdx >= 0 ? parseInt(args[cpuIdx + 1], 10) : 1;
  if (cpuIdx >= 0 && !idle) {
    console.log('NOTE: --cpu only applies to --idle (it needs the CDP session Emulation.setCPUThrottlingRate ' +
      'uses; boot mode still runs through --dump-dom --virtual-time-budget, which has no CDP session). Running boot at cpu=1.');
  }
  // mapLib is only relevant to --idle: boot mode's own metrics (requests,
  // gzipBytes, apiCalls) must keep meaning "same-origin only", which a local
  // MapLibre script would change. Cold checkouts (no test/.cache/) get
  // mapLib:"absent" here and always did — see mapLibreCachePaths().
  const mapLib = idle ? mapLibreCachePaths() : null;

  H.group('perf-bench — lab boot cost, real Chromium, same-origin only (' + BIN + ')');
  let result;
  try {
    result = await bench(idle, runCount, mapLib, idle ? cpuRate : 1);
  } catch (e) {
    H.ok('bench completed ' + runCount + ' navigation(s) and parsed a probe from each', false, e.message);
    process.exit(H.report());
    return;
  }
  console.log(JSON.stringify(result));

  if (idle) {
    H.ok('idle bench produced real frame production (framesPerSec >= 1) before trusting rafArmedPerSec/rafPerFrame',
      typeof result.idle.framesPerSec === 'number' && result.idle.framesPerSec >= 1 && !result.idle.invalid,
      JSON.stringify(result.idle));
    H.ok('idle bench confirms window.App.sim actually started (simStarted)',
      result.idle.simStarted === true, JSON.stringify(result.idle));
    H.ok('mapLib is reported (' + result.mapLib + ') so the number is never read without its fixture',
      result.mapLib === 'local' || result.mapLib === 'absent', result.mapLib);
  } else {
    H.ok('boot bench produced a positive DOMContentLoaded time', result.dcl > 0, 'dcl=' + result.dcl);
    H.ok('boot bench counted same-origin asset requests', result.requests > 0, 'requests=' + result.requests);
    H.ok('boot bench counted gzip bytes for those assets', result.gzipBytes > 0, 'gzipBytes=' + result.gzipBytes);
  }
  process.exit(H.report());
}

if (FETCH_MAPLIBRE) {
  fetchMaplibreCache().then(() => process.exit(0)).catch((e) => { console.error('--fetch-maplibre failed: ' + e.message); process.exit(1); });
} else {
  main();
}
