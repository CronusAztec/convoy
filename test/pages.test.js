/* Convoy — the GitHub Pages mirror (scripts/build-pages.js, .github/workflows/pages.yml).
   `npm test` (test/run.js), or:  node test/pages.test.js

   The mirror is a static copy of the web app and the landing page that talks
   to the real backend. Two things must hold forever and are pinned here:
     G1  nothing a code unlocks is in it — no packs/, no server/, no legal/
         copy (the legal text has one home), and the app page names the
         backend so API, packs, legal links and the APK all resolve there
     G2  the rewrites are complete — no absolute /fonts, /landing/img,
         /convoy.apk or legal path survives (a project site lives under
         /<repo>/), the app link is relative, the backend is overridable and
         validated, and the build refuses a page that already names a backend
     G3  js/config.js honours the tag on the mirror and ignores its absence
         on the server page; the workflow uploads exactly the build dir */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { group, ok, report, ROOT } = require('./harness');
const build = require('../scripts/build-pages');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-pages-'));
const OUT = path.join(TMP, 'site');

group('G1 — nothing a code unlocks is in the mirror');
{
  const r = build.build({ out: OUT });
  ok('the build lands in the requested directory with the default backend', r.out === OUT && r.backend === 'https://odoreeci.tech' && r.files > 40, JSON.stringify(r));
  for (const d of ['packs', 'server', 'legal', 'www', 'deploy', 'test']) ok('no ' + d + '/ in the mirror', !fs.existsSync(path.join(OUT, d)));
  ok('the app, its js/css/fonts, the loader and the landing page are in', ['index.html', 'js/packs.js', 'js/config.js', 'css/styles.css', 'landing/index.html', 'landing/landing.js', 'landing/img/map-riders.webp', '.nojekyll', 'about/index.html']
    .every((f) => fs.existsSync(path.join(OUT, f))) && fs.readdirSync(path.join(OUT, 'fonts')).some((f) => f.endsWith('.woff2')));
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  ok('the app page names the backend right after <meta charset>', /<meta charset="[^"]*"\s*\/?>\n<meta name="convoy-base" content="https:\/\/odoreeci\.tech">/.test(html));
  ok('…and references nothing under packs/', !/["'(]\/?packs\//.test(html));
  ok('the mirror\'s js/ is byte-identical to the repo\'s (no feature smuggled in at build time)',
    fs.readdirSync(path.join(ROOT, 'js')).every((f) => fs.readFileSync(path.join(ROOT, 'js', f)).equals(fs.readFileSync(path.join(OUT, 'js', f)))));
}

group('G2 — the rewrites are complete');
{
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  ok('index.html: the font preloads are relative, the script tags untouched', !/href="\/fonts\//.test(html) && /href="fonts\//.test(html) && /<script src="js\/config\.js\?v=cy\d+" defer>/.test(html));
  const landing = fs.readFileSync(path.join(OUT, 'landing', 'index.html'), 'utf8');
  const absolute = (landing.match(/(?:href|src)="\/[^"]*"/g) || []);
  ok('landing: no absolute same-origin href/src survives (' + absolute.length + ')', absolute.length === 0, absolute.join(' '));
  ok('landing: images and the script are relative to /landing/', /src="img\/map-riders\.webp"/.test(landing) && /src="landing\.js"/.test(landing) && !/(?:href|src)="\/landing\/img\//.test(landing));
  ok('landing: fonts are one level up', /href="\.\.\/fonts\/chakra-petch-v13-latin-700\.woff2"/.test(landing));
  ok('landing: "Open in browser" opens the mirrored app, the APK and the legal pages go to the backend',
    /href="\.\.\/"/.test(landing) && /href="https:\/\/odoreeci\.tech\/convoy\.apk"/.test(landing) &&
    /href="https:\/\/odoreeci\.tech\/terms"/.test(landing) && /href="https:\/\/odoreeci\.tech\/privacy"/.test(landing) &&
    /href="https:\/\/odoreeci\.tech\/notices"/.test(landing) && /href="https:\/\/odoreeci\.tech\/delete-account"/.test(landing));
  ok('/about keeps its URL on the mirror (a redirect to the landing page)', /url=\.\.\/landing\//.test(fs.readFileSync(path.join(OUT, 'about', 'index.html'), 'utf8')));
  const r2 = build.build({ out: path.join(TMP, 'site2'), backend: 'https://example.org/' });
  const html2 = fs.readFileSync(path.join(TMP, 'site2', 'index.html'), 'utf8');
  ok('the backend is overridable and a trailing slash is dropped', r2.backend === 'https://example.org' && /content="https:\/\/example\.org"/.test(html2) &&
    /href="https:\/\/example\.org\/convoy\.apk"/.test(fs.readFileSync(path.join(TMP, 'site2', 'landing', 'index.html'), 'utf8')));
  let err = null;
  try { build.build({ out: path.join(TMP, 'site3'), backend: 'odoreeci.tech/app' }); } catch (e) { err = e; }
  ok('a backend that is not a bare origin is refused', !!err && /origin/.test(err.message));
  err = null;
  try { build.appHtml('<html><head><meta charset="utf-8"><meta name="convoy-base" content="x"></head></html>', 'https://x'); } catch (e) { err = e; }
  ok('a page that already names a backend is refused (the server page must never carry the tag)', !!err);
  ok('the repo\'s own index.html carries no convoy-base tag', !/convoy-base/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
}

group('G3 — the client honours the tag; the workflow publishes the build');
{
  const { JSDOM } = require('jsdom');
  const run = (headExtra) => {
    const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8">' + headExtra + '</head><body></body></html>', { url: 'http://localhost/' });
    const win = dom.window;
    const prev = { window: global.window, document: global.document };
    global.window = win; global.document = win.document;
    win.App = {};
    try { new Function(fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8')).call(win); }
    finally { global.window = prev.window; global.document = prev.document; }
    return win.App.config;
  };
  const server = run('');
  const mirror = run('<meta name="convoy-base" content="https://odoreeci.tech/">');
  ok('without the tag (the server page): base \'\' and a same-origin socket', server.base === '' && server.wsUrl === null);
  ok('with the tag (the mirror): base is the backend origin, the socket is wss on it', mirror.base === 'https://odoreeci.tech' && mirror.wsUrl === 'wss://odoreeci.tech/ws');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
  ok('the workflow builds with scripts/build-pages.js, uploads _site and deploys with the Pages actions',
    /run: node scripts\/build-pages\.js/.test(wf) && /upload-pages-artifact@v3[\s\S]*path: _site/.test(wf) && /deploy-pages@v4/.test(wf) && /pages: write/.test(wf) && /id-token: write/.test(wf));
  ok('the workflow proves no packs/, server/ or legal/ made it into the artifact', /test ! -e _site\/packs && test ! -e _site\/server && test ! -e _site\/legal/.test(wf));
  ok('_site/ is gitignored', /^_site\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
  const copy = fs.readFileSync(path.join(ROOT, 'scripts', 'copy-web.js'), 'utf8');
  ok('the APK/IPA bundle (copy-web) still carries no convoy-base tag logic — the store build stays same-origin + native base', !/convoy-base/.test(copy));
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(report());
