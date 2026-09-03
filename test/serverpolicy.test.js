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
         rider already abandoned before writing headers, server-022)

   Added with the cycle-54 B3b + cache-policy stage (2026-09-03):
     H1  static assets are cached by their stamp: the handler stats before it
         reads, a matching If-None-Match short-circuits to a 304 before any
         fs.readFile, the policy lives in server/httpcache.js (executed by
         test/httpcache.test.js, never re-inlined here), `immutable` never
         reaches the branch that serves index.html, and STATIC_IMMUTABLE is
         the documented kill switch
     D1  every deferred body goes through defer() (a try/catch around the
         five setTimeout bodies that used to land on uncaughtException,
         server-002) and leadership goes to a socket that is still OPEN
         (server-020)

   Added with the cycle-55 chat-outage stage (2026-09-03):
     X1  a rider's chat message actually reaches the convoy — the chat handler
         is lifted out of server.js and EXECUTED against fakes. Its fan-out
         envelope carried `t2: now`, an undefined name, from the initial commit
         to cycle 55, so every live chat line died in the dispatcher's catch
         (server-032). The mutation guard re-runs the same lift with `t2: now`
         and demands the ReferenceError, so the group is a detector, not a
         passenger
     X2  a `systemctl restart` that lands mid-boot returns from boot() instead
         of blaming SUPABASE_DB_URL and exiting 1 (server-033)

   Added with the cycle-56 B5 stage (2026-09-03):
     Y1  the anonymous-credential rate gate is two tiers — a pre-body per-IP
         flood ceiling and a post-body per-route attempt budget — lifted in
         three pieces and EXECUTED over a scripted readBody(). One shared
         `auth:<ip>` bucket used to gate all eleven routes, so 24 fat-fingered
         logins behind carrier NAT 429'd /api/recover for everyone on that
         address, and a malformed or oversized body burned a login attempt
         (server-017). The mutation guard pastes the old gate back in and
         demands both failures, and AUTH_FLOOD_MAX >= sum(budgets) is pinned
         so the self-DoS cannot be re-created by nudging one number */
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

group('H1 — static assets are cached by their stamp, and revalidation is a 304');
// The policy itself is executed by test/httpcache.test.js (real round-trips over
// a temp dir, plus the real static tail lifted out of this file). These pins
// guard the WIRING: stat before read, 304 before read, the module required
// rather than re-inlined, and `immutable` kept out of the index.html branch.
const CACHE_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'httpcache.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(__dirname, '..', 'server', '.env.example'), 'utf8');
const staticAt = SRC.indexOf('Object.prototype.hasOwnProperty.call(LEGAL_PAGES, urlPath)');
const staticEnd = SRC.indexOf('/* ================= websocket wiring', staticAt);
const staticRegion = (staticAt >= 0 && staticEnd > staticAt) ? SRC.slice(staticAt, staticEnd) : '';
const staticCode = staticRegion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const statAt = staticRegion.indexOf('fs.stat(file');
const readAt = staticRegion.indexOf('fs.readFile(file');
const notModAt = staticRegion.indexOf('res.writeHead(304');
ok('server.js requires ./httpcache (the policy is a module, not re-inlined in the handler)',
  /require\('\.\/httpcache'\)/.test(SRC), "no require('./httpcache') in server.js");
ok('the static handler calls fs.stat(file) BEFORE fs.readFile(file)',
  statAt >= 0 && readAt > statAt, 'stat@' + statAt + ' read@' + readAt + ' (region ' + staticRegion.length + ' chars)');
ok('the 304 branch sits between the stat and the read, and returns before any fs.readFile',
  notModAt > statAt && notModAt < readAt && /res\.writeHead\(304[\s\S]{0,200}?return;/.test(staticRegion),
  '304@' + notModAt + ' — a 304 that still reads the body is the old cost with a new status code');
ok('the 304 is answered by matchesEtag(req.headers[\'if-none-match\'], …) — RFC 7232, not a hand-rolled compare',
  /httpcache\.matchesEtag\(req\.headers\['if-none-match'\]/.test(staticRegion));
ok('a non-file stat (a directory such as /js) still 404s — stat-first must not turn EISDIR into a cacheable 200/304',
  /!st\.isFile\(\)/.test(staticRegion), "the '!st.isFile()' guard is gone");
ok('the literal `immutable` lives in server/httpcache.js …',
  /immutable/.test(CACHE_SRC));
ok('… and the static handler CODE (comments stripped) builds no Cache-Control string of its own: no quoted `immutable`, no max-age, no Cache-Control literal — the only `immutable` there is the option key passing the switch through',
  staticCode.length > 0 && !/Cache-Control|max-age|['"`][^'"`\n]*immutable/.test(staticCode),
  'a Cache-Control decision crept back into server.js — index.html must stay no-cache');
ok('max-age=31536000 is paired with `immutable` in the same header string (a long max-age alone still revalidates on every reload)',
  /public, max-age=31536000, immutable/.test(CACHE_SRC));
ok('the entry point stays revalidated: httpcache.js emits `no-cache` for anything unstamped',
  /'no-cache'/.test(CACHE_SRC));
ok('STATIC_IMMUTABLE is read from process.env exactly once, at require time, as a kill switch',
  /const IMMUTABLE_ENABLED = process\.env\.STATIC_IMMUTABLE !== '0'/.test(CACHE_SRC) && (CACHE_SRC.match(/process\.env\.STATIC_IMMUTABLE/g) || []).length === 1);
ok('server/.env.example documents STATIC_IMMUTABLE and WS_MSG_BUDGET (the runtime tuning knobs are discoverable)',
  /STATIC_IMMUTABLE/.test(ENV_EXAMPLE) && /WS_MSG_BUDGET/.test(ENV_EXAMPLE), 'a knob nobody can find is a knob nobody can turn');

group('D1 — deferred work is guarded, and leadership goes to a live socket');
// server-002: five deferred bodies (race teardown, bot invite reply, bot chat
// reply, bot wave reply, race green light) ran outside every try/catch. The
// count of bare `setTimeout(() => {` blocks was 5 before the fix; now the only
// one is inside defer() itself. The shutdown safety net at the bottom of the
// file is `setTimeout(() => process.exit(0), …)` — no brace, cannot throw,
// needs its .unref() — and is deliberately not counted.
const bareBlocks = (SRC.match(/setTimeout\(\(\) => \{/g) || []).length;
ok('every deferred body in server.js is guarded (only the defer() helper itself uses a bare setTimeout block; found ' + bareBlocks + ')',
  bareBlocks === 1, 'a new setTimeout(() => { … }) body escaped defer() — a throw in it lands on uncaughtException');
ok('defer() wraps the body in try/catch and returns the timer handle (two call sites chain .unref())',
  /function defer\(fn, ms\) \{\s*return setTimeout\(\(\) => \{\s*try \{ fn\(\); \} catch \(e\) \{ console\.error\(/.test(SRC));
const deferUses = (SRC.match(/\bdefer\(/g) || []).length;
ok('defer() is actually used at the five deferred call sites (' + deferUses + ' occurrences incl. the helper)',
  deferUses >= 6, 'expected the helper + 5 call sites');
ok('the two teardown timers (race end grace, race green light) still .unref() so a draining process is not held open',
  (SRC.match(/\}, 8000\)\.unref\(\);/g) || []).length === 1 && (SRC.match(/\}, 3000\)\.unref\(\);/g) || []).length === 1);
// server-020: leaveParty() runs from ws.on('close') BEFORE clients.delete(), so
// with two riders dropping together the first close handler still finds the
// second in `clients` with a socket that has already left OPEN.
const lpAt = SRC.indexOf('function leaveParty(rider, silent)');
const lpEnd = SRC.indexOf('\n}\n', lpAt);
const lp = (lpAt >= 0 && lpEnd > lpAt) ? SRC.slice(lpAt, lpEnd) : '';
const pickAt = lp.indexOf('if (party.leader === rider.id)');
const liveAt = lp.indexOf('readyState === 1', pickAt);
const assignAt = lp.indexOf('party.leader = ', pickAt);
ok('leaveParty() picks the new leader with the file\'s own liveness idiom (ws.readyState === 1) before assigning',
  pickAt >= 0 && liveAt > pickAt && assignAt > liveAt,
  'pick@' + pickAt + ' live@' + liveAt + ' assign@' + assignAt + ' — leadership can be handed to a socket that is mid-close again');
ok('… and keeps the `|| humanMembers[0]` fallback so a party whose every socket is mid-close is never leaderless',
  /party\.leader = live \|\| humanMembers\[0\];/.test(lp));
ok('the pick is join-ordered by construction: party.members is only ever push()ed and splice()d, never reassigned or sorted',
  !/party\.members = |members\.sort\(|members\.reverse\(|members\.unshift\(/.test(SRC));

// Executed, not just grepped (the W1 pattern): defer() and leaveParty() are
// lifted out of server.js verbatim and run against fakes. If the try/catch
// or the liveness pick regress, this fails on the behaviour, not on a string.
const dAt = SRC.indexOf('function defer(fn, ms)');
const dEnd = dAt >= 0 ? SRC.indexOf('\n}\n', dAt) + 3 : -1;
if (dAt >= 0 && dEnd > dAt) {
  const logged = [];
  const runNow = (fn) => { fn(); return { unref() { return this; } }; };
  const deferFn = new Function('setTimeout', 'console', SRC.slice(dAt, dEnd) + '\nreturn defer;')(runNow, { error: (...a) => logged.push(a.join(' ')) });
  let escaped = null, handle = null;
  try { handle = deferFn(() => { throw new Error('boom'); }, 5); } catch (e) { escaped = e; }
  ok('executed: a throwing deferred body is caught and logged with its message, never raised',
    escaped === null && logged.length === 1 && /boom/.test(logged[0]), escaped ? 'escaped: ' + escaped.message : logged.join(' | '));
  ok('executed: defer() returns the timer handle, so .unref() still chains',
    !!handle && typeof handle.unref === 'function');
}
if (lp) {
  const parties = new Map(), clients = new Map(), bots = new Map(), sys = [];
  const mk = (id, ready) => ({ id, party: 'p1', ws: { readyState: ready }, profile: { name: id }, bot: false });
  const A = mk('A', 1), B = mk('B', 3), C = mk('C', 1);   // B: mid-close (CLOSED=3), still in `clients`
  clients.set('A', A); clients.set('B', B); clients.set('C', C);
  const party = { id: 'p1', code: 'X', leader: 'A', members: ['A', 'B', 'C'], chat: [] };
  parties.set('p1', party);
  const leave = new Function('parties', 'clients', 'bots', 'send', 'partySys', 'riderName', 'getRider', 'sendPartyState',
    lp + '\n}\nreturn leaveParty;')(parties, clients, bots, () => {}, (p, t) => sys.push(t), (r) => r.profile.name, (id) => clients.get(id) || null, () => {});
  leave(A, true);
  ok('executed: leader A leaves while B (next in join order) is mid-close -> C, the earliest LIVE member, leads',
    party.leader === 'C' && sys[sys.length - 1] === 'C now leads the convoy', 'leader=' + party.leader + ' sys=' + sys.join(' | '));
  C.ws.readyState = 3;
  leave(C, true);
  ok('executed: with every remaining socket mid-close the fallback keeps the join-order pick (B) — never leaderless',
    party.leader === 'B' && parties.has('p1'), 'leader=' + party.leader);
}


/* ---- X1 — a rider's chat message actually reaches the convoy (server-032) ----
   Lift-and-execute, the D1 pattern: the `chat` handler is an object-literal
   method, so it is sliced from `\n  chat(c, m) {` to its matching `\n  },\n`
   and wrapped as a plain function over fakes for everything it closes over. */
group('X1 — a rider\'s chat message actually reaches the convoy (server-032)');
const chatOpen = '\n  chat(c, m) {';
const chatAt = SRC.indexOf(chatOpen);
const chatEnd = chatAt >= 0 ? SRC.indexOf('\n  },\n', chatAt) : -1;
const chatBody = (chatAt >= 0 && chatEnd > chatAt) ? SRC.slice(chatAt + chatOpen.length, chatEnd) : '';
ok('the chat handler can be lifted: `chat(c, m) {` … `},` found once, body non-trivial',
  chatBody.length > 300 && SRC.indexOf(chatOpen, chatAt + 1) === -1, 'at=' + chatAt + ' end=' + chatEnd + ' len=' + chatBody.length);

function chatWorld(opts) {
  opts = opts || {};
  const parties = new Map(), clients = new Map(), bots = new Map(), sent = [];
  const blocked = new Set(opts.blocked || []);
  const mk = (id) => ({ id, party: 'p1', profile: { name: id, emoji: '🏍' }, ws: { readyState: 1 } });
  const members = ['A', 'B', 'C'];
  members.forEach((id) => clients.set(id, mk(id)));
  if (opts.withBot) { const z = mk('Z'); clients.set('Z', z); bots.set('Z', z); members.push('Z'); }
  const party = { id: 'p1', code: 'X', leader: 'A', members, chat: [] };
  parties.set('p1', party);
  const chat = new Function('parties', 'clients', 'rateOk', 'str', 'liteOf', 'blockedPair', 'send', 'bots', 'B', 'defer',
    'return function chat(c, m) {' + (opts.body || chatBody) + '\n};')(
    parties, clients,
    () => opts.rateOk !== false,
    (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : ''),
    (c) => ({ id: c.id, name: c.profile.name, emoji: c.profile.emoji }),
    (a, b) => blocked.has(a.id + ':' + b.id) || blocked.has(b.id + ':' + a.id),
    (c, m) => sent.push({ to: c.id, m }),
    bots,
    { chance: () => !!opts.withBot, pick: (a) => a[0], randInt: () => 0, CHAT_REPLIES: ['copy that'] },
    (fn) => { fn(); return { unref() { return this; } }; });
  return { parties, clients, party, sent, chat, say: (from, text) => chat(clients.get(from), { t: 'chat', text }) };
}

if (chatBody) {
  const w = chatWorld();
  let threw = null;
  try { w.say('A', '  hi  '); } catch (e) { threw = e; }
  const envs = w.sent.filter((s) => s.m.t === 'chat');
  ok('executed: A says "hi" in a 3-member convoy → three chat envelopes go out (A, B, C), each { t:\'chat\', text:\'hi\', t2:<finite> }',
    threw === null && envs.length === 3 && ['A', 'B', 'C'].every((id) => envs.some((s) => s.to === id)) &&
    envs.every((s) => s.m.text === 'hi' && Number.isFinite(s.m.t2)),
    threw ? 'threw: ' + threw.message : 'sent=' + JSON.stringify(w.sent));
  ok('executed: the sender gets their own line back (from.id === A) — the live client has no local echo, so this is the only way "me" ever renders',
    envs.some((s) => s.to === 'A' && s.m.from && s.m.from.id === 'A'), 'sent=' + JSON.stringify(w.sent));
  ok('executed: t2 equals the party.chat entry\'s t, so the live envelope and the backlog (visibleChat ships `t`) agree on the timestamp',
    w.party.chat.length === 1 && envs.length > 0 && envs.every((s) => s.m.t2 === w.party.chat[0].t),
    'chat=' + JSON.stringify(w.party.chat) + ' t2=' + envs.map((s) => s.m.t2).join(','));

  const wb = chatWorld({ blocked: ['A:B'] });
  let threwB = null;
  try { wb.say('A', 'hi'); } catch (e) { threwB = e; }
  const to = wb.sent.filter((s) => s.m.t === 'chat').map((s) => s.to).sort().join('');
  ok('executed: a member who has blocked (or is blocked by) the sender receives nothing; the others still do — the blockedPair guard survives',
    threwB === null && to === 'AC', threwB ? 'threw: ' + threwB.message : 'delivered to=' + to);

  const wr = chatWorld({ rateOk: false });
  wr.say('A', 'hi');
  ok('executed: over the chat rate limit → one err to the sender, nothing to the convoy, nothing in the backlog',
    wr.sent.length === 1 && wr.sent[0].to === 'A' && wr.sent[0].m.t === 'err' && wr.party.chat.length === 0, JSON.stringify(wr.sent));

  const we = chatWorld();
  we.say('A', '   ');
  ok('executed: whitespace-only text sends nothing and stores nothing', we.sent.length === 0 && we.party.chat.length === 0);

  const wz = chatWorld({ withBot: true });
  let threwZ = null;
  try { wz.say('A', 'hi'); } catch (e) { threwZ = e; }
  const replies = wz.sent.filter((s) => s.m.t === 'chat' && s.m.text === 'copy that');
  ok('executed: with a bot in the convoy the deferred bot reply reaches all four members with t2 === its own backlog entry\'s t (the third envelope site)',
    threwZ === null && replies.length === 4 && wz.party.chat.length === 2 && replies.every((s) => s.m.from.id === 'Z' && s.m.t2 === wz.party.chat[1].t),
    threwZ ? 'threw: ' + threwZ.message : 'replies=' + JSON.stringify(replies));

  // The mutation guard: the same lift with the shipped bug put back must throw
  // where the shipped server threw. If this stops failing, the assertion above
  // has stopped detecting anything.
  ok('the fan-out stamps the envelope with `t2: entry.t` — the party.chat entry\'s own timestamp', /t2: entry\.t\b/.test(chatBody));
  const mutated = chatBody.replace(/t2: entry\.t\b/, 't2: now');
  let mutErr = null;
  try { chatWorld({ body: mutated }).say('A', 'hi'); } catch (e) { mutErr = e; }
  ok('mutation guard: the same lift with `t2: now` (the shipped bug) throws ReferenceError before the first send() — so the checks above are a real detector',
    mutated !== chatBody && mutErr instanceof ReferenceError && /\bnow\b/.test(mutErr.message), mutErr ? String(mutErr) : 'did not throw');
}
const chatSites = SRC.split('\n').map((l, i) => ({ l, n: i + 1 })).filter((x) => /\bt: 'chat'/.test(x.l));
ok('static: server.js builds exactly three chat envelopes (partySys, the rider fan-out, the bot reply)',
  chatSites.length === 3, 'lines ' + chatSites.map((x) => x.n).join(','));
ok('static: every one of them carries a t2 that is a defined expression (<entry>.t), and none is `t2: now`',
  chatSites.length > 0 && chatSites.every((x) => /t2: [A-Za-z_$][\w$]*\.t\b/.test(x.l) && !/t2:\s*now\b/.test(x.l)),
  chatSites.map((x) => x.n + ': ' + x.l.trim()).join(' | '));

/* ---- X2 — a restart that lands mid-boot is not a database misconfiguration (server-033) ----
   shutdown() ends the pool under boot()'s pending store.init(); the rejection
   that produces is indistinguishable from a dead database unless the catch
   asks whether a shutdown is in progress FIRST. */
group('X2 — a restart that lands mid-boot returns from boot() instead of blaming SUPABASE_DB_URL (server-033)');
ok('shutdown() sets shuttingDown as its first statement after the re-entrancy guard — the boot catch depends on it',
  /function shutdown\(sig\) \{\n  if \(shuttingDown\) return;\n  shuttingDown = true;\n/.test(SRC));
ok('shuttingDown is declared exactly once, at module level, and assigned exactly once — no second flag',
  (SRC.match(/^let shuttingDown = false;$/gm) || []).length === 1 && (SRC.match(/\bshuttingDown = true\b/g) || []).length === 1);
const bootAt = SRC.indexOf('(async function boot() {');
const initAt = bootAt >= 0 ? SRC.indexOf('await store.init();', bootAt) : -1;
const catchOpen = '} catch (e) {';
const catchAt = initAt >= 0 ? SRC.indexOf(catchOpen, initAt) : -1;
const catchEnd = catchAt >= 0 ? SRC.indexOf('\n  }\n', catchAt) : -1;
const bootCatch = (catchAt > initAt && catchEnd > catchAt) ? SRC.slice(catchAt + catchOpen.length, catchEnd) : '';
ok('boot(): the store.init() catch tests shuttingDown BEFORE it prints "Check SUPABASE_DB_URL"',
  bootCatch.indexOf('if (shuttingDown)') >= 0 && bootCatch.indexOf('if (shuttingDown)') < bootCatch.indexOf('Check SUPABASE_DB_URL'),
  'catch body: ' + bootCatch.replace(/\s+/g, ' ').slice(0, 160));
function runBootCatch(flag) {
  const out = { log: [], error: [], exit: [] };
  new Function('shuttingDown', 'console', 'process', 'e', bootCatch)(flag,
    { log: (...a) => out.log.push(a.join(' ')), error: (...a) => out.error.push(a.join(' ')) },
    { exit: (code) => out.exit.push(code) }, new Error('Cannot use a pool after calling end on the pool'));
  return out;
}
if (bootCatch) {
  const r1 = runBootCatch(true);
  ok('executed: with shuttingDown set, the catch logs "[boot] aborted" and returns — no exit(1), no SUPABASE_DB_URL blame',
    r1.exit.length === 0 && r1.log.some((l) => /^\[boot\] aborted/.test(l)) && !r1.error.some((l) => /SUPABASE_DB_URL/.test(l)), JSON.stringify(r1));
  const r0 = runBootCatch(false);
  ok('executed: with shuttingDown clear, a genuine failure still names the cause, says where to look, and exits 1',
    r0.exit.length === 1 && r0.exit[0] === 1 && r0.error.some((l) => /could not reach the Supabase database: Cannot use a pool/.test(l)) &&
    r0.error.some((l) => /Check SUPABASE_DB_URL/.test(l)), JSON.stringify(r0));
}
const jwksAt = bootAt >= 0 ? SRC.indexOf('await sb.loadJwks(true)', bootAt) : -1;
const jwksMsgAt = jwksAt >= 0 ? SRC.indexOf('could not load the Supabase JWKS', jwksAt) : -1;
const jwksGuardAt = jwksAt >= 0 ? SRC.indexOf('if (shuttingDown)', jwksAt) : -1;
ok('boot(): the JWKS check is guarded the same way — shuttingDown is tested between that await and the "could not load the Supabase JWKS" exit',
  jwksAt > 0 && jwksGuardAt > jwksAt && jwksGuardAt < jwksMsgAt, 'jwks@' + jwksAt + ' guard@' + jwksGuardAt + ' msg@' + jwksMsgAt);


/* ---- Y1 — one rider's fat-fingered logins do not take /api/recover away from a carrier NAT (server-017) ----
   Lift-and-execute, in three pieces this time. The anonymous-credential gate
   is sliced out of server.js — the budget table, the pre-body flood check and
   the head of the readBody() callback — and composed into a fake handleApi()
   over a real, lifted rateOk() and a scripted readBody(): a well-formed body
   reaches the attempt check, a malformed one 400s, an oversized one 413s
   inside the data handler and never calls back (that is what readBody does).
   The markers exist in both the old and the new shape, so the executed checks
   run against the shipped single-bucket gate too — and fail on BEHAVIOUR:
   measured 2026-09-03, 24 failed logins from one NAT address 429'd
   /api/recover for everyone behind it, and 24 malformed bodies burned 24
   login attempts. `at` in every answer says which piece of the gate spoke. */
group('Y1 — a rider\'s fat-fingered logins do not take /api/recover away from everyone behind their NAT (server-017)');

const rkOpen = 'function rateOk(key, max, windowMs) {';
const rkAt = SRC.indexOf(rkOpen);
const rkEnd = rkAt >= 0 ? SRC.indexOf('\n}\n', rkAt) + 3 : -1;
const rateOkSrc = (rkAt >= 0 && rkEnd > rkAt) ? SRC.slice(rkAt, rkEnd) : '';
ok('rateOk() can be lifted (found once, non-trivial)', rateOkSrc.length > 100 && SRC.indexOf(rkOpen, rkAt + 1) === -1, 'len=' + rateOkSrc.length);

// The table: module-scope ANON_AUTH_BUDGET … AUTH_FLOOD_MAX after the fix; the
// bare ANON_AUTH_ROUTES array literal inside handleApi() before it.
const handleApiAt = SRC.indexOf('async function handleApi(');
let tableAt = SRC.indexOf('const ANON_AUTH_BUDGET = ');
let tableEnd = -1;
if (tableAt >= 0) {
  const fm = SRC.indexOf('const AUTH_FLOOD_MAX = ', tableAt);
  tableEnd = fm >= 0 ? SRC.indexOf('\n', fm) : -1;
} else {
  tableAt = SRC.indexOf('const ANON_AUTH_ROUTES = [');
  tableEnd = tableAt >= 0 ? SRC.indexOf('];', tableAt) + 2 : -1;
}
const tableSrc = (tableAt >= 0 && tableEnd > tableAt) ? SRC.slice(tableAt, tableEnd) : '';
const floodOpen = 'if (ANON_AUTH_ROUTES.indexOf(urlPath) >= 0 && !rateOk(';
const floodAt = SRC.indexOf(floodOpen);
const floodEnd = floodAt >= 0 ? SRC.indexOf('\n  }\n', floodAt) + 4 : -1;
const floodSrc = (floodAt >= 0 && floodEnd > floodAt) ? SRC.slice(floodAt, floodEnd) : '';
const readBodyAt = floodAt >= 0 ? SRC.indexOf('readBody(req, res, async (body) => {', floodAt) : -1;
const bodyNullAt = readBodyAt >= 0 ? SRC.indexOf('if (body == null) return json(res, 400', readBodyAt) : -1;
const attemptEnd = bodyNullAt >= 0 ? SRC.indexOf('\n    try {', bodyNullAt) : -1;
const attemptSrc = (bodyNullAt >= 0 && attemptEnd > bodyNullAt) ? SRC.slice(bodyNullAt, attemptEnd) : '';
ok('the gate can be lifted in three pieces: the route table, the pre-body check (found once), and the head of the readBody() callback',
  tableSrc.length > 0 && floodSrc.length > 0 && attemptSrc.length > 0 && SRC.indexOf(floodOpen, floodAt + 1) === -1,
  'table=' + tableSrc.length + ' flood=' + floodSrc.length + ' attempt=' + attemptSrc.length);

// What the table says, evaluated — never re-typed. Missing names read as null
// so the checks below fail with a reason instead of a ReferenceError.
function evalTable(src) {
  try {
    return new Function(src + '\nreturn { routes: ANON_AUTH_ROUTES.slice(),' +
      ' budget: typeof ANON_AUTH_BUDGET === "undefined" ? null : Object.assign({}, ANON_AUTH_BUDGET),' +
      ' floodMax: typeof AUTH_FLOOD_MAX === "undefined" ? null : AUTH_FLOOD_MAX };')();
  } catch (e) { return { routes: [], budget: null, floodMax: null, err: e.message }; }
}
const OVERSIZED = { oversized: true };   // readBody's data handler answers 413 itself and never calls back
const AUTH_429 = { error: 'Too many attempts — wait a few minutes' };
// A fake handleApi(): the three lifted pieces in the order the server runs
// them, around a scripted readBody(). `over` swaps a piece for the mutation guard.
function authWorld(over) {
  over = over || {};
  const hits = new Map();
  const rateOk = new Function('authHits', rateOkSrc + '\nreturn rateOk;')(hits);
  const entered = { count: 0 };
  const src = (over.table || tableSrc) + '\n' +
    'return function handle(ip, urlPath, body) {\n' +
    '  let at = "flood"; const res = {};\n' +
    '  const json = (r, code, obj) => ({ code: code, body: obj, at: at });\n' +
    '  ' + (over.flood || floodSrc) + '\n' +
    '  at = "readBody"; entered.count++;\n' +
    '  if (body === OVERSIZED) return { code: 413, body: { error: "Request too large" }, at: at };\n' +
    '  at = "attempt";\n' +
    '  ' + (over.attempt || attemptSrc) + '\n' +
    '  at = "handler";\n' +
    '  return { code: 200, body: { ok: true }, at: at };\n' +
    '};';
  const handle = new Function('rateOk', 'RATE_WINDOW', 'OVERSIZED', 'entered', src)(rateOk, 10 * 60 * 1000, OVERSIZED, entered);
  return {
    hits: hits, handle: handle, entered: entered, api: evalTable(over.table || tableSrc),
    times: (n, ip, route, body) => { const out = []; for (let i = 0; i < n; i++) out.push(handle(ip, route, body)); return out; },
    bucket: (k) => (hits.get(k) || []).length
  };
}

if (rateOkSrc && tableSrc && floodSrc && attemptSrc) {
  const NAT = '203.0.113.7', OTHER = '198.51.100.9';
  const LOGIN = { identifier: 'alice', password: 'wrong' };

  // (a) — the self-DoS. 24 wrong passwords from one carrier-NAT address.
  const w = authWorld();
  const logins = w.times(24, NAT, '/api/login', LOGIN);
  const rec = w.handle(NAT, '/api/recover', { username: 'alice', code: 'x', password: 'y' });
  ok('executed (a): 24 failed /api/login from one NAT address all reach the handler (the 24th is still allowed)',
    logins.every((r) => r.code === 200 && r.at === 'handler'), 'codes=' + logins.map((r) => r.code).join(','));
  ok('executed (a): …and /api/recover from the SAME address is still answerable — the route the locked-out rider needs next',
    rec.code === 200 && rec.at === 'handler', 'recover → ' + JSON.stringify(rec));
  const login25 = w.handle(NAT, '/api/login', LOGIN);
  ok('executed: the 25th /api/login from that address is refused with the rider-visible 429 copy — the per-route budget binds',
    login25.code === 429 && JSON.stringify(login25.body) === JSON.stringify(AUTH_429), JSON.stringify(login25));

  // (b1) — a malformed body. readBody() calls back with undefined → 400.
  const wm = authWorld();
  const bad = wm.times(24, NAT, '/api/login', null);
  const goodAfterBad = wm.handle(NAT, '/api/login', LOGIN);
  ok('executed (b1): 24 malformed bodies each 400 — and the 25th, well-formed login still reaches the handler: a parse error costs no attempt',
    bad.every((r) => r.code === 400) && goodAfterBad.code === 200 && goodAfterBad.at === 'handler',
    '400s=' + bad.filter((r) => r.code === 400).length + ' then ' + JSON.stringify(goodAfterBad));
  ok('executed (b1): the malformed bodies charged the flood tier only — authflood:<ip> holds 25, auth:/api/login:<ip> holds exactly the one real attempt',
    wm.bucket('authflood:' + NAT) === 25 && wm.bucket('auth:/api/login:' + NAT) === 1,
    'buckets: ' + [...wm.hits.keys()].map((k) => k + '=' + wm.bucket(k)).join(' '));

  // (b2) — an oversized body. readBody() 413s in its data handler and never calls back.
  const wo = authWorld();
  const big = wo.times(24, NAT, '/api/login', OVERSIZED);
  const goodAfterBig = wo.handle(NAT, '/api/login', LOGIN);
  ok('executed (b2): 24 oversized bodies each 413 inside readBody (never calling back) — and the 25th, well-formed login still reaches the handler',
    big.every((r) => r.code === 413 && r.at === 'readBody') && goodAfterBig.code === 200 && goodAfterBig.at === 'handler',
    '413s=' + big.filter((r) => r.code === 413).length + ' then ' + JSON.stringify(goodAfterBig));
  ok('executed (b2): the attempt bucket was never reached by an oversized body — auth:/api/login:<ip> holds exactly the one real attempt',
    wo.bucket('auth:/api/login:' + NAT) === 1, 'buckets: ' + [...wo.hits.keys()].map((k) => k + '=' + wo.bucket(k)).join(' '));

  // per-route independence
  const wr = authWorld();
  wr.times(25, NAT, '/api/login', LOGIN);
  const others = wr.api.routes.filter((r) => r !== '/api/login').map((r) => [r, wr.handle(NAT, r, { any: 1 }).code]);
  ok('executed: with /api/login exhausted, every other anonymous credential route from the same address is still answerable (' + others.length + ' routes)',
    others.length === wr.api.routes.length - 1 && others.length >= 10 && others.every((x) => x[1] === 200), JSON.stringify(others));

  // per-IP isolation (passes today; must keep passing)
  const otherLogin = wr.handle(OTHER, '/api/login', LOGIN);
  ok('executed: per-IP isolation is preserved — a different address\'s /api/login is untouched by the exhausted one',
    otherLogin.code === 200 && otherLogin.at === 'handler', JSON.stringify(otherLogin));

  // the flood tier still fronts the body read
  const wf = authWorld();
  const floodMax = wf.api.floodMax;
  if (typeof floodMax === 'number') {
    const spread = wf.api.routes;
    for (let i = 0; i < floodMax; i++) wf.handle(NAT, spread[i % spread.length], null);   // malformed → flood tier only
    const before = wf.entered.count;
    const next = wf.handle(NAT, '/api/register', { username: 'x', password: 'y' });
    ok('executed: AUTH_FLOOD_MAX (' + floodMax + ') requests from one address, then the next is refused BEFORE readBody is entered — a flooder still cannot make this process read bodies',
      next.code === 429 && next.at === 'flood' && wf.entered.count === before && JSON.stringify(next.body) === JSON.stringify(AUTH_429),
      JSON.stringify(next) + ' entered ' + before + '→' + wf.entered.count);
  } else {
    ok('executed: AUTH_FLOOD_MAX requests from one address, then the next is refused BEFORE readBody is entered', false,
      'AUTH_FLOOD_MAX is not defined — there is no flood tier');
  }

  // routes absent from the table are ungated by either tier — exactly as today
  const wt = authWorld();
  const free = wt.times(300, NAT, '/api/telemetry', { kind: 'x' }).concat(wt.times(60, NAT, '/api/ota', { platform: 'android' }));
  ok('executed: routes absent from the table (/api/telemetry ×300, /api/ota ×60 from one address) are ungated by either tier and mint no auth bucket',
    free.every((r) => r.code === 200 && r.at === 'handler') && wt.hits.size === 0,
    'codes=' + [...new Set(free.map((r) => r.code))].join(',') + ' buckets=' + wt.hits.size);

  // The mutation guard: the same harness with the shipped single-bucket gate
  // pasted back in must reproduce both halves of server-017. If this stops
  // failing, the (a)/(b) checks above have stopped detecting anything.
  const OLD_GATE = "if (ANON_AUTH_ROUTES.indexOf(urlPath) >= 0 && !rateOk('auth:' + ip, 24, RATE_WINDOW)) {\n" +
    "    return json(res, 429, { error: 'Too many attempts — wait a few minutes' });\n  }";
  const OLD_HEAD = "if (body == null) return json(res, 400, { error: 'Bad request' });";
  const wg = authWorld({ flood: OLD_GATE, attempt: OLD_HEAD });
  wg.times(24, NAT, '/api/login', LOGIN);
  const recOld = wg.handle(NAT, '/api/recover', { username: 'alice' });
  const wg2 = authWorld({ flood: OLD_GATE, attempt: OLD_HEAD });
  wg2.times(24, NAT, '/api/login', null);
  const loginOld = wg2.handle(NAT, '/api/login', LOGIN);
  ok('mutation guard: the same harness with the old single-bucket gate pasted back in 429s /api/recover after 24 logins AND 429s a real login after 24 malformed bodies — so (a) and (b) are a real detector',
    recOld.code === 429 && recOld.at === 'flood' && loginOld.code === 429 && loginOld.at === 'flood',
    'recover → ' + JSON.stringify(recOld) + ' login-after-malformed → ' + JSON.stringify(loginOld));
}

// Structural pins — cheap, and the second of them is the one that keeps the
// self-DoS from being re-created by nudging a number six months from now.
const api = evalTable(tableSrc);
const budgetSum = api.budget ? Object.keys(api.budget).reduce((s, k) => s + api.budget[k], 0) : NaN;
ok('AUTH_FLOOD_MAX >= the sum of every per-route attempt budget (' + api.floodMax + ' >= ' + budgetSum + ') — the flood tier can only bind on traffic that never produced a well-formed body',
  typeof api.floodMax === 'number' && !!api.budget && api.floodMax >= budgetSum, api.err || ('floodMax=' + api.floodMax + ' sum=' + budgetSum));
ok('every per-route budget is a positive integer, and the table is prototype-less (a URL path is the key)',
  !!api.budget && Object.keys(api.budget).every((k) => Number.isInteger(api.budget[k]) && api.budget[k] > 0) &&
  /const ANON_AUTH_BUDGET = Object\.assign\(Object\.create\(null\), \{/.test(tableSrc), api.err || tableSrc.slice(0, 60));
ok('ANON_AUTH_ROUTES is DERIVED — Object.keys(ANON_AUTH_BUDGET) — so the gated list and the budget table cannot drift apart',
  /^const ANON_AUTH_ROUTES = Object\.keys\(ANON_AUTH_BUDGET\);/m.test(SRC));
const ROUTES_TODAY = ['/api/register', '/api/login', '/api/recover', '/api/forgot', '/api/reset', '/api/magic', '/api/magic/consume',
  '/api/email/verify', '/api/email/change/confirm', '/api/oauth/start', '/api/oauth/callback'].sort();
ok('the gated routes are exactly today\'s eleven — no anonymous credential route dropped out of the gate, none smuggled in',
  JSON.stringify(api.routes.slice().sort()) === JSON.stringify(ROUTES_TODAY), JSON.stringify(api.routes));
ok('the table lives at module scope (before handleApi), not rebuilt per request',
  tableAt >= 0 && handleApiAt > 0 && tableAt < handleApiAt, 'table@' + tableAt + ' handleApi@' + handleApiAt);
ok('ordering: the flood charge sits inside handleApi() and BEFORE readBody( — the pre-body property is intact',
  floodAt > handleApiAt && readBodyAt > floodAt, 'handleApi@' + handleApiAt + ' flood@' + floodAt + ' readBody@' + readBodyAt);
const attemptAt = readBodyAt >= 0 ? SRC.indexOf("rateOk('auth:' + urlPath + ':' + ip", readBodyAt) : -1;
const firstRouteAt = readBodyAt >= 0 ? SRC.indexOf("if (urlPath === '/api/", readBodyAt) : -1;
ok('ordering: the attempt charge is the first thing after the `body == null` 400 and before the first route branch inside the callback',
  attemptAt > bodyNullAt && bodyNullAt > 0 && attemptAt < firstRouteAt, 'bodyNull@' + bodyNullAt + ' attempt@' + attemptAt + ' firstRoute@' + firstRouteAt);
ok('the old shared key is gone: no `rateOk(\'auth:\' + ip` anywhere — every auth bucket now names its route or its tier',
  !/rateOk\('auth:' \+ ip\b/.test(SRC));
ok('the four per-identity buckets are untouched: login:<ident> 10, recover:<name> 10, forgot:<address> 5, magic:<address> 5 — the tight, outcome-aware control',
  /rateOk\('login:' \+ ident, 10, RATE_WINDOW\)/.test(SRC) && /rateOk\('recover:' \+ rname, 10, RATE_WINDOW\)/.test(SRC) &&
  /rateOk\('forgot:' \+ address, 5, RATE_WINDOW\)/.test(SRC) && /rateOk\('magic:' \+ address, 5, RATE_WINDOW\)/.test(SRC));
const copy429 = "{ error: 'Too many attempts — wait a few minutes' }";
ok('both tiers answer with exactly the rider-visible copy the old gate used — ' + copy429 + ' — twice, unchanged on purpose',
  (floodSrc + attemptSrc).split(copy429).length - 1 === 2, 'occurrences=' + ((floodSrc + attemptSrc).split(copy429).length - 1));
ok('RATE_WINDOW is still 10 * 60 * 1000 and both tiers use it',
  /^const RATE_WINDOW = 10 \* 60 \* 1000;$/m.test(SRC) &&
  /rateOk\('authflood:' \+ ip, AUTH_FLOOD_MAX, RATE_WINDOW\)/.test(floodSrc) &&
  /rateOk\('auth:' \+ urlPath \+ ':' \+ ip, attempts, RATE_WINDOW\)/.test(attemptSrc));

process.exit(report());
