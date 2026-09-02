/* Convoy — client/server boundary tests.

   The police finder (server/police-finder.js) reaches several third-party
   sources that have no public API — Waze's private live-map endpoint, Citizen,
   PulsePoint. That is a deliberate, server-side-only arrangement: the scraping
   happens on the VPS, under its own systemd unit, and its findings reach riders
   only after being normalised and pushed through Convoy's OWN API
   (/api/agent/update, /api/waze). The shipped app never talks to those hosts.

   These tests exist so that stays true. It is the kind of separation that is
   easy to break by accident — one fetch() moved into js/ for convenience, one
   extra entry in copy-web's target list — and hard to notice afterwards,
   because everything still works.

   Run:  node test/boundary.test.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const ROOT = H.ROOT;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// Every file that can end up on a rider's device.
function clientFiles() {
  const out = [];
  const roots = [
    'index.html', 'js', 'css',
    'www/index.html', 'www/js', 'www/css',
    'android/app/src/main/assets/public'
  ];
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) { out.push(r); continue; }
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name), rp = rel + '/' + e.name;
        if (e.isDirectory()) walk(p, rp);
        else if (/\.(js|html|css|json)$/i.test(e.name)) out.push(rp);
      }
    })(abs, r);
  }
  return out;
}

// Hosts + endpoint shapes that only the server-side finder may touch.
const SERVER_ONLY = [
  { name: 'Waze private live-map', re: /waze\.com\/live-map|api\/georss/i },
  { name: 'Citizen',               re: /citizen\.com/i },
  { name: 'PulsePoint',            re: /pulsepoint\.org/i }
];

/* ======================================================================== */
H.group('Scraped sources never reach the shipped app');
{
  const files = clientFiles();
  H.ok('found client files to scan', files.length > 40, files.length + ' files');

  for (const src of SERVER_ONLY) {
    const hits = files.filter((f) => src.re.test(read(f)));
    H.ok('no client file references ' + src.name, hits.length === 0,
      hits.length ? 'LEAKED INTO: ' + hits.join(', ') : 'clean across ' + files.length + ' files');
  }

  // ...and the whole repo agrees: only the finder knows those hosts.
  // legal/ is exempt: the third-party-notices page is where the licenses say
  // the sources MUST be credited — naming PulsePoint there is disclosure to
  // riders, not a client that talks to the host. Everything else is fair game.
  const strays = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html)$/i.test(e.name)) continue;
      const rel = path.relative(ROOT, p).split(path.sep).join("/");
      if (rel === 'server/police-finder.js' || rel.indexOf('test/') === 0 ||
          rel.indexOf('legal/') === 0) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (SERVER_ONLY.some((s) => s.re.test(body))) strays.push(rel);
    }
  })(ROOT);
  H.ok('only server/police-finder.js knows the scraped hosts', strays.length === 0,
    strays.length ? 'also in: ' + strays.join(', ') : 'confined to the finder');
}

/* ======================================================================== */
H.group('Server code is never packaged into the app');
{
  const packaged = clientFiles().filter((f) => f.indexOf('android/') === 0 || f.indexOf('www/') === 0);
  const serverish = packaged.filter((f) =>
    /\/(police-finder|collect-hotspots|server|store|bots|tomtom|waze|agent|hotspots)\.js$/.test(f));
  H.ok('no server module inside the packaged assets', serverish.length === 0,
    serverish.length ? 'FOUND: ' + serverish.join(', ') : 'checked ' + packaged.length + ' packaged files');

  const copyWeb = read('scripts/copy-web.js');
  const m = copyWeb.match(/const targets = \[([^\]]*)\]/);
  H.ok('copy-web declares an explicit target list', !!m, m ? m[1].trim() : 'not found');
  if (m) {
    const targets = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    H.ok('copy-web copies only index.html, js and css',
      targets.length === 3 && targets.indexOf('index.html') >= 0 &&
      targets.indexOf('js') >= 0 && targets.indexOf('css') >= 0, targets.join(' + '));
    H.ok('copy-web never copies server/', targets.indexOf('server') < 0, targets.join(' + '));
  }
}

/* ======================================================================== */
H.group('Server code is never served over HTTP');
{
  const srv = read('server/server.js');
  const m = srv.match(/const ALLOWED_TOP = \[([^\]]*)\]/);
  H.ok('the static server uses an explicit allowlist', !!m, m ? m[1].trim() : 'not found');
  if (m) {
    const allowed = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    H.ok('/server is not in the allowlist', !allowed.some((a) => /^\/server/.test(a)), allowed.join(' '));
    H.ok('the allowlist stays small', allowed.length <= 6, allowed.length + ' entries: ' + allowed.join(' '));
  }
}

/* ======================================================================== */
H.group('The finder stays a separate process with one way in');
{
  const srv = read('server/server.js');
  H.ok('server.js does not require the finder',
    !/require\(['"]\.\/police-finder/.test(srv) && !/require\(['"]\.\/collect-hotspots/.test(srv),
    'the finder runs under its own systemd unit');

  const finder = read('server/police-finder.js');
  H.ok('the finder pushes through /api/agent/update', /\/api\/agent\/update/.test(finder));
  H.ok('...authenticated with AGENT_KEY', /X-Agent-Key/.test(finder));
  H.ok('...and targets a configurable base URL, defaulting to localhost',
    /FINDER_URL[\s\S]{0,140}localhost/.test(finder));

  H.ok('the finder has its own unit file', exists('deploy/convoy-police-finder.service'));
  if (exists('deploy/convoy-police-finder.service')) {
    const unit = read('deploy/convoy-police-finder.service');
    H.ok('the unit talks to the API over localhost only',
      /FINDER_URL=http:\/\/localhost/.test(unit), 'never exposed publicly');
  }
}

/* ======================================================================== */
H.group('Scraped data does not carry a vendor brand into the app');
{
  const finder = read('server/police-finder.js');
  const waze = read('server/waze.js');
  // The LICENSED OpenWeb Ninja path may credit Waze — that data is paid for.
  H.ok('the licensed Waze path still credits Waze', /Police \(Waze\)/.test(waze));
  // The SCRAPED keyless path must not.
  H.ok('the scraped keyless path uses a neutral label', !/Police \(Waze\)/.test(finder),
    'riders see "Police reported", credited to the generic live feed');
}

/* ======================================================================== */
/* Supabase credentials are the highest-value secret in the project: the secret
   key is full admin over Auth AND the database, and the database URL embeds the
   password. Convoy's whole reason for proxying GoTrue through its own /api is
   that neither ever has to leave the server — so the day one of them is dropped
   into a client file "just to try it", that decision is quietly undone and the
   APK ships it to every rider. These checks make that loud. */
H.group('Supabase credentials never reach the shipped app');
{
  const files = clientFiles();
  const SECRETS = [
    { name: 'a secret API key',    re: /\bsb_secret_[A-Za-z0-9_-]+/ },
    { name: 'a service_role key',  re: /service_role/i },
    { name: 'a Postgres URL',      re: /postgres(ql)?:\/\//i },
    { name: 'the JWT shared secret', re: /SUPABASE_JWT_SECRET/ }
  ];
  for (const s of SECRETS) {
    const hits = files.filter((f) => s.re.test(read(f)));
    H.ok('no client file contains ' + s.name, hits.length === 0,
      hits.length ? 'LEAKED INTO: ' + hits.join(', ') : 'clean across ' + files.length + ' files');
  }

  // The client must reach Supabase only through Convoy's own API. A direct
  // GoTrue call from the browser would mean a key had to ship with it.
  const direct = files.filter((f) => /\/auth\/v1\/|\.supabase\.co/.test(read(f)));
  H.ok('no client file talks to Supabase directly', direct.length === 0,
    direct.length ? 'DIRECT CALL IN: ' + direct.join(', ') : 'everything goes through /api');

  // And the server reads them from the environment rather than hardcoding them.
  const sbjs = read('server/supabase.js');
  H.ok('the server takes its secret key from the environment',
    /process\.env\.SUPABASE_SECRET_KEY/.test(sbjs));
  H.ok('no literal secret key is committed in server code',
    !/sb_secret_[A-Za-z0-9_-]{10,}/.test(sbjs + read('server/db.js') + read('server/store.js')));
  H.ok('the example env file ships no filled-in secret',
    !exists('server/.env.example') || /SUPABASE_SECRET_KEY=\s*$/m.test(read('server/.env.example')));
  // .env holds the real values and must stay untracked.
  H.ok('.env is gitignored', /(^|\n)\*\*\/\.env|(^|\n)\.env/.test(read('.gitignore')));
}

H.report();
