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
     S3  traffic tile bounds · S4 global-feed privacy delay

   Added with the 2026-08 security-review follow-up:
     R1  refresh-token reuse detection (revoke the family)
     F1  friend:add username oracle closed (silent, shape-identical no-op)
     C1  jsDelivr CSP allowlist pinned to exact files, not the origin
     U1  one throttling mechanism: the hand-rolled per-socket timestamp
         arrays ride the shared rateOk buckets like everything else.
         ONE deliberate exception, added with W1 below: the global
         per-connection message budget in ws.on('message') keeps two
         integers on the connection instead of a rateOk bucket, because
         rateOk's per-call array filter at 1800/min would make the limiter
         itself the amplifier under the flood it exists to stop. W1 pins
         that the gate stays rateOk-free; U1 still forbids any OTHER
         private throttle.

   Added with the second review round (name-sanitization regression):
     N1  rider-visible free text is character-allowlisted at the data layer —
         the door 400s (register/profile), the storage cleans, and the strip
         is GLOBAL (first-match-only stripping was caught in review)

   Added with the cycle-53 B3 truth pass (2026-09-03):
     W1  the socket dispatcher survives an impolite client (a global
         per-connection message budget over ALL message types, server-024)
         and an absent one (the TTS synth callback checks for a response the
         rider already abandoned before writing headers, server-022) */
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

group('R1 — refresh-token reuse detection');
ok('a completed refresh is remembered (rtRemember on the success path)',
  /function rtRemember\(/.test(SRC) && /rtRemember\(th, u\.id, r\.session\.access_token\)/.test(SRC));
ok('a replayed token is refused BEFORE GoTrue is asked (the reuse interval never sees it)',
  /rtSeen\.has\(th\)/.test(SRC) && /revokeRtFamily\(rtSeen\.get\(th\), ip\)/.test(SRC));
ok('the replay revokes the whole session family (global sign-out with the held token)',
  /sb\.signOut\(access, 'global', ip\)/.test(SRC));
ok('concurrent presentations are coalesced, not punished (two tabs share one GoTrue call)',
  /rtInFlight\.get\(th\)/.test(SRC) && /rtInFlight\.set\(th, pending\)/.test(SRC));
ok('the seen-set is bounded (memory ceiling on the map)',
  /RT_SEEN_MAX/.test(SRC));

group('F1 — friend:add username oracle');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'store.js'), 'utf8');
ok("the missing/blocked outcome is one code ('no-such-rider')",
  (STORE_SRC.match(/return \{ error: 'no-such-rider' \};/g) || []).length === 2,
  'not-found and blocked must collapse to the SAME code, in exactly those two branches');
ok('and is answered with the same frame a real send gets — same ok, same wording',
  /r\.error === 'no-such-rider'[\s\S]{0,400}friend:result', ok: true, msg: 'Friend request sent to ' \+ who/.test(SRC));
ok('no error message names the miss (nothing distinguishes "exists" from "not")',
  !/No rider with that username/.test(SRC));
ok('the echoed name is the input as typed on BOTH paths (stored casing would leak)',
  /'Friend request sent to ' \+ who/.test(SRC) && !/'Friend request sent to ' \+ r\.target\.username/.test(SRC));

group('C1 — jsDelivr CSP allowlist is file-pinned');
const scriptSrc = (SRC.match(/"script-src[^"]*"/) || [''])[0];
ok('script-src pins the exact package files, not the bare origin',
  /cdn\.jsdelivr\.net\/npm\/maplibre-gl@5\.24\.0\/dist\/maplibre-gl\.min\.js/.test(scriptSrc) &&
  /cdn\.jsdelivr\.net\/npm\/@tensorflow\/tfjs@4\.22\.0\/dist\/tf\.min\.js/.test(scriptSrc) &&
  /cdn\.jsdelivr\.net\/npm\/nsfwjs@4\.2\.1\/dist\/browser\.min\.js/.test(scriptSrc) &&
  /cdn\.jsdelivr\.net\/npm\/nsfwjs@2\.4\.2\/dist\/nsfwjs\.min\.js/.test(scriptSrc),
  scriptSrc);
ok('no origin-wide jsDelivr entry survives anywhere in the policy',
  !/cdn\.jsdelivr\.net[' ]/.test(SRC.replace(/cdn\.jsdelivr\.net\/npm\//g, '')),
  'an origin-wide https://cdn.jsdelivr.net reappeared — any package on the CDN runs as Convoy again');
const styleSrc = (SRC.match(/"style-src[^"]*"/) || [''])[0];
ok('style-src pins the maplibre css file',
  /cdn\.jsdelivr\.net\/npm\/maplibre-gl@5\.24\.0\/dist\/maplibre-gl\.min\.css/.test(styleSrc), styleSrc);
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const wwwHtml = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8');
ok('the meta CSP in index.html matches the pinned policy',
  indexHtml.indexOf('https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.js') >= 0 &&
  !/script-src[^"]*https:\/\/cdn\.jsdelivr\.net[ ']/.test(indexHtml));
ok('the meta CSP in www/index.html matches too (the APK half)',
  wwwHtml.indexOf('https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.js') >= 0 &&
  !/script-src[^"]*https:\/\/cdn\.jsdelivr\.net[ ']/.test(wwwHtml));

group('U1 — one throttling mechanism');
ok('chat / invites / friend requests ride the shared rateOk buckets',
  /rateOk\('chat:' \+ c\.id/.test(SRC) &&
  /rateOk\('invite:' \+ c\.id/.test(SRC) &&
  /rateOk\('freq:' \+ c\.id/.test(SRC));
ok('no hand-rolled per-socket timestamp array survives',
  !/chatTimes|inviteTimes|friendReqTimes/.test(SRC),
  'a private throttle reappeared — it drifts from the one scheme (and its prune)');

group('N1 — rider-visible free text is allowlisted');
// The whole point of this suite: server.js can't be require()d (it boots), so
// its rules are pinned in source AND — where the rule is pure logic like this
// one — the real literals are pulled out and EXECUTED here.
const n1Lit = SRC.match(/const TEXT_ALLOW = ("(?:[^"\\]|\\.)*");/);
ok('TEXT_ALLOW exists as a plain string literal', !!n1Lit);
ok('the door-check regex alternation (class + ^/` carve-out) is constructed as designed',
  SRC.indexOf("const TEXT_BAD = new RegExp('(?:[\\\\^`]|[^' + TEXT_ALLOW + '])', 'u');") >= 0 &&
  SRC.indexOf("const TEXT_STRIP = new RegExp('(?:[\\\\^`]|[^' + TEXT_ALLOW + '])', 'gu');") >= 0);
ok('cleanText strips with the GLOBAL regex — every offender, not the first',
  SRC.indexOf('v.replace(TEXT_STRIP, ') >= 0 &&
  !/\.replace\(TEXT_BAD,/.test(SRC));
ok('sanitizeProfile routes name/vibe and every garage free-text through cleanText',
  /name: cleanText\(p\.name, 24, 'Rider'\)/.test(SRC) &&
  /vibe: cleanText\(p\.vibe, 24, 'Chill cruise'\)/.test(SRC) &&
  (SRC.match(/cleanText\(car\./g) || []).length === 6);
ok('convoy titles are cleaned too (ws doors have no reply frame to reject with)',
  /cleanText\(name, 30, \(c\.profile\.name \|\| 'My'\) \+ "'s convoy"\)/.test(SRC));
ok('register and /api/profile answer 400 on violating text (the observable the pen-test restored)',
  (SRC.match(/profileTextViolations\(body\.profile\)/g) || []).length === 2 &&
  SRC.indexOf("return json(res, 400, { error: 'Bad request' })") >= 0);
if (n1Lit) {
  const TEXT_ALLOW = eval(n1Lit[1]);                    // exactly what Node parses
  const bad = new RegExp('(?:[\\^`]|[^' + TEXT_ALLOW + '])', 'u');
  const strip = new RegExp('(?:[\\^`]|[^' + TEXT_ALLOW + '])', 'gu');
  const clean = (v) => v.replace(strip, '').trim().slice(0, 24);
  // markup skeleton, format/attribute-context chars, control + bidi override
  const evil = ['<', '>', '"', '=', '`', ';', ':', '\\', '{', '}', '[', ']', '|', '^', '@', '$', '%', '\u0000', '\u202E'];
  ok('every markup/format char is flagged AND stripped (all occurrences)',
    evil.every((ch) => bad.test(ch) && clean('x' + ch + 'y' + ch + 'z') === 'xyz'),
    'a character that survives the strip can arm a name again');
  // names, accents, scripts, numbers, spaces, plausible punctuation
  const good = ['a', 'Z', 'é', '中', '5', ' ', '.', ',', "'", '’', '(', ')', '-', '_', '!', '?', '&', '/', '+', '*', '#', '~', '°', '§'];
  ok('legitimate name characters all survive',
    good.every((ch) => !bad.test(ch)));
  ok("O'Brien 🚗 / café / Mazda CX-5 2.5L survive intact",
    clean("O'Brien 🚗") === "O'Brien 🚗" &&
    clean('café Rider') === 'café Rider' &&
    clean('Mazda CX-5 2.5L') === 'Mazda CX-5 2.5L');
  ok('emoji sequences keep their ZWJ; skin tones keep their modifier',
    clean('👨‍👩').indexOf('\u200D') >= 0 && clean('👍🏽') === '👍🏽');
  ok('the pen-test payload comes out inert and stays inert',
    !bad.test(clean('"><svg onload=alert(1)>`x`^<img src=x onerror=alert(1)>')));
}

group('W1 — the socket dispatcher survives an impolite or absent client');
// server-024: every handler above throttles ONE message type; this is the
// ceiling over all of them. The sizing invariant is computed from the source,
// never hard-coded: a legitimate racer's documented peak is race:fix at 10Hz
// (RACE_FIX_BUDGET/min) + pos at 1Hz (60/min, js/net.js sendPos) + voice:signal
// at its own 40-per-5s ceiling (480/min). A retune below that starves a real
// racer, and this check says so with the arithmetic in the message.
const wsBudget = numDefault('WS_MSG_BUDGET');
const raceFixBudget = numDefault('RACE_FIX_BUDGET');
const legitPeak = (raceFixBudget || 0) + 60 + 480;
ok('WS_MSG_BUDGET exists as an env-tunable parseInt default (per connection, per minute)',
  wsBudget !== null,
  'no WS_MSG_BUDGET constant — the dispatcher has no global budget and {"t":"wave"} at line rate is a scoped broadcast per message again');
ok('WS_MSG_BUDGET (' + wsBudget + ') ≥ RACE_FIX_BUDGET + 60 + 480 = ' + legitPeak + " (a racer's legitimate peak)",
  wsBudget !== null && raceFixBudget !== null && wsBudget >= legitPeak,
  'retuned below the documented peak — a real racer at 10Hz is throttled by the flood gate');
// Anchored on the code shape, not the phrase, so a comment that mentions the
// handler elsewhere in the file cannot move the region.
const msgAt = SRC.indexOf("ws.on('message', (buf) =>");
const closeAt = SRC.indexOf("ws.on('close'", msgAt);
const gateAt = SRC.indexOf('WS_MSG_BUDGET', msgAt);
const lookupAt = SRC.indexOf('Object.prototype.hasOwnProperty.call(handlers, m.t)', msgAt);
ok("the gate sits inside ws.on('message'), before the handlers[m.t] lookup",
  msgAt >= 0 && gateAt > msgAt && lookupAt > gateAt && gateAt < closeAt,
  'no WS_MSG_BUDGET use between the message handler start and the handler lookup (msg@' + msgAt + ' gate@' + gateAt + ' lookup@' + lookupAt + ')');
const gate = (msgAt >= 0 && lookupAt > msgAt) ? SRC.slice(msgAt, lookupAt) : '';
ok('the counter is two integers on the connection (c.msgWinStart / c.msgCount), lazily initialised in the gate',
  /c\.msgWinStart/.test(gate) && /c\.msgCount/.test(gate),
  'the fixed-window counter fields are gone');
// Code only: the gate's own comment explains WHY it avoids rateOk, by name.
const gateCode = gate.replace(/\/\/[^\n]*/g, '');
ok('the gate is O(1): no rateOk() call anywhere in the dispatcher (its per-call array filter would be the amplifier)',
  gateCode.length > 0 && gateCode.indexOf('rateOk(') === -1,
  'rateOk crept into the hot path — every message now filters an ~1800-entry array under the flood the gate exists to stop');
const overAt = gate.indexOf('c.msgCount > WS_MSG_BUDGET');
const exemptAt = gate.indexOf("if (m.t !== 'hello') return;");
ok("'hello' is counted toward the budget but never dropped (sign-in survives a reconnect storm)",
  overAt >= 0 && exemptAt > overAt,
  'the hello exemption is missing or precedes the budget check');
ok('over budget drops the MESSAGE, never the socket (no close/terminate in the gate)',
  gate.length > 0 && !/ws\.close\(|ws\.terminate\(/.test(gate),
  "a rider whose phone burped gets disconnected instead of having a second's worth of pos frames dropped");
ok('crossing the budget is logged once per window, naming the rider and the limit',
  /c\.msgCount === WS_MSG_BUDGET \+ 1/.test(gate) && /console\.warn\([^;]*WS_MSG_BUDGET/.test(gate),
  'a silent limiter that starves a real user is the failure mode to avoid');

// Executed, not just grepped (the N1 pattern): the gate's real source text is
// lifted out of server.js and run with a fake clock and a fake console. If the
// window arithmetic, the hello exemption or the log-once rule regress, this
// fails on the behaviour, not on a string.
const gateStart = gate.indexOf('const now = Date.now();');
if (gateStart >= 0) {
  const gateSrc = gate.slice(gateStart, gate.lastIndexOf('\n'));
  let runGate = null;
  try { runGate = new Function('c', 'm', 'WS_MSG_BUDGET', 'WS_MSG_WINDOW_MS', 'console', 'Date', gateSrc + '\nreturn true;'); }
  catch (e) { runGate = null; }
  ok('the gate is self-contained (compiles with only c, m, the two constants, console and Date in scope)', !!runGate,
    'the gate grew a dependency the executed check cannot see — keep it to the two integers');
  if (runGate) {
    let clock = 1000000;
    const fakeDate = { now: () => clock };
    const warns = [];
    const fakeConsole = { warn: (line) => warns.push(String(line)), log() {}, error() {} };
    const budget = wsBudget || 1800;
    const c = { id: 'c-test', ip: '203.0.113.9', profile: { name: 'Ada' } };
    let passed = 0, dropped = 0;
    for (let i = 0; i < budget + 50; i++) {
      if (runGate(c, { t: 'wave' }, budget, 60000, fakeConsole, fakeDate) === true) passed++; else dropped++;
    }
    ok('executed: exactly WS_MSG_BUDGET (' + budget + ') messages pass in one window, the next 50 are dropped',
      passed === budget && dropped === 50, 'passed=' + passed + ' dropped=' + dropped);
    ok('executed: a hello still passes while the connection is over budget',
      runGate(c, { t: 'hello' }, budget, 60000, fakeConsole, fakeDate) === true);
    ok('executed: crossing the budget warns exactly once per window and names the rider',
      warns.length === 1 && /Ada/.test(warns[0]) && /203\.0\.113\.9/.test(warns[0]), warns.join(' | ') || '(no warning)');
    clock += 60000;
    ok('executed: after WS_MSG_WINDOW_MS the window resets and the rider is served again',
      runGate(c, { t: 'wave' }, budget, 60000, fakeConsole, fakeDate) === true && c.msgCount === 1,
      'msgCount=' + c.msgCount);
    ok('executed: the counter is two plain integers on the connection, nothing else was attached',
      Number.isInteger(c.msgWinStart) && Number.isInteger(c.msgCount) &&
      Object.keys(c).filter((k) => k !== 'id' && k !== 'ip' && k !== 'profile').sort().join(',') === 'msgCount,msgWinStart',
      Object.keys(c).join(','));
  }
}

// server-022: synthesis is slow and the caller is a phone in a moving car. If
// the client is gone by the time piper answers, writing headers throws out of
// the async callback and lands in uncaughtException.
const ttsAt = SRC.indexOf('ttsSynth(text, function (err, buf)');
const releaseAt = SRC.indexOf('ttsRelease(ip);', ttsAt);
const guardAt = SRC.indexOf('if (res.writableEnded || res.destroyed) return;', ttsAt);
const firstWriteAt = SRC.indexOf('res.writeHead(', ttsAt);
ok('the TTS synth callback checks res.writableEnded || res.destroyed before it writes headers',
  ttsAt >= 0 && guardAt > ttsAt && firstWriteAt > guardAt,
  'an aborted /api/tts throws ERR_STREAM_DESTROYED out of the synth callback again');
ok('ttsRelease(ip) runs BEFORE that guard (an aborting client must not burn one of its in-flight synth slots)',
  ttsAt >= 0 && releaseAt > ttsAt && guardAt > releaseAt,
  'release after the early return = a slot leaks per aborted request until the IP is locked out of TTS');

process.exit(report());
