/* Convoy — race lifecycle, end to end.

   NOT part of the default test run: like test/block-integration.js it needs a
   RUNNING SERVER and a REAL DATABASE, and registers throwaway accounts it
   deletes in a finally block.

       node server/server.js            # in one terminal
       npm run test:race                # in another

   This exists because the race lifecycle has been the single buggiest corner of
   the server, and every bug in it had the same shape: a rider was charged a DNF
   and a race entry for something that was never a race. A DNF is permanent and
   public (it lands on the rider card), so getting it wrong is not cosmetic.

   The rule being pinned down is: only a race that reached the GREEN LIGHT
   records anything. There are three statuses — 'lobby', 'countdown', 'running' —
   and clients arm their timers on 'running', so anything cancelled before that
   never happened and must leave no trace on anyone's record.

   Each case below was a real bug:
     A  cancel from the lobby            -> DNF'd everyone
     B  host leaves during the countdown -> DNF'd everyone
     C  a genuine finish                 -> must still record, or the guard
                                            above has gone too far
   Case C is the control. Without it the other two would pass just as well with
   race recording removed entirely. */
'use strict';
const WebSocket = require('../server/node_modules/ws');

const BASE = 'http://localhost:5173';
const PW = 'racetest12345';
const stamp = Date.now().toString().slice(-6);
const A_NAME = 'zrcea' + stamp;
const B_NAME = 'zrceb' + stamp;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
function head(s) { console.log('\n' + s); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

function profileFor(n) {
  return { name: n, handle: n, emoji: 0, vibe: 'x',
    car: { year: 2020, make: 'Honda', model: 'Civic', trim: '',
           paint: '#ffffff', paintName: 'White', finish: 'Gloss' } };
}

function rider(token, profile, pos) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:5173/ws');
    const frames = [], waiters = [];
    const r = {
      ws, frames, id: null,
      send: (m) => ws.send(JSON.stringify(m)),
      want: (pred, ms) => new Promise((res) => {
        const hit = frames.find(pred);
        if (hit) return res(hit);
        const w = { pred, res };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); res(null); }
        }, ms || 3000);
      }),
      seen: (pred) => frames.filter(pred),
      lastState: () => frames.filter((m) => m.t === 'race:state').pop(),
      clear: () => { frames.length = 0; },
      close: () => { try { ws.close(); } catch (e) {} }
    };
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      frames.push(m);
      if (m.t === 'welcome') { r.id = m.id; resolve(r); }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { waiters[i].res(m); waiters.splice(i, 1); }
      }
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, profile, pos, heading: 0 })));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
}

// Stand a race up with both riders in it and both staged.
async function lobbyWith(A, B) {
  A.clear(); B.clear();
  A.send({ t: 'race:create', modeId: '0-60' });
  const created = await A.want((m) => m.t === 'race:state' && m.race);
  if (!created) return null;
  B.send({ t: 'race:join', id: created.race.id });
  await sleep(500);
  A.send({ t: 'race:ready', on: true });
  B.send({ t: 'race:ready', on: true });
  await sleep(400);
  return created.race.id;
}

(async () => {
  let aTok = null, bTok = null;
  let A = null, B = null;
  try {
    head('setup');
    const ra = await api('/api/register', 'POST', { username: A_NAME, password: PW, profile: profileFor(A_NAME) });
    const rb = await api('/api/register', 'POST', { username: B_NAME, password: PW, profile: profileFor(B_NAME) });
    aTok = ra.body.token; bTok = rb.body.token;
    ok('registered both', !!aTok && !!bTok, { a: ra.status, b: rb.status });
    if (!aTok || !bTok) throw new Error('registration failed');

    A = await rider(aTok, profileFor(A_NAME), [-118.25, 34.05]);
    B = await rider(bTok, profileFor(B_NAME), [-118.2505, 34.0505]);

    head('A. cancelling from the lobby records nothing');
    let id = await lobbyWith(A, B);
    ok('lobby stood up', !!id);
    A.clear(); B.clear();
    A.send({ t: 'race:end' });
    await sleep(700);
    ok('A race torn down (not "finished")',
      A.seen((m) => m.t === 'race:state' && m.race === null).length === 1,
      A.seen((m) => m.t === 'race:state').map((m) => m.race && m.race.status));
    ok('B race torn down too',
      B.seen((m) => m.t === 'race:state' && m.race === null).length === 1,
      B.seen((m) => m.t === 'race:state').map((m) => m.race && m.race.status));
    ok('nobody is shown a results screen',
      A.seen((m) => m.t === 'race:state' && m.race && m.race.status === 'finished').length === 0);

    head('B. host leaving during the countdown records nothing');
    id = await lobbyWith(A, B);
    ok('lobby stood up', !!id);
    A.clear(); B.clear();
    A.send({ t: 'race:start' });
    const counting = await A.want((m) => m.t === 'race:state' && m.race && m.race.status === 'countdown');
    ok('countdown started', !!counting, counting && counting.race.status);
    // Leave mid-countdown, well before the 3s green light.
    await sleep(600);
    A.send({ t: 'race:leave' });
    await sleep(900);
    ok('B is torn down, not handed a leaderboard',
      B.seen((m) => m.t === 'race:state' && m.race === null).length === 1,
      B.seen((m) => m.t === 'race:state').map((m) => m.race && m.race.status));
    ok('B never sees a finished race',
      B.seen((m) => m.t === 'race:state' && m.race && m.race.status === 'finished').length === 0);

    head('C. a race that actually runs still records  <- the control');
    id = await lobbyWith(A, B);
    ok('lobby stood up', !!id);
    A.clear(); B.clear();
    A.send({ t: 'race:start' });
    const running = await A.want((m) => m.t === 'race:state' && m.race && m.race.status === 'running', 6000);
    ok('reached the green light', !!running, running && running.race.status);
    if (running) {
      // A finishes, B never does -> B is a legitimate DNF.
      A.send({ t: 'race:finish', time: 5.5, trap: 60 });
      await sleep(400);
      A.send({ t: 'race:end' });
      const done = await A.want((m) => m.t === 'race:state' && m.race && m.race.status === 'finished', 4000);
      ok('race finishes properly', !!done, done && done.race.status);
      const me = done && done.race.members.filter((x) => x.id === A.id)[0];
      ok('A recorded as finished', !!(me && me.finished && me.time === 5.5), me);
      const them = done && done.race.members.filter((x) => x.id === B.id)[0];
      ok('B recorded as a DNF  <- a real race must still record', !!(them && them.dnf), them);
    }

    // Printed so the run counters can be checked in SQL: exactly one race ran,
    // so each rider should end on runs = 1 and A on wins = 1.
    console.log('\n  (verify in SQL: ' + A_NAME + ' runs=1 wins=1, ' + B_NAME + ' runs=1 wins=0)');
  } catch (e) {
    fail++; console.log('\nTHREW: ' + e.message);
  } finally {
    if (A) A.close();
    if (B) B.close();
    head('cleanup');
    for (const [n, t] of [[A_NAME, aTok], [B_NAME, bTok]]) {
      if (!t) continue;
      const d = await api('/api/account/delete', 'POST', { confirm: 'DELETE', password: PW }, t);
      ok('deleted ' + n, d.status === 200, d.body);
    }
    console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' : '✓ ') + pass + ' passed');
    process.exit(fail ? 1 : 0);
  }
})();
