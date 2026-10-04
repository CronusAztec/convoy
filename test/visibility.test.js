/* Convoy — visual-only pollers pause while the page is hidden, and one
   coalesced refresh runs on the way back. `npm test` (test/run.js)

   Why this exists: timer-owning modules never checked document.hidden
   (BUGS.md frontend-021, measured by the cycle-56 improve stage), so a
   backgrounded app kept fetching and repainting things nobody could see. The
   rider-felt half is the RESUME: coming back to the app showed stale layers
   until each timer happened to fire.

   The rule (cycle-58 improve stage §3, re-read against today's tree): anything
   that can produce an audible alert, transmit to another rider, or feed the
   data an audible alert reads keeps a plain setInterval while hidden. Only
   pixels pause, through U.poll(fn, ms). Since the store-readiness cut removed
   every pixels-only poller (the enforcement, weather, traffic and clock
   layers), the pause set is empty today — the helper and the gate stay so the
   next visual poller lands in U.poll() rather than in a bare setInterval.

   What this does, in two groups, executed against the REAL helper:
     V3  the helper's own contract, with synthetic pollers: hidden ticks do no
         work, one visibilitychange runs each DUE poller exactly once, a
         not-due poller not at all, unpoll() drops it from the resume list.
     V4  the class gate (acorn + acorn-walk, the test/globals.test.js
         toolchain): every setInterval in js/ is the helper itself or an
         allowlisted site whose reason still matches a real call, every U.poll
         has a U.unpoll partner, and js/util.js registers exactly one
         visibilitychange listener.

   When this fails: a new visual-only setInterval belongs in U.poll(fn, ms) /
   U.unpoll(id); a timer that must keep running while hidden belongs in
   POLL_ALLOW with a reason a stranger can act on — never both, never neither. */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, ROOT } = H;

const JS_DIR = path.join(ROOT, 'js');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => 'js/' + f);

/* ---------------- the harness: timers recorded, never armed ---------------- */
const win = H.installBrowser();
const armed = [];   // every setInterval(fn, ms) the modules asked for, in order
const cleared = []; // every clearInterval(id)
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
global.setInterval = function (fn, ms) { armed.push({ fn: fn, ms: ms, id: armed.length + 1 }); return armed.length; };
global.clearInterval = function (id) { cleared.push(id); };
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

H.loadModule('js/util.js');
const A = win.App, U = A.util || {};
const doc = global.document;
function run(t, hidden) { doc.hidden = !!hidden; if (t) t.fn(); }
function show(fire) { doc.hidden = false; if (fire) doc.dispatchEvent({ type: 'visibilitychange' }); }
const listeners = (type) => (typeof doc._listeners === 'function' ? doc._listeners(type) : []);

(async () => {
  /* ================= V3 — the helper's contract ================= */
  group('V3 — the coalesced resume: one visibilitychange runs each DUE poller exactly once, never a storm');
  ok('js/util.js registers exactly one document visibilitychange listener — one for all pollers, not one per poll()',
    listeners('visibilitychange').length === 1, 'listeners: ' + listeners('visibilitychange').length);
  ok('A.util.poll and A.util.unpoll are functions', typeof U.poll === 'function' && typeof U.unpoll === 'function', 'A.util keys: ' + Object.keys(U).join(','));
  if (typeof U.poll === 'function' && typeof U.unpoll === 'function') {
    let a = 0, b = 0;
    const idA = U.poll(() => { a++; }, 1000), idB = U.poll(() => { b++; }, 60000);
    const wa = armed[armed.length - 2], wb = armed[armed.length - 1];
    ok('poll(fn, ms) arms setInterval(wrapper, ms) and returns ITS id, so clearInterval bookkeeping at a call site is unchanged',
      wa && wb && wa.ms === 1000 && wb.ms === 60000 && idA === wa.id && idB === wb.id, 'ids ' + idA + '/' + idB + ' vs ' + (wa && wa.id) + '/' + (wb && wb.id));
    run(wa, true); const hiddenRuns = a; run(wa, false);
    ok('the wrapper reads document.hidden at TICK time — hidden: skipped, visible: runs (a cached flag would fail here)', hiddenRuns === 0 && a === 1, 'a=' + a + ' after hidden=' + hiddenRuns);
    run(wb, false);
    doc.hidden = true; clock += 5000; show(true);
    ok('due only: 5 s hidden → the 1 s poller ran once on resume, the 60 s poller not at all', a === 2 && b === 1, 'a=' + a + ' b=' + b);
    doc.hidden = true; clock += 100; show(true);
    ok('not due: 100 ms hidden → the visibilitychange fires NOTHING (no request storm when flicking between apps)', a === 2 && b === 1, 'a=' + a + ' b=' + b);
    clock += 301000;
    doc.hidden = true; doc.dispatchEvent({ type: 'visibilitychange' });
    ok('a visibilitychange while still hidden fires nothing — the listener only acts on the way back', a === 2 && b === 1, 'a=' + a + ' b=' + b);
    show(false);
    U.unpoll(idA);
    doc.hidden = true; clock += 600000; show(true);
    ok('unpoll(id) clears the interval AND drops the poller from the resume list: 10 min later the resume runs b, never a', cleared.indexOf(idA) >= 0 && a === 2 && b === 2, 'cleared=' + cleared.indexOf(idA) + ' a=' + a + ' b=' + b);
    U.unpoll(idB);
    ok('unpoll returns null, the value every call site stores back into its timer variable', U.unpoll(idB) === null);
  }

  /* ================= V4 — the class gate ================= */
  group('V4 — class gate: every setInterval in js/ is the helper itself or an allowlisted timer that alerts, transmits or feeds an alert');
  // The §3.2 table of the cycle-58 improve directive, machine-checked and
  // trimmed to the modules that still ship. `fn` is the identifier passed to
  // setInterval, or a call inside the inline function that identifies it
  // (word-bounded, so `tick` never matches predictTick). Anti-rot both ways:
  // every entry must still match a real bare site, and every bare site must
  // be matched by exactly one entry.
  const POLL_ALLOW = {
    'js/net.js': [{ fn: 'sendPos', why: 'your position to your convoy, 1 Hz — the product' }],
    'js/voice.js': [
      { fn: 'shouldTransmit', why: 'the 33 ms mic gate flips micTrack.enabled; paused, push-to-talk never opens the mic with the screen off' },
      { fn: 'reconcile', why: 'proximity-voice membership: riders drift in and out of range while you ride' }
    ],
    'js/state.js': [{ fn: 'applyTheme', why: 'sun-synced theme, 60 s: two comparisons, no network, no paint — pausing buys nothing' }],
    'js/space.js': [{ fn: 'refreshNight', why: 'already visibility-aware: returns unless `active`, and the rAF loop stops on its own visibilitychange listener' }],
    'js/sim.js': [
      { fn: 'tick', why: 'start(): the 1 s UI tick (ST.emit("tick") → nearby/convoy panels; the solo physics it used to step was deleted in cycle 60, frontend-003) — paused and re-armed by its own visibilitychange listener' },
      { fn: 'tick', why: 'that visibilitychange listener re-arming the UI tick on return' }
    ]
  };
  // The pause set, by file: every U.poll() call must be here, and every count
  // must hold. Empty today (see the header); a new visual poller adds a row.
  const POLL_SITES = {};
  const bare = [], helperSites = [], pollCalls = {}, unpollCalls = {}, parseErrors = [];
  let visListeners = 0, visInsidePoll = 0;
  const propName = (c, name) => c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === name;
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); } catch (e) { parseErrors.push(rel + ': ' + e.message); continue; }
    walk.ancestor(ast, {
      CallExpression(node, _s, ancestors) {
        const c = node.callee;
        const inPoll = ancestors.some((a) => a.type === 'FunctionDeclaration' && a.id && a.id.name === 'poll');
        if ((c.type === 'Identifier' && c.name === 'setInterval') || propName(c, 'setInterval')) {
          const a0 = node.arguments[0];
          const site = { key: rel + ':' + node.loc.start.line, file: rel, line: node.loc.start.line, arg: a0 ? src.slice(a0.start, a0.end) : '' };
          if (inPoll && rel === 'js/util.js') helperSites.push(site); else bare.push(site);
        } else if (propName(c, 'poll') && (c.object.type === 'Identifier' || propName(c.object, 'util'))) {
          pollCalls[rel] = (pollCalls[rel] || 0) + 1;                      // U.poll(...) or A.util.poll(...)
        } else if (propName(c, 'unpoll')) {
          unpollCalls[rel] = (unpollCalls[rel] || 0) + 1;
        } else if (propName(c, 'addEventListener') && rel === 'js/util.js' && node.arguments[0] && node.arguments[0].type === 'Literal' && node.arguments[0].value === 'visibilitychange') {
          visListeners++; if (inPoll) visInsidePoll++;
        }
      }
    });
  }
  const violations = [], stale = [];
  const byFile = {};
  for (const s of bare) (byFile[s.file] = byFile[s.file] || []).push(s);
  const allowFiles = Object.keys(POLL_ALLOW);
  for (const file of new Set(allowFiles.concat(Object.keys(byFile)))) {
    const entries = (POLL_ALLOW[file] || []).slice();
    for (const s of byFile[file] || []) {
      const i = entries.findIndex((e) => new RegExp('\\b' + e.fn + '\\b').test(s.arg));
      if (i >= 0) entries.splice(i, 1); else violations.push(s.key + ' (' + s.arg.replace(/\s+/g, ' ').slice(0, 40) + ')');
    }
    entries.forEach((e) => stale.push(file + ' fn=' + e.fn));
  }
  const allowCount = allowFiles.reduce((t, f) => t + POLL_ALLOW[f].length, 0);
  const pollTotal = Object.keys(pollCalls).reduce((t, f) => t + pollCalls[f], 0);
  const unpollTotal = Object.keys(unpollCalls).reduce((t, f) => t + unpollCalls[f], 0);
  console.log('    setInterval sites: ' + (bare.length + helperSites.length) + ' | the helper: ' + helperSites.length + ' | allowlisted: ' + (bare.length - violations.length) +
    ' | violations: ' + violations.length + ' | U.poll() calls: ' + pollTotal + ' | U.unpoll() calls: ' + unpollTotal);
  ok('every js/*.js parses (' + jsFiles.length + ' files) and the scan is real: >= 8 setInterval sites found (' + (bare.length + helperSites.length) + ')',
    parseErrors.length === 0 && bare.length + helperSites.length >= 8, parseErrors.join('; '));
  ok('exactly one setInterval lives inside a function named poll, and it is in js/util.js — the single place a visual poller may arm a timer',
    helperSites.length === 1 && helperSites[0].file === 'js/util.js', 'helper sites: ' + helperSites.map((s) => s.key).join(', ') || 'none');
  ok('every other setInterval is allowlisted with a reason that still matches its call — 0 violations (' + violations.length + ' found)',
    violations.length === 0, 'convert to U.poll(fn, ms) or add to POLL_ALLOW with a reason: ' + violations.join('  '));
  ok('anti-rot: every POLL_ALLOW entry still names a real bare setInterval (an entry that stops matching must be removed, not kept)',
    stale.length === 0, 'stale: ' + stale.join(', '));
  ok('the allowlist is the §3.2 table trimmed to the shipping modules: exactly 7 entries across 5 files (an 8th needs the reason written here, not a quiet addition)',
    allowCount === 7 && allowFiles.length === 5, allowCount + ' entries / ' + allowFiles.length + ' files');
  const pollFiles = Object.keys(pollCalls).sort();
  const wrongCounts = Object.keys(POLL_SITES).filter((f) => (pollCalls[f] || 0) !== POLL_SITES[f]);
  const newFiles = pollFiles.filter((f) => !(f in POLL_SITES));
  ok('the pause set is exactly POLL_SITES — empty today, every pixels-only poller left with the layers it drew (' + pollTotal + ' found)',
    wrongCounts.length === 0 && newFiles.length === 0,
    'counts: ' + JSON.stringify(pollCalls) + (newFiles.length ? ' — new pause-set file(s), add to POLL_SITES with why they are pixels-only: ' + newFiles.join(', ') : ''));
  ok('every U.poll() has a U.unpoll() partner in the same file (' + unpollTotal + ' unpoll calls for ' + pollTotal + ' poll sites)',
    unpollTotal === pollTotal && Object.keys(POLL_SITES).every((f) => (unpollCalls[f] || 0) === POLL_SITES[f]), 'unpoll counts: ' + JSON.stringify(unpollCalls));
  ok('js/util.js registers exactly one visibilitychange listener, outside poll() (one resume loop, not one per poller)',
    visListeners === 1 && visInsidePoll === 0, 'listeners in util.js: ' + visListeners + ' (inside poll: ' + visInsidePoll + ')');
  const utilSrc = fs.readFileSync(path.join(ROOT, 'js', 'util.js'), 'utf8');
  const pollAt = utilSrc.indexOf('function poll(');
  const pollCtx = pollAt >= 0 ? utilSrc.slice(Math.max(0, pollAt - 900), pollAt + 500) : '';
  ok('the reasoning lives at the helper, not only here: the comment around `function poll(` in js/util.js names frontend-021, the allowlist suite and the due-only resume',
    pollAt >= 0 && /frontend-021/.test(pollCtx) && /visibility\.test\.js/.test(pollCtx) && /due/.test(pollCtx), 'found at ' + pollAt);

  global.setInterval = realSetInterval; global.clearInterval = realClearInterval;
  Date.now = realNow;
  process.exit(H.report());
})().catch((e) => { console.error(e); process.exit(1); });
