/* Convoy — turn on HTTPS via Caddy (run from your PC, AFTER the DNS A record is added).

   Usage (PowerShell):
     cd deploy
     $env:VPS_HOST='2.25.184.90'; $env:VPS_USER='root'
     $env:VPS_KEY="$PWD\convoy_deploy_key"     # or $env:VPS_PASS='...'
     $env:DOMAIN='convoy.yourdomain.com'
     node setup-https.js

   It will:
     1. Verify DOMAIN's A record already points at VPS_HOST (aborts otherwise).
     2. Move the Convoy service to an internal port (5173).
     3. Install Caddy and write a Caddyfile (DOMAIN -> reverse_proxy localhost:5173).
     4. Open 80/443, close 5173 to the outside.
     5. Wait for the certificate and verify https + wss from your machine.
*/
'use strict';

const fs = require('fs');
const dnsmod = require('dns');
const https = require('https');

// Resolve against PUBLIC resolvers (what Let's Encrypt sees), not this machine's
// local/ISP resolver — which may have a stale negative cache for a freshly-added record.
function resolve4Public(name) {
  const tries = [['1.1.1.1', '1.0.0.1'], ['8.8.8.8', '8.8.4.4'], null];
  return (async () => {
    for (const srv of tries) {
      try {
        const r = new dnsmod.promises.Resolver({ timeout: 5000, tries: 1 });
        if (srv) r.setServers(srv);
        const ips = await r.resolve4(name);
        if (ips && ips.length) return ips;
      } catch (e) { /* try next resolver */ }
    }
    return [];
  })();
}
const { Client } = require('ssh2');
const WebSocket = require('ws');

const HOST = process.env.VPS_HOST;
const PASS = process.env.VPS_PASS;
const KEYFILE = process.env.VPS_KEY || '';
const USER = (process.env.VPS_USER || 'root').split(',')[0].trim();
const DOMAIN = (process.env.DOMAIN || '').trim().toLowerCase();
const INTERNAL_PORT = 5173;

if (!HOST || (!PASS && !KEYFILE) || !DOMAIN) {
  console.error('Set VPS_HOST, DOMAIN, and VPS_KEY (or VPS_PASS).');
  process.exit(1);
}
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(DOMAIN)) {
  console.error('DOMAIN "' + DOMAIN + '" does not look like a hostname (e.g. convoy.example.com).');
  process.exit(1);
}
const PRIVKEY = KEYFILE && fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE) : null;

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    if (PASS) c.on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => PASS)));
    const cfg = { host: HOST, port: 22, username: USER, readyTimeout: 25000 };
    if (PRIVKEY) cfg.privateKey = PRIVKEY;
    if (PASS) { cfg.password = PASS; cfg.tryKeyboard = true; }
    c.connect(cfg);
  });
}

function runB64(conn, script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = 'bash -c "$(echo ' + b64 + ' | base64 -d)"';
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errp = '';
      stream.on('close', (code) => resolve({ code: code == null ? 0 : code, out, err: errp }));
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errp += d; });
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'convoy' } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function checkWss(domain) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://' + domain + '/ws');
    const to = setTimeout(() => { try { ws.terminate(); } catch (e) {} resolve(false); }, 12000);
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'hello', pos: [-118.25, 34.05], heading: 0,
      profile: { name: 'HttpsCheck', handle: 'https', emoji: '🔒', vibe: 'Road trip!',
        car: { year: 2026, make: 'Tesla', model: 'Model 3', paint: '#4f8cff', paintName: 'Pulse Blue', finish: 'Gloss' } }
    })));
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.t === 'welcome') { clearTimeout(to); ws.close(); resolve(m); }
    });
    ws.on('error', () => { clearTimeout(to); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const caddySetup = (domain, port, includeWww) => `
set -e
echo "== reconfigure convoy -> internal port ${port} =="
sed -i 's/^Environment=PORT=.*/Environment=PORT=${port}/' /etc/systemd/system/convoy.service
sed -i '/AmbientCapabilities=CAP_NET_BIND_SERVICE/d;/CapabilityBoundingSet=CAP_NET_BIND_SERVICE/d' /etc/systemd/system/convoy.service
systemctl daemon-reload
systemctl restart convoy
echo "== install Caddy (if missing) =="
if ! command -v caddy >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get -o DPkg::Lock::Timeout=180 update -qq >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y -qq caddy >/dev/null 2>&1
fi
caddy version
echo "== write Caddyfile =="
cat > /etc/caddy/Caddyfile <<EOF
${domain} {
    encode zstd gzip
    reverse_proxy localhost:${port}
}
${includeWww ? 'www.' + domain + ' {\n    redir https://' + domain + '{uri} permanent\n}\n' : ''}EOF
systemctl restart caddy
echo "== firewall =="
if ufw status 2>/dev/null | grep -q active; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw deny ${port}/tcp >/dev/null
  echo "ufw: 80,443 open; ${port} closed externally"
else
  echo "ufw inactive — relying on provider firewall (ensure 80,443 open there)"
fi
echo "DONE"
`;

(async () => {
  // 1. DNS precheck
  process.stdout.write('-> DNS (public resolvers): resolving ' + DOMAIN + ' ... ');
  let ips = await resolve4Public(DOMAIN);
  console.log(ips.length ? ips.join(', ') : '(no A record yet)');
  if (ips.indexOf(HOST) === -1) {
    console.log('\nDNS is not pointing at ' + HOST + ' yet.');
    console.log('Add an A record  ' + DOMAIN + ' -> ' + HOST + '  in Hostinger, then wait a few minutes and re-run.');
    console.log('(Propagation is usually quick but can take up to ~30 min on a fresh record.)');
    process.exit(2);
  }
  console.log('-> DNS OK — ' + DOMAIN + ' points at ' + HOST);

  // include a www -> apex redirect only for apex domains where www also resolves here
  let includeWww = false;
  if (DOMAIN.split('.').length === 2) {
    includeWww = (await resolve4Public('www.' + DOMAIN)).indexOf(HOST) !== -1;
    console.log('-> www.' + DOMAIN + (includeWww ? ' also points here → will redirect www → apex' : ' not pointing here → skipping www'));
  }

  // 2-5. Caddy setup on the box
  const conn = await connect();
  console.log('-> connected to ' + HOST + ' as ' + USER);
  const r = await runB64(conn, caddySetup(DOMAIN, INTERNAL_PORT, includeWww));
  conn.end();
  console.log(r.out.trim().split('\n').map((l) => '   ' + l).join('\n'));
  if (r.code !== 0 || r.out.indexOf('DONE') === -1) {
    console.log('\nSetup step failed (exit ' + r.code + ').');
    if (r.err.trim()) console.log(r.err.slice(-1200));
    process.exit(3);
  }

  // 6. Wait for the cert + verify
  console.log('\n-> waiting for Let\'s Encrypt certificate (first issue can take ~10-40s)…');
  let httpsOk = false;
  for (let i = 0; i < 12; i++) {
    await sleep(6000);
    try {
      const res = await getJson('https://' + DOMAIN + '/');
      if (res.status === 200) { httpsOk = true; break; }
      process.stdout.write('   …status ' + res.status + ', retrying\n');
    } catch (e) { process.stdout.write('   …' + e.message + ', retrying\n'); }
  }

  if (!httpsOk) {
    console.log('\nHTTPS not answering yet. Check on the box: journalctl -u caddy -n 40 --no-pager');
    console.log('Most common cause: provider cloud-firewall is blocking 80/443 — open them and re-run.');
    process.exit(4);
  }
  console.log('-> https://' + DOMAIN + '/ : 200 OK');
  const ws = await checkWss(DOMAIN);
  if (ws) console.log('-> wss://' + DOMAIN + '/ws : OK — welcome, ' + (ws.riders || []).length + ' riders visible');
  else console.log('-> wss check did not complete (HTTPS works; check Caddy websocket proxying if this persists)');

  console.log('\n🔒 LIVE OVER HTTPS → https://' + DOMAIN + '/');
  console.log('Real phone GPS now works. Old http://' + HOST + '/ still serves too (Caddy can redirect it).');
})().catch((e) => { console.error('Aborted: ' + e.message); process.exit(5); });
