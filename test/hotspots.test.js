/* Convoy — hotspots dedup-map regression tests.

   Covers the M2 fix: recentCell (the DEDUP_MS dedup map) must be hard-capped
   (it used to be an unbounded object whose only cleanup was "older than 30
   days", remotely growable through /api/waze bbox polling), and the switch to
   a Map must not change the dedup semantics.

   DATA_DIR is pointed at a temp dir BEFORE the first require of hotspots.js —
   otherwise the require loads the real server/data/hotspots.json and the
   process-'exit' flushSync would write test junk over it. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { group, ok, report } = require('./harness');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-hotspots-'));
process.env.DATA_DIR = TMP;
const hotspots = require('../server/hotspots');

const CAP = 300000;   // must match RECENT_CELL_MAX in server/hotspots.js
const HYS = CAP >> 4; // eviction hysteresis headroom

group('M2 — dedup map is bounded under unbounded distinct-cell load');
for (let i = 0; i < CAP + 50000; i++) {
  // distinct cells via stepped coords (lng wraps past 180 but cellId only
  // needs distinctness here, not geography)
  hotspots.record((i % 360000) * 0.001 - 180, Math.floor(i / 360000) * 0.001 - 85, Date.now());
}
ok('dedupSize stays ≤ cap + hysteresis after CAP+50k distinct cells',
  hotspots.dedupSize() <= CAP + HYS,
  'dedupSize=' + hotspots.dedupSize() + ' — the map is unbounded again (M2 regressed)');

group('M2 — dedup semantics unchanged (negative/boundary)');
const before = hotspots.dedupSize();
const ts = Date.now();
hotspots.record(12.3456, 45.6789, ts);
hotspots.record(12.3456, 45.6789, ts + 1000);            // same cell, same 15-min bucket
ok('a repeat sighting in the same bucket is collapsed',
  hotspots.dedupSize() === before + 1,
  'expected +' + 1 + ', got +' + (hotspots.dedupSize() - before));
const b2 = hotspots.dedupSize();
hotspots.record(12.3456, 45.6789, ts + 16 * 60 * 1000);  // same cell, NEXT bucket
ok('the same spot in a new 15-min window counts again',
  hotspots.dedupSize() === b2 + 1);

group('query still builds features from recorded observations');
const q = hotspots.query(12.34, 45.67, 12.35, 45.68, new Date(ts).getUTCHours());
ok('query returns a FeatureCollection', q && q.type === 'FeatureCollection');

process.exit(report());
