/* Convoy — every client fetch() has a deadline. `npm test` (test/run.js)

   Why this exists: 22 of the app's 23 `fetch` call sites had no AbortSignal
   (cycle-56 improve stage, 2026-09-03 — BUGS.md frontend-020) while all of
   the server's upstream families had one. A fetch with no signal never
   rejects when the socket stalls — a tunnel, a captive portal, a dropped TCP
   session with no RST, exactly what happens to a phone on a motorcycle — so
   the `.catch()` that clears a layer's latch never runs and the feature is
   dead for the rest of the ride, with no error, no toast and no log line.

   What this does, in three groups:
     B  an AST class gate (acorn + acorn-walk, the test/globals.test.js
        toolchain — a regex matches the word "fetch" in comments): every
        fetch() in js/ is the helper itself, carries a static `signal`, or is
        on the allowlist below — and every allowlist entry must still name a
        real bare site (anti-rot, as test/bugstats.test.js does for evidence
        paths). A new bare fetch fails npm test by name.
     D  A.util.fetchT() itself, executed: the default deadline, a caller's own
        signal, untouched opts, and the engine fallbacks.
     E  nothing under test left a rejected promise without a handler.

   Run:  node test/fetchtimeout.test.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, ROOT } = H;

const JS_DIR = path.join(ROOT, 'js');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => 'js/' + f);

/* ---------------- boot: util + state + ghost in the harness ----------------
   ghost.js arms its always-on police/hotspot pollers at load. Record the
   timers instead of arming them: the 90 s police tick is exactly the function
   group A wants to call by hand, and nothing keeps the process alive. */
const win = H.installBrowser();
const armed = [];
const realSetInterval = global.setInterval;
global.setInterval = function (fn, ms) { armed.push({ fn: fn, ms: ms }); return armed.length; };
H.loadModule('js/util.js');
H.loadModule('js/state.js');
global.setInterval = realSetInterval;
const A = win.App;
const U = A.util || {};

const BB = { minLat: 51.4, minLng: -0.2, maxLat: 51.6, maxLng: 0.0 }; // London, a ~22 km box
const settle = () => new Promise((r) => setTimeout(r, 0)); // one macrotask drains the whole .then/.catch chain

/* ---------------- fakes shared by A and D ----------------
   fetch: records the call; with a signal it rejects when that signal aborts,
   without one it NEVER settles — exactly what a stalled socket does.
   AbortSignal.timeout: records the deadline asked for and hands back a signal
   the test fires on demand, so 75 s of "waiting" costs nothing. */
const calls = [];
const deadlines = [];
function fakeFetch(url, opts) {
  const rec = { url: url, opts: opts || {}, signal: opts && opts.signal, settled: false };
  calls.push(rec);
  return new Promise((resolve, reject) => {
    if (!rec.signal) return; // hang forever
    const fail = () => { rec.settled = true; reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); };
    if (rec.signal.aborted) fail(); else rec.signal.addEventListener('abort', fail);
  });
}
// A deadline that fires turns a stall into a rejection — every call site under
// test must own that rejection. A rejection nobody handles is a failed check
// (below), never a silent crash of this process.
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String((e && e.message) || e)); });
function fakeTimeout(ms) { const c = new AbortController(); deadlines.push({ ms: ms, c: c }); return c.signal; }
function elapse() { deadlines.splice(0).forEach((d) => d.c.abort()); }
const realFetch = global.fetch, realTimeout = AbortSignal.timeout;
const T = U.FETCH_TIMEOUT;

(async () => {
  group('B — class gate: every fetch() in js/ is A.util.fetchT() itself, carries a static `signal`, or is allowlisted with a reason that still holds');
  // Bare-fetch sites the gate accepts, 'js/file.js:LINE': 'why'. Each entry
  // must still match a real bare site (anti-rot) and its reason is re-checked
  // below. Anything else belongs in A.util.fetchT(), not here.
  const ALLOW = {
    'js/routing.js:84': 'fetchJSON(url, init): init is built as { signal: opts.signal || ctrl.signal } two lines up, with its own FETCH_TIMEOUT_MS abort timer'
  };
  const sites = [], fetchTCalls = [], aliases = [], parseErrors = [];
  const hasSignalProp = (o) => !!o && o.type === 'ObjectExpression' && o.properties.some((p) =>
    p.type === 'Property' && ((!p.computed && p.key.type === 'Identifier' && p.key.name === 'signal') || (p.key.type === 'Literal' && p.key.value === 'signal')));
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); } catch (e) { parseErrors.push(rel + ': ' + e.message); continue; }
    walk.ancestor(ast, {
      CallExpression(node, _s, ancestors) {
        const c = node.callee;
        const prop = (name) => c.type === 'MemberExpression' && ((!c.computed && c.property.type === 'Identifier' && c.property.name === name) || (c.computed && c.property.type === 'Literal' && c.property.value === name));
        if ((c.type === 'Identifier' && c.name === 'fetch') || prop('fetch')) {
          sites.push({
            key: rel + ':' + node.loc.start.line, file: rel, line: node.loc.start.line,
            hasSignal: hasSignalProp(node.arguments[1]),
            inFetchT: ancestors.some((a) => a.type === 'FunctionDeclaration' && a.id && a.id.name === 'fetchT')
          });
        } else if (prop('fetchT')) {
          const a0 = node.arguments[0], a2 = node.arguments[2];
          fetchTCalls.push({
            key: rel + ':' + node.loc.start.line,
            url: a0 && a0.type === 'Identifier' ? a0.name : (a0 ? a0.type : 'none'),
            ms: a2 ? src.slice(a2.start, a2.end) : ''
          });
        }
      },
      Identifier(node, _s, ancestors) {
        if (node.name !== 'fetch') return;
        const parent = ancestors[ancestors.length - 2];
        if (!parent) return;
        if (parent.type === 'CallExpression' && parent.callee === node) return;        // fetch(...)
        if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return; // typeof fetch
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return; // window.fetch
        if (parent.type === 'Property' && parent.key === node) return;                 // { fetch: … }
        aliases.push(rel + ':' + node.loc.start.line + ' (' + parent.type + ')');
      }
    });
  }
  const bare = sites.filter((s) => !s.hasSignal && !s.inFetchT);
  const helperSites = sites.filter((s) => s.inFetchT);
  const violations = bare.filter((s) => !(s.key in ALLOW));
  const stale = Object.keys(ALLOW).filter((k) => !bare.some((s) => s.key === k));
  const wrap = (arr) => arr.map((s) => s.key).join('  ') || 'none';
  console.log('    fetch() call sites: ' + sites.length + ' | with static signal: ' + sites.filter((s) => s.hasSignal).length +
    ' | the helper: ' + helperSites.length + ' | A.util.fetchT() calls: ' + fetchTCalls.length +
    ' | bare fetch sites: ' + bare.length + ' (allowlisted ' + (bare.length - violations.length) + ', violations ' + violations.length + ')');
  console.log('    bare: ' + wrap(bare));
  ok('every js/*.js parses with acorn (' + jsFiles.length + ' files) and the scan is real: >= 3 transport call sites (fetch + A.util.fetchT) found (' + (sites.length + fetchTCalls.length) + ')',
    parseErrors.length === 0 && jsFiles.length >= 15 && sites.length + fetchTCalls.length >= 3, parseErrors.join('; ') + ' fetch=' + sites.length + ' fetchT=' + fetchTCalls.length);
  ok('exactly one fetch() lives inside a function named fetchT, and it is in js/util.js — the single place a bare transport call is allowed',
    helperSites.length === 1 && helperSites[0].file === 'js/util.js', 'helper sites: ' + wrap(helperSites));
  ok('every other fetch() goes through A.util.fetchT(), passes a static `signal`, or is allowlisted — 0 violations (' + violations.length + ' found)',
    violations.length === 0, 'route these through A.util.fetchT(url, opts, ms): ' + wrap(violations));
  ok('the allowlist has exactly the one justified entry (js/routing.js fetchJSON) — anything more is scope creep',
    Object.keys(ALLOW).length === 1 && 'js/routing.js:84' in ALLOW);
  ok('anti-rot: every allowlist entry still names a real bare fetch site (an entry that stops matching must be removed, not kept)',
    stale.length === 0, 'stale: ' + stale.join(', '));
  ok('no fetch aliasing: every `fetch` identifier in js/ is a call\'s callee, a typeof operand or a `window.fetch` test — nothing is bound to a local and called later',
    aliases.length === 0, aliases.join('; '));
  // The reason, re-checked against the source each run.
  const routingSrc = fs.readFileSync(path.join(ROOT, 'js', 'routing.js'), 'utf8');
  const fjAt = routingSrc.indexOf('function fetchJSON(url, opts)');
  const fj = fjAt >= 0 ? routingSrc.slice(fjAt, routingSrc.indexOf('\n  }\n', fjAt)) : '';
  ok('js/routing.js:84 reason holds: fetchJSON builds `init = { signal: signal }` from opts.signal || its own AbortController, armed with a FETCH_TIMEOUT_MS abort timer',
    /var signal = opts\.signal \|\| \(ctrl && ctrl\.signal\);/.test(fj) && /var init = \{ signal: signal \};/.test(fj) &&
    /setTimeout\(function \(\) \{ if \(ctrl\) ctrl\.abort\(\); \}, FETCH_TIMEOUT_MS\)/.test(fj) && /return fetch\(url, init\)/.test(fj),
    'fetchJSON body: ' + fj.replace(/\s+/g, ' ').slice(0, 200));
  ok('js/telemetry.js (loads before util.js — index.html, second on purpose) keeps an inline `signal:` on its fetch instead of A.util.fetchT',
    sites.some((s) => s.file === 'js/telemetry.js' && s.hasSignal) && !fetchTCalls.some((c) => /^js\/telemetry\.js/.test(c.key)),
    'telemetry sites: ' + sites.filter((s) => s.file === 'js/telemetry.js').map((s) => s.key + (s.hasSignal ? ' signal' : ' bare')).join(', '));

  /* ================= D — the helper itself, executed ================= */
  group('D — A.util.fetchT(url, opts, ms): default deadline, caller signal honoured, opts untouched, engine fallbacks');
  const fetchT = U.fetchT;
  ok('A.util.fetchT is a function', typeof fetchT === 'function', 'A.util keys: ' + Object.keys(U).slice(0, 8).join(',') + '…');
  if (typeof fetchT === 'function') {
    global.fetch = fakeFetch; AbortSignal.timeout = fakeTimeout;
    calls.length = 0; deadlines.length = 0;
    fetchT('/api/x').catch(() => {});
    ok('fetchT(url) with no opts: fetch() receives an options object carrying a signal, deadline = FETCH_TIMEOUT.api',
      calls.length === 1 && !!calls[0].signal && deadlines.length === 1 && deadlines[0].ms === T.api, 'calls=' + calls.length + ' deadlines=' + JSON.stringify(deadlines.map((d) => d.ms)));
    const mine = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    calls.length = 0; deadlines.length = 0;
    fetchT('/api/y', mine, 20000).catch(() => {});
    ok('fetchT(url, opts, ms): method/headers/body pass through, the deadline is ms, and the caller\'s opts object is NOT mutated (no signal written onto it)',
      calls.length === 1 && calls[0].opts.method === 'POST' && calls[0].opts.body === '{}' && !!calls[0].signal && deadlines[0].ms === 20000 && !('signal' in mine),
      'opts keys seen by fetch: ' + Object.keys(calls[0] ? calls[0].opts : {}).join(',') + ' caller keys: ' + Object.keys(mine).join(','));
    const ctrl = new AbortController();
    calls.length = 0; deadlines.length = 0;
    fetchT('/api/z', { signal: ctrl.signal }, 5000).catch(() => {});
    const passed = calls[0] && calls[0].signal;
    ctrl.abort();
    ok('a caller-supplied signal is honoured: aborting the caller\'s controller aborts the signal fetch() received' +
      (typeof AbortSignal.any === 'function' ? ' (combined with the deadline through AbortSignal.any)' : ' (no AbortSignal.any on this engine — the caller\'s signal wins)'),
      !!passed && passed.aborted === true && (typeof AbortSignal.any !== 'function' || deadlines.length === 1), 'aborted=' + (passed && passed.aborted) + ' deadlines=' + deadlines.length);
    // Engines without AbortSignal.timeout (older WebViews): AbortController + setTimeout.
    AbortSignal.timeout = undefined;
    calls.length = 0; deadlines.length = 0;
    fetchT('/api/old', undefined, 5).catch(() => {});
    const fb = calls[0] && calls[0].signal;
    await new Promise((r) => setTimeout(r, 30));
    ok('no AbortSignal.timeout: the AbortController + setTimeout fallback still produces a signal, and it aborts after ms (5 ms here)',
      !!fb && fb.aborted === true, 'signal=' + !!fb + ' aborted=' + (fb && fb.aborted));
    // Engines with neither: a plain fetch, exactly as before this cycle — never a throw.
    const RC = global.AbortController;
    Object.defineProperty(global, 'AbortController', { value: undefined, writable: true, configurable: true });
    let threw = null;
    calls.length = 0;
    try { fetchT('/api/ancient').catch(() => {}); } catch (e) { threw = e; }
    Object.defineProperty(global, 'AbortController', { value: RC, writable: true, configurable: true });
    ok('no AbortSignal.timeout and no AbortController: fetchT degrades to a plain fetch (no signal, no throw)',
      threw === null && calls.length === 1 && !calls[0].signal, threw ? threw.message : 'calls=' + calls.length);
    global.fetch = realFetch; AbortSignal.timeout = realTimeout;
  }

  await settle();
  group('E — nothing under test left a rejected promise without a handler (a fired deadline is a rejection every call site must own)');
  ok('0 unhandled rejections during this run (' + unhandled.length + ')', unhandled.length === 0, unhandled.join(' | '));

  process.exit(H.report());
})().catch((e) => { console.error(e); process.exit(1); });
