/* Convoy — the stamp rule, computed instead of remembered. `node test/stamp.test.js`.

   STATE.md's cycle-1 incident: the stamp rule ("bump index.html/css/js/legal's
   ?v=cyNNN by one whenever those files change since the last push") used to be
   written down as PROSE containing a FACT ("today production serves cy122").
   The fact went stale the moment the next push landed (stage 0008, cy122 →
   cy123) — the map was never re-read, so the cycle-1 implementer and the
   cycle-1 reviewer both correctly followed a rule that was, by then, false.
   Three of that implementer's real bug fixes (js/mapview.js, js/routing.js,
   js/telemetry.js) shipped under the SAME stamp the broken files already had,
   so every rider's browser had them pinned `immutable, max-age=31536000` —
   for a year — with no way to ever fetch the fix.

   The fix generalizes past this one bug: a rule phrased "X, because currently
   Y" is a landmine. This file makes the loop COMPUTE Y (git origin/main) every
   run instead of reading a remembered sentence in STATE.md.

   Rule, in plain terms: if any file under index.html/css/js/legal differs
   from what origin/main last published, the local stamp must be STRICTLY
   greater than the pushed stamp. If nothing changed, local may equal (or
   exceed, e.g. a server-only stage after a web stage) the pushed stamp, but
   never fall behind it.

   Reuses scripts/pack-ota.js's own readStamp/versionFromStamp/cmpVersion
   (module.exports at :292) — no second stamp parser. SKIPs (exit 0, never
   fails npm test) when there is no origin/main to compare against (a fresh
   clone with no remote), the same shape test/perf-bench.js uses when the
   browser binary is missing.

   Run:  node test/stamp.test.js  */
'use strict';
const { execFileSync } = require('child_process');
const { group, ok, report, ROOT } = require('./harness');
const { readStamp, versionFromStamp, cmpVersion } = require('../scripts/pack-ota.js');

/* ---------------- the rule itself, pure — no git, no fs, so the regression
   fixture below can drive it directly with constructed strings ---------------- */
function checkStampRule(pushedHtml, localHtml, webChanged) {
  const pushed = readStamp(pushedHtml);
  if (pushed.error) return { ok: false, reason: 'pushed index.html: ' + pushed.error };
  const local = readStamp(localHtml);
  if (local.error) return { ok: false, reason: 'local index.html: ' + local.error };
  const pv = versionFromStamp(pushed.stamp);
  const lv = versionFromStamp(local.stamp);
  const cmp = cmpVersion(lv, pv);
  if (webChanged) {
    return {
      ok: cmp > 0,
      reason: cmp > 0
        ? 'local ' + local.stamp + ' > pushed ' + pushed.stamp + ', web files changed since origin/main'
        : 'web files (index.html/css/js/legal) differ from origin/main but the stamp is not strictly newer ' +
          '(local ' + local.stamp + ', pushed ' + pushed.stamp + ') — the fix is stranded behind an immutable ' +
          'cache entry, exactly the cycle-1 incident'
    };
  }
  return {
    ok: cmp >= 0,
    reason: cmp >= 0
      ? 'local ' + local.stamp + ' >= pushed ' + pushed.stamp + ', no web files changed'
      : 'local stamp ' + local.stamp + ' is BEHIND the pushed stamp ' + pushed.stamp + ' with no local web changes — impossible without a bad revert'
  };
}

/* ---------------- live check against this checkout ---------------- */
function runLive() {
  let pushedHtml;
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: ROOT, stdio: 'pipe' });
    pushedHtml = execFileSync('git', ['show', 'origin/main:index.html'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    console.log('SKIP test/stamp.test.js — no origin/main to compare against (fresh clone / no remote); nothing checked, exit 0.');
    process.exit(0);
  }

  group('test/stamp.test.js — the cache-buster stamp vs. what origin/main last published');

  const fs = require('fs');
  const path = require('path');
  const localHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const changedFiles = execFileSync('git', ['diff', '--name-only', 'origin/main..HEAD', '--', 'index.html', 'css', 'js', 'legal'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirtyFiles = execFileSync('git', ['status', '--porcelain', '--', 'index.html', 'css', 'js', 'legal'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  const webChanged = !!(changedFiles || dirtyFiles);

  const local = readStamp(localHtml);
  ok('local index.html carries exactly one ?v=cyNNN stamp (no half-done sed)', !local.error,
    local.error && local.error);

  const result = checkStampRule(pushedHtml, localHtml, webChanged);
  ok('stamp rule: ' + (webChanged ? 'web files changed since origin/main → stamp must be strictly newer' : 'no web changes since origin/main → stamp must not be behind'),
    result.ok, result.reason);
}

/* ---------------- regression fixture: the exact cycle-1 situation,
   reconstructed, proving the checker actually catches it. A guard that can't
   be shown failing isn't a guard. ---------------- */
function runRegressionFixture() {
  group('regression fixture — the cycle-1 incident, reconstructed');

  const stamped = (n) => '<!doctype html><html><head>' +
    '<link rel="stylesheet" href="css/styles.css?v=cy' + n + '">' +
    '</head><body>' +
    '<script src="js/config.js?v=cy' + n + '" defer></script>' +
    '<script src="js/mapview.js?v=cy' + n + '" defer></script>' +
    '</body></html>';

  // "pushed" = production, still on cy123 (stage 0008's push).
  const pushedHtml = stamped(123);
  // "local" = cycle-1's tree: js/mapview.js was fixed (a real, executed diff
  // — irrelevant to this fixture beyond "web files changed"), but index.html
  // was NEVER bumped, so it is byte-identical at cy123.
  const localHtmlBroken = stamped(123);
  const webChangedTrue = true; // js/mapview.js differs from origin/main — this is the fact the incident hinged on

  const bad = checkStampRule(pushedHtml, localHtmlBroken, webChangedTrue);
  ok('FAILS on the cycle-1 tree (web changed, stamp NOT bumped) — this is the guard actually guarding', !bad.ok, bad.reason);

  // The fix: task 1 of this stage bumps the stamp to cy124.
  const localHtmlFixed = stamped(124);
  const good = checkStampRule(pushedHtml, localHtmlFixed, webChangedTrue);
  ok('PASSES once the stamp is bumped past the pushed stamp', good.ok, good.reason);

  // No web changes at all (a server-only stage): staying level is fine.
  const level = checkStampRule(pushedHtml, stamped(123), false);
  ok('PASSES when nothing web-side changed and the stamp did not move', level.ok, level.reason);

  // A mixed stamp (half-done sed) must be caught locally, not just by pack-ota.
  const mixedHtml = '<!doctype html><html><head>' +
    '<link rel="stylesheet" href="css/styles.css?v=cy124">' +
    '</head><body><script src="js/config.js?v=cy123" defer></script></body></html>';
  const mixed = readStamp(mixedHtml);
  ok('a mixed local stamp (half-done sed) is rejected before the rule even runs', !!mixed.error, mixed.error);
}

runRegressionFixture();
runLive();
process.exit(report());
