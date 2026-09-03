/* Convoy — undefined-identifier gate: no file may reference a name that nothing
   defines. `npm test` (test/run.js)

   Why this exists: server/server.js's chat handler shipped with `t2: now` from
   the initial commit until cycle 55 (2026-09-03) — and `now` was never defined.
   The handler threw ReferenceError before its first send(); the socket
   dispatcher's `try { h(c, m); } catch (e) { console.error('[handler ' + m.t + ']', …) }`
   swallowed it; and every rider-typed convoy chat message in live mode was lost,
   including the sender's own echo (server-032 in BUGS.md). System lines and
   bot replies use their own, correct envelopes, so chat LOOKED fine in sim
   mode. The only trace was a production journal line —
   `[handler chat] now is not defined` — that no test and no runbook step read.

   Why no other suite could see it: server.js refuses to boot without Supabase,
   so its handlers are only ever text-checked or lifted one function at a time
   (test/serverpolicy.test.js), and the client suites run js/*.js inside a shim.
   A free identifier that no scope defines is a static property of the source,
   and nothing here was looking at the source that way.

   What this does: parses every .js file in the trees below with acorn and asks
   acorn-globals for the identifiers that resolve to no enclosing scope — the
   "free" names. Each must be on the allowlist for its tree: language globals,
   the host's globals (Node or the browser), the CommonJS wrapper names, and
   the one ambient library global index.html loads. Anything else is a failed
   check naming the file and the identifier. A file that does not parse is a
   failed check, never a skip.

   The allowlists are kept honest three ways, so this cannot rot into a rubber
   stamp: (1) no dead entries — every allowlisted name is referenced by the
   trees its list applies to; (2) no project symbols — nothing defined at
   column 0 in a scanned file (that is not itself a platform global) may be
   allowlisted, so the next `now` cannot be silenced by listing it; (3) every
   entry resolves on the platform it claims: this Node process, a jsdom window,
   the CommonJS wrapper, or an index.html <script src>. The web APIs jsdom does
   not implement are a separate, explicit list that must stay absent from jsdom.

   When this fails: fix the reference (define it, or use the value that was
   meant — for the chat bug, `entry.t`). Do not add the name to a list. */
'use strict';
const fs = require('fs');
const path = require('path');
const findGlobals = require('acorn-globals');
const { JSDOM } = require('jsdom');
const { group, ok, report, ROOT } = require('./harness');

// Language globals (ECMA-262). Every engine, every tree.
const ES = ['Array', 'ArrayBuffer', 'Boolean', 'DataView', 'Date', 'Error', 'Float32Array', 'Function',
  'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'ReferenceError', 'RegExp', 'Set',
  'String', 'TypeError', 'Uint8Array', 'decodeURIComponent', 'encodeURIComponent', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt'];
// Host globals that Node (>= 18) and every browser both define. Every tree.
const HOST = ['AbortController', 'AbortSignal', 'URL', 'URLSearchParams', 'clearInterval', 'clearTimeout',
  'console', 'fetch', 'setInterval', 'setTimeout'];
// Node only: real globals, plus the CommonJS wrapper's parameters — which are
// NOT globals at all; they are verified through this module's own wrapper.
const NODE = ['Buffer', 'process'];
const CJS = ['__dirname', 'module', 'require'];
// Browser only (js/ runs in a WebView or a tab). Verified against a jsdom window …
const WEB = ['Audio', 'Blob', 'Event', 'Image', 'MouseEvent', 'WebSocket', 'XMLHttpRequest', 'atob', 'btoa',
  'cancelAnimationFrame', 'confirm', 'document', 'getComputedStyle', 'history', 'localStorage', 'location',
  'navigator', 'performance', 'requestAnimationFrame', 'window'];
// … except these, which jsdom does not implement (canvas paths, WebRTC, speech
// synthesis, CSS media queries). Real in every WebView the app ships in; kept
// apart so the gap is visible and checked — they must stay absent from jsdom.
const WEB_NOT_IN_JSDOM = ['Path2D', 'RTCIceCandidate', 'RTCPeerConnection', 'RTCRtpSender',
  'RTCSessionDescription', 'SpeechSynthesisUtterance', 'matchMedia'];
// Ambient library globals index.html loads from a pinned <script src>. Capacitor,
// tf and nsfwjs are always reached through window.* and so are never free names.
const APP_WEB = ['maplibregl'];
const APP_WEB_SCRIPT = { maplibregl: 'maplibre-gl' };
// Test only: Node's `global`, the lift-and-execute suites' `eval`, the fetch
// fakes' `Response` / `DOMException` (Node globals since 18 / 17) …
const TEST_EXTRA = ['global', 'eval', 'Response', 'DOMException'];
// … and `document`: test/browser.test.js stringifies its probe functions and
// runs them inside headless Chromium, where the DOM is real.
const TEST_DOM = ['document'];

const NODE_SIDE = [ES, HOST, NODE, CJS];
const TREES = [
  { dir: '.', files: ['release.js'], allow: NODE_SIDE },
  { dir: 'server', allow: NODE_SIDE },
  { dir: 'scripts', allow: NODE_SIDE },
  { dir: 'deploy', allow: NODE_SIDE },
  { dir: 'js', allow: [ES, HOST, WEB, WEB_NOT_IN_JSDOM, APP_WEB] },
  { dir: 'test', allow: [ES, HOST, NODE, CJS, TEST_EXTRA, TEST_DOM] }
];
const LISTS = [['ES', ES], ['HOST', HOST], ['NODE', NODE], ['CJS', CJS], ['WEB', WEB],
  ['WEB_NOT_IN_JSDOM', WEB_NOT_IN_JSDOM], ['APP_WEB', APP_WEB], ['TEST_EXTRA', TEST_EXTRA], ['TEST_DOM', TEST_DOM]];

function filesOf(t) {
  const names = t.files || fs.readdirSync(path.join(ROOT, t.dir)).filter((f) => f.endsWith('.js')).sort();
  return names.map((f) => (t.dir === '.' ? f : t.dir + '/' + f));
}

/* ---- 1. the scan: one check per file, then a summary ---- */
group('globals — every free identifier in every .js file is a real global of its platform');
const used = {};          // dir -> Set of free names seen anywhere in that tree
const violations = [];    // 'file: name'
const defs = new Map();   // column-0 definitions across all scanned files: name -> 'file:line'
let filesScanned = 0, namesSeen = 0;
for (const t of TREES) {
  const allow = new Set([].concat(...t.allow));
  used[t.dir] = new Set();
  for (const rel of filesOf(t)) {
    filesScanned++;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src.split('\n').forEach((l, i) => {
      const m = l.match(/^(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
      if (m && !defs.has(m[1])) defs.set(m[1], rel + ':' + (i + 1));
    });
    let free;
    try { free = findGlobals(src).map((g) => g.name); } catch (e) {
      ok(rel + ': parses', false, e.message);
      continue;
    }
    namesSeen += free.length;
    free.forEach((n) => used[t.dir].add(n));
    const bad = free.filter((n) => !allow.has(n));
    bad.forEach((n) => violations.push(rel + ': ' + n));
    ok(rel + ' (' + free.length + ' free identifier' + (free.length === 1 ? '' : 's') + ', all allowlisted)',
      bad.length === 0, 'defined nowhere: ' + bad.join(', ') +
      ' — fix the reference; only if it really is a platform global, add it to this tree\'s list and the honesty checks below will vouch for it');
  }
}
ok('summary: ' + filesScanned + ' files scanned, 0 identifiers that nothing defines',
  violations.length === 0, violations.join('; '));
ok('the scan is real: >= 100 files, >= 800 free-name sightings, `process` seen in server/ and `window` in js/',
  filesScanned >= 100 && namesSeen >= 800 && used.server.has('process') && used.js.has('window'),
  'files=' + filesScanned + ' sightings=' + namesSeen);

/* ---- 2. the allowlists are honest ---- */
group('globals — the allowlists cannot rot into a rubber stamp');
// (1) no dead entries: a list may only name what its trees actually reference.
for (const [name, list] of LISTS) {
  const dirs = TREES.filter((t) => t.allow.indexOf(list) >= 0).map((t) => t.dir);
  const seen = new Set([].concat(...dirs.map((d) => [...used[d]])));
  const dead = list.filter((n) => !seen.has(n));
  ok('no dead entries in ' + name + ' (' + list.length + ' name' + (list.length === 1 ? '' : 's') +
    ', every one referenced under ' + dirs.join(', ') + ')',
    dead.length === 0, 'remove ' + dead.join(', ') + ' from the allowlist');
}
// (2) no project symbols. "Platform" is decided by the platforms themselves —
// never by the lists above — or this check would be circular.
const win = new JSDOM('', { url: 'http://localhost/', pretendToBeVisual: true }).window;
const wrapper = { require: typeof require, module: typeof module, __dirname: typeof __dirname };
const isPlatform = (n) => (n in global) || (n in win) || (n in wrapper);
const allowlisted = new Set([].concat(...LISTS.map((x) => x[1])));
const projectOnly = [...defs.keys()].filter((n) => !isPlatform(n));
const smuggled = projectOnly.filter((n) => allowlisted.has(n));
ok('no project symbols: none of the ' + projectOnly.length + ' names defined at column 0 in scanned files (and not platform globals) is allowlisted',
  smuggled.length === 0, smuggled.map((n) => n + ' is defined at ' + defs.get(n)).join('; ') + ' — fix the reference, do not allowlist it');
ok('… and that check has teeth: `shutdown` (' + (defs.get('shutdown') || 'missing') + ') and `now` (' + (defs.get('now') || 'missing') +
  ') are project symbols, and neither is allowlisted',
  projectOnly.indexOf('shutdown') >= 0 && projectOnly.indexOf('now') >= 0 && !allowlisted.has('shutdown') && !allowlisted.has('now'));
// (3) every entry resolves where it claims to.
const nodeSide = [].concat(ES, HOST, NODE, TEST_EXTRA);
const missingNode = nodeSide.filter((n) => !(n in global));
ok('every ES / HOST / NODE / TEST_EXTRA entry resolves in this Node process (' + process.version + ')',
  missingNode.length === 0, 'not a global here: ' + missingNode.join(', '));
const missingCjs = CJS.filter((n) => !(n in wrapper) || wrapper[n] === 'undefined');
ok('every CJS entry is a live CommonJS wrapper name in this module', missingCjs.length === 0, missingCjs.join(', '));
const missingWeb = [].concat(WEB, TEST_DOM).filter((n) => !(n in win));
ok('every WEB / TEST_DOM entry resolves in a jsdom window',
  missingWeb.length === 0, 'jsdom does not define ' + missingWeb.join(', ') + ' — if it is a real browser API, move it to WEB_NOT_IN_JSDOM');
const leaked = WEB_NOT_IN_JSDOM.filter((n) => (n in win) || (n in global));
ok('WEB_NOT_IN_JSDOM names only what jsdom (and Node) really lack — the exception list cannot become a bypass',
  leaked.length === 0, leaked.join(', ') + ' now resolves — move it to WEB');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scriptSrcs = (html.match(/<script[^>]+src="[^"]+"/g) || []).join('\n');
const unloaded = APP_WEB.filter((n) => !APP_WEB_SCRIPT[n] || scriptSrcs.indexOf(APP_WEB_SCRIPT[n]) < 0);
ok('every APP_WEB entry is loaded by an index.html <script src> (' + APP_WEB.map((n) => n + ' ← ' + APP_WEB_SCRIPT[n]).join(', ') + ')',
  unloaded.length === 0, 'no script tag loads ' + unloaded.join(', '));

process.exit(report());
