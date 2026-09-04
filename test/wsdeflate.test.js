/* Convoy — permessage-deflate negotiation + fidelity + kill switch (P-E, T2.6b, cycle 12).
   `node test/wsdeflate.test.js`.

   Boots a REAL server/server.js child (same recipe as test/wire-bench.js:
   `node -r test/server-stub.js server/server.js`, BOTS=0/AMBIENT=0/MAX_PER_IP=999
   so a guest client's traffic is 100% real and never mixed with simulation),
   connects one real `ws` guest client, and checks three things:

     1. the extension actually negotiated — read off `ws.extensions` (a public
        getter on the CLIENT socket, joined from what the server actually
        offered and the client actually accepted), never off server.js's own
        config object. A test that asserts the config equals the config proves
        nothing about whether the handshake actually worked.
     2. a `tick` frame received over that compressed socket decodes to the
        exact same shape as an uncompressed one would — rows are 5-element
        arrays, lat/lng round-trip to 5 decimal places. Compression is
        lossless by construction, but this is what makes it *provably*
        lossless on this exact server, not just in theory.
     3. the WS_DEFLATE=0 kill switch actually disables the extension end to
        end (a second server child, started with that env var) and the guest
        client still connects and receives ticks normally.

   SKIPs cleanly (exit 0) if server/node_modules/ws is missing, exactly like
   test/wire-bench.js. Registered in test/run.js's suites array (40th suite). */
'use strict';
const fs = require('fs');
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
  console.log('SKIP test/wsdeflate.test.js — server/node_modules/ws is not installed ' +
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

// Same recipe as test/wire-bench.js's startServer(): spawn the real server
// stubbed just enough to boot with no server/.env, resolve once "Convoy
// server →" appears on stdout.
function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', STUB, SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port), MAX_PER_IP: '999', MAX_CLIENTS: '500',
        BOTS: '0', AMBIENT: '0'
      }, extraEnv || {}),
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

async function stopServer(child) {
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    try { child.kill('SIGKILL'); } catch (e) { resolve(); }
  });
}

function connectOne(url, pos) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let welcomed = false;
    const onMsg = (buf) => {
      let m = null;
      try { m = JSON.parse(buf.toString()); } catch (e) {}
      if (!welcomed && m && m.t === 'welcome') {
        welcomed = true;
        resolve(ws);
      }
    };
    ws.on('message', onMsg);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello',
        profile: { name: 'wd', handle: 'wd', emoji: 0, vibe: 'x',
          car: { year: 2020, make: 'Honda', model: 'Civic', trim: '', paint: '#ffffff', paintName: 'W', finish: 'Gloss' } },
        pos, heading: 90
      }));
    });
    ws.on('error', (e) => reject(e));
  });
}

// A lone guest sees an empty c.known (server/server.js's tick lanes both
// `continue` when `!c.known.size` — :3350/:3378) and NEVER receives a `tick`
// frame — the fast/full-sync lanes only fire once a viewer has at least one
// OTHER rider in scope. So this connects TWO guests within NEARBY_KM of each
// other (same lattice centres test/wire-bench.js uses) and returns the FIRST
// one's socket plus the first `tick` frame it receives.
async function connectPairAndAwaitTick(url) {
  const a = await connectOne(url, [51.5, -0.12]);
  const b = await connectOne(url, [51.51, -0.12]); // ~1.1km away, well under NEARBY_KM
  const firstTick = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tick frame received within 5s')), 5000);
    a.on('message', (buf) => {
      let m = null;
      try { m = JSON.parse(buf.toString()); } catch (e) {}
      if (m && m.t === 'tick' && Array.isArray(m.r) && m.r.length) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
  return { ws: a, other: b, tick: firstTick };
}

async function main() {
  H.group('wsdeflate — permessage-deflate negotiates on the real server');
  const port1 = await freePort();
  let child1;
  try {
    child1 = await startServer(port1, {});
  } catch (e) {
    H.ok('server booted with permessage-deflate enabled (default config)', false, e.message);
    process.exit(H.report());
    return;
  }
  try {
    const { ws, other, tick } = await connectPairAndAwaitTick('ws://127.0.0.1:' + port1 + '/ws');
    H.ok('ws.extensions reports permessage-deflate actually negotiated (read off the client socket, not our own config)',
      ws.extensions.indexOf('permessage-deflate') >= 0, 'ws.extensions=' + JSON.stringify(ws.extensions));

    // Fidelity: a tick row is [id, lat5, lng5, hdg, parked] — assert the
    // shape and the 5-decimal-place rounding survive compression intact.
    const row = tick.r[0];
    H.ok('a tick row is a 5-element array', Array.isArray(row) && row.length === 5, JSON.stringify(row));
    const lat = row[1], lng = row[2];
    H.ok('lat round-trips to 5 decimal places', typeof lat === 'number' && Number(lat.toFixed(5)) === lat, 'lat=' + lat);
    H.ok('lng round-trips to 5 decimal places', typeof lng === 'number' && Number(lng.toFixed(5)) === lng, 'lng=' + lng);
    H.ok('heading is a number', typeof row[3] === 'number', 'hdg=' + row[3]);
    H.ok('parked flag is 0 or 1', row[4] === 0 || row[4] === 1, 'parked=' + row[4]);

    try { ws.close(); } catch (e) {}
    try { other.close(); } catch (e) {}
  } catch (e) {
    H.ok('connected a guest client pair and received a tick frame over the deflate-enabled server', false, e.message);
  } finally {
    await stopServer(child1);
  }

  H.group('wsdeflate — WS_DEFLATE=0 kill switch disables the extension end to end');
  const port2 = await freePort();
  let child2;
  try {
    child2 = await startServer(port2, { WS_DEFLATE: '0' });
  } catch (e) {
    H.ok('server booted with WS_DEFLATE=0', false, e.message);
    process.exit(H.report());
    return;
  }
  try {
    const { ws, other } = await connectPairAndAwaitTick('ws://127.0.0.1:' + port2 + '/ws');
    H.ok('ws.extensions is empty with WS_DEFLATE=0 (kill switch actually reaches the handshake)',
      ws.extensions === '', 'ws.extensions=' + JSON.stringify(ws.extensions));
    try { ws.close(); } catch (e) {}
    try { other.close(); } catch (e) {}
  } catch (e) {
    H.ok('connected a guest client pair and received a tick frame with the kill switch on (client still works)', false, e.message);
  } finally {
    await stopServer(child2);
  }

  process.exit(H.report());
}

main();
