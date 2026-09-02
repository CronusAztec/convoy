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

(function main() {

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

    Promise.all([
      overpass.query('nope', LA),
      overpass.query('police', { minLat: 'x' }),
      overpass.query('police', undefined),
      overpass.query('road', { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 })
    ]).then((rs) => {
      global.fetch = realFetch;
      H.ok('an unknown kind is reported', rs[0].error === 'unknown-kind', JSON.stringify(rs[0]));
      H.ok('a string corner is reported as a bad bbox', rs[1].error === 'bad-bbox', JSON.stringify(rs[1]));
      H.ok('a missing bbox is reported', rs[2].error === 'bad-bbox', JSON.stringify(rs[2]));
      H.ok('an oversized bbox is reported', rs[3].error === 'bad-bbox', JSON.stringify(rs[3]));
      H.ok('and Overpass was never contacted for any of them', calls === 0, 'calls=' + calls);
      process.exit(H.report());
    });
  }
})();
