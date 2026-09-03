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
       Chromium's virtual clock, then prints the final DOM once. --idle reuses
       the exact same one-shot mechanism with a 30 s (virtual) budget instead
       of tacking on a second live session — no CDP needed for either number.
     - CPU throttling (Emulation.setCPUThrottlingRate) has no CLI flag; it is
       DevTools-protocol only, so `--cpu` stays a stretch item (STATE.md
       handoff: "only after the report is written") rather than blocking P0a.

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
  console.log('SKIP test/perf-bench.js — no headless Chromium under ~/.cache/ms-playwright/chromium_headless_shell-*/ ' +
    '(STATE.md "Headless Chromium — working recipe"); nothing measured, exit 0.');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

/* window.__lt/__iv/__to/__raf are cumulative counters from page-load, not deltas —
   fine for a one-shot boot measurement, and exactly what --idle wants (a count
   over its whole virtual-time window, which IS the idle window since nothing
   else happens on this fixture before it). */
const COUNTERS = '<script>\n' +
  'window.__iv=0;window.__to=0;window.__raf=0;window.__lt=0;\n' +
  'var _si=window.setInterval;window.setInterval=function(){window.__iv++;return _si.apply(window,arguments)};\n' +
  'var _st=window.setTimeout;window.setTimeout=function(){window.__to++;return _st.apply(window,arguments)};\n' +
  'var _rq=window.requestAnimationFrame;window.requestAnimationFrame=function(){window.__raf++;return _rq.apply(window,arguments)};\n' +
  'try{new PerformanceObserver(function(l){window.__lt+=l.getEntries().length}).observe({type:"longtask",buffered:true})}catch(e){}\n' +
  '</script>';

function probeScript(delayMs, idle) {
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
    '    idle:' + (idle ? 'true' : 'false') + '\n' +
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
function startServer(delayMs, idle) {
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
      html = html.replace('<head>', '<head>\n' + COUNTERS);
      html = html.replace('</body>', probeScript(delayMs, idle) + '\n</body>');
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
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('chrome timed out after 30s')); }, 30000);
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

/* One run: fresh server (so its request log starts empty) + one navigation. */
async function oneRun(idle) {
  const delayMs = idle ? 30000 : 300;
  const virtualTimeBudget = idle ? 32000 : 1500;
  const { server, requests, port } = await startServer(delayMs, idle);
  let probe = null;
  let failure = null;
  try {
    probe = parseProbe(await runChromium('http://127.0.0.1:' + port + '/', virtualTimeBudget));
  } catch (e) { failure = e.message; }
  finally { server.close(); }
  if (failure || !probe) return { failure: failure || 'no probe output in the dumped DOM' };

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

  return {
    dcl: probe.dcl, load: probe.load, longTasks: probe.longTasks,
    requests: assets.length, gzipBytes, apiCalls,
    rafArmed: probe.rafArmed, intervalsArmed: probe.intervalsArmed, timeoutsArmed: probe.timeoutsArmed
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

async function bench(idle, runCount) {
  const runs = [];
  for (let i = 0; i < runCount; i++) {
    const r = await oneRun(idle);
    if (r.failure) throw new Error('run ' + (i + 1) + '/' + runCount + ' failed: ' + r.failure);
    runs.push(r);
  }
  if (idle) {
    return {
      mode: 'idle', cspStripped: true, runs: runCount,
      idle: {
        rafPerSec: Math.round((medianOf(runs, 'rafArmed') / 30) * 100) / 100,
        longTasks30s: medianOf(runs, 'longTasks')
      }
    };
  }
  return {
    mode: 'boot', cspStripped: true, cpu: 1, runs: runCount,
    dcl: medianOf(runs, 'dcl'), load: medianOf(runs, 'load'), longTasks: medianOf(runs, 'longTasks'),
    jsExecMs: null, // needs CDP Profiler (Emulation has no CLI flag) — stretch, not measured by --dump-dom
    requests: medianOf(runs, 'requests'), gzipBytes: medianOf(runs, 'gzipBytes'), apiCalls: medianOf(runs, 'apiCalls')
  };
}

async function main() {
  const args = process.argv.slice(2);
  const idle = args.includes('--idle');
  const runsIdx = args.indexOf('--runs');
  const runCount = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 3;
  if (args.includes('--cpu')) {
    console.log('NOTE: --cpu (DevTools Emulation.setCPUThrottlingRate) is not implemented — ' +
      'it has no CLI flag, only the CDP protocol; STATE.md handoff files it as stretch. Running at cpu=1.');
  }

  H.group('perf-bench — lab boot cost, real Chromium, same-origin only (' + BIN + ')');
  let result;
  try {
    result = await bench(idle, runCount);
  } catch (e) {
    H.ok('bench completed ' + runCount + ' navigation(s) and parsed a probe from each', false, e.message);
    process.exit(H.report());
    return;
  }
  console.log(JSON.stringify(result));

  if (idle) {
    H.ok('idle bench (30 s virtual time on the map shell) produced rafPerSec + longTasks30s',
      typeof result.idle.rafPerSec === 'number' && typeof result.idle.longTasks30s === 'number',
      JSON.stringify(result.idle));
  } else {
    H.ok('boot bench produced a positive DOMContentLoaded time', result.dcl > 0, 'dcl=' + result.dcl);
    H.ok('boot bench counted same-origin asset requests', result.requests > 0, 'requests=' + result.requests);
    H.ok('boot bench counted gzip bytes for those assets', result.gzipBytes > 0, 'gzipBytes=' + result.gzipBytes);
  }
  process.exit(H.report());
}

main();
