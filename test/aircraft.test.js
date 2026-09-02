/* Convoy — live aircraft proxy tests (server/aircraft.js).

   The aircraft layer was dead in every deployment for two independent reasons,
   and this suite exists so it cannot quietly die the same way twice:

     - OpenSky refuses cross-origin browser reads (it answers with
       Access-Control-Allow-Origin: https://opensky-network.org), so the fetch
       HAS to happen server-side. These tests drive the server module.
     - ADS-B Exchange's keyless mirror now 403s everyone, taking its
       authoritative `dbFlags` military bit with it. Ownership is therefore a
       callsign heuristic, and the interesting property is not "does it label
       things" but "does it refuse to label things it cannot identify".

   Properties pinned here:

     P1  a contact the classifier cannot place is `unknown`, never `civilian`
     P2  tactical callsigns (LOST25, BULET47) do not read as registrations
     P3  a bbox is validated before it reaches upstream
     P4  nearby riders share one cached upstream fetch
     P5  a rate-limit stops upstream calls instead of hammering them
     P6  an upstream failure serves the last good sky rather than blanking it

   Run:  node test/aircraft.test.js
*/
'use strict';
const H = require('./harness');
const { group, ok } = H;
const ac = require('../server/aircraft');

/* A recording fetch stub standing in for OpenSky. */
function stubOpenSky(script) {
  const calls = [];
  global.fetch = function (url) {
    calls.push(String(url));
    const next = script.shift();
    if (!next) return Promise.reject(new Error('no scripted response'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: () => Promise.resolve(next.body || {}),
      headers: { get: () => null }
    });
  };
  return calls;
}
const state = (icao, cs, lat, lon, extra) => {
  const row = new Array(17).fill(null);
  row[0] = icao; row[1] = cs; row[2] = 'United States';
  row[4] = 1700000000; row[5] = lon; row[6] = lat;
  row[7] = 1000; row[8] = false; row[9] = 100; row[10] = 90; row[11] = 0;
  row[14] = '1200';
  return Object.assign(row, extra || {});
};

async function main() {
  /* ================================================================ P1, P2 */
  group('ownership — it says unknown when it does not know');
  {
    ok('no callsign is unknown', ac.classify('') === 'unknown');
    ok('whitespace-only is unknown', ac.classify('   ') === 'unknown');
    ok('null is unknown', ac.classify(null) === 'unknown');

    ok('an airline flight is civilian', ac.classify('SWA1426') === 'civilian');
    ok('a 2-letter IATA flight is civilian', ac.classify('BC743') === 'civilian');
    ok('a flight with a letter suffix is civilian', ac.classify('DAL45J') === 'civilian');
    ok('a US N-number is civilian', ac.classify('N963PM') === 'civilian');
    ok('a foreign tail is civilian', ac.classify('XBMQK') === 'civilian');

    ok('a Reach airlift callsign is military', ac.classify('RCH471') === 'military');
    ok('a Navy callsign is military', ac.classify('CNV4961') === 'military');
    ok('an RAF transport callsign is military', ac.classify('ASCOT4521') === 'military');

    ok('a police callsign is police', ac.classify('SHERIFF12') === 'police');
    ok('a border patrol callsign is police', ac.classify('CBP210') === 'police');
    ok('an air ambulance callsign is ems', ac.classify('LIFEFLIGHT2') === 'ems');
    ok('a coastguard callsign is ems', ac.classify('COASTGUARD6031') === 'ems');

    // The regression that made this rewrite necessary: these are tactical
    // military callsigns observed live, and a looser registration pattern
    // swallowed every one of them as civilian traffic.
    ['LOST25', 'BULET47', 'SCRCH52', 'RDSTRM16', 'VRTX19', 'INTEL24', 'SHWK769', 'BATT43']
      .forEach(function (cs) {
        ok('tactical callsign ' + cs + ' is NOT called civilian', ac.classify(cs) !== 'civilian',
          'got ' + ac.classify(cs));
      });
    ok('classification is case-insensitive', ac.classify('rch471') === 'military');
    ok('every answer is one of the five buckets',
      ['', 'SWA1', 'RCH1', 'LOST25', 'N1'].every((c) => ac.OWNERS.indexOf(ac.classify(c)) >= 0));
  }

  /* ===================================================================== P3 */
  group('bounding boxes are validated before anything is fetched');
  {
    ok('a good bbox passes', !!ac.validBbox({ minLat: 33, minLng: -119, maxLat: 34, maxLng: -118 }));
    ok('missing input is refused', ac.validBbox(null) === null);
    ok('non-numeric is refused', ac.validBbox({ minLat: 'a', minLng: 0, maxLat: 1, maxLng: 1 }) === null);
    ok('inverted latitude is refused', ac.validBbox({ minLat: 34, minLng: -119, maxLat: 33, maxLng: -118 }) === null);
    ok('out-of-range latitude is refused', ac.validBbox({ minLat: -95, minLng: 0, maxLat: 10, maxLng: 1 }) === null);
    ok('a planet-sized box is refused', ac.validBbox({ minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 }) === null);
    ok('a zero-area box is refused', ac.validBbox({ minLat: 33, minLng: -118, maxLat: 33, maxLng: -118 }) === null);

    const r = await ac.states({ minLat: 99, minLng: 0, maxLat: 100, maxLng: 1 });
    ok('states() reports a bad bbox rather than calling upstream', r.error === 'bad-bbox');
  }

  group('a state row becomes a normalized contact');
  {
    const a = ac.rowToAircraft(state('A22233', 'RCH471 ', 33.8, -118.1));
    ok('hex is lowercased', a.hex === 'a22233');
    ok('callsign is trimmed', a.callsign === 'RCH471');
    ok('coordinates are read from the right columns', a.lat === 33.8 && a.lon === -118.1);
    ok('the owner is stamped on the row', a.owner === 'military');
    ok('the fix time comes from last_contact, not now', a.at === 1700000000 * 1000);
    ok('a row with no position is dropped', ac.rowToAircraft(state('x', 'y', null, null)) === null);
  }

  /* ===================================================================== P4 */
  group('nearby riders share one upstream fetch');
  {
    ac._reset();
    const calls = stubOpenSky([{ status: 200, body: { states: [state('a1', 'SWA1', 33.9, -118.2)] } }]);
    const bbox = { minLat: 33.8, minLng: -118.3, maxLat: 33.95, maxLng: -118.1 };
    const first = await ac.states(bbox);
    ok('the first call reaches upstream', calls.length === 1 && first.cached === false);
    ok('it returns the contact', first.rows.length === 1);

    // A rider a few streets away — different bbox, same snapped cell.
    const second = await ac.states({ minLat: 33.82, minLng: -118.28, maxLat: 33.93, maxLng: -118.15 });
    ok('a nearby rider is served from cache', second.cached === true);
    ok('and no second upstream call was made', calls.length === 1);
    ok('two different bboxes snap to one cell',
      ac.cellKey(ac.cellFor(bbox)) === ac.cellKey(ac.cellFor({ minLat: 33.82, minLng: -118.28, maxLat: 33.93, maxLng: -118.15 })));
  }

  group('the cache is clipped back to what was actually asked for');
  {
    ac._reset();
    stubOpenSky([{
      status: 200,
      body: {
        states: [
          state('in1', 'SWA1', 33.85, -118.20),   // inside the request
          state('out1', 'SWA2', 33.10, -118.20)   // inside the snapped cell, outside the request
        ]
      }
    }]);
    const r = await ac.states({ minLat: 33.8, minLng: -118.3, maxLat: 33.9, maxLng: -118.1 });
    ok('only contacts inside the requested box come back', r.rows.length === 1);
    ok('and it is the right one', r.rows[0].hex === 'in1');
  }

  /* ===================================================================== P5 */
  group('a rate limit stops upstream calls instead of hammering them');
  {
    ac._reset();
    const calls = stubOpenSky([{ status: 429 }, { status: 200, body: { states: [] } }]);
    const first = await ac.states({ minLat: 40, minLng: -75, maxLat: 41, maxLng: -74 });
    ok('a 429 is reported as rate-limited', first.error === 'rate-limited');
    ok('upstream was called once', calls.length === 1);

    const second = await ac.states({ minLat: 50, minLng: -5, maxLat: 51, maxLng: -4 });
    ok('the next request does NOT reach upstream during cooldown', calls.length === 1);
    ok('and it says so rather than pretending the sky is empty', second.error === 'rate-limited');
    ok('status() surfaces the cooldown', ac.status().cooldown > 0);
  }

  /* ===================================================================== P6 */
  group('an upstream failure keeps the last good sky');
  {
    ac._reset();
    stubOpenSky([
      { status: 200, body: { states: [state('keep', 'SWA9', 45.5, -73.6)] } },
      { status: 500 }
    ]);
    const bbox = { minLat: 45.4, minLng: -73.7, maxLat: 45.6, maxLng: -73.5 };
    const good = await ac.states(bbox);
    ok('the good fetch populates the cache', good.rows.length === 1);

    // Age the cache past its freshness window so the next call refetches.
    await new Promise((r) => setTimeout(r, ac.CACHE_MS + 50));
    const failed = await ac.states(bbox);
    ok('a 500 does not blank the layer', failed.rows && failed.rows.length === 1);
    ok('but it is honestly marked stale', failed.stale === true);
    ok('and the error is recorded', /500/.test(ac.status().lastError));
  }

  group('with nothing cached, a failure is an error rather than an empty sky');
  {
    ac._reset();
    stubOpenSky([{ status: 500 }]);
    const r = await ac.states({ minLat: 1, minLng: 1, maxLat: 2, maxLng: 2 });
    ok('the caller is told the feed failed', r.error === 'upstream');
    ok('it does not pretend there are zero aircraft', !r.rows);
  }

  process.exit(H.report());
}

main().catch((e) => { console.error(e); process.exit(1); });
