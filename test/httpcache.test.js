/* Convoy — static-asset cache policy, proven by real HTTP round-trips.

   server/httpcache.js decides what Cache-Control / ETag / Last-Modified every
   static response carries. Two things about it can turn a performance win
   into an outage, and this suite exists to pin both:

     1. index.html must NEVER be `immutable`. It is the unstamped entry point
        that names the current `?v=cyNNN` stamp; cache it for a year and no
        rider ever sees a new release again.
     2. The ETag must MOVE when the file moves. A validator that never changes
        makes every revalidation a 304 forever — stale JavaScript for everyone,
        which is strictly worse than no cache at all.

   The policy is exercised the way production uses it: a throwaway
   http.createServer over a temp directory, mounting the same module functions
   in the same stat -> 304 -> read order as server.js's static handler, driven
   by real http.request round-trips on an ephemeral port (the test/auth.test.js
   pattern). The last group goes one step further and lifts the REAL static
   tail out of server/server.js and runs it verbatim, so the test double and
   the production handler cannot quietly drift apart.

   server.js itself cannot be require()d (it exits at boot without Supabase
   config) — that is why the policy lives in a small module at all.

   Run:  node test/httpcache.test.js  */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { group, ok, report, ROOT } = require('./harness');

const cache = require('../server/httpcache');

/* ---------------- fixtures ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-httpcache-'));
const APP_JS = 'window.App = window.App || {}; // cycle 54\n';
const INDEX = '<!doctype html><title>Convoy</title><script src="app.js?v=cy118"></script>\n';
fs.writeFileSync(path.join(TMP, 'app.js'), APP_JS);
fs.writeFileSync(path.join(TMP, 'index.html'), INDEX);
fs.mkdirSync(path.join(TMP, 'js'));                       // a directory, to prove stat-first still 404s it
fs.writeFileSync(path.join(TMP, 'convoy.apk'), 'PK not really an apk');
fs.mkdirSync(path.join(TMP, 'fonts'));
fs.writeFileSync(path.join(TMP, 'fonts', 'chakra-petch-v13-latin-400.woff2'), 'wOF2-fake-font-bytes');

// fs.readFile spy: the 304 branch must never read a body. Wrapping the real
// function (rather than counting Content-Length) makes the assertion direct.
let reads = 0;
const realReadFile = fs.readFile;
fs.readFile = function () { reads++; return realReadFile.apply(fs, arguments); };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive', '.woff2': 'font/woff2'
};
const IMMUTABLE = 'public, max-age=31536000, immutable';

/* The test double: the production flow (stat -> 304 -> read) over the module's
   functions. `immutable` is a knob here so the STATIC_IMMUTABLE=0 path can be
   driven without re-requiring the module. */
let immutable = true;
function serve(req, res, file, query) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const meta = { stamped: cache.isStamped(query), immutable, etag: cache.etagFor(st), mtime: st.mtime };
    if (cache.matchesEtag(req.headers['if-none-match'], meta.etag)) {
      res.writeHead(304, cache.headersFor(meta));
      res.end();
      return;
    }
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      meta.type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, cache.headersFor(meta));
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

/* The real thing: server.js's static tail, lifted verbatim. It must depend on
   nothing but fs, path, req, res, file, httpcache and MIME — the same seven
   names the double uses — or it does not compile here and the group below
   says so. */
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
let lifted = null, liftErr = 'static tail not found in server.js';
{
  const start = SRC.indexOf("const qAt = req.url.indexOf('?');");
  const end = SRC.indexOf('/* ================= websocket wiring');
  if (start >= 0 && end > start) {
    let block = SRC.slice(start, end);
    block = block.slice(0, block.lastIndexOf('});'));   // drop http.createServer's own close
    try { lifted = new Function('fs', 'path', 'req', 'res', 'file', 'httpcache', 'MIME', block); liftErr = null; }
    catch (e) { liftErr = 'lifted block does not compile: ' + e.message; }
  }
}

let useLifted = false;
const server = http.createServer((req, res) => {
  const qAt = req.url.indexOf('?');
  let urlPath = qAt >= 0 ? req.url.slice(0, qAt) : req.url;
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(TMP, urlPath);
  if (useLifted) lifted(fs, path, req, res, file, cache, MIME);
  else serve(req, res, file, qAt >= 0 ? req.url.slice(qAt + 1) : '');
});

function request(method, url, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}
const get = (url, headers) => request('GET', url, headers);

(async function main() {
  /* ================================================================== */
  group('httpcache — the pure policy (no server, no env)');
  ok('isStamped: v=cy<digits> as a query parameter, in any position',
    cache.isStamped('v=cy118') && cache.isStamped('?v=cy118') && cache.isStamped('a=1&v=cy118') && cache.isStamped('v=cy118&x=1'));
  ok('isStamped: not a substring match — "", v=cy, sv=cy118, v=cy118x, undefined are all unstamped',
    !cache.isStamped('') && !cache.isStamped('v=cy') && !cache.isStamped('sv=cy118') && !cache.isStamped('v=cy118x') && !cache.isStamped(undefined));
  const st = fs.statSync(path.join(TMP, 'app.js'));
  const tag = cache.etagFor(st);
  ok('etagFor: weak validator, hex size-mtime, e.g. ' + tag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(tag), tag);
  ok('etagFor: a different size gives a different tag',
    cache.etagFor({ size: st.size + 1, mtimeMs: st.mtimeMs }) !== tag);
  ok('etagFor: a different mtime gives a different tag',
    cache.etagFor({ size: st.size, mtimeMs: st.mtimeMs + 1000 }) !== tag);
  ok('matchesEtag: exact, weak-vs-strong (W/ ignored on both sides), *, and a comma list all match',
    cache.matchesEtag(tag, tag) && cache.matchesEtag(tag.slice(2), tag) && cache.matchesEtag(tag, tag.slice(2)) &&
    cache.matchesEtag('*', tag) && cache.matchesEtag('"nope", ' + tag + ' , W/"other"', tag));
  ok('matchesEtag: undefined / empty / a different tag / a prefix do not match',
    !cache.matchesEtag(undefined, tag) && !cache.matchesEtag('', tag) && !cache.matchesEtag('W/"0-0"', tag) &&
    !cache.matchesEtag(tag.slice(0, -2) + '"', tag));
  const h200 = cache.headersFor({ stamped: true, immutable: true, etag: tag, mtime: st.mtime, type: 'text/javascript' });
  ok('headersFor: stamped + immutable -> ' + IMMUTABLE, h200['Cache-Control'] === IMMUTABLE, JSON.stringify(h200));
  ok('headersFor: carries ETag, Last-Modified (HTTP-date) and the Content-Type it was given',
    h200.ETag === tag && h200['Last-Modified'] === st.mtime.toUTCString() && h200['Content-Type'] === 'text/javascript');
  ok('headersFor: unstamped -> no-cache, still with ETag + Last-Modified (index.html is never immutable)',
    (function () { const h = cache.headersFor({ stamped: false, immutable: true, etag: tag, mtime: st.mtime, type: 'text/html' });
      return h['Cache-Control'] === 'no-cache' && h.ETag === tag && !!h['Last-Modified']; })());
  ok('headersFor: stamped + immutable:false (the STATIC_IMMUTABLE=0 path) -> no-cache, ETag kept',
    (function () { const h = cache.headersFor({ stamped: true, immutable: false, etag: tag, mtime: st.mtime });
      return h['Cache-Control'] === 'no-cache' && h.ETag === tag; })());
  ok('headersFor: no Content-Type unless one is given (the 304 branch never has one)',
    !('Content-Type' in cache.headersFor({ stamped: true, immutable: true, etag: tag, mtime: st.mtime })));
  ok('IMMUTABLE_ENABLED is a boolean, true with STATIC_IMMUTABLE unset, and headersFor defaults to it',
    cache.IMMUTABLE_ENABLED === true && process.env.STATIC_IMMUTABLE === undefined &&
    cache.headersFor({ stamped: true, etag: tag, mtime: st.mtime })['Cache-Control'] === IMMUTABLE);
  ok('isImmutablePath: a .woff2 file directly under a "fonts" directory, any ancestor path',
    cache.isImmutablePath('/opt/data/convoy/fonts/chakra-petch-v13-latin-400.woff2') &&
    cache.isImmutablePath(path.join(TMP, 'fonts', 'x.woff2')));
  ok('isImmutablePath: false for a non-.woff2 file in fonts/, a .woff2 elsewhere, or a bad type',
    !cache.isImmutablePath(path.join(TMP, 'fonts', 'OFL.txt')) &&
    !cache.isImmutablePath(path.join(TMP, 'js', 'x.woff2')) &&
    !cache.isImmutablePath(undefined) && !cache.isImmutablePath(42));

  /* ================================================================== */
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  group('round-trip — the policy table, one real request per row');

  let r = await get('/app.js?v=cy118');
  const etag = r.headers.etag;
  ok('GET /app.js?v=cy118 -> 200, ' + IMMUTABLE + ', has an etag',
    r.status === 200 && r.headers['cache-control'] === IMMUTABLE && !!etag && r.body === APP_JS,
    r.status + ' ' + r.headers['cache-control'] + ' ' + etag);
  r = await get('/app.js');
  ok('GET /app.js (no stamp) -> 200, no-cache, has an etag',
    r.status === 200 && r.headers['cache-control'] === 'no-cache' && r.headers.etag === etag, r.status + ' ' + r.headers['cache-control']);
  r = await get('/index.html');
  const r2 = await get('/');
  ok('GET /index.html and GET / -> 200, no-cache — index.html is NEVER immutable',
    r.status === 200 && r.headers['cache-control'] === 'no-cache' && r2.status === 200 && r2.headers['cache-control'] === 'no-cache' && !!r.headers.etag,
    r.headers['cache-control'] + ' / ' + r2.headers['cache-control']);
  r = await get('/index.html?v=cy118');
  ok('a stamped index.html URL IS immutable (the policy keys on the stamp, not the name — the entry point is unstamped by construction)',
    r.status === 200 && r.headers['cache-control'] === IMMUTABLE);
  r = await get('/convoy.apk');
  ok('GET /convoy.apk -> no-cache with an etag (a repeated download check becomes a 304)',
    r.status === 200 && r.headers['cache-control'] === 'no-cache' && !!r.headers.etag);

  const before = reads;
  r = await get('/app.js?v=cy118', { 'if-none-match': etag });
  ok('matching If-None-Match -> 304 with a zero-length body',
    r.status === 304 && r.body.length === 0, r.status + ' body=' + r.body.length);
  ok('the 304 still carries cache-control + etag + last-modified (RFC 7232 s4.1)',
    r.headers['cache-control'] === IMMUTABLE && r.headers.etag === etag && !!r.headers['last-modified'],
    JSON.stringify(r.headers));
  ok('the 304 branch never reads the body: fs.readFile was not called, and there is no content-type',
    reads === before && r.headers['content-type'] === undefined, 'reads ' + before + ' -> ' + reads + ' content-type=' + r.headers['content-type']);
  r = await get('/app.js?v=cy118', { 'if-none-match': 'W/"0-0"' });
  ok('NON-matching If-None-Match -> 200 with the full body', r.status === 200 && r.body === APP_JS && reads === before + 1);
  r = await get('/app.js?v=cy118', { 'if-none-match': '*' });
  ok('If-None-Match: * -> 304', r.status === 304);
  r = await get('/app.js?v=cy118', { 'if-none-match': 'W/"other", ' + etag });
  ok('If-None-Match list form with weak prefixes -> 304', r.status === 304);
  r = await request('HEAD', '/app.js?v=cy118', { 'if-none-match': etag });
  ok('HEAD with a matching If-None-Match -> 304, no body', r.status === 304 && r.body.length === 0);
  r = await request('HEAD', '/app.js?v=cy118');
  ok('HEAD without a validator -> 200, no body, and the etag a client needs for its next request',
    r.status === 200 && r.body.length === 0 && r.headers.etag === etag);

  // The check that keeps this from shipping stale JavaScript: touch the file,
  // the validator must move and the old one must stop matching.
  const t = new Date(fs.statSync(path.join(TMP, 'app.js')).mtimeMs + 5000);
  fs.utimesSync(path.join(TMP, 'app.js'), t, t);
  r = await get('/app.js?v=cy118', { 'if-none-match': etag });
  ok('the validator tracks the file: after utimes the old etag no longer matches -> 200 with a NEW etag',
    r.status === 200 && r.headers.etag !== etag && /^W\/"/.test(r.headers.etag), r.status + ' ' + r.headers.etag);
  const etag2 = r.headers.etag;
  fs.writeFileSync(path.join(TMP, 'app.js'), APP_JS + '// rewritten\n');
  r = await get('/app.js?v=cy118', { 'if-none-match': etag2 });
  ok('rewriting the file with different content moves the etag again -> 200',
    r.status === 200 && r.headers.etag !== etag2 && r.body === APP_JS + '// rewritten\n');

  immutable = false;
  r = await get('/app.js?v=cy118');
  ok('kill switch (immutable=false, i.e. STATIC_IMMUTABLE=0): a stamped request gets no-cache AND still gets an etag',
    r.status === 200 && r.headers['cache-control'] === 'no-cache' && !!r.headers.etag, r.headers['cache-control'] + ' ' + r.headers.etag);
  r = await get('/app.js?v=cy118', { 'if-none-match': r.headers.etag });
  ok('kill switch: revalidation is still a 304 (the validator is a strict improvement in every configuration)', r.status === 304);
  immutable = true;

  r = await get('/js');
  const rDirCond = await get('/js', { 'if-none-match': '*' });
  ok('a directory -> 404 (stat-first must not turn /js into a cacheable resource; readFile used to EISDIR it)', r.status === 404);
  ok('a directory with If-None-Match: * -> still 404, never a 304 (the !st.isFile() guard runs before the validator)', rDirCond.status === 404, 'got ' + rDirCond.status);
  r = await get('/nope.js?v=cy118');
  ok('a missing file -> 404, stamped or not', r.status === 404);

  /* ================================================================== */
  group('executed — the real server.js static tail, lifted verbatim, serves the same table');
  ok('server.js has a liftable static tail (const qAt ... fs.stat ... fs.readFile) that compiles with only fs/path/req/res/file/httpcache/MIME in scope',
    !!lifted, liftErr);
  if (lifted) {
    useLifted = true;
    r = await get('/app.js?v=cy118');
    const e3 = r.headers.etag;
    ok('production code: stamped -> 200 ' + IMMUTABLE + ' + etag + last-modified + content-type',
      r.status === 200 && r.headers['cache-control'] === IMMUTABLE && !!e3 && !!r.headers['last-modified'] && /javascript/.test(r.headers['content-type']),
      JSON.stringify(r.headers));
    r = await get('/index.html');
    ok('production code: index.html -> no-cache with an etag', r.status === 200 && r.headers['cache-control'] === 'no-cache' && !!r.headers.etag);
    const b2 = reads;
    r = await get('/app.js?v=cy118', { 'if-none-match': e3 });
    ok('production code: matching If-None-Match -> 304, no body, no read, no content-type, cache-control + etag repeated',
      r.status === 304 && r.body.length === 0 && reads === b2 && r.headers['content-type'] === undefined &&
      r.headers['cache-control'] === IMMUTABLE && r.headers.etag === e3, r.status + ' reads ' + b2 + '->' + reads);
    r = await request('HEAD', '/app.js?v=cy118', { 'if-none-match': e3 });
    ok('production code: HEAD + matching validator -> 304', r.status === 304 && r.body.length === 0);
    const t2 = new Date(fs.statSync(path.join(TMP, 'app.js')).mtimeMs + 5000);
    fs.utimesSync(path.join(TMP, 'app.js'), t2, t2);
    r = await get('/app.js?v=cy118', { 'if-none-match': e3 });
    ok('production code: the etag moves with the file -> 200 with a new etag', r.status === 200 && r.headers.etag !== e3);
    r = await get('/js');
    const r404 = await get('/missing.js');
    ok('production code: a directory and a missing file both 404 with the old "Not found" body',
      r.status === 404 && r.body === 'Not found' && r404.status === 404 && r404.body === 'Not found');
    r = await get('/js', { 'if-none-match': '*' });
    ok('production code: a directory with If-None-Match: * is a 404, not a 304 (stat-first guarded by !st.isFile())', r.status === 404, 'got ' + r.status);
    r = await get('/fonts/chakra-petch-v13-latin-400.woff2');
    ok('production code: /fonts/*.woff2 -> 200 ' + IMMUTABLE + ' + etag + font/woff2, with NO ?v=cyNNN stamp at all (T2.5, cycle 19)',
      r.status === 200 && r.headers['cache-control'] === IMMUTABLE && !!r.headers.etag && r.headers['content-type'] === 'font/woff2',
      JSON.stringify(r.headers));
    useLifted = false;
  }

  server.close();
  fs.readFile = realReadFile;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(report());
})().catch((e) => { console.error(e); process.exit(1); });
