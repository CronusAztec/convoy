/* Convoy — performance baseline.

   NOT part of `npm test`. Spins up a real dev-auth server on a scratch port
   (CONVOY_DEV_AUTH=1, BOTS=0 — no Supabase, no third-party calls) and
   measures the numbers M1/M8 of the mission plan need to compare against:

     - client payload: byte and gzip size of every js/*.js + css/styles.css +
       index.html the browser loads on cold boot, and the <script> tag count
     - /api/health round-trip latency (p50/p95/p99) over 300 sequential calls
     - WS connect→welcome latency (p50/p95) opening 50 concurrent sockets
     - server RSS growth over a churn window: N simulated riders repeatedly
       connect, send a few 'pos' updates, and disconnect, while RSS is
       sampled from the real OS process (not the aggregate of the sockets)

   Usage:
     node scripts/bench.js                  # ~5 min churn window (default)
     BENCH_CHURN_MS=30000 node scripts/bench.js   # shorter run for iteration
     BENCH_CHURN_CLIENTS=40 node scripts/bench.js

   Prints a plain-text report and writes the same as JSON next to this
   script's caller-supplied --out path (or stdout only if omitted). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.BENCH_PORT || '5878', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const CHURN_MS = parseInt(process.env.BENCH_CHURN_MS || String(5 * 60 * 1000), 10);
const CHURN_CLIENTS = parseInt(process.env.BENCH_CHURN_CLIENTS || '25', 10);
const outIdx = process.argv.indexOf('--out');
const OUT_PATH = outIdx >= 0 ? process.argv[outIdx + 1] : null;

function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}
function ms(n) { return n.toFixed(1) + 'ms'; }
function kb(n) { return (n / 1024).toFixed(1) + 'KB'; }

/* ---------------- client bundle size ---------------- */
function clientBundleReport() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scriptTags = (html.match(/<script[^>]*src="js\/[^"]+"/g) || []);
  let rawTotal = 0, gzTotal = 0;
  const files = ['index.html', 'css/styles.css'];
  for (const m of scriptTags) {
    const src = m.match(/src="([^"?]+)/)[1];
    files.push(src);
  }
  const uniq = [...new Set(files)];
  for (const f of uniq) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    rawTotal += buf.length;
    gzTotal += zlib.gzipSync(buf, { level: 9 }).length;
  }
  return { scriptTagCount: scriptTags.length, fileCount: uniq.length, rawBytes: rawTotal, gzipBytes: gzTotal };
}

/* ---------------- server process + RSS sampling ---------------- */
function startServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      // Every simulated client in this script comes from 127.0.0.1, so the
      // real per-IP ceiling (MAX_PER_IP=10) would throttle the benchmark
      // itself long before it measured anything — raise it for this run only.
      CONVOY_DEV_AUTH: '1', BOTS: '0', PORT: String(PORT), NODE_ENV: 'development',
      MAX_PER_IP: String(Math.max(80, CHURN_CLIENTS + 60))
    });
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (buf.indexOf('Convoy server') >= 0) { child.stdout.off('data', onData); resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error('server exited ' + code)); });
    setTimeout(() => reject(new Error('server boot timeout')), 10000);
  });
}
function rssOf(pid) {
  try {
    const out = execSync('ps -o rss= -p ' + pid).toString().trim();
    return parseInt(out, 10) * 1024; // KB -> bytes
  } catch (e) { return null; }
}

/* ---------------- /api/health latency ---------------- */
async function healthLatency(n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(BASE + '/api/health');
    await r.text();
    times.push(performance.now() - t0);
  }
  return times;
}

/* ---------------- WS connect->welcome latency ---------------- */
function wsConnectWelcome(n) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(new Promise((resolve) => {
      const t0 = performance.now();
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
      let settled = false;
      const done = (dt) => { if (!settled) { settled = true; resolve(dt); try { ws.close(); } catch (e) { } } };
      ws.on('open', () => ws.send(JSON.stringify({
        t: 'hello',
        profile: { name: 'bench' + i, handle: 'bench' + i, emoji: 0, vibe: 'x',
          car: { year: 2020, make: 'Honda', model: 'Civic', trim: '', paint: '#fff', paintName: 'White', finish: 'Gloss' } },
        pos: [-118.25 + Math.random() * 0.05, 34.05 + Math.random() * 0.05], heading: 0
      })));
      ws.on('message', (buf) => {
        let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
        if (m.t === 'welcome') done(performance.now() - t0);
      });
      ws.on('error', () => done(NaN));
      setTimeout(() => done(NaN), 8000);
    }));
  }
  return Promise.all(runs);
}

/* ---------------- churn: connect, chat a bit, disconnect, repeat ---------------- */
function churnClient(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    let ticks = 0;
    const finish = () => { try { ws.close(); } catch (e) { } resolve(); };
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'hello',
      profile: { name: 'churn' + id, handle: 'churn' + id, emoji: 0, vibe: 'x',
        car: { year: 2020, make: 'Honda', model: 'Civic', trim: '', paint: '#fff', paintName: 'White', finish: 'Gloss' } },
      pos: [-118.25, 34.05], heading: 0
    })));
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      if (m.t !== 'welcome') return;
      const iv = setInterval(() => {
        ticks++;
        if (ticks > 4) { clearInterval(iv); finish(); return; }
        try { ws.send(JSON.stringify({ t: 'pos', pos: [-118.25 + Math.random() * 0.01, 34.05], heading: Math.random() * 360 })); } catch (e) { }
      }, 300);
    });
    ws.on('error', finish);
    setTimeout(finish, 5000);
  });
}
async function churnLoop(durationMs, concurrency, pid, sampleEveryMs) {
  const samples = [];
  const startedAt = Date.now();
  const stop = startedAt + durationMs;
  const sampler = setInterval(() => {
    const rss = rssOf(pid);
    if (rss != null) samples.push({ tMs: Date.now() - startedAt, rssBytes: rss });
  }, sampleEveryMs);
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async function loop(idx) {
      let n = 0;
      while (Date.now() < stop) { await churnClient(idx + '-' + (n++)); }
    })(i));
  }
  await Promise.all(workers);
  clearInterval(sampler);
  const rss = rssOf(pid);
  if (rss != null) samples.push({ tMs: Date.now() - startedAt, rssBytes: rss });
  return samples;
}

(async () => {
  console.log('Convoy perf baseline — port ' + PORT + ', churn ' + (CHURN_MS / 1000) + 's × ' + CHURN_CLIENTS + ' concurrent clients\n');

  const bundle = clientBundleReport();
  console.log('client bundle:');
  console.log('  <script> tags in index.html: ' + bundle.scriptTagCount + ' (+ index.html + css/styles.css = ' + bundle.fileCount + ' files loaded cold)');
  console.log('  raw bytes:  ' + kb(bundle.rawBytes));
  console.log('  gzip bytes: ' + kb(bundle.gzipBytes) + '\n');

  console.log('starting dev-auth server...');
  const child = await startServer();
  const pid = child.pid;
  const rssIdle = rssOf(pid);
  console.log('server up, pid=' + pid + ', idle RSS=' + kb(rssIdle) + '\n');

  console.log('measuring /api/health latency (300 sequential requests)...');
  const health = await healthLatency(300);
  console.log('  p50=' + ms(pct(health, 50)) + '  p95=' + ms(pct(health, 95)) + '  p99=' + ms(pct(health, 99)) + '\n');

  console.log('measuring WS connect→welcome latency (50 concurrent sockets)...');
  const wsLat = (await wsConnectWelcome(50)).filter((v) => !isNaN(v));
  console.log('  ok=' + wsLat.length + '/50  p50=' + ms(pct(wsLat, 50)) + '  p95=' + ms(pct(wsLat, 95)) + '\n');

  console.log('running churn (' + (CHURN_MS / 1000) + 's, ' + CHURN_CLIENTS + ' concurrent connect/pos/disconnect loops)...');
  const rssBefore = rssOf(pid);
  const samples = await churnLoop(CHURN_MS, CHURN_CLIENTS, pid, 15000);
  const rssAfter = rssOf(pid);
  const growth = rssAfter - rssBefore;
  console.log('  RSS before churn: ' + kb(rssBefore));
  console.log('  RSS after churn:  ' + kb(rssAfter));
  console.log('  growth: ' + kb(growth) + ' (' + ((growth / rssBefore) * 100).toFixed(1) + '%)\n');

  const report = {
    at: new Date().toISOString(),
    bundle,
    healthMs: { p50: pct(health, 50), p95: pct(health, 95), p99: pct(health, 99), n: health.length },
    wsConnectWelcomeMs: { p50: pct(wsLat, 50), p95: pct(wsLat, 95), ok: wsLat.length, attempted: 50 },
    churn: { durationMs: CHURN_MS, concurrency: CHURN_CLIENTS, rssIdleBytes: rssIdle, rssBeforeBytes: rssBefore, rssAfterBytes: rssAfter, growthBytes: growth, samples }
  };
  if (OUT_PATH) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log('wrote ' + OUT_PATH);
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('[bench] failed:', e && e.stack || e); process.exit(1); });
