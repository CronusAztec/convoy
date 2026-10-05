/* Convoy — feature-pack registry (server side).

   WHY PACKS EXIST. The store builds of Convoy carry only the core product —
   live riders, proximity voice, convoys, routes, profiles. Everything that was
   withdrawn for store review on 2026-10-04 (enforcement awareness, scanner
   audio, the performance timers, map overlays, the instrument HUD) was not
   deleted; it was moved out of the binary and into packs/<id>/ on the server,
   where it is handed to an app only after the account using it has redeemed a
   code (server/packcodes.js, migrations/004_feature_packs.sql).

   That split is what keeps the app publishable. A dormant feature inside the
   binary that a code switches on is exactly what Apple's guideline 2.3.1
   ("hidden features") rejects and what Play's reviewers call undisclosed
   functionality. Code the app downloads from its own origin, interpreted in
   the WebView, is explicitly allowed by both (Apple 2.5.2, Play's WebView
   rule) as long as it does not change the app's core purpose — these packs
   extend the map the rider already has. So the rule this module enforces is
   simple and absolute: NOTHING under packs/ is ever copied into www/, the APK,
   the IPA or an OTA bundle (scripts/copy-web.js names what ships; test/
   packs.test.js pins that packs/ is not in it), and every byte of a pack
   leaves this server only for a request that proves the account holds it.

   HOW A PACK IS SHAPED.
     packs/<id>/pack.json          the manifest (see validateManifest below):
                                   title, blurb, legal key, ordered scripts,
                                   styles and HTML fragments with mount points
     packs/<id>/*.js, *.css, *.html the client code, written against the hook
                                   points the core exposes (A.packs.register,
                                   A.store.registerSettings, A.ui.addHook,
                                   A.mapview.onStyle/onClick, A.net.on/send,
                                   A.routing.hook) — the same vanilla ES5
                                   modules they were before the cut
     server/packs/<id>.js          OPTIONAL server half: HTTP routes and
                                   socket handlers, every one of them only
                                   dispatched for an account that holds the
                                   pack:
                                     module.exports = {
                                       id: '<id>',
                                       init(ctx) {},                 // optional
                                       routes: [[method, regex, fn]], // fn(req, res, match, user, ctx)
                                       ws: { 'type'(c, m, ctx) {} },  // c.packs has <id>, guaranteed
                                       onHello(c, ctx), onClose(c, ctx) // optional
                                     }
                                   ctx is the object server.js hands to init()
                                   (clients, parties, send, rateOk, store, …;
                                   see packCtx in server/server.js).

   HOW THE STATIC FILES ARE GATED. A <script src> cannot carry a bearer
   token, so GET /api/packs (an authenticated call) answers with URLs that
   carry a short-lived signed token per pack: ?t=<payload>.<hmac>, payload =
   { u: account id, p: pack id, e: expiry }. The static handler in server.js
   asks staticOk() before it will even stat a file under /packs/: the path
   must name a registered, enabled pack and a servable file (never pack.json),
   the token must verify, be unexpired and name THIS pack, and the account in
   it must STILL hold the pack — so a revoke or a kill switch takes effect on
   the next load, not when the token runs out. The secret is per process
   unless PACK_TOKEN_SECRET is set; tokens die with a restart, and a client
   that hits a 403 simply calls /api/packs again.

   KILL SWITCHES. Every pack has a flag 'pack:<id>' on the control panel's
   board (server/flags.js reads the packs/ directory for the names). Forced
   off, the pack disappears from manifests, its files 403, its routes 404 and
   its socket handlers go silent — for everyone, instantly, without touching
   the grants. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Both directories are overridable for tests only (fixture packs under a temp
// dir); production reads the repo's own packs/ and server/packs/.
const PACKS_DIR = process.env.CONVOY_PACKS_DIR || path.join(__dirname, '..', '..', 'packs');
const SERVER_DIR = process.env.CONVOY_PACKS_SERVER_DIR || __dirname;
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const SERVABLE = /\.(js|css|html|svg|png|webp|jpg|jpeg|gif|json|mp3|wav|ogg|woff2)$/i;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MOUNT_POSITIONS = ['append', 'prepend', 'before', 'after'];

let ctx = null;                      // server.js hands this over in init()
const registry = new Map();          // id -> manifest (validated, fragments inlined)
const serverMods = new Map();        // id -> require()d server half
const wsIndex = new Map();           // message type -> { id, fn }
let secret = null;

function secretKey() {
  if (!secret) secret = process.env.PACK_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
  return secret;
}

/* ---------------- manifests ---------------- */
function validateManifest(id, m) {
  const bad = (why) => { throw new Error('packs/' + id + '/pack.json: ' + why); };
  if (!m || typeof m !== 'object') bad('not an object');
  if (m.id !== id) bad('id must equal the directory name');
  if (typeof m.title !== 'string' || !m.title.trim()) bad('title required');
  if (typeof m.blurb !== 'string') bad('blurb required (may be empty)');
  if (m.legal !== undefined && m.legal !== null && typeof m.legal !== 'string') bad('legal must be a string key');
  const list = (k) => {
    const v = m[k] === undefined ? [] : m[k];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && /^[\w.-]+$/.test(s))) bad(k + ' must be an array of bare file names');
    return v;
  };
  const scripts = list('scripts'), styles = list('styles');
  const fragments = (m.fragments === undefined ? [] : m.fragments).map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.file !== 'string' || !/^[\w.-]+\.html$/.test(f.file)) bad('fragments[' + i + '].file must be a bare .html name');
    const position = f.position === undefined ? 'append' : f.position;
    if (MOUNT_POSITIONS.indexOf(position) < 0) bad('fragments[' + i + '].position must be one of ' + MOUNT_POSITIONS.join('/'));
    if (f.mount !== undefined && (typeof f.mount !== 'string' || !f.mount.trim())) bad('fragments[' + i + '].mount must be a selector');
    return { file: f.file, mount: f.mount || 'body', position };
  });
  scripts.concat(styles, fragments.map((f) => f.file)).forEach((f) => {
    if (f === 'pack.json' || !fs.existsSync(path.join(PACKS_DIR, id, f))) bad('listed file missing: ' + f);
  });
  if (!scripts.length) bad('a pack must have at least one script');
  return {
    id, title: m.title.trim(), blurb: m.blurb, legal: m.legal || null,
    order: typeof m.order === 'number' ? m.order : 100,
    scripts, styles,
    fragments: fragments.map((f) => Object.assign({}, f, {
      html: fs.readFileSync(path.join(PACKS_DIR, id, f.file), 'utf8')
    }))
  };
}

function packIds() {
  let names = [];
  try { names = fs.readdirSync(PACKS_DIR, { withFileTypes: true }); } catch (e) { return []; }
  return names.filter((d) => d.isDirectory() && ID_RE.test(d.name) &&
    fs.existsSync(path.join(PACKS_DIR, d.name, 'pack.json'))).map((d) => d.name).sort();
}

/* Load every pack on disk. Throws on a malformed manifest or a server half
   that claims a socket message another pack (or the core) already owns: a
   pack that half-loads is worse than a boot that fails with the file name. */
function load(coreHandlers) {
  registry.clear(); serverMods.clear(); wsIndex.clear();
  for (const id of packIds()) {
    const raw = fs.readFileSync(path.join(PACKS_DIR, id, 'pack.json'), 'utf8');
    let m;
    try { m = JSON.parse(raw); } catch (e) { throw new Error('packs/' + id + '/pack.json: ' + e.message); }
    registry.set(id, validateManifest(id, m));
    const serverFile = path.join(SERVER_DIR, id + '.js');
    if (fs.existsSync(serverFile)) {
      const mod = require(serverFile);
      if (mod.id !== id) throw new Error('server/packs/' + id + '.js: id must be ' + JSON.stringify(id));
      for (const type of Object.keys(mod.ws || {})) {
        if (coreHandlers && Object.prototype.hasOwnProperty.call(coreHandlers, type)) throw new Error('server/packs/' + id + '.js: ws handler ' + type + ' collides with the core');
        if (wsIndex.has(type)) throw new Error('server/packs/' + id + '.js: ws handler ' + type + ' collides with pack ' + wsIndex.get(type).id);
        if (typeof mod.ws[type] !== 'function') throw new Error('server/packs/' + id + '.js: ws.' + type + ' is not a function');
        wsIndex.set(type, { id, fn: mod.ws[type] });
      }
      (mod.routes || []).forEach((r, i) => {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || !(r[1] instanceof RegExp) || typeof r[2] !== 'function') throw new Error('server/packs/' + id + '.js: routes[' + i + '] must be [method, regex, fn]');
      });
      serverMods.set(id, mod);
    }
  }
  return [...registry.keys()];
}

function init(serverCtx, coreHandlers) {
  ctx = serverCtx;
  const ids = load(coreHandlers);
  for (const [id, mod] of serverMods) if (typeof mod.init === 'function') mod.init(ctx);
  console.log('[boot] feature packs: ' + (ids.length ? ids.join(', ') : 'none on disk') +
    (serverMods.size ? ' (' + serverMods.size + ' with a server half)' : ''));
  return ids;
}

/* ---------------- queries ---------------- */
function has(id) { return registry.has(id); }
function get(id) { return registry.get(id) || null; }
function enabled(id) {
  if (!registry.has(id)) return false;
  return ctx && ctx.flags ? ctx.flags.pick('pack:' + id, true) : true;
}
function list() {
  return [...registry.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((p) => ({ id: p.id, title: p.title, blurb: p.blurb, legal: p.legal }));
}
// Public catalogue: what exists, for the redeem screen (guests see it too).
function catalog() { return list().filter((p) => enabled(p.id)); }

function holds(userId, id) {
  return !!(ctx && ctx.store && userId && ctx.store.hasPack(userId, id));
}
function heldBy(user) {
  if (!user) return [];
  return (ctx.store.packsOf(user.id) || []).filter((id) => enabled(id));
}

/* ---------------- signed file tokens ---------------- */
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secretKey()).update(body).digest();
  return body + '.' + b64u(mac);
}
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const mac = crypto.createHmac('sha256', secretKey()).update(parts[0]).digest();
  const given = unb64u(parts[1]);
  if (given.length !== mac.length || !crypto.timingSafeEqual(given, mac)) return null;
  let p;
  try { p = JSON.parse(unb64u(parts[0]).toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.u !== 'string' || typeof p.p !== 'string' || typeof p.e !== 'number') return null;
  if (p.e <= Date.now()) return null;
  return p;
}

/* What the client loader needs for one account: the packs it holds, each with
   its fragments inlined and its files as tokened URLs, plus the rest of the
   catalogue so the redeem screen can say what a code could unlock. */
function manifestFor(user, now) {
  now = now || Date.now();
  const held = heldBy(user);
  const packs = held.map((id) => {
    const p = registry.get(id);
    const t = sign({ u: user.id, p: id, e: now + TOKEN_TTL_MS });
    const url = (f) => '/packs/' + id + '/' + f + '?t=' + t;
    return {
      id, title: p.title, blurb: p.blurb, legal: p.legal,
      scripts: p.scripts.map(url), styles: p.styles.map(url),
      fragments: p.fragments.map((f) => ({ mount: f.mount, position: f.position, html: f.html }))
    };
  });
  return { packs, available: catalog().filter((p) => held.indexOf(p.id) < 0), expiresIn: TOKEN_TTL_MS };
}

/* The static gate. `urlPath` is the raw request path (no query); the token
   rides in the query string. */
function staticOk(req, urlPath) {
  const m = /^\/packs\/([^/]+)\/([^/]+)$/.exec(urlPath);
  if (!m) return false;
  const id = m[1], file = m[2];
  if (!enabled(id)) return false;
  if (file === 'pack.json' || !SERVABLE.test(file) || file[0] === '.') return false;
  const p = registry.get(id);
  const known = p.scripts.concat(p.styles);
  if (known.indexOf(file) < 0 && !SERVABLE.test(file)) return false;
  const q = String(req.url || '').indexOf('?');
  const qs = q >= 0 ? req.url.slice(q + 1) : '';
  let token = null;
  for (const kv of qs.split('&')) {
    if (kv.indexOf('t=') === 0) { token = decodeURIComponent(kv.slice(2)); break; }
  }
  const payload = verify(token);
  if (!payload || payload.p !== id) return false;
  return holds(payload.u, id);
}

/* ---------------- HTTP + socket dispatch ---------------- */
// Returns true when a pack route answered (or refused) the request.
async function handleApi(req, res, urlPath) {
  for (const [id, mod] of serverMods) {
    for (const [method, re, fn] of (mod.routes || [])) {
      const m = urlPath.match(re);
      if (!m || req.method !== method) continue;
      if (!enabled(id)) return false;        // killed: fall through to the 404
      const user = ctx.userFromToken(ctx.bearer(req));
      if (!user) { ctx.json(res, 401, { error: 'unauthorized' }); return true; }
      if (!holds(user.id, id)) { ctx.json(res, 403, { error: 'pack-required', pack: id }); return true; }
      await fn(req, res, m, user, ctx);
      return true;
    }
  }
  return false;
}

// The socket side: a handler for `type` that only runs for a socket whose
// account holds (and whose pack still has) the pack, else drops the frame
// silently — the same shape as an unknown message type.
function wsHandler(type) {
  const e = wsIndex.get(type);
  if (!e) return null;
  return function (c, m) {
    if (!c.packs || !c.packs.has(e.id) || !enabled(e.id)) return;
    e.fn(c, m, ctx);
  };
}

function onHello(c, user) {
  c.packs = new Set(user ? heldBy(user) : []);
  for (const id of c.packs) {
    const mod = serverMods.get(id);
    if (mod && typeof mod.onHello === 'function') {
      try { mod.onHello(c, ctx); } catch (e) { console.error('[pack ' + id + ' hello]', e.message); }
    }
  }
}
function onClose(c) {
  if (!c.packs) return;
  for (const id of c.packs) {
    const mod = serverMods.get(id);
    if (mod && typeof mod.onClose === 'function') {
      try { mod.onClose(c, ctx); } catch (e) { console.error('[pack ' + id + ' close]', e.message); }
    }
  }
}
function packsForSocket(c) { return c.packs ? [...c.packs] : []; }

// Who holds what, for the control panel.
function holders(id) { return ctx && ctx.store && ctx.store.packHolders ? ctx.store.packHolders(id) : 0; }

module.exports = {
  init, load, has, get, enabled, list, catalog, manifestFor, staticOk,
  handleApi, wsHandler, onHello, onClose, packsForSocket, holders, packIds,
  PACKS_DIR, SERVER_DIR, TOKEN_TTL_MS,
  // test surface
  _sign: sign, _verify: verify, _validateManifest: validateManifest, _registry: registry,
  _setCtx: (c) => { ctx = c; }, _reset: () => { registry.clear(); serverMods.clear(); wsIndex.clear(); secret = null; }
};
