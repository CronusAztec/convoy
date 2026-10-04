/* Convoy — VPS deployer (run from your PC)

   Usage:
     set env VPS_HOST, VPS_PASS (and optionally VPS_USER, VPS_PUBKEY, TARBALL), then:
       node deploy.js          → full install (node, service user, systemd, firewall)
       node deploy.js update   → push app files + restart service

   Notes:
     - Never logs the password.
     - VPS_USER may be a comma list of logins to try (e.g. "root,ubuntu").
       Non-root logins are wrapped with sudo automatically.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client } = require('ssh2');
const WebSocket = require('ws');

const HOST = process.env.VPS_HOST;
const PASS = process.env.VPS_PASS;
const KEYFILE = process.env.VPS_KEY || ''; // private key for passwordless deploys
const USERS = (process.env.VPS_USER || 'root').split(',').map((s) => s.trim());
const PUBKEY_PATH = process.env.VPS_PUBKEY || '';
const TARBALL = process.env.TARBALL || path.join(os.tmpdir(), 'convoy.tgz');
const MODE = process.argv[2] === 'update' ? 'update' : 'full';

if (!HOST || (!PASS && !KEYFILE)) {
  console.error('Set VPS_HOST and either VPS_PASS or VPS_KEY (private key path) first.');
  process.exit(1);
}
const PRIVKEY = KEYFILE && fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE) : null;
if (!fs.existsSync(TARBALL)) {
  console.error('App bundle not found: ' + TARBALL + ' — build it with tar first.');
  process.exit(1);
}

let conn = null;
let USER = null;

function connect(user) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    if (PASS) c.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => PASS)));
    const cfg = { host: HOST, port: 22, username: user, readyTimeout: 25000 };
    if (PRIVKEY) cfg.privateKey = PRIVKEY;
    if (PASS) { cfg.password = PASS; cfg.tryKeyboard = true; }
    c.connect(cfg);
  });
}

function run(cmd, opts) {
  opts = opts || {};
  const wrapped = (USER === 'root' || opts.nosudo)
    ? cmd
    : 'sudo -S -p "" bash -c ' + JSON.stringify(cmd);
  return new Promise((resolve, reject) => {
    conn.exec(wrapped, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      if (USER !== 'root' && !opts.nosudo) stream.write(PASS + '\n');
      stream.on('close', (code) => resolve({ code: code == null ? 0 : code, out, err: errOut }));
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errOut += d; });
    });
  });
}

const indent = (s) => s.trim().split('\n').map((l) => '    ' + l).join('\n');

async function step(label, cmd, opts) {
  opts = opts || {};
  process.stdout.write('-> ' + label + ' ... ');
  const r = await run(cmd, opts);
  if (r.code !== 0 && !opts.allowFail) {
    console.log('FAILED (exit ' + r.code + ')');
    if (r.out.trim()) console.log(indent(r.out.slice(-1500)));
    if (r.err.trim()) console.log(indent(r.err.slice(-1500)));
    throw new Error(label + ' failed');
  }
  console.log(r.code === 0 ? 'ok' : 'exit ' + r.code + ' (ignored)');
  if (!opts.quiet && r.out.trim()) console.log(indent(r.out.slice(-1200)));
  return r;
}

function upload(local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function unitFile(port, user, nodeBin) {
  const needCaps = user !== 'root' && port < 1024;
  return [
    '[Unit]',
    'Description=Convoy realtime server (riders, convoys, chat)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'User=' + user,
    'WorkingDirectory=/opt/convoy/server',
    'ExecStart=' + nodeBin + ' /opt/convoy/server/server.js',
    'Environment=PORT=' + port,
    'Environment=BOTS=12',
    'Environment=NEARBY_KM=30',
    // Supabase credentials (accounts + identity). REQUIRED — the server exits at
    // boot without it — but it still uses '-' so a missing file surfaces as the
    // server's own clear error message rather than a systemd unit failure with
    // nothing useful in the log.
    'EnvironmentFile=-/var/lib/convoy/convoy.env',
    needCaps ? 'AmbientCapabilities=CAP_NET_BIND_SERVICE' : null,
    needCaps ? 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE' : null,
    'Restart=always',
    'RestartSec=3',
    'NoNewPrivileges=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].filter((l) => l !== null).join('\n');
}

const SUPABASE_VARS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL'];
const SUPABASE_OPTIONAL = ['SUPABASE_JWT_SECRET', 'AUTH_EMAIL_DOMAIN', 'SUPABASE_DB_CA'];

function localEnv() {
  const out = {};
  try {
    const p = path.join(__dirname, '..', 'server', '.env');
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* no local .env — ambient env only */ }
  SUPABASE_VARS.concat(SUPABASE_OPTIONAL).forEach((k) => {
    if (process.env[k]) out[k] = process.env[k];
  });
  return out;
}

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// A value copied from .env.example but not actually filled in. Treating one of
// these as real would push a broken credential and restart the server into the
// crash loop this whole check exists to prevent — so they count as unset.
function looksUnset(v) {
  if (!v) return true;
  const s = String(v).trim();
  if (!s) return true;
  return /\[YOUR-PASSWORD\]|\bPASSWORD\b|<[^>]*>|\byour[-_]|\bchangeme\b|\bxxx+\b/i.test(s);
}

// Decided once by checkSupabaseEnv(), acted on later by provisionSupabaseEnv().
let supabasePlan = null;   // { write: bool, env: {...} }

// Runs before ANY upload. Either the credentials are available locally (we'll
// push them), or the box already has them (leave it alone), or neither is true —
// in which case restarting the service would take the site down, so we stop now
// while the server is still untouched.
async function checkSupabaseEnv() {
  const env = localEnv();
  const have = SUPABASE_VARS.filter((k) => !looksUnset(env[k]));
  const missing = SUPABASE_VARS.filter((k) => looksUnset(env[k]));
  // Distinguish "never filled in" from "filled in with the example placeholder",
  // because the fix is different and the second one is easy to stare past.
  const placeholders = missing.filter((k) => env[k]);

  if (!missing.length) {
    console.log('-> Supabase env: pushing ' + have.length + ' values from server/.env');
    supabasePlan = { write: true, env: env };
    return;
  }

  const probe = await run(
    'if [ -s /var/lib/convoy/convoy.env ] && grep -q "^SUPABASE_SECRET_KEY=." /var/lib/convoy/convoy.env; ' +
    'then echo configured; else echo missing; fi', { allowFail: true });
  if ((probe.out || '').indexOf('configured') >= 0) {
    console.log('-> Supabase env: already on the server, leaving it untouched' +
      (have.length ? ' (locally set: ' + have.join(', ') + ')' : ''));
    supabasePlan = { write: false };
    return;
  }

  console.error('');
  console.error('  DEPLOY ABORTED — nothing was uploaded, the site is untouched.');
  console.error('');
  console.error('  Convoy keeps accounts in Supabase, and server.js exits at boot');
  console.error('  without these. They are set neither locally nor on the VPS:');
  missing.forEach((k) => console.error('      ' + k +
    (placeholders.indexOf(k) >= 0 ? '   <- still the example placeholder, not a real value' : '')));
  console.error('');
  console.error('  Fill them in server/.env (see server/.env.example) and re-run.');
  console.error('  Deploying without them would restart the service into a crash');
  console.error('  loop and take https://odoreeci.tech offline.');
  console.error('');
  throw new Error('Supabase configuration missing: ' + missing.join(', '));
}

async function provisionSupabaseEnv() {
  if (!supabasePlan || !supabasePlan.write) return;   // already configured on the box
  const env = supabasePlan.env;

  const lines = SUPABASE_VARS.concat(SUPABASE_OPTIONAL)
    .filter((k) => env[k])
    .map((k) => k + '=' + env[k]);

  // Written with printf over the existing SSH session rather than uploaded as a
  // file, so the secrets never touch a temp file on either machine. Permissions
  // are set before the content lands.
  const svc = await run('grep -oP "^User=\\K\\S+" /etc/systemd/system/convoy.service | head -1',
    { allowFail: true });
  const owner = (svc.out || '').trim() || 'convoy';
  /* MERGE, never truncate.

     This file is the only place a production-only secret can live: ADMIN_TOKEN
     (the control panel), APP_URL, an API key rotated on the box and nowhere
     else. Those are set by hand on the server precisely BECAUSE they should
     not sit in a developer's local .env — and a deploy that rewrites the file
     with `>` silently deletes every one of them. The symptom is delightful:
     the deploy succeeds, health checks pass, and some feature is just gone.

     So: keep every line whose key we are not about to write, drop the stale
     copies of the keys we ARE writing, then append ours. The temp file is
     created 0600 before any secret lands in it, and the rename is atomic so a
     reader never sees a half-written file. */
  const managed = SUPABASE_VARS.concat(SUPABASE_OPTIONAL);
  const keyRe = '^(' + managed.join('|') + ')=';
  await step('Supabase credentials (/var/lib/convoy/convoy.env)',
    'mkdir -p /var/lib/convoy && ' +
    'F=/var/lib/convoy/convoy.env; T=$F.tmp; ' +
    'install -m 600 /dev/null "$T" && ' +
    // Preserve everything this deploy does not manage.
    'if [ -f "$F" ]; then grep -vE ' + shq(keyRe) + ' "$F" >> "$T" || true; fi && ' +
    'printf "%s\\n" ' + lines.map(shq).join(' ') + ' >> "$T" && ' +
    'chown ' + owner + ':' + owner + ' "$T" 2>/dev/null; ' +
    'mv "$T" "$F" && ' +
    'echo "$(grep -c . "$F") vars, mode $(stat -c %a "$F")"');

  // An already-installed unit (update mode) won't have the EnvironmentFile line
  // that unitFile() now emits. Insert it idempotently so the restart picks it up.
  await step('ensure the service loads convoy.env',
    "grep -q 'EnvironmentFile=-/var/lib/convoy/convoy.env' /etc/systemd/system/convoy.service || " +
    "sed -i '/^\\[Service\\]/a EnvironmentFile=-/var/lib/convoy/convoy.env' /etc/systemd/system/convoy.service; " +
    'systemctl daemon-reload; echo ok', { quiet: true });
}

function checkHttp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      console.log('-> public http ' + url + ' : ' + res.statusCode + (res.statusCode === 200 ? ' OK' : ''));
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); console.log('-> public http ' + url + ' : TIMEOUT'); resolve(false); });
    req.on('error', (e) => { console.log('-> public http ' + url + ' : FAILED (' + e.message + ')'); resolve(false); });
  });
}

function checkWs(host, port) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://' + host + ':' + port + '/ws');
    const to = setTimeout(() => {
      console.log('-> public websocket: TIMEOUT');
      try { ws.terminate(); } catch (e) { }
      resolve(false);
    }, 9000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'hello', pos: [-118.25, 34.05], heading: 0,
        profile: {
          name: 'DeployCheck', handle: 'deploy', emoji: '🛰️', vibe: 'Road trip!',
          car: { year: 2026, make: 'Tesla', model: 'Model 3', paint: '#4f8cff', paintName: 'Pulse Blue', finish: 'Gloss' }
        }
      }));
    });
    ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d); } catch (e) { return; }
      if (m.t === 'welcome') {
        console.log('-> public websocket: OK — welcome received, ' + (m.riders || []).length +
          ' riders visible, online=' + m.online);
        clearTimeout(to);
        ws.close();
        resolve(true);
      }
    });
    ws.on('error', (e) => {
      console.log('-> public websocket: FAILED (' + e.message + ')');
      clearTimeout(to);
      resolve(false);
    });
  });
}

(async () => {
  for (const u of USERS) {
    try {
      conn = await connect(u);
      USER = u;
      break;
    } catch (e) {
      console.log('login as "' + u + '" failed: ' + e.message);
    }
  }
  if (!conn) {
    console.error('Could not log in to ' + HOST + ' with any of: ' + USERS.join(', '));
    process.exit(2);
  }
  console.log('Connected to ' + HOST + ' as ' + USER + '  (mode: ' + MODE + ')');

  // Check the Supabase credentials BEFORE anything is uploaded or overwritten.
  // Aborting later would leave /opt/convoy holding new code that the running
  // (old) process hasn't loaded — fine until the next restart, then a crash loop.
  await checkSupabaseEnv();

  await upload(TARBALL, '/tmp/convoy.tgz');
  console.log('-> uploaded app bundle (' + Math.round(fs.statSync(TARBALL).size / 1024) + ' KB)');

  if (MODE === 'full') {
    await step('prerequisites (curl, tar)',
      'command -v curl >/dev/null || (apt-get -o DPkg::Lock::Timeout=180 update -qq && apt-get -o DPkg::Lock::Timeout=180 install -y -qq curl)',
      { quiet: true });
    await step('service user "convoy"',
      'id -u convoy >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin convoy', { quiet: true });
    await step('stop existing service (if running)',
      'systemctl stop convoy 2>/dev/null || true', { quiet: true, allowFail: true });
    // The box may ship Node only under /root (mode 700) — unreachable by an unprivileged
    // user. Ensure a world-accessible /usr/bin/node so the service can run unprivileged.
    await step('ensure system Node at /usr/bin/node',
      'if [ ! -x /usr/bin/node ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; ' +
      'DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y -qq nodejs >/dev/null 2>&1 || true; fi; ' +
      '(/usr/bin/node -v 2>/dev/null || echo "no /usr/bin/node yet")');
  }

  await step('extract app to /opt/convoy',
    'mkdir -p /opt/convoy && tar -xzf /tmp/convoy.tgz -C /opt/convoy && rm -f /tmp/convoy.tgz', { quiet: true });
  await step('install server dependency',
    'cd /opt/convoy/server && npm install --omit=dev --no-fund --no-audit 2>&1 | tail -1');
  await step('ownership', 'chown -R convoy:convoy /opt/convoy', { quiet: true });

  /* ---------------- Supabase credentials ----------------
     Accounts and identity live in Supabase, and the server exits at boot without
     these. The tarball deliberately excludes server/.env, so they have to reach
     the box some other way: a 0600 EnvironmentFile in /var/lib/convoy, outside
     the app tree, so no deploy can overwrite or ship it.

     This runs BEFORE the service restart below. Getting that order wrong would
     restart the server into a crash loop and take the site down until the file
     landed. */
  await provisionSupabaseEnv();

  let port = 80;
  let svcUser = null, nodeBin = null; // known after full mode; grepped back in update mode
  if (MODE === 'full') {
    const busy = await run('ss -tlnH 2>/dev/null | awk \'{print $4}\' | grep -qE ":80$" && echo busy || echo free');
    if (busy.out.indexOf('busy') >= 0) port = 5173;
    console.log('-> serving on port ' + port);

    // Prefer an unprivileged user with a world-accessible node; fall back to root otherwise.
    const dec = await run(
      'if [ -x /usr/bin/node ] && sudo -u convoy /usr/bin/node -v >/dev/null 2>&1; then echo "user=convoy bin=/usr/bin/node"; ' +
      'else echo "user=root bin=$(command -v node || echo /usr/local/bin/node)"; fi');
    const dm = /user=(\S+)\s+bin=(\S+)/.exec(dec.out) || [];
    svcUser = dm[1] || 'root';
    nodeBin = dm[2] || '/usr/bin/node';
    console.log('-> service runs as "' + svcUser + '" using ' + nodeBin +
      (svcUser === 'root' ? '  (unprivileged user could not reach a node binary)' : ''));

    const tmpUnit = path.join(os.tmpdir(), 'convoy.service.tmp');
    fs.writeFileSync(tmpUnit, unitFile(port, svcUser, nodeBin));
    await upload(tmpUnit, '/tmp/convoy.service');
    fs.unlinkSync(tmpUnit);
    await step('systemd service',
      'mv /tmp/convoy.service /etc/systemd/system/convoy.service && ' +
      'systemctl daemon-reload && systemctl enable convoy >/dev/null 2>&1; systemctl restart convoy', { quiet: true });

    const ufw = await run('ufw status 2>/dev/null | head -1', { allowFail: true });
    if (ufw.out.indexOf('active') >= 0) {
      await step('firewall: allow port ' + port, 'ufw allow ' + port + '/tcp', { quiet: true });
    } else {
      console.log('-> ufw inactive — no host firewall to open');
    }
  } else {
    const p = await run('grep -oP "PORT=\\K[0-9]+" /etc/systemd/system/convoy.service | head -1');
    port = parseInt(p.out.trim(), 10) || 80;
    await step('restart service', 'systemctl restart convoy', { quiet: true });
  }

  // Retire the data collectors that older deploys installed beside the server
  // (the police finder and, before it, the hotspot collector). Their scripts no
  // longer ship, so a unit left enabled would just restart-loop against a
  // missing file. Idempotent: a box that never had them is a no-op.
  await step('retire retired collector services',
    'systemctl disable --now convoy-police-finder 2>/dev/null || true; ' +
    'systemctl disable --now convoy-collector 2>/dev/null || true; ' +
    'rm -f /etc/systemd/system/convoy-police-finder.service /etc/systemd/system/convoy-collector.service; ' +
    'systemctl daemon-reload || true',
    { quiet: true, allowFail: true });

  if (PUBKEY_PATH && fs.existsSync(PUBKEY_PATH)) {
    const key = fs.readFileSync(PUBKEY_PATH, 'utf8').trim();
    const keyBody = key.split(' ')[1];
    await step('install deploy SSH key for ' + USER,
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
      'grep -qF "' + keyBody + '" ~/.ssh/authorized_keys 2>/dev/null || echo "' + key + '" >> ~/.ssh/authorized_keys; ' +
      'chmod 600 ~/.ssh/authorized_keys',
      { quiet: true, nosudo: true, allowFail: true });
  }

  await step('service health',
    'sleep 3; echo "convoy: $(systemctl is-active convoy)"; ' +
    'curl -s -m 6 -o /dev/null -w "local http: %{http_code}\\n" http://127.0.0.1:' + port + '/ ; ' +
    'echo "--- convoy ---"; journalctl -u convoy -n 5 --no-pager --output=cat', { allowFail: true });

  conn.end();

  console.log('');
  const url = 'http://' + HOST + (port === 80 ? '' : ':' + port) + '/';
  const httpOk = await checkHttp(url);
  const wsOk = await checkWs(HOST, port);

  console.log('');
  if (httpOk && wsOk) {
    console.log('DEPLOYED & PUBLICLY REACHABLE → ' + url);
  } else if (!httpOk) {
    console.log('Deployed, but ' + url + ' is not reachable from outside.');
    console.log('If the service is healthy above, your provider has a cloud firewall —');
    console.log('open TCP port ' + port + ' in their control panel and re-test.');
  } else {
    console.log('HTTP is up but the websocket failed — check `journalctl -u convoy -f` on the VPS.');
  }
})().catch((e) => {
  console.error('Deploy aborted: ' + e.message);
  process.exit(3);
});
