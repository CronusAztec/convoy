/* Convoy — wire bench (aspect P-E, milestone opened cycle 10). `node test/wire-bench.js`.

   Answers "how many bytes/second does the server push to each client, and how
   long does each tick callback take" with a REAL server/server.js child process
   and REAL guest WebSocket clients — the same "no number, no claim" discipline
   test/perf-bench.js established for the frontend (STATE.md guardrail 5).

   This box has no server/.env (no Supabase config), so server/server.js exits
   1 on boot ("[boot] Supabase Auth is not configured") and test/concurrency.js
   has never been runnable here. test/server-stub.js removes that blocker with
   a 9-line, test-only preload that patches the boot-gate functions — no
   production code changes, and guests never touch the database anyway
   (server/server.js:2613 hello(), :2066 blockedPair()).

   Recipe:
     - pick a free port ourselves (net.createServer().listen(0)) rather than
       PORT=0 — server/server.js:54 reads PORT once at require time and its
       own readiness line (:4287) prints that same string, so PORT=0 would
       print "localhost:0" and we'd have no way to find the real port;
     - spawn `node -r <abs path to server-stub.js> server/server.js` with
       MAX_PER_IP/MAX_CLIENTS raised (MAX_PER_IP defaults to 10 — server.js:62
       — and refuses an 11th socket from 127.0.0.1) and BOTS=0/AMBIENT=0 so the
       byte count is 100% real clients, not simulation traffic mixed in;
     - wait for "Convoy server →" on stdout, never a fixed sleep;
     - connect N guest clients (require('../server/node_modules/ws') — the
       same import test/concurrency.js:30 uses; ws is NOT a root package.json
       dependency, guardrail 1) on a fixed, deterministic lattice around a
       fixed centre (lat = 51.5 + (i%8)*0.01, lng = -0.12 + floor(i/8)*0.01 —
       all within a few km, well under the 30km NEARBY_KM default, so every
       rider sees every other rider) with a fixed per-tick advance — NO
       Math.random() anywhere, so rowOf()'s toFixed(5) numbers, and therefore
       the byte count, are reproducible run to run (unlike the improve
       directive's own spike, which used Math.random() and could not be
       pinned);
     - discard a warm-up window (1.5s) before counting, so the per-socket
       `welcome` frame and the join burst of `rider:add` frames from the other
       N-1 sockets connecting don't land in what's supposed to be a
       steady-state number;
     - count received bytes per frame, bucketed by the frame's own `t`;
     - tick-callback durations come from test/server-stub.js's own
       CONVOY_BENCH_STATS file, keyed by the callback's source prefix (not by
       delay — the mistake in the improve directive's spike, evidence §5) so
       the two frame-sending lanes (TICK_MS=1000 "full sync", FAST_MS=350
       "fast lane") are never confused with server.js's four other
       setIntervals;
     - teardown: close every socket, SIGKILL the child. Never leaves a
       listening server or an orphan node process behind (see the
       "no-orphan" self-check in main()).

   bytesPerClientPerSec is the pinnable number (test/server-baseline.json,
   Task 2) — it depends only on the deterministic lattice and rider count, not
   on box speed. tickMs is informational only: this box runs a long-lived,
   unrelated Chromium session (STATE.md §8) that can eat 100%+ of a core, so a
   tick callback's wall-clock duration here is not a trustworthy number to
   ratchet against. `boxLoaded` (os.loadavg()[0] > 1) is recorded on every run
   precisely so a future reader knows whether to trust tickMs at all.

   No new dependency: net/child_process/fs/os are Node built-ins; ws is
   already vendored under server/node_modules (test/concurrency.js's own
   import). SKIPs with exit 0 (never fails `npm test`) if server/node_modules/
   ws is missing, or the child never prints "Convoy server →" within a
   generous timeout — the same discipline as test/perf-bench.js's missing-
   Chromium SKIP. */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./harness');

const ROOT = H.ROOT;
const STUB = path.join(ROOT, 'test', 'server-stub.js');
const SERVER = path.join(ROOT, 'server', 'server.js');

let WebSocket;
try { WebSocket = require(path.join(ROOT, 'server', 'node_modules', 'ws')); }
catch (e) {
  console.log('SKIP test/wire-bench.js — server/node_modules/ws is not installed ' +
    '(run npm install under server/); nothing measured, exit 0.');
  process.exit(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/* Spawn the real server as a child process, stubbed just enough to boot with
   no server/.env. Resolves once "Convoy server →" appears on stdout, rejects
   on early exit or a 15s timeout. */
function startServer(port, statsPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', STUB, SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port), MAX_PER_IP: '999', MAX_CLIENTS: '500',
        BOTS: '0', AMBIENT: '0', CONVOY_BENCH_STATS: statsPath
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('server did not print "Convoy server →" within 15s. stdout: ' + out));
    }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if (!settled && /Convoy server →/.test(out)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('server exited early (code ' + code + '). stdout: ' + out));
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Fixed lattice, no Math.random() anywhere — a rider's position is a pure
// function of its index and the tick number, so a given (clients, secs) pair
// always produces the same byte count.
function latticePos(i) {
  return [51.5 + (i % 8) * 0.01, -0.12 + Math.floor(i / 8) * 0.01];
}

function guestProfile(i) {
  return {
    name: 'wb' + i, handle: 'wb' + i, emoji: 0, vibe: 'x',
    car: { year: 2020, make: 'Honda', model: 'Civic', trim: '', paint: '#ffffff', paintName: 'W', finish: 'Gloss' }
  };
}

/* One connected guest client: sends hello, then a `pos` frame once a second
   with a small deterministic advance (parked clients never advance). Received
   frame bytes are tallied by kind, gated on the SHARED `gate.counting` flag
   (see oneRun) rather than a per-client timer. A per-client "1.5s after MY OWN
   welcome" gate looked right in isolation but was wrong at N=60: client #0's
   gate opens while clients #1..#59 are still connecting, and every one of
   those joins fans out a rider:add to every already-known rider — so client
   #0 was still counting join-burst traffic well past its own 1.5s. The
   resolved promise fires on 'welcome', not on 'open', so oneRun can wait for
   every client to actually be known to the server before starting the shared
   warm-up clock. */
function connectClient(url, i, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const bytesByKind = Object.create(null);
    let framesTotal = 0;
    let posTimer = null;
    let tick = 0;
    let welcomed = false;
    const prevRows = new Map();   // Task 4: rider id -> last-seen row JSON, for unchangedRowShare
    let rowsSeen = 0, rowsUnchanged = 0;

    ws.on('message', (buf) => {
      const n = buf.length;
      let m = null;
      try { m = JSON.parse(buf.toString()); } catch (e) {}
      const kind = (m && m.t) || 'unparsed';
      if (opts.gate.counting) {
        bytesByKind[kind] = (bytesByKind[kind] || 0) + n;
        framesTotal++;
        if (m && m.t === 'tick' && Array.isArray(m.r)) {
          for (const row of m.r) {
            const id = row[0];
            const rowJson = JSON.stringify(row);
            rowsSeen++;
            if (prevRows.get(id) === rowJson) rowsUnchanged++;
            prevRows.set(id, rowJson);
          }
        }
      }
      if (!welcomed && m && m.t === 'welcome') {
        welcomed = true;
        resolve({
          close() { try { clearInterval(posTimer); } catch (e) {} try { ws.close(); } catch (e) {} },
          stats() { return { bytesByKind, framesTotal, rowsSeen, rowsUnchanged }; }
        });
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello', profile: guestProfile(i), pos: latticePos(i), heading: 90
      }));
      posTimer = setInterval(() => {
        tick++;
        if (opts.mode !== 'parked') {
          const [lat, lng] = latticePos(i);
          ws.send(JSON.stringify({
            t: 'pos', pos: [lat + tick * 0.0001, lng], heading: 90, mode: 'cruise'
          }));
        } else {
          ws.send(JSON.stringify({ t: 'pos', pos: latticePos(i), heading: 90, mode: 'parked' }));
        }
      }, 1000);
    });
    ws.on('error', (e) => { try { ws.close(); } catch (e2) {} reject(e); });
  });
}

async function oneRun(clients, secs, mode) {
  const port = await freePort();
  const statsPath = path.join(os.tmpdir(), 'convoy-wire-bench-' + process.pid + '-' + Date.now() + '.json');
  const loadBefore = os.loadavg()[0];
  const child = await startServer(port, statsPath);
  try {
    const url = 'ws://127.0.0.1:' + port + '/ws';
    // Shared across every client, not a per-client timer keyed off its OWN
    // welcome: at N=60, client #0's welcome lands while #1..#59 are still
    // connecting, and every later join fans out a rider:add to every
    // already-known rider. A per-client gate let client #0 start "counting"
    // while it was still receiving that join-burst traffic. The gate opens
    // only once, warmupMs after the LAST client's welcome.
    const gate = { counting: false };
    const conns = [];
    for (let i = 0; i < clients; i++) {
      conns.push(await connectClient(url, i, { mode, gate }));
      await new Promise((r) => setTimeout(r, 15)); // trickle connects so MAX_PER_IP's per-socket accept path never sees a burst it has to queue
    }
    const warmupMs = 1500;
    await new Promise((r) => setTimeout(r, warmupMs));
    gate.counting = true;
    await new Promise((r) => setTimeout(r, secs * 1000));
    gate.counting = false;
    const loadAfter = os.loadavg()[0];

    let totalBytes = 0;
    let totalFrames = 0;
    let rowsSeen = 0, rowsUnchanged = 0;
    const byKind = Object.create(null);
    for (const c of conns) {
      const s = c.stats();
      totalFrames += s.framesTotal;
      rowsSeen += s.rowsSeen;
      rowsUnchanged += s.rowsUnchanged;
      for (const k of Object.keys(s.bytesByKind)) {
        byKind[k] = (byKind[k] || 0) + s.bytesByKind[k];
        totalBytes += s.bytesByKind[k];
      }
    }
    conns.forEach((c) => c.close());

    let tickMs = { tick1000: { p50: null, p95: null, max: null, n: 0 }, fast350: { p50: null, p95: null, max: null, n: 0 } };
    try {
      const raw = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      const keys = Object.keys(raw);
      // TICK_MS=1000 registers first (server/server.js:3343), FAST_MS=350
      // second (:3364) — both are the only setIntervals that ever fire in a
      // guest-only run with BOTS=0 (the bot-stepping code inside the fast
      // lane is a no-op with zero bots, but the interval itself still fires).
      const summarize = (arr) => {
        if (!arr || !arr.length) return { p50: null, p95: null, max: null, n: 0 };
        const s = arr.slice().sort((a, b) => a - b);
        const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
        return { p50: round2(pick(0.5)), p95: round2(pick(0.95)), max: round2(s[s.length - 1]), n: s.length };
      };
      if (keys[0]) tickMs.tick1000 = summarize(raw[keys[0]]);
      if (keys[1]) tickMs.fast350 = summarize(raw[keys[1]]);
    } catch (e) { /* stats file not written yet on a very short run — leave nulls */ }

    return {
      clients, secs, totalBytes, totalFrames, byKind,
      rowsSeen, rowsUnchanged, boxLoaded: loadBefore > 1 || loadAfter > 1, tickMs
    };
  } finally {
    try { fs.unlinkSync(statsPath); } catch (e) {}
    // Wait for the actual 'exit' event, not a guessed delay — pgrep can still
    // see a just-SIGKILLed pid for a few ms after kill() returns, which made
    // the no-orphan check flaky before this fix.
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      try { child.kill('SIGKILL'); } catch (e) { resolve(); }
    });
  }
}

function round2(n) { return Math.round(n * 100) / 100; }

async function bench(clients, secs, mode) {
  const r = await oneRun(clients, secs, mode);
  const bytesPerClientPerSec = round2(r.totalBytes / r.clients / r.secs);
  const framesPerClientPerSec = round2(r.totalFrames / r.clients / r.secs);
  const byKindBytesPerSec = {};
  for (const k of Object.keys(r.byKind)) byKindBytesPerSec[k] = round2(r.byKind[k] / r.secs);
  const unchangedRowShare = r.rowsSeen ? round2(r.rowsUnchanged / r.rowsSeen) : null;
  return {
    mode: mode === 'parked' ? 'wire-parked' : 'wire',
    clients: r.clients, secs: r.secs,
    bytesPerClientPerSec, framesPerClientPerSec, byKindBytesPerSec,
    serverBytesPerSec: round2(r.totalBytes / r.secs),
    tickMs: r.tickMs, boxLoaded: r.boxLoaded, unchangedRowShare
  };
}

// STATE.md §8 documents a pre-existing orphan `node server/server.js` (PID
// 33618, a dead mission's leftover, not ours) that is permanently present on
// this box's process table — a plain "is anything matching still running"
// check would permanently fail because of it. Compare pid SETS instead: this
// bench's own children must not survive teardown, but pids that were already
// running before the bench started are none of its business.
function serverPids() {
  // execFileSync, no shell: running the pattern through `sh -c "pgrep -f
  // '...server/server.js...'"` makes the search string appear in the
  // intermediate shell's OWN command line, which pgrep -f then matches —
  // a self-match that looked like an orphan on every single run until this
  // fix. execFileSync has no intermediate shell, so no self-match is possible.
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('pgrep', ['-f', 'server/server.js'], { encoding: 'utf8' });
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch (e) { return new Set(); } // pgrep exits 1 with no output when nothing matches
}

async function main() {
  const args = process.argv.slice(2);
  const clientsIdx = args.indexOf('--clients');
  const secsIdx = args.indexOf('--secs');
  const clients = clientsIdx >= 0 ? parseInt(args[clientsIdx + 1], 10) : 8;   // fast default mode
  const secs = secsIdx >= 0 ? parseInt(args[secsIdx + 1], 10) : 5;
  const mode = args.includes('--parked') ? 'parked' : 'moving';
  const isDefaultMode = clientsIdx < 0 && secsIdx < 0 && mode === 'moving';

  const pidsBefore = serverPids();

  H.group('wire-bench — real server child, ' + clients + ' guest WS clients, ' + secs + 's window (' + mode + ')');
  let result;
  try {
    result = await bench(clients, secs, mode);
  } catch (e) {
    H.ok('bench connected ' + clients + ' guest client(s) and measured a steady-state window', false, e.message);
    process.exit(H.report());
    return;
  }
  console.log(JSON.stringify(result));

  H.ok('bytesPerClientPerSec is a positive number', typeof result.bytesPerClientPerSec === 'number' && result.bytesPerClientPerSec > 0,
    'bytesPerClientPerSec=' + result.bytesPerClientPerSec);
  H.ok('every received frame was t:\'tick\' (guest-only, no other traffic in this window)',
    Object.keys(result.byKindBytesPerSec).every((k) => k === 'tick'), JSON.stringify(result.byKindBytesPerSec));
  H.ok('boxLoaded is recorded so tickMs is never read without its trust caveat', typeof result.boxLoaded === 'boolean', result.boxLoaded);

  // Ratchet gate, default mode only (test/server-baseline.json — same
  // ratchet-down contract as test/frontend-baseline.json). A non-default
  // invocation (e.g. --clients 60 --secs 10) measures and reports but does
  // not assert: it is far slower and not what the pin's tolerance was sized
  // against (see the file's own _comment).
  if (isDefaultMode) {
    const baselinePath = path.join(ROOT, 'test', 'server-baseline.json');
    const pin = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).bytesPerClientPerSec_default;
    const tolerance = 1.20; // see test/server-baseline.json _comment: ~5-6% natural quantisation jitter at this window size
    const ceiling = Math.round(pin * tolerance);
    H.ok('bytesPerClientPerSec (' + result.bytesPerClientPerSec + ') is within the pinned ceiling (' + pin +
      ' * ' + tolerance + ' = ' + ceiling + ', test/server-baseline.json)',
      result.bytesPerClientPerSec <= ceiling,
      'a rise past this means a real wire-format change added bytes to every row, not box jitter');
  }

  const pidsAfter = serverPids();
  const newOrphans = [...pidsAfter].filter((p) => !pidsBefore.has(p));
  H.ok('no NEW server/server.js process left behind (pre-existing ones, e.g. STATE.md §8\'s orphan, are not this bench\'s concern)',
    newOrphans.length === 0, newOrphans.join(', '));

  process.exit(H.report());
}

main();
