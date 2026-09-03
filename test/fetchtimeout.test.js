/* Convoy — every client fetch() has a deadline. `npm test` (test/run.js)

   Why this exists: 22 of the app's 23 `fetch` call sites had no AbortSignal
   (cycle-56 improve stage, 2026-09-03 — BUGS.md frontend-020) while all five
   of the server's upstream families had one. A fetch with no signal never
   rejects when the socket stalls — a tunnel, a captive portal, a dropped TCP
   session with no RST, exactly what happens to a phone on a motorcycle — so
   the `.catch()` that clears a map layer's bbox latch never runs. Five layers
   share the idiom (police/cameras/ALPR, live Waze police, hotspots, traffic
   incidents, NWS alerts): the latch is set BEFORE the fetch and cleared only
   in `.catch()`, and js/ghost.js bboxChanged() only re-asks after a ~66 km
   pan. One stalled /api/overpass response and the enforcement layer is dead
   for the rest of the ride, with no error, no toast and no log line.

   What this does, in four groups:
     A  the latch mechanism lifted verbatim out of js/ghost.js and run over a
        stubbed transport, then the REAL fetchPolice() executed in the harness
        with a transport that stalls: before A.util.fetchT() one fetch is ever
        issued; after it the deadline turns the stall into a rejection, the
        latch clears, the backoff arms, and the layer keeps asking.
     B  an AST class gate (acorn + acorn-walk, the test/globals.test.js
        toolchain — a regex matches the word "fetch" in comments): every
        fetch() in js/ is the helper itself, carries a static `signal`, or is
        on the two-entry allowlist below — and every allowlist entry must
        still name a real bare site (anti-rot, as test/bugstats.test.js does
        for evidence paths). The 23rd bare fetch fails npm test by name.
     C  the cross-file timeout floor: the Overpass proxy tries MIRRORS.length
        mirrors at server/overpass.js TIMEOUT_MS each, so a cold-cache lookup
        legitimately takes mirrors × timeout. A client deadline below that
        aborts WORKING requests and makes the layer worse. Pinned here the
        way cycle 56 pinned AUTH_FLOOD_MAX >= sum(ANON_AUTH_BUDGET).
     D  the helper itself: default deadline, caller signal honoured (combined
        through AbortSignal.any where the engine has it), the caller's opts
        never mutated, the AbortController fallback, the no-abort engine.

   When this fails: route the new call through A.util.fetchT(url, opts, ms)
   (telemetry.js is the one inline exception — it loads before util.js). Do
   not add an allowlist entry; do not lower FETCH_TIMEOUT.overpass without
   lowering the server's MIRRORS × TIMEOUT_MS first. */
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
H.loadModule('js/ghost.js');
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

(async () => {
  /* ================= A1 — the latch, lifted and executed over a stub ================= */
  group('A1 — js/ghost.js bboxChanged() lifted verbatim: a transport that never settles latches the enforcement layer for good');
  const ghostSrc = fs.readFileSync(path.join(ROOT, 'js', 'ghost.js'), 'utf8');
  const bbAt = ghostSrc.indexOf('function bboxChanged(bb)');
  const bbEnd = ghostSrc.indexOf('function policeOn()');
  const bbBody = (bbAt >= 0 && bbEnd > bbAt) ? ghostSrc.slice(bbAt, bbEnd) : '';
  ok('lift: bboxChanged() … policeOn() found once in js/ghost.js, still the 0.6° centre-move rule (a refactor fails here, loudly)',
    bbBody.length > 0 && /movedLat > 0\.6 \|\| movedLng > 0\.6/.test(bbBody) && ghostSrc.indexOf('function bboxChanged(bb)', bbAt + 1) === -1,
    'at=' + bbAt + ' end=' + bbEnd + ' len=' + bbBody.length);
  // bboxChanged closes over lastPoliceBbox; bind the lifted source to the latch of the moment.
  const bboxChangedFor = (last) => new Function('lastPoliceBbox', bbBody + '\nreturn bboxChanged;')(last);
  // The guard order of fetchPolice(), in structure: gate → set the latch → issue the fetch.
  // 'reject' models what a deadline turns a stall into: js/ghost.js's .catch() clears the latch.
  function ticks(transport) {
    let last = null, fetches = 0;
    const log = [];
    for (let i = 1; i <= 5; i++) {
      if (last && !bboxChangedFor(last)(BB)) { log.push('90s tick ' + i + ': skipped (latched)'); continue; }
      last = BB; fetches++;
      if (transport === 'reject') { last = null; log.push('90s tick ' + i + ': fetched -> catch cleared the latch'); }
      else log.push('90s tick ' + i + ': fetched -> promise pending forever');
    }
    return { fetches: fetches, log: log };
  }
  const hang = ticks('hang'), rej = ticks('reject');
  console.log('    --- transport hangs ---\n      ' + hang.log.join('\n      ') + '\n    --- transport rejects ---\n      ' + rej.log.join('\n      '));
  ok('lifted: with the transport hanging, five 90 s ticks issue exactly 1 fetch — ticks 2-5 are "skipped (latched)"',
    hang.fetches === 1 && hang.log.slice(1).every((l) => /latched/.test(l)), 'fetches=' + hang.fetches);
  ok('lifted: the same view, unmoved, is never re-asked: bboxChanged(sameBox) is false once the latch is set',
    bboxChangedFor(BB)(BB) === false && bboxChangedFor(null)(BB) === true);
  ok('lifted: with the transport rejecting, all five ticks fetch — the .catch() path is the only thing that frees the layer',
    rej.fetches === 5, 'fetches=' + rej.fetches);

  /* ================= A2 — the REAL fetchPolice(), executed ================= */
  group('A2 — executed: the real fetchPolice() with a transport that stalls, before and after the deadline (frontend-020)');
  const realFetch = global.fetch, realTimeout = AbortSignal.timeout, realNow = Date.now;
  let clock = realNow();
  global.fetch = fakeFetch;
  AbortSignal.timeout = fakeTimeout;
  Date.now = () => clock;
  A.mapview = {
    map: () => ({ getBounds: () => ({ getSouthWest: () => ({ lat: BB.minLat, lng: BB.minLng }), getNorthEast: () => ({ lat: BB.maxLat, lng: BB.maxLng }) }) }),
    setPoliceData() {}
  };
  const policeTimers = armed.filter((a) => a.ms === 90000);
  const policeTick = policeTimers.length ? policeTimers[0].fn : null;
  ok('the police poll is armed at load: exactly one setInterval(fn, 90000) recorded (POLICE_MS) — that fn is fetchPolice',
    policeTimers.length === 1 && typeof policeTick === 'function', 'intervals armed: ' + armed.map((a) => a.ms).join(','));
  const counts = [];
  if (policeTick) {
    policeTick();
    counts.push(calls.length);
    const first = calls[0] || { opts: {} };
    let kind = null; try { kind = JSON.parse(first.opts.body).kind; } catch (e) { /* not JSON */ }
    ok('executed: the first tick issues exactly one POST /api/overpass {kind:"enforcement"}',
      calls.length === 1 && /\/api\/overpass$/.test(String(first.url)) && kind === 'enforcement', 'calls=' + calls.length + ' url=' + first.url + ' kind=' + kind);
    ok('executed: that request carries an AbortSignal — a stalled socket can now reject (bare fetch(OVERPASS_PROXY, {…}) before the fix)',
      !!first.signal, 'opts keys: ' + Object.keys(first.opts).join(','));
    ok('executed: the deadline asked for is A.util.FETCH_TIMEOUT.overpass (the 2 mirrors × 30 s server budget plus slack — group C)',
      deadlines.length === 1 && !!U.FETCH_TIMEOUT && deadlines[0].ms === U.FETCH_TIMEOUT.overpass,
      'deadlines=' + JSON.stringify(deadlines.map((d) => d.ms)) + ' table=' + JSON.stringify(U.FETCH_TIMEOUT || null));
    policeTick();
    ok('executed: a second tick while the request is pending is skipped by the bbox latch (the latch itself is right; the missing deadline was the bug)',
      calls.length === 1, 'calls=' + calls.length);
    elapse(); await settle();
    policeTick();
    ok('executed: once the deadline fires, a tick inside backoffFail(\'police\', 90 s) is still skipped — a timeout is a failure, not a free retry',
      calls.length === 1 && (calls[0].settled || !calls[0].signal), 'calls=' + calls.length + ' settled=' + calls[0].settled);
    clock += 90000; policeTick();
    counts.push(calls.length);
    ok('executed: 90 s later the latch is clear and the layer asks again — 2 fetches over 3 ticks (1 before the fix: dead for the session)',
      calls.length === 2, 'calls=' + calls.length);
    for (let k = 3; k <= 5; k++) { elapse(); await settle(); clock += 90000; policeTick(); counts.push(calls.length); }
    ok('executed: five 90 s ticks with the socket stalling every time → fetches after each tick = 1,2,2,3,3 (the doubling backoff owns ticks 3 and 5; 1,1,1,1,1 before the fix)',
      counts.join(',') === '1,2,2,3,3', 'got ' + counts.join(','));
    ok('executed: every issued request carried a signal and every fired deadline settled it — nothing is left pending',
      calls.every((c) => !!c.signal) && calls.slice(0, -1).every((c) => c.settled), calls.map((c) => (c.signal ? (c.settled ? 'S' : 'p') : '-')).join(''));
  }
  global.fetch = realFetch; AbortSignal.timeout = realTimeout; Date.now = realNow;
  delete A.mapview;

  /* ================= B — the AST class gate ================= */
  group('B — class gate: every fetch() in js/ is A.util.fetchT() itself, carries a static `signal`, or is allowlisted with a reason that still holds');
  // Bare-fetch sites the gate accepts, 'js/file.js:LINE': 'why'. Each entry
  // must still match a real bare site (anti-rot) and its reason is re-checked
  // below. Anything else belongs in A.util.fetchT(), not here.
  const ALLOW = {
    'js/routing.js:91': 'fetchJSON(url, init): init is built as { signal: opts.signal || ctrl.signal } two lines up, with its own FETCH_TIMEOUT_MS abort timer',
    'js/weathernow.js:52': 'fetch(u, ac ? { signal: ac.signal } : undefined): a real AbortController with an 8 s abort timer, behind a ConditionalExpression the walker cannot see'
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
  ok('every js/*.js parses with acorn (' + jsFiles.length + ' files) and the scan is real: >= 20 transport call sites (fetch + A.util.fetchT) found (' + (sites.length + fetchTCalls.length) + ')',
    parseErrors.length === 0 && jsFiles.length >= 40 && sites.length + fetchTCalls.length >= 20, parseErrors.join('; ') + ' fetch=' + sites.length + ' fetchT=' + fetchTCalls.length);
  ok('exactly one fetch() lives inside a function named fetchT, and it is in js/util.js — the single place a bare transport call is allowed',
    helperSites.length === 1 && helperSites[0].file === 'js/util.js', 'helper sites: ' + wrap(helperSites));
  ok('every other fetch() goes through A.util.fetchT(), passes a static `signal`, or is allowlisted — 0 violations (' + violations.length + ' found)',
    violations.length === 0, 'route these through A.util.fetchT(url, opts, ms): ' + wrap(violations));
  ok('the allowlist has exactly the two justified entries (js/routing.js fetchJSON, js/weathernow.js) — anything more is scope creep',
    Object.keys(ALLOW).length === 2 && 'js/routing.js:91' in ALLOW && 'js/weathernow.js:52' in ALLOW);
  ok('anti-rot: every allowlist entry still names a real bare fetch site (an entry that stops matching must be removed, not kept)',
    stale.length === 0, 'stale: ' + stale.join(', '));
  ok('no fetch aliasing: every `fetch` identifier in js/ is a call\'s callee, a typeof operand or a `window.fetch` test — nothing is bound to a local and called later',
    aliases.length === 0, aliases.join('; '));
  // The two reasons, re-checked against the source each run.
  const routingSrc = fs.readFileSync(path.join(ROOT, 'js', 'routing.js'), 'utf8');
  const fjAt = routingSrc.indexOf('function fetchJSON(url, opts)');
  const fj = fjAt >= 0 ? routingSrc.slice(fjAt, routingSrc.indexOf('\n  }\n', fjAt)) : '';
  ok('js/routing.js:91 reason holds: fetchJSON builds `init = { signal: signal }` from opts.signal || its own AbortController, armed with a FETCH_TIMEOUT_MS abort timer',
    /var signal = opts\.signal \|\| \(ctrl && ctrl\.signal\);/.test(fj) && /var init = \{ signal: signal \};/.test(fj) &&
    /setTimeout\(function \(\) \{ if \(ctrl\) ctrl\.abort\(\); \}, FETCH_TIMEOUT_MS\)/.test(fj) && /return fetch\(url, init\)/.test(fj),
    'fetchJSON body: ' + fj.replace(/\s+/g, ' ').slice(0, 200));
  const weatherSrc = fs.readFileSync(path.join(ROOT, 'js', 'weathernow.js'), 'utf8');
  ok('js/weathernow.js:52 reason holds: `new AbortController()`, an 8000 ms `ac.abort()` timer, and `fetch(u, ac ? { signal: ac.signal } : undefined)`',
    /var ac = window\.AbortController \? new AbortController\(\) : null;/.test(weatherSrc) &&
    /setTimeout\(function \(\) \{ ac\.abort\(\); \}, 8000\)/.test(weatherSrc) && /fetch\(u, ac \? \{ signal: ac\.signal \} : undefined\)/.test(weatherSrc));
  // The table is bound to the sites that need it: a fetchT(OVERPASS_PROXY, …) with the
  // default 15 s deadline would pass the gate and silently bypass group C.
  const overpassCalls = fetchTCalls.filter((c) => c.url === 'OVERPASS_PROXY');
  const aircraftCalls = fetchTCalls.filter((c) => c.url === 'AIRCRAFT_PROXY');
  ok('every A.util.fetchT(OVERPASS_PROXY, …) passes FETCH_TIMEOUT.overpass as its deadline (' + overpassCalls.length + ' sites: ghost.js fetchPolice, routing.js police + road lookups)',
    overpassCalls.length === 3 && overpassCalls.every((c) => /\bFETCH_TIMEOUT\.overpass$/.test(c.ms)),
    overpassCalls.map((c) => c.key + ' ms=' + (c.ms || '(default)')).join('; ') || 'no fetchT(OVERPASS_PROXY) call found');
  ok('every A.util.fetchT(AIRCRAFT_PROXY, …) passes FETCH_TIMEOUT.aircraft (' + aircraftCalls.length + ' site: ghost.js fetchAircraft)',
    aircraftCalls.length === 1 && aircraftCalls.every((c) => /\bFETCH_TIMEOUT\.aircraft$/.test(c.ms)),
    aircraftCalls.map((c) => c.key + ' ms=' + (c.ms || '(default)')).join('; ') || 'no fetchT(AIRCRAFT_PROXY) call found');
  ok('js/telemetry.js (loads before util.js — index.html, second on purpose) keeps an inline `signal:` on its fetch instead of A.util.fetchT',
    sites.some((s) => s.file === 'js/telemetry.js' && s.hasSignal) && !fetchTCalls.some((c) => /^js\/telemetry\.js/.test(c.key)),
    'telemetry sites: ' + sites.filter((s) => s.file === 'js/telemetry.js').map((s) => s.key + (s.hasSignal ? ' signal' : ' bare')).join(', '));

  /* ================= C — the cross-file timeout floor ================= */
  group('C — the client deadline is never shorter than the server\'s own upstream budget (mirrors × TIMEOUT_MS)');
  // Why: server/overpass.js tries every mirror in turn, each bounded by
  // TIMEOUT_MS, and only then answers 502. A client that gives up before the
  // server can have answered aborts requests that were about to succeed — a
  // cold-cache enforcement lookup on a slow first mirror is the common case,
  // not the edge case. So the floor is a property of BOTH files, pinned here.
  const ovSrc = fs.readFileSync(path.join(ROOT, 'server', 'overpass.js'), 'utf8');
  const mT = ovSrc.match(/const TIMEOUT_MS = parseInt\(process\.env\.OVERPASS_TIMEOUT_MS \|\| '(\d+)', 10\);/);
  const mM = ovSrc.match(/process\.env\.OVERPASS_URLS \|\|\s*\n?\s*'([^']+)'\)/);
  const serverOverpassMs = mT ? parseInt(mT[1], 10) : NaN;
  const mirrors = mM ? mM[1].split(',').map((s) => s.trim()).filter(Boolean).length : NaN;
  const acSrc = fs.readFileSync(path.join(ROOT, 'server', 'aircraft.js'), 'utf8');
  const mA = acSrc.match(/const UPSTREAM_TIMEOUT_MS = (\d+);/);
  const serverAircraftMs = mA ? parseInt(mA[1], 10) : NaN;
  ok('server/overpass.js: TIMEOUT_MS default (' + serverOverpassMs + ' ms) and the MIRRORS default (' + mirrors + ' mirrors) parsed from the source',
    serverOverpassMs > 0 && mirrors >= 1, 'TIMEOUT_MS match=' + !!mT + ' MIRRORS match=' + !!mM);
  if (!process.env.OVERPASS_URLS) {
    const ov = require(path.join(ROOT, 'server', 'overpass.js'));
    ok('… and the mirror count matches the module\'s own MIRROR_HOSTS (' + ov.MIRROR_HOSTS.join(', ') + ')', ov.MIRROR_HOSTS.length === mirrors);
  }
  ok('server/aircraft.js: UPSTREAM_TIMEOUT_MS (' + serverAircraftMs + ' ms) parsed from the source', serverAircraftMs > 0, 'match=' + !!mA);
  const T = U.FETCH_TIMEOUT;
  const entries = T ? Object.keys(T) : [];
  ok('A.util.FETCH_TIMEOUT is exported with overpass / aircraft / api, every entry a finite number > 0',
    !!T && ['overpass', 'aircraft', 'api'].every((k) => entries.indexOf(k) >= 0) && entries.every((k) => typeof T[k] === 'number' && isFinite(T[k]) && T[k] > 0),
    'table=' + JSON.stringify(T || null));
  const floor = mirrors * serverOverpassMs;
  ok('FETCH_TIMEOUT.overpass (' + (T && T.overpass) + ') >= MIRRORS.length × server TIMEOUT_MS (' + mirrors + ' × ' + serverOverpassMs + ' = ' + floor + ') — below it the client aborts requests the server was about to answer',
    !!T && T.overpass >= floor, 'raise the client deadline or lower the server budget first');
  ok('FETCH_TIMEOUT.aircraft (' + (T && T.aircraft) + ') > server UPSTREAM_TIMEOUT_MS (' + serverAircraftMs + ')', !!T && T.aircraft > serverAircraftMs);
  ok('FETCH_TIMEOUT.api (' + (T && T.api) + ') is the smallest entry and at least 10 s — every other /api/* answers from memory or a short upstream call',
    !!T && T.api >= 10000 && T.api <= T.aircraft && T.api <= T.overpass);
  const utilSrc = fs.readFileSync(path.join(ROOT, 'js', 'util.js'), 'utf8');
  const tblAt = utilSrc.indexOf('var FETCH_TIMEOUT = {');
  const tblContext = tblAt >= 0 ? utilSrc.slice(Math.max(0, tblAt - 1500), tblAt + 400) : '';
  ok('the reasoning lives at the constant, not only in this test: the comment around `var FETCH_TIMEOUT` in js/util.js names server/overpass.js, its mirrors and TIMEOUT_MS',
    tblAt >= 0 && /server\/overpass\.js/.test(tblContext) && /MIRRORS/.test(tblContext) && /TIMEOUT_MS/.test(tblContext), 'found at ' + tblAt);

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
