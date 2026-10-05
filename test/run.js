/* Convoy — run every test suite. `npm test` */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['physics.test.js', 'behaviour.test.js', 'auth.test.js', 'supabase.test.js', 'store.test.js',
  'mailer.test.js', 'oauth.test.js', 'serverpolicy.test.js', 'httpcache.test.js', 'globals.test.js', 'net.test.js',
  'routegeo.test.js', 'voice.test.js', 'riderarrows.test.js', 'telemetry.test.js', 'deletion.test.js',
  'sdk-inventory.test.js', 'ota.test.js', 'admin.test.js', 'bugstats.test.js', 'browser.test.js', 'fetchtimeout.test.js', 'partyresume.test.js', 'visibility.test.js', 'domids.test.js', 'chatlog.test.js', 'frontend.test.js', 'mapboot.test.js', 'perf-bench.js', 'stamp.test.js', 'lazydata.test.js', 'leaks.test.js', 'wire-bench.js', 'wiregate.test.js', 'wsdeflate.test.js', 'simidle.test.js', 'glassbudget.test.js', 'landing.test.js', 'packs.test.js'];
// Feature-pack suites (test/packs-<id>.test.js) register themselves by name:
// a pack is a self-contained tree, and its tests must not need an edit here.
const fs = require('fs');
fs.readdirSync(__dirname).filter((f) => /^packs-[a-z0-9-]+\.test\.js$/.test(f)).sort().forEach((f) => { if (!suites.includes(f)) suites.push(f); });

let failed = 0;

for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('');
if (failed) {
  console.log('\x1b[31m\x1b[1m' + failed + ' of ' + suites.length + ' suites failed.\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32m\x1b[1mAll ' + suites.length + ' suites passed.\x1b[0m');
