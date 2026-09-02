'use strict';
const fs = require('fs');
const { Client } = require('ssh2');
const HOST = process.env.VPS_HOST, PASS = process.env.VPS_PASS;
const KEYFILE = process.env.VPS_KEY || '';
const PRIVKEY = KEYFILE && fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE) : null;
const USER = (process.env.VPS_USER || 'root').split(',')[0].trim();
// Pass commands as base64 via B64=... to avoid all shell-quoting hazards across PS->node->ssh.
const CMD = process.env.B64
  ? 'bash -c "$(echo ' + process.env.B64 + ' | base64 -d)"'
  : (process.argv[2] || 'systemctl status convoy --no-pager -l | head -20; echo "---LOGS---"; journalctl -u convoy -n 40 --no-pager --output=cat');
const c = new Client();
c.on('ready', () => {
  c.exec(CMD, (err, s) => {
    if (err) { console.error(err); process.exit(1); }
    s.on('close', () => { c.end(); });
    s.on('data', (d) => process.stdout.write(d.toString()));
    s.stderr.on('data', (d) => process.stdout.write(d.toString()));
  });
});
c.on('error', (e) => { console.error('conn error:', e.message); process.exit(1); });
const cfg = { host: HOST, port: 22, username: USER, readyTimeout: 25000 };
if (PRIVKEY) cfg.privateKey = PRIVKEY;
if (PASS) { cfg.password = PASS; cfg.tryKeyboard = true; c.on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => PASS))); }
c.connect(cfg);
