/* Convoy — feature packs: the class gates, applied to packs/.
   `npm test` (test/run.js), or:  node test/packgates.test.js

   The core's gates (test/globals.test.js, fetchtimeout.test.js,
   visibility.test.js, domids.test.js, frontend.test.js's CSS floors) scan
   js/ and css/ only. A pack is the same kind of code — a vanilla App module
   that runs in the same WebView — so it gets the same discipline, applied
   here per pack so a violation names the pack:

     P1  the contract: pack.json validates through the real registry, the
         server half (if any) loads, no socket type collides with the core's
         handlers or another pack's, every pack has a README and a suite
     P2  globals: every free identifier in packs/**\/*.js is a platform global
         (acorn-globals, the same lists as test/globals.test.js); a pack never
         leaks a name
     P3  fetch: no bare fetch() — every request goes through A.util.fetchT
     P4  visibility: a bare setInterval whose callback fetches is a hidden-page
         poller; those go through A.util.poll — unless the line carries a
         "hidden-page poller: <why it must keep running with the screen off>"
         comment (audio that must keep streaming, say), the same explicit,
         reasoned exception test/visibility.test.js's POLL_ALLOW gives the core
     P5  dom ids: every document.getElementById('<literal>') resolves against
         index.html, the pack's own fragments, or an id assigned in pack JS
     P6  css: no font-size below 12px, no backdrop-filter (the glass budget is
         the core's), nothing dormant: no shipped file references packs/
     P7  server half: routes under /api/<id>/, ws types '<id>:…', no
         require('../server'), no process.exit, rider-triggered work rate-limited
         through ctx.rateOk

   Vacuous (one passing check) while packs/ holds no pack, so the suite can
   land before the first pack does. */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const findGlobals = require('acorn-globals');
const { group, ok, report, ROOT } = require('./harness');

const PACKS_DIR = path.join(ROOT, 'packs');
const ids = fs.existsSync(PACKS_DIR)
  ? fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-z][a-z0-9-]{1,31}$/.test(d.name) && fs.existsSync(path.join(PACKS_DIR, d.name, 'pack.json')))
    .map((d) => d.name).sort()
  : [];

if (!ids.length) {
  group('P0 — no feature pack on disk');
  ok('packs/ holds no pack yet — nothing to gate (this suite becomes real with the first packs/<id>/pack.json)', true);
  process.exit(report());
}

/* ---------------- shared allowlists (mirrors test/globals.test.js) ---------------- */
const ES = ['Array', 'ArrayBuffer', 'Boolean', 'DataView', 'Date', 'Error', 'Float32Array', 'Function',
  'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'ReferenceError', 'RegExp', 'Set',
  'String', 'Uint8Array', 'Uint16Array', 'Float64Array', 'Symbol', 'TypeError', 'RangeError', 'WeakMap', 'WeakSet',
  'decodeURIComponent', 'encodeURIComponent', 'decodeURI', 'encodeURI', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined'];
const HOST = ['AbortController', 'AbortSignal', 'PerformanceObserver', 'URL', 'URLSearchParams', 'clearInterval',
  'clearTimeout', 'console', 'fetch', 'setInterval', 'setTimeout', 'queueMicrotask', 'structuredClone', 'TextEncoder', 'TextDecoder'];
const WEB = ['Audio', 'AudioContext', 'webkitAudioContext', 'Blob', 'Event', 'CustomEvent', 'Image', 'MouseEvent', 'TouchEvent',
  'KeyboardEvent', 'WebSocket', 'XMLHttpRequest', 'atob', 'btoa', 'cancelAnimationFrame', 'confirm', 'alert', 'prompt',
  'document', 'getComputedStyle', 'history', 'localStorage', 'sessionStorage', 'location', 'navigator', 'performance',
  'requestAnimationFrame', 'requestIdleCallback', 'screen', 'window', 'self', 'top', 'parent', 'devicePixelRatio',
  'innerWidth', 'innerHeight', 'matchMedia', 'addEventListener', 'removeEventListener', 'dispatchEvent',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'FormData', 'Headers', 'Request', 'Response',
  'FileReader', 'Notification', 'Worker', 'speechSynthesis', 'SpeechSynthesisUtterance', 'crypto', 'Path2D', 'OffscreenCanvas',
  'HTMLElement', 'HTMLCanvasElement', 'Node', 'NodeList', 'Element', 'DOMException', 'maplibregl', 'Capacitor', 'App', 'open', 'close', 'scrollTo', 'getSelection', 'CSS', 'isSecureContext', 'origin', 'frames', 'length', 'name', 'opener', 'print', 'stop', 'focus', 'blur', 'postMessage', 'ImageData', 'createImageBitmap', 'BroadcastChannel', 'ServiceWorker', 'Intl', 'MediaStream', 'RTCPeerConnection', 'MediaRecorder', 'AnalyserNode', 'GainNode', 'OscillatorNode', 'Geolocation', 'GeolocationPosition', 'wakeLock', 'WakeLock', 'orientation', 'DeviceOrientationEvent', 'DeviceMotionEvent', 'BatteryManager', 'ontouchstart', 'PointerEvent', 'ClipboardItem', 'visualViewport', 'EventSource', 'ReadableStream', 'WritableStream', 'TransformStream', 'Proxy', 'Reflect', 'BigInt', 'globalThis', 'eval'];
const CLIENT_ALLOW = new Set([].concat(ES, HOST, WEB));
const NODE_ALLOW = new Set([].concat(ES, HOST, ['Buffer', 'process', 'global', 'globalThis', '__dirname', '__filename', 'module', 'require', 'exports', 'Reflect', 'Proxy', 'BigInt', 'Symbol', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone']));

/* ---------------- helpers ---------------- */
function listFiles(dir, pred) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, pred));
    else if (pred(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
function readOr(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { ok(rel(file) + ' is on disk', false, e.message); return null; }
}
const isStr = (n) => n && n.type === 'Literal' && typeof n.value === 'string';
function parse(src, file) {
  try { return acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true }); }
  catch (e) { ok(rel(file) + ' parses', false, e.message); return null; }
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const staticIds = new Set();
{ const re = /\bid="([^"]*)"/g; let m; while ((m = re.exec(html))) staticIds.add(m[1]); }

// The core's socket handler names, from the handlers object in server.js.
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const coreWs = {};
{
  const start = SERVER_SRC.indexOf('\nconst handlers = {');
  const end = SERVER_SRC.indexOf('\n};', start);
  const block = SERVER_SRC.slice(start, end);
  const re = /^  '?([a-z][a-z:]*)'?\((?:c(?:, m)?)\) \{/gm;
  let m;
  while ((m = re.exec(block))) coreWs[m[1]] = true;
}
ok('the core socket handler names were found in server.js (>= 20: ' + Object.keys(coreWs).length + ')', Object.keys(coreWs).length >= 20, Object.keys(coreWs).join(','));

/* ================= P1 — the contract ================= */
group('P1 — the contract: every pack validates through the real registry, loads, and collides with nothing');
let registry = null;
{
  const packs = require('../server/packs');
  let err = null;
  try { packs._reset(); packs.load(coreWs); registry = packs; } catch (e) { err = e; }
  ok('server/packs/index.js load() accepts every pack on disk and refuses no collision (' + ids.join(', ') + ')', !err, err && err.message);
  if (!err) {
    ok('every pack directory is registered', ids.every((id) => packs.has(id)), ids.filter((id) => !packs.has(id)).join(','));
  }
}
for (const id of ids) {
  const dir = path.join(PACKS_DIR, id);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')); } catch (e) { ok(id + ': pack.json parses', false, e.message); continue; }
  ok(id + ': README.md present and says what the pack does', fs.existsSync(path.join(dir, 'README.md')) && fs.readFileSync(path.join(dir, 'README.md'), 'utf8').length > 200);
  ok(id + ': has its own suite test/packs-' + id + '.test.js', fs.existsSync(path.join(ROOT, 'test', 'packs-' + id + '.test.js')));
  const onDisk = fs.readdirSync(dir).filter((f) => /\.(js|css|html)$/.test(f)).sort();
  const listed = [].concat(manifest.scripts || [], manifest.styles || [], (manifest.fragments || []).map((f) => f.file)).sort();
  const unlisted = onDisk.filter((f) => listed.indexOf(f) < 0);
  ok(id + ': every .js/.css/.html on disk is in pack.json (' + onDisk.length + ' files)', unlisted.length === 0, 'not listed: ' + unlisted.join(', '));
  ok(id + ': a legal key implies a registered notice and a legalGate call in the pack JS; no legal key implies neither is required',
    !manifest.legal || (manifest.scripts || []).some((f) => {
      const s = readOr(path.join(dir, f)) || '';
      return s.indexOf('registerFeatureNotice(') >= 0 || s.indexOf('legalGate(') >= 0;
    }), 'pack.json names legal: ' + manifest.legal + ' but no script registers a notice or gates on it');
}

/* ================= P2–P5 — client gates ================= */
for (const id of ids) {
  const dir = path.join(PACKS_DIR, id);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')); } catch (e) { continue; }
  group('P2–P5 — ' + id + ': client discipline');
  const fragIds = new Set();
  (manifest.fragments || []).forEach((f) => {
    const s = readOr(path.join(dir, f.file)) || '';
    const re = /\bid="([^"]*)"/g; let m; while ((m = re.exec(s))) fragIds.add(m[1]);
  });
  const assigned = new Set();
  const lookups = [];
  const files = (manifest.scripts || []).map((f) => path.join(dir, f));
  // pass 1: assigned ids + free globals + fetch + setInterval
  for (const file of files) {
    const src = readOr(file);
    if (src === null) continue;
    const ast = parse(src, file);
    if (!ast) continue;
    // globals
    let free = [];
    try { free = findGlobals(ast).map((g) => g.name); } catch (e) { ok(rel(file) + ': acorn-globals', false, e.message); }
    const bad = free.filter((n) => !CLIENT_ALLOW.has(n));
    ok(rel(file) + ': every free identifier is a platform global (' + free.length + ' seen)', bad.length === 0, 'defined nowhere: ' + bad.join(', '));
    // top-level shape: nothing but expression statements (the IIFE) — no top-level var/function that would be a global
    const topDecl = ast.body.filter((n) => n.type !== 'ExpressionStatement' && !(n.type === 'EmptyStatement'));
    ok(rel(file) + ': no top-level declaration (everything lives inside the module IIFE; exports only on window.App)', topDecl.length === 0,
      topDecl.map((n) => n.type + '@' + n.loc.start.line).join(', '));
    const bareFetch = [], pollers = [], ids2 = [];
    { const re = /\bid="([^"]*)"/g; let m; while ((m = re.exec(src))) assigned.add(m[1]); }
    walk.ancestor(ast, {
      CallExpression(node, ancestors) {
        const c = node.callee;
        const prop = (name) => c.type === 'MemberExpression' && !c.computed && c.property.name === name;
        if (c.type === 'Identifier' && c.name === 'fetch') bareFetch.push(node.loc.start.line);
        if (c.type === 'MemberExpression' && prop('fetch') && c.object.type === 'Identifier' && c.object.name === 'window') bareFetch.push(node.loc.start.line);
        if ((c.type === 'Identifier' && c.name === 'setInterval') || (prop('setInterval') && c.object.type === 'Identifier' && c.object.name === 'window')) {
          const cb = node.arguments[0];
          let body = '';
          if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) body = src.slice(cb.start, cb.end);
          else if (cb && cb.type === 'Identifier') {
            const re = new RegExp('function\\s+' + cb.name + '\\s*\\(');
            const at = src.search(re);
            if (at >= 0) body = src.slice(at, at + 4000);
          }
          if (/\bfetchT\(|\bfetch\(/.test(body)) {
            // An explicit, reasoned exception on the setInterval line itself.
            const line = src.split('\n')[node.loc.start.line - 1] || '';
            const prev = src.split('\n')[node.loc.start.line - 2] || '';
            const reason = /hidden-page poller:\s*(.{20,})/i.exec(line) || /hidden-page poller:\s*(.{20,})/i.exec(prev);
            if (!reason) pollers.push(node.loc.start.line);
          }
        }
        if (prop('getElementById') && isStr(node.arguments[0])) lookups.push({ id: node.arguments[0].value, where: rel(file) + ':' + node.loc.start.line });
        if (prop('setAttribute') && isStr(node.arguments[0]) && node.arguments[0].value === 'id' && isStr(node.arguments[1])) assigned.add(node.arguments[1].value);
      },
      AssignmentExpression(node) {
        const l = node.left;
        if (l.type === 'MemberExpression' && !l.computed && l.property.name === 'id' && isStr(node.right)) assigned.add(node.right.value);
      }
    });
    ok(rel(file) + ': no bare fetch() — every request goes through A.util.fetchT (' + bareFetch.length + ' found)', bareFetch.length === 0, 'lines ' + bareFetch.join(', '));
    ok(rel(file) + ': no bare setInterval that fetches — hidden-page pollers go through A.util.poll, or carry a "hidden-page poller: <reason>" comment (' + pollers.length + ' unexplained)', pollers.length === 0, 'lines ' + pollers.join(', '));
  }
  // pass 2: id resolution
  const unresolved = lookups.filter((l) => !staticIds.has(l.id) && !fragIds.has(l.id) && !assigned.has(l.id));
  ok(id + ': every document.getElementById(literal) resolves against index.html, the pack\'s fragments or an id its JS assigns (' + lookups.length + ' lookups)',
    unresolved.length === 0, unresolved.map((l) => l.id + ' @ ' + l.where).join('; '));
  // fragments mount on something that exists
  (manifest.fragments || []).forEach((f) => {
    const sel = f.mount || 'body';
    const idSel = /^#([\w-]+)$/.exec(sel);
    const resolvable = sel === 'body' || /^\.[\w-]+$/.test(sel) && html.indexOf('class="') >= 0 && new RegExp('class="[^"]*\\b' + sel.slice(1) + '\\b').test(html) ||
      (idSel && (staticIds.has(idSel[1]) || fragIds.has(idSel[1]) || assigned.has(idSel[1])));
    ok(id + ': fragment ' + f.file + ' mounts on a selector the page has (' + sel + ')', !!resolvable);
  });
  // CSS
  for (const f of (manifest.styles || [])) {
    const css = readOr(path.join(dir, f));
    if (css === null) continue;
    const small = (css.match(/font-size:\s*([0-9.]+)px/g) || []).map((m) => parseFloat(m.match(/[0-9.]+/)[0])).filter((px) => px < 12);
    ok(id + '/' + f + ': no font-size below the 12px floor (' + small.length + ' found)', small.length === 0, small.join(', '));
    ok(id + '/' + f + ': no backdrop-filter (the glass budget belongs to the core theme)', !/backdrop-filter/.test(css));
  }
}

/* ================= P6 — nothing dormant ================= */
group('P6 — nothing under packs/ is referenced by what ships');
{
  const shipped = ['index.html'].concat(listFiles(path.join(ROOT, 'js'), (f) => f.endsWith('.js')).map(rel), listFiles(path.join(ROOT, 'css'), (f) => f.endsWith('.css')).map(rel));
  // Code only (comments stripped): a comment may well SAY "packs/<id>/*.css";
  // what must never exist is a URL, a src/href or a string literal naming one.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const refs = shipped.filter((f) => f !== 'js/packs.js' && /(src|href)=["']\/?packs\/|url\(\s*["']?\/?packs\/|['"`]\/?packs\/[\w-]+\/[\w.-]+['"`]/.test(strip(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  ok('no shipped file names a packs/ path (' + shipped.length + ' files checked)', refs.length === 0, refs.join(', '));
  const copy = fs.readFileSync(path.join(ROOT, 'scripts', 'copy-web.js'), 'utf8');
  ok("scripts/copy-web.js still bundles only index.html/js/css/fonts", /const targets = \['index\.html', 'js', 'css', 'fonts'\];/.test(copy));
}

/* ================= P7 — server halves ================= */
for (const id of ids) {
  const file = path.join(ROOT, 'server', 'packs', id + '.js');
  if (!fs.existsSync(file)) continue;
  group('P7 — ' + id + ': server half');
  const helpers = listFiles(path.join(ROOT, 'server', 'packs', id), (f) => f.endsWith('.js'));
  for (const f of [file].concat(helpers)) {
    const src = readOr(f);
    if (src === null) continue;
    const ast = parse(src, f);
    if (!ast) continue;
    let free = [];
    try { free = findGlobals(ast).map((g) => g.name); } catch (e) { ok(rel(f) + ': acorn-globals', false, e.message); }
    const bad = free.filter((n) => !NODE_ALLOW.has(n));
    ok(rel(f) + ': every free identifier is a Node global (' + free.length + ' seen)', bad.length === 0, 'defined nowhere: ' + bad.join(', '));
    ok(rel(f) + ": never requires the core server, never exits the process", !/require\((['"])\.\.\/server(\.js)?\1\)/.test(src) && !/process\.exit\(/.test(src));
  }
  let mod;
  try { mod = require(file); } catch (e) { ok(id + ': server/packs/' + id + '.js loads', false, e.message); continue; }
  const routes = mod.routes || [];
  const badRoutes = routes.filter((r) => !new RegExp('^\\^?\\\\/api\\\\/' + id + '\\\\/').test(r[1].source));
  ok(id + ': every route lives under /api/' + id + '/ (' + routes.length + ' routes)', badRoutes.length === 0, badRoutes.map((r) => r[1].source).join(', '));
  const ws = Object.keys(mod.ws || {});
  const badWs = ws.filter((t) => t.indexOf(id + ':') !== 0);
  ok(id + ": every socket type is prefixed '" + id + ":' (" + ws.length + ' types)', badWs.length === 0, badWs.join(', '));
  const src = fs.readFileSync(file, 'utf8');
  if (ws.length || routes.length) {
    ok(id + ': rider-triggered work is rate-limited through ctx.rateOk somewhere in the half', /\brateOk\(/.test(src));
  }
}

process.exit(report());
