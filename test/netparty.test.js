/* Convoy — net.js party-drop grace + dragy.js auth-header regression tests.

   Covers two M2 fixes:
     frontend-013 — teardownLive() used to null S.party and repaint on EVERY
        socket drop, even a sub-second blip. A flaky link that dropped and
        reconnected 3x rapidly flickered convoy markers, retoasted "Connection
        lost", and re-acquired the mic each cycle. Fix: coalesce a burst of
        drops into one grace-delayed transition (PARTY_DROP_GRACE_MS) and
        suppress the repeat toast until the connection has actually held.
     frontend-005 — dragy.js's uploadPB() sent a literal 'Bearer false' or
        'Bearer undefined' Authorization header whenever isLoggedIn() was true
        but the auth token itself was missing.

   The grace-window assertions wait out the real timers (like net.test.js's
   M6 case), so this suite takes a few seconds by design. */
'use strict';
const { installBrowser, loadModule, group, ok, report } = require('./harness');
installBrowser();

let sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; if (this.onclose) this.onclose({}); }
}
global.window.WebSocket = FakeWS;
global.WebSocket = FakeWS;

loadModule('js/util.js');
loadModule('js/state.js');
const A = global.window.App;
A.config = { wsUrl: 'wss://test/ws', base: '' };
let toasts = [];
A.ui = { toast: function (msg) { toasts.push(msg); } };
A.sim = {
  enableSolo: function () {}, disableSolo: function () {},
  hasRealPos: function () { return false; }, playerPos: function () { return null; },
  playerHeading: function () { return 0; }, getNpc: function () { return null; },
  count: function () { return 0; }, remoteAdd: function () {}
};
A.mapview = { setLinksData: function () {}, setGlobalData: function () {}, setNpcMember: function () {} };
// goLive() fires a one-shot GET for routing caps; stub it so it resolves quietly
// instead of throwing "fetch is not a function" into the console on every test.
global.window.fetch = global.fetch = function () { return Promise.resolve({ ok: false }); };
loadModule('js/net.js');

function open(s) { s.readyState = 1; s.onopen(); }
function recv(s, msg) { s.onmessage({ data: JSON.stringify(msg) }); }

group('frontend-013 — a socket drop does not instantly wipe the convoy');
sockets.length = 0;
A.net.connect();
let s = sockets[0];
open(s);
recv(s, { t: 'welcome', id: 'me1', online: 2, account: null, riders: [], global: null });
recv(s, {
  t: 'party',
  party: { id: 'p1', name: 'Test convoy', emoji: '', leader: 'me1', mode: 'invite', code: 'ABCD',
    members: [{ id: 'me1' }, { id: 'friend1' }], chat: [] }
});
ok('party is set after the party message', A.state.party && A.state.party.id === 'p1');
toasts.length = 0;
s.close(); // simulate an established socket dropping (onDisconnected path)
ok('party is NOT nulled the instant the socket drops', A.state.party && A.state.party.id === 'p1',
  'S.party went null synchronously on close — the grace window regressed');
ok('exactly one "Connection lost" toast fired', toasts.length === 1, 'toasts: ' + JSON.stringify(toasts));

group('frontend-013 — a fast reconnect that re-confirms the party cancels the drop');
sockets.length = 0;
A.net.connect();
let s2 = sockets[0];
open(s2);
recv(s2, { t: 'welcome', id: 'me1', online: 2, account: null, riders: [], global: null });
recv(s2, {
  t: 'party',
  party: { id: 'p1', name: 'Test convoy', emoji: '', leader: 'me1', mode: 'invite', code: 'ABCD',
    members: [{ id: 'me1' }, { id: 'friend1' }], chat: [] }
});
ok('a fresh party message survives even though the earlier drop is still pending',
  A.state.party && A.state.party.id === 'p1');
toasts.length = 0;

setTimeout(function () {
  ok('after the grace window with no further drop, party state is unaffected by the earlier (canceled) timer',
    A.state.party && A.state.party.id === 'p1',
    'the stale grace timer from the first drop fired anyway — applyParty must cancel it');

  group('frontend-013 — a drop with no reconnect eventually finalizes exactly once');
  s2.close();
  ok('party still present immediately after the second close (grace pending)', A.state.party && A.state.party.id === 'p1');
  setTimeout(function () {
    ok('party is finalized to null after the grace window elapses', A.state.party === null,
      'S.party never dropped — dropPartyNow()/partyDropTimer regressed');

    group('frontend-005 — uploadPB never sends Bearer false/undefined');
    let fetchCalls = [];
    global.window.fetch = global.fetch = function (url, opts) { fetchCalls.push(opts); return Promise.resolve({ ok: false }); };
    loadModule('js/dragy.js');
    // isLoggedIn() true but no token on A.state.auth — the exact frontend-005 repro:
    // a profile/username exists (so the caller believes the rider is signed in)
    // but the auth token itself is missing or already expired.
    A.state.auth = { username: 'x' };
    A.dragy._uploadPB('0-60', 4.2, null);
    ok('no fetch is sent when the auth token is missing', fetchCalls.length === 0,
      'uploadPB fired a request with an unconditional Bearer header (frontend-005 repro)');

    fetchCalls.length = 0;
    A.state.auth = { username: 'x', token: 'real-token-123' };
    A.dragy._uploadPB('0-60', 4.2, null);
    ok('a real token still sends the PB', fetchCalls.length === 1 &&
      fetchCalls[0].headers.Authorization === 'Bearer real-token-123',
      'got: ' + JSON.stringify(fetchCalls));

    process.exit(report());
  }, 3300);
}, 3300);
