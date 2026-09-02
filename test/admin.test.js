/* Convoy — admin control panel + kill switches + Play publishing.

   The panel can change any account, take the whole app down, and publish to
   Google. Three of those are irreversible in the ways that matter, so this
   suite concentrates on the guards rather than the rendering:

     · server/flags.js  — the master switch and the atomic panic/restore
                          writes, driven against a temp DATA_DIR (the store.js
                          require.cache stub the telemetry and OTA suites use).
     · server/admin.js  — session forgery, expiry, cross-origin POSTs, HTML
                          escaping, and the artifact path resolver. Every one
                          of these is a way in, not a cosmetic detail.
     · server/play.js   — the status/userFraction contract that Play enforces
                          with cryptic 400s, and the edit transaction, driven
                          against a stubbed fetch so the whole publish flow is
                          exercised without a Google account. The JWT is signed
                          with a REAL generated RSA key and verified here, so
                          "the assertion is well-formed" is proven, not assumed.
     · server.js wiring — policy assertions on the source (the serverpolicy
                          pattern), because a kill switch that isn't mounted is
                          the most expensive kind of dead code.

   What can only be proven against Google — that a real service account is
   accepted, that a real .aab uploads — is the pre-launch drill in DEPLOY.md,
   not this file.

   Run:  node test/admin.test.js  */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { group, ok, report } = require('./harness');

/* ---- temp DATA_DIR, injected before any module captures store.DATA_DIR ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-admin-'));
{
  const STORE_PATH = require.resolve('../server/store.js');
  require.cache[STORE_PATH] = {
    id: STORE_PATH, filename: STORE_PATH, loaded: true, children: [], paths: [],
    exports: { DATA_DIR: TMP, count: () => 0, pendingAuthDeletions: () => 0 }
  };
}

/* ---- a real service-account key, so the JWT path is genuinely exercised ---- */
const KEYPAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_FILE = path.join(TMP, 'play-key.json');
fs.writeFileSync(KEY_FILE, JSON.stringify({
  type: 'service_account',
  client_email: 'convoy-publisher@example.iam.gserviceaccount.com',
  private_key: KEYPAIR.privateKey.export({ type: 'pkcs8', format: 'pem' })
}));
process.env.PLAY_SERVICE_ACCOUNT_JSON = KEY_FILE;
process.env.PLAY_PACKAGE = 'tech.odoreeci.convoy';
process.env.PLAY_ARTIFACT_DIR = path.join(TMP, 'releases');
fs.mkdirSync(process.env.PLAY_ARTIFACT_DIR, { recursive: true });

const flags = require('../server/flags.js');
const play = require('../server/play.js');
const admin = require('../server/admin.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

/* ================================================================== */
group('flags — the master switch');

flags.init();

ok('`app` is a known flag',
  flags.KNOWN.includes('app'), 'got ' + JSON.stringify(flags.KNOWN));
ok('`app` is named as the master, not hardcoded at call sites',
  flags.MASTER === 'app', 'got ' + flags.MASTER);
ok('`app` sorts first, so the panel renders it above the features',
  flags.KNOWN[0] === 'app', 'got ' + flags.KNOWN[0]);

// Nothing forced yet: the env default must flow through untouched.
flags.restore();
ok('with no override, pick() returns the env default (on)', flags.pick('app', true) === true);
ok('with no override, pick() returns the env default (off)', flags.pick('routing', false) === false);

/* ---- panic ---- */
const changed = flags.panic();
ok('panic() reports every flag it changed',
  changed.length === flags.KNOWN.length,
  'changed ' + changed.length + ' of ' + flags.KNOWN.length);
ok('panic() kills the master switch',
  flags.pick('app', true) === false, 'app survived the panic');
ok('panic() overrides even a TRUE env default',
  flags.KNOWN.every((f) => flags.pick(f, true) === false),
  'a flag stayed on: ' + flags.KNOWN.filter((f) => flags.pick(f, true) !== false).join(', '));

// The atomicity claim is the whole reason panic() exists as one call: read the
// file back and assert every flag landed in the SAME write.
{
  const onDisk = JSON.parse(fs.readFileSync(flags._FLAGS_FILE, 'utf8'));
  ok('panic() lands every flag in one file, not one write per flag',
    flags.KNOWN.every((f) => onDisk[f] === false),
    'file holds ' + JSON.stringify(onDisk));
}

ok('panic() is idempotent — a second press changes nothing',
  flags.panic().length === 0);

/* ---- restore ---- */
{
  const cleared = flags.restore();
  ok('restore() reports what it cleared', cleared.length === flags.KNOWN.length,
    'cleared ' + cleared.length);
  ok('restore() brings the app back', flags.pick('app', true) === true);
  ok('restore() does NOT force features on — a keyless feature stays off',
    flags.pick('routing', false) === false,
    'routing was forced on despite having no API key: it would 500 for every rider');
  ok('restore() leaves no overrides behind',
    Object.keys(flags.readOverrides()).length === 0,
    'left ' + JSON.stringify(flags.readOverrides()));
}

/* ---- board ---- */
{
  flags.setOverride('waze', false);
  const board = flags.board({ app: true, routing: true, waze: true });
  const waze = board.find((f) => f.name === 'waze');
  const routing = board.find((f) => f.name === 'routing');
  ok('board separates "off because an operator did it" from the env default',
    waze.env === true && waze.forced === false && waze.effective === false,
    JSON.stringify(waze));
  ok('board leaves an un-overridden flag at its env default',
    routing.forced === null && routing.effective === true, JSON.stringify(routing));
  ok('board covers every known flag', board.length === flags.KNOWN.length);
  flags.restore();
}

ok('an unknown flag is refused rather than silently written',
  (() => { try { flags.setOverride('nope', false); return false; } catch (e) { return true; } })());
ok('a non-boolean flag value is refused',
  (() => { try { flags.setOverride('app', 'off'); return false; } catch (e) { return true; } })());

/* ================================================================== */
group('admin — sessions cannot be forged');

admin._setEnvForTest('a-long-test-admin-secret-0123456789', []);

const good = admin._signSession('admin');
const reqWith = (cookie, extra) => Object.assign({ headers: cookie ? { cookie: 'cvad=' + cookie } : {} }, extra || {});

ok('a freshly signed session round-trips to its actor',
  admin._sessionActor(reqWith(good)) === 'admin');
ok('no cookie is no session', admin._sessionActor(reqWith(null)) === null);
ok('a tampered payload is rejected',
  admin._sessionActor(reqWith('x' + good)) === null);
ok('a tampered signature is rejected',
  admin._sessionActor(reqWith(good.slice(0, -2) + (good.slice(-2) === 'aa' ? 'bb' : 'aa'))) === null);
ok('an unsigned payload is rejected',
  admin._sessionActor(reqWith(Buffer.from(JSON.stringify({ a: 'admin', e: Date.now() + 1e6 })).toString('base64url') + '.')) === null);
ok('garbage is rejected without throwing',
  admin._sessionActor(reqWith('not-a-session')) === null);

// Expiry is checked from the payload, so a valid signature over a stale
// timestamp must still fail — otherwise a leaked cookie is forever.
{
  const payload = Buffer.from(JSON.stringify({ a: 'admin', e: Date.now() - 1000 })).toString('base64url');
  const key = crypto.createHash('sha256').update('a-long-test-admin-secret-0123456789:cvad-session').digest();
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  ok('a correctly signed but EXPIRED session is rejected',
    admin._sessionActor(reqWith(payload + '.' + sig)) === null);
}

// Rotating the secret must invalidate every outstanding session: that is the
// only revocation a stateless cookie has.
{
  const before = admin._signSession('admin');
  admin._setEnvForTest('a-different-secret-9876543210abcdef', []);
  ok('rotating ADMIN_TOKEN invalidates every existing session',
    admin._sessionActor(reqWith(before)) === null);
  admin._setEnvForTest('a-long-test-admin-secret-0123456789', []);
}

/* ================================================================== */
group('admin — the panel refuses to exist without a secret');

admin._setEnvForTest('', []);
ok('no ADMIN_TOKEN ⇒ /admin is not handled at all (falls through to a 404)',
  admin.handles('/admin') === false && admin.handles('/admin/home') === false);
admin._setEnvForTest('a-long-test-admin-secret-0123456789', []);
ok('with a secret, /admin and its subtree are handled',
  admin.handles('/admin') === true && admin.handles('/admin/flags') === true);
ok('a path that merely starts with the letters "admin" is not the panel',
  admin.handles('/administrator') === false && admin.handles('/adminfoo') === false);

/* ================================================================== */
group('admin — cross-origin POSTs are blocked');

ok('a same-origin https POST is allowed',
  admin._originOk({ headers: { origin: 'https://odoreeci.tech', host: 'odoreeci.tech' } }) === true);
ok('a foreign origin is refused',
  admin._originOk({ headers: { origin: 'https://evil.example', host: 'odoreeci.tech' } }) === false);
ok('an origin that merely contains the host is refused',
  admin._originOk({ headers: { origin: 'https://odoreeci.tech.evil.example', host: 'odoreeci.tech' } }) === false);
ok('no Origin header (curl, the native app) is allowed',
  admin._originOk({ headers: { host: 'odoreeci.tech' } }) === true);
/* A browser sends the literal string "null" when it has an origin but declines
   to name it. Refusing that is what broke every kill switch: the app-wide
   Referrer-Policy: no-referrer makes a form POST serialize its Origin as
   "null", so the panel refused its own forms. It is not a CSRF vector —
   SameSite=Strict means no such request can carry the cvad cookie. */
ok('a serialized-away "null" origin is allowed, not treated as foreign',
  admin._originOk({ headers: { origin: 'null', host: 'odoreeci.tech' } }) === true);

/* ================================================================== */
group('admin — every rendered value is escaped');

ok('esc() neutralises a script tag',
  admin._esc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
ok('esc() closes an attribute break-out',
  admin._esc('" onmouseover="x') === '&quot; onmouseover=&quot;x');
ok('esc() handles single quotes (attribute values use them too)',
  admin._esc("' onload='x") === '&#39; onload=&#39;x');
ok('esc() renders null/undefined as empty, not "null"',
  admin._esc(null) === '' && admin._esc(undefined) === '');

/* A username is attacker-chosen and is rendered into the account page in half
   a dozen places, so pin the whole round trip rather than esc() alone. */
ok('an attacker-chosen username cannot break out of the page',
  admin._esc('<img src=x onerror=alert(1)>').indexOf('<') === -1);

/* ================================================================== */
group('admin — the Play artifact picker cannot escape its directory');

fs.writeFileSync(path.join(process.env.PLAY_ARTIFACT_DIR, 'convoy-1.0.109.aab'), 'x'.repeat(500));
fs.writeFileSync(path.join(process.env.PLAY_ARTIFACT_DIR, 'convoy-old.apk'), 'x'.repeat(400));
fs.writeFileSync(path.join(process.env.PLAY_ARTIFACT_DIR, 'notes.txt'), 'ignore me');
fs.writeFileSync(path.join(process.env.PLAY_ARTIFACT_DIR, 'empty.aab'), '');

{
  const arts = admin._listArtifacts().map((a) => a.name);
  ok('lists .aab and .apk artifacts',
    arts.includes('convoy-1.0.109.aab') && arts.includes('convoy-old.apk'), JSON.stringify(arts));
  ok('ignores files that are not artifacts', !arts.includes('notes.txt'), JSON.stringify(arts));
  ok('ignores a zero-byte artifact (an interrupted upload is not a release)',
    !arts.includes('empty.aab'), JSON.stringify(arts));
}

for (const bad of ['../../../etc/passwd', '..\\..\\server\\.env', '/etc/passwd',
                   'a/b.aab', 'a\\b.aab', 'convoy.aab\0.txt', '']) {
  ok('rejects ' + JSON.stringify(bad), admin._artifactPath(bad) === null);
}
ok('accepts a plain artifact name',
  admin._artifactPath('convoy-1.0.109.aab') !== null);
ok('a non-artifact extension is rejected even inside the directory',
  admin._artifactPath('notes.txt') === null);

/* ================================================================== */
group('admin — every route is authenticated and every POST has a handler');

{
  const routes = admin._routes;
  const gets = routes.filter((r) => r[0] === 'GET').map((r) => String(r[1]));
  const posts = routes.filter((r) => r[0] === 'POST').map((r) => String(r[1]));
  ok('the kill switch, Play and the flags board all have pages',
    gets.some((r) => /flags/.test(r)) && gets.some((r) => /play/.test(r)) &&
    gets.some((r) => /ota/.test(r)));
  ok('panic and restore are POST-only (a GET kill switch is one prefetch away from an outage)',
    posts.some((r) => /panic/.test(r)) && posts.some((r) => /restore/.test(r)) &&
    !gets.some((r) => /panic|restore/.test(r)));
  ok('every Play move has a POST route',
    ['upload', 'promote', 'rollout', 'halt', 'resume']
      .every((a) => posts.some((r) => new RegExp('play.*' + a).test(r))),
    JSON.stringify(posts));
  ok('every route has a function handler',
    routes.every((r) => typeof r[2] === 'function'));
  // The account id group is what stops /admin/account/../../ from resolving.
  // (Filtered on "account\/" so the /admin/accounts SEARCH page — which takes
  // no id — isn't swept in.)
  {
    const byId = routes.filter((r) => /account\\\//.test(String(r[1])));
    ok('there are per-account routes to check at all', byId.length >= 10, 'found ' + byId.length);
    ok('every per-account route only accepts a uuid-shaped id',
      byId.every((r) => /\[0-9a-f-\]\{36\}/.test(String(r[1]))),
      byId.filter((r) => !/\[0-9a-f-\]\{36\}/.test(String(r[1]))).map((r) => String(r[1])).join(', '));
  }
}

/* ================================================================== */
group('map — status is resolved on the SERVER, once');

/* The map draws what the server tells it. That is the whole reason the status
   rules live in adminmap.js rather than in the browser: the dots and the
   roster table are rendered by different code paths, and if each decided
   "stale" for itself they would eventually disagree — which is worse than
   either being wrong, because you cannot tell which to believe. */
{
  const amap = admin._amap;
  const base = { id: 'a', username: 'Rae', pos: [1, 2], ageMs: 0, mode: 'cruise', racing: false };
  const with_ = (o) => Object.assign({}, base, o);

  const p = amap.payload([
    with_({}),
    with_({ id: 'b', username: 'Ari', ghost: true, mode: 'parked' }),
    with_({ id: 'c', username: 'Bot', bot: true }),
    with_({ id: 'd', username: 'NoFix', pos: null, ageMs: null })
  ]);
  ok('payload carries a resolved status, label and colour per rider',
    p.every((r) => r.status && r.label && /^#/.test(r.color)), JSON.stringify(p[0]));
  ok('ghost survives into the payload as a flag, not a status',
    p[1].ghost === true && p[1].status === 'parked',
    'ghost must not swallow what the rider is actually doing');
  ok('bots are flagged so the map can draw them hollow', p[2].bot === true);
  ok('a rider with no fix still appears (the table needs them)',
    p[3].status === 'nofix' && p[3].pos === null);
  ok('a human-readable age rides along', typeof p[0].age === 'string');

  /* The payload feeds a browser. It must carry what the map needs and nothing
     more — an IP or a profile leaking into a polled JSON endpoint is a much
     bigger surface than the same data rendered once into a page. */
  const keys = Object.keys(p[0]).sort().join(',');
  ok('payload does NOT leak the rider IP',
    keys.indexOf('ip') < 0, 'keys: ' + keys);
  ok('payload does NOT leak the profile blob',
    keys.indexOf('profile') < 0, 'keys: ' + keys);
}

/* ================================================================== */
group('map — the client bootstrap');

{
  const amap = admin._amap;

  ok('MapLibre is pinned to the exact build index.html loads',
    /maplibre-gl@5\.24\.0/.test(amap.MAPLIBRE_JS) && /maplibre-gl@5\.24\.0/.test(amap.MAPLIBRE_CSS),
    amap.MAPLIBRE_JS);
  ok('the basemap is the app\'s dark style, not a lookalike',
    amap.MAP_STYLE === 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    amap.MAP_STYLE);

  // Both hosts must already be in the boot CSP, or the panel silently renders
  // a blank box in production and nowhere else.
  ok('every host the map needs is allowed by the boot CSP',
    /script-src[^;]*cdn\.jsdelivr\.net/.test(SERVER_SRC) &&
    /img-src[^;]*https:/.test(SERVER_SRC) &&
    /connect-src[^;]*https:/.test(SERVER_SRC) &&
    /worker-src[^;]*blob:/.test(SERVER_SRC),
    'MapLibre needs jsDelivr for script, https for tiles, and blob: workers');

  ok('the bootstrap applies the app\'s globe projection',
    /setProjection\(\{ type: 'globe' \}\)/.test(amap.MAP_JS));
  ok('...and the app\'s atmosphere fade to zoom 7',
    /atmosphere-blend[\s\S]{0,80}7, 0/.test(amap.MAP_JS));
  ok('the bootstrap re-applies the globe on style.load, as the app does',
    /on\('style\.load', applyGlobe\)/.test(amap.MAP_JS),
    'setStyle wipes the projection — without this the globe silently flattens');

  ok('markers use the app\'s .m-car / .m-dot element',
    /m-car/.test(amap.MAP_JS) && /m-dot/.test(amap.MAP_JS) && /m-car/.test(amap.MAP_CSS));

  /* css/styles.css carries this warning in capitals: "never set `position` on
     marker roots — it must stay maplibre's .maplibregl-marker{position:absolute}
     or every car renders offset." We set position:relative on .m-car and got
     exactly that: every rider piled into the top-left corner, and the ghost
     ring's inset:-9px resolved against the map container instead of the dot,
     painting a dashed box across the whole map. Pin both halves. */
  ok('.m-car does NOT set position — MapLibre owns the marker root',
    !/\.m-car\{[^}]*position\s*:/.test(amap.MAP_CSS),
    'markers will render offset; see the warning in css/styles.css');
  ok('.m-dot IS positioned, so the ring and tag have an anchor',
    /\.m-dot\{[^}]*position:relative/.test(amap.MAP_CSS));
  ok('the ghost ring is appended to the DOT, not the marker root',
    /dot\.appendChild\(ring\)/.test(amap.MAP_JS),
    'appending to the root makes inset:-9px resolve against the map container');
  ok('the name tag is appended to the DOT, not the marker root',
    /dot\.appendChild\(tag\)/.test(amap.MAP_JS));
  ok('the poll sends the session cookie',
    /credentials: 'same-origin'/.test(amap.MAP_JS));
  ok('a failed poll is swallowed, not thrown at the operator',
    /\.catch\(function \(\) \{/.test(amap.MAP_JS));

  /* The camera belongs to the operator after the first frame. Re-fitting on
     every poll would drag the view away from whatever they were looking at. */
  ok('the map frames everyone ONCE, then leaves the camera alone',
    /if \(bounds && !fitted\)/.test(amap.MAP_JS),
    'a re-fit on every poll makes the page unusable');

  ok('a rider who disconnects has their marker removed',
    /markers\[id\]\.remove\(\)/.test(amap.MAP_JS));

  ok('the bootstrap escapes rider-supplied text before building HTML',
    /function esc\(/.test(amap.MAP_JS) && /replace\(\/\[&<>"'\]\/g/.test(amap.MAP_JS),
    'a username reaches the popup as markup otherwise');
  ok('the rider NAME goes in via textContent, never innerHTML',
    /tag\.textContent = r\.name/.test(amap.MAP_JS),
    'the one place a username lands in the DOM directly');

  ok('the container declares the refresh cadence for the script to read',
    /data-refresh="15"/.test(amap.container(15)));
  ok('a zero cadence means no polling loop',
    /data-refresh="0"/.test(amap.container(0)) && /if \(REFRESH > 0\)/.test(amap.MAP_JS));

  ok('the head block pulls the MapLibre stylesheet',
    /maplibre-gl\.min\.css/.test(amap.head()));
  ok('MapLibre loads BEFORE the bootstrap (its global must exist first)',
    amap.scripts().indexOf('maplibre-gl.min.js') < amap.scripts().indexOf('/admin/map.js'));
  ok('both scripts are deferred so the roster renders first',
    (amap.scripts().match(/defer/g) || []).length === 2);

  /* The panel ships no inline script; that is what makes the CSP tight. The
     bootstrap must be a same-origin FILE, not a <script> body. */
  ok('the bootstrap is served from /admin, not from the rider bundle',
    /src="\/admin\/map\.js"/.test(amap.scripts()),
    'js/ would ship operator tooling inside the APK');
}


/* ================================================================== */
group('map — status: ghost, offline and everything between');

{
  const st = admin._riderStatus;
  const base = { pos: [0, 0], ageMs: 0, mode: 'cruise', racing: false };
  const with_ = (o) => Object.assign({}, base, o);

  ok('a moving rider is cruising', st(base).key === 'cruise');
  ok('a parked rider is parked', st(with_({ mode: 'parked' })).key === 'parked');
  ok('a racing rider outranks parked', st(with_({ mode: 'parked', racing: true })).key === 'racing');
  ok('a connected rider with no fix is "no GPS fix", not offline',
    st(with_({ pos: null })).key === 'nofix',
    'connected-without-a-fix and not-connected are different problems');
  ok('a fix older than the stale window reads stale',
    st(with_({ ageMs: 61 * 1000 })).key === 'stale');
  ok('a fresh fix does not read stale', st(with_({ ageMs: 59 * 1000 })).key === 'cruise');
  ok('stale outranks racing — a stale position is not evidence of a race',
    st(with_({ ageMs: 120000, racing: true })).key === 'stale');

  /* Ghost is a MODIFIER, not a status: a ghosted rider is still cruising or
     parked, and collapsing that into one "ghost" state would hide what they
     are actually doing. */
  ok('ghost does not replace the underlying state',
    st(with_({ ghost: true })).key === 'cruise' &&
    st(with_({ ghost: true, mode: 'parked' })).key === 'parked',
    'ghost swallowed the rider\'s real state');
  ok('every status has a distinct colour',
    new Set(['cruise', 'parked', 'racing', 'nofix', 'stale'].map((k) => {
      const map = { cruise: base, parked: with_({ mode: 'parked' }), racing: with_({ racing: true }),
                    nofix: with_({ pos: null }), stale: with_({ ageMs: 99000 }) };
      return st(map[k]).color;
    })).size === 5);

  ok('ago() reads in human units',
    admin._ago(null) === '—' && admin._ago(500) === 'now' &&
    admin._ago(45000) === '45s' && admin._ago(120000) === '2m' && admin._ago(7200000) === '2h');
}

/* ================================================================== */
group('play — the status/userFraction contract Play enforces');

ok('a full release is "completed" with NO userFraction',
  (() => { const r = play._releaseFor(['4'], 'completed', null); return r.status === 'completed' && r.userFraction === undefined; })(),
  'Play 400s if completed carries a fraction');
ok('a staged rollout carries the fraction, converted from percent',
  (() => { const r = play._releaseFor(['4'], 'inProgress', 5); return r.userFraction === 0.05; })(),
  'got ' + JSON.stringify(play._releaseFor(['4'], 'inProgress', 5)));
ok('20% becomes 0.2', play._releaseFor(['4'], 'inProgress', 20).userFraction === 0.2);
ok('a fractional percent survives (0.5% = 0.005)',
  play._releaseFor(['4'], 'inProgress', 0.5).userFraction === 0.005);
ok('version codes are stringified — Play rejects numbers',
  play._releaseFor([4], 'completed', null).versionCodes.every((v) => typeof v === 'string'));

for (const bad of [0, 100, -5, 101, NaN, null, undefined, 'abc']) {
  ok('a staged rollout refuses ' + JSON.stringify(bad) + '% before spending a round trip',
    (() => { try { play._releaseFor(['4'], 'inProgress', bad); return false; } catch (e) { return true; } })());
}
ok('an unknown status is refused',
  (() => { try { play._releaseFor(['4'], 'live', null); return false; } catch (e) { return true; } })());
ok('release notes are tagged en-US (an undeclared language is rejected upstream)',
  play._releaseFor(['4'], 'completed', null, 'hi').releaseNotes[0].language === 'en-US');
ok('release notes are length-capped',
  play._releaseFor(['4'], 'completed', null, 'x'.repeat(9999)).releaseNotes[0].text.length === 500);

ok('the four Play tracks are known, ordered least → most exposed',
  play.TRACKS.join(',') === 'internal,alpha,beta,production');
ok('an unknown track is refused', play._validTrack('staging') === false);

/* ================================================================== */
group('play — the OAuth assertion is a real, verifiable RS256 JWT');

{
  const jwt = play._signAssertion(1700000000000);
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  ok('header declares RS256', header.alg === 'RS256' && header.typ === 'JWT');
  ok('issuer is the service account', claims.iss === 'convoy-publisher@example.iam.gserviceaccount.com');
  ok('scope is androidpublisher and nothing else',
    claims.scope === 'https://www.googleapis.com/auth/androidpublisher');
  ok('audience is the token endpoint (Google rejects any other aud)',
    claims.aud === 'https://oauth2.googleapis.com/token');
  ok('the assertion is short-lived (1h)', claims.exp - claims.iat === 3600);
  // The real proof: verify the signature with the public half.
  ok('the signature verifies against the service account public key',
    crypto.createVerify('RSA-SHA256').update(h + '.' + c)
      .verify(KEYPAIR.publicKey, Buffer.from(s, 'base64url')));
}

ok('configured() is true with a valid key file', play.configured() === true);

/* ================================================================== */
group('play — the edit transaction, against a stubbed Google');

/* A recording fetch stub. Each test installs a script of responses keyed by
   "METHOD <url-substring>"; anything unscripted fails loudly rather than
   silently returning undefined and passing for the wrong reason. */
const realFetch = global.fetch;
let CALLS = [];
function stubGoogle(script) {
  CALLS = [];
  // Longest fragment first: "/edits" is a substring of "/edits/e1:commit" and
  // of every upload URL, so a naive in-order match would answer the commit
  // with the create-edit response and quietly pass the wrong thing.
  const rules = script.slice().sort((a, b) => b[0].length - a[0].length);
  global.fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    CALLS.push({ method, url: String(url), body: opts && opts.body });
    if (String(url).indexOf('oauth2.googleapis.com') >= 0) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
    }
    for (const [key, val] of rules) {
      const [m, frag] = key.split(' ');
      if (m === method && String(url).indexOf(frag) >= 0) {
        const body = typeof val === 'function' ? val() : val;
        const status = (body && body.__status) || 200;
        return { ok: status < 300, status, json: async () => body };
      }
    }
    throw new Error('unscripted call: ' + method + ' ' + url);
  };
}
function restoreFetch() { global.fetch = realFetch; }
function calls(method, frag) {
  return CALLS.filter((c) => c.method === method && c.url.indexOf(frag) >= 0);
}

(async () => {
  /* ================================================================== */
  group('admin — dispatch: the sign-in page must be reachable');

  /* Regression: loginPage was NOT exempt from the "no session ⇒ redirect to
     /admin" branch, and /admin IS loginPage — so every browser hitting the
     panel got an infinite redirect and nobody could ever sign in. The panel
     was unusable and every unit test still passed, because signSession() and
     the route table were both perfectly fine in isolation. Pin the dispatch. */
  function mockRes() {
    const r = { status: 0, headers: {}, body: '', ended: false };
    r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.end = (b) => { r.body = b || ''; r.ended = true; };
    return r;
  }
  const mockReq = (method, url, cookie) => ({
    method, url, headers: cookie ? { cookie: 'cvad=' + cookie } : {},
    on: (ev, fn) => { if (ev === 'end') fn(); }
  });

  {
    const res = mockRes();
    await admin.handle(mockReq('GET', '/admin', null), res, '/admin', '1.2.3.4');
    ok('GET /admin with NO session renders the login form (200), never a redirect',
      res.status === 200 && /Convoy control panel/.test(res.body),
      'status ' + res.status + ' → ' + (res.headers.Location || '(no location)') +
      ' — an infinite redirect loop means nobody can sign in');
    ok('the login page carries no inline script (the CSP forbids it)',
      !/<script/i.test(res.body));
    /* server.js sets Referrer-Policy: no-referrer on every response, and that
       policy also strips the Origin off a form POST (it arrives as "null").
       The panel must override it, or its own forms look cross-origin. */
    ok('the panel overrides the app-wide referrer policy to same-origin',
      res.headers['Referrer-Policy'] === 'same-origin',
      'got ' + JSON.stringify(res.headers['Referrer-Policy']));
  }
  {
    /* The end-to-end shape of the bug: a signed-in operator clicking "off" on
       the flags board, with the Origin the browser actually sends. */
    const sess = admin._signSession('admin');
    const body = 'name=routing&value=off';
    const res = mockRes();
    await admin.handle({
      method: 'POST', url: '/admin/flags/set',
      headers: { cookie: 'cvad=' + sess, origin: 'null', host: 'odoreeci.tech' },
      on: (ev, fn) => { if (ev === 'data') fn(body); if (ev === 'end') fn(); }
    }, res, '/admin/flags/set', '1.2.3.4');
    ok('a kill switch POST is NOT refused as cross-origin',
      res.status !== 403 && !/Cross-origin form post blocked/.test(res.body),
      'status ' + res.status + ' — the panel refused its own form');
    ok('...and the flag actually flipped off',
      flags.pick('routing', true) === false);
    flags.setOverride('routing', null);
  }
  {
    // …and a signed-in operator is still bounced on to the dashboard.
    const res = mockRes();
    await admin.handle(mockReq('GET', '/admin', admin._signSession('admin')), res, '/admin', '1.2.3.4');
    ok('GET /admin WITH a session redirects to the dashboard',
      res.status === 303 && res.headers.Location === '/admin/home',
      'status ' + res.status);
  }
  {
    // Every other page must still bounce an anonymous visitor to the login.
    const res = mockRes();
    await admin.handle(mockReq('GET', '/admin/flags', null), res, '/admin/flags', '1.2.3.4');
    ok('GET /admin/flags with no session redirects to the login page',
      res.status === 303 && res.headers.Location === '/admin');
  }

  /* Regression: asking for the flat map with nobody connected 500'd. fitCamera
     returns null when there is nothing to fit, and the flat branch went
     straight to cam.z. Every view must render on an empty server — that is
     the state the page is in most of the time. */
  {
    const ctx = {
      riders: () => [],
      snapshot: () => ({ clients: 0, parties: 0, races: 0 }),
      tomtomKeyed: () => true, wazeKeyed: () => true, agentKeyed: () => false,
      telemetryOn: () => true, secure: false,
      sanitizeProfile: (p) => p, validUsername: () => null,
      validPassword: () => null, validEmail: () => null
    };
    admin.init(ctx);
    admin._setEnvForTest('a-long-test-admin-secret-0123456789', []);
    const sess = admin._signSession('admin');
    for (const view of ['', '?view=flat', '?view=globe', '?view=flat&refresh=0']) {
      const res = mockRes();
      await admin.handle(mockReq('GET', '/admin/map' + view, sess), res, '/admin/map', '1.2.3.4');
      ok('GET /admin/map' + (view || ' (auto)') + ' renders with NOBODY connected',
        res.status === 200, 'status ' + res.status);
    }
    // ...and with riders present but no fix, which is the other empty shape.
    ctx.riders = () => [{ id: 'a', userId: null, username: 'NoFix', guest: true, bot: false,
      pos: null, heading: 0, mode: 'cruise', ghost: false, party: null, racing: false,
      mic: false, ageMs: null, ip: '' }];
    for (const view of ['?view=flat', '?view=globe']) {
      const res = mockRes();
      await admin.handle(mockReq('GET', '/admin/map' + view, sess), res, '/admin/map', '1.2.3.4');
      ok('GET /admin/map' + view + ' renders when riders have no GPS fix',
        res.status === 200 && /NoFix/.test(res.body), 'status ' + res.status);
    }
  }
  {
    // And an anonymous POST is refused outright, not redirected — a redirect
    // would turn a kill-switch press into a silent no-op.
    const res = mockRes();
    await admin.handle(mockReq('POST', '/admin/flags/panic', null), res, '/admin/flags/panic', '1.2.3.4');
    ok('POST /admin/flags/panic with no session is a 403, not a redirect',
      res.status === 403, 'status ' + res.status);
    ok('the app was NOT killed by an anonymous panic',
      flags.pick('app', true) === true);
  }

  /* ---- halt: the store kill switch ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-1' }],
    ['GET /tracks/production', { track: 'production', releases: [
      { versionCodes: ['4'], status: 'inProgress', userFraction: 0.1 }] }],
    ['PUT /tracks/production', {}],
    ['POST /edits/edit-1:commit', {}]
  ]);
  play._resetTokenForTest();
  const r = await play.halt('production');

  ok('halt reports the track and the fraction it stopped at',
    r.track === 'production' && r.percent === 10, JSON.stringify(r));
  {
    const put = JSON.parse(calls('PUT', '/tracks/production')[0].body);
    ok('halt sets status "halted"', put.releases[0].status === 'halted', JSON.stringify(put));
    ok('halt keeps the fraction, so resume knows where it left off',
      put.releases[0].userFraction === 0.1, JSON.stringify(put));
    ok('halt keeps the SAME version code — it never republishes',
      put.releases[0].versionCodes.join() === '4');
  }
  ok('halt commits the edit (nothing is live until commit)',
    calls('POST', ':commit').length === 1);

  /* A completed rollout has nothing left to halt. Play would accept the write
     and do nothing useful; the panel must say so instead. */
  stubGoogle([
    ['POST /edits', { id: 'edit-2' }],
    ['GET /tracks/production', { releases: [{ versionCodes: ['4'], status: 'completed' }] }],
    ['DELETE /edits/edit-2', {}]
  ]);
  let msg = '';
  try { await play.halt('production'); } catch (e) { msg = e.message; }
  ok('halting a 100%-live release explains why it cannot work',
    /completed rollout cannot be halted|fully live/.test(msg), 'got: ' + msg);
  ok('the failed halt DISCARDS its edit — a stale edit blocks the next publish',
    calls('DELETE', '/edits/edit-2').length === 1,
    'no discard: the pipeline is now locked until the edit expires');

  /* ---- rollout: 100 means "completed", not userFraction 1 ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-3' }],
    ['GET /tracks/production', { releases: [{ versionCodes: ['7'], status: 'inProgress', userFraction: 0.2 }] }],
    ['PUT /tracks/production', {}],
    ['POST /edits/edit-3:commit', {}]
  ]);
  const full = await play.setRollout('production', 100);
  {
    const put = JSON.parse(calls('PUT', '/tracks/production')[0].body);
    ok('100% is sent as "completed" with no userFraction',
      put.releases[0].status === 'completed' && put.releases[0].userFraction === undefined,
      JSON.stringify(put));
    ok('setRollout(100) reports 100%', full.percent === 100 && full.status === 'completed');
  }

  stubGoogle([
    ['POST /edits', { id: 'edit-4' }],
    ['GET /tracks/beta', { releases: [{ versionCodes: ['7'], status: 'inProgress', userFraction: 0.05 }] }],
    ['PUT /tracks/beta', {}],
    ['POST /edits/edit-4:commit', {}]
  ]);
  await play.setRollout('beta', 50);
  ok('a partial rollout stays inProgress with the fraction',
    (() => { const p = JSON.parse(calls('PUT', '/tracks/beta')[0].body).releases[0];
             return p.status === 'inProgress' && p.userFraction === 0.5; })());

  /* ---- promote: copies the source track's version, never a new build ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-5' }],
    ['GET /tracks/internal', { releases: [{ versionCodes: ['9'], status: 'completed' }] }],
    ['PUT /tracks/production', {}],
    ['POST /edits/edit-5:commit', {}]
  ]);
  const promoted = await play.promote({ from: 'internal', to: 'production', status: 'inProgress', percent: 5 });
  ok('promote carries the SOURCE track\'s version code',
    promoted.versionCodes.join() === '9', JSON.stringify(promoted));
  ok('promote writes to the DESTINATION track only',
    calls('PUT', '/tracks/production').length === 1 && calls('PUT', '/tracks/internal').length === 0);
  ok('promote honours the requested staged fraction',
    JSON.parse(calls('PUT', '/tracks/production')[0].body).releases[0].userFraction === 0.05);

  stubGoogle([
    ['POST /edits', { id: 'edit-6' }],
    ['GET /tracks/alpha', { releases: [] }],
    ['DELETE /edits/edit-6', {}]
  ]);
  msg = '';
  try { await play.promote({ from: 'alpha', to: 'production' }); } catch (e) { msg = e.message; }
  ok('promoting an empty track refuses instead of publishing nothing',
    /nothing is released/.test(msg), 'got: ' + msg);
  ok('the refused promotion discards its edit', calls('DELETE', '/edits/edit-6').length === 1);

  msg = '';
  try { await play.promote({ from: 'beta', to: 'beta' }); } catch (e) { msg = e.message; }
  ok('promoting a track onto itself is refused', /same track/.test(msg), 'got: ' + msg);

  /* ---- a failed commit must not look like success ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-7' }],
    ['GET /tracks/production', { releases: [{ versionCodes: ['4'], status: 'inProgress', userFraction: 0.1 }] }],
    ['PUT /tracks/production', {}],
    ['POST /edits/edit-7:commit', { __status: 409, error: { message: 'edit conflict' } }],
    ['DELETE /edits/edit-7', {}]
  ]);
  msg = '';
  try { await play.halt('production'); } catch (e) { msg = e.message; }
  ok('a rejected commit throws and says nothing was published',
    /nothing was published/.test(msg), 'got: ' + msg);
  ok('a rejected commit still discards the edit',
    calls('DELETE', '/edits/edit-7').length === 1);

  /* ---- status() reads without committing ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-8' }],
    ['GET /tracks', { tracks: [
      { track: 'production', releases: [{ versionCodes: ['4'], status: 'inProgress', userFraction: 0.15 }] }] }],
    ['DELETE /edits/edit-8', {}]
  ]);
  const st = await play.status();
  ok('status() returns every track, even the empty ones',
    st.length === play.TRACKS.length, 'got ' + st.length);
  ok('status() converts the fraction back to a percent for display',
    st.find((t) => t.track === 'production').releases[0].percent === 15);
  ok('status() NEVER commits — a read must not burn a listing version',
    calls('POST', ':commit').length === 0);
  ok('status() discards its read edit', calls('DELETE', '/edits/edit-8').length === 1);

  /* ---- upload validates locally before spending bandwidth ---- */
  stubGoogle([['POST /edits', { id: 'edit-9' }], ['DELETE /edits/edit-9', {}]]);
  const goodArtifact = path.join(process.env.PLAY_ARTIFACT_DIR, 'convoy-1.0.109.aab');
  msg = '';
  try { await play.upload(goodArtifact, { track: 'production', status: 'inProgress', percent: 0 }); }
  catch (e) { msg = e.message; }
  ok('upload rejects a bad rollout % BEFORE uploading a single byte',
    /percentage above 0/.test(msg) && calls('POST', 'uploadType=media').length === 0,
    'got: ' + msg + ' after ' + calls('POST', 'uploadType=media').length + ' uploads');

  msg = '';
  try { await play.upload(path.join(process.env.PLAY_ARTIFACT_DIR, 'notes.txt'), { track: 'internal' }); }
  catch (e) { msg = e.message; }
  ok('upload refuses a non-artifact file', /only .aab and .apk/.test(msg), 'got: ' + msg);

  msg = '';
  try { await play.upload(path.join(TMP, 'does-not-exist.aab'), { track: 'internal' }); }
  catch (e) { msg = e.message; }
  ok('upload refuses a missing artifact', /no artifact at/.test(msg), 'got: ' + msg);

  msg = '';
  try { await play.upload(goodArtifact, { track: 'nope' }); } catch (e) { msg = e.message; }
  ok('upload refuses an unknown track', /unknown track/.test(msg), 'got: ' + msg);

  /* ---- the happy path: upload → assign → commit ---- */
  stubGoogle([
    ['POST /edits', { id: 'edit-10' }],
    ['POST uploadType=media', { versionCode: 12, sha256: 'abc' }],
    ['PUT /tracks/internal', {}],
    ['POST /edits/edit-10:commit', {}]
  ]);
  const up = await play.upload(goodArtifact, { track: 'internal', status: 'inProgress', percent: 5, notes: 'hotfix' });
  ok('upload takes the version code from Play, never from the operator',
    up.versionCode === '12', JSON.stringify(up));
  ok('upload posts the artifact to the bundles endpoint (.aab ⇒ bundles)',
    calls('POST', '/bundles?uploadType=media').length === 1, JSON.stringify(CALLS.map((c) => c.url)));
  ok('upload sends the file bytes, not JSON',
    Buffer.isBuffer(calls('POST', 'uploadType=media')[0].body));
  {
    const put = JSON.parse(calls('PUT', '/tracks/internal')[0].body);
    ok('the uploaded version is assigned to the requested track',
      put.releases[0].versionCodes.join() === '12' && put.releases[0].userFraction === 0.05,
      JSON.stringify(put));
    ok('release notes ride along', put.releases[0].releaseNotes[0].text === 'hotfix');
  }
  ok('the happy path commits exactly once', calls('POST', ':commit').length === 1);

  /* An .apk goes to a different endpoint than an .aab — getting this wrong is
     a 400 at the worst possible moment. */
  stubGoogle([
    ['POST /edits', { id: 'edit-11' }],
    ['POST uploadType=media', { versionCode: 13 }],
    ['PUT /tracks/internal', {}],
    ['POST /edits/edit-11:commit', {}]
  ]);
  await play.upload(path.join(process.env.PLAY_ARTIFACT_DIR, 'convoy-old.apk'), { track: 'internal', status: 'draft' });
  ok('an .apk goes to the apks endpoint, not bundles',
    calls('POST', '/apks?uploadType=media').length === 1, JSON.stringify(CALLS.map((c) => c.url)));

  /* Play's nested error shape must reach the operator as a sentence. */
  ok('a nested Play error is flattened to one readable line',
    play._errText({ status: 400, body: { error: { errors: [{ reason: 'apkUpgradeVersionConflict', message: 'Version code 4 has already been used' }] } } })
      === 'Version code 4 has already been used (apkUpgradeVersionConflict)');

  restoreFetch();

  /* ================================================================== */
  group('server.js — the switches are actually wired in');

  ok('the admin panel is mounted',
    /admin\.handles\(urlPath\)/.test(SERVER_SRC) && /admin\.handle\(req, res, urlPath/.test(SERVER_SRC),
    'the panel exists as a module but no request can ever reach it');
  ok('admin.init() is called at boot', /admin\.init\(\{/.test(SERVER_SRC));
  ok('the panel is handed a kick() so a ban closes live sockets',
    /kick:\s*\(userId\)/.test(SERVER_SRC));

  ok('the master switch gates /api/*',
    /urlPath\.indexOf\('\/api\/'\) === 0 &&[\s\S]{0,200}flags\.pick\('app', true\)/.test(SERVER_SRC));
  ok('a killed app answers 503, not 200',
    /res\.writeHead\(503,[\s\S]{0,400}maintenance: true/.test(SERVER_SRC));
  ok('a killed app sends Retry-After so the fleet backs off',
    /'Retry-After'/.test(SERVER_SRC));
  ok('/api/health stays up during a kill (a monitor must tell this from a dead box)',
    /urlPath !== '\/api\/health'/.test(SERVER_SRC) && /urlPath === '\/api\/health'/.test(SERVER_SRC));
  ok('/api/ota stays up during a kill (it is the recovery path)',
    /urlPath !== '\/api\/ota'/.test(SERVER_SRC),
    'killing the app would also kill the only way to ship the fix');
  ok('the WebSocket handshake is refused while killed',
    /function wsOriginOk[\s\S]{0,600}?flags\.pick\('app', true\)\)\s*return cb\(false, 503/.test(SERVER_SRC),
    'a killed server would still accept sockets — the realtime half stays open');
  // It must be the FIRST thing wsOriginOk does: checking after the origin
  // allowlist would let an allowed origin through during a kill.
  {
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function wsOriginOk'));
    ok('the kill check precedes the origin allowlist inside wsOriginOk',
      fn.indexOf("flags.pick('app'") < fn.indexOf('WS_EXTRA_ORIGINS'));
  }

  // The gate sits above the routes on purpose; if it drifts below them, a
  // broken handler downstream can keep serving through a kill.
  {
    const gate = SERVER_SRC.indexOf("urlPath !== '/api/health'");
    const firstRoute = SERVER_SRC.indexOf("if (urlPath === '/api/tts/health')");
    ok('the kill gate sits ABOVE the first route it protects',
      gate > 0 && firstRoute > 0 && gate < firstRoute,
      'gate at ' + gate + ', first route at ' + firstRoute);
  }

  ok('flags.init() runs before the listener opens',
    SERVER_SRC.indexOf('flags.init()') > 0 &&
    SERVER_SRC.indexOf('flags.init()') < SERVER_SRC.indexOf('httpServer.listen('),
    'booting with the master switch on would still serve for a moment');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(report());
})().catch((e) => {
  restoreFetch();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* best effort */ }
  console.error('\n\x1b[31mtest crashed:\x1b[0m', e && (e.stack || e.message));
  process.exit(1);
});
