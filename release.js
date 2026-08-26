#!/usr/bin/env node
/* Convoy — one-shot release script.

   Builds everything locally, then ships it to the VPS in a single pass:
     1. Sync web assets into www/ (for the Capacitor shell)
     2. cap sync android  (wire www/ + plugins into the Android project)
     3. Build the signed release APK  (gradlew assembleRelease)
     4. Copy the APK to the repo root as convoy.apk (+ Convoy-release.apk)
        so the server's /convoy.apk download route serves the new build
     5. Build the server tarball
     6. deploy.js update  (upload app files + restart the convoy service)
     7. Upload convoy.apk to the VPS project root (/opt/convoy/convoy.apk)
     8. Health-check the public site + the APK download URL

   Run it from the project root:

       node release.js                 # full release (APK + site)
       node release.js --no-apk        # site only, skip the APK build/upload
       node release.js --no-site       # APK only, skip the site deploy
       node release.js --skip-build    # reuse the APK already at ./convoy.apk
                                       # and the tarball at %TEMP%/convoy.tgz

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
const NO_SITE = flag('--no-site');
const SKIP_BUILD = flag('--skip-build');

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
    '--exclude=*.apk', '--exclude=*.keystore', '--exclude=*.jks',
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
    'index.html', 'css', 'js', 'legal', 'server',
    'README.md', 'DEPLOY.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'
  );
  run('tar', args, { cwd: ROOT, label: 'tarball' });
  log('   ' + Math.round(fs.statSync(TARBALL).size / 1024) + ' KB → ' + TARBALL);
}

/* ----------------------------- build steps ----------------------------- */

function buildApk() {
  head('Syncing web assets → www/');
  run(process.execPath, [path.join(ROOT, 'scripts', 'copy-web.js')], { label: 'copy-web' });

  head('cap sync android');
  const [npx, npxArgs] = npmBin('cap');
  run(npx, npxArgs.concat(['sync', 'android']), { label: 'cap sync' });

  head('Building release APK');
  // assembleRelease signs with the config in android/key.properties (storeFile=
  // convoy-release.keystore). No key.properties → the build still succeeds but
  // produces an unsigned APK; we catch that in copyApk().
  run(gradlew(), ['assembleRelease'], { cwd: ANDROID_DIR, label: 'gradlew assembleRelease', live: true });
  copyApk();
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

/* ----------------------------- health checks ----------------------------- */

async function health() {
  head('Health check');
  // SITE_URL is the public domain (Caddy's cert is for the domain, not the raw
  // IP — probing https://<IP>/ fails TLS SNI). Probe the app root and the APK
  // route so a half-deploy (site up, APK missing) shows up plainly.
  const checks = [
    { name: 'site', url: SITE_URL + '/' },
    { name: 'APK download', url: SITE_URL + '/convoy.apk' }
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

  // Only verify what we actually shipped. --no-site built/deployed nothing, so a
  // health probe would test the OLD live build and report a misleading result.
  let ok = true;
  if (!NO_SITE) ok = await health();
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('\n' + (ok ? '✓ Released in ' : '✗ Finished with errors in ') + secs + 's');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('\nRelease failed: ' + e.message);
  process.exit(1);
});
