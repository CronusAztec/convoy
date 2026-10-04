#!/usr/bin/env node
/* Convoy — one-shot release script.

   Builds everything locally, then ships it to the VPS in a single pass:
     1. Sync web assets into www/ (for the Capacitor shell)
     2. cap sync android  (wire www/ + plugins into the Android project)
     3. Build the signed release APK  (gradlew assembleRelease)
        AND the signed Android App Bundle (gradlew bundleRelease)
     4. Copy the APK to the repo root as convoy.apk (+ Convoy-release.apk)
        so the server's /convoy.apk download route serves the new build, and
        the .aab to convoy.aab for the Play Console

     Both artifacts are built because they serve different consumers and only
     one of them can go to Google Play. Play has required an App Bundle for new
     apps since August 2021 and will reject an APK outright; the website's
     /convoy.apk sideload link, by contrast, needs a real installable APK
     because a bundle is not installable. Building only the APK — which is what
     this script did — left the project with no artifact it could publish.
     5. Build the server tarball
     6. deploy.js update  (upload app files + restart the convoy service)
     7. Upload convoy.apk to the VPS project root (/opt/convoy/convoy.apk)
     8. Health-check the public site + the APK download URL

   Run it from the project root:

       node release.js                 # full release (APK + site)
       node release.js --no-apk        # site only, skip the APK/AAB build+upload
       node release.js --no-aab        # skip only the App Bundle (APK still built)
       node release.js --no-site       # APK only, skip the site deploy
       node release.js --skip-build    # reuse the APK already at ./convoy.apk
                                       # and the tarball at %TEMP%/convoy.tgz

   ── OTA hotfix path ─────────────────────────────────────────────────────────
   The APK's web layer is live-updatable (LiveUpdatePlugin + /api/ota), so a
   JS/CSS/HTML fix does NOT need a store review:

       node release.js --ota           # hotfix: pack www/ → zip+sha256, deploy
                                       # the site (web riders), then upload the
                                       # bundle + manifest to the OTA dir.
                                       # NO APK build, NO service restart —
                                       # the manifest is mtime-reloaded.
       node release.js --rollback      # OTA emergency stop: repoint the channel
                                       # at the previous bundle. Nothing is
                                       # rebuilt; devices that already took the
                                       # bad one are force-moved back.

   Native code changes still need the full APK + store path above. The bundle
   zip lands in /var/lib/convoy/ota (the convoy service's DATA_DIR) — override
   with OTA_DIR_REMOTE. --offline passes through to the packer for local drills.

   VPS auth reuses deploy/deploy.js: set VPS_HOST + either VPS_KEY (passwordless,
   recommended) or VPS_PASS. VPS_USER defaults to root. The deploy SSH key at
   deploy/convoy_deploy_key is used automatically if present and VPS_KEY is unset.

   Windows-first (gradlew.bat, .apk at repo root) but every step degrades cleanly
   so it runs on macOS/Linux too (uses ./gradlew). */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const ANDROID_DIR = path.join(ROOT, 'android');
const DEPLOY_JS = path.join(DEPLOY_DIR, 'deploy.js');

// --- args ---
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const NO_APK = flag('--no-apk');
const NO_AAB = flag('--no-aab');
const NO_SITE = flag('--no-site');
const SKIP_BUILD = flag('--skip-build');
const OTA = flag('--ota');
const ROLLBACK = flag('--rollback');
const OTA_FORCE = flag('--force');
const OTA_OFFLINE = flag('--offline');

const packOta = require('./scripts/pack-ota.js');

// --- VPS config (resolved the same way deploy.js expects it) ---
// HOST is the SSH/SFTP target (IP or hostname). SITE_URL is the public base URL
// the health check probes — keep them separate: Caddy's TLS cert is for the
// DOMAIN (odoreeci.tech), not the IP, so probing https://<IP>/ fails TLS SNI
// (alert 80) even when the server is perfectly healthy.
const HOST = process.env.VPS_HOST || '2.25.184.90';
const SITE_URL = (process.env.SITE_URL || 'https://odoreeci.tech').replace(/\/+$/, '');
const USERS = (process.env.VPS_USER || 'root').split(',').map((s) => s.trim());
const DEFAULT_KEY = path.join(DEPLOY_DIR, 'convoy_deploy_key');
// Prefer an explicit VPS_KEY; fall back to the repo's deploy key if it exists.
if (!process.env.VPS_KEY && !process.env.VPS_PASS && fs.existsSync(DEFAULT_KEY)) {
  process.env.VPS_KEY = DEFAULT_KEY;
}
process.env.VPS_HOST = HOST;
process.env.VPS_USER = USERS.join(',');
const TARBALL = process.env.TARBALL || path.join(os.tmpdir(), 'convoy.tgz');
process.env.TARBALL = TARBALL;

const APK_OUT = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const ROOT_APK = path.join(ROOT, 'convoy.apk');        // served at /convoy.apk
const ROOT_APK_NAMED = path.join(ROOT, 'Convoy-release.apk'); // convenience copy
// Play Console artifact. Not served anywhere and never uploaded to the VPS —
// it exists purely so there is something to hand to Google.
const AAB_OUT = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const ROOT_AAB = path.join(ROOT, 'convoy.aab');

/* ----------------------------- helpers ----------------------------- */

function log(msg) { console.log(msg); }
function head(t) { console.log('\n=== ' + t + ' ==='); }

// Run a command, capture output (printed live for build steps, surfaced fully on
// failure). Throws on non-zero exit with the command + the last chunk of stderr.
//
// Windows spawning is fiddly:
//  - Node refuses to exec .bat/.cmd directly with shell:false (CVE-2018-1000001
//    class) → silent status:null. So we MUST go through cmd.exe.
//  - shell:true lets Node route through cmd.exe for us, BUT it re-tokenizes args
//    on whitespace, so a spaced path arg ("...\New folder\scripts\copy-web.js")
//    splits, and globs (* ?) get expanded by cmd before the program sees them.
// The robust uniform fix: on Windows, invoke cmd.exe ourselves with shell:false,
// passing ['/d', '/c', cmd, ...args] as a proper arg array. Node applies Win32
// argument quoting at the CreateProcess boundary, so each token survives intact —
// no manual outer-quoting, no /s trickery. cwd (which may contain spaces, like
// this repo's "New folder") is set directly and never shell-parsed. mac/linux
// stay on a plain spawn.
function run(cmd, args, opts) {
  opts = opts || {};
  const isWin = process.platform === 'win32';
  let spawnCmd = cmd, spawnArgs = args || [];
  if (isWin) {
    spawnCmd = 'cmd.exe';
    spawnArgs = ['/d', '/c', String(cmd)].concat(args || []);
  }
  const display = cmd + ' ' + (args || []).join(' ');
  if (opts.label) process.stdout.write('-> ' + opts.label + ' ... ');
  const r = spawnSync(spawnCmd, spawnArgs, {
    stdio: opts.live ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    shell: false,
    cwd: opts.cwd || ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    if (opts.label) console.log('FAILED');
    const err = (r.stderr || '').trim();
    const out = (r.stdout || '').trim();
    const detail = err || out
      ? '\n--- ' + display + ' output ---\n' + (err ? err : out).split('\n').slice(-30).join('\n')
      : (r.error ? '\n' + r.error.message : '');
    throw new Error('command failed (' + r.status + '): ' + display + detail);
  }
  if (opts.label) console.log('ok');
  return r;
}

// (quoteArg retained for any future call site that builds a single command string;
// run() itself no longer needs it now that args ride as a proper array.)
function quoteArg(a) {
  const s = String(a);
  if (s === '' || /[\s"^&|<>*?[\]()%!]/.test(s)) {
    return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
  }
  return s;
}

// Resolve an npm-runnable binary (cap, etc.) for spawnSync. We run it through
// `npx --no-install`, which finds the local node_modules binary reliably on
// Windows/macOS/Linux without us guessing .cmd/.sh shim names or fighting
// shell:false PATH resolution. Returns [cmd, prefixArgs].
//
// On Windows npx lives at the node install root; spawnSync needs the real path
// (cmd shims under .bin are bash scripts that node can't exec directly, and
// the .cmd variants don't always resolve under shell:false). npx sidesteps both.
function npmBin(name) {
  const npx = process.platform === 'win32' ? npxPath() : 'npx';
  return [npx, ['--no-install', name]];
}

// Locate npx.cmd alongside the node binary (where it's installed).
function npxPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [path.join(nodeDir, 'npx.cmd'), path.join(nodeDir, 'npx')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'npx.cmd'; // last resort — hope it's on PATH
}

// gradlew wrapper for this platform. Returns an EXPLICIT relative launcher path —
// the caller passes cwd: ANDROID_DIR, so the spaced repo path ("New folder") stays
// in cwd (never shell-parsed) instead of riding inside an arg where cmd mangles it.
// Why not the absolute path? gradlew.bat's %~dp0 self-location trips on the quotes
// cmd adds → "network path was not found". Why not the bare name? cmd skips the
// current directory when NoDefaultCurrentDirectoryInExePath is set (hardened
// shells) → "'gradlew.bat' is not recognized". `.\gradlew.bat` avoids both.
function gradlew() {
  return process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
}

// GET a URL and resolve to { status } (or { error }). Picks http/https from the URL.
// Caddy fronts https on 443, so the public checks use https — plain http.get would
// hand it a TLS handshake and error out.
function probe(url) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? 'https' : 'http';
    const req = require(proto).get(url, { timeout: 10000 }, (res) => {
      res.resume(); // drain
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

// Build the deploy tarball exactly as DEPLOY.md documents: app sources only,
// never node_modules/.git/.claude/server-data. Excludes the APKs (they ship
// separately, and bundling a 30MB binary into the app tarball would bloat every
// restart's tar -xzf).
//
// tar flavor matters on Windows: the tarball path is an absolute C:\... path.
//   - GNU tar (Git for Windows) reads the colon as a [host]:[path] remote-shell
//     target and fails with "Cannot connect to C:" UNLESS given --force-local.
//   - bsdtar (Windows 10/11 System32 tar) handles C:\ natively and does NOT
//     understand --force-local (errors "Option --force-local is not supported").
// Whichever wins the PATH lookup (System32 usually wins from cmd, Git's tar wins
// from bash), we probe once and only pass --force-local to GNU tar. mac/linux tar
// has no drive letters, so the flag is moot there but harmless — except that some
// BSD-derived tars also reject it, so we probe there too.
let _tarIsGnu;
function tarIsGnu() {
  if (_tarIsGnu !== undefined) return _tarIsGnu;
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8', shell: false });
  _tarIsGnu = /GNU tar/i.test((r.stdout || '') + (r.stderr || ''));
  return _tarIsGnu;
}

function buildTarball() {
  head('Building server tarball');
  if (fs.existsSync(TARBALL)) fs.unlinkSync(TARBALL);
  // --exclude must come before the file list. Keep this list in sync with
  // DEPLOY.md §"Automated deploy". run() quotes any arg with glob/special chars,
  // so the '*.apk' excludes reach tar literally instead of being expanded by cmd.
  const args = ['-czf', TARBALL];
  if (tarIsGnu()) args.push('--force-local');
  args.push(
    '--exclude=node_modules', '--exclude=.git', '--exclude=.claude',
    '--exclude=android', '--exclude=www',
    '--exclude=*.apk', '--exclude=*.aab', '--exclude=*.keystore', '--exclude=*.jks',
    // NEVER ship secrets or the account store: server/.env holds API keys, and
    // server/data holds users.json (password hashes) + .secret (token key). The VPS
    // keeps its own .env and uses DATA_DIR=/var/lib/convoy, so excluding these both
    // protects the secrets and leaves the box's real files untouched on extract.
    '--exclude=server/.env', '--exclude=server/data', '--exclude=*.secret',
    '--exclude=deploy/convoy_deploy_key', '--exclude=deploy/convoy_deploy_key.pub',
    // 'legal' is load-bearing, not documentation: server.js serves it at /terms,
    // /privacy, /notices and /delete-account, the in-app consent gate links
    // straight to those URLs, and /delete-account is the account-deletion URL
    // registered with Google Play. Leaving it out of the tarball ships a build
    // where every one of those 404s — which is a store-policy violation, not a
    // cosmetic gap.
    'index.html', 'css', 'js', 'legal', 'server', 'fonts', 'landing',
    'README.md', 'DEPLOY.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'
  );
  run('tar', args, { cwd: ROOT, label: 'tarball' });
  log('   ' + Math.round(fs.statSync(TARBALL).size / 1024) + ' KB → ' + TARBALL);
}

/* ----------------------------- build steps ----------------------------- */

// versionName must equal the web stamp's semver (cy109 → 1.0.109): the OTA
// server compares a fresh APK's versionName against the published bundle to
// decide whether the APK's builtin assets are current (server/ota.js decide()
// maps the plugin's "builtin" report onto version_build). Auto-synced here
// because a manual versionName is a step that silently desyncs the first time
// it's forgotten — and a stale one makes every fresh APK re-download assets
// it already contains.
function syncVersionName() {
  const html = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
  const st = packOta.readStamp(html);
  if (st.error) throw new Error(st.error);
  const want = packOta.versionFromStamp(st.stamp);
  const gradle = path.join(ANDROID_DIR, 'app', 'build.gradle');
  const src = fs.readFileSync(gradle, 'utf8');
  const cur = (src.match(/versionName\s+"([^"]*)"/) || [])[1];
  if (cur === want) return;
  fs.writeFileSync(gradle, src.replace(/versionName\s+"[^"]*"/, 'versionName "' + want + '"'));
  log('   versionName synced ' + (cur || '?') + ' → ' + want + ' (stamp ' + st.stamp + ')');
}

function buildApk() {
  head('Syncing web assets → www/');
  run(process.execPath, [path.join(ROOT, 'scripts', 'copy-web.js')], { label: 'copy-web' });
  syncVersionName();

  head('cap sync android');
  const [npx, npxArgs] = npmBin('cap');
  run(npx, npxArgs.concat(['sync', 'android']), { label: 'cap sync' });

  head('Building release APK');
  // assembleRelease signs with the config in android/key.properties (storeFile=
  // convoy-release.keystore). No key.properties → the build still succeeds but
  // produces an unsigned APK; we catch that in copyApk().
  run(gradlew(), ['assembleRelease'], { cwd: ANDROID_DIR, label: 'gradlew assembleRelease', live: true });
  copyApk();

  if (!NO_AAB) buildAab();
}

// The Play Console artifact. Same signing config, same version — Gradle just
// packages it as a bundle instead of an installable APK.
function buildAab() {
  head('Building release App Bundle (Play Console)');
  run(gradlew(), ['bundleRelease'], { cwd: ANDROID_DIR, label: 'gradlew bundleRelease', live: true });
  if (!fs.existsSync(AAB_OUT)) {
    throw new Error('release AAB not found at ' + AAB_OUT +
      '\n   android/key.properties + convoy-release.keystore are required to sign it.');
  }
  fs.copyFileSync(AAB_OUT, ROOT_AAB);
  const mb = (fs.statSync(AAB_OUT).size / 1048576).toFixed(1);
  log('   signed AAB (' + mb + ' MB) -> convoy.aab   (upload THIS to Play, not the APK)');
}

function copyApk() {
  if (!fs.existsSync(APK_OUT)) {
    throw new Error('release APK not found at ' + APK_OUT +
      '\n   Did the gradle build sign it? android/key.properties + convoy-release.keystore are required.');
  }
  // Copy to the repo root under BOTH names:
  //  - convoy.apk          → what the server's ALLOWED_TOP serves at /convoy.apk
  //  - Convoy-release.apk  → the human-friendly archive name already in the tree
  fs.copyFileSync(APK_OUT, ROOT_APK);
  fs.copyFileSync(APK_OUT, ROOT_APK_NAMED);
  const mb = (fs.statSync(APK_OUT).size / 1048576).toFixed(1);
  log('   signed APK (' + mb + ' MB) → convoy.apk + Convoy-release.apk');
}

/* ----------------------------- deploy steps ----------------------------- */

// Reuses deploy/deploy.js for the app+service update so this script never
// duplicates the SSH/systemd logic (and stays in lockstep with it).
function deploySite() {
  head('Deploying app to ' + HOST);
  if (!fs.existsSync(TARBALL)) {
    log('   no tarball yet — building one');
    buildTarball();
  }
  // deploy.js reads VPS_* env (already set above) and the TARBALL path.
  run(process.execPath, [DEPLOY_JS, 'update'], { label: 'deploy.js update' });
}

// Upload convoy.apk to the VPS project root so /convoy.apk serves the new build.
// Uses the same ssh2 library deploy.js already depends on, with the same VPS_*
// auth env. Returns true on success. The APK lands at /opt/convoy/convoy.apk,
// which the convoy service exposes at /convoy.apk (see ALLOWED_TOP in server.js).
async function uploadApk() {
  head('Uploading APK to site');
  if (!fs.existsSync(ROOT_APK)) throw new Error('convoy.apk missing — build it first (drop --no-apk / --skip-build)');

  let Client;
  try { Client = require(path.join(DEPLOY_DIR, 'node_modules', 'ssh2')).Client; }
  catch (e) {
    log('   ssh2 not installed in deploy/ — run: cd deploy && npm install');
    return false;
  }
  const PRIVKEY = process.env.VPS_KEY && fs.existsSync(process.env.VPS_KEY) ? fs.readFileSync(process.env.VPS_KEY) : null;
  const PASS = process.env.VPS_PASS || '';

  for (const user of USERS) {
    const ok = await tryUpload(Client, PRIVKEY, PASS, user);
    if (ok) { log('   APK live at ' + SITE_URL + '/convoy.apk'); return true; }
    log('   login as "' + user + '" failed');
  }
  return false;
}

// One attempt: connect as `user` and sftp the APK DIRECTLY to its serve path.
//
// Why not upload→/tmp + exec mv (the obvious pattern)?
//   ssh2's SFTP subsystem leaves the SSH session in a state where any subsequent
//   exec() on the same connection (or even a fresh connection to the same host
//   right after) deadlocks — the exec callback fires but the stream never emits
//   'close', hanging until ssh2's 5-min command timeout. This is reproducible
//   against the box's sshd (MaxSessions interaction). We avoid exec entirely:
//   sftp can write anywhere root can, so we land the file at the final serve path
//   and chmod it world-readable (root-uploaded files are 644 by default, which is
//   already fine, but be explicit so the convoy service user can always read it).
//   One subsystem, one connection, no follow-up command → no deadlock.
function tryUpload(Client, PRIVKEY, PASS, user) {
  return sshConnect(Client, PRIVKEY, PASS, user).then((c) => {
    if (!c) return false;
    return sftpPut(c, ROOT_APK, '/opt/convoy/convoy.apk').finally(() => { try { c.end(); } catch (e) {} });
  });
}

// Open one authenticated SSH connection as `user`. Resolves the Client or null.
function sshConnect(Client, PRIVKEY, PASS, user) {
  return new Promise((resolve) => {
    const c = new Client();
    const timer = setTimeout(() => { try { c.end(); } catch (e) {} resolve(null); }, 25000);
    c.on('ready', () => { clearTimeout(timer); resolve(c); });
    c.on('error', (e) => { log('   ssh error: ' + (e && e.message ? e.message : e)); clearTimeout(timer); try { c.end(); } catch (e2) {} resolve(null); });
    const cfg = { host: HOST, port: 22, username: user, readyTimeout: 25000 };
    if (PRIVKEY) cfg.privateKey = PRIVKEY;
    if (PASS) {
      cfg.password = PASS; cfg.tryKeyboard = true;
      c.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => PASS)));
    }
    try { c.connect(cfg); } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

// sftp.fastPut to the final path, then chmod 644 so the convoy service user can
// read-serve it. Resolves true/false.
function sftpPut(c, local, remote) {
  return new Promise((resolve) => {
    c.sftp((err, sftp) => {
      if (err) { log('   sftp error: ' + err.message); return resolve(false); }
      sftp.fastPut(local, remote, (putErr) => {
        if (putErr) { log('   upload error: ' + putErr.message); return resolve(false); }
        sftp.chmod(remote, 0o644, (modeErr) => {
          if (modeErr) log('   chmod warning: ' + modeErr.message); // non-fatal — 644 is usually default
          resolve(true);
        });
      });
    });
  });
}

// A non-root VPS_USER needs sudo to write under /opt/convoy; root doesn't.
// (Kept for clarity; the sftp-direct path above works for both since sftp honors
// the authenticated user's filesystem permissions.)
function isRoot(user) { return user === 'root'; }

/* ----------------------------- OTA channel ----------------------------- */

// Where the convoy service's DATA_DIR lives on the box (Environment=DATA_DIR
// in deploy/convoy.service). The OTA files land beside the telemetry
// stores; server/ota.js picks the manifest up per-request on mtime change, so
// an OTA push never needs the systemd restart that a site deploy does.
const OTA_DIR_REMOTE = process.env.OTA_DIR_REMOTE || '/opt/convoy/server/data/ota';

// Upload files[] in ORDER over one SSH connection. Order is the atomicity:
// callers put the bundle zip before the manifest so an interrupted push leaves
// the channel serving the previous version rather than pointing at a zip that
// isn't there yet.
async function uploadOtaFiles(files) {
  let Client;
  try { Client = require(path.join(DEPLOY_DIR, 'node_modules', 'ssh2')).Client; }
  catch (e) {
    log('   ssh2 not installed in deploy/ — run: cd deploy && npm install');
    return false;
  }
  const PRIVKEY = process.env.VPS_KEY && fs.existsSync(process.env.VPS_KEY) ? fs.readFileSync(process.env.VPS_KEY) : null;
  const PASS = process.env.VPS_PASS || '';

  for (const user of USERS) {
    const ok = await new Promise((resolve) => {
      sshConnect(Client, PRIVKEY, PASS, user).then((c) => {
        if (!c) return resolve(false);
        c.on('error', () => { try { c.end(); } catch (e5) {} resolve(false); });
        c.sftp((err, sftp) => {
          if (err) { log('   sftp error: ' + err.message); try { c.end(); } catch (e2) {} return resolve(false); }
          // mkdir is idempotent-by-ignore: EEXIST is the normal case.
          sftp.mkdir(OTA_DIR_REMOTE, () => {
            (function next(i) {
              if (i >= files.length) { try { c.end(); } catch (e3) {} return resolve(true); }
              const f = files[i];
              sftp.fastPut(f.local, f.remote, (putErr) => {
                if (putErr) {
                  log('   upload error: ' + f.remote + ': ' + putErr.message);
                  try { c.end(); } catch (e4) {}
                  return resolve(false);
                }
                // The convoy service user must be able to read what root uploaded.
                sftp.chmod(f.remote, 0o644, () => {
                  log('   uploaded ' + path.basename(f.remote));
                  next(i + 1);
                });
              });
            })(0);
          });
        });
      });
    });
    if (ok) return true;
    log('   login as "' + user + '" failed');
  }
  return false;
}

// The hotfix command: pack the bundle, ship the SITE (web riders get the same
// fix from the repo-root statics on reload), then publish the OTA pair. The
// service restart from deploySite is harmless here — the OTA manifest itself
// would have gone live without it.
async function pushOta() {
  head('Packing OTA bundle');
  const res = await packOta.pack({ force: OTA_FORCE, offline: OTA_OFFLINE });
  log('   v' + res.version + ' (stamp ' + res.stamp + ')  ' + Math.round(res.zipBytes / 1024) + ' KB  sha256 ' + res.sha256.slice(0, 12) + '…');

  head('Deploying app to ' + HOST);
  buildTarball();
  deploySite();

  head('Publishing OTA bundle → ' + OTA_DIR_REMOTE);
  const ok = await uploadOtaFiles([
    { local: res.zipPath, remote: OTA_DIR_REMOTE + '/' + path.basename(res.zipPath) },
    { local: res.manifestPath, remote: OTA_DIR_REMOTE + '/manifest.json' }
  ]);
  if (!ok) throw new Error('OTA upload failed — see messages above');
  log('   live — APKs pick it up on their next app open (no service restart)');
}

// The OTA channel's own kill switch: repoint the manifest at the previous
// bundle. Devices still on the bad version are force-moved down (a rollback
// is by definition not "newer", hence force:true in the manifest we write).
// Only the manifest travels — the previous zip is already on the box.
async function rollbackOta() {
  head('Rolling the OTA channel back');
  const res = await packOta.fetchPublished(SITE_URL);
  if (!res.ok || !res.body) throw new Error('could not read ' + SITE_URL + '/api/ota (' + (res.error || res.status) + ')');
  const pub = res.body;
  if (!pub.current) throw new Error('the channel has no bundle published — nothing to roll back from');
  const prev = packOta.rollbackTarget(pub);
  if (!prev) throw new Error('no previous bundle in the manifest history — the bad one was the first push');
  const manifest = {
    version: prev.version,
    file: prev.file,
    checksum: prev.checksum,
    size: prev.size,
    note: 'rollback from ' + pub.current.version,
    force: true,
    // The bundle being abandoned drops OUT of history: its zip stops resolving
    // (/ota/<file> serves manifest-vouched names only), so nobody can stumble
    // back onto it with a later rollback.
    history: (pub.history || []).filter((h) => h.version !== prev.version).slice(0, 10)
  };
  const tmp = path.join(os.tmpdir(), 'convoy-ota-rollback.json');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  log('   v' + pub.current.version + ' → v' + prev.version + ' (forced)');
  const ok = await uploadOtaFiles([{ local: tmp, remote: OTA_DIR_REMOTE + '/manifest.json' }]);
  if (!ok) throw new Error('rollback manifest upload failed — see messages above');
  log('   live — devices on v' + pub.current.version + ' are moved back on next app open');
}

/* ----------------------------- health checks ----------------------------- */

async function health() {
  head('Health check');
  // SITE_URL is the public domain (Caddy's cert is for the domain, not the raw
  // IP — probing https://<IP>/ fails TLS SNI). Probe the app root and the APK
  // route so a half-deploy (site up, APK missing) shows up plainly.
  //
  // The legal routes are checked too, and they are not padding. They live in a
  // directory the tarball's file list has to name explicitly, so forgetting one
  // line there deploys a site where /terms and /privacy 404 — which is what
  // happened the first time legal/ shipped. Probing only / and /convoy.apk
  // reported that release as healthy. These four are also the URLs the in-app
  // consent gate links to and the one Google Play holds on file for account
  // deletion, so a 404 here is a store-policy failure, not a broken link.
  const checks = [
    { name: 'site', url: SITE_URL + '/' },
    { name: 'APK download', url: SITE_URL + '/convoy.apk' },
    { name: 'OTA channel', url: SITE_URL + '/api/ota' },
    { name: 'terms', url: SITE_URL + '/terms' },
    { name: 'privacy policy', url: SITE_URL + '/privacy' },
    { name: 'account deletion', url: SITE_URL + '/delete-account' },
    { name: 'third-party notices', url: SITE_URL + '/notices' }
  ];
  let allOk = true;
  for (const c of checks) {
    const res = await probe(c.url);
    const ok = !!res.status && res.status < 400;
    allOk = allOk && ok;
    log('   ' + (ok ? '✓' : '✗') + ' ' + c.name + ' → ' + c.url + ' : ' + (res.status || res.error));
  }
  return allOk;
}

/* ----------------------------- main ----------------------------- */

(async () => {
  const t0 = Date.now();

  // The OTA modes are their own lanes: no APK build, and --rollback touches
  // nothing in the tree at all.
  if (ROLLBACK) {
    log('Convoy OTA rollback → ' + HOST);
    await rollbackOta();
  } else if (OTA) {
    log('Convoy OTA hotfix → ' + HOST + '  (site + bundle, no APK build)');
    await pushOta();
  } else {
    log('Convoy release → ' + HOST + (NO_APK ? '  (site only)' : NO_SITE ? '  (APK only)' : ''));

    // APK build + copy (skippable)
    if (!NO_APK) {
      if (SKIP_BUILD && fs.existsSync(ROOT_APK)) {
        head('Reusing existing convoy.apk (--skip-build)');
        log('   ' + Math.round(fs.statSync(ROOT_APK).size / 1048576) + ' MB');
      } else {
        buildApk();
      }
    }

    // Site deploy (skippable)
    if (!NO_SITE) {
      if (!SKIP_BUILD || !fs.existsSync(TARBALL)) buildTarball();
      deploySite();
      if (!NO_APK) {
        const ok = await uploadApk();
        if (!ok) throw new Error('APK upload failed — see messages above');
      }
    }
  }

  // Only verify what we actually shipped. --no-site built/deployed nothing, so a
  // health probe would test the OLD live build and report a misleading result.
  // The OTA lanes always deployed something channel-shaped, so they probe.
  let ok = true;
  if (!NO_SITE || OTA || ROLLBACK) ok = await health();
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('\n' + (ok ? '✓ Released in ' : '✗ Finished with errors in ') + secs + 's');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('\nRelease failed: ' + e.message);
  process.exit(1);
});
