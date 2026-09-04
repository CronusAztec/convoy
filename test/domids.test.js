/* Convoy — every element id the client looks up by literal must exist.
   `npm test` (test/run.js)

   Why this exists: a mistyped or deleted id="…" kills a feature exactly as
   silently as `now is not defined` killed chat for the life of the product
   (server-032). document.getElementById() returns null, the next property
   access throws inside a handler or a .then, and nothing on the page says so.
   BUGS.md frontend-001 / 008 / 009 / 010 filed "no null check" against the five
   map controls, the dock badge, the ETA card and the panel bodies. The guards
   have since landed — but a guard only turns a crash into a feature that
   silently does nothing. The invariant that matters is that the id RESOLVES,
   and this suite pins it for every literal lookup in js/ (the class-gate
   pattern of test/globals.test.js, test/fetchtimeout.test.js and
   test/visibility.test.js, same acorn toolchain).

   Four groups:
     D1  resolution — every document.getElementById('<literal>') in js/*.js,
         plus the literal calls through js/radar.js's byId() wrapper, names an
         id that is (a) static in index.html, (b) assigned somewhere in js/
         (el.id = '…', setAttribute('id', '…'), or id="…" inside a JS string /
         template literal) or (c) in ALLOW below. Zero unresolved.
     D2  ALLOW is exactly one justified entry, still referenced, still not
         resolvable any other way (anti-rot in both directions).
     D3  informational pins of what the tree measures — NOT a ratchet; update
         the number when a lookup is added or removed, so the swing is visible
         in the diff.
     D4  the ledger entries, executed by name: each id frontend-001/008/009/010
         dereferences is still looked up in the file the entry names AND is
         static in index.html.

   When this fails: fix the id — in index.html or in the JS that builds the
   element. Add to ALLOW only when the id is genuinely computed at runtime, and
   say where. Never widen the allowlist to make a red run green. */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const H = require('./harness');
const { group, ok, ROOT } = H;

const JS_DIR = path.join(ROOT, 'js');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => 'js/' + f);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// (c) ids that exist at runtime but are neither static nor assigned by a literal.
// One entry. The reason must name where the id is computed; D2 re-checks it.
const ALLOW = {
  'theme-css-custom': "computed: js/themes.js ensureCss() builds the <style> tag id as 'theme-css-' + def.id, so the custom theme's tag is never written as a literal; setCustom() looks it up to drop the stale block before re-injecting"
};
// Wrappers around document.getElementById that take the id as their only
// argument — literal calls through them are the same class of lookup.
const WRAPPERS = { 'js/radar.js': 'byId' };
const WRAPPER_SRC = 'function byId(id) { return document.getElementById(id); }';

/* ---------------- (a) static ids in index.html ---------------- */
const staticIds = new Set();
{
  const re = /\bid="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) staticIds.add(m[1]);
}

/* ---------------- the scan over js/ ---------------- */
const lookups = [];        // { file, line, id, via } for every literal lookup
const dynamicLookups = []; // getElementById(<non-literal>) — informational
const assigned = new Set(); // (b) ids js/ gives to elements it builds
const parseErrors = [];
const ID_IN_STRING = /\bid=["']([A-Za-z0-9_:.-]+)["']/g;
const isStr = (n) => n && n.type === 'Literal' && typeof n.value === 'string';
const prop = (c, name) => c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' && c.property.name === name;
function harvest(text) { let m; ID_IN_STRING.lastIndex = 0; while ((m = ID_IN_STRING.exec(text))) assigned.add(m[1]); }

for (const rel of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); } catch (e) { parseErrors.push(rel + ': ' + e.message); continue; }
  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee, a0 = node.arguments[0];
      if (prop(c, 'getElementById')) {
        if (isStr(a0)) lookups.push({ file: rel, line: node.loc.start.line, id: a0.value, via: 'document.getElementById' });
        else dynamicLookups.push(rel + ':' + node.loc.start.line);
      } else if (c.type === 'Identifier' && WRAPPERS[rel] === c.name && isStr(a0)) {
        lookups.push({ file: rel, line: node.loc.start.line, id: a0.value, via: c.name });
      } else if (prop(c, 'setAttribute') && isStr(a0) && a0.value === 'id' && isStr(node.arguments[1])) {
        assigned.add(node.arguments[1].value);
      }
    },
    AssignmentExpression(node) {
      if (prop(node.left, 'id') && isStr(node.right)) assigned.add(node.right.value);
    },
    Literal(node) { if (typeof node.value === 'string') harvest(node.value); },
    TemplateLiteral(node) { node.quasis.forEach((q) => harvest(q.value.cooked || '')); }
  });
}

const resolvedBy = (id) => (staticIds.has(id) ? 'static' : assigned.has(id) ? 'js' : ALLOW[id] ? 'allow' : null);
const unresolved = lookups.filter((l) => !resolvedBy(l.id));
const site = (l) => l.file + ':' + l.line + ' ' + l.id + (l.via === 'document.getElementById' ? '' : ' (via ' + l.via + ')');
const direct = lookups.filter((l) => l.via === 'document.getElementById');
const viaWrapper = lookups.filter((l) => l.via !== 'document.getElementById');
const referenced = new Set(lookups.map((l) => l.id));
const notStatic = Array.from(referenced).filter((id) => !staticIds.has(id)).sort();
const jsAssignedRefs = notStatic.filter((id) => assigned.has(id));

console.log('    literal lookups: ' + lookups.length + ' (' + direct.length + ' direct, ' + viaWrapper.length + ' via wrappers) | static ids: ' + staticIds.size +
  ' | referenced but not static: ' + notStatic.length + ' (' + jsAssignedRefs.length + ' assigned in js/, ' + notStatic.filter((id) => ALLOW[id]).length + ' allowlisted) | unresolved: ' + unresolved.length);

/* ================= D1 — resolution ================= */
group('D1 — every id the client looks up by literal resolves: static in index.html, assigned in js/, or allowlisted with a reason');
ok('every js/*.js parses (' + jsFiles.length + ' files) and the scan is real: >= 90 literal lookups (' + lookups.length + ') over >= 60 static ids (' + staticIds.size + ')',
  parseErrors.length === 0 && lookups.length >= 90 && staticIds.size >= 60, parseErrors.join('; '));
ok('0 unresolved lookups (' + unresolved.length + ' found) — a getElementById that returns null on the shipped page is a feature that silently does nothing',
  unresolved.length === 0, 'fix the id in index.html or the JS that builds the element: ' + unresolved.map(site).join('  '));
for (const file of Object.keys(WRAPPERS)) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const calls = viaWrapper.filter((l) => l.file === file);
  ok(file + ' ' + WRAPPERS[file] + '() is still a bare document.getElementById wrapper and its ' + calls.length + ' literal calls all resolve (' +
    Array.from(new Set(calls.map((l) => l.id))).sort().join(', ') + ')',
    src.indexOf(WRAPPER_SRC) >= 0 && calls.length >= 1 && calls.every((l) => resolvedBy(l.id)),
    src.indexOf(WRAPPER_SRC) < 0 ? 'the wrapper changed — re-read it and update WRAPPER_SRC/WRAPPERS' : 'unresolved: ' + calls.filter((l) => !resolvedBy(l.id)).map(site).join('  '));
}

/* ================= D2 — the allowlist ================= */
group('D2 — ALLOW is exactly one justified entry, still needed, still true');
const allowIds = Object.keys(ALLOW);
ok('ALLOW has exactly one entry (theme-css-custom) — a second computed id needs its reason written here, not a quiet addition',
  allowIds.length === 1 && allowIds[0] === 'theme-css-custom' && /js\/themes\.js/.test(ALLOW['theme-css-custom'] || ''), 'entries: ' + allowIds.join(', '));
const allowUnused = allowIds.filter((id) => !referenced.has(id));
ok('anti-rot: every allowlisted id is still looked up by a literal somewhere in js/ (an entry nothing references must be removed)',
  allowUnused.length === 0, 'unreferenced: ' + allowUnused.join(', '));
const allowRedundant = allowIds.filter((id) => staticIds.has(id) || assigned.has(id));
ok('anti-rot: no allowlisted id is resolvable as static or js-assigned (then the entry is a bypass, not a reason)',
  allowRedundant.length === 0, 'now resolvable, drop from ALLOW: ' + allowRedundant.join(', '));
const themes = fs.readFileSync(path.join(ROOT, 'js', 'themes.js'), 'utf8');
ok("the reason still holds: js/themes.js builds the tag id as 'theme-css-' + def.id and looks up 'theme-css-custom' by literal",
  themes.indexOf("'theme-css-' + def.id") >= 0 && themes.indexOf("getElementById('theme-css-custom')") >= 0);

/* ================= D3 — informational pins ================= */
// Not a ratchet. These are the measured shape of the tree; when a lookup or a
// static id is added or removed on purpose, update the number here so the
// change is visible in the diff instead of silent.
group('D3 — informational pins (update the number when the tree changes on purpose; never a ratchet)');
ok('101 direct document.getElementById(\'<literal>\') sites (measured ' + direct.length + ')', direct.length === 101);
ok('7 literal lookups through the js/radar.js byId() wrapper (measured ' + viaWrapper.length + ')', viaWrapper.length === 7);
ok('71 static id="…" in index.html (measured ' + staticIds.size + ')', staticIds.size === 71);
ok('22 referenced ids that are not static: 21 assigned in js/ + 1 allowlisted (measured ' + notStatic.length + ' = ' + jsAssignedRefs.length + ' + ' + notStatic.filter((id) => ALLOW[id]).length + ')',
  notStatic.length === 22 && jsAssignedRefs.length === 21);
ok('3 non-literal getElementById calls, all known: the js/radar.js wrapper itself and the two computed theme tags in js/themes.js (measured ' + dynamicLookups.length + ': ' + dynamicLookups.join(', ') + ')',
  dynamicLookups.length === 3 && dynamicLookups.every((d) => /^js\/(radar|themes)\.js:/.test(d)));

/* ================= D4 — the ledger, executed ================= */
group('D4 — BUGS.md frontend-001 / 008 / 009 / 010: every id those functions dereference is looked up where the entry says and is static in index.html');
const LEDGER = [
  ['frontend-001', 'js/mapview.js', 'ctl-zoom-in'], ['frontend-001', 'js/mapview.js', 'ctl-zoom-out'], ['frontend-001', 'js/mapview.js', 'ctl-compass'],
  ['frontend-001', 'js/mapview.js', 'ctl-locate'], ['frontend-001', 'js/mapview.js', 'ctl-recenter'],
  ['frontend-008', 'js/ui.js', 'dock-convoy-badge'],
  ['frontend-009', 'js/routing.js', 'eta-card'],
  ['frontend-010', 'js/ui.js', 'nearby-body'], ['frontend-010', 'js/ui.js', 'convoy-body'], ['frontend-010', 'js/ui.js', 'profile-body']
];
for (const [bug, file, id] of LEDGER) {
  const at = lookups.filter((l) => l.file === file && l.id === id);
  ok(bug + ': #' + id + ' — looked up in ' + file + (at.length ? ' (line ' + at.map((l) => l.line).join(', ') + ')' : ' (NOT FOUND)') + ' and static in index.html (' + (staticIds.has(id) ? 'yes' : 'NO') + ')',
    at.length >= 1 && staticIds.has(id));
}

process.exit(H.report());
