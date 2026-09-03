/* Convoy — server/overpass.js: the OpenStreetMap proxy's guard rails.

   This module exists because overpass-api.de serves no CORS header, so the
   browser cannot call it at all. Moving the call server-side fixes that, but it
   puts OUR IP in front of a shared community resource, and the failure modes
   are the quiet kind:

     - AN OPEN PROXY would be the real damage. Overpass QL is a language with a
       server-side cost model; forwarding a caller's query would let anyone spend
       our budget on whatever they liked until the instance banned us — for every
       rider at once. The caller picks a KIND, never a query.
     - THE SPAN LIMIT MUST NOT BE TIGHTER THAN THE CALLERS. ghost.js clamps its
       view to exactly 4°, and `centre ± 2` lands on 4.000000000000001 in binary
       often enough to matter. A bare `> 4` rejects the layer's normal wide view,
       and because every call site ends in `.catch(() => null)` the layer just
       goes dark with nothing in the log.
     - A GARBAGE BBOX reaching Overpass is a slow query we get charged for.

   Run:  node test/overpass.test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./harness');

const overpass = require(path.join(__dirname, '..', 'server', 'overpass.js'));

const LA = { minLat: 34.03, minLng: -118.30, maxLat: 34.09, maxLng: -118.20 };
function box(over) { return Object.assign({}, LA, over || {}); }

(async function main() {
  reset();   // the cooldown table outlives every group (server-034); start clean

  H.group('Only the app\'s own three lookups can be run');
  {
    // These are the three the client actually uses. A kind that is not one of
    // them must not reach Overpass at all.
    ['police', 'enforcement', 'road'].forEach((k) => {
      H.ok(k + ' is a known lookup', overpass.hasKind(k) === true);
    });
    ['', 'nodes', 'POLICE', 'constructor', '__proto__', 'toString'].forEach((k) => {
      H.ok(JSON.stringify(k) + ' is not', overpass.hasKind(k) === false);
    });
  }
  {
    // The queries are built here, from a bbox and nothing else. Whatever the
    // caller sends beyond that cannot become part of one.
    const ql = overpass.KINDS.police('34.0,-118.3,34.1,-118.2');
    H.ok('the query is Overpass QL built server-side', ql.indexOf('[out:json]') === 0, ql.slice(0, 40));
    H.ok('it carries the bbox', ql.indexOf('34.0,-118.3,34.1,-118.2') > 0);
    H.ok('and caps what it returns', /out center \d+;$/.test(ql), ql.slice(-20));
  }
  {
    // Each kind asks for what its own layer draws — the ALPR/surveillance tags
    // belong to Ghost Mode, the stop/signal tags to the road-feature lookup.
    H.ok('enforcement includes surveillance (ALPR)',
      overpass.KINDS.enforcement('B').indexOf('man_made"="surveillance') > 0);
    H.ok('road includes stops and signals',
      overpass.KINDS.road('B').indexOf('highway"="stop') > 0 &&
      overpass.KINDS.road('B').indexOf('highway"="traffic_signals') > 0);
    H.ok('police avoidance stays narrow — no stops or signals',
      overpass.KINDS.police('B').indexOf('highway"="stop') < 0);
  }

  H.group('A bbox is checked before it costs an upstream query');
  {
    H.ok('a normal city view passes', !!overpass.parseBbox(LA));
    H.ok('missing entirely is refused', overpass.parseBbox(undefined) === null);
    H.ok('not an object is refused', overpass.parseBbox('34,-118,35,-117') === null);
    H.ok('a missing corner is refused', overpass.parseBbox({ minLat: 34, minLng: -118, maxLat: 35 }) === null);
    // Strings are the interesting one: '34' would coerce fine in arithmetic and
    // build a query that looks valid.
    H.ok('numeric STRINGS are refused, not coerced',
      overpass.parseBbox(box({ minLat: '34.03' })) === null);
    H.ok('NaN is refused', overpass.parseBbox(box({ minLat: NaN })) === null);
    H.ok('Infinity is refused', overpass.parseBbox(box({ maxLng: Infinity })) === null);
    H.ok('null is refused', overpass.parseBbox(box({ minLng: null })) === null);
  }
  {
    H.ok('out-of-range latitude is refused', overpass.parseBbox(box({ maxLat: 91 })) === null);
    H.ok('out-of-range longitude is refused', overpass.parseBbox(box({ minLng: -181 })) === null);
    H.ok('an inverted box is refused', overpass.parseBbox({ minLat: 40, minLng: 10, maxLat: 30, maxLng: 20 }) === null);
    H.ok('a zero-area box is refused', overpass.parseBbox({ minLat: 34, minLng: -118, maxLat: 34, maxLng: -118 }) === null);
    H.ok('the whole world is refused', overpass.parseBbox({ minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 }) === null);
  }

  H.group('The span limit is not tighter than what the callers clamp to');
  {
    const M = overpass.MAX_SPAN_DEG;
    // ghost.js clamps to exactly MAX_BBOX_DEG. If this limit sits below that,
    // its normal wide view 400s and the police layer silently shows nothing.
    H.ok('the ceiling is at least ghost.js\'s 4° clamp', M >= 4, String(M));

    const exact = { minLat: 10, minLng: 10, maxLat: 10 + M, maxLng: 10 + M };
    H.ok('a box of exactly the limit is accepted', !!overpass.parseBbox(exact));

    // The real shape ghost.js produces: centre ± half the limit. In binary this
    // is routinely a hair OVER the limit, which is what broke it in the browser.
    const centre = 19.599999999999998;
    const drift = { minLat: centre - M / 2, minLng: -2, maxLat: centre + M / 2, maxLng: 2 };
    H.ok('and so is one a floating-point hair over it',
      !!overpass.parseBbox(drift),
      'span=' + (drift.maxLat - drift.minLat).toString());

    // The tolerance is a rounding error, not a loophole.
    H.ok('a box meaningfully over the limit is still refused',
      overpass.parseBbox({ minLat: 10, minLng: 10, maxLat: 10 + M + 0.01, maxLng: 11 }) === null);
  }

  H.group('Bad input is refused without reaching Overpass');
  {
    // query() must resolve, never throw, and never call out for input it has
    // already judged unusable.
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = () => { calls++; return Promise.reject(new Error('should not be called')); };
    let rs;
    try {
      rs = await Promise.all([
        overpass.query('nope', LA),
        overpass.query('police', { minLat: 'x' }),
        overpass.query('police', undefined),
        overpass.query('road', { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 })
      ]);
    } finally { global.fetch = realFetch; }
    H.ok('an unknown kind is reported', rs[0].error === 'unknown-kind', JSON.stringify(rs[0]));
    H.ok('a string corner is reported as a bad bbox', rs[1].error === 'bad-bbox', JSON.stringify(rs[1]));
    H.ok('a missing bbox is reported', rs[2].error === 'bad-bbox', JSON.stringify(rs[2]));
    H.ok('an oversized bbox is reported', rs[3].error === 'bad-bbox', JSON.stringify(rs[3]));
    H.ok('and Overpass was never contacted for any of them', calls === 0, 'calls=' + calls);
  }

  H.group('A failed mirror says which one and why');
  await failedMirrorGroup();

  H.group('A mirror that just failed goes to the back of the try order (server-034)');
  await cooldownGroup();

  process.exit(H.report());
})();

/* ---------------- a scripted upstream ----------------
   Cycle 51 (2026-09-03) read seven `all mirrors failed` lines out of production
   and could not say why a single one failed: every branch in the mirror loop
   `continue`d past its own reason. These checks pin the line that replaces it.

   The mirror list is read from the environment at require time, so it is not
   changed here; instead `fetch` is replaced with a script consumed in call
   order — the module tries MIRRORS[0] first, then MIRRORS[1]. Outcomes are
   real `Response` objects (so jsonCapped reads a real stream, the path
   production takes) or functions that throw. Every case uses its own bbox:
   a success caches for 30 min and identical concurrent queries share one
   promise, so a reused box would silently read the previous case's answer. */
function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}
function textRes(text, status) { return new Response(text, { status: status || 200 }); }
function timeoutErr() { return new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
function netErr() { return Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }); }
// Distinct, valid, small boxes: keyFor() rounds to 0.01°, so 1° apart is safe.
function at(k) { return { minLat: 40 + k, minLng: 10, maxLat: 40.06 + k, maxLng: 10.1 }; }

// Run one query against a scripted upstream, capturing what the module logged
// and which hosts it asked, then restore fetch and console whatever happened.
async function drive(kind, bbox, script) {
  const realFetch = global.fetch, realErr = console.error, realWarn = console.warn;
  const errors = [], warns = [], hosts = [];
  let n = 0;
  global.fetch = (url) => {
    hosts.push(new URL(url).host);
    const step = script[n++];
    if (typeof step === 'function') return Promise.resolve().then(step);   // a throw becomes a rejection
    return Promise.resolve(step);
  };
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = await overpass.query(kind, bbox);
    return { r: r, errors: errors, warns: warns, hosts: hosts };
  } finally {
    global.fetch = realFetch; console.error = realErr; console.warn = realWarn;
  }
}
const n0 = (o, k) => (o && o[k]) || 0;

async function failedMirrorGroup() {
  reset();
  {
    reset();   // every block starts with nothing cooling — the scripts assume declaration order (server-034)
    // Total failure: the first mirror is out of slots, the second hangs to the
    // deadline. The one line must carry both facts.
    const before = overpass.stats();
    const d = await drive('enforcement', at(0), [textRes('rate limited', 429), () => { throw timeoutErr(); }]);
    const line = d.errors.join('\n');
    H.ok('the client still gets the same {error:"upstream"} it always did', d.r.error === 'upstream', JSON.stringify(d.r));
    H.ok('exactly one error line for the whole query, not one per mirror', d.errors.length === 1, String(d.errors.length));
    H.ok('every mirror was tried', d.hosts.length === before.mirrors, 'asked ' + d.hosts.join(', '));
    H.ok('the line names each mirror that failed', d.hosts.every((h) => line.indexOf(h) >= 0), line);
    H.ok('an HTTP status survives as http:429', line.indexOf(d.hosts[0] + ' http:429 ') >= 0, line);
    H.ok('a timeout survives as "timeout"', line.indexOf(d.hosts[1] + ' timeout ') >= 0, line);
    H.ok('each attempt carries its elapsed ms', (line.match(/ \d+ms\b/g) || []).length === d.hosts.length, line);
    H.ok('the line carries the session tallies', /\(session ok=\d+ fail=\d+\)/.test(line), line);
    const after = overpass.stats();
    H.ok('stats().fail went up by exactly one — per query, not per attempt', after.fail === before.fail + 1,
      before.fail + ' -> ' + after.fail);
    H.ok('stats().ok did not move', after.ok === before.ok);
    H.ok('stats().byReason counted http:429 and timeout once each',
      n0(after.byReason, 'http:429') === n0(before.byReason, 'http:429') + 1 &&
      n0(after.byReason, 'timeout') === n0(before.byReason, 'timeout') + 1, JSON.stringify(after.byReason));
    H.ok('stats().byMirror charged one failure to each host',
      d.hosts.every((h) => n0((after.byMirror || {})[h], 'fail') === n0((before.byMirror || {})[h], 'fail') + 1), JSON.stringify(after.byMirror));
  }
  {
    reset();
    // Partial failure: the first mirror is unreachable, the second answers.
    // Today this is completely silent — a mirror down 100% of the time is
    // invisible while the other one covers for it.
    const before = overpass.stats();
    const d = await drive('enforcement', at(1), [
      () => { throw netErr(); },
      jsonRes({ elements: [{ type: 'node', id: 1, lat: 41.02, lon: 10.05, tags: { amenity: 'police' } }] })
    ]);
    H.ok('the body still comes back', !!(d.r.body && Array.isArray(d.r.body.elements) && d.r.body.elements.length === 1), JSON.stringify(d.r));
    H.ok('and is marked as a fresh (uncached) answer', d.r.cached === false);
    H.ok('no error line — the query succeeded', d.errors.length === 0, d.errors.join('\n'));
    H.ok('one warn line names the mirror that failed and why (net:TypeError)',
      d.warns.length === 1 && d.warns[0].indexOf(d.hosts[0] + ' net:TypeError ') >= 0, d.warns.join('\n'));
    H.ok('and which mirror served the answer', d.warns.length === 1 && d.warns[0].indexOf('served by ' + d.hosts[1]) >= 0, d.warns.join('\n'));
    const after = overpass.stats();
    H.ok('stats().ok went up by one and fail did not', after.ok === before.ok + 1 && after.fail === before.fail,
      'ok ' + before.ok + '->' + after.ok + ', fail ' + before.fail + '->' + after.fail);
    H.ok('the serving mirror is credited and the failing one charged',
      n0(after.byMirror[d.hosts[1]], 'ok') === n0(before.byMirror[d.hosts[1]], 'ok') + 1 &&
      n0(after.byMirror[d.hosts[0]], 'fail') === n0(before.byMirror[d.hosts[0]], 'fail') + 1, JSON.stringify(after.byMirror));
  }
  {
    reset();
    // The normal day: first mirror answers. Nothing is logged, and the same
    // box a second time is a cache hit that costs no fetch and is counted as one.
    const before = overpass.stats();
    const d1 = await drive('police', at(2), [jsonRes({ elements: [] })]);
    H.ok('a first-mirror success logs nothing at all', d1.errors.length === 0 && d1.warns.length === 0 && d1.r.cached === false,
      d1.errors.concat(d1.warns).join('\n'));
    const d2 = await drive('police', at(2), [jsonRes({ elements: [] })]);
    const after = overpass.stats();
    H.ok('the same box again is a cache hit and costs no fetch', d2.r.cached === true && d2.hosts.length === 0, JSON.stringify(d2.r));
    H.ok('stats() counts the hit under cached, not ok', after.cached === before.cached + 1 && after.ok === before.ok + 1,
      'cached ' + before.cached + '->' + after.cached + ', ok ' + before.ok + '->' + after.ok);
  }
  {
    reset();
    // A 200 that is not the answer: an HTML busy page, then JSON without elements[].
    const d = await drive('road', at(3), [textRes('<html><body>Gateway busy</body></html>', 200), jsonRes({ remark: 'runtime error: query timed out' })]);
    const line = d.errors[0] || '';
    H.ok('a non-JSON 200 is reported as a body failure', line.indexOf(d.hosts[0] + ' body:') >= 0, line);
    H.ok('a JSON answer without elements[] is reported as "shape"', line.indexOf(d.hosts[1] + ' shape ') >= 0, line);
    H.ok('the body detail stays on one line and is capped', line.indexOf('\n') < 0 && line.length < 400, 'length ' + line.length);
    H.ok('byReason files body failures under one key, not one key per message', n0(overpass.stats().byReason, 'body') >= 1,
      JSON.stringify(overpass.stats().byReason));
  }
  {
    reset();
    // The shape any future caller (admin page, health line) can rely on, and
    // that reading it cannot corrupt it.
    const s = overpass.stats();
    H.ok('stats() still has entries and mirrors', typeof s.entries === 'number' && typeof s.mirrors === 'number', JSON.stringify(s));
    H.ok('and ok / fail / cached / byMirror / byReason',
      ['ok', 'fail', 'cached'].every((k) => typeof s[k] === 'number') && !!s.byMirror && !!s.byReason, JSON.stringify(s));
    const host = Object.keys(s.byMirror)[0];
    s.byReason.timeout = 999; if (host) s.byMirror[host].fail = 999;
    const s2 = overpass.stats();
    H.ok('a caller mutating what stats() returned does not touch the live counters',
      s2.byReason.timeout !== 999 && (!host || s2.byMirror[host].fail !== 999), JSON.stringify(s2));
  }
}

/* ---------------- a mirror that just failed goes to the back ----------------
   The cycle-55 improve stage drove three consecutive queries with mirror 0
   timing out on all three: mirror 0 was asked FIRST all three times, at
   TIMEOUT_MS (30 s) a go, because the loop had no memory (server-034). These
   checks pin the demotion: a mirror that failed sorts to the back of the try
   order for COOL_MS, every mirror is still attempted on every query (demote,
   never skip — with two mirrors a real breaker would take the layer down
   whenever both were cooling), a success clears it, and with nothing cooling
   the order is byte-for-byte the declaration order the rest of this file
   assumes.

   The module keeps its cooldown table for the life of the process and every
   group in this file shares one module instance, so a failure scripted in
   one block would reorder the mirrors in the next. _coolReset() exists for
   exactly that; every block calls it first. */
function reset(state) { if (typeof overpass._coolReset === 'function') overpass._coolReset(state); }

async function cooldownGroup() {
  reset();
  let HOSTS = overpass.MIRROR_HOSTS;
  if (!Array.isArray(HOSTS)) {
    // No export yet: the first query with nothing cooling shows the declaration order.
    HOSTS = (await drive('police', at(9), [() => { throw netErr(); }, () => { throw netErr(); }])).hosts;
  }
  const H0 = HOSTS[0], H1 = HOSTS[1];
  H.ok('the module exports MIRROR_HOSTS (two by default), mirrorOrder(now), COOL_MS and the _coolReset() test seam',
    Array.isArray(overpass.MIRROR_HOSTS) && overpass.MIRROR_HOSTS.length === 2 && typeof overpass.mirrorOrder === 'function' &&
    typeof overpass.COOL_MS === 'number' && typeof overpass._coolReset === 'function',
    'exports = ' + Object.keys(overpass).join(', '));
  {
    // 1. RED before the fix: mirror 0 times out, mirror 1 serves → the NEXT query asks mirror 1 first.
    reset();
    const d1 = await drive('enforcement', at(10), [() => { throw timeoutErr(); }, jsonRes({ elements: [] })]);
    const d2 = await drive('enforcement', at(11), [jsonRes({ elements: [] })]);
    H.ok('a query whose first mirror timed out was served by the second (' + d1.hosts.join(' → ') + ')',
      d1.hosts.length === 2 && d1.hosts[0] === H0 && d1.hosts[1] === H1 && !!d1.r.body, JSON.stringify(d1.r));
    H.ok('executed: the NEXT query asks the mirror that just served, not the one that just timed out (asked ' + d2.hosts.join(' → ') + ')',
      d2.hosts[0] === H1 && !!d2.r.body, 'asked ' + d2.hosts.join(' → ') + ' — expected ' + H1 + ' first');
    H.ok('and it is served first time, so no warn line and no second attempt', d2.warns.length === 0 && d2.hosts.length === 1,
      d2.warns.join('\n') || ('asked ' + d2.hosts.length));
  }
  {
    // 2. demote, never skip: with both mirrors cooling, both are still attempted.
    reset();
    const d1 = await drive('police', at(12), [() => { throw netErr(); }, () => { throw netErr(); }]);
    const d2 = await drive('police', at(13), [() => { throw netErr(); }, () => { throw netErr(); }]);
    H.ok('executed: with every mirror cooling, every mirror is still attempted — demote, never skip (asked ' + d2.hosts.join(' → ') + ')',
      d1.hosts.length === 2 && d2.hosts.length === overpass.stats().mirrors, 'asked ' + d2.hosts.join(' → '));
    H.ok('executed: the worst case is exactly today\'s worst case — {error:"upstream"} and one line naming both mirrors',
      d2.r.error === 'upstream' && d2.errors.length === 1 && d2.hosts.every((h) => d2.errors[0].indexOf(h) >= 0), d2.errors.join('\n'));
    H.ok('stats().cooling lists both hosts, in declaration order',
      JSON.stringify(overpass.stats().cooling) === JSON.stringify(HOSTS), JSON.stringify(overpass.stats().cooling));
  }
  {
    // 3. the demoted mirror is still tried when the promoted one fails; 4. a success clears the cooldown.
    reset();
    const d1 = await drive('road', at(14), [() => { throw timeoutErr(); }, jsonRes({ elements: [] })]);
    H.ok('setup: mirror 0 timed out and is the only one cooling', d1.hosts[0] === H0 && JSON.stringify(overpass.stats().cooling) === JSON.stringify([H0]),
      'cooling=' + JSON.stringify(overpass.stats().cooling));
    const d2 = await drive('road', at(15), [() => { throw netErr(); }, jsonRes({ elements: [] })]);
    H.ok('executed: the promoted mirror is asked first and fails; the demoted one is still tried, and serves (asked ' + d2.hosts.join(' → ') + ')',
      d2.hosts.length === 2 && d2.hosts[0] === H1 && d2.hosts[1] === H0 && !!d2.r.body && d2.r.cached === false,
      JSON.stringify(d2.r) + ' asked ' + d2.hosts.join(' → '));
    H.ok('executed: that success CLEARED mirror 0\'s cooldown and the failure charged mirror 1\'s — stats().cooling is exactly [' + H1 + ']',
      JSON.stringify(overpass.stats().cooling) === JSON.stringify([H1]), JSON.stringify(overpass.stats().cooling));
    H.ok('the warn line still names the mirror that failed and the one that served',
      d2.warns.length === 1 && d2.warns[0].indexOf(H1 + ' net:TypeError') >= 0 && d2.warns[0].indexOf('served by ' + H0) >= 0, d2.warns.join('\n'));
    const d3 = await drive('road', at(16), [jsonRes({ elements: [] })]);
    H.ok('executed: the following query is back to declaration order — mirror 0 first (asked ' + d3.hosts.join(' → ') + ')',
      d3.hosts[0] === H0 && d3.hosts.length === 1, 'asked ' + d3.hosts.join(' → '));
  }
  if (typeof overpass.mirrorOrder === 'function' && typeof overpass._coolReset === 'function') {
    // Pure: mirrorOrder(now) over a state installed through the seam. No wall clock.
    const now = 1000000;
    const order = (st, t) => { reset(st); return JSON.stringify(overpass.mirrorOrder(t === undefined ? now : t)); };
    H.ok('pure: nothing cooling → [0,1] — today\'s declaration order, byte for byte', order({}) === '[0,1]', order({}));
    H.ok('pure: host 0 cooling until now+1 → [1,0]', order({ [H0]: now + 1 }) === '[1,0]', order({ [H0]: now + 1 }));
    H.ok('pure: the same state evaluated at now+2 → [0,1] — expiry is deterministic', order({ [H0]: now + 1 }, now + 2) === '[0,1]', order({ [H0]: now + 1 }, now + 2));
    H.ok('pure: a cooldown that ends exactly at `now` is over (strictly greater, not >=)', order({ [H0]: now }) === '[0,1]', order({ [H0]: now }));
    H.ok('pure: equal cooldowns tie-break on declaration order → [0,1]', order({ [H0]: now + 5, [H1]: now + 5 }) === '[0,1]', order({ [H0]: now + 5, [H1]: now + 5 }));
    H.ok('pure: both cooling, unequal → the one that expires sooner goes first → [1,0]', order({ [H0]: now + 9, [H1]: now + 5 }) === '[1,0]', order({ [H0]: now + 9, [H1]: now + 5 }));
    const states = [{}, { [H0]: now + 1 }, { [H1]: now + 1 }, { [H0]: now + 1, [H1]: now + 1 }, { [H0]: now - 1, [H1]: now + 1 }, { [H0]: now + 3, [H1]: now + 2 }];
    const ident = JSON.stringify(HOSTS.map((_, i) => i));
    H.ok('pure: never drops or duplicates an index across ' + states.length + ' states',
      states.every((st) => { reset(st); const o = overpass.mirrorOrder(now); return o.length === HOSTS.length && JSON.stringify(o.slice().sort()) === ident; }));
    reset();
  } else {
    H.ok('pure: mirrorOrder(now) is exported and testable without a wall clock', false, 'mirrorOrder / _coolReset missing');
  }
  {
    // Surface: stats().cooling is a fresh copy and lists only what is cooling now.
    const now = Date.now();
    reset({ [H1]: now + 60000 });
    const s = overpass.stats();
    H.ok('stats().cooling lists exactly the cooling hosts', JSON.stringify(s.cooling) === JSON.stringify([H1]), JSON.stringify(s.cooling));
    if (Array.isArray(s.cooling)) s.cooling.push('mutated');
    H.ok('a caller mutating what stats() returned does not touch the live table',
      JSON.stringify(overpass.stats().cooling) === JSON.stringify([H1]), JSON.stringify(overpass.stats().cooling));
    reset({ [H0]: now - 1 });
    H.ok('an expired cooldown is not listed', Array.isArray(overpass.stats().cooling) && overpass.stats().cooling.length === 0, JSON.stringify(overpass.stats().cooling));
    reset();
  }
  {
    H.ok('COOL_MS defaults to 120000 — long enough to spare a burst of rider queries a dead mirror, short enough to notice it coming back',
      overpass.COOL_MS === 120000, String(overpass.COOL_MS));
    const modPath = path.join(__dirname, '..', 'server', 'overpass.js');
    const r = spawnSync(process.execPath, ['-e', 'console.log(require(' + JSON.stringify(modPath) + ').COOL_MS)'],
      { env: Object.assign({}, process.env, { OVERPASS_COOL_MS: '5000' }), encoding: 'utf8' });
    H.ok('and is overridable through OVERPASS_COOL_MS (a fresh process with OVERPASS_COOL_MS=5000 reports 5000)',
      r.status === 0 && r.stdout.trim() === '5000', (r.stdout + r.stderr).trim());
    const env = fs.readFileSync(path.join(__dirname, '..', 'server', '.env.example'), 'utf8');
    H.ok('OVERPASS_COOL_MS is documented in server/.env.example right after OVERPASS_TIMEOUT_MS',
      /# OVERPASS_TIMEOUT_MS=30000\n[\s\S]{0,700}# OVERPASS_COOL_MS=120000/.test(env));
  }
  {
    // Source pins: one edit inside failed() charges the cooldown for every reason; success clears it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'overpass.js'), 'utf8');
    const fAt = src.indexOf('const failed = (i, reason, detail, t0) => {');
    const fEnd = fAt >= 0 ? src.indexOf('\n    };', fAt) : -1;
    const failedBody = (fAt >= 0 && fEnd > fAt) ? src.slice(fAt, fEnd) : '';
    H.ok('source: the cooldown is set inside failed(), so every failure reason charges it with one edit',
      /coolUntil\[MIRROR_HOSTS\[i\]\] = Date\.now\(\) \+ COOL_MS;/.test(failedBody), failedBody.replace(/\s+/g, ' ').slice(0, 160));
    const loopAt = src.indexOf('for (const i of mirrorOrder(Date.now())) {');
    const loopEnd = loopAt >= 0 ? src.indexOf('return { body: body, cached: false };', loopAt) : -1;
    const loopSrc = (loopAt >= 0 && loopEnd > loopAt) ? src.slice(loopAt, loopEnd) : '';
    const failCalls = (loopSrc.match(/failed\(i, /g) || []).length;
    const failThenContinue = (loopSrc.match(/failed\(i, [^\n]*\n?\s*continue;/g) || []).length;
    const reasons = ["'timeout'", "'net:'", "'http:'", "'body'", "'shape'"].filter((r) => loopSrc.indexOf(r) >= 0);
    H.ok('source: the loop iterates mirrorOrder(Date.now()), every failed( call is followed by continue (' + failCalls + '/' + failThenContinue + '), and all five reasons are still there (' + reasons.length + ')',
      loopAt > 0 && failCalls === 4 && failThenContinue === 4 && reasons.length === 5, 'loop@' + loopAt + ' calls=' + failCalls + ' continue=' + failThenContinue + ' reasons=' + reasons.join(','));
    H.ok('source: a success clears the cooldown right where the mirror is credited',
      /mirrorTally\(MIRROR_HOSTS\[i\]\)\.ok\+\+;\n\s*delete coolUntil\[MIRROR_HOSTS\[i\]\];/.test(src));
    H.ok('source: the loop that had no memory — `for (let i = 0; i < MIRRORS.length; i++)` — is gone', src.indexOf('for (let i = 0; i < MIRRORS.length; i++)') < 0);
  }
  {
    // Regression pin: with nothing cooling, the all-mirrors-failed line names mirrors in attempt (= declaration) order.
    reset();
    const d = await drive('enforcement', at(17), [() => { throw netErr(); }, textRes('busy', 504)]);
    const line = d.errors[0] || '';
    H.ok('regression: with nothing cooling the `all mirrors failed` line names the mirrors in declaration order (' + d.hosts.join(' → ') + ')',
      d.hosts.length === 2 && d.hosts[0] === H0 && d.hosts[1] === H1 && line.indexOf(H0 + ' net:TypeError') >= 0 &&
      line.indexOf(H1 + ' http:504') > line.indexOf(H0 + ' net:TypeError'), line);
    reset();
  }
}
