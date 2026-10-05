#!/usr/bin/env node
/* Convoy — GitHub Pages build.
   Assembles a static mirror of the web app and the landing page into _site/
   for GitHub Pages (.github/workflows/pages.yml publishes it). Pages hosts
   files only, so this is NOT the server: the mirror's index.html names the
   real backend with <meta name="convoy-base" content="…"> (js/config.js reads
   it), and every API call, the legal pages, the APK link and the feature-pack
   loader then go to that origin. The server answers /api/* with CORS for
   exactly this. Realtime (the /ws socket) is accepted only from origins the
   server lists in WS_ORIGINS, so a mirror whose host is not on that list runs
   in solo mode — the map, routes, sign-in, settings and packs all work;
   live riders need the host added server-side (DEPLOY.md, "GitHub Pages
   mirror").

   What goes in: index.html, js/, css/, fonts/, landing/. What never does:
   packs/ (served only by the server to accounts holding a pack — the whole
   point of the feature-pack design; test/pages.test.js pins it), server/,
   legal/ (the legal text has one home, the server, so a mirror can never show
   a stale version — the links point there).

   Pages serves a project site under /<repo>/, so the absolute paths the server
   pages use (/fonts/…, /landing/img/…, href="/") are rewritten relative here,
   in the copies only. Run from the project root:
       node scripts/build-pages.js                      # → _site/
       CONVOY_BACKEND=https://example.org node scripts/build-pages.js
       node scripts/build-pages.js --out /tmp/site */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BACKEND = 'https://odoreeci.tech';
const SHIP_DIRS = ['js', 'css', 'fonts'];
const NEVER = ['packs', 'server', 'legal', 'www', 'deploy', 'test', 'android', 'ios'];
const LEGAL_PATHS = ['/terms', '/privacy', '/notices', '/delete-account', '/licenses'];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function replaceAll(s, from, to) { return s.split(from).join(to); }

// The app page: the backend tag, and the two font preloads made relative.
function appHtml(src, backend) {
  if (/convoy-base/.test(src)) throw new Error('index.html already carries a convoy-base tag — the server page must not');
  let out = src.replace(/<meta charset="[^"]*"\s*\/?>/i, (m) => m + '\n<meta name="convoy-base" content="' + backend + '">');
  if (!/convoy-base/.test(out)) throw new Error('index.html: no <meta charset> to anchor the convoy-base tag on');
  out = replaceAll(out, 'href="/fonts/', 'href="fonts/');
  return out;
}

// The landing page: assets relative, the app link relative, everything the
// server owns (APK, legal pages) absolute to the backend.
function landingHtml(src, backend) {
  let out = src;
  out = replaceAll(out, 'href="/fonts/', 'href="../fonts/');
  out = replaceAll(out, '"/landing/img/', '"img/');
  out = replaceAll(out, 'src="/landing/landing.js"', 'src="landing.js"');
  out = replaceAll(out, 'href="/convoy.apk"', 'href="' + backend + '/convoy.apk"');
  for (const p of LEGAL_PATHS) out = replaceAll(out, 'href="' + p + '"', 'href="' + backend + p + '"');
  out = replaceAll(out, 'href="/"', 'href="../"');
  return out;
}

function build(opts) {
  opts = opts || {};
  const out = path.resolve(opts.out || path.join(ROOT, '_site'));
  const backend = String(opts.backend || process.env.CONVOY_BACKEND || DEFAULT_BACKEND).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(backend)) throw new Error('backend must be an origin like https://host, got ' + backend);
  if (path.relative(ROOT, out) === '' || out === path.parse(out).root) throw new Error('refusing to build into ' + out);
  rmrf(out);
  fs.mkdirSync(out, { recursive: true });

  for (const d of SHIP_DIRS) copyDir(path.join(ROOT, d), path.join(out, d));
  fs.writeFileSync(path.join(out, 'index.html'), appHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), backend));

  const landing = path.join(ROOT, 'landing');
  fs.mkdirSync(path.join(out, 'landing'), { recursive: true });
  copyDir(path.join(landing, 'img'), path.join(out, 'landing', 'img'));
  fs.copyFileSync(path.join(landing, 'landing.js'), path.join(out, 'landing', 'landing.js'));
  fs.writeFileSync(path.join(out, 'landing', 'index.html'), landingHtml(fs.readFileSync(path.join(landing, 'index.html'), 'utf8'), backend));
  // /about on the server is the landing page; keep that URL alive on the mirror.
  fs.mkdirSync(path.join(out, 'about'), { recursive: true });
  fs.writeFileSync(path.join(out, 'about', 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../landing/"><title>Convoy</title><a href="../landing/">Convoy</a>');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  // The invariant that makes the feature-pack design hold: nothing a code
  // unlocks is ever in a static mirror.
  for (const d of NEVER) {
    if (fs.existsSync(path.join(out, d))) throw new Error('refusing to publish ' + d + '/');
  }
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  if (/["'(]\/?packs\//.test(html)) throw new Error('index.html references packs/');

  const files = countFiles(out);
  return { out, backend, files };
}
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const r = build({ out: outIdx >= 0 ? argv[outIdx + 1] : undefined });
  console.log('Pages build: ' + r.files + ' files → ' + r.out + ' (backend ' + r.backend + ')');
}

module.exports = { build, appHtml, landingHtml, SHIP_DIRS, NEVER, DEFAULT_BACKEND };
