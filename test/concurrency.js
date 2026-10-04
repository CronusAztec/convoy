/* Convoy — concurrency probe.

   NOT part of the default test run: needs a RUNNING SERVER and a REAL DATABASE.

       node server/server.js        # in one terminal
       npm run test:concurrent      # in another

   WHERE RACES CAN AND CANNOT HAPPEN HERE. The websocket handlers are all
   SYNCHRONOUS — the dispatcher calls h(c, m) with no await — so two frames can
   never interleave mid-handler, and most "what if two riders both…" worries are
   answered by that alone. The REST handlers ARE async and can interleave across
   an await. So the interesting cases are:

     · check-then-act across an await in the REST layer
     · caps (MAX_PARTY) enforced across several separate frames
     · the "one session per account" rule when two sockets arrive together

   Every case asserts an INVARIANT that must hold however the interleaving lands,
   never a particular winner — a test that expects a specific ordering under
   concurrency is a flaky test.

   The bug it found on its first run: registering the same username from six
   requests at once returned 502 to the five losers instead of "That username is
   taken". GoTrue's own duplicate check is a check-then-insert, so under a race
   the second insert fails on the database index and surfaces a raw Postgres
   unique-violation rather than the tidy email_exists — which nothing classified.
   Sequentially it never reproduces. Double-tapping Create account on a slow
   connection is exactly this. */
'use strict';
const WebSocket = require('../server/node_modules/ws');
const BASE = 'http://localhost:5173';
const MAX_PARTY = 6;
const PW = 'concpw12345';

let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + (x !== undefined ? '  ' + JSON.stringify(x) : ''))); };
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, m, b, t) {
  const h = { 'Content-Type': 'application/json' };
  if (t) h.Authorization = 'Bearer ' + t;
  try {
    const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}
const prof = (n) => ({ name: n, handle: n, emoji: 0, vibe: 'x',
  car: { year: 2020, make: 'Honda', model: 'Civic', trim: '', paint: '#ffffff', paintName: 'W', finish: 'Gloss' } });

function open(tok, p, pos) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://localhost:5173/ws');
    const f = [];
    ws.on('message', (b) => {
      let m; try { m = JSON.parse(b.toString()); } catch (e) { return; }
      f.push(m);
      if (m.t === 'welcome') res({ ws, id: m.id, frames: f, send: (x) => { try { ws.send(JSON.stringify(x)); } catch (e) {} }, close: () => { try { ws.close(); } catch (e) {} } });
      // MAX_PER_IP: the server refusing an 11th socket from one address is the
      // cap working, not a failure. Resolve as 'refused' so the caller can count it.
      if (m.t === 'err' && /Too many connections/i.test(m.msg || '')) res({ refused: true, close: () => { try { ws.close(); } catch (e) {} } });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: tok, profile: p, pos, heading: 0 })));
    ws.on('error', rej);
    setTimeout(() => res({ refused: true, close: () => { try { ws.close(); } catch (e) {} } }), 8000);
  });
}

// A FIXED pool, reused across runs. An earlier version registered ~19 fresh
// accounts each time, which spends the per-IP auth budget (24 per 10 min) before
// the later cases run — they then silently skipped, which looked like passing.
// Log in if they exist, register if not, and never delete them.
async function poolAccount(name) {
  const li = await api('/api/login', 'POST', { username: name, password: PW });
  if (li.status === 200 && li.body.token) return li.body.token;
  const rg = await api('/api/register', 'POST', { username: name, password: PW, profile: prof(name) });
  return rg.body.token || null;
}

(async () => {
  const s = Date.now().toString().slice(-6);
  const made = [];

  head('1. same username registered N times SIMULTANEOUSLY');
  {
    const name = 'zcnc' + s;
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () => api('/api/register', 'POST', { username: name, password: PW, profile: prof(name) }))
    );
    const wins = results.filter((r) => r.status === 200 && r.body.token);
    // Every request rate-limited means the case never ran. That is not a pass and
    // not a failure — asserting either would be a lie about what was observed.
    if (results.every((r) => r.status === 429)) {
      console.log('  ! all ' + N + ' requests were rate limited — case skipped.');
      console.log('    /api/register allows 24 per IP per 10 min; retry in ~10 min.');
    } else {
      ok('exactly one registration succeeds (got ' + wins.length + ' of ' + N + ')', wins.length === 1,
        results.map((r) => r.status));
      ok('the losers get a clean error, not a 500',
        results.filter((r) => r.status >= 500).length === 0, results.map((r) => r.status));
    }
    if (wins.length) made.push([name, wins[0].body.token]);
  }

  head('2. MAX_PARTY is not overshot by simultaneous joins');
  {
    // MAX_PARTY riders + 2 extra all trying to get into one convoy at once.
    const n = MAX_PARTY + 2;
    const toks = [];
    for (let i = 0; i < n; i++) {
      const t = await poolAccount('zzconcrider' + i);
      if (t) toks.push(t);
    }
    const all = [];
    for (let i = 0; i < toks.length; i++) all.push(await open(toks[i], prof('r' + i), [-118.25 + i * 0.0001, 34.05]));
    const riders = all.filter((r) => !r.refused);
    all.filter((r) => r.refused).forEach((r) => r.close());
    console.log('  (' + riders.length + ' sockets connected, ' + (all.length - riders.length) + ' refused by MAX_PER_IP)');
    // A cap test with fewer riders than the cap proves nothing. Say so loudly
    // rather than asserting against a pool that never assembled — a short pool
    // means the auth rate limit blocked it, not that the cap holds.
    if (riders.length <= MAX_PARTY) {
      console.log('  ! pool too small to exercise the cap (need > ' + MAX_PARTY + ') — skipped.');
      console.log('    the account pool needs a clear auth rate-limit window; retry in ~10 min.');
      riders.forEach((r) => r.close());
    } else {
    const host = riders[0];
    host.send({ t: 'party:create', name: 'cap', emoji: 0 });
    await sleep(400);
    // Fire every invite in the same tick, then every accept in the same tick.
    for (let i = 1; i < riders.length; i++) host.send({ t: 'party:invite', to: riders[i].id });
    await sleep(700);
    for (let i = 1; i < riders.length; i++) {
      const inv = riders[i].frames.filter((m) => m.t === 'invite').pop();
      if (inv) riders[i].send({ t: 'party:accept', pid: inv.party.id });
    }
    await sleep(1200);
    const st = host.frames.filter((m) => m.t === 'party').pop();
    const size = st ? st.party.members.length : -1;
    ok('convoy never exceeds MAX_PARTY=' + MAX_PARTY + ' (got ' + size + ')', size > 0 && size <= MAX_PARTY, size);
    riders.forEach((r) => r.close());
    }
    await sleep(300);
  }

  head('4. two sockets for ONE account — only one survives');
  {
    const u = 'zcns' + s;
    const r = await api('/api/register', 'POST', { username: u, password: PW, profile: prof(u) });
    if (r.body.token) {
      made.push([u, r.body.token]);
      const [a, b] = await Promise.all([
        open(r.body.token, prof(u), [-118.25, 34.05]),
        open(r.body.token, prof(u), [-118.25, 34.05])
      ]);
      await sleep(900);
      const aDead = a.ws.readyState >= 2, bDead = b.ws.readyState >= 2;
      ok('exactly one socket is closed', (aDead ? 1 : 0) + (bDead ? 1 : 0) === 1, { aDead, bDead });
      a.close(); b.close();
      await sleep(300);
    } else {
      console.log('  ! could not obtain test accounts (rate limited) — skipped.');
    }
  }

  head('5. mutual friend:add at the same instant');
  {
    const u1 = 'zcnf' + s + 'a', u2 = 'zcnf' + s + 'b';
    const r1 = await api('/api/register', 'POST', { username: u1, password: PW, profile: prof(u1) });
    const r2 = await api('/api/register', 'POST', { username: u2, password: PW, profile: prof(u2) });
    if (r1.body.token && r2.body.token) {
      made.push([u1, r1.body.token], [u2, r2.body.token]);
      const A = await open(r1.body.token, prof(u1), [-118.25, 34.05]);
      const B = await open(r2.body.token, prof(u2), [-118.2501, 34.05]);
      A.send({ t: 'friend:add', username: u2 });
      B.send({ t: 'friend:add', username: u1 });
      await sleep(1200);
      const af = A.frames.filter((m) => m.t === 'friends').pop();
      const bf = B.frames.filter((m) => m.t === 'friends').pop();
      const aCount = af ? (af.friends || []).filter((x) => x.username === u2).length : -1;
      const bCount = bf ? (bf.friends || []).filter((x) => x.username === u1).length : -1;
      ok('A lists B exactly once (got ' + aCount + ')', aCount === 1, af && af.friends);
      ok('B lists A exactly once (got ' + bCount + ')', bCount === 1, bf && bf.friends);
      ok('no dangling requests', !!(af && (af.requests || []).length === 0 && bf && (bf.requests || []).length === 0),
        { a: af && af.requests, b: bf && bf.requests });
      A.close(); B.close();
      await sleep(300);
    } else {
      console.log('  ! could not obtain test accounts (rate limited) — skipped.');
    }
  }

  head('6. concurrent block + unblock settles consistently');
  {
    const u1 = 'zcnb' + s + 'a', u2 = 'zcnb' + s + 'b';
    const r1 = await api('/api/register', 'POST', { username: u1, password: PW, profile: prof(u1) });
    const r2 = await api('/api/register', 'POST', { username: u2, password: PW, profile: prof(u2) });
    if (r1.body.token && r2.body.token) {
      made.push([u1, r1.body.token], [u2, r2.body.token]);
      const A = await open(r1.body.token, prof(u1), [-118.25, 34.05]);
      const B = await open(r2.body.token, prof(u2), [-118.2501, 34.05]);
      await sleep(600);
      // Hammer block/unblock in the same tick, ending on a block.
      for (let i = 0; i < 8; i++) {
        A.send({ t: 'block:add', to: B.id, username: u2 });
        A.send({ t: 'block:remove', userId: '' });          // bogus id in the middle
      }
      A.send({ t: 'block:add', to: B.id, username: u2 });
      await sleep(1500);
      const last = A.frames.filter((m) => m.t === 'block:list').pop();
      ok('block list has no duplicates', !!(last && last.blocked.length <= 1), last && last.blocked);
      ok('final state is blocked', !!(last && last.blocked.length === 1), last && last.blocked);
      A.close(); B.close();
      await sleep(300);
    } else {
      console.log('  ! could not obtain test accounts (rate limited) — skipped.');
    }
  }

  head('cleanup');
  let stranded = [];
  for (const [n, t] of made) {
    const d = await api('/api/account/delete', 'POST', { confirm: 'DELETE', password: PW }, t);
    if (d.status !== 200) stranded.push(n);
  }
  console.log('  deleted ' + (made.length - stranded.length) + '/' + made.length +
    (stranded.length ? ' — stranded: ' + stranded.join(', ') : ''));

  console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' : '✓ ') + pass + ' passed');
  process.exit(fail ? 1 : 0);
})();
