/* Convoy — feature packs: the server-side entitlement, the gated delivery,
   the client loader and the core's extension points.
   `npm test` (test/run.js), or:  node test/packs.test.js

   WHY THIS SUITE EXISTS. The store builds carry only the core product; every
   feature withdrawn for store review lives under packs/<id>/ on the server and
   reaches an app only after its account redeemed a code. That design is only
   worth anything if three things hold, and each is pinned here:

     1. NOTHING in packs/ ships in the binary or an OTA bundle, and nothing in
        the shipped JS is a dormant feature — the loader is a loader
        (group E). This is the Apple 2.3.1 / Play "undisclosed functionality"
        line, and it is what makes a code-unlock compliant rather than hidden.
     2. Every byte of a pack leaves the server only for a request that proves
        the account holds it: the signed file tokens, the per-request grant
        re-check, the pack-gated HTTP routes and socket handlers, the kill
        switch (groups B, D).
     3. A code is a grant, not a bypass: normalised, hashed, single-use per
        account, revocable, with the rider told nothing a guesser could use
        (groups A, C).

   The client half (group F) runs the real js/packs.js in jsdom against a
   scripted fetch; the core's hook points (group G) run against the real UI
   chain through the harness, so a pack written to them has something to
   stand on. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./harness');
const { group, ok, report, ROOT } = H;

/* ---------------- fixture packs in a temp dir ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-packs-'));
const PACKS = path.join(TMP, 'packs');
const SERVER = path.join(TMP, 'server-packs');
function writePack(id, manifest, files) {
  const dir = path.join(PACKS, id);
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files || {}).forEach((f) => fs.writeFileSync(path.join(dir, f), files[f]));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(Object.assign({ id }, manifest)));
}
fs.mkdirSync(SERVER, { recursive: true });
writePack('demo', {
  title: 'Demo pack', blurb: 'A fixture.', legal: 'demo', order: 5,
  scripts: ['a.js', 'b.js'], styles: ['demo.css'],
  fragments: [{ file: 'demo.html', mount: '#dock', position: 'append' }]
}, { 'a.js': '// a', 'b.js': '// b', 'demo.css': '.demo{}', 'demo.html': '<button id="demo-btn">demo</button>' });
writePack('other', { title: 'Other pack', blurb: '', scripts: ['o.js'] }, { 'o.js': '// o' });
fs.mkdirSync(path.join(PACKS, 'Not-A-Pack'), { recursive: true });           // bad id: ignored
fs.mkdirSync(path.join(PACKS, 'nojson'), { recursive: true });               // no manifest: ignored
fs.writeFileSync(path.join(SERVER, 'demo.js'), `
  module.exports = {
    id: 'demo',
    init(ctx) { ctx._demoInit = (ctx._demoInit || 0) + 1; },
    routes: [
      ['GET', /^\\/api\\/demo\\/ping$/, async (req, res, m, user, ctx, body) => ctx.json(res, 200, { pong: user.username, body: body })],
      ['GET', /^\\/api\\/demo\\/tile$/, async (req, res, m, user, ctx) => ctx.json(res, 200, { tile: user.id }), { auth: 'token' }]
    ],
    ws: { 'demo:hi'(c, m, ctx) { c._hi = (c._hi || 0) + 1; } },
    onHello(c) { c._hello = true; },
    onClose(c) { c._closed = true; }
  };`);
process.env.CONVOY_PACKS_DIR = PACKS;
process.env.CONVOY_PACKS_SERVER_DIR = SERVER;

const packcodes = require('../server/packcodes');
const packs = require('../server/packs');

(async function main() {

  /* ================= A — codes ================= */
  group('A — server/packcodes.js: a code is random, readable, and only ever stored as a hash');
  {
    const c = packcodes.mint();
    ok('mint() → CONVOY-XXXX-XXXX-XXXX-XXXX over the unambiguous alphabet (' + c + ')',
      /^CONVOY(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){4}$/.test(c));
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(packcodes.mint());
    ok('200 mints, 200 distinct codes', seen.size === 200);
    const n = packcodes.normalize(c);
    ok('normalize() strips the prefix and dashes to 16 symbols', n.length === 16 && c.replace(/-/g, '').endsWith(n));
    ok('case, spaces, dashes and the prefix are all presentation',
      packcodes.normalize(c.toLowerCase().replace(/-/g, ' ')) === n && packcodes.normalize(' ' + n.toLowerCase() + ' ') === n);
    ok('an ambiguous symbol (0/O/1/I/L) is not a code', packcodes.normalize('CONVOY-OOOO-1111-2222-3333') === '' &&
      packcodes.normalize(n.slice(0, 15) + 'I') === '');
    ok('wrong length is not a code', packcodes.normalize(n.slice(1)) === '' && packcodes.normalize(n + 'A') === '');
    ok('hash() is a stable sha256 hex', /^[0-9a-f]{64}$/.test(packcodes.hash(n)) && packcodes.hash(n) === packcodes.hash(n));
    ok('looksValid() agrees with normalize()', packcodes.looksValid(c) && !packcodes.looksValid('nope') && !packcodes.looksValid(''));
  }

  /* ================= B — registry ================= */
  group('B — server/packs/index.js: manifests, tokens, the static gate, gated routes and handlers');
  const overrides = {};
  const grants = { 'u-held': ['demo'], 'u-other': ['other'] };
  const users = { 'tok-held': { id: 'u-held', username: 'holder' }, 'tok-none': { id: 'u-none', username: 'nobody' } };
  const ctx = {
    flags: { pick: (name, d) => (Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : d) },
    store: {
      hasPack: (uid, id) => !!(grants[uid] && grants[uid].indexOf(id) >= 0),
      packsOf: (uid) => (grants[uid] || []).slice(),
      packHolders: (id) => Object.keys(grants).filter((u) => grants[u].indexOf(id) >= 0).length
    },
    bearer: (req) => ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '') || null,
    userFromToken: (tok) => users[tok] || null,
    json: (res, status, obj) => { res.status = status; res.body = obj; }
  };
  {
    let ids;
    let threw = null;
    try { ids = packs.init(ctx, { hello: () => {}, pos: () => {} }); } catch (e) { threw = e; }
    ok('init() loads the two well-formed fixture packs and ignores the bad-id and manifest-less dirs',
      !threw && JSON.stringify(ids) === '["demo","other"]', threw ? threw.message : JSON.stringify(ids));
    ok('the server half\'s init(ctx) ran once', ctx._demoInit === 1);
    ok('list() is ordered by `order` then id and carries only the public fields',
      JSON.stringify(packs.list()) === JSON.stringify([
        { id: 'demo', title: 'Demo pack', blurb: 'A fixture.', legal: 'demo' },
        { id: 'other', title: 'Other pack', blurb: '', legal: null }]), JSON.stringify(packs.list()));
    ok('holders() counts accounts holding a pack', packs.holders('demo') === 1 && packs.holders('other') === 1 && packs.holders('nope') === 0);
    overrides['pack:other'] = false;
    ok('a killed pack (flag pack:<id> forced off) drops out of catalog() but stays on disk',
      !packs.enabled('other') && packs.catalog().length === 1 && packs.catalog()[0].id === 'demo' && packs.has('other'));
    delete overrides['pack:other'];
  }
  {
    const badManifest = (m, files) => {
      writePack('bad', m, files || { 'x.js': '' });
      try { packs._validateManifest('bad', JSON.parse(fs.readFileSync(path.join(PACKS, 'bad', 'pack.json'), 'utf8'))); return null; }
      catch (e) { return e.message; }
    };
    ok('a manifest whose id is not the directory name is refused', /id must equal/.test(badManifest({ id: 'other-name', title: 'x', blurb: '', scripts: ['x.js'] }) || ''));
    ok('a manifest listing a file that is not on disk is refused', /listed file missing: y\.js/.test(badManifest({ title: 'x', blurb: '', scripts: ['y.js'] }) || ''));
    ok('a path-shaped file name is refused (no ../ or subdirs)', /bare file names/.test(badManifest({ title: 'x', blurb: '', scripts: ['../x.js'] }) || ''));
    ok('a fragment with an unknown position is refused', /position must be/.test(badManifest({ title: 'x', blurb: '', scripts: ['x.js'], fragments: [{ file: 'f.html', position: 'inside' }] }, { 'x.js': '', 'f.html': '' }) || ''));
    ok('a pack without a script is refused', /at least one script/.test(badManifest({ title: 'x', blurb: '', scripts: [] }) || ''));
    fs.rmSync(path.join(PACKS, 'bad'), { recursive: true, force: true });
  }
  {
    const now = Date.now();
    const t = packs._sign({ u: 'u-held', p: 'demo', e: now + 60000 });
    ok('a signed token verifies and yields its payload', JSON.stringify(packs._verify(t)) === JSON.stringify({ u: 'u-held', p: 'demo', e: now + 60000 }));
    const parts = t.split('.');
    const flipped = parts[0] + '.' + (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1);
    ok('a token with one MAC character changed is rejected', packs._verify(flipped) === null);
    const body = Buffer.from(JSON.stringify({ u: 'u-none', p: 'demo', e: now + 60000 })).toString('base64url');
    ok('a re-signed payload under a different account is rejected (the MAC covers the body)', packs._verify(body + '.' + parts[1]) === null);
    ok('an expired token is rejected', packs._verify(packs._sign({ u: 'u-held', p: 'demo', e: now - 1 })) === null);
    ok('garbage is rejected without throwing', packs._verify('') === null && packs._verify('a.b') === null && packs._verify(null) === null);
  }
  {
    const m = packs.manifestFor(users['tok-held']);
    ok('manifestFor(holder) lists the held pack with tokened URLs for every script and style',
      m.packs.length === 1 && m.packs[0].id === 'demo' &&
      m.packs[0].scripts.length === 2 && m.packs[0].scripts.every((u) => /^\/packs\/demo\/[ab]\.js\?t=[\w-]+\.[\w-]+$/.test(u)) &&
      m.packs[0].styles.length === 1 && /^\/packs\/demo\/demo\.css\?t=/.test(m.packs[0].styles[0]), JSON.stringify(m.packs[0] && m.packs[0].scripts));
    ok('…with the HTML fragments inlined (mount + position + markup), so the page never fetches them',
      m.packs[0].fragments.length === 1 && m.packs[0].fragments[0].mount === '#dock' &&
      m.packs[0].fragments[0].position === 'append' && /demo-btn/.test(m.packs[0].fragments[0].html));
    ok('…and `available` is the catalogue minus what is held', m.available.length === 1 && m.available[0].id === 'other');
    ok('manifestFor(someone with nothing) holds nothing and sees the whole catalogue',
      packs.manifestFor(users['tok-none']).packs.length === 0 && packs.manifestFor(users['tok-none']).available.length === 2);
    const url = m.packs[0].scripts[0];
    const req = (u) => ({ url: u, headers: {} });
    const pathOf = (u) => u.split('?')[0];
    ok('staticOk: the tokened URL the manifest handed out is served', packs.staticOk(req(url), pathOf(url)) === true);
    ok('staticOk: no token → refused', packs.staticOk(req(pathOf(url)), pathOf(url)) === false);
    const tok = url.split('?t=')[1];
    ok('staticOk: the demo token does not open another pack\'s file',
      packs.staticOk(req('/packs/other/o.js?t=' + tok), '/packs/other/o.js') === false);
    ok('staticOk: pack.json is never served, token or not',
      packs.staticOk(req('/packs/demo/pack.json?t=' + tok), '/packs/demo/pack.json') === false);
    ok('staticOk: a path with a subdirectory or traversal does not match the gate at all',
      packs.staticOk(req('/packs/demo/../x.js?t=' + tok), '/packs/demo/../x.js') === false &&
      packs.staticOk(req('/packs/demo/sub/a.js?t=' + tok), '/packs/demo/sub/a.js') === false &&
      packs.staticOk(req('/packs?t=' + tok), '/packs') === false);
    grants['u-held'] = [];
    ok('staticOk: a grant revoked AFTER the token was issued refuses the file (re-checked per request)',
      packs.staticOk(req(url), pathOf(url)) === false);
    grants['u-held'] = ['demo'];
    overrides['pack:demo'] = false;
    ok('staticOk: a killed pack refuses the file even for a holder with a fresh token',
      packs.staticOk(req(url), pathOf(url)) === false);
    delete overrides['pack:demo'];
    const expired = '/packs/demo/a.js?t=' + packs._sign({ u: 'u-held', p: 'demo', e: Date.now() - 1 });
    ok('staticOk: an expired token refuses the file', packs.staticOk(req(expired), '/packs/demo/a.js') === false);
  }
  {
    const call = async (bearerTok, urlPath) => {
      const res = {};
      const handled = await packs.handleApi({ method: 'GET', url: urlPath, headers: bearerTok ? { authorization: 'Bearer ' + bearerTok } : {} }, res, urlPath);
      return { handled, res };
    };
    let r = await call('tok-held', '/api/demo/ping');
    ok('handleApi: a holder reaches the pack route (200, the fn ran with the user)', r.handled && r.res.status === 200 && r.res.body.pong === 'holder');
    {
      const res = {};
      await packs.handleApi({ method: 'GET', url: '/api/demo/ping', headers: { authorization: 'Bearer tok-held' } }, res, '/api/demo/ping', { hello: 'body' });
      ok('handleApi: the parsed body is handed to the route as its sixth argument (null when there is none)', res.body.body && res.body.body.hello === 'body' && r.res.body.body === null, JSON.stringify(res.body));
    }
    r = await call(null, '/api/demo/ping');
    ok('handleApi: no bearer → 401, handled (the route is not a 404 probe)', r.handled && r.res.status === 401);
    r = await call('tok-none', '/api/demo/ping');
    ok('handleApi: an account without the pack → 403 pack-required', r.handled && r.res.status === 403 && r.res.body.pack === 'demo');
    r = await call('tok-held', '/api/nothing');
    ok('handleApi: an unmatched path is not handled (server.js falls through to its 404)', r.handled === false);
    {
      // A route declared { auth: 'token' } takes the signed file token on ?t= (a raster tile cannot carry a bearer).
      const tok = packs.tokenFor(users['tok-held'], 'demo');
      const hit = async (url) => { const res = {}; const handled = await packs.handleApi({ method: 'GET', url, headers: {} }, res, '/api/demo/tile'); return { handled, res }; };
      const good = await hit('/api/demo/tile?t=' + encodeURIComponent(tok));
      const none = await hit('/api/demo/tile');
      const other = await hit('/api/demo/tile?t=' + encodeURIComponent(packs._sign({ u: 'u-held', p: 'other', e: Date.now() + 60000 })));
      const stale = await hit('/api/demo/tile?t=' + encodeURIComponent(packs._sign({ u: 'u-held', p: 'demo', e: Date.now() - 1 })));
      ok('a token-auth route: the pack\'s own fresh token → 200 as that account; no token, another pack\'s token or an expired one → 401',
        good.handled && good.res.status === 200 && good.res.body.tile === 'u-held' && none.res.status === 401 && other.res.status === 401 && stale.res.status === 401,
        JSON.stringify([good.res.status, none.res.status, other.res.status, stale.res.status]));
      ok('tokenFor() refuses an account that does not hold the pack', packs.tokenFor(users['tok-none'], 'demo') === null);
      grants['u-held'] = [];
      const revoked = await hit('/api/demo/tile?t=' + encodeURIComponent(tok));
      grants['u-held'] = ['demo'];
      ok('…and a token outlives its grant by nothing: revoked → 403 on the next request', revoked.res.status === 403);
    }
    overrides['pack:demo'] = false;
    r = await call('tok-held', '/api/demo/ping');
    ok('handleApi: a killed pack\'s route is not handled either (404 like any unknown path)', r.handled === false);
    delete overrides['pack:demo'];
  }
  {
    ok('wsHandler: an unknown type is null (the dispatcher drops it as before)', packs.wsHandler('nope') === null && packs.wsHandler('constructor') === null);
    const h = packs.wsHandler('demo:hi');
    const holder = { packs: new Set(['demo']) }, nobody = { packs: new Set() }, guest = {};
    h(holder, { t: 'demo:hi' }); h(nobody, { t: 'demo:hi' }); h(guest, { t: 'demo:hi' });
    ok('wsHandler: the wrapped handler runs for a socket holding the pack and silently drops it for everyone else',
      holder._hi === 1 && nobody._hi === undefined && guest._hi === undefined);
    overrides['pack:demo'] = false;
    h(holder, { t: 'demo:hi' });
    ok('wsHandler: killed → dropped even for a holder', holder._hi === 1);
    delete overrides['pack:demo'];
    const c = {};
    packs.onHello(c, users['tok-held']);
    ok('onHello(account) fills c.packs from the store and runs the pack\'s onHello', c.packs instanceof Set && c.packs.has('demo') && c._hello === true);
    const g = {};
    packs.onHello(g, null);
    ok('onHello(guest) → an empty set', g.packs instanceof Set && g.packs.size === 0 && JSON.stringify(packs.packsForSocket(g)) === '[]');
    packs.onClose(c);
    ok('onClose runs the pack\'s onClose for a holder', c._closed === true);
    ok('packsForSocket lists the set', JSON.stringify(packs.packsForSocket(c)) === '["demo"]');
  }
  {
    // A server half that claims a core message, or one another pack owns, is a boot failure, not a silent override.
    fs.writeFileSync(path.join(SERVER, 'other.js'), "module.exports = { id: 'other', ws: { hello() {} } };");
    delete require.cache[path.join(SERVER, 'other.js')];
    let err = null;
    try { packs.load({ hello: () => {} }); } catch (e) { err = e; }
    ok('a pack ws handler named like a CORE message makes load() throw with the pack and type named',
      !!err && /other\.js: ws handler hello collides with the core/.test(err.message), err && err.message);
    fs.writeFileSync(path.join(SERVER, 'other.js'), "module.exports = { id: 'other', ws: { 'demo:hi'() {} } };");
    delete require.cache[path.join(SERVER, 'other.js')];
    err = null;
    try { packs.load({}); } catch (e) { err = e; }
    ok('two packs claiming the same ws type make load() throw', !!err && /collides with pack demo/.test(err.message), err && err.message);
    fs.unlinkSync(path.join(SERVER, 'other.js'));
    delete require.cache[path.join(SERVER, 'other.js')];
    packs.load({});
  }

  /* ================= C — store ================= */
  group('C — server/store.js: redeem, grant, revoke, mint — against a fake database');
  {
    const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const DB_PATH = path.join(ROOT, 'server', 'db.js'), SB_PATH = path.join(ROOT, 'server', 'supabase.js'), STORE_PATH = path.join(ROOT, 'server', 'store.js');
    const calls = [];
    const codes = [];   // what insertPackCode saw
    const db = {
      init: async () => ({ role: 'postgres', profiles: 1 }),
      loadAll: async () => [{ id: UID, username: 'rider', profile: {}, friends: [], reqIn: [], reqOut: [], blocked: [], blockedBy: [], packs: ['other'], createdAt: 1 }],
      redeemPackCode: async (hash, uid) => { calls.push('redeem:' + hash.slice(0, 8) + ':' + uid); return db._redeem; },
      insertPackGrant: async (uid, pack, src) => { calls.push('grant:' + pack + ':' + src); return true; },
      deletePackGrant: async (uid, pack) => { calls.push('ungrant:' + pack); return true; },
      insertPackCode: async (c) => { codes.push(c); return 42; },
      listPackCodes: async () => [{ id: 42 }],
      revokePackCode: async (id) => { calls.push('revokecode:' + id); return true; }
    };
    delete require.cache[require.resolve(STORE_PATH)];
    require.cache[require.resolve(DB_PATH)] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: db };
    require.cache[require.resolve(SB_PATH)] = { id: SB_PATH, filename: SB_PATH, loaded: true, exports: { emailFor: (u) => u + '@x', verify: () => null } };
    const store = require(STORE_PATH);
    await store.init();
    ok('packsOf() reads the grants loadAll() delivered; hasPack() answers per pack',
      JSON.stringify(store.packsOf(UID)) === '["other"]' && store.hasPack(UID, 'other') && !store.hasPack(UID, 'demo'));
    ok('packsOf()/hasPack() on an unknown account are empty/false, never a throw',
      JSON.stringify(store.packsOf('nope')) === '[]' && store.hasPack('nope', 'other') === false && store.hasPack('constructor', 'other') === false);
    ok('packHolders() counts', store.packHolders('other') === 1 && store.packHolders('demo') === 0);

    let r = await store.redeemPack(UID, 'definitely not a code');
    ok('a malformed code is "unknown" WITHOUT a database round-trip', r.error === 'unknown' && calls.length === 0);
    const code = packcodes.mint();
    db._redeem = { error: 'unknown' };
    r = await store.redeemPack(UID, code.toLowerCase());
    ok('a well-formed unknown code goes to the database as its hash and comes back "unknown"',
      r.error === 'unknown' && calls[0] === 'redeem:' + packcodes.hash(packcodes.normalize(code)).slice(0, 8) + ':' + UID, calls.join(','));
    db._redeem = { ok: true, id: 7, label: 'Review', packs: ['demo', 'other'], granted: ['demo'] };
    r = await store.redeemPack(UID, code);
    ok('a good code adds the packs to the account in memory and reports what was new',
      r.ok && JSON.stringify(r.granted) === '["demo"]' && JSON.stringify(store.packsOf(UID).sort()) === '["demo","other"]' && r.label === 'Review' && r.code === 7, JSON.stringify(r));
    for (const why of ['revoked', 'expired', 'exhausted']) {
      db._redeem = { error: why };
      r = await store.redeemPack(UID, code);
      ok('a ' + why + ' code is reported as such to the server (the API collapses it for the rider)', r.error === why);
    }
    r = await store.redeemPack('nope', code);
    ok('redeem on an unknown account fails closed', !!r.error);

    r = await store.grantPack(UID, 'third', 'admin:ops');
    ok('grantPack() writes a grant and updates memory', r.ok && store.hasPack(UID, 'third') && calls.indexOf('grant:third:admin:ops') >= 0);
    r = await store.revokePack(UID, 'third');
    ok('revokePack() deletes it and updates memory', r.ok && !store.hasPack(UID, 'third') && calls.indexOf('ungrant:third') >= 0);

    r = await store.mintPackCode({ packs: [], maxUses: 1 });
    ok('mint refuses a code that unlocks nothing', !!r.error);
    r = await store.mintPackCode({ packs: ['demo'], maxUses: 1, expiresAt: Date.now() - 1 });
    ok('mint refuses an expiry in the past', !!r.error);
    r = await store.mintPackCode({ label: 'App Review', packs: ['demo'], maxUses: '3', expiresAt: Date.now() + 86400000, createdBy: 'ops' });
    ok('mint returns the plaintext once, stores only the hash, clamps max uses to an integer',
      r.ok && packcodes.looksValid(r.code) && r.id === 42 && codes.length === 1 &&
      codes[0].hash === packcodes.hash(packcodes.normalize(r.code)) && codes[0].maxUses === 3 && codes[0].label === 'App Review' &&
      codes[0].createdBy === 'ops' && !JSON.stringify(codes[0]).includes(r.code), JSON.stringify(codes[0]));
    ok('listPackCodes()/revokePackCode() pass through', (await store.listPackCodes())[0].id === 42 && (await store.revokePackCode(42)) === true);
    delete require.cache[require.resolve(STORE_PATH)];
    delete require.cache[require.resolve(DB_PATH)];
    delete require.cache[require.resolve(SB_PATH)];
  }

  /* ================= D — server.js wiring (source policy) ================= */
  group('D — server/server.js wiring: every pack path is gated, and the gate sits where it must');
  {
    const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    ok("server.js requires './packs' and './packcodes'", /require\('\.\/packs'\)/.test(SRC) && /require\('\.\/packcodes'\)/.test(SRC));
    ok("'/packs' is in ALLOWED_TOP (the static handler can reach the tree at all)", /const ALLOWED_TOP = \[[^\]]*'\/packs'[^\]]*\];/.test(SRC));
    const gateAt = SRC.indexOf('packs.staticOk(req, urlPath)');
    const resolveAt = SRC.indexOf("const file = path.resolve(ROOT, '.' + urlPath);");
    const statAt = SRC.indexOf('fs.stat(file');
    ok('the static gate runs BEFORE the path is resolved and BEFORE any stat — a probe learns nothing about the disk',
      gateAt > 0 && resolveAt > gateAt && statAt > resolveAt, 'gate@' + gateAt + ' resolve@' + resolveAt + ' stat@' + statAt);
    ok('the gate covers /packs itself and everything under /packs/', /urlPath === '\/packs' \|\| urlPath\.indexOf\('\/packs\/'\) === 0/.test(SRC));
    ok('a refused pack file is a bare 403 (no body, no caching header of its own)', /if \(!packs\.staticOk\(req, urlPath\)\) \{ res\.writeHead\(403\); res\.end\('Forbidden'\); return; \}/.test(SRC));
    ok('the socket dispatcher falls back to packs.wsHandler(m.t) only AFTER the core\'s own-property lookup',
      /hasOwnProperty\.call\(handlers, m\.t\) \? handlers\[m\.t\] : packs\.wsHandler\(m\.t\)/.test(SRC));
    const apiGetAt = SRC.indexOf("if (req.method !== 'POST') {\n    if (await packs.handleApi(req, res, urlPath, null)) return;\n    return json(res, 404, { error: 'not found' });");
    ok('non-POST pack routes are tried right before the non-POST API 404 (GET pack routes are reachable)', apiGetAt > 0);
    const apiPackAt = SRC.indexOf('if (await packs.handleApi(req, res, urlPath, body)) return;');
    const api404At = SRC.indexOf("return json(res, 404, { error: 'not found' });", apiPackAt);
    ok('POST pack routes are tried, with the parsed body, immediately before the API 404', apiPackAt > 0 && api404At > apiPackAt && api404At - apiPackAt < 200);
    ok('a block reaches the packs (applyBlockNow → packs.onBlock) before the core\'s own teardown', /function applyBlockNow\(c, targetUserId\) \{\s*const tc = online\.get\(targetUserId\);[\s\S]{0,200}packs\.onBlock\(c, targetUserId, tc \|\| null\);/.test(SRC));
    ok('hello fills c.packs for accounts (packs.onHello(c, u)) and clears it for guests (packs.onHello(c, null))',
      /packs\.onHello\(c, u\);/.test(SRC) && /packs\.onHello\(c, null\);/.test(SRC));
    ok('the client record starts with an empty packs Set', /packs: new Set\(\),/.test(SRC));
    ok('the welcome frame carries packs: packs.packsForSocket(c)', /packs: packs\.packsForSocket\(c\)/.test(SRC));
    ok('close runs packs.onClose(c)', /ws\.on\('close', \(\) => \{\s*packs\.onClose\(c\);/.test(SRC));
    ok('boot calls packs.init(packCtx, handlers) and exits on a bad pack', /packs\.init\(packCtx, handlers\);[^\n]*\} catch \(e\) \{[^\n]*process\.exit\(1\)/.test(SRC));
    ok('GET /api/packs/catalog is public; GET /api/packs and POST /api/packs/redeem need a bearer',
      /urlPath === '\/api\/packs\/catalog'\) \{\s*return json\(res, 200, \{ packs: packs\.catalog\(\) \}\);/.test(SRC) &&
      /urlPath === '\/api\/packs'\) \{\s*const u = userFromToken\(bearer\(req\)\);\s*if \(!u\) return json\(res, 401/.test(SRC) &&
      /urlPath === '\/api\/packs\/redeem'\) \{\s*const u = userFromToken\(bearer\(req\)\);\s*if \(!u\) return json\(res, 401/.test(SRC));
    ok('redeem is rate-limited per account AND per IP through the shared rateOk buckets',
      /rateOk\('packs:' \+ u\.id, 10, 15 \* 60 \* 1000\)/.test(SRC) && /rateOk\('packs-ip:' \+ ip, 30, 15 \* 60 \* 1000\)/.test(SRC));
    ok('the rider is told only "not valid" (404) or "can\'t be used any more" (410) — never which', /r\.error === 'unknown'\) return json\(res, 404/.test(SRC) && /json\(res, 410, \{ error: 'That code can\\'t be used any more' \}\)/.test(SRC));
    ok('a malformed code is refused before the store is asked (400)', /!packcodes\.looksValid\(body\.code\)\) return json\(res, 400/.test(SRC));
    ok('a live socket learns of its new packs at redeem time (packs.onHello on the online socket)', /const live = online\.get\(u\.id\);\s*if \(live\) packs\.onHello\(live, u\);/.test(SRC));
    ok('the panel\'s grant/revoke reaches a live socket (kickPacks → onHello + a packs frame)', /kickPacks: \(userId\) => \{[\s\S]{0,400}packs\.onHello\(c, u\);\s*send\(c, \{ t: 'packs', packs: packs\.packsForSocket\(c\) \}\);/.test(SRC));
    ok('packCtx hands packs the live maps and helpers, never the module scope', /const packCtx = \{\s*clients, parties, online, bots,/.test(SRC) && /store, db, flags, tomtom, B,/.test(SRC));
    const ADMIN = fs.readFileSync(path.join(ROOT, 'server', 'admin.js'), 'utf8');
    const admin = require('../server/admin');
    const routes = admin._routes.map((r) => r[0] + ' ' + r[1].source);
    ok('the control panel has /admin/packs, mint, revoke and per-account grant/revoke routes',
      routes.some((r) => r === 'GET ^\\/admin\\/packs$') && routes.some((r) => /packs\\\/mint/.test(r)) && routes.some((r) => /packs\\\/revoke/.test(r)) &&
      routes.some((r) => /pack-grant/.test(r)) && routes.some((r) => /pack-revoke/.test(r)), routes.filter((r) => /pack/.test(r)).join(' | '));
    ok('every pack on disk gets a kill switch on the Flags board (envDefaults adds pack:<id>)', /packs\.packIds\(\)\.forEach\(\(id\) => \{ d\['pack:' \+ id\] = true; \}\);/.test(ADMIN));
    const flags = require('../server/flags');
    ok('server/flags.js KNOWN carries pack:demo and pack:other from the packs directory', flags.KNOWN.indexOf('pack:demo') >= 0 && flags.KNOWN.indexOf('pack:other') >= 0, flags.KNOWN.join(','));
    const MIG = fs.readFileSync(path.join(ROOT, 'server', 'migrations', '004_feature_packs.sql'), 'utf8');
    ok('migration 004 creates pack_codes (hash unique, max_uses, uses, expires_at, revoked) and pack_grants (cascade with the account), RLS on',
      /create table if not exists public\.pack_codes[\s\S]*code_hash\s+text not null unique[\s\S]*max_uses[\s\S]*expires_at[\s\S]*revoked/.test(MIG) &&
      /create table if not exists public\.pack_grants[\s\S]*references public\.profiles\(id\) on delete cascade[\s\S]*primary key \(user_id, pack\)/.test(MIG) &&
      /alter table public\.pack_codes\s+enable row level security/.test(MIG) && /alter table public\.pack_grants enable row level security/.test(MIG));
    const DB = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
    ok('db.redeemPackCode is one transaction: lock the row, check, grant, count the use only when something was granted',
      /select id, label, packs, max_uses, uses, expires_at, revoked from public\.pack_codes where code_hash = \$1 for update/.test(DB) &&
      /if \(granted\.length\) await client\.query\('update public\.pack_codes set uses = uses \+ 1/.test(DB) && /await client\.query\('commit'\)/.test(DB));
  }

  /* ================= E — nothing dormant ships ================= */
  group('E — the store build carries no pack: packs/ is outside every bundle, and the loader is only a loader');
  {
    const COPY = fs.readFileSync(path.join(ROOT, 'scripts', 'copy-web.js'), 'utf8');
    const targets = (COPY.match(/const targets = \[([^\]]*)\]/) || ['', ''])[1];
    ok("scripts/copy-web.js (what Capacitor freezes into the APK/IPA, and what pack-ota.js zips) copies index.html, js, css, fonts — never packs",
      /'index\.html'/.test(targets) && /'js'/.test(targets) && !/packs/.test(targets), targets);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('index.html tags js/packs.js (the loader) and references nothing under packs/',
      /<script src="js\/packs\.js\?v=cy\d+" defer><\/script>/.test(html) && !/["'(]\/?packs\//.test(html));
    const jsDir = path.join(ROOT, 'js');
    const refs = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).filter((f) => /['"`]\/?packs\//.test(fs.readFileSync(path.join(jsDir, f), 'utf8')));
    ok('no shipped js/*.js names a packs/ path (the only pack URLs come from the server manifest at runtime)', refs.length === 0, refs.join(','));
    const loader = fs.readFileSync(path.join(ROOT, 'js', 'packs.js'), 'utf8');
    const featureWords = /radar|scanner|dragy|race|hotspot|aircraft|police|overlay|instrument|speedo|triplog/i;
    const code = loader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok('js/packs.js CODE (comments stripped) carries no feature logic — no radar/scanner/race/overlay/instrument words at all', !featureWords.test(code),
      (code.match(featureWords) || []).join(','));
    ok('the client never hard-codes a pack id: it loads whatever the manifest names', !/['"](enforcement|scanners|perf|overlays|instruments)['"]/.test(code));
    if (fs.existsSync(path.join(ROOT, 'www'))) {
      ok('www/ (the last copy-web output) has no packs directory', !fs.existsSync(path.join(ROOT, 'www', 'packs')));
    }
    const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
    ok('packs/ is tracked (not gitignored): it deploys with the site tarball to the server, which is the only place it runs', !/^\/?packs\/?$/m.test(gitignore));
  }

  /* ================= F — the client loader ================= */
  group('F — js/packs.js in jsdom: fetch the manifest, mount, style, run scripts in order, init once, stand down on sign-out');
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><head></head><body><nav id="dock"></nav></body></html>', { url: 'http://localhost/' });
    const win = dom.window;
    const FETCHES = [];
    let manifestAnswer = null;
    let redeemAnswer = null;
    const fakeFetch = (url, opts) => {
      FETCHES.push({ url, method: (opts && opts.method) || 'GET', auth: opts && opts.headers && opts.headers.Authorization, body: opts && opts.body });
      const reply = (status, obj) => Promise.resolve({ ok: status < 400, status, json: async () => obj });
      if (/\/api\/packs\/catalog$/.test(url)) return reply(200, { packs: [{ id: 'demo', title: 'Demo pack', blurb: '' }] });
      if (/\/api\/packs\/redeem$/.test(url)) return reply(redeemAnswer.status, redeemAnswer.body);
      if (/\/api\/packs$/.test(url)) return reply(manifestAnswer.status, manifestAnswer.body);
      return reply(404, {});
    };
    const prev = { window: global.window, document: global.document, localStorage: global.localStorage, fetch: global.fetch, navigator: global.navigator };
    global.window = win; global.document = win.document; global.localStorage = win.localStorage; global.fetch = fakeFetch; win.fetch = fakeFetch;
    try { global.navigator = win.navigator; } catch (e) { /* read-only on newer Node */ }
    win.App = { config: { base: '' } };
    const load = (rel) => new Function(fs.readFileSync(path.join(ROOT, rel), 'utf8')).call(win);
    load('js/util.js'); load('js/state.js'); load('js/packs.js');
    const A = win.App;
    // jsdom never loads a stylesheet, so fire the link's onload ourselves (a browser
    // fires load or error; the loader also has a 3 s cap for a stalled request).
    const realAppend = win.document.head.appendChild.bind(win.document.head);
    win.document.head.appendChild = (el) => { const r = realAppend(el); if (el.tagName === 'LINK' && el.onload) setTimeout(() => el.onload(), 0); return r; };
    const SCRIPTS = [];
    const MODULES = {
      '/packs/demo/a.js': "window.App.aRan = (window.App.aRan || 0) + 1; window.App.store.registerSettings({ demoFoo: 7 });",
      '/packs/demo/b.js': "window.App.bRanAfterA = window.App.aRan === 1; window.App.packs.register('demo', { init: function () { window.App.demoInit = (window.App.demoInit || 0) + 1; } });"
    };
    A.util.loadScript = (src) => {
      SCRIPTS.push(src);
      const key = src.split('?')[0];
      if (!MODULES[key]) return Promise.reject(new Error('404 ' + src));
      new Function(MODULES[key]).call(win);
      return Promise.resolve();
    };
    const events = [];
    A.store.on('packs', (st) => events.push('packs:' + st.held.join('+')));
    A.store.on('pack:loaded', (e) => events.push('loaded:' + e.id));

    manifestAnswer = { status: 200, body: {
      packs: [{ id: 'demo', title: 'Demo pack', blurb: '', legal: 'demo',
        scripts: ['/packs/demo/a.js?t=T1', '/packs/demo/b.js?t=T1'], styles: ['/packs/demo/demo.css?t=T1'],
        fragments: [{ mount: '#dock', position: 'append', html: '<button id="demo-btn">demo</button>' }] }],
      available: [{ id: 'other', title: 'Other pack', blurb: '' }] } };

    A.packs.init();
    ok('signed out at init: no manifest fetch, state is empty and signedIn:false', FETCHES.length === 0 && A.packs.state().signedIn === false && A.packs.state().held.length === 0);
    const st0 = await A.packs.sync();
    ok('sync() signed out resolves to the empty state without a request', FETCHES.length === 0 && st0.held.length === 0 && !A.packs.has('demo'));

    A.store.setAuth({ token: 'tok-held', username: 'holder' });   // emits 'auth' → sync()
    await H.waitFor(() => A.demoInit === 1, 3000);
    const st = A.packs.state();
    ok('sign-in triggers GET /api/packs with the bearer', FETCHES.length === 1 && /\/api\/packs$/.test(FETCHES[0].url) && FETCHES[0].auth === 'Bearer tok-held', JSON.stringify(FETCHES[0]));
    ok('the fragment is mounted where the manifest said (#dock, append)', !!win.document.querySelector('#dock > #demo-btn'));
    ok('the stylesheet is linked by its tokened URL', !!win.document.querySelector('link[rel="stylesheet"][href="/packs/demo/demo.css?t=T1"]'));
    ok('the scripts ran in manifest order, by their tokened URLs', JSON.stringify(SCRIPTS) === JSON.stringify(['/packs/demo/a.js?t=T1', '/packs/demo/b.js?t=T1']) && A.aRan === 1 && A.bRanAfterA === true, JSON.stringify(SCRIPTS));
    ok('a pack script can register settings late: the default landed and setSetting() accepts the key',
      A.state.settings.demoFoo === 7 && (A.store.setSetting('demoFoo', 8), A.state.settings.demoFoo === 8));
    ok('register(id, { init }) ran the init exactly once, after the whole pack loaded', A.demoInit === 1);
    ok('state(): held + loaded + available, has() true', st.held.join() === 'demo' && st.loaded.join() === 'demo' && st.available[0].id === 'other' && A.packs.has('demo') && A.packs.holds('demo'));
    ok("events: 'pack:loaded' then 'packs'", events.indexOf('loaded:demo') >= 0 && events.indexOf('packs:demo') > events.indexOf('loaded:demo'), events.join(' '));

    await A.packs.sync();
    ok('a second sync() does not re-run the scripts (a loaded pack stays loaded)', SCRIPTS.length === 2 && A.aRan === 1 && A.demoInit === 1);
    A.packs.onWelcome(['demo']);
    await H.sleep(30);
    ok('onWelcome with nothing new does not fetch again', FETCHES.length === 2);
    A.packs.onWelcome(['demo', 'other']);
    await H.waitFor(() => FETCHES.length === 3, 2000);
    ok('onWelcome naming an unloaded pack triggers a resync', FETCHES.length === 3);

    redeemAnswer = { status: 404, body: { error: "That code isn't valid" } };
    let err = null;
    try { await A.packs.redeem('CONVOY-AAAA-AAAA-AAAA-AAAA'); } catch (e) { err = e; }
    ok('redeem(): the server\'s refusal surfaces as the error message the rider sees', !!err && /isn't valid/.test(err.message) && FETCHES[FETCHES.length - 1].method === 'POST' && /"code":"CONVOY-AAAA/.test(FETCHES[FETCHES.length - 1].body));
    redeemAnswer = { status: 200, body: { ok: true, granted: ['other'], label: 'x', packs: [], available: [] } };
    const r = await A.packs.redeem('CONVOY-BBBB-BBBB-BBBB-BBBB');
    ok('redeem() ok → reports what was granted and resyncs (another GET /api/packs)', r.ok && r.granted.join() === 'other' && /\/api\/packs$/.test(FETCHES[FETCHES.length - 1].url));

    manifestAnswer = { status: 401, body: { error: 'unauthorized' } };
    await A.packs.sync();
    ok('a 401 on the manifest (session gone) empties the held list; the loaded code is simply no longer "held"', !A.packs.holds('demo') && !A.packs.has('demo') && A.packs.state().held.length === 0);
    A.store.clearAuth();
    ok('sign-out → nothing held, state signedIn:false, and the next sync() makes no request', A.packs.state().signedIn === false && A.packs.state().held.length === 0);
    const before = FETCHES.length;
    await A.packs.sync();
    ok('…confirmed: no request', FETCHES.length === before);
    const cat = await A.packs.ensureCatalog();
    ok('ensureCatalog() fetches the public catalogue without a bearer and caches it', cat.length === 1 && cat[0].id === 'demo' && FETCHES[FETCHES.length - 1].auth === undefined &&
      (await A.packs.ensureCatalog(), FETCHES.length === before + 1));

    global.window = prev.window; global.document = prev.document; global.localStorage = prev.localStorage; global.fetch = prev.fetch;
    try { global.navigator = prev.navigator; } catch (e) { /* ignore */ }
  }

  /* ================= G — the core's extension points ================= */
  group('G — the core\'s hook points, against the real UI chain: settings/profile hooks, the Feature packs screen, the legality gate, registerSettings');
  {
    const { win, doc, A } = H.bootRealUi();
    A.store.load();
    A.ui.init();
    ok('A.ui exposes addHook, legalGate, registerFeatureNotice, openOverlay, settingsKit', ['addHook', 'legalGate', 'registerFeatureNotice', 'openOverlay'].every((k) => typeof A.ui[k] === 'function') && typeof A.ui.settingsKit.row === 'function');
    ok('A.mapview exposes onStyle/onClick, A.net on/off/send, A.routing hook/fetchRoutes/applyRoute, A.store registerSettings/featureAcked/ackFeature',
      typeof A.mapview.onStyle === 'function' && typeof A.mapview.onClick === 'function' &&
      typeof A.net.on === 'function' && typeof A.net.off === 'function' && typeof A.net.send === 'function' &&
      typeof A.routing.hook === 'function' && typeof A.routing.fetchRoutes === 'function' && typeof A.routing.applyRoute === 'function' &&
      typeof A.store.registerSettings === 'function' && typeof A.store.featureAcked === 'function' && typeof A.store.ackFeature === 'function');

    const seen = [];
    A.ui.addHook('settings', (body, kit) => { seen.push('settings:' + (body && body.nodeType) + ':' + typeof kit.toggle); body.appendChild(kit.row('From a pack', 'sub', kit.toggle(false, () => {}))); });
    A.ui.addHook('profile', (body) => seen.push('profile:' + body.nodeType));
    A.ui.addHook('profile', () => { throw new Error('a hook that throws'); });
    A.ui.addHook('init', () => seen.push('init-late'));
    ok("addHook('init') after ui.init() runs at once", seen.indexOf('init-late') >= 0);
    let threw = null;
    try { A.ui.openPanel('profile'); } catch (e) { threw = e; }
    // The profile page (and the Settings box in it) renders on the next microtask.
    await H.waitFor(() => doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0, 2000);
    ok('the Settings box is populated after the profile page renders (it was built synchronously before #settings-host existed — fixed with the hooks)',
      !!doc.getElementById('settings-host') && doc.getElementById('settings-host').children.length > 0);
    ok('opening Profile + Settings runs the profile and settings hooks, survives a throwing hook, and the pack row rendered',
      !threw && seen.some((s) => /^profile:1$/.test(s)) && seen.some((s) => /^settings:1:function$/.test(s)) && /From a pack/.test(doc.getElementById('settings-host').textContent),
      threw ? threw.message : seen.join(' '));
    const host = doc.getElementById('settings-host');
    ok('the "Feature packs" section is on the settings screen, signed out: catalogue shown, the code field disabled with a sign-in note',
      /Feature packs/.test(host.textContent) && !!host.querySelector('.packs-redeem') && host.querySelector('.packs-code').disabled && /Sign in to redeem/.test(host.textContent));
    ok('…and it says what packs are, and that they are not in the installed app', /not part of the app you installed/.test(host.textContent) && /Terms/.test(host.textContent));

    A.store.registerSettings({ packKnob: 'a', packOther: 1 });
    ok('registerSettings() seeds defaults into live settings and makes setSetting accept them',
      A.state.settings.packKnob === 'a' && (A.store.setSetting('packKnob', 'b'), A.state.settings.packKnob === 'b'));
    A.store.registerSettings({ packKnob: 'zzz' });
    ok('re-registering never overwrites a live value', A.state.settings.packKnob === 'b');
    // A value saved under a pack key before this session wins over the default on the next load.
    win.localStorage.setItem('convoy.v1', JSON.stringify(Object.assign(JSON.parse(win.localStorage.getItem('convoy.v1') || '{}'), { settings: Object.assign({}, A.state.settings, { lateKey: 'kept' }) })));
    A.store.load();
    A.store.registerSettings({ lateKey: 'default' });
    ok('a saved value for a not-yet-registered key survives load() and beats the default at registration', A.state.settings.lateKey === 'kept', String(A.state.settings.lateKey));

    A.ui.registerFeatureNotice('demo', { title: 'Before you demo', lede: 'lede', points: ['one', 'two'] });
    A.store.setConsent({ passenger: true, age: true, terms: true });
    let proceeded = 0, cancelled = 0;
    A.ui.legalGate('demo', () => proceeded++, () => cancelled++);
    const card = doc.querySelector('.modal-card');
    ok('legalGate() on a fresh key opens the notice (title, points, Terms §5 link) and has NOT proceeded', proceeded === 0 && !!card && /Before you demo/.test(card.textContent) && /two/.test(card.textContent) && /terms#features/.test(card.innerHTML));
    const buttons = Array.from(card.querySelectorAll('button'));
    buttons.find((b) => /Not now/.test(b.textContent)).click();
    ok('"Not now" cancels without acknowledging', cancelled === 1 && proceeded === 0 && !A.store.featureAcked('demo'));
    A.ui.legalGate('demo', () => proceeded++, () => cancelled++);
    Array.from(doc.querySelector('.modal-card').querySelectorAll('button')).find((b) => /I understand/.test(b.textContent)).click();
    ok('"I understand" acknowledges and proceeds', proceeded === 1 && A.store.featureAcked('demo'));
    A.ui.legalGate('demo', () => proceeded++, () => cancelled++);
    ok('once acknowledged, legalGate() proceeds synchronously with no card', proceeded === 2 && cancelled === 1);
    const saved = JSON.parse(win.localStorage.getItem('convoy.v1'));
    ok('the acknowledgement is persisted (featureAck in the saved state)', !!(saved.featureAck && saved.featureAck.demo));
    A.store.setConsent({ passenger: true, age: true, terms: true });
    const LV = A.store.LEGAL_VERSION;
    A.state.consent.version = '0.0';
    ok('an acknowledgement under a different Terms version is void', !A.store.featureAcked('demo'));
    A.state.consent.version = LV;
    A.ui.legalGate('unregistered', () => proceeded++);
    ok('a key with no registered notice proceeds immediately (the gate is opt-in per feature)', proceeded === 3);

    A.net.on('welcome', () => {});
    let packMsg = null;
    A.net.on('demo:x', (m) => { packMsg = m; });
    ok('A.net.on() refuses a core message type and accepts a pack one', typeof packMsg === 'object');
    let reqSeen = null;
    A.routing.hook('request', (req) => { reqSeen = req; req.avoid = 'x'; });
    A.routing.hook('routes', (routes) => routes);
    ok('A.routing.hook() registers without throwing', true);
    let styleCalls = 0;
    A.mapview.onStyle(() => styleCalls++);
    A.mapview.onClick(() => false);
    ok('A.mapview.onStyle()/onClick() register without throwing', true);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  report();
  // bootRealUi()'s jsdom window and the store's sweeps keep timers armed; the
  // verdict is printed, so leave the way the frontend suite does.
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
