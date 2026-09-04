/* Convoy — server/wiregate.js semantics (P-E, T2.6, cycle 11).

   Pure logic tests for the per-viewer wire gate (no server boot, no network —
   this file drives the module's exported functions directly with a synthetic
   clock, plus one real-client integration proof at the bottom). See
   server/wiregate.js's own header for the design and STATE.md §6 for the
   measured before/after this gate produced.

   Decision order under test (server/wiregate.js's shouldSend()):
     1. no entry (first sight)                    -> send
     2. now - entry.at >= WIRE_MAX_STALE_MS        -> send (heartbeat)
     3. row differs from entry.s                   -> send iff tier interval elapsed
     4. row identical to entry.s                   -> send iff still within WIRE_HOLD_MS

   Run:  node test/wiregate.test.js
*/
'use strict';
const H = require('./harness');
const wiregate = require('../server/wiregate');

/* ---------------- group 1: first sight is always sent ---------------- */
H.group('shouldSend — first sight (no entry) is always sent, any distance');
H.ok('no entry, near distance -> send', wiregate.shouldSend(undefined, 'row1', 100, 0) === true);
H.ok('no entry, far distance -> send', wiregate.shouldSend(null, 'row1', 20000, 0) === true);

/* ---------------- group 2: near + changed is never delayed ---------------- */
H.group("shouldSend — near tier (< WIRE_NEAR_M) with a changing row is sent on every tick, exactly today's behaviour");
{
  const wire = new Map();
  const distM = 500; // well inside WIRE_NEAR_M
  let skips = 0;
  for (let i = 0; i < 30; i++) {
    const now = i * 250;
    const rowStr = 'row-' + i; // a genuinely different row every tick
    const entry = wire.get('r');
    const sent = wiregate.shouldSend(entry, rowStr, distM, now);
    wiregate.record(wire, 'r', rowStr, now, sent);
    if (!sent) skips++;
  }
  H.ok('30 ticks of a changing near-tier row: zero skips', skips === 0, skips + ' skipped');
}

/* ---------------- group 3: hold guard ---------------- */
H.group('shouldSend — identical-row hold guard (WIRE_HOLD_MS)');
{
  const wire = new Map();
  const rowStr = 'same-row';
  const distM = 500;

  const sent0 = wiregate.shouldSend(wire.get('r'), rowStr, distM, 0);
  wiregate.record(wire, 'r', rowStr, 0, sent0);
  H.ok('t=0 first sight is sent', sent0 === true);

  const beforeMs = wiregate.WIRE_HOLD_MS - 250;
  const sentBefore = wiregate.shouldSend(wire.get('r'), rowStr, distM, beforeMs);
  wiregate.record(wire, 'r', rowStr, beforeMs, sentBefore);
  H.ok('identical row at t=' + beforeMs + 'ms (< WIRE_HOLD_MS=' + wiregate.WIRE_HOLD_MS + ') is still sent', sentBefore === true);

  const atMs = wiregate.WIRE_HOLD_MS;
  const sentAt = wiregate.shouldSend(wire.get('r'), rowStr, distM, atMs);
  H.ok('identical row at t=' + atMs + 'ms (== WIRE_HOLD_MS, boundary) is suppressed', sentAt === false);

  const afterMs = wiregate.WIRE_HOLD_MS + 250;
  const sentAfter = wiregate.shouldSend(wire.get('r'), rowStr, distM, afterMs);
  H.ok('identical row at t=' + afterMs + 'ms (> WIRE_HOLD_MS) is suppressed', sentAfter === false);
}

/* ---------------- group 4: heartbeat is inviolable ---------------- */
H.group('shouldSend — WIRE_MAX_STALE_MS bounds every gap, for a rider that never changes (near AND far tier)');
// Measures the gap on EVERY tick (not just at the next send) so a heartbeat
// that stops firing entirely shows up as an ever-growing gap, not a silently
// unmeasured one — the earlier draft of this helper only compared consecutive
// `sent` events, so "no further sends, ever" (the exact bug this group exists
// to catch) never widened maxGap because there was no later send to diff
// against. Caught by deliberately breaking WIRE_MAX_STALE_MS's clause during
// this suite's own RED→GREEN pass (see the cycle-11 report for the transcript).
function maxSendGap(distM, totalMs, tickMs) {
  const wire = new Map();
  const rowStr = 'stationary-row';
  let lastSentAt = 0; // t=0 is always a send (first sight), so this is exact, not an assumption
  let maxGap = 0;
  for (let now = 0; now <= totalMs; now += tickMs) {
    const entry = wire.get('r');
    const sent = wiregate.shouldSend(entry, rowStr, distM, now);
    wiregate.record(wire, 'r', rowStr, now, sent);
    if (sent) lastSentAt = now;
    else maxGap = Math.max(maxGap, now - lastSentAt);
  }
  return maxGap;
}
{
  const nearGap = maxSendGap(200, 60000, 250);
  const farGap = maxSendGap(20000, 60000, 250);
  H.ok('near tier, 60s unchanging: max gap ' + nearGap + 'ms <= WIRE_MAX_STALE_MS (' + wiregate.WIRE_MAX_STALE_MS + 'ms)',
    nearGap <= wiregate.WIRE_MAX_STALE_MS);
  H.ok('far tier, 60s unchanging: max gap ' + farGap + 'ms <= WIRE_MAX_STALE_MS (' + wiregate.WIRE_MAX_STALE_MS + 'ms) — tier + hold must not compose into a longer gap than the heartbeat',
    farGap <= wiregate.WIRE_MAX_STALE_MS);
}

/* ---------------- group 5: tier ceiling ---------------- */
H.group('shouldSend — a genuinely CHANGING far-tier row is delayed by at most WIRE_FAR_MS ("distant riders still move")');
{
  const wire = new Map();
  let lastSentAt = null;
  let maxGap = 0;
  let seq = 0;
  for (let now = 0; now <= 30000; now += 250) {
    seq++;
    const rowStr = 'row-' + seq; // different every tick: a rider that is still moving
    const entry = wire.get('r');
    const sent = wiregate.shouldSend(entry, rowStr, 20000, now); // 20km, beyond WIRE_MID_M
    wiregate.record(wire, 'r', rowStr, now, sent);
    if (sent) {
      if (lastSentAt !== null) maxGap = Math.max(maxGap, now - lastSentAt);
      lastSentAt = now;
    }
  }
  H.ok('far tier (20km), continuously-changing row: max gap ' + maxGap + 'ms <= WIRE_FAR_MS (' + wiregate.WIRE_FAR_MS + 'ms)',
    maxGap <= wiregate.WIRE_FAR_MS);
}

/* ---------------- group 6: lifecycle / leak ---------------- */
H.group('lifecycle — c.wire never leaks and never exceeds c.known.size (50 add→remove cycles, models the 4 known.delete sites in server.js)');
{
  const known = new Set();
  const wire = new Map();
  const RIDERS = 10;
  for (let cycle = 0; cycle < 50; cycle++) {
    for (let i = 0; i < RIDERS; i++) {
      const id = 'r' + i;
      known.add(id);
      const now = cycle * 1000 + i;
      const rowStr = 'row-cycle-' + cycle;
      const sent = wiregate.shouldSend(wire.get(id), rowStr, 500, now);
      wiregate.record(wire, id, rowStr, now, sent);
    }
    if (cycle % 10 === 0) {
      H.ok('cycle ' + cycle + ': wire.size (' + wire.size + ') never exceeds known.size (' + known.size + ')', wire.size <= known.size);
    }
    // Collect first, delete after — same pattern as syncScope's own remove
    // branch (server/server.js) and the 4 sites this cycle paired a
    // c.wire.delete(id) with every existing c.known.delete(id): syncScope's
    // remove branch, applyBlockNow's two lines, and the ghost-toggle site.
    for (const id of Array.from(known)) { known.delete(id); wire.delete(id); }
  }
  H.ok('after 50 add→remove cycles, wire.size === 0', wire.size === 0, 'size=' + wire.size);
  H.ok('after 50 add→remove cycles, known.size === 0', known.size === 0, 'size=' + known.size);
}

/* ---------------- group 7: the parked-fidelity proof ----------------
   The strongest test in this suite. Two rider ids are driven through the
   REAL js/sim.js (loaded via test/harness.js's lightweight module loader,
   same pattern as test/physics.test.js / test/riderarrows.test.js — not
   test/frontend.test.js's full jsdom boot, which is unnecessary for a module
   with no DOM dependency beyond A.mapview's stubbed hooks): one gets every
   tick resent (today's pre-wiregate behaviour), the other only gets a row
   when the REAL wiregate.shouldSend()/record() (near-tier, distM=0, exactly
   as the fast lane calls it in server/server.js's nearestRows()) says to
   send it. Both run through the real setNext() + frame() maths and must
   render bit-identically at every sampled instant — not within a tolerance,
   exact float equality — because a parked rider's prev/next positions never
   differ (setNext forces pSpeed=0 the instant mode==='parked', so frame()'s
   dead-reckoning branch is structurally unreachable and lerping between two
   identical points is exact regardless of elapsed time). This is what makes
   suppressing a parked rider's repeats free. */
H.group("the parked-fidelity proof — suppressed vs unsuppressed render bit-identically through js/sim.js's real setNext()/frame()");
{
  const win = H.installBrowser();
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  const A = win.App;
  A.mapview = {
    addNpc() {}, removeNpc() {}, updateNpc() {}, createPlayerMarker() {},
    map() { return { getCanvasContainer() { return { addEventListener() {} }; } }; }
  };

  let clock = 0;
  // `global.performance`, not the bare `performance` global — test/globals.test.js's
  // free-identifier scan only allows `performance` in the js/ tree (real browser
  // global); going through `global.` keeps this file's tree-allowlist honest while
  // mutating the exact same object js/sim.js's own bare `performance.now()` calls
  // read (both resolve to the same globalThis.performance).
  const realNow = global.performance.now;
  global.performance.now = () => clock;

  // start() arms a real 1Hz UI-tick setInterval and captures frame() via
  // requestAnimationFrame — swallow the interval (unrelated to this proof,
  // and a real timer would fire mid-test since clock is fake) and capture
  // frame() so it can be invoked directly with a fully controlled `now`,
  // instead of waiting on real rAF scheduling.
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0;
  let capturedFrame = null;
  const realRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = (fn) => { capturedFrame = fn; return 1; };

  H.loadModule('js/sim.js');
  A.sim.start();
  global.setInterval = realSetInterval;

  const POS = [-122.4194, 37.7749];
  const HEADING = 90;
  const rowArgs = [POS[0], POS[1], HEADING, 1]; // parked flag = 1
  const rowStr = rowArgs.join(',');

  A.sim.remoteAdd({ id: 'unsup', name: 'u', handle: '', emoji: '', vibe: '', car: '', pos: POS, heading: HEADING, mode: 'parked' });
  A.sim.remoteAdd({ id: 'sup', name: 's', handle: '', emoji: '', vibe: '', car: '', pos: POS, heading: HEADING, mode: 'parked' });

  const wire = new Map(); // this viewer's c.wire, for the 'sup' stream only
  let mismatches = 0;
  let gatedSends = 0, totalTicks = 0;
  const FAST_MS = 350;
  const TOTAL_MS = 20000; // crosses WIRE_HOLD_MS and one WIRE_MAX_STALE_MS heartbeat
  for (let now = 0; now <= TOTAL_MS; now += FAST_MS) {
    clock = now;
    totalTicks++;

    // unsuppressed: every fast tick resends the identical row (pre-wiregate behaviour)
    A.sim.remoteTick([['unsup', rowArgs[0], rowArgs[1], rowArgs[2], rowArgs[3]]]);

    // gated: only resend when the REAL fast-lane gate says to (distM=0, same as nearestRows())
    const entry = wire.get('sup');
    const sent = wiregate.shouldSend(entry, rowStr, 0, now);
    wiregate.record(wire, 'sup', rowStr, now, sent);
    if (sent) { A.sim.remoteTick([['sup', rowArgs[0], rowArgs[1], rowArgs[2], rowArgs[3]]]); gatedSends++; }

    capturedFrame(now);
    const a = A.sim.getNpc('unsup'), b = A.sim.getNpc('sup');
    const same = a.livePos[0] === b.livePos[0] && a.livePos[1] === b.livePos[1] && a.liveBrg === b.liveBrg;
    if (!same) mismatches++;
  }

  global.requestAnimationFrame = realRaf;
  global.performance.now = realNow;

  H.ok('parked rider: 0 mismatches across ' + totalTicks + ' fast-lane ticks (' + gatedSends + ' actually sent to the gated stream, vs ' + totalTicks + ' to the unsuppressed one)',
    mismatches === 0, mismatches + ' mismatch(es)');
  H.ok('the gate actually suppressed something (proves this is a real test, not a vacuous one)',
    gatedSends < totalTicks, gatedSends + ' sent of ' + totalTicks);
}

process.exit(H.report());
