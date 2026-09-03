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
const path = require('path');
const H = require('./harness');

const overpass = require(path.join(__dirname, '..', 'server', 'overpass.js'));

const LA = { minLat: 34.03, minLng: -118.30, maxLat: 34.09, maxLng: -118.20 };
function box(over) { return Object.assign({}, LA, over || {}); }

(async function main() {

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
  {
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
