/* Convoy — blocking + reporting, end to end.

   NOT part of Unknown command: "test"


Did you mean this?
  npm test # Test a package
To see a list of supported npm commands, run:
  npm help. Unlike every other suite here this one needs a
   RUNNING SERVER and a REAL DATABASE — it registers two throwaway accounts,
   drives them against each other over the actual websocket, and deletes both in
   a finally block whatever happens. Putting it in the default run would make
   Unknown command: "test"


Did you mean this?
  npm test # Test a package
To see a list of supported npm commands, run:
  npm help fail on any machine without a configured Supabase project.

       node server/server.js            # in one terminal
       npm run test:blocking            # in another

   What it is really checking is that a block cannot be routed around. Each
   numbered step is a path that reached the other rider before it was closed:
   the map, the convoy roster and chat backlog, invites, waves, friend requests,
   and races (race:fix streams live GPS, so that one mattered most). Step 2b
   guards an ordering bug — the client refuses rider:remove for a convoy member,
   so the roster update has to go first. */
'use strict';
const WebSocket = require('../server/node_modules/ws');

const BASE = 'http://localhost:5173';
const PW = 'blocktest12345';
const A_NAME = 'zblka' + Date.now().toString().slice(-6);
const B_NAME = 'zblkb' + Date.now().toString().slice(-6);

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
function head(s) { console.log('\n' + s); }

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

// A websocket wrapper that records every frame so tests can await one.
function rider(token, profile, pos) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:5173/ws');
    const frames = [];
    const waiters = [];
    const r = {
      ws, frames, id: null,
      send: (m) => ws.send(JSON.stringify(m)),
      // Resolve when a frame matching `pred` arrives (or already has).
      want: (pred, ms) => new Promise((res) => {
        const hit = frames.find(pred);
        if (hit) return res(hit);
        const w = { pred, res };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); res(null); }
        }, ms || 2500);
      }),
      seen: (pred) => frames.filter(pred),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let aTok = null, bTok = null, aId = null, bId = null;
  try {
    head('setup: two accounts');
    const ra = await api('/api/register', 'POST', { username: A_NAME, password: PW, profile: profileFor(A_NAME) });
    const rb = await api('/api/register', 'POST', { username: B_NAME, password: PW, profile: profileFor(B_NAME) });
    aTok = ra.body.token; bTok = rb.body.token;
    ok('registered A', !!aTok); ok('registered B', !!bTok);
    if (!aTok || !bTok) throw new Error('registration failed');

    // Same spot, well inside the 30km nearby radius.
    const A = await rider(aTok, profileFor(A_NAME), [-118.25, 34.05]);
    const B = await rider(bTok, profileFor(B_NAME), [-118.2505, 34.0505]);
    aId = A.id; bId = B.id;

    head('1. they can see each other before any block');
    const sawB = await A.want((m) => m.t === 'rider:add' && m.rider && m.rider.id === bId);
    const sawA = await B.want((m) => m.t === 'rider:add' && m.rider && m.rider.id === aId);
    ok('A sees B', !!sawB);
    ok('B sees A', !!sawA);

    head('2. welcome carries an (empty) block list');
    const wa = A.frames.find((m) => m.t === 'welcome');
    ok('welcome.account.blocked is an array', Array.isArray(wa && wa.account && wa.account.blocked), wa && wa.account);
    ok('starts empty', wa && wa.account && wa.account.blocked.length === 0);

    head('2b. blocking a CONVOY MATE clears them from both rosters');
    // The hard case: the client refuses rider:remove for a party member, so the
    // server must drop them from the roster first.
    A.clear(); B.clear();
    A.send({ t: 'party:create', name: 'shared', emoji: 0 });
    await sleep(400);
    A.send({ t: 'party:invite', to: bId });
    const inv = await B.want((m) => m.t === 'invite');
    ok('B was invited', !!inv);
    if (inv) { B.send({ t: 'party:accept', pid: inv.party.id }); await sleep(600); }
    const bothIn = A.frames.filter((m) => m.t === 'party').pop();
    ok('both in the convoy', !!(bothIn && bothIn.party.members.length === 2), bothIn && bothIn.party.members);

    A.clear(); B.clear();
    A.send({ t: 'block:add', to: bId, username: B_NAME });
    await sleep(900);
    const aParty = A.frames.filter((m) => m.t === 'party').pop();
    const bParty = B.frames.filter((m) => m.t === 'party').pop();
    ok('A no longer sees B in the roster',
      !!(aParty && !aParty.party.members.some((x) => x.id === bId)), aParty && aParty.party.members);
    ok('B no longer sees A in the roster',
      !!(bParty && !bParty.party.members.some((x) => x.id === aId)), bParty && bParty.party.members);

    const aIdxParty = A.frames.findIndex((m) => m.t === 'party');
    const aIdxRemove = A.frames.findIndex((m) => m.t === 'rider:remove' && m.id === bId);
    ok('roster update precedes rider:remove  <- else the client refuses it',
      aIdxParty >= 0 && aIdxRemove >= 0 && aIdxParty < aIdxRemove,
      { party: aIdxParty, remove: aIdxRemove });

    // clean up so the numbered steps below start from a known state
    A.send({ t: 'block:remove', userId: (await A.want((m) => m.t === 'block:list')).blocked[0].id });
    await sleep(500);
    A.send({ t: 'party:leave' }); B.send({ t: 'party:leave' });
    await sleep(500);
    A.clear(); B.clear();

    head('3. A blocks B');
    A.clear(); B.clear();
    A.send({ t: 'block:add', to: bId });
    const list = await A.want((m) => m.t === 'block:list');
    ok('A gets the canonical block list', !!list);
    ok('list names B', !!(list && list.blocked.length === 1 && list.blocked[0].username === B_NAME), list && list.blocked);

    head('4. the block is symmetric and immediate');
    const aDrop = await A.want((m) => m.t === 'rider:remove' && m.id === bId);
    const bDrop = await B.want((m) => m.t === 'rider:remove' && m.id === aId);
    ok('B disappears from A', !!aDrop);
    ok('A disappears from B  <- symmetric', !!bDrop, 'one-way block would leak the blocker position');

    head('5. blocked riders do not come back on re-scope');
    A.clear(); B.clear();
    A.send({ t: 'pos', pos: [-118.2502, 34.0502], heading: 10 });
    B.send({ t: 'pos', pos: [-118.2503, 34.0503], heading: 10 });
    await sleep(1800);
    ok('A never re-adds B', A.seen((m) => m.t === 'rider:add' && m.rider && m.rider.id === bId).length === 0);
    ok('B never re-adds A', B.seen((m) => m.t === 'rider:add' && m.rider && m.rider.id === aId).length === 0);

    head('6. chat does not cross the block');
    A.clear(); B.clear();
    B.send({ t: 'party:create', name: 'test', emoji: 0 });
    await sleep(400);
    B.send({ t: 'party:invite', to: aId });
    await sleep(500);
    ok('invite from a blocked rider never arrives', A.seen((m) => m.t === 'invite').length === 0);

    head('7. a wave does not cross the block');
    A.clear();
    B.send({ t: 'wave', to: aId });
    await sleep(500);
    ok('wave never arrives', A.seen((m) => m.t === 'wave').length === 0);

    head('8. friend-add is refused without confirming the block');
    const fr = await api('/api/me', 'GET', null, aTok);
    A.clear();
    A.send({ t: 'friend:add', username: B_NAME });
    const ferr = await A.want((m) => m.t === 'err' || m.t === 'friend:result');
    ok('refused', !!(ferr && ferr.t === 'err'), ferr);
    ok('message does not reveal the block',
      !!(ferr && /No rider with that username/i.test(ferr.msg || '')), ferr && ferr.msg);

    head('9. reporting');
    const bad = await api('/api/report', 'POST', { riderId: bId, reason: 'nonsense' }, aTok);
    ok('rejects an unknown reason', bad.status === 400, bad.body);
    const noauth = await api('/api/report', 'POST', { riderId: bId, reason: 'harassment' }, null);
    ok('requires auth', noauth.status === 401, noauth.body);
    const self = await api('/api/report', 'POST', { riderId: aId, reason: 'harassment' }, aTok);
    ok('refuses self-report', self.status === 400, self.body);
    const rep = await api('/api/report', 'POST', {
      riderId: bId, reason: 'harassment', detail: 'integration test',
      context: 'chat', evidence: { quoted: 'a rude message', at: Date.now() }
    }, aTok);
    ok('accepts a valid report', rep.status === 200 && !!rep.body.id, rep.body);

    head('9b. a race cannot be used to route around a block');
    // Both are still blocked at this point. B hosts, A tries to join.
    A.clear(); B.clear();
    B.send({ t: 'race:create', modeId: '0-60' });
    await sleep(500);
    const bRace = B.frames.filter((m) => m.t === 'race:state').pop();
    ok('B created a race', !!bRace, bRace);
    if (bRace) {
      A.send({ t: 'race:join', id: bRace.race.id });
      const joinErr = await A.want((m) => m.t === 'err' || m.t === 'race:state');
      ok('A is refused entry', !!(joinErr && joinErr.t === 'err'), joinErr);
      ok('refusal names nobody',
        !!(joinErr && !/blocked/i.test(joinErr.msg || '')), joinErr && joinErr.msg);
    }
    // And an invite from the blocked host never lands.
    A.clear();
    B.send({ t: 'race:invite', to: aId });
    await sleep(500);
    ok('race invite never arrives', A.seen((m) => m.t === 'race:invite').length === 0);
    B.send({ t: 'race:end' });
    await sleep(300);

    head('10. unblock restores visibility');
    A.clear(); B.clear();
    const bUserId = list && list.blocked[0] && list.blocked[0].id;
    A.send({ t: 'block:remove', userId: bUserId });
    const cleared = await A.want((m) => m.t === 'block:list');
    ok('list is empty again', !!(cleared && cleared.blocked.length === 0), cleared && cleared.blocked);
    const back = await A.want((m) => m.t === 'rider:add' && m.rider && m.rider.id === bId, 3000);
    ok('B reappears on A without a reconnect', !!back);

    A.close(); B.close();
  } catch (e) {
    fail++; console.log('\nTHREW: ' + e.message);
  } finally {
    head('cleanup');
    for (const [n, t] of [[A_NAME, aTok], [B_NAME, bTok]]) {
      if (!t) continue;
      const d = await api('/api/account/delete', 'POST', { confirm: 'DELETE', password: PW }, t);
      ok('deleted ' + n, d.status === 200, d.body);
    }
    console.log('\n' + (fail ? '\u2717 ' + fail + ' failed, ' : '\u2713 ') + pass + ' passed');
    process.exit(fail ? 1 : 0);
  }
})();
