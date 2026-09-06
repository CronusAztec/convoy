/* Convoy — the landing page is served, and only through the paths it is meant
   to be served on.

   landing/ (index.html + landing.js + img/*.webp) is reached at /landing and
   /about. It sits beside the app, never in front of it: / must keep serving
   the app's index.html, because every OAuth redirect, magic link and Android
   App Link points at the root. Two ways this breaks silently in production
   while working fine on `python3 -m http.server`:

     1. the top-level dir is not in ALLOWED_TOP (every request under it 404s);
     2. the clean-path rewrite is missing or ordered after the allowlist
        check, so /landing 404s while /landing/index.html works.

   This lifts the real path-resolution block out of server/server.js (rewrite
   maps -> '/' -> resolve -> traversal guard -> allowlist) and runs it against
   a temp tree over real http.request round-trips, so the test and the
   production handler cannot quietly drift apart.

   Run:  node test/landing.test.js  */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { group, ok, report, ROOT } = require('./harness');

/* ---------------- static shape of the real thing ---------------- */
group('landing page — files, routes and the deploy manifest agree');
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'landing', 'index.html'), 'utf8');
ok('landing/index.html exists and is a full document', /<!DOCTYPE html>/i.test(html) && /<\/html>\s*$/.test(html));
ok('landing/landing.js exists (the CSP forbids inline scripts, so behaviour lives in a file)',
  fs.existsSync(path.join(ROOT, 'landing', 'landing.js')) && !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
  'an inline <script> body would be blocked by script-src \'self\'');
const imgs = Array.from(html.matchAll(/(?:src|href|content)="\/landing\/img\/([^"]+)"/g)).map((m) => m[1]);
const missing = imgs.filter((f) => !fs.existsSync(path.join(ROOT, 'landing', 'img', f)));
ok('every /landing/img/* the page references is on disk (' + imgs.length + ' refs)', imgs.length > 0 && missing.length === 0, 'missing: ' + missing.join(', '));
ok('the page only links to fonts the app already self-hosts under /fonts',
  Array.from(html.matchAll(/\/fonts\/([^)"]+\.woff2)/g)).every((m) => fs.existsSync(path.join(ROOT, 'fonts', m[1]))));
ok('every in-page anchor target exists',
  Array.from(html.matchAll(/href="#([^"]+)"/g)).every((m) => new RegExp('id="' + m[1] + '"').test(html)));
ok('the legal links point at the stable legal routes, not the files',
  /href="\/terms"/.test(html) && /href="\/privacy"/.test(html) && /href="\/delete-account"/.test(html) && !/legal\/[a-z-]+\.html/.test(html));
ok('the install CTA points at /convoy.apk and the app CTA at /', /href="\/convoy\.apk"/.test(html) && /href="\/"/.test(html));
ok("ALLOWED_TOP includes '/landing'", /const ALLOWED_TOP = \[[^\]]*'\/landing'[^\]]*\];/.test(SRC));
ok("MIME['.webp'] is 'image/webp' — without it the screenshots go out as application/octet-stream",
  /'\.webp':\s*'image\/webp'/.test(SRC));
ok('LANDING_PAGES maps /landing, /landing/ and /about onto landing/index.html',
  /const LANDING_PAGES = \{[^}]*'\/landing': 'landing\/index\.html'[^}]*'\/landing\/': 'landing\/index\.html'[^}]*'\/about': 'landing\/index\.html'[^}]*\}/.test(SRC));
ok('the landing rewrite sits AFTER the legal rewrite and BEFORE the "/" -> index.html rule (the app root is untouched)',
  (function () {
    const a = SRC.indexOf('hasOwnProperty.call(LEGAL_PAGES, urlPath)');
    const b = SRC.indexOf('hasOwnProperty.call(LANDING_PAGES, urlPath)');
    const c = SRC.indexOf("if (urlPath === '/') urlPath = '/index.html';");
    return a >= 0 && b > a && c > b;
  })());
ok('/landing is not an app route: index.html (the app) never mentions it', !/\/landing/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
for (const f of ['release.js', 'deploy/live-deploy.sh', 'DEPLOY.md']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(f + ' ships landing/ in the site tarball', /\blanding\b/.test(s) && /\bfonts\b/.test(s),
    'a tarball without landing/ deploys a 404 at /landing; without fonts/ the page renders in a fallback face');
}

/* ---------------- the lifted resolver over a temp tree ---------------- */
// Lift: from the LEGAL_PAGES rewrite through the allowlist 404. Returns the
// resolved file (or writes the 403/404 the production code writes).
let resolver = null, liftErr = 'resolver block not found in server.js';
{
  const start = SRC.indexOf('if (Object.prototype.hasOwnProperty.call(LEGAL_PAGES, urlPath))');
  const end = SRC.indexOf('// Stat first; read only when a body is actually going out.');
  const consts = SRC.slice(SRC.indexOf('const ALLOWED_TOP = ['), SRC.indexOf('/* ---- legal pages ----'));
  const legal = SRC.slice(SRC.indexOf('const LEGAL_PAGES = {'), SRC.indexOf('};', SRC.indexOf('const LEGAL_PAGES = {')) + 2);
  if (start >= 0 && end > start) {
    const block = consts + '\n' + legal + '\n' + SRC.slice(start, end) + '\nreturn file;';
    try { resolver = new Function('path', 'ROOT', 'urlPath', 'res', block); liftErr = null; }
    catch (e) { liftErr = 'lifted block does not compile: ' + e.message; }
  }
}
group('landing page — real round-trips through the lifted resolver');
ok('the resolver block lifts out of server.js and compiles', !!resolver, liftErr);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-landing-'));
fs.writeFileSync(path.join(TMP, 'index.html'), '<title>APP</title>');
fs.mkdirSync(path.join(TMP, 'landing', 'img'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'landing', 'index.html'), '<title>LANDING</title>');
fs.writeFileSync(path.join(TMP, 'landing', 'landing.js'), '/* js */');
fs.writeFileSync(path.join(TMP, 'landing', 'img', 'x.webp'), 'RIFF-fake-webp');
fs.mkdirSync(path.join(TMP, 'legal'));
fs.writeFileSync(path.join(TMP, 'legal', 'terms.html'), '<title>TERMS</title>');
fs.mkdirSync(path.join(TMP, 'server'));
fs.writeFileSync(path.join(TMP, 'server', 'secret.js'), 'SECRET');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = resolver ? resolver(path, TMP, urlPath, res) : null;
  if (res.headersSent || res.writableEnded) return;
  if (!file) { res.writeHead(500); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(file, (e2, data) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
});
function get(url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let r = await get('/');
  ok('GET / still serves the APP (the landing page never takes the root)', r.status === 200 && /APP/.test(r.body), r.status + ' ' + r.body);
  r = await get('/landing');
  ok('GET /landing -> 200 landing/index.html as text/html', r.status === 200 && /LANDING/.test(r.body) && /text\/html/.test(r.headers['content-type']), r.status + ' ' + r.body);
  r = await get('/landing/');
  ok('GET /landing/ (trailing slash) -> 200 landing page', r.status === 200 && /LANDING/.test(r.body), r.status);
  r = await get('/about');
  ok('GET /about -> 200 landing page (alias)', r.status === 200 && /LANDING/.test(r.body), r.status);
  r = await get('/landing?utm_source=x');
  ok('GET /landing?query -> 200 (the rewrite keys on the path, not the URL)', r.status === 200 && /LANDING/.test(r.body), r.status);
  r = await get('/landing/index.html');
  ok('GET /landing/index.html -> 200 (a direct file path under an allowlisted dir still works)', r.status === 200 && /LANDING/.test(r.body), r.status);
  r = await get('/landing/landing.js');
  ok('GET /landing/landing.js -> 200 text/javascript', r.status === 200 && /javascript/.test(r.headers['content-type']), r.status + ' ' + r.headers['content-type']);
  r = await get('/landing/img/x.webp');
  ok('GET /landing/img/x.webp -> 200 image/webp', r.status === 200 && r.headers['content-type'] === 'image/webp', r.status + ' ' + r.headers['content-type']);
  r = await get('/landing/img/');
  ok('GET /landing/img/ (a directory) -> 404, not a listing', r.status === 404, r.status);
  r = await get('/landing/../server/secret.js');
  ok('GET /landing/../server/secret.js -> 404 (traversal is resolved first, then the allowlist rejects /server)', r.status === 404 && !/SECRET/.test(r.body), r.status + ' ' + r.body);
  r = await get('/landing/../../etc/passwd');
  ok('GET /landing/../../etc/passwd -> 403 or 404, never a body', (r.status === 403 || r.status === 404) && !/root:/.test(r.body), r.status);
  r = await get('/terms');
  ok('GET /terms still resolves (the legal rewrite runs first and is unchanged)', r.status === 200 && /TERMS/.test(r.body), r.status);
  r = await get('/landingpage');
  ok('GET /landingpage -> 404 (no prefix matching on the rewrite or the allowlist)', r.status === 404, r.status);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  report();
})().catch((e) => { console.error(e); process.exit(1); });
