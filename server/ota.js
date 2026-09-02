/* Convoy — OTA hotfix channel, server half.

   The web app is already over-the-air by construction: the server serves
   index.html with no-cache and every asset URL carries a ?v= stamp, so a
   browser reload IS an update. The APK is the frozen half — Capacitor bundles
   www/ into the APK at build time, and the only way to change it has been a
   full rebuild + store review. This module (plus the LiveUpdate plugin and
   js/ota.js on the client) is the bridge: HTML/CSS/JS fixes reach installed
   APKs in minutes, while native changes still go the store route.

   What lives here:
     · The published manifest (DATA_DIR/ota/manifest.json) — the ONE file that
       says which bundle the fleet should run. release.js SFTPs it next to its
       zip; this process never writes it. It is re-read on mtime change per
       request, so a hotfix push goes live WITHOUT a service restart — the
       whole point of the channel. No manifest (or a malformed one) means "no
       update": the channel fails off, never on.

     · decide() — the version brain. The plugin POSTs what it is running
       {platform, version_build, version_code, version_name}; the server alone
       decides whether an update is offered. The client never gets to choose,
       because the client is the thing being fixed.

     · bundlePath() — the only way /ota/<file>.zip resolves to bytes on disk.
       It only ever returns names the current-or-historical manifest vouched
       for, so path traversal is impossible by construction rather than by
       check.

   Version scheme: the ?v=cyNNN cache-buster in index.html is the app's
   existing version identity (telemetry already reports it), so OTA versions
   derive from it: cy109 → "1.0.109". The Android versionName follows the same
   number, which is what lets decide() map a plugin reporting version_name
   "builtin" onto its bundled stamp via version_build — fresh APKs don't
   re-download assets they already contain.

   Privacy note: the plugin's POST carries platform + versions and NOTHING
   else. No device id, no install id — the Data Safety answer "Device or other
   IDs: No" (pinned by test/sdk-inventory.test.js) stays true.

   TRUST MODEL (written down so the next review doesn't have to re-derive it):
   the manifest is NOT cryptographically signed. What stands between a rider's
   APK and a malicious bundle, in order:
     1. TLS to the one origin, plus the operator's SSH key/password on the only
        write path (release.js SFTPs zip-then-manifest; this process never
        writes the directory).
     2. THIS module's shape gate — version/file/checksum/size all validated,
        and /ota/<file> resolves only names the manifest vouched for.
     3. The plugin's own gate — https-only, sha256 streamed during download
        and compared to the manifest, declared-size enforcement, zip-escape
        guard, and the stage→notifyReady()→15s-watchdog→revert handshake.
   The residual gap is full server compromise: an attacker who controls the
   box serves a malicious manifest AND a matching zip, and every checksum
   passes because they chose it. Closing THAT needs a signature over the
   manifest verified against a public key baked into the APK (Ed25519; Node
   signs with stock crypto, Java needs API 33+ or a bundled verifier) — which
   only protects APKs built after the key ships, so it is a rollout project,
   not a patch. Every stage above it is already enforced. */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;
const OTA_DIR = path.join(DATA_DIR, 'ota');
const MANIFEST_FILE = path.join(OTA_DIR, 'manifest.json');

// manifest.json (written by release.js --ota, read here):
//   {
//     "version":  "1.0.109",            semver derived from the ?v= stamp
//     "file":     "bundle-1.0.109.zip", must match /^[A-Za-z0-9._-]+\.zip$/
//     "checksum": "<64 hex sha256>",
//     "size":     12345,                bytes; plugin enforces its own cap too
//     "note":     "fix: ghost layer",   operator-facing, never shown by code
//     "force":    false,                offer even when NOT newer (rollbacks)
//     "history":  [ {…same fields…} ]   previous entries, newest first
//   }
// history is what `release.js --ota --rollback` reads to re-point the channel
// at the previous bundle without rebuilding anything.

const KEEP_HISTORY = 10;      // entries of history honoured when resolving files
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024; // sanity ceiling for manifest size claims

let cache = { mtimeMs: -1, manifest: null };
let warnedBad = false;

/* Semver-lite: "1.0.109" → [1, 0, 109]. Missing segments count as 0, so "1.0"
   and "1.0.0" compare equal — a versionName of "1.0.109" and a manifest of
   "1.0.109.0" would too. Anything unparseable returns null and sorts BELOW
   every real version: a client that reports garbage gets offered the update
   (the checksum decides whether it installs), and a garbage manifest version
   never gets offered to anyone. */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [+m[1], +(m[2] || 0), +(m[3] || 0)];
}

function cmpSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function validEntry(e) {
  return !!(e && typeof e === 'object' &&
    typeof e.version === 'string' && parseSemver(e.version) &&
    typeof e.file === 'string' && /^[A-Za-z0-9._-]+\.zip$/.test(e.file) &&
    typeof e.checksum === 'string' && /^[0-9a-f]{64}$/.test(e.checksum) &&
    typeof e.size === 'number' && Number.isFinite(e.size) &&
    e.size > 0 && e.size <= MAX_BUNDLE_BYTES);
}

/* Read (and mtime-cache) the manifest. Malformed or half-written files keep
   the LAST GOOD copy rather than nulling the channel — release.js uploads the
   zip first and the manifest second, so the only mid-write state a request can
   ever catch is a truncated manifest, and "keep serving the old one" is the
   correct answer to that. */
function readManifest() {
  let st;
  try { st = fs.statSync(MANIFEST_FILE); }
  catch (e) { return null; }
  if (st.mtimeMs !== cache.mtimeMs) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); }
    catch (e) { parsed = null; }
    if (parsed && validEntry(parsed)) {
      parsed.force = !!parsed.force;
      if (typeof parsed.note !== 'string') parsed.note = '';
      parsed.history = Array.isArray(parsed.history)
        ? parsed.history.filter(validEntry).slice(0, KEEP_HISTORY) : [];
      cache = { mtimeMs: st.mtimeMs, manifest: parsed };
      warnedBad = false;
    } else {
      // Once per bad file, not once per request: a polling fleet would turn
      // this into log spam within seconds of a botched upload.
      if (!warnedBad) {
        console.error('[ota] manifest is missing required fields — keeping the last good one (' +
          (cache.manifest ? cache.manifest.version : 'none') + ')');
        warnedBad = true;
      }
      cache.mtimeMs = st.mtimeMs;
    }
  }
  return cache.manifest;
}

/* Public shape of an entry: everything the plugin or an operator needs, none
   of the bookkeeping. `url` is path-relative — the plugin knows the origin it
   fetched the check from (js/config.js's base) and joins; hardcoding the
   domain here would break dev servers and the localhost drill. */
function offerShape(e) {
  return { version: e.version, url: '/ota/' + e.file, checksum: e.checksum, size: e.size };
}

/* The version brain. body is the plugin's POST:
     version_name  "builtin" or the running bundle's version
     version_build the Android versionName (tracks the bundled stamp)
     version_code  the Android versionCode (informational here)
   Rules, in order:
     1. no (good) manifest          → {} — channel off
     2. manifest.force and differs  → offer — the rollback/redo path
     3. manifest strictly newer     → offer — the normal hotfix path
     4. anything else               → {} — up to date
   Equal versions are never re-offered (a fleet would otherwise re-download on
   every app open), and a client running something NEWER than the manifest
   (beta APK, or a rollback in flight) gets {} and keeps what it has. */
function decide(body) {
  const m = readManifest();
  if (!m) return {};
  const b = body && typeof body === 'object' ? body : {};
  const cur = (b.version_name === 'builtin' || !b.version_name)
    ? b.version_build : b.version_name;
  const diff = cmpSemver(m.version, cur);
  if ((m.force && diff !== 0) || diff > 0) return offerShape(m);
  return {};
}

/* Resolve a bundle filename to an absolute path — only names the current or a
   historical manifest vouched for. History matters: right after a rollback,
   devices still downloading the previous "current" must keep succeeding, or a
   rollback would strand every rider mid-download. */
function bundlePath(file) {
  if (typeof file !== 'string') return null;
  const m = readManifest();
  if (!m) return null;
  const known = [m].concat(m.history || []).some(function (e) { return e.file === file; });
  if (!known) return null;
  const p = path.resolve(OTA_DIR, file);
  if (path.dirname(p) !== OTA_DIR) return null; // belt + suspenders: names are regex-gated already
  return p;
}

/* Operator/health view: what the channel is currently serving and what it
   could roll back to. This is the endpoint `release.js --ota` probes and the
   data `--rollback` reads. */
function summary() {
  const m = readManifest();
  if (!m) return { current: null, history: [] };
  return {
    current: { version: m.version, file: m.file, checksum: m.checksum, size: m.size,
               note: m.note || '', force: !!m.force },
    history: (m.history || []).map(function (e) {
      return { version: e.version, file: e.file, checksum: e.checksum, size: e.size,
               note: e.note || '' };
    })
  };
}

function init() {
  try { fs.mkdirSync(OTA_DIR, { recursive: true }); } catch (e) { /* exists */ }
  const m = readManifest();
  console.log('[boot] OTA channel: ' + (m
    ? 'bundle ' + m.version + (m.force ? ' (forced)' : '')
    : 'no bundle published'));
}

/* Exports are the test surface: everything meaningful is pure or file-backed,
   so test/ota.test.js can drive it against a temp DATA_DIR the same way the
   telemetry suite does (require.cache stub for store.js). */
module.exports = { init, decide, bundlePath, summary, readManifest, _OTA_DIR: OTA_DIR };
