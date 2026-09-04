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

// Intercepts A.store.on('stats', ...) and substitutes a counting wrapper for
// whatever function js/ui.js registers, so a later A.store.emit('stats', …)
// proves — by actually invoking the real bus, not by trusting a call count on
// A.store.off — whether that specific registration is still subscribed.
function instrumentStatsBus(A) {
  const regs = []; // { calls }
  const realOn = A.store.on;
  A.store.on = function (evt, fn) {
    if (evt !== 'stats') return realOn.call(this, evt, fn);
    const rec = { calls: 0 };
    regs.push(rec);
    return realOn.call(this, evt, function (e) { rec.calls++; return fn(e); });
  };
  return regs;
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

/* ---------------- (a) the exact frontend-015 residual: chained opens ---------------- */
function checkChainedOpensDontLeak() {
  group('js/ui.js openProfileOverlay() — chaining opens (rider A -> rider B without closing A) detaches A\'s "stats" listener + pollClose interval instead of leaking them until the whole overlay finally closes (BUGS.md frontend-015 residual)');
  const { win, A } = bootRealUi();
  seedNpcs(A);
  const regs = instrumentStatsBus(A);
  const timers = instrumentIntervals(win);

  A.ui.openProfileOverlay('npc1');
  A.ui.openProfileOverlay('npc2'); // chained: npc1's overlay is superseded, never explicitly closed
  ok('two "stats" listeners were attached (one per open)', regs.length === 2, regs.length);
  ok('two pollClose intervals were armed (one per open)', timers.counts.armed === 2, timers.counts.armed);

  timers.tick(); // simulate one 250ms pollClose tick for both intervals

  ok('the superseded (npc1) overlay\'s pollClose interval self-cleared within one tick of being superseded, not left running until final close',
    timers.counts.cleared === 1, 'cleared=' + timers.counts.cleared);

  A.store.emit('stats', { id: 'npc1' });
  ok('npc1\'s "stats" listener no longer fires after being superseded — it was really unsubscribed, not just outlived by a guard elsewhere',
    regs[0].calls === 0, 'calls=' + regs[0].calls);
  ok('npc2\'s "stats" listener (the still-open overlay) still fires normally',
    regs[1].calls === 1, 'calls=' + regs[1].calls);
}

/* ---------------- (b) regression guard: a real close still detaches (the
   already-fixed half of frontend-015 — must not regress) ---------------- */
function checkRealCloseStillDetaches() {
  group('js/ui.js openProfileOverlay() — closing the overlay for real (not chaining) still detaches its "stats" listener + pollClose interval (regression guard for the already-fixed half of frontend-015)');
  const { win, doc, A } = bootRealUi();
  seedNpcs(A);
  const regs = instrumentStatsBus(A);
  const timers = instrumentIntervals(win);

  A.ui.openProfileOverlay('npc1');
  A.ui.closeOverlay();
  ok('closeOverlay() synchronously starts the exit animation ("closing" class)',
    doc.getElementById('onboarding').classList.contains('closing'));

  // closeOverlay's real cleanup (root.hidden = true) is behind its own 380ms
  // setTimeout, a genuine jsdom window timer — see file header, trap 2, for
  // why this suite doesn't wait on it. pollClose only ever checks
  // `root.hidden`, so forcing that terminal state directly and ticking the
  // interval by hand exercises the exact same cleanup path the real timer
  // would eventually reach.
  doc.getElementById('onboarding').hidden = true;
  timers.tick();

  ok('the pollClose interval cleared once the overlay was hidden', timers.counts.cleared === 1, 'cleared=' + timers.counts.cleared);
  A.store.emit('stats', { id: 'npc1' });
  ok('the "stats" listener no longer fires after a real close', regs[0].calls === 0, 'calls=' + regs[0].calls);
}

/* ---------------- (c) scale: 50 open/close cycles net to zero ---------------- */
function checkFiftyOpenCloseCyclesNetZero() {
  group('js/ui.js openProfileOverlay() — 50 open/close cycles leave zero net "stats" listeners and zero net pollClose intervals armed (P-D scale requirement, this cycle\'s scope: the profile overlay only)');
  const { win, doc, A } = bootRealUi();
  seedNpcs(A);
  const regs = instrumentStatsBus(A);
  const timers = instrumentIntervals(win);

  for (let i = 0; i < 50; i++) {
    A.ui.openProfileOverlay(i % 2 === 0 ? 'npc1' : 'npc2');
    A.ui.closeOverlay();
  }
  // The first 49 opens are each superseded by the next before closeOverlay's
  // own timer could matter (openOverlay()'s cancelOverlayClose() cancels it
  // outright) — their pollClose intervals clear via the supersession branch.
  // Only the 50th (nothing supersedes it) needs the real "closed" state;
  // force it directly (file header, trap 2) rather than wait on it.
  doc.getElementById('onboarding').hidden = true;
  timers.tick();

  ok('50 opens armed 50 pollClose intervals', timers.counts.armed === 50, 'armed=' + timers.counts.armed);
  ok('all 50 pollClose intervals were cleared — no net growth after 50 cycles', timers.counts.cleared === 50,
    'armed=' + timers.counts.armed + ' cleared=' + timers.counts.cleared + ' net=' + (timers.counts.armed - timers.counts.cleared));
  ok('50 "stats" listeners were registered (one per open)', regs.length === 50, regs.length);
  A.store.emit('stats', { id: 'npc1' });
  A.store.emit('stats', { id: 'npc2' });
  const stillFiring = regs.filter(function (r) { return r.calls > 0; }).length;
  ok('none of the 50 registered listeners still fire after their overlay closed — net zero, not just bounded',
    stillFiring === 0, stillFiring + ' of 50 still fire');
}

checkChainedOpensDontLeak();
checkRealCloseStillDetaches();
checkFiftyOpenCloseCyclesNetZero();
process.exit(report());
