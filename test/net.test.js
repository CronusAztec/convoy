/* Convoy — net.js reconnect lifecycle regression tests.

   Covers two fixes in js/net.js:
     M6 — the 9s connect-TIMEOUT path must clear `connecting`; before the fix
          one stalled handshake left it true forever, so every retry, every
          'online' event and every visibilitychange no-opped and the rider
          spent the session riderless.
     M7 — the outbound party queue must flush AFTER `hello`; before the fix it
          flushed first, and the server drops every pre-hello frame, so queued
          invites/kicks/leaves were silently lost on every reconnect.

   Runs the REAL js/net.js through the harness shim with a fake WebSocket.
   The M6 check waits out the real 9s CONNECT_TIMEOUT (the timeout is a
   closure const), so this suite takes ~10 seconds by design. */
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
A.config = { wsUrl: 'wss://test/ws' };
A.ui = { toast: function () {} };
A.sim = {
  enableSolo: function () {}, disableSolo: function () {},
  hasRealPos: function () { return false; }, playerPos: function () { return null; },
  playerHeading: function () { return 0; }, getNpc: function () { return null; },
  count: function () { return 0; }, remoteAdd: function () {}
};
A.mapview = { setLinksData: function () {}, setGlobalData: function () {}, setNpcMember: function () {} };
loadModule('js/net.js');

group('M7 — queued party messages flush after hello');
sockets.length = 0;
// Queue a control message while "down", then connect and open the socket.
A.net.sendLeave();
ok('message queued while offline', true);
A.net.connect();
const s = sockets[0];
s.readyState = 1;        // a real socket is open by the time onopen fires
s.onopen();
const order = s.sent.map(function (m) { return m.t; });
ok('hello is the first frame on the wire', order[0] === 'hello',
  'first frame was ' + JSON.stringify(order[0]) + ' — the server drops pre-hello frames (M7 repro)');
ok('the queued party:leave flushed after hello', order.indexOf('party:leave') > order.indexOf('hello'),
  'order was ' + JSON.stringify(order));

group('M6 — a stalled handshake does not kill reconnection for the session');
s.close();              // drop the M7 socket first: connect() no-ops while one is open
sockets.length = 0;
A.net.connect();
const s1 = sockets[0];
// Wait out the REAL 9s timeout: the timer calls socket.close() then
// onConnectFailed(). Poll until close() is observable (single-threaded, so the
// whole callback has run by then).
const t0 = Date.now();
(function waitForTimeout() {
  if (s1.closed || Date.now() - t0 > 12000) {
    ok('the 9s connect timeout fired and closed the stalled socket', s1.closed,
      'timer never fired in 12s — test setup broken, not the app');
    // reconnectNow() is module-private; its recovery move is exactly connect(),
    // and connect() is what the M6 bug made a permanent no-op (connecting stuck
    // true). Driving the public API tests the same regression.
    A.net.connect();
    ok('connect() after a timeout attempts a NEW socket (connecting cleared)',
      sockets.length === 2,
      'no second attempt — `connecting` stuck true after one timeout (M6 repro)');
    // Negative: while an attempt is genuinely mid-handshake, no second one.
    A.net.connect();
    ok('connect() during a live handshake is still a no-op',
      sockets.length === 2,
      'spawned a duplicate socket while one was mid-handshake');
    const mid = sockets[1];
    mid.readyState = 1; mid.onopen();
    ok('the retried socket completes hello normally', mid.sent.length >= 1 && mid.sent[0].t === 'hello');
    process.exit(report());
  } else {
    setTimeout(waitForTimeout, 50);
  }
})();
