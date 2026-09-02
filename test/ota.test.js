/* Convoy — OTA hotfix channel tests.

   The hotfix path spans four pieces, and each half is testable without the
   others:

     · server/ota.js   — the version brain + manifest store. Driven directly
                         against a temp DATA_DIR (the store.js require.cache
                         stub the telemetry suite introduced), because the
                         decision logic is where a bad day starts: offering a
                         downgrade, offering nothing, or resolving a bundle
                         path that was never published.
     · server.js wiring — policy assertions on the source (the serverpolicy
                         pattern): the check POST is rate-limited, the zip
                         route only serves manifest-vouched names, and the
                         routes exist at all.
     · scripts/pack-ota.js — the deterministic zip writer + stamp/version
                         mapping + manifest assembly. The zip is parsed back
                         with an independent reader (not the writer's own
                         logic) and re-inflated entry by entry.
     · js/ota.js       — the client half in the browser shim: inert on the
                         web, talks to the plugin on native, and never throws
                         its way out of a broken boot.

   What can only be proven on a device — the actual WebView swap and the
   15s handshake watchdog — is the pre-launch drill in DEPLOY.md §"OTA hotfix
   path", not this file.

   Run:  node test/ota.test.js  */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { group, ok, report, ROOT, installBrowser, loadModule } = require('./harness');

/* ---- temp DATA_DIR, injected before server/ota.js captures store.DATA_DIR ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-ota-'));
const OTA_DIR = path.join(TMP, 'ota');
fs.mkdirSync(OTA_DIR, { recursive: true });
const MANIFEST = path.join(OTA_DIR, 'manifest.json');
{
  const STORE_PATH = require.resolve('../server/store.js');
  require.cache[STORE_PATH] = { id: STORE_PATH, filename: STORE_PATH, loaded: true, children: [], paths: [], exports: { DATA_DIR: TMP } };
}
const ota = require('../server/ota.js');
const pack = require('../scripts/pack-ota.js');

/* Writing the manifest twice within the same millisecond would look like "no
   change" to the mtime cache, so tests set explicit, increasing mtimes. */
let fakeMtime = Date.now() / 1000;
function writeManifest(obj) {
  fs.writeFileSync(MANIFEST, JSON.stringify(obj));
  fakeMtime += 10;
  fs.utimesSync(MANIFEST, fakeMtime, fakeMtime);
}
function clearManifest() {
  try { fs.unlinkSync(MANIFEST); } catch (e) { /* absent */ }
}

const HEX64 = 'a'.repeat(64);
const HEX64b = 'b'.repeat(64);
function entry(version, file, checksum, size) {
  return { version, file, checksum, size: size || 100 };
}

/* ================================================================== */
group('server: decide() — who gets offered what');

clearManifest();
writeManifest(entry('1.0.109', 'bundle-1.0.109.zip', HEX64, 1000));

const builtin = { version_name: 'builtin', version_build: '1.0.108', version_code: '4' };
ok('an old APK (builtin 1.0.108) is offered 1.0.109',
  JSON.stringify(ota.decide(builtin)) === JSON.stringify({ version: '1.0.109', url: '/ota/bundle-1.0.109.zip', checksum: HEX64, size: 1000 }),
  JSON.stringify(ota.decide(builtin)));

ok('a fresh APK (builtin 1.0.109) re-downloads nothing',
  JSON.stringify(ota.decide({ version_name: 'builtin', version_build: '1.0.109' })) === '{}');

ok('a device running the published bundle is up to date',
  JSON.stringify(ota.decide({ version_name: '1.0.109' })) === '{}');

ok('a device running an older bundle is offered the update',
  !!ota.decide({ version_name: '1.0.107' }).version);

ok('a device running something NEWER (beta/rollback race) is left alone',
  JSON.stringify(ota.decide({ version_name: '1.0.110' })) === '{}');

ok('a client reporting garbage gets the update (checksum gates install)',
  !!ota.decide({}).version && !!ota.decide({ version_name: 'garbage' }).version);

writeManifest(Object.assign(entry('1.0.108', 'bundle-1.0.108.zip', HEX64b, 900), { force: true }));
ok('force offers an OLDER version (the rollback path)',
  ota.decide({ version_name: '1.0.109' }).version === '1.0.108');
ok('force does not re-offer the version already running',
  JSON.stringify(ota.decide({ version_name: '1.0.108' })) === '{}');

writeManifest(entry('1.0.109', 'bundle-1.0.109.zip', HEX64, 1000));
ok('semver compares numerically, not as text (…109 > …9)',
  !!ota.decide({ version_name: '1.0.9' }).version &&
  JSON.stringify(ota.decide({ version_name: '1.0.110' })) === '{}');

clearManifest();
ok('no manifest at all → nobody is offered anything', JSON.stringify(ota.decide(builtin)) === '{}');

/* ================================================================== */
group('server: the manifest is hostile-input proof');

writeManifest(entry('1.0.109', 'bundle-1.0.109.zip', HEX64, 1000));
writeManifest('{ truncated mid-write');
ok('a malformed manifest keeps the last good one serving',
  ota.decide(builtin).version === '1.0.109');

writeManifest({ version: 'not-semver', file: 'x.zip', checksum: 'zz', size: -1 });
ok('a shape-invalid manifest is treated the same way: last good keeps serving',
  ota.decide(builtin).version === '1.0.109');

writeManifest(Object.assign(entry('1.0.110', 'bundle-1.0.110.zip', HEX64, 1000),
  { history: [entry('1.0.109', 'bundle-1.0.109.zip', HEX64, 1000)] }));
ok('summary() exposes current + history for the rollback tooling',
  ota.summary().current.version === '1.0.110' && ota.summary().history[0].version === '1.0.109');

/* ================================================================== */
group('server: bundlePath() only resolves published names');

ok('the current bundle resolves', !!ota.bundlePath('bundle-1.0.110.zip'));
ok('a historical bundle still resolves (mid-download rollback safety)',
  !!ota.bundlePath('bundle-1.0.109.zip'));
ok('an unpublished name is refused', ota.bundlePath('bundle-9.9.9.zip') === null);
ok('traversal is refused', ota.bundlePath('../manifest.json') === null &&
  ota.bundlePath('..\\..\\server\\server.js') === null);

/* ================================================================== */
group('server.js wiring (source policy, serverpolicy-style)');

const SRV = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
ok('GET /api/ota serves the channel summary', /'GET' && urlPath === '\/api\/ota'/.test(SRV) || /urlPath === '\/api\/ota'/.test(SRV));
ok('the update-check POST is rate limited per IP', /rateOk\('ota:' \+ ip, 30, 60 \* 1000\)/.test(SRV));
ok('the bundle download route is rate limited too', /rateOk\('otaz:' \+ ip, 20, 60 \* 1000\)/.test(SRV));
ok('the zip route is anchored to exactly one safe name segment',
  SRV.includes('/^\\/ota\\/([A-Za-z0-9._-]+\\.zip)$/'));
ok('bundle bytes stream through ota.bundlePath(), never a raw path',
  /ota\.bundlePath\(otaZip\[1\]\)/.test(SRV));
ok('boot() initialises the OTA channel', /ota\.init\(\)/.test(SRV));

/* ================================================================== */
group('packer: stamp → version identity');

ok('no cache-buster is an error', pack.readStamp('<script src="js/a.js"></script>').error);
ok('mixed cache-busters are an error (half-done bump)',
  pack.readStamp('<script src="a.js?v=cy108"></script><script src="b.js?v=cy109"></script>').error);
ok('a consistent page yields its stamp',
  pack.readStamp('<link href="css/x.css?v=cy108"/><script src="js/a.js?v=cy108" defer></script>').stamp === 'cy108');
ok('cy109 packs as 1.0.109', pack.versionFromStamp('cy109') === '1.0.109');

ok('cmpVersion: equal', pack.cmpVersion('1.0.109', '1.0.109') === 0);
ok('cmpVersion: newer', pack.cmpVersion('1.0.109', '1.0.9') > 0);
ok('cmpVersion: older', pack.cmpVersion('1.0.9', '1.0.109') < 0);
ok('cmpVersion: garbage sorts below everything', pack.cmpVersion('garbage', '0.0.1') < 0);

/* ================================================================== */
group('packer: the deterministic zip writer');

const ZSRC = path.join(TMP, 'zipsrc');
fs.rmSync(ZSRC, { recursive: true, force: true });
fs.mkdirSync(path.join(ZSRC, 'js'), { recursive: true });
fs.writeFileSync(path.join(ZSRC, 'index.html'), '<!doctype html><p>convoy zip fixture</p>');
fs.writeFileSync(path.join(ZSRC, 'js', 'app.js'), 'var x = "' + 'zip-me-'.repeat(200) + '";');
fs.writeFileSync(path.join(ZSRC, 'js', 'ota.js'), 'tiny-but-compressible-aaaaaa');

function readZipEntries(buf) {
  // Independent local-header walk — deliberately NOT the writer's own code.
  const out = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const csize = buf.readUInt32LE(off + 18);
    const usize = buf.readUInt32LE(off + 22);
    const nlen = buf.readUInt16LE(off + 26);
    const elen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nlen).toString('utf8');
    const data = buf.slice(off + 30 + nlen + elen, off + 30 + nlen + elen + csize);
    out.push({ name, method, crc, csize, usize, data });
    off += 30 + nlen + elen + csize;
  }
  return out;
}

const zip1 = pack.buildZip(ZSRC);
const zip2 = pack.buildZip(ZSRC);
ok('identical trees pack to identical bytes (the checksum is a fingerprint)',
  Buffer.compare(zip1, zip2) === 0);

const entries = readZipEntries(zip1);
ok('entries are sorted and complete',
  entries.length === 3 && entries.map((e) => e.name).join(',') === 'index.html,js/app.js,js/ota.js',
  entries.map((e) => e.name).join(','));

let allRoundTrip = true, allCrc = true;
for (const e of entries) {
  const back = e.method === 8 ? zlib.inflateRawSync(e.data) : e.data;
  const orig = fs.readFileSync(path.join(ZSRC, e.name.split('/').join(path.sep)));
  if (Buffer.compare(back, orig) !== 0) allRoundTrip = false;
  if ((zlib.crc32(back) >>> 0) !== e.crc) allCrc = false;
}
ok('every entry re-inflates to the original bytes', allRoundTrip);
ok('every entry CRC matches its content', allCrc);

fs.writeFileSync(path.join(ZSRC, 'index.html'), 'moved');
fs.rmSync(path.join(ZSRC, 'index.html'));
let threw = false;
try { pack.buildZip(ZSRC); } catch (e) { threw = true; }
ok('a bundle without index.html at the root is refused', threw);
fs.writeFileSync(path.join(ZSRC, 'index.html'), '<p>back</p>');

/* ================================================================== */
group('packer: manifest assembly + rollback target');

const old = { current: { version: '1.0.109', file: 'bundle-1.0.109.zip', checksum: HEX64, size: 10 },
              // history is newest-first, like manifestFor writes it
              history: Array.from({ length: 12 }, (_, i) =>
                entry('1.0.' + (111 - i), 'bundle-1.0.' + (111 - i) + '.zip', HEX64b, 5)) };
const m = pack.manifestFor(entry('1.0.110', 'bundle-1.0.110.zip', HEX64, 20), old, false);
ok('the published current becomes history[0]', m.history[0].version === '1.0.109');
ok('history is capped at 10', m.history.length === 10);
ok('the manifest carries its own version + checksum', m.version === '1.0.110' && m.checksum === HEX64);
ok('not forced by default (a normal push must only go UP)', m.force === false);

ok('rollback picks the newest history entry', pack.rollbackTarget(old).version === '1.0.111');
ok('rollback with no history has nowhere to go', pack.rollbackTarget({ current: null, history: [] }) === null);

/* ================================================================== */
group('client: js/ota.js — inert on the web, wired on native');

const win = installBrowser();
win.Capacitor = undefined;
loadModule('js/ota.js');

win.App.config = { isNative: false, base: '', plugins: null };
ok('web: init() is a clean no-op returning false', win.App.ota.init() === false);
ok('web: ready() is a clean no-op returning false', win.App.ota.ready() === false);

// Native stub: a recorder pretending to be the Capacitor plugin proxy.
const calls = { check: [], notifyReady: 0, listener: null, throwCheck: false };
const stub = {
  check: (o) => { calls.check.push(o); if (calls.throwCheck) throw new Error('bridge gone'); },
  notifyReady: () => { calls.notifyReady++; },
  addListener: (ev, fn) => { if (ev === 'state') calls.listener = fn; }
};
let toasts = [], tracks = [];
win.App.config = { isNative: true, base: 'https://odoreeci.tech', plugins: { LiveUpdate: stub } };
win.App.ui = { toast: (msg, kind) => toasts.push([msg, kind]) };
win.App.telemetry = { track: (name, data) => tracks.push([name, data]) };

ok('native: init() pokes the plugin with the server base',
  win.App.ota.init() === true && calls.check.length === 1 && calls.check[0].base === 'https://odoreeci.tech');
ok('native: init() registers for plugin state events', typeof calls.listener === 'function');

calls.listener({ t: 'staged', version: '1.0.110' });
ok('staged → a rider-visible toast + telemetry',
  toasts.length === 1 && tracks.some((t) => t[0] === 'ota_staged'));

calls.listener({ t: 'reverted', version: '1.0.110', to: '1.0.109' });
ok('reverted → a warning toast + telemetry',
  toasts.length === 2 && toasts[1][1] === 'warn' && tracks.some((t) => t[0] === 'ota_reverted'));

calls.listener({ t: 'failed', error: 'checksum mismatch' });
ok('failed → telemetry only, silent for the rider',
  toasts.length === 2 && tracks.some((t) => t[0] === 'ota_failed'));

ok('native: ready() reaches notifyReady exactly once per call',
  win.App.ota.ready() === true && calls.notifyReady === 1);

calls.throwCheck = true;
ok('a throwing plugin bridge never escapes init()', win.App.ota.init() === true);

process.exit(report());
