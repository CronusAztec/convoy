/* Convoy — memory leak gate for js/ui.js's rider-profile overlay (P-D, T2.1).
   `node test/leaks.test.js`.

   Mission 20260903-173653-75d3 cycle 7 (aspect P-D, "use fewer resources",
   the mission's third pillar and its first cycle): BUGS.md frontend-015 was
   fixed as re-scoped (cycle 60) but left a documented residual — chaining
   profile opens (rider A's overlay, then rider B's, without closing A first)
   leaves A's 250ms `pollClose` interval and its 'stats' bus listener running
   forever, because `openProfileOverlay()`'s only cleanup path watches for
   `#onboarding` to go `hidden`, and a chained open never hides it (it just
   swaps the card via `openOverlay()`). Bounded by the overlay's eventual
   real close, but unbounded in *how many* chained opens can pile up before
   that happens, and `pollClose` is in test/visibility.test.js's POLL_ALLOW
   so it keeps ticking with the screen off too.

   Two measurement traps this suite avoids, both recorded in the cycle-7
   improve directive / this stage's own debugging:

   1. js/state.js's `on(evt, fn)` returns `function () { off(evt, fn); }` — a
      closure over the module's OWN PRIVATE `off`, not a call through
      `A.store.off`. Wrapping `A.store.off` to count detachments observes
      nothing; the returned unsubscribe function bypasses it entirely. The fix:
      substitute the function handed to the real `A.store.on()` with a
      counting wrapper, let the app's own unsubscribe closure run, then fire
      the SAME event through the real `A.store.emit()` and check whether the
      wrapper still gets called.

   2. jsdom's own window timers (setTimeout/setInterval on a REAL `new
      JSDOM(...).window`, as bootRealUi() uses) were observed on this box to
      fire drastically later than their nominal delay under CPU contention
      from a persistent, unrelated Chromium session (STATE.md §8) — a 380ms
      `setTimeout` took low tens of seconds in one measured run. Waiting
      wall-clock for that is not a fair test of this fix (test/frontend.test.js
      already treats the SAME closeOverlay() timer as non-deterministic to
      wait on, for the same underlying reason — see its "a timer race is not
      deterministic" comment). The fix: capture the actual interval callback
      `setInterval` was given and invoke it directly to simulate "one poll
      tick" deterministically, instead of waiting for jsdom's real timer to
      fire it. */
'use strict';
const H = require('./harness');
const { group, ok, report, bootRealUi } = H;

function seedNpcs(A) {
  A.mapview.addNpc = function () {};
  A.sim.remoteAdd({
    id: 'npc1', name: 'Ghost', handle: 'ghost', emoji: '👻', vibe: 'Cruising',
    car: { year: 2020, make: 'Test', model: 'Car' }, pos: [0, 0], heading: 0
  });
  A.sim.remoteAdd({
    id: 'npc2', name: 'Rival', handle: 'rival', emoji: '🏁', vibe: 'Racing',
    car: { year: 2021, make: 'Test', model: 'Car' }, pos: [0, 0], heading: 0
  });
}

// Intercepts win.setInterval/clearInterval, keeping a live list of currently
// armed callbacks so a test can invoke a "tick" synchronously — deterministic,
// unlike waiting for jsdom's own window timer to actually fire (see file
// header, trap 2).
function instrumentIntervals(win) {
  const live = []; // { id, fn }
  const counts = { armed: 0, cleared: 0 };
  const realSI = win.setInterval, realCI = win.clearInterval;
  win.setInterval = function (fn) {
    counts.armed++;
    const id = realSI.apply(this, arguments);
    live.push({ id, fn });
    return id;
  };
  win.clearInterval = function (id) {
    counts.cleared++;
    const i = live.findIndex(function (c) { return c.id === id; });
    if (i >= 0) live.splice(i, 1);
    return realCI.apply(this, arguments);
  };
  // Invokes every currently-armed callback once, simulating one real tick of
  // each. Callbacks that clearInterval() themselves (as pollClose does) are
  // safe: `live` is snapshotted with slice() before iterating.
  function tick() { live.slice().forEach(function (c) { c.fn(); }); }
  return { counts, tick };
}

// Counts every A.store.on() call made after this point, for any event —
// proves a cycle of app actions attaches no NEW subscriptions, without
// needing to know every event name the code under test might use. Paired
// with instrumentTimers() below (armed/cleared parity) this is the whole
// "net zero after N cycles" proof T2.9/task 5 asks for, applied to convoy
// join/leave instead of the profile overlay.
function instrumentBusOnCalls(A) {
  const counts = { on: 0 };
  const realOn = A.store.on;
  A.store.on = function () { counts.on++; return realOn.apply(this, arguments); };
  return counts;
}

// Generalizes instrumentIntervals() (above) to setTimeout too, so a 50-cycle
// join/leave loop — which uses A.party.invite()'s one-shot accept timer, not
// an interval — can be proven net-zero the same deterministic way (capture
// + invoke directly, per file header trap 2, rather than waiting on jsdom's
// real timers).
function instrumentTimers(win) {
  const liveIntervals = [], liveTimeouts = [];
  const counts = { intervalArmed: 0, intervalCleared: 0, timeoutArmed: 0, timeoutFired: 0 };
  const realSI = win.setInterval, realCI = win.clearInterval;
  const realST = win.setTimeout, realCT = win.clearTimeout;
  win.setInterval = function (fn) {
    counts.intervalArmed++;
    const id = realSI.apply(this, arguments);
    liveIntervals.push({ id, fn });
    return id;
  };
  win.clearInterval = function (id) {
    counts.intervalCleared++;
    const i = liveIntervals.findIndex(function (c) { return c.id === id; });
    if (i >= 0) liveIntervals.splice(i, 1);
    return realCI.apply(this, arguments);
  };
  win.setTimeout = function (fn) {
    counts.timeoutArmed++;
    const id = realST.apply(this, arguments);
    liveTimeouts.push({ id, fn });
    return id;
  };
  win.clearTimeout = function (id) {
    const i = liveTimeouts.findIndex(function (c) { return c.id === id; });
    if (i >= 0) liveTimeouts.splice(i, 1);
    return realCT.apply(this, arguments);
  };
  function tickIntervals() { liveIntervals.slice().forEach(function (c) { c.fn(); }); }
  // A real setTimeout fires exactly once, then is inert — invoking it here may
  // itself arm MORE one-shot timeouts (e.g. A.ui.toast()'s own two-stage
  // show-then-remove chain, js/ui.js:12), which is normal, not a leak: a
  // one-shot timer that fires and completes is not "retained" the way an
  // uncleared interval or an un-off()'d bus listener is. drainAll() below
  // repeatedly flushes until nothing is left pending (capped), which is the
  // actual leak-relevant question — did anything stay armed forever — rather
  // than counting fires, which this file's own toast cascade proved is not a
  // meaningful signal (armed=249 on a correct, leak-free invite/kick loop,
  // entirely explained by toast()'s nested setTimeout, not a bug).
  function drainAll(maxRounds) {
    let rounds = 0;
    while (liveTimeouts.length && rounds < maxRounds) {
      const pending = liveTimeouts.slice();
      liveTimeouts.length = 0;
      pending.forEach(function (c) { counts.timeoutFired++; c.fn(); });
      rounds++;
    }
    return liveTimeouts.length; // 0 means everything eventually completed
  }
  return { counts, tickIntervals, drainAll };
}

/* ---------------- (d) P-D task 5: convoy join/leave — 50 cycles net to
   zero. Audited before writing this (js/party.js's only ST.on('party', ...)
   is at module scope, registered once at boot, same for js/ui.js:4489 and
   js/mapview.js's rally-sync listener; A.party.invite()'s accept timer
   self-guards via a snapshotted `partyId` and is already a one-shot). No bug
   found — unlike the profile overlay (cycle 7) and buildCarSetup() (cycle
   9), convoy join/leave was already leak-free by construction. This is the
   proof, not a fix: net-zero across 50 cycles of both the local rider
   creating/leaving a convoy AND NPC members being invited/accepted/kicked. */
function checkConvoyCreateLeaveCyclesDontLeak() {
  group('js/party.js A.party.create()/leave() — 50 cycles of the local rider creating and leaving a convoy attach zero net "party"/"chat" bus subscriptions and zero net timers (P-D task 5)');
  const { win, A } = bootRealUi();
  const bus = instrumentBusOnCalls(A);
  const timers = instrumentTimers(win);

  for (let i = 0; i < 50; i++) {
    A.party.create('Test Convoy ' + i, i % 3);
    A.party.leave();
  }
  // Each create()/leave() toasts (js/ui.js's toast() arms its own self-completing
  // setTimeout chain, see instrumentTimers()'s comment) — drain those out before
  // judging whether anything is stuck, rather than counting raw arms.
  const stuck = timers.drainAll(20);

  ok('50 create()/leave() cycles attached zero NEW "party"-family subscriptions (party.js\'s own ST.on(\'party\') listener is registered once at module load, before this count started)',
    bus.on === 0, 'A.store.on() called ' + bus.on + ' times during the loop');
  ok('50 create()/leave() cycles armed zero intervals', timers.counts.intervalArmed === 0, 'armed=' + timers.counts.intervalArmed);
  ok('every timeout the 100 toasts (1 per create + 1 per leave) armed eventually fired and completed — none left stuck pending forever',
    stuck === 0, 'stuck=' + stuck + ' (armed=' + timers.counts.timeoutArmed + ', fired=' + timers.counts.timeoutFired + ')');
}

function checkConvoyMemberInviteKickCyclesDontLeak() {
  group('js/party.js A.party.invite()/kick() — 50 cycles of an NPC member being invited (accept timer fired) then kicked attach zero net bus subscriptions and leave zero net timers armed (P-D task 5)');
  const { win, A } = bootRealUi();
  seedNpcs(A);
  A.party.create('Squad', 0);
  const bus = instrumentBusOnCalls(A);
  const timers = instrumentTimers(win);

  for (let i = 0; i < 50; i++) {
    A.party.invite('npc1');
    // Fire the accept-timer (and any toast cascade it triggers) synchronously
    // (file header trap 2) — must happen every cycle: invite() leaves
    // npc.invited=true until this timer resolves, so a later invite() in the
    // loop is a no-op (js/party.js's own guard) unless this runs each time.
    // Outcome (joined or not, U.chance(0.88)) doesn't matter to this leak check.
    timers.drainAll(20);
    A.party.kick('npc1'); // no-op if the coin flip above didn't seat them — kick() is a safe no-op when not a member
  }
  const stuck = timers.drainAll(20);

  ok('50 invite()/kick() cycles attached zero NEW bus subscriptions', bus.on === 0, 'A.store.on() called ' + bus.on + ' times during the loop');
  ok('50 one-shot accept timers were armed (one per invite)', timers.counts.timeoutArmed >= 50, 'armed=' + timers.counts.timeoutArmed);
  ok('every timeout armed (accept timers + their toast cascades) eventually fired and completed — none left stuck pending forever',
    stuck === 0, 'stuck=' + stuck + ' (armed=' + timers.counts.timeoutArmed + ', fired=' + timers.counts.timeoutFired + ')');
  ok('zero intervals armed by the invite/kick path', timers.counts.intervalArmed === 0, 'armed=' + timers.counts.intervalArmed);
}

/* ---------------- (a) the exact frontend-015 residual: chained opens ---------------- */
function checkProfileOverlayHoldsNothing() {
  group('js/ui.js openProfileOverlay() — 50 chained opens + closes attach zero bus subscriptions and arm zero intervals (the frontend-015 class of leak has nothing left to leak)');
  const { win, doc, A } = bootRealUi();
  seedNpcs(A);
  const bus = instrumentBusOnCalls(A);
  const timers = instrumentIntervals(win);
  for (let i = 0; i < 50; i++) {
    A.ui.openProfileOverlay(i % 2 === 0 ? 'npc1' : 'npc2');   // chained: the previous card is superseded
    if (i % 5 === 4) A.ui.closeOverlay();                         // and sometimes closed for real
  }
  doc.getElementById('onboarding').hidden = true;
  timers.tick();
  ok('an overlay open registers no bus listener (the per-open "stats" listener is gone with the race stats it watched)', bus.on === 0, 'A.store.on calls=' + bus.on);
  ok('an overlay open arms no interval (the 250 ms pollClose detector is gone with the listener it existed to detach)', timers.counts.armed === 0, 'armed=' + timers.counts.armed);
  ok('the overlay still renders a card for the rider', !!doc.getElementById('onboarding').querySelector('.profile-overlay'));
}

checkProfileOverlayHoldsNothing();
checkConvoyCreateLeaveCyclesDontLeak();
checkConvoyMemberInviteKickCyclesDontLeak();
process.exit(report());
