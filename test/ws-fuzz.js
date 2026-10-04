/* Convoy — websocket handler fuzz.

   NOT part of the default test run: needs a RUNNING SERVER and a REAL DATABASE.

       node server/server.js        # in one terminal
       npm run test:fuzz            # in another, then read the server's output

   HOW TO READ THE RESULT. This suite does not assert — it provokes. The
   dispatcher wraps every handler in try/catch and logs '[handler <t>] <message>',
   so a handler that throws is INVISIBLE to the client: the frame is simply
   ignored and the action silently never happens. That is the class of bug this
   is hunting, and it can only be seen in the SERVER's output. After a run, the
   server should have logged neither of:

       [handler …]        a handler threw
       [db] DROPPED …     a write was queued that could never succeed

   Anything else means a real finding.

   WHY IT IS STATEFUL. A stateless pass over the same handlers found nothing,
   because nearly all of them bail on a guard before touching anything: 'chat'
   returns without a party, 'party:kick'
   without being host. The interesting code sits past those guards. So this
   drives two real accounts INTO the states first — friends, a shared convoy, a
   — and fuzzes from there, rebuilding the state between rounds
   because the fuzzing tears it down. It also fuzzes the REST surface.

   Two bugs it found on its first run, both invisible from the client side:
     · 'constructor' as a rider id resolved through the account index's PROTOTYPE
       to a Function, sailed past every `if (!u)` guard, and threw on the first
       field access. Fixed by giving the indexes a null prototype.
     · friend:decline queued a Postgres DELETE against a non-account, so any
       client could spend a real database round-trip per frame on a write that
       could never succeed. */
'use strict';
const WebSocket = require('../server/node_modules/ws');
const BASE = 'http://localhost:5173';
const PW = 'fuzzpw12345';

const NASTY = [
  null, 0, -1, NaN, Infinity, -Infinity, '', 'x'.repeat(3000), true, false,
  [], {}, [[[[1]]]], '__proto__', 'constructor', 'toString', 'prototype',
  1e308, -1e308, 0.5, '12abc', '\u0000\uffff\ud800', '<img onerror=x>',
  { lng: 'a', lat: 'b' }, [null, null], [999, 999], [-999, -999], [0],
  { length: 1e9 }, { valueOf: null }, '-0', '1e999', '0x10'
];
const FIELDS = ['pos', 'heading', 'mode', 'profile', 'on', 'name', 'emoji', 'to',
  'id', 'pid', 'code', 'text', 'username', 'userId', 'payload', 'chunk', 'rate',
  'modeId', 'time', 'trap', 'lng', 'lat', 'kind', 'label', 'clear', 'speed',
  'acc', 'ts', 'from', 'sys'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
let sent = 0;

async function api(path, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}

function profileFor(n) {
  return { name: n, handle: n, emoji: 0, vibe: 'x',
    car: { year: 2020, make: 'Honda', model: 'Civic', trim: '',
           paint: '#ffffff', paintName: 'White', finish: 'Gloss' } };
}

function open(token, profile, pos) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:5173/ws');
    const frames = [];
    ws.on('message', (b) => {
      let m; try { m = JSON.parse(b.toString()); } catch (e) { return; }
      frames.push(m);
      if (m.t === 'welcome') resolve({ ws, id: m.id, frames, send: (x) => { try { ws.send(JSON.stringify(x)); sent++; } catch (e) {} } });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, profile, pos, heading: 0 })));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
}

function fuzzFrame(t) {
  const msg = { t };
  const n = 1 + Math.floor(Math.random() * 6);
  for (let k = 0; k < n; k++) msg[rnd(FIELDS)] = rnd(NASTY);
  return msg;
}

(async () => {
  /* FIXED accounts, reused across runs — not fresh ones each time.

     Cleanup used to delete them at the end, which does not work: the delete
     endpoint allows 10 per IP per TEN MINUTES, and a fuzz run spends that budget
     long before it finishes. Every repeat run then orphaned two more accounts.

     Reusing a fixed pair removes the problem rather than working around it. Log
     in if they exist, register if they do not. Pass --cleanup to remove them when
     you are done fuzzing for the day. */
  const AN = 'zzfuzzrider_a', BN = 'zzfuzzrider_b';
  async function ensure(name) {
    const li = await api('/api/login', 'POST', { username: name, password: PW });
    if (li.status === 200 && li.body.token) return li.body.token;
    const rg = await api('/api/register', 'POST', { username: name, password: PW, profile: profileFor(name) });
    return rg.body.token || null;
  }
  const aTok = await ensure(AN), bTok = await ensure(BN);
  if (!aTok || !bTok) { console.log('could not obtain fuzz accounts'); process.exit(1); }

  if (process.argv.includes('--cleanup')) {
    let blocked = false;
    for (const [nm, tk] of [[AN, aTok], [BN, bTok]]) {
      const d = await api('/api/account/delete', 'POST', { confirm: 'DELETE', password: PW }, tk);
      if (d.status === 429) blocked = true;
      console.log('cleanup ' + nm + ': ' + (d.status === 200 ? 'deleted' : JSON.stringify(d.body)));
    }
    // Not a bug in either side. Deletion is capped at 10 per IP per ten minutes,
    // and a fuzz run spends that budget on purpose — which is exactly why these
    // accounts are reused rather than created fresh each time. Say so, instead of
    // leaving someone staring at a rate-limit error they did not cause.
    if (blocked) {
      console.log('\n  The delete endpoint is rate limited (10 per IP / 10 min) and this run,');
      console.log('  or a recent fuzz, has used it up. Wait ten minutes and re-run --cleanup.');
      console.log('  Leaving them in place is harmless: the next fuzz run reuses them.');
    }
    process.exit(0);
  }
  console.log('stateful fuzz as ' + AN + ' / ' + BN);

  const A = await open(aTok, profileFor(AN), [-118.25, 34.05]);
  const B = await open(bTok, profileFor(BN), [-118.2505, 34.0505]);

  // ---- become friends, so the friend handlers have real state ----
  A.send({ t: 'friend:add', username: BN });
  await sleep(400);
  B.send({ t: 'friend:add', username: AN });   // auto-accepts
  await sleep(600);

  const PARTY_H = ['party:rally', 'party:invite', 'party:accept', 'party:decline',
    'party:kick', 'party:mode', 'party:join', 'party:sys', 'chat', 'wave',
    'voice:signal', 'voice:relay', 'voice:mic', 'voice:prox'];
  const OTHER_H = ['pos', 'profile', 'ghost', 'block:add', 'block:remove',
    'friend:add', 'friend:accept', 'friend:decline', 'friend:remove',
    'party:create'];

  // ---- round 1: inside a convoy ----
  for (let round = 0; round < 6; round++) {
    A.send({ t: 'party:create', name: 'fuzz', emoji: 0 });
    await sleep(250);
    A.send({ t: 'party:invite', to: B.id });
    await sleep(250);
    const inv = B.frames.filter((m) => m.t === 'invite').pop();
    if (inv) { B.send({ t: 'party:accept', pid: inv.party.id }); await sleep(350); }
    for (const t of PARTY_H) {
      for (let i = 0; i < 20; i++) { A.send(fuzzFrame(t)); B.send(fuzzFrame(t)); }
    }
    await sleep(150);
    A.send({ t: 'party:leave' }); B.send({ t: 'party:leave' });
    await sleep(200);
  }

  // ---- round 2: everything else, plus interleaved valid state churn ----
  for (let round = 0; round < 8; round++) {
    for (const t of OTHER_H) {
      for (let i = 0; i < 15; i++) { A.send(fuzzFrame(t)); B.send(fuzzFrame(t)); }
    }
    A.send({ t: 'pos', pos: [-118.25 + Math.random() * 0.01, 34.05], heading: 90 });
    B.send({ t: 'ghost', on: round % 2 === 0 });
    await sleep(120);
  }

  await sleep(1500);
  console.log('sent ' + sent + ' frames from inside real convoy/friend state');

  // ---- REST surface, same values ----
  let restCalls = 0;
  const REST = [
    ['/api/report', 'POST'], ['/api/account/delete', 'POST'], ['/api/profile', 'POST'],
    ['/api/route', 'POST']
  ];
  for (const [path, method] of REST) {
    for (let i = 0; i < 12; i++) {
      const body = {};
      for (let k = 0; k < 4; k++) body[rnd(FIELDS)] = rnd(NASTY);
      await api(path, method, body, Math.random() < 0.5 ? aTok : null);
      restCalls++;
    }
  }
  console.log('sent ' + restCalls + ' malformed REST bodies');

  // Leave the two accounts in place — see the note at the top of main(). They
  // are reused by the next run, and 'npm run test:fuzz -- --cleanup' removes them.
  try { A.ws.close(); B.ws.close(); } catch (e) {}
  await sleep(300);
  console.log('');
  console.log('now read the SERVER output: any [handler …] or [db] DROPPED line is a finding.');
  process.exit(0);
})();
