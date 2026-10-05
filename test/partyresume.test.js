/* Convoy — a convoy survives a tunnel. `npm test` (test/run.js)

   Why this exists (BUGS.md server-035 / frontend-022 / frontend-023, cycle 58):
   `ws.on('close')` in server/server.js ran `leaveParty(c, false)` — a rider
   whose phone lost signal for three seconds was removed from their convoy for
   good, everyone was told they "left", and the client threw the roster, links
   and chat away with it (js/net.js teardownLive()). Nothing rejoined: party:join
   by code is refused for the default invite-only mode, and no client path ever
   re-sent one. The reconnect almost always arrives while the OLD socket is
   still open server-side (the client retries in 2 s; the ping reaper needs
   30-60 s), so a fix that only remembered seats at close time would almost
   never fire.

   The fix: the server holds the seat for PARTY_GRACE_MS (90 s) and hands every
   socket a resume token inside its own `welcome`; the next `hello` carrying
   that token drops the rider straight back into the same convoy — whether the
   old socket was already reaped (resumeSeats) or is still half-open
   (seatOwner). The client echoes the token, keeps the roster on screen only
   while the server can still be holding the seat, and the server's `resumed`
   answer always wins over the client's optimism.

   Four groups:
     R1  server, lift-and-execute (the test/serverpolicy.test.js D1/X1 idiom):
         the REAL close handler, the REAL `hello` handler, joinParty/leaveParty
         and the seat functions are sliced out of server/server.js by text and
         RUN over fake maps. Against the unfixed tree the same slices run the
         file's own pre-fix behaviour, so every red line here is a rider who
         came back from a tunnel and was not in their convoy — never a missing
         name.
     R2  ordering + wiring pins, source-parsed: claimSeat BEFORE the welcome
         frame (so `resumed` is truthful), restoreSeat AFTER it (the client
         needs its own id before the roster), the close handler's hold-then-
         leave order, joinParty's third parameter and its untouched call sites,
         the token width, the default window, the .env.example entry.
     R3  the cross-file pin that outlives this cycle: js/net.js PARTY_GRACE_MS
         must be <= server/server.js PARTY_GRACE_MS. A client that keeps the
         roster after the server let the seat go is showing the rider a convoy
         they are no longer in.
     R4  client, executed: the REAL js/net.js and js/party.js through the
         test/net.test.js FakeWS harness — token echo, the graced roster, the
         honesty rule, the one grace timer, chat typed in the tunnel, explicit
         leaves, the stale-socket guard, the token never touching storage.

   When this fails: read the check label — each names its scenario (half-open,
   reaped, expired, single use, wrong account, disbanded, full, kill switch,
   bounded) or the pin it protects. Never raise the client grace above the
   server's; lower the server's only together with the client's. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { group, ok, ROOT } = H;

const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const NET_SRC = fs.readFileSync(path.join(ROOT, 'js', 'net.js'), 'utf8');
const PARTY_SRC = fs.readFileSync(path.join(ROOT, 'js', 'party.js'), 'utf8');
const ENV_SRC = fs.readFileSync(path.join(ROOT, 'server', '.env.example'), 'utf8');

const MAX_PARTY = (() => { const m = SRC.match(/^const MAX_PARTY = (\d+);/m); return m ? parseInt(m[1], 10) : 6; })();

/* ---------------- slicing (the serverpolicy.test.js idiom) ---------------- */
function sliceTop(head) {                       // `function name(…) {` … `\n}\n`, inclusive
  const at = SRC.indexOf(head);
  if (at < 0) return '';
  const end = SRC.indexOf('\n}\n', at);
  return end > at ? SRC.slice(at, end + 3) : '';
}
function sliceBetween(open, close) {            // the body between an opener and its closer
  const at = SRC.indexOf(open);
  if (at < 0) return null;
  const end = SRC.indexOf(close, at + open.length);
  return end > at ? SRC.slice(at + open.length, end) : null;
}
const constsAt = SRC.indexOf('const PARTY_GRACE_MS = ');
const ownerAt = constsAt >= 0 ? SRC.indexOf('const seatOwner = new Map();', constsAt) : -1;
const CONSTS = (constsAt >= 0 && ownerAt > constsAt) ? SRC.slice(constsAt, SRC.indexOf('\n', ownerAt) + 1) : '';
const SEAT_FNS = {
  pruneSeats: sliceTop('function pruneSeats(now) {'),
  rememberSeat: sliceTop('function rememberSeat(rider, now) {'),
  claimSeat: sliceTop('function claimSeat(rider, token, now) {'),
  restoreSeat: sliceTop('function restoreSeat(rider, party) {')
};
const JOIN = sliceTop('function joinParty(rider, party');
const LEAVE = sliceTop('function leaveParty(rider, silent) {');
const HELLO_BODY = sliceBetween('\n  hello(c, m) {', '\n  },\n');
const CLOSE_BODY = sliceBetween("  ws.on('close', () => {", '\n  });\n');
const LIFTED = !!CONSTS && Object.keys(SEAT_FNS).every((k) => !!SEAT_FNS[k]);

/* A world: the real party functions + the real close/hello handlers over fake
   maps. Every scenario builds its own. `opts.env` reaches the lifted
   `process.env` read (the kill switch is exercised through the real
   expression, not a spliced literal); `opts.users` backs userFromToken. */
function world(opts) {
  opts = opts || {};
  const clock = { now: opts.now || 1000 };
  const FakeDate = { now: () => clock.now };
  const parties = new Map(), clients = new Map(), bots = new Map(), online = new Map(), ipCount = new Map(), partyByCode = new Map();
  const sent = [], sys = [];
  const send = (c, m) => sent.push({ to: c.id, m });
  const partySys = (party, text) => {
    sys.push(text);
    party.chat.push({ sys: true, text, t: clock.now });
    if (party.chat.length > 100) party.chat.shift();
  };
  const riderName = (r) => (r.bot ? r.name : r.profile.name);
  const getRider = (id) => bots.get(id) || clients.get(id) || null;
  const sendPartyState = (party) => {
    for (const id of party.members) {
      const c = clients.get(id);
      if (c) send(c, { t: 'party', party: { id: party.id, leader: party.leader, members: party.members.slice(), chat: party.chat.slice() } });
    }
  };
  // Pre-fix stand-ins: exactly what the file did before server-035 — nothing
  // remembered, nothing claimed. joinParty/leaveParty are always the real ones.
  const preFix = 'const PARTY_GRACE_MS = 0, RESUME_MAX = 0; const resumeSeats = new Map(); const seatOwner = new Map();\n' +
    'function pruneSeats() {}\nfunction rememberSeat() { return false; }\nfunction claimSeat() { return null; }\nfunction restoreSeat() { return false; }\n';
  const src = (LIFTED ? CONSTS + Object.keys(SEAT_FNS).map((k) => SEAT_FNS[k]).join('\n') : preFix) + '\n' + JOIN + '\n' + LEAVE +
    '\nreturn { pruneSeats, rememberSeat, claimSeat, restoreSeat, joinParty, leaveParty, resumeSeats, seatOwner, PARTY_GRACE_MS, RESUME_MAX };';
  const api = new Function('parties', 'partyByCode', 'clients', 'bots', 'send', 'partySys', 'riderName', 'getRider', 'sendPartyState', 'MAX_PARTY', 'process',
    src)(parties, partyByCode, clients, bots, send, partySys, riderName, getRider, sendPartyState, MAX_PARTY, { env: opts.env || {} });
  const noop = () => {};
  const store = { blockList: () => [], getById: () => null };
  const quiet = { log: noop, warn: noop, error: noop };
  const onClose = new Function('c', 'seatOwner', 'rememberSeat', 'leaveParty', 'leaveRace', 'clients', 'ipCount', 'online',
    'store', 'notifyFriendsOf', 'recomputeHumans', 'humans', 'console', 'assignAnchors', 'Date', 'packs', CLOSE_BODY || '');
  const helloFn = new Function('claimSeat', 'restoreSeat', 'userFromToken', 'send', 'online', 'friendsPayload', 'notifyFriendsOf',
    'sanitizeProfile', 'validPos', 'num', 'recomputeHumans', 'assignAnchors', 'syncScope', 'humans', 'store', 'riderRecord',
    'getRider', 'gated', 'anonymiseGlobal', 'buildGlobalFC', 'console', 'Date', 'packs',
    'return function hello(c, m) {' + (HELLO_BODY || '') + '\n};')(
    api.claimSeat, api.restoreSeat,
    (tok) => (opts.users && opts.users[tok]) || null,
    send, online, () => ({ friends: [], requests: [] }), noop,
    (p) => ({ name: (p && p.name) || 'guest', emoji: 0 }),
    () => false, () => 0, noop, noop, noop, () => [], store, () => null, getRider, () => false, (x) => x, () => ({}), quiet, FakeDate,
    // feature packs (server/packs/index.js): hello fills c.packs; the welcome frame lists it
    { onHello: (c) => { c.packs = new Set(); }, packsForSocket: (c) => (c.packs ? [...c.packs] : []) });

  function mk(id, o) {                              // the connection literal + the handler's registration
    o = o || {};
    const c = {
      id, ws: { readyState: 1, closed: false, close() { this.closed = true; this.readyState = 2; } }, ip: '10.0.0.1',
      userId: null, username: null, profile: null, pos: null, heading: 0, mode: 'cruise', party: null,
      known: new Set(), lastPosAt: 0, micActive: false, ghost: false, isAlive: true, resume: o.resume || ('tok-' + id)
    };
    ipCount.set(c.ip, (ipCount.get(c.ip) || 0) + 1);
    clients.set(c.id, c);
    api.seatOwner.set(c.resume, c);
    return c;
  }
  function hello(c, m) { helloFn(c, Object.assign({ t: 'hello', profile: { name: c.id } }, m || {})); }
  function close(c) { onClose(c, api.seatOwner, api.rememberSeat, api.leaveParty, noop, clients, ipCount, online, store, noop, noop, () => [], quiet, noop, FakeDate, { onClose: noop }); }
  function party(id, members, leader) {
    const p = { id, name: 'Night Run', emoji: 0, code: id.toUpperCase(), leader, members: members.map((c) => c.id), chat: [], mode: 'invite', rally: null };
    parties.set(id, p);
    members.forEach((c) => { c.party = id; });
    return p;
  }
  const framesTo = (id) => sent.filter((s) => s.to === id).map((s) => s.m);
  const welcomeOf = (id) => framesTo(id).find((m) => m.t === 'welcome') || null;
  return { clock, parties, clients, sent, sys, api, mk, hello, close, party, framesTo, welcomeOf };
}

/* ================= R1 — server, lift-and-execute ================= */
group('R1 — server, executed: the real close + hello handlers over fake maps — a rider who comes back from a tunnel is still in their convoy (server-035)');
ok('server/server.js declares PARTY_GRACE_MS / RESUME_MAX / resumeSeats / seatOwner at module scope and pruneSeats / rememberSeat / claimSeat / restoreSeat as top-level functions (liftable)',
  LIFTED, 'consts=' + !!CONSTS + ' fns=' + JSON.stringify(Object.keys(SEAT_FNS).filter((k) => !SEAT_FNS[k])) + ' missing');
ok('the close handler and the hello handler can be sliced out of server.js (ws.on(\'close\') … / hello(c, m) { … })',
  !!CLOSE_BODY && !!HELLO_BODY && CLOSE_BODY.length > 200 && HELLO_BODY.length > 800, 'close=' + (CLOSE_BODY || '').length + ' hello=' + (HELLO_BODY || '').length);
ok('joinParty and leaveParty can be lifted (both non-trivial)', JOIN.length > 200 && LEAVE.length > 500, 'join=' + JOIN.length + ' leave=' + LEAVE.length);

// (a) half-open — the common case: the old socket is still OPEN server-side.
{
  const w = world();
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { profile: { name: 'Ana' } }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  const A2 = w.mk('A2');
  w.sent.length = 0; w.sys.length = 0;
  w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume });
  const toA2 = w.framesTo('A2');
  const wIdx = toA2.findIndex((m) => m.t === 'welcome'), pIdx = toA2.findIndex((m) => m.t === 'party');
  const welcome = w.welcomeOf('A2');
  ok('executed: half-open — a new socket carrying the old socket\'s token lands back in the convoy: roster [B, A2]',
    p1.members.join(',') === 'B,A2' && A2.party === 'p1', 'members=' + p1.members.join(',') + ' A2.party=' + A2.party);
  ok('executed: half-open — the old socket was closed and silently unseated (no "left the convoy" line)',
    A.ws.closed && A.party === null && !w.sys.some((t) => /left the convoy/.test(t)), 'closed=' + A.ws.closed + ' A.party=' + A.party + ' sys=' + w.sys.join(' | '));
  ok('executed: half-open — exactly one "Ana reconnected" line and NO "joined the convoy" line',
    w.sys.filter((t) => t === 'Ana reconnected').length === 1 && !w.sys.some((t) => /joined the convoy/.test(t)), 'sys=' + w.sys.join(' | '));
  ok('executed: half-open — the welcome says resumed:true and carries the NEW socket\'s own token',
    !!welcome && welcome.resumed === true && welcome.resume === A2.resume, 'welcome=' + JSON.stringify(welcome));
  ok('executed: half-open — the roster reaches the new socket AFTER its welcome (it needs its own id first)',
    wIdx >= 0 && pIdx > wIdx, 'welcome@' + wIdx + ' party@' + pIdx);
  ok('executed: half-open — the old token is spent (seatOwner no longer maps it) and the new one is live',
    !w.api.seatOwner.has(A.resume) && w.api.seatOwner.get(A2.resume) === A2);
  // (j) the old socket's close event fires later — it must not disturb the resumed seat
  w.sys.length = 0;
  w.close(A);
  ok('executed: the superseded socket\'s late close event leaves the resumed seat alone (roster still [B, A2], no new system line, A gone from clients)',
    p1.members.join(',') === 'B,A2' && w.sys.length === 0 && !w.clients.has('A'), 'members=' + p1.members.join(',') + ' sys=' + w.sys.join(' | '));
}

// (b) reaped, (d) single use
{
  const w = world({ now: 1000 });
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { profile: { name: 'Ana' } }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  w.sys.length = 0;
  w.close(A);                                           // the ping reaper terminated the socket
  ok('executed: reaped — the close handler holds the seat and tells the convoy the truth: "Ana lost signal", never "left the convoy"',
    w.sys.join(' | ') === 'Ana lost signal' && p1.members.join(',') === 'B' && w.api.resumeSeats.has(A.resume),
    'sys=' + w.sys.join(' | ') + ' members=' + p1.members.join(',') + ' held=' + w.api.resumeSeats.has(A.resume));
  w.clock.now = 21000;                                  // 20 s later
  const A2 = w.mk('A2');
  w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: reaped — 20 s later the same token puts the rider back: roster [B, A2], "Ana reconnected", welcome resumed:true',
    p1.members.join(',') === 'B,A2' && A2.party === 'p1' && w.sys.indexOf('Ana reconnected') >= 0 && !!w.welcomeOf('A2') && w.welcomeOf('A2').resumed === true,
    'members=' + p1.members.join(',') + ' sys=' + w.sys.join(' | ') + ' welcome=' + JSON.stringify(w.welcomeOf('A2')));
  const A3 = w.mk('A3');
  w.hello(A3, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: single use — replaying the same token claims nothing (roster still [B, A2], welcome resumed:false)',
    A3.party === null && p1.members.join(',') === 'B,A2' && !w.api.resumeSeats.has(A.resume) && w.welcomeOf('A3').resumed === false,
    'A3.party=' + A3.party + ' members=' + p1.members.join(','));
}

// (c) expired
{
  const w = world({ now: 1000 });
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { profile: { name: 'Ana' } }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  w.close(A);
  w.clock.now = 1000 + 91000;                           // 91 s later: the seat is gone
  const A2 = w.mk('A2');
  w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: expired — 91 s later the token is worthless: the rider lands convoy-less, roster still [B], welcome resumed:false, seat pruned',
    A2.party === null && p1.members.join(',') === 'B' && w.welcomeOf('A2').resumed === false && !w.api.resumeSeats.has(A.resume),
    'A2.party=' + A2.party + ' members=' + p1.members.join(',') + ' welcome=' + JSON.stringify(w.welcomeOf('A2')));
}

// (e) wrong account — a seat minted while signed in is bound to that account
{
  const users = {
    t1: { id: 'u1', username: 'ana', profile: { name: 'Ana' }, stats: { pb: {} } },
    t2: { id: 'u2', username: 'bo', profile: { name: 'Bo' }, stats: { pb: {} } }
  };
  const run = (claimToken) => {
    const w = world({ now: 1000, users });
    const A = w.mk('A'), B = w.mk('B');
    w.hello(A, { token: 't1' }); w.hello(B, { profile: { name: 'Bo' } });
    const p1 = w.party('p1', [A, B], 'B');
    w.close(A);
    w.clock.now = 5000;
    const A2 = w.mk('A2');
    w.hello(A2, claimToken ? { token: claimToken, resume: A.resume } : { profile: { name: 'Ana' }, resume: A.resume });
    return { w, A2, p1, A };
  };
  const guest = run(null), other = run('t2'), same = run('t1');
  ok('executed: wrong account — a seat minted for account u1 is refused to a guest (roster still [B])',
    guest.A2.party === null && guest.p1.members.join(',') === 'B', 'A2.party=' + guest.A2.party + ' members=' + guest.p1.members.join(','));
  ok('executed: wrong account — … and refused to account u2, and the refused claim spends the seat',
    other.A2.party === null && other.p1.members.join(',') === 'B' && !other.w.api.resumeSeats.has(other.A.resume), 'A2.party=' + other.A2.party);
  ok('executed: same account — u1 reconnecting as u1 gets the seat back (roster [B, A2])',
    same.A2.party === 'p1' && same.p1.members.join(',') === 'B,A2' && same.A2.userId === 'u1', 'A2.party=' + same.A2.party + ' userId=' + same.A2.userId);
  // half-open + a different identity: the dead socket is left to the reaper, nothing is seated
  const w = world({ now: 1000, users });
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { token: 't1' }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  const G = w.mk('G');
  w.hello(G, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: half-open + wrong account — a guest holding a signed-in socket\'s token is not seated and the live seat is untouched (roster still [A, B])',
    G.party === null && p1.members.join(',') === 'A,B' && A.party === 'p1' && !A.ws.closed, 'G.party=' + G.party + ' members=' + p1.members.join(','));
}

// (f) disbanded
{
  const w = world({ now: 1000 });
  const A = w.mk('A');
  w.hello(A, { profile: { name: 'Ana' } });
  w.party('p1', [A], 'A');
  w.close(A);                                           // last human gone → the party is disbanded (assumption A2)
  w.clock.now = 21000;
  const A2 = w.mk('A2');
  let threw = null;
  try { w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume }); } catch (e) { threw = e; }
  ok('executed: disbanded — the party was deleted while they were away: no throw, no seat, welcome still sent with resumed:false',
    threw === null && w.parties.size === 0 && A2.party === null && !!w.welcomeOf('A2') && w.welcomeOf('A2').resumed === false,
    threw ? 'threw: ' + threw.message : 'parties=' + w.parties.size + ' A2.party=' + A2.party);
}

// (g) full
{
  const w = world({ now: 1000 });
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { profile: { name: 'Ana' } }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  w.close(A);
  for (let i = 0; p1.members.length < MAX_PARTY; i++) {   // the convoy refilled while they were away
    const c = w.mk('F' + i); w.hello(c, { profile: { name: 'F' + i } }); c.party = 'p1'; p1.members.push(c.id);
  }
  w.clock.now = 21000;
  const A2 = w.mk('A2');
  w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: full — the convoy refilled to MAX_PARTY (' + MAX_PARTY + ') while they were away: no seat, roster still exactly ' + MAX_PARTY,
    A2.party === null && p1.members.length === MAX_PARTY && p1.members.indexOf('A2') < 0, 'A2.party=' + A2.party + ' size=' + p1.members.length);
}

// (h) kill switch — PARTY_GRACE_MS=0 through the real process.env read
{
  const w = world({ now: 1000, env: { PARTY_GRACE_MS: '0' } });
  const A = w.mk('A'), B = w.mk('B');
  w.hello(A, { profile: { name: 'Ana' } }); w.hello(B, { profile: { name: 'Bo' } });
  const p1 = w.party('p1', [A, B], 'B');
  w.sys.length = 0;
  w.close(A);
  const A2 = w.mk('A2');
  w.hello(A2, { profile: { name: 'Ana' }, resume: A.resume });
  ok('executed: kill switch — PARTY_GRACE_MS=0 restores the pre-fix behaviour exactly: "Ana left the convoy", no seat held, the token claims nothing',
    w.api.PARTY_GRACE_MS === 0 && w.sys[0] === 'Ana left the convoy' && w.api.resumeSeats.size === 0 && A2.party === null && p1.members.join(',') === 'B',
    'grace=' + w.api.PARTY_GRACE_MS + ' sys=' + w.sys.join(' | ') + ' A2.party=' + A2.party);
}

// (i) bounded
{
  const w = world({ now: 1000 });
  const p1 = w.party('p1', [], 'nobody');
  const max = w.api.RESUME_MAX;
  let held = 0;
  for (let i = 0; i < max; i++) {
    const r = { id: 'r' + i, bot: false, profile: { name: 'r' + i }, party: 'p1', resume: 't' + i, userId: null };
    if (w.api.rememberSeat(r, 1000)) held++;
  }
  const extra = w.api.rememberSeat({ id: 'rX', bot: false, profile: { name: 'rX' }, party: 'p1', resume: 'tX', userId: null }, 1000);
  ok('executed: bounded — RESUME_MAX (' + max + ') seats are held, the next rememberSeat() returns false and the map does not grow',
    max >= 100 && held === max && extra === false && w.api.resumeSeats.size === max, 'max=' + max + ' held=' + held + ' extra=' + extra + ' size=' + w.api.resumeSeats.size);
  ok('executed: bounded — pruning frees the room: 91 s later the same call holds a seat again',
    w.api.rememberSeat({ id: 'rY', bot: false, profile: { name: 'rY' }, party: 'p1', resume: 'tY', userId: null }, 1000 + 91000) === true && w.api.resumeSeats.size === 1);
  ok('executed: rememberSeat() refuses a bot, a rider with no party and a rider with no token',
    w.api.rememberSeat({ id: 'z', bot: true, name: 'z', party: 'p1', resume: 'tz' }, 1000) === false &&
    w.api.rememberSeat({ id: 'y', bot: false, profile: { name: 'y' }, party: null, resume: 'ty' }, 1000) === false &&
    w.api.rememberSeat({ id: 'x', bot: false, profile: { name: 'x' }, party: 'p1', resume: null }, 1000) === false);
  void p1;
}

/* ================= R2 — ordering + wiring pins ================= */
group('R2 — ordering and wiring pins (source-parsed): claim before welcome, restore after, hold before leave, quiet joins, token width, default window');
const hb = HELLO_BODY || '';
const claimAt = hb.indexOf('claimSeat('), welcomeAt = hb.indexOf("t: 'welcome'"), restoreAt = hb.indexOf('restoreSeat(');
ok('hello: claimSeat( runs BEFORE the welcome frame is built — `resumed` must be truthful',
  claimAt >= 0 && welcomeAt > claimAt, 'claim@' + claimAt + ' welcome@' + welcomeAt);
ok('hello: restoreSeat( runs AFTER the welcome frame — the roster must not reach a client that has no id yet (js/net.js applyParty: isLeader = leader === myId)',
  welcomeAt >= 0 && restoreAt > welcomeAt, 'welcome@' + welcomeAt + ' restore@' + restoreAt);
const welcomeLit = welcomeAt >= 0 ? hb.slice(welcomeAt, hb.indexOf('});', welcomeAt)) : '';
ok('hello: the welcome literal carries `resume: c.resume` and `resumed:`',
  /resume: c\.resume/.test(welcomeLit) && /resumed:/.test(welcomeLit), 'literal=' + welcomeLit.slice(0, 120).replace(/\n/g, ' '));
const cb = CLOSE_BODY || '';
const delAt = cb.indexOf('seatOwner.delete('), remAt = cb.indexOf('rememberSeat('), leaveAt = cb.indexOf('leaveParty(');
ok("close: seatOwner.delete( → rememberSeat( → leaveParty( in that order", delAt >= 0 && remAt > delAt && leaveAt > remAt,
  'delete@' + delAt + ' remember@' + remAt + ' leave@' + leaveAt);
ok('close: the leave is silent exactly when the seat was held — `const held = rememberSeat(c, Date.now()); if (c.party) leaveParty(c, held);`',
  /const held = rememberSeat\(c, Date\.now\(\)\);\s*\n\s*if \(c\.party\) leaveParty\(c, held\);/.test(cb));
ok('joinParty(rider, party, quiet) has the third parameter and only announces when not quiet',
  /^function joinParty\(rider, party, quiet\) \{/m.test(SRC) && /if \(!quiet\) partySys\(party, riderName\(rider\) \+ ' joined the convoy'\);/.test(JOIN));
{
  const rsAt = SRC.indexOf('function restoreSeat(rider, party) {');
  const rsEnd = rsAt >= 0 ? SRC.indexOf('\n}\n', rsAt) : -1;
  const calls = [];
  const re = /\bjoinParty\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(SRC))) {
    if (SRC.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue;
    if (!m[1].trim()) continue;                       // `joinParty()` in a comment is a mention, not a call
    calls.push({ args: m[1].split(',').map((s) => s.trim()).filter(Boolean), inRestore: rsAt >= 0 && m.index > rsAt && m.index < rsEnd });
  }
  const outside = calls.filter((c) => !c.inRestore), inside = calls.filter((c) => c.inRestore);
  ok('every joinParty( call site outside restoreSeat passes exactly two arguments (' + outside.length + ' sites: invite → bot, party:accept, party:join) — nothing else went quiet; restoreSeat is the one quiet join',
    outside.length >= 3 && outside.every((c) => c.args.length === 2) && inside.length === 1 && inside[0].args.length === 3 && inside[0].args[2] === 'true',
    'outside=' + JSON.stringify(outside.map((c) => c.args)) + ' inside=' + JSON.stringify(inside.map((c) => c.args)));
}
{
  const litAt = SRC.indexOf("    id: 'u' + crypto.randomBytes(5).toString('hex'),");
  const litEnd = litAt >= 0 ? SRC.indexOf('isAlive: true', litAt) : -1;
  const lit = litAt >= 0 && litEnd > litAt ? SRC.slice(litAt, litEnd) : '';
  const mTok = lit.match(/resume: crypto\.randomBytes\((\d+)\)\.toString\('hex'\)/);
  ok('the connection literal mints c.resume with crypto.randomBytes(>= 16) — 128 bits, a capability at the same trust level as the socket it is sent on',
    !!mTok && parseInt(mTok[1], 10) >= 16, 'literal match=' + !!mTok + (mTok ? ' bytes=' + mTok[1] : ''));
  ok('the new socket is registered in seatOwner right after it passed the per-IP ceiling (beside clients.set)',
    /ipCount\.set\(c\.ip, cur \+ 1\);\s*\n\s*clients\.set\(c\.id, c\);\s*\n\s*seatOwner\.set\(c\.resume, c\);/.test(SRC));
}
const mG = SRC.match(/^const PARTY_GRACE_MS = Number\(process\.env\.PARTY_GRACE_MS \|\| (\d+)\);/m);
const serverMs = mG ? parseInt(mG[1], 10) : NaN;
ok('PARTY_GRACE_MS = Number(process.env.PARTY_GRACE_MS || <default>) at module scope, with 0 < default (' + serverMs + ') <= 600000',
  !!mG && serverMs > 0 && serverMs <= 600000, 'match=' + !!mG);
{
  const at = ENV_SRC.indexOf('PARTY_GRACE_MS');
  const block = at >= 0 ? ENV_SRC.slice(Math.max(0, at - 900), at + 200) : '';
  ok('server/.env.example documents PARTY_GRACE_MS: what it holds, the default (' + serverMs + '), that 0 disables it, and the client pin',
    at >= 0 && new RegExp('PARTY_GRACE_MS=' + serverMs).test(block) && /0 disables/.test(block) && /js\/net\.js/.test(block), 'found at ' + at);
}

/* ================= R3 — the cross-file pin ================= */
group('R3 — cross-file pin: the client never keeps the roster longer than the server holds the seat');
const mC = NET_SRC.match(/^\s*var PARTY_GRACE_MS = (\d+);/m);
const clientMs = mC ? parseInt(mC[1], 10) : NaN;
const mRetry = NET_SRC.match(/^\s*var RETRY_MAX = (\d+);/m), mConn = NET_SRC.match(/^\s*var CONNECT_TIMEOUT = (\d+);/m);
ok('js/net.js declares `var PARTY_GRACE_MS = <ms>` (' + clientMs + ')', clientMs > 0, 'match=' + !!mC);
ok('client grace (' + clientMs + ' ms) <= server grace (' + serverMs + ' ms) — a client that keeps the roster after the server let the seat go is showing the rider a convoy they are no longer in',
  clientMs > 0 && serverMs > 0 && clientMs <= serverMs, 'lower js/net.js PARTY_GRACE_MS, or raise the server\'s default FIRST');
ok('client grace (' + clientMs + ' ms) >= RETRY_MAX + CONNECT_TIMEOUT (' + (mRetry && mConn ? parseInt(mRetry[1], 10) + parseInt(mConn[1], 10) : NaN) + ' ms) — one slow retry cycle must not outlive the roster',
  !!mRetry && !!mConn && clientMs >= parseInt(mRetry[1], 10) + parseInt(mConn[1], 10));
ok('the reasoning lives at the constant: the comment above `var PARTY_GRACE_MS` in js/net.js names the server\'s window and this suite',
  (() => { const at = NET_SRC.indexOf('var PARTY_GRACE_MS'); const ctx = at >= 0 ? NET_SRC.slice(Math.max(0, at - 1200), at) : ''; return at >= 0 && /server\/server\.js/.test(ctx) && /partyresume\.test\.js/.test(ctx); })());

/* ================= R4 — client, executed ================= */
group('R4 — client, executed: the real js/net.js keeps the seat warm, echoes the token, and lets the server\'s answer win (frontend-022 / frontend-023)');
const win = H.installBrowser();
const storageWrites = [];
const realSetItem = win.localStorage.setItem;
win.localStorage.setItem = function (k, v) { storageWrites.push(k + '=' + v); return realSetItem(k, v); };
// Timers are recorded, never armed: the grace timer is fired by hand, retry
// timers never run, and nothing keeps the process alive.
const timers = [];
global.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms, cleared: false }); return timers.length; };
global.clearTimeout = function (id) { if (timers[id - 1]) timers[id - 1].cleared = true; };
global.setInterval = function () { return 0; };
global.clearInterval = function () {};
const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; if (this.onclose) this.onclose({}); }
}
win.WebSocket = FakeWS;
global.WebSocket = FakeWS;
H.loadModule('js/util.js');
H.loadModule('js/state.js');
const A = win.App;
const S = A.state, ST = A.store;
A.config = { wsUrl: 'wss://test/ws', routeCaps: { routing: false, waze: false, hotspots: false, incidents: false } };
const toasts = [];
A.ui = { toast: function (t) { toasts.push(t); }, inviteToast: function () {} };
A.sim = {
  enableSolo: function () {}, disableSolo: function () {},
  hasRealPos: function () { return false; }, playerPos: function () { return null; },
  playerHeading: function () { return 0; }, getNpc: function () { return null; },
  count: function () { return 0; }, remoteAdd: function () {}
};
const links = [];
A.mapview = { setLinksData: function (d) { links.push(d); }, setGlobalData: function () {}, setNpcMember: function () {}, setRallyPoint: function () {} };
A.data = { CONVOY_NAMES: ['Night Run'], CHAT_REPLIES: ['copy that'] };
H.loadModule('js/net.js');
H.loadModule('js/party.js');

function deliver(s, m) { s.onmessage({ data: JSON.stringify(m) }); }
function open() { A.net.connect(); const s = sockets[sockets.length - 1]; s.readyState = 1; s.onopen(); return s; }
function drop(s) { s.readyState = 3; s.closed = true; s.onclose({}); }     // the server side vanished
function welcome(id, tok, resumed) { return { t: 'welcome', id: id, online: 2, riders: [], resume: tok, resumed: resumed }; }
function partyFrame(me, others) {
  return { t: 'party', party: { id: 'p1', name: 'Night Run', emoji: 0, leader: others[0], mode: 'invite', code: '',
    members: [me].concat(others).map((id) => ({ id: id, name: id, emoji: 0 })), chat: [{ sys: true, text: 'Convoy created', t: 1 }], rally: null } };
}
const liveGrace = () => timers.filter((t) => t.ms === clientMs && !t.cleared);
const types = (s) => s.sent.map((f) => f.t).join(',');

// 1. cold boot → a party → the drop
const s1 = open();
const h1 = s1.sent[0];
ok('cold boot: the hello frame carries `resume: null` — nothing to resume yet',
  !!h1 && h1.t === 'hello' && ('resume' in h1) && h1.resume === null, 'hello=' + JSON.stringify(h1));
deliver(s1, welcome('me1', 'tok-1', false));
ok('welcome → live', A.net.isLive() && S.netMode === 'live');
deliver(s1, partyFrame('me1', ['B']));
ok('a party frame lands: roster [B]', !!S.party && S.party.members.join() === 'B');
let emits = 0, nullSeen = false;
ST.on('party', function () { emits++; if (!S.party) nullSeen = true; });
const linksBefore = links.length, chatBefore = S.party.chat.length;
drop(s1);
ok('a socket drop inside the grace keeps S.party on screen and reads netMode "connecting" (the HUD link light goes dark — that is the stale-roster affordance)',
  !!S.party && S.party.members.join() === 'B' && S.netMode === 'connecting' && !A.net.isLive(),
  'party=' + JSON.stringify(S.party && S.party.members) + ' netMode=' + S.netMode);
ok('… the convoy link lines were not wiped', links.length === linksBefore, 'setLinksData calls during the drop: ' + (links.length - linksBefore));
ok('… exactly one grace timer is armed, at the client PARTY_GRACE_MS', liveGrace().length === 1, 'live grace timers: ' + liveGrace().length);
ok('… A.net.isResuming() is true while the server may still be holding the seat', !!A.net.isResuming && A.net.isResuming() === true);
A.party.sendChat('still here');
ok('chat typed in the tunnel is handed to the queue, not to the solo simulation (no local "me" line, so no fake reply from a real member — js/party.js sendChat)',
  !!S.party && S.party.chat.length === chatBefore && !S.party.chat.some((e) => e.text === 'still here'),
  'chat=' + JSON.stringify(S.party && S.party.chat.map((e) => e.text)));

// 2. reconnect → token echo → resumed:true
const s2 = open();
ok('the next hello echoes the exact token from the previous welcome', s2.sent[0].t === 'hello' && s2.sent[0].resume === 'tok-1', 'hello=' + JSON.stringify(s2.sent[0]));
ok('… and the tunnel chat is flushed right behind it', s2.sent.some((f, i) => i > 0 && f.t === 'chat' && f.text === 'still here'), 'wire=' + types(s2));
deliver(s2, welcome('me2', 'tok-2', true));
ok('welcome resumed:true leaves the graced roster intact', !!S.party && S.party.members.join() === 'B');
deliver(s2, partyFrame('me2', ['B']));
ok('no null gap: S.party was never null across drop → hello → welcome → party (' + emits + ' party emits)', !nullSeen && !!S.party);
ok('the grace timer was disarmed on resume (only ever one, never a stale one)', liveGrace().length === 0, 'live grace timers: ' + liveGrace().length);
ok('the resumed roster carries the server\'s chat backlog', !!S.party && S.party.chat.length >= 1);

// 3. resumed:false clears immediately — the honesty rule
drop(s2);
ok('second drop: roster kept again', !!S.party);
const s3 = open();
ok('the hello now echoes the newer token (tok-2)', s3.sent[0].resume === 'tok-2', 'hello=' + JSON.stringify(s3.sent[0]));
deliver(s3, welcome('me3', 'tok-3', false));
ok('welcome resumed:false clears a graced S.party immediately — the server\'s answer wins over the client\'s optimism', S.party === null);
ok('… and the grace timer went with it', liveGrace().length === 0);

// 4. nobody comes back: the timer clears the roster
deliver(s3, partyFrame('me3', ['B']));
drop(s3);
const g = liveGrace();
ok('a fresh drop arms one grace timer and keeps the roster', g.length === 1 && !!S.party, 'timers=' + g.length);
if (g.length) { g[0].cleared = true; g[0].fn(); }     // fired: it is spent, like a real timer
ok('the grace timer clears a roster nobody came back for (links wiped with it)', S.party === null && links[links.length - 1] === null);

// 5. a teardown past the window clears it too (a failed retry after the grace)
const s4 = open();
deliver(s4, welcome('me4', 'tok-4', false));
deliver(s4, partyFrame('me4', ['B']));
drop(s4);
ok('roster kept at the drop', !!S.party);
const realNow = Date.now;
Date.now = function () { return realNow() + clientMs + 1000; };
A.net.connect();
const s5 = sockets[sockets.length - 1];
s5.onclose({});                                       // refused before it opened → onConnectFailed → teardownLive
Date.now = realNow;
ok('a failed reconnect attempt past the grace window clears the roster — the pre-fix behaviour, now only past the window', S.party === null);

// 6. party:left zeroes the grace
const s6 = open();
deliver(s6, welcome('me6', 'tok-6', false));
deliver(s6, partyFrame('me6', ['B']));
deliver(s6, { t: 'party:left' });
ok('party:left (left or kicked) clears the roster and toasts', S.party === null && toasts[toasts.length - 1] === 'You left the convoy');
drop(s6);
ok('… and a subsequent drop keeps nothing and arms nothing — never resurrect a convoy the rider left or was kicked from',
  S.party === null && liveGrace().length === 0, 'timers=' + liveGrace().length);

// 7. an explicit leave inside the tunnel
const s7 = open();
deliver(s7, welcome('me7', 'tok-7', false));
deliver(s7, partyFrame('me7', ['B']));
drop(s7);
A.party.leave();                                      // the rider taps Leave while the socket is down
ok('leave() during the grace clears the roster now and does not fall into the solo path (no grace for a convoy the rider chose to leave)',
  S.party === null && liveGrace().length === 0, 'party=' + JSON.stringify(S.party) + ' timers=' + liveGrace().length);
const s8 = open();
ok('… the leave is queued behind the next hello with the token still echoed, so it lands on the resumed seat',
  s8.sent[0].t === 'hello' && s8.sent[0].resume === 'tok-7' && s8.sent.findIndex((f) => f.t === 'party:leave') > 0, 'wire=' + types(s8));
deliver(s8, welcome('me8', 'tok-8', true));
deliver(s8, partyFrame('me8', ['B']));
deliver(s8, { t: 'party:left' });
ok('… and the server\'s party:left confirms it', S.party === null);

// 8. the stale socket (frontend-023)
const s9 = open();
deliver(s9, welcome('me9', 'tok-9', false));
deliver(s9, partyFrame('me9', ['B']));
drop(s9);
const s10 = open();
deliver(s10, welcome('me10', 'tok-10', true));
deliver(s10, partyFrame('me10', ['B']));
const P = S.party, toastsBefore = toasts.length;
deliver(s9, { t: 'party:left' });                     // a late frame on the socket the client already replaced
ok('stale socket: party:left on a superseded socket is ignored — S.party intact, no toast (the server\'s half-open branch sends exactly this frame to the OLD socket)',
  S.party === P && toasts.length === toastsBefore, 'party=' + JSON.stringify(S.party && S.party.members) + ' toasts=' + (toasts.length - toastsBefore));
deliver(s9, partyFrame('me9', ['C']));
ok('stale socket: a party frame on a superseded socket is ignored', S.party === P && !!S.party && S.party.members.join() === 'B');
deliver(s10, { t: 'party:left' });
ok('the same frame on the current socket is honoured', S.party === null);

// 9. the token never touches storage
ok('js/net.js never touches localStorage/sessionStorage — the token lives in memory only', !/localStorage|sessionStorage/.test(NET_SRC));
ok('no storage write during the whole flow carried a resume token (' + storageWrites.length + ' writes)', !storageWrites.some((w) => /tok-\d+/.test(w)));
ok('js/party.js gates its delegations on live-or-resuming and joinByCode on a live socket only',
  /A\.net\.isResuming/.test(PARTY_SRC) && /function joinByCode\(code\) \{\s*\n\s*if \(!\(A\.net && A\.net\.isLive\(\)\)\)/.test(PARTY_SRC));

process.exit(H.report());
