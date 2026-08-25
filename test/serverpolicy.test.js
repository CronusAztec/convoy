/* Convoy — server policy regression tests.

   server.js cannot be require()d (boot exits without Supabase config), so this
   suite pins the OPERATIONAL POLICIES the fixes introduced against the real
   source: it reads server.js and asserts the constants and guard lines are
   present and correctly sized. If someone reverts a fix or retunes a constant
   past its documented contract, this fails with the reason.

   Added with the 2026-08 hardening pass:
     M1  race:fix budget vs the client's 10Hz cadence (js/race.js)
     M3  HTTP slowloris timeouts
     M4  OAuth login-CSRF cookie binding
     S1  voice:signal throttle · S2 /api/logout throttle
     S3  traffic tile bounds · S4 global-feed privacy delay */
'use strict';
const fs = require('fs');
const path = require('path');
const { group, ok, report } = require('./harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

function numDefault(name) {
  const m = SRC.match(new RegExp("const " + name + " = parseInt\\(process\\.env\\." + name + " \\|\\| '(\\d+)'"));
  return m ? parseInt(m[1], 10) : null;
}

group('M1 — race:fix budget sustains the client cadence');
ok('RACE_FIX_BUDGET default ≥ 600 (10Hz × 60s for one racer)',
  (numDefault('RACE_FIX_BUDGET') || 0) >= 600,
  'got ' + numDefault('RACE_FIX_BUDGET') + ' — races starve mid-run again');
ok('RACE_FIX_IP_BUDGET default ≥ 3600 (6 NAT\'d racers at 10Hz)',
  (numDefault('RACE_FIX_IP_BUDGET') || 0) >= 3600,
  'got ' + numDefault('RACE_FIX_IP_BUDGET'));
ok("rate limit keyed per CONNECTION ('racefix:' + c.id)",
  /rateOk\('racefix:' \+ c\.id/.test(SRC),
  'per-IP keying returned — two racers behind one NAT throttle each other');
ok("rate limit also has the per-IP ceiling ('racefixip:' + c.ip)",
  /rateOk\('racefixip:' \+ c\.ip/.test(SRC));

group('M3 — slowloris bounds');
ok('requestTimeout set', /httpServer\.requestTimeout\s*=/.test(SRC),
  'no requestTimeout — Node default is 300s of withheld-body socket pinning');
ok('headersTimeout set', /httpServer\.headersTimeout\s*=/.test(SRC));

group('M4 — OAuth login-CSRF binding');
ok('/api/oauth/start sets the cvst cookie', /Set-Cookie', 'cvst='/.test(SRC));
ok('/api/oauth/callback rejects a mismatched cvst cookie', /cvst=([^;\]]+)[\s\S]{0,400}sign-in link was started somewhere else/.test(SRC));

group('S1/S2 — throttles');
ok("voice:signal throttled ('sig:' + c.id)", /rateOk\('sig:' \+ c\.id/.test(SRC));
ok("/api/logout throttled ('logout:' + ip)", /rateOk\('logout:' \+ ip/.test(SRC));

group('S3 — traffic tile bounds');
ok('tile z/x/y validated before upstream', /tz > 22 \|\| tx >= \(1 << tz\) \|\| ty >= \(1 << tz\)/.test(SRC),
  'garbage tiles burn TomTom quota again');

group('S4 — global-feed privacy delay');
ok('no post-boot fresh-snapshot fallback', !/snap = snapshots\[0\]/.test(SRC),
  'buildGlobalFC serves < GLOBAL_DELAY_MS-old positions again after restart');

process.exit(report());
