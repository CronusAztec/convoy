/* Convoy realtime server
   - Serves the static app (project root)
   - WebSocket realtime layer on /ws: riders, convoys, chat, waves, delayed global feed
   - Server-side bots keep the map alive at any user count

   Run:  node server.js          (or: PORT=5173 BOTS=12 node server.js)
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const B = require('./bots');
const store = require('./store');
const auth = require('./auth');
const tomtom = require('./tomtom');
const waze = require('./waze');
const hotspots = require('./hotspots');

const PORT = parseInt(process.env.PORT || '5173', 10);
// Fake/demo riders are OFF by default for the production build. Set BOTS=12 (or
// any N) to repopulate the map with simulated riders for demos/dev/testing.
const BOT_COUNT = parseInt(process.env.BOTS || '0', 10);
const NEARBY_KM = parseFloat(process.env.NEARBY_KM || '30');
const GLOBAL_DELAY_MS = parseInt(process.env.GLOBAL_DELAY_MS || '300000', 10); // ~5 min
const MAX_PARTY = 6;            // members per convoy, leader included (matches client MAX_MEMBERS)
const MAX_CLIENTS = parseInt(process.env.MAX_CLIENTS || '200', 10);
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || '10', 10); // per-IP socket ceiling
const RATE_WINDOW = 10 * 60 * 1000;
const TICK_MS = 1000;            // full sync/broadcast cadence (everyone in scope)
const FAST_MS = 350;            // fast-lane cadence for the closest riders
const NEAR_FAST = parseInt(process.env.NEAR_FAST || '6', 10); // riders refreshed at fast-lane rate

/* ================= neural TTS (Piper) ================= */
// Self-hosted neural text-to-speech. /api/tts streams a WAV synthesized by the
// Piper binary + a female voice model. Auto-detected under /opt/convoy/tts.
const TTS_DIR = process.env.TTS_DIR || path.join(__dirname, '..', 'tts');
const TTS_BIN = process.env.TTS_BIN || path.join(TTS_DIR, 'piper', 'piper');
const TTS_MODEL = process.env.TTS_MODEL || path.join(TTS_DIR, 'models', 'en_US-amy-medium.onnx');
const TTS_MAX_LEN = 280;
const TTS_MAX_CONCURRENT = 3;
let ttsInFlight = 0;
const ttsCache = new Map();      // text -> WAV Buffer (nav phrases repeat heavily)
const TTS_CACHE_MAX = 240;

function ttsReady() {
  try { return fs.existsSync(TTS_BIN) && fs.existsSync(TTS_MODEL); } catch (e) { return false; }
}

// Synthesize `text` to a WAV Buffer via Piper. Caches results. cb(err, buffer).
function ttsSynth(text, cb) {
  var cached = ttsCache.get(text);
  if (cached) return cb(null, cached);
  if (ttsInFlight >= TTS_MAX_CONCURRENT) return cb(new Error('busy'));
  ttsInFlight++;
  var args = ['--model', TTS_MODEL, '--output_file', '-'];
  var espeak = path.join(TTS_DIR, 'piper', 'espeak-ng-data');
  if (fs.existsSync(espeak)) args.push('--espeak_data', espeak);
  var done = false;
  var finish = function (err, buf) { if (done) return; done = true; ttsInFlight--; cb(err, buf); };
  var proc;
  try {
    proc = spawn(TTS_BIN, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { LD_LIBRARY_PATH: path.join(TTS_DIR, 'piper') })
    });
  } catch (e) { return finish(e); }
  var chunks = [];
  var killer = setTimeout(function () { try { proc.kill('SIGKILL'); } catch (e) {} finish(new Error('timeout')); }, 8000);
  proc.stdout.on('data', function (d) { chunks.push(d); });
  proc.on('error', function (e) { clearTimeout(killer); finish(e); });
  proc.on('close', function (code) {
    clearTimeout(killer);
    if (code !== 0 || !chunks.length) return finish(new Error('piper exit ' + code));
    var buf = Buffer.concat(chunks);
    if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(text, buf);
    finish(null, buf);
  });
  try { proc.stdin.write(text); proc.stdin.end(); } catch (e) { clearTimeout(killer); finish(e); }
}

/* ================= validation helpers ================= */
const str = (v, max, dflt) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : (dflt || ''));
const num = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const validPos = (p) => Array.isArray(p) && p.length === 2 &&
  typeof p[0] === 'number' && isFinite(p[0]) && p[0] >= -180 && p[0] <= 180 &&
  typeof p[1] === 'number' && isFinite(p[1]) && p[1] >= -85 && p[1] <= 85;

// Emojis only: no ASCII, no angle brackets, no combining chains long enough to hide a tag.
// Rider insignia key (0..7). Accepts a number or numeric string; legacy emoji
// strings (from old profiles) are coerced to a stable key by the client, so we
// just pass anything non-numeric through as-is.
function sanitizeEmoji(v) {
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 7) return n;
  // legacy: keep old emoji strings intact so existing accounts still resolve.
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 8);
  return 0;
}

const CAR_BODY_TYPES = ['Sedan', 'SUV', 'Coupe', 'Truck', 'Hatchback', 'Van', 'Convertible', 'Wagon'];
const CAR_TRANS = ['Automatic', 'Manual', 'CVT', 'Dual-Clutch'];
const CAR_DRIVE = ['FWD', 'RWD', 'AWD'];
const CAR_ENGINES = ['1.5L', '1.8L', '2.0L', '2.4L', '2.5L', '3.0L', '3.5L', '3.8L', '4.0L', '4.6L', '5.0L', '5.7L', '6.2L', 'Electric'];
const CAR_MODS = ['None', 'Tinted windows', 'Spoiler', 'Lowered', 'Exhaust', 'Aftermarket wheels', 'Widebody', 'Roof rack'];
const CAR_EXHAUST = ['Stock', 'Deep rumble', 'High-pitched', 'Turbo whistle', 'Straight pipe', 'Quiet'];
const carEnum = (v, arr, dflt) => (typeof v === 'string' && arr.indexOf(v) >= 0 ? v : dflt);

function sanitizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const car = p.car && typeof p.car === 'object' ? p.car : {};
  const paintOk = typeof car.paint === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(car.paint);
  return {
    name: str(p.name, 24, 'Rider'),
    handle: str(p.handle, 16, 'rider').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'rider',
    emoji: sanitizeEmoji(p.emoji),
    vibe: str(p.vibe, 24, 'Chill cruise'),
    car: {
      year: Math.round(num(car.year, 1900, 2030, 2020)),
      make: str(car.make, 24, 'Toyota'),
      model: str(car.model, 24, 'Supra'),
      paint: paintOk ? car.paint : '#4f8cff',
      paintName: str(car.paintName, 24, 'Custom'),
      finish: ['Gloss', 'Matte', 'Metallic', 'Satin'].indexOf(car.finish) >= 0 ? car.finish : 'Gloss',
      body: carEnum(car.body, CAR_BODY_TYPES, 'Sedan'),
      engine: carEnum(car.engine, CAR_ENGINES, '2.0L'),
      trans: carEnum(car.trans, CAR_TRANS, 'Automatic'),
      drive: carEnum(car.drive, CAR_DRIVE, 'FWD'),
      hp: Math.round(num(car.hp, 50, 2000, 200)),
      mods: carEnum(car.mods, CAR_MODS, 'None'),
      exhaust: carEnum(car.exhaust, CAR_EXHAUST, 'Stock')
    }
  };
}

/* ================= auth / account validation ================= */
function validUsername(u) {
  if (typeof u !== 'string') return 'Username required';
  u = u.trim();
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username must be 20 characters or fewer';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'Letters, numbers and underscores only';
  return null;
}
function validPassword(p) {
  if (typeof p !== 'string') return 'Password required';
  if (p.length < 6) return 'Password must be at least 6 characters';
  if (p.length > 200) return 'Password is too long';
  return null;
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  // Scheme is case-insensitive (RFC 7235); accept "Bearer" in any case.
  return /^bearer\s+/i.test(h) ? h.replace(/^\S+\s+/, '').trim() : null;
}
// Decode + verify a bearer token, then confirm its tokenVersion matches the
// user's current record. Returns the user or null. This is what makes tokens
// revocable: a password reset bumps tokenVersion, so old tokens stop validating.
function userFromToken(token) {
  const data = auth.verifyToken(token);
  if (!data || !data.uid) return null;
  const u = store.getById(data.uid);
  if (!u) return null;
  if ((u.tokenVersion || 0) !== (data.ver || 0)) return null; // token superseded
  return u;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, res, cb) {
  let data = '';
  let aborted = false;
  req.on('data', (c) => {
    data += c;
    if (data.length > 16384) { aborted = true; req.destroy(); }
  });
  req.on('end', () => {
    if (aborted) return cb(null);
    let body;
    try { body = JSON.parse(data || '{}'); } catch (e) { return cb(undefined); }
    // `cb` may be async (handleApi's handler is). Catch a rejection here as a
    // 500 rather than letting it escape as an unhandledRejection that would
    // crash the process under Node's default --unhandled-rejections=throw.
    let ret;
    try { ret = cb(body); } catch (e) {
      console.error('[api body sync]', e && e.message);
      try { json(res, 500, { error: 'Server error' }); } catch (e2) { /* response gone */ }
      return;
    }
    if (ret && typeof ret.catch === 'function') {
      ret.catch((e) => {
        console.error('[api body async]', e && e.message);
        try { json(res, 500, { error: 'Server error' }); } catch (e2) { /* response gone */ }
      });
    }
  });
  req.on('error', () => cb(null));
}

const authHits = new Map(); // ip -> [timestamps]
function rateOk(ip, max, windowMs) {
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter((t) => now - t < windowMs);
  authHits.set(ip, arr);
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}

// authHits keys (one per unique IP) are never deleted otherwise; prune the whole map
// periodically so an IP that tried once and left doesn't live forever in memory.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of authHits) {
    if (!arr.length || now - arr[arr.length - 1] > RATE_WINDOW) authHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

async function handleApi(req, res, urlPath) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && urlPath === '/api/me') {
    const u = userFromToken(bearer(req));
    if (!u) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { username: u.username, profile: u.profile });
  }

  // Anonymous capability probe: tells the client which optional data sources the
  // server has keys for, so it can opt in or fall back to keyless alternatives.
  // Cheap GET, no upstream call — safe to hit on every connect.
  if (req.method === 'GET' && urlPath === '/api/route/caps') {
    return json(res, 200, { routing: tomtom.hasKey(), waze: waze.hasKey(), hotspots: true });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  if ((urlPath === '/api/register' || urlPath === '/api/login' || urlPath === '/api/recover') &&
    !rateOk(ip, 14, RATE_WINDOW)) {
    return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
  }

  readBody(req, res, async (body) => {
    if (body === undefined) return json(res, 400, { error: 'Bad request' });
    if (body === null) return json(res, 413, { error: 'Request too large' });
    try {
      if (urlPath === '/api/register') {
        const ue = validUsername(body.username);
        if (ue) return json(res, 400, { error: ue });
        const pe = validPassword(body.password);
        if (pe) return json(res, 400, { error: pe });
        const profile = sanitizeProfile(body.profile);
        profile.handle = body.username.trim().toLowerCase();
        const r = await store.createUser(body.username.trim(), body.password, profile);
        if (r.error === 'taken') return json(res, 409, { error: 'That username is taken' });
        console.log('[register] ' + r.user.username + ' (' + store.count() + ' accounts)');
        return json(res, 200, { token: auth.mintToken(r.user.id, r.user.tokenVersion), username: r.user.username, profile, recoveryCode: r.recoveryCode });
      }
      if (urlPath === '/api/login') {
        const u = await store.verifyUser(String(body.username || ''), String(body.password || ''));
        if (!u) return json(res, 401, { error: 'Invalid username or password' });
        return json(res, 200, { token: auth.mintToken(u.id, u.tokenVersion), username: u.username, profile: u.profile });
      }
      if (urlPath === '/api/recover') {
        const u = await store.verifyRecovery(String(body.username || ''), String(body.code || ''));
        if (!u) return json(res, 401, { error: 'Wrong username or recovery code' });
        const pe = validPassword(body.password);
        if (pe) return json(res, 400, { error: pe });
        await store.setPassword(u.id, body.password);
        const newCode = await store.regenRecovery(u.id); // burn the used code, issue a fresh one
        console.log('[recover] ' + u.username + ' reset their password');
        return json(res, 200, { token: auth.mintToken(u.id, u.tokenVersion), username: u.username, profile: u.profile, recoveryCode: newCode });
      }
      if (urlPath === '/api/change-password') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        const ok = await store.verifyUser(u.username, String(body.oldPassword || ''));
        if (!ok) return json(res, 401, { error: 'Current password is incorrect' });
        const pe = validPassword(body.newPassword);
        if (pe) return json(res, 400, { error: pe });
        await store.setPassword(u.id, body.newPassword);
        // Issue a fresh token at the new version so the caller stays signed in.
        return json(res, 200, { ok: true, token: auth.mintToken(u.id, u.tokenVersion) });
      }
      if (urlPath === '/api/recovery') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        const ok = await store.verifyUser(u.username, String(body.password || ''));
        if (!ok) return json(res, 401, { error: 'Password is incorrect' });
        const code = await store.regenRecovery(u.id);
        return json(res, 200, { recoveryCode: code });
      }
      if (urlPath === '/api/profile') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        const profile = sanitizeProfile(body.profile);
        profile.handle = u.username.toLowerCase();
        store.updateProfile(u.id, profile);
        return json(res, 200, { ok: true, profile });
      }

      // Traffic-aware routing via TomTom (key is a server secret). Anonymous:
      // routing is core app functionality and routing isn't sensitive data, so
      // no token required — but it is rate-limited per IP to protect the quota.
      if (urlPath === '/api/route') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!rateOk(ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many route requests — slow down' });
        if (!tomtom.hasKey()) return json(res, 503, { error: 'Routing key not configured' });
        tomtom.route(body, (err, status, j) => {
          if (err) return json(res, 502, { error: 'Routing service unavailable' });
          return json(res, 200, j);
        });
        return;
      }

      // Live Waze alerts (police/accidents/hazards) via RapidAPI. Anonymous —
      // the bbox is public road data — but rate-limited per IP to protect the
      // RapidAPI quota. Returns normalized GeoJSON the client layers consume.
      // body: { bottomLeft:[lng,lat], topRight:[lng,lat] }
      if (urlPath === '/api/waze') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!rateOk(ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        if (!waze.hasKey()) return json(res, 503, { error: 'Waze key not configured' });
        const bl = body && body.bottomLeft, tr = body && body.topRight;
        if (!tomtom.isLngLat(bl) || !tomtom.isLngLat(tr)) return json(res, 400, { error: 'bad bbox' });
        waze.alerts(bl, tr, (err, status, fc) => {
          if (err) return json(res, 502, { error: 'Waze service unavailable' });
          // Feed live police sightings into the probability model — they become
          // the observations hotspot queries are scored from. Server time, since
          // the sighting is "now" from the rider's perspective. Non-police alerts
          // (hazards/accidents) are intentionally excluded from police hotspots.
          if (fc && fc.features) {
            const now = Date.now();
            for (let i = 0; i < fc.features.length; i++) {
              const f = fc.features[i];
              if (f.properties && f.properties.kind === 'police' && f.geometry && f.geometry.coordinates) {
                hotspots.record(f.geometry.coordinates[0], f.geometry.coordinates[1], now);
              }
            }
          }
          return json(res, 200, fc);
        });
        return;
      }

      // Police probability hotspots for a bbox + hour. Derived from accumulated
      // Waze + crowd police sightings (see server/hotspots.js). Anonymous, rate-
      // limited. body: { bottomLeft:[lng,lat], topRight:[lng,lat], hour?:0..23 }.
      // hour defaults to the current UTC hour server-side, but the client passes
      // its LOCAL hour (police patterns are local — "morning rush" = local morning).
      if (urlPath === '/api/hotspots') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!rateOk(ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        const bl = body && body.bottomLeft, tr = body && body.topRight;
        if (!tomtom.isLngLat(bl) || !tomtom.isLngLat(tr)) return json(res, 400, { error: 'bad bbox' });
        let hour = Number(body && body.hour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = new Date().getHours();
        return json(res, 200, hotspots.query(bl[0], bl[1], tr[0], tr[1], hour));
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[api ' + urlPath + ']', e.message);
      return json(res, 500, { error: 'Server error' });
    }
  });
}

/* ================= state ================= */
const clients = new Map(); // id -> human client
const bots = new Map();    // id -> bot
const parties = new Map(); // pid -> party
const partyByCode = new Map(); // join code -> party
const ipCount = new Map(); // ip -> open socket count (per-IP ceiling)

function genPartyCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 50; tries++) {
    let s = '';
    const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) s += A[b[i] % A.length];
    if (!partyByCode.has(s)) return s;
  }
  return 'CV' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

for (let i = 0; i < BOT_COUNT; i++) {
  const bot = B.makeBot(B.DEFAULT_ANCHOR);
  bots.set(bot.id, bot);
}

// Cached snapshot of human clients, recomputed on join/leave/anchor events.
// The 1 Hz tick reads this instead of reallocating per call (was O(H^2) per second).
let humanList = [];
function humans() { return humanList; }
function recomputeHumans() { humanList = [...clients.values()].filter((c) => c.profile); }

function assignAnchors() {
  const hs = humans();
  let i = 0;
  for (const bot of bots.values()) {
    bot.anchor = hs.length ? hs[i++ % hs.length] : null;
  }
}

function riderRecord(r) {
  if (r.bot) {
    return {
      id: r.id, name: r.name, handle: r.handle, emoji: r.emoji, vibe: r.vibe,
      car: r.car, pos: r.pos, heading: r.heading, mode: r.mode, account: null
    };
  }
  return {
    id: r.id, name: r.profile.name, handle: r.profile.handle, emoji: r.profile.emoji,
    vibe: r.profile.vibe, car: r.profile.car, pos: r.pos, heading: r.heading, mode: r.mode,
    account: r.username || null // username when this rider is signed in (enables "add friend")
  };
}

function getRider(id) { return bots.get(id) || clients.get(id) || null; }

/* ---------------- online accounts (userId -> client) ---------------- */
const online = new Map();
function clientByUserId(uid) { return online.get(uid) || null; }
function riderName(r) { return r.bot ? r.name : r.profile.name; }

function send(c, msg) {
  if (c.ws && c.ws.readyState === 1) {
    try { c.ws.send(JSON.stringify(msg)); } catch (e) { /* dropped */ }
  }
}
// Send an already-serialized payload (string or Buffer) to one client. Used by
// broadcast paths where the same object goes to everyone — serialize once, not
// once-per-client.
function sendRaw(c, str) {
  if (c.ws && c.ws.readyState === 1) {
    try { c.ws.send(str); } catch (e) { /* dropped */ }
  }
}

/* ================= scope (who sees whom) ================= */
// `pool` (optional) is a prebuilt array of all riders; the 1 Hz tick passes one
// shared list so we don't spread both Maps into a fresh array for every client.
function scopeFor(c, pool) {
  const out = new Set();
  if (!c.pos) return out;
  const radius = NEARBY_KM * 1000;
  // resolve the viewer's convoy member set once, so a ghosted convoy-mate
  // is still visible to their party.
  var viewerParty = null;
  if (c.party) viewerParty = parties.get(c.party);
  function sameParty(r) {
    return !!(viewerParty && r.party && r.party === c.party);
  }
  const riders = pool || [...clients.values(), ...bots.values()];
  for (const r of riders) {
    if (r.id === c.id || (!r.bot && !r.profile) || !r.pos) continue;
    // ghosted riders are hidden — unless they're in the viewer's convoy
    if (r.ghost && !sameParty(r)) continue;
    if (B.haversine(c.pos, r.pos) <= radius) out.add(r.id);
  }
  if (c.party) {
    if (viewerParty) for (const id of viewerParty.members) if (id !== c.id) out.add(id);
  }
  return out;
}

function syncScope(c, pool) {
  const want = scopeFor(c, pool);
  for (const id of want) {
    if (!c.known.has(id)) {
      c.known.add(id);
      send(c, { t: 'rider:add', rider: riderRecord(getRider(id)) });
    }
  }
  for (const id of [...c.known]) {
    if (!want.has(id)) {
      c.known.delete(id);
      send(c, { t: 'rider:remove', id });
    }
  }
}

function ensureKnown(c, id) {
  if (id !== c.id && !c.known.has(id)) {
    const r = getRider(id);
    if (r && r.pos) {
      c.known.add(id);
      send(c, { t: 'rider:add', rider: riderRecord(r) });
    }
  }
}

/* ================= parties ================= */
function liteOf(r) { return { id: r.id, name: riderName(r), emoji: r.bot ? r.emoji : r.profile.emoji }; }

function sendPartyState(party) {
  const lites = party.members.map((id) => liteOf(getRider(id))).filter(Boolean);
  for (const id of party.members) {
    const c = clients.get(id);
    if (!c) continue;
    for (const mid of party.members) ensureKnown(c, mid);
    send(c, {
      t: 'party',
      party: {
        id: party.id, name: party.name, emoji: party.emoji, leader: party.leader,
        mode: party.mode, code: party.code,
        members: lites, chat: party.chat.slice(-50)
      }
    });
  }
}

function partySys(party, text) {
  const m = { sys: true, text: str(text, 140), t: Date.now() };
  party.chat.push(m);
  if (party.chat.length > 100) party.chat.shift();
  for (const id of party.members) {
    const c = clients.get(id);
    if (c) send(c, { t: 'chat', sys: true, text: m.text, t2: m.t });
  }
}

function createParty(c, name, emoji) {
  if (c.party) leaveParty(c, true);
  const code = genPartyCode();
  const party = {
    id: 'p' + crypto.randomBytes(4).toString('hex'),
    name: str(name, 30, (c.profile.name || 'My') + "'s convoy"),
    emoji: sanitizeEmoji(emoji),
    leader: c.id,
    mode: 'invite',  // invite | code | locked
    code: code,
    members: [c.id],
    chat: []
  };
  parties.set(party.id, party);
  partyByCode.set(code, party);
  c.party = party.id;
  partySys(party, 'Convoy created — invite riders, or share the join code');
  sendPartyState(party);
  console.log(`[party] ${c.profile.name} created "${party.name}" (${code})`);
}

function joinParty(rider, party) {
  if (party.members.length >= MAX_PARTY) return false;
  if (rider.bot) {
    if (rider.party) return false;
    rider.party = party.id;
  } else {
    if (rider.party) leaveParty(rider, true);
    rider.party = party.id;
  }
  party.members.push(rider.id);
  partySys(party, riderName(rider) + ' joined the convoy');
  sendPartyState(party);
  return true;
}

function leaveParty(rider, silent) {
  const party = rider.party && parties.get(rider.party);
  rider.party = null;
  if (!party) return;
  const i = party.members.indexOf(rider.id);
  if (i >= 0) party.members.splice(i, 1);
  if (!rider.bot) send(rider, { t: 'party:left' });
  if (!silent) partySys(party, riderName(rider) + ' left the convoy');

  const humanMembers = party.members.filter((id) => clients.has(id));
  if (!humanMembers.length) {
    // bots can't run a convoy on their own — disband
    for (const id of party.members) {
      const bot = bots.get(id);
      if (bot) bot.party = null;
    }
    parties.delete(party.id);
    partyByCode.delete(party.code);
    return;
  }
  if (party.leader === rider.id) {
    party.leader = humanMembers[0];
    partySys(party, riderName(getRider(party.leader)) + ' now leads the convoy');
  }
  sendPartyState(party);
}

/* ================= friends ================= */
// A friend record marked online (the recipient is, by definition, looking at a live session)
function friendLiteOnline(u) { const l = store.friendLite(u); l.online = true; return l; }

function friendsPayload(u) {
  const friends = (u.friends || []).map((id) => {
    const f = store.getById(id);
    if (!f) return null;
    const lite = store.friendLite(f);
    lite.online = online.has(id);
    return lite;
  }).filter(Boolean);
  const requests = (u.reqIn || []).map((id) => {
    const f = store.getById(id);
    return f ? store.friendLite(f) : null;
  }).filter(Boolean);
  return { friends, requests };
}

function pushFriends(c) {
  if (!c.userId) return;
  const u = store.getById(c.userId);
  if (u) send(c, Object.assign({ t: 'friends' }, friendsPayload(u)));
}

// Notify a user's currently-online friends (e.g. that they came online/offline)
function notifyFriendsOf(u, msg) {
  for (const fid of (u.friends || [])) {
    const fc = online.get(fid);
    if (fc) send(fc, msg);
  }
}

/* ================= message handlers ================= */
const handlers = {
  hello(c, m) {
    let friendData = null;
    if (m.token) {
      const u = userFromToken(m.token);
      if (!u) { send(c, { t: 'auth:invalid' }); return; }
      c.userId = u.id;
      c.username = u.username;
      c.profile = u.profile;           // account profile is authoritative
      online.set(u.id, c);             // one session per account (last wins)
      friendData = friendsPayload(u);
      notifyFriendsOf(u, { t: 'friend:status', id: u.id, online: true });
    } else {
      c.profile = sanitizeProfile(m.profile); // guest
    }
    if (validPos(m.pos)) c.pos = m.pos;
    c.heading = num(m.heading, 0, 360, 0);
    recomputeHumans();
    assignAnchors();
    syncScope(c);
    send(c, {
      t: 'welcome',
      id: c.id,
      online: humans().length,
      account: c.userId ? { username: c.username, friends: friendData.friends, requests: friendData.requests } : null,
      riders: [...c.known].map((id) => riderRecord(getRider(id))),
      global: buildGlobalFC()
    });
    console.log(`[join] ${c.profile.name}${c.userId ? ' @' + c.username : ' (guest)'} — ${humans().length} online`);
  },

  pos(c, m) {
    const now = Date.now();
    if (now - c.lastPosAt < 250 || !validPos(m.pos)) return;
    c.lastPosAt = now;
    c.pos = m.pos;
    c.heading = num(m.heading, 0, 360, c.heading);
    c.mode = m.mode === 'parked' ? 'parked' : 'cruise';
  },

  profile(c, m) {
    c.profile = sanitizeProfile(m.profile);
    if (c.userId) {
      c.profile.handle = c.username.toLowerCase();
      store.updateProfile(c.userId, c.profile); // persist account edits
    }
    const upd = { t: 'rider:update', id: c.id, profile: c.profile };
    for (const other of clients.values()) {
      if (other.known && other.known.has(c.id)) send(other, upd);
    }
  },

  // Ghost Mode: the toggling rider goes invisible to non-convoy riders.
  ghost(c, m) {
    const wasGhost = c.ghost;
    c.ghost = !!m.on;
    if (wasGhost !== c.ghost) {
      // recompute scope so others drop/learn the rider on the next tick;
      // also immediately remove from anyone currently seeing them.
      for (const other of clients.values()) {
        if (other.id !== c.id && other.known && other.known.has(c.id)) {
          if (!scopeFor(other).has(c.id)) {
            other.known.delete(c.id);
            send(other, { t: 'rider:remove', id: c.id });
          }
        }
      }
    }
  },

  'party:create'(c, m) { createParty(c, m.name, m.emoji); },

  'party:invite'(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party) return send(c, { t: 'err', msg: 'Create a convoy first' });
    if (party.mode === 'locked') return send(c, { t: 'err', msg: 'Convoy is locked' });
    if (party.members.length >= MAX_PARTY) return send(c, { t: 'err', msg: 'Convoy is full' });
    const now = Date.now();
    c.inviteTimes = (c.inviteTimes || []).filter((t) => now - t < 60000);
    if (c.inviteTimes.length >= 10) return send(c, { t: 'err', msg: 'Too many invites — give it a minute' });
    c.inviteTimes.push(now);

    // m.to may be a rider/client id (nearby) or a friend's account id (any distance)
    const target = getRider(str(m.to, 40)) || clientByUserId(str(m.to, 40));
    if (!target || party.members.indexOf(target.id) >= 0) return;

    if (target.bot) {
      const pid = party.id, tid = target.id;
      setTimeout(() => {
        const p = parties.get(pid), bot = bots.get(tid);
        if (!p || !bot) return;
        if (!bot.party && B.chance(0.85) && joinParty(bot, p)) return;
        send(c, { t: 'invite:result', to: tid, name: bot.name, ok: false });
      }, B.randInt(1200, 2900));
    } else {
      send(target, {
        t: 'invite',
        from: liteOf(c),
        party: { id: party.id, name: party.name, emoji: party.emoji }
      });
    }
  },

  'party:accept'(c, m) {
    const party = parties.get(str(m.pid, 40));
    if (!party) return send(c, { t: 'err', msg: 'That convoy is gone' });
    if (!joinParty(c, party)) send(c, { t: 'err', msg: 'Convoy is full' });
  },

  'party:decline'(c, m) {
    const party = parties.get(str(m.pid, 40));
    if (!party) return;
    const leaderC = clients.get(party.leader);
    if (leaderC) send(leaderC, { t: 'invite:result', to: c.id, name: c.profile.name, ok: false });
  },

  'party:leave'(c) { leaveParty(c, false); },

  'party:kick'(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party || party.leader !== c.id) return;
    const target = getRider(str(m.id, 40));
    if (target && party.members.indexOf(target.id) >= 0 && target.id !== c.id) {
      leaveParty(target, false);
    }
  },

  'party:mode'(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party || party.leader !== c.id) return;
    const mode = ['invite', 'code', 'locked'].indexOf(m.mode) >= 0 ? m.mode : 'invite';
    if (party.mode === mode) return;
    party.mode = mode;
    const label = mode === 'invite' ? 'invite-only' : (mode === 'code' ? 'open with a join code' : 'locked');
    partySys(party, 'Convoy is now ' + label);
    sendPartyState(party);
  },

  'party:join'(c, m) {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const party = partyByCode.get(code);
    if (!party) return send(c, { t: 'err', msg: 'No convoy with that code' });
    if (party.members.indexOf(c.id) >= 0) return;
    if (party.mode === 'locked') return send(c, { t: 'err', msg: 'That convoy is locked' });
    if (party.members.length >= MAX_PARTY) return send(c, { t: 'err', msg: 'That convoy is full' });
    joinParty(c, party);
  },

  // A member posts a trip-style announcement ("Convoy arrived at …"). The text
  // still goes through partySys (sanitized + sys-styled), but unlike the old
  // {t:'chat', sys:true} path it can't be faked by a non-member — c must be in
  // the convoy. System styling is the server's to grant, not the client's.
  'party:sys'(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party) return;
    if (party.members.indexOf(c.id) < 0) return;
    const now = Date.now();
    c.chatTimes = (c.chatTimes || []).filter((t) => now - t < 5000);
    if (c.chatTimes.length >= 5) return send(c, { t: 'err', msg: 'Slow down — too many messages' });
    c.chatTimes.push(now);
    const text = str(m.text, 140);
    if (text) partySys(party, text);
  },

  /* ----- friends (account required) ----- */
  'friend:add'(c, m) {
    if (!c.userId) return send(c, { t: 'err', msg: 'Sign in to add friends' });
    const now = Date.now();
    c.friendReqTimes = (c.friendReqTimes || []).filter((t) => now - t < 60000);
    if (c.friendReqTimes.length >= 15) return send(c, { t: 'err', msg: 'Too many requests — give it a minute' });
    c.friendReqTimes.push(now);

    const r = store.sendFriendRequest(c.userId, str(m.username, 20));
    if (r.error) return send(c, { t: 'err', msg: r.error });
    const me = store.getById(c.userId);
    if (r.autoAccepted) {
      send(c, { t: 'friend:result', ok: true, msg: 'You and ' + r.target.username + ' are now friends' });
      const tc = online.get(r.target.id);
      if (tc) { send(tc, { t: 'friend:added', friend: friendLiteOnline(me) }); pushFriends(tc); }
      pushFriends(c);
    } else {
      send(c, { t: 'friend:result', ok: true, msg: 'Friend request sent to ' + r.target.username });
      const tc = online.get(r.target.id);
      if (tc) { send(tc, { t: 'friend:request', from: store.friendLite(me) }); pushFriends(tc); }
      pushFriends(c);
    }
  },

  'friend:accept'(c, m) {
    if (!c.userId) return;
    const me = store.getById(c.userId);
    const otherId = str(m.id, 40);
    if (!me || me.reqIn.indexOf(otherId) < 0) return;
    store.acceptFriend(c.userId, otherId);
    const other = store.getById(otherId);
    pushFriends(c);
    const oc = online.get(otherId);
    if (oc && other) { send(oc, { t: 'friend:added', friend: friendLiteOnline(me) }); pushFriends(oc); }
    if (other) send(c, { t: 'friend:result', ok: true, msg: 'You and ' + other.username + ' are now friends' });
  },

  'friend:decline'(c, m) {
    if (!c.userId) return;
    store.declineFriend(c.userId, str(m.id, 40));
    pushFriends(c);
  },

  'friend:remove'(c, m) {
    if (!c.userId) return;
    const otherId = str(m.id, 40);
    store.removeFriend(c.userId, otherId);
    pushFriends(c);
    const oc = online.get(otherId);
    if (oc) pushFriends(oc);
  },

  chat(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party) return;
    const now = Date.now();
    c.chatTimes = (c.chatTimes || []).filter((t) => now - t < 5000);
    if (c.chatTimes.length >= 5) return send(c, { t: 'err', msg: 'Slow down — too many messages' });
    c.chatTimes.push(now);

    const text = str(m.text, 140);
    if (!text) return;

    // System messages can only originate server-side (partySys). Clients sending
    // {t:'chat', sys:true} used to be able to forge convoy announcements — now
    // the flag is ignored entirely on the incoming path.
    const entry = { from: liteOf(c), text, t: now };
    party.chat.push(entry);
    if (party.chat.length > 100) party.chat.shift();
    for (const id of party.members) {
      const member = clients.get(id);
      if (member) send(member, { t: 'chat', from: entry.from, text, t2: now });
    }

    const botMembers = party.members.filter((id) => bots.has(id));
    if (botMembers.length && B.chance(0.75)) {
      const pid = party.id;
      setTimeout(() => {
        const p = parties.get(pid);
        if (!p) return;
        const stillBots = p.members.filter((id) => bots.has(id));
        if (!stillBots.length) return;
        const bot = bots.get(B.pick(stillBots));
        const reply = { from: liteOf(bot), text: B.pick(B.CHAT_REPLIES), t: Date.now() };
        p.chat.push(reply);
        for (const id of p.members) {
          const member = clients.get(id);
          if (member) send(member, { t: 'chat', from: reply.from, text: reply.text, t2: reply.t });
        }
      }, B.randInt(900, 3600));
    }
  },

  wave(c, m) {
    const target = getRider(str(m.to, 40));
    if (!target) return;
    if (target.bot) {
      const tid = target.id, cid = c.id;
      setTimeout(() => {
        const bot = bots.get(tid), me = clients.get(cid);
        if (bot && me && B.chance(0.9)) send(me, { t: 'wave', from: bot.name });
      }, B.randInt(900, 2200));
    } else {
      send(target, { t: 'wave', from: c.profile.name });
    }
  },

  // Walkie-talkie signaling: relay WebRTC SDP/ICE between convoy members (P2P path).
  'voice:signal'(c, m) {
    if (!c.party) return;
    const party = parties.get(c.party);
    if (!party) return;
    // Payload must be reasonably small (SDP + a few ICE candidates). Cap to avoid abuse.
    const payload = m.payload;
    if (payload == null || JSON.stringify(payload).length > 16384) return;
    for (const id of party.members) {
      if (id === c.id) continue;
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:signal', from: c.id, payload });
    }
  },

  // Audio relay fallback (when P2P fails): fan a chunk out to convoy members.
  'voice:relay'(c, m) {
    if (!c.party || !c.micActive) return;
    const party = parties.get(c.party);
    if (!party) return;
    const chunk = m.chunk;
    if (typeof chunk !== 'string' || chunk.length > 8192) return; // base64 PCM, capped
    const rate = num(m.rate, 0, 192000, 0); // effective sample rate the sender encoded at
    for (const id of party.members) {
      if (id === c.id) continue;
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:relay', from: c.id, chunk, rate });
    }
  },

  // Announce mic state so convoy UI can show who's speaking.
  'voice:mic'(c, m) {
    if (!c.party) return;
    const party = parties.get(c.party);
    if (!party) return;
    c.micActive = !!m.on;
    for (const id of party.members) {
      if (id === c.id) continue;
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:mic', from: c.id, on: c.micActive, name: c.profile.name });
    }
  },

  // Crowd hazard report (e.g. a live police sighting). The live pin is ephemeral
  // (clients hold it for the session and cap their own array), BUT police reports
  // are also recorded into the probability model so recurring spots become hotspots.
  // Coords are validated, the label sanitized, and the broadcast is SCOPED: only
  // riders within NEARBY_KM of the report receive it (a police spot on the other
  // side of the world is noise). The reporter's lite is attached so a client can
  // drop its own echo (it already drew the pin locally at report time).
  'crowd:report'(c, m) {
    const pos = [m.lng, m.lat];
    if (!validPos(pos)) return;
    // Per-IP throttle so one source can't flood the area. Reuses the auth/window
    // rate limiter; a 60s budget is generous for genuine reporting cadence.
    if (!rateOk(c.ip, 20, 60 * 1000)) return send(c, { t: 'err', msg: 'Too many reports — slow down' });
    const kind = str(m.kind, 24, 'hazard');
    const label = str(m.label, 48, '');
    // A rider-reported police sighting feeds the probability model just like a
    // Waze sighting would. Timestamped server-side ("now" from the rider's view).
    if (kind === 'police') hotspots.record(m.lng, m.lat, Date.now());
    const payload = { t: 'crowd:report', from: liteOf(c), lat: m.lat, lng: m.lng, kind, label };
    const radius = NEARBY_KM * 1000;
    for (const other of clients.values()) {
      if (!other.pos || other.id === c.id) continue;
      if (B.haversine(pos, other.pos) <= radius) send(other, payload);
    }
  }
};

/* ================= simulation ticks ================= */
function rowOf(r) {
  return [r.id, +r.pos[0].toFixed(5), +r.pos[1].toFixed(5), Math.round(r.heading || 0), r.mode === 'parked' ? 1 : 0];
}
function botLeaderInfo(bot) {
  if (!bot.party) return null;
  const party = parties.get(bot.party);
  const leader = party && clients.get(party.leader);
  if (party && leader && leader.pos) {
    return { pos: leader.pos, heading: leader.heading || 0, slot: Math.max(0, party.members.indexOf(bot.id) - 1) };
  }
  if (!party) bot.party = null;
  return null;
}

// Full sync + broadcast at 1 Hz: every rider each client can currently see.
setInterval(() => {
  // One combined rider list for the whole tick, reused across every client so
  // scopeFor doesn't reallocate+spread both Maps per viewer per second.
  const pool = [...clients.values(), ...bots.values()];
  for (const c of humans()) {
    if (!c.pos) continue;
    syncScope(c, pool);
    if (!c.known.size) continue;
    const rows = [];
    for (const id of c.known) {
      const r = getRider(id);
      if (r && r.pos) rows.push(rowOf(r));
    }
    send(c, { t: 'tick', r: rows });
  }
}, TICK_MS);

// Fast lane: step bots and refresh each client's NEAREST riders several times a second, so the
// cars closest to the driver update far more often than distant ones (prioritized freshness).
let lastFast = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastFast) / 1000, 1);
  lastFast = now;

  for (const bot of bots.values()) B.stepBot(bot, dt, botLeaderInfo(bot));

  for (const c of humans()) {
    if (!c.pos || !c.known.size) continue;
    const near = [...c.known]
      .map((id) => getRider(id))
      .filter((r) => r && r.pos)
      .map((r) => ({ r, d: B.haversine(c.pos, r.pos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAR_FAST)
      .map((x) => rowOf(x.r));
    if (near.length) send(c, { t: 'tick', r: near });
  }
}, FAST_MS);

/* ================= global feed (delayed) ================= */
// Decorative ambient world dots (fake "always-on" global drivers) are OFF by
// default in the production build so the global feed reflects only REAL riders.
// Set AMBIENT=1 to repopulate them for demos/dev (independent of BOTS).
const AMBIENT = parseInt(process.env.AMBIENT || '0', 10);
const ambient = AMBIENT ? B.makeAmbientGlobal() : [];
const snapshots = []; // ring buffer of {t, items}

setInterval(() => {
  const dt = 60;
  if (ambient.length) for (const a of ambient) B.stepAmbient(a, dt);

  const items = [];
  for (const r of [...clients.values(), ...bots.values()]) {
    if ((!r.bot && !r.profile) || !r.pos) continue;
    const rec = riderRecord(r);
    items.push({
      name: rec.name + ' ' + (rec.handle ? rec.handle[0].toUpperCase() + '.' : ''),
      emoji: rec.emoji,
      car: rec.car.year + ' ' + rec.car.make + ' ' + rec.car.model,
      city: B.nearestCity(r.pos),
      pos: r.pos.slice(),
      online: true
    });
  }
  snapshots.push({ t: Date.now(), items });
  if (snapshots.length > 12) snapshots.shift();
}, 60000);

function buildGlobalFC() {
  const features = [];
  if (ambient.length) for (const a of ambient) {
    if (!a.online) continue; // offline ambient drivers don't appear
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: a.pos.slice() },
      properties: {
        name: a.name, emoji: a.emoji, car: a.car, city: a.city,
        seenMin: B.randInt(3, 9), online: true
      }
    });
  }
  // the real (delayed) layer: oldest snapshot at least GLOBAL_DELAY_MS old, else the oldest we have
  let snap = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (Date.now() - snapshots[i].t >= GLOBAL_DELAY_MS) { snap = snapshots[i]; break; }
  }
  if (!snap && snapshots.length) snap = snapshots[0];
  if (snap) {
    const seenMin = Math.max(1, Math.round((Date.now() - snap.t) / 60000));
    for (const it of snap.items) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: B.destPoint(it.pos, B.rand(0, 360), B.rand(100, 400)) },
        properties: {
          name: it.name, emoji: it.emoji, car: it.car, city: it.city,
          seenMin, online: !!it.online
        }
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

setInterval(() => {
  // The global feed payload is identical for every client, so serialize once
  // and send the raw string — was JSON.stringify'd per client every 45s.
  const raw = JSON.stringify({ t: 'global', fc: buildGlobalFC() });
  for (const c of humans()) sendRaw(c, raw);
}, 45000);

/* ================= static file server ================= */
const ROOT = path.resolve(__dirname, '..');
// Explicit allowlist of top-level paths that may be served. Anything else 404s.
// (Formerly a denylist, which silently served any new file added at the repo root —
// a path-traversal-class bug waiting for the next config/backup file to land here.)
const ALLOWED_TOP = ['/', '/index.html', '/js', '/css', '/convoy.apk'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
  '.apk': 'application/vnd.android.package-archive'  // downloadable Android build (/convoy.apk)
};

// Per-IP rate limit + concurrency cap for the CPU-bound /api/tts route (spawns piper).
const TTS_RATE_MAX = 30;     // requests per window
const TTS_RATE_WINDOW = 60 * 1000;
const ttsInflightByIp = new Map(); // ip -> count of in-flight synth calls

function ttsRateOk(ip) {
  if (!rateOk(ip, TTS_RATE_MAX, TTS_RATE_WINDOW)) return false;
  const n = ttsInflightByIp.get(ip) || 0;
  if (n >= 2) return false; // max 2 concurrent synth per source
  ttsInflightByIp.set(ip, n + 1);
  return true;
}
function ttsRelease(ip) {
  const n = (ttsInflightByIp.get(ip) || 1) - 1;
  if (n <= 0) ttsInflightByIp.delete(ip); else ttsInflightByIp.set(ip, n);
}

const httpServer = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end(); return; }

  // Neural TTS (binary audio, so handled before the JSON /api router).
  if (urlPath === '/api/tts/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: ttsReady() }));
    return;
  }
  if (urlPath === '/api/tts') {
    if (!ttsReady()) { res.writeHead(503); res.end('tts unavailable'); return; }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!ttsRateOk(ip)) { res.writeHead(429); res.end('tts rate limited'); return; }
    var text = '';
    try { text = (new URLSearchParams(req.url.split('?')[1] || '').get('text') || '').slice(0, TTS_MAX_LEN).trim(); }
    catch (e) { text = ''; }
    if (!text) { ttsRelease(ip); res.writeHead(400); res.end('no text'); return; }
    ttsSynth(text, function (err, buf) {
      ttsRelease(ip);
      if (err || !buf) { res.writeHead(503); res.end('synth failed'); return; }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }

  // TomTom flow tiles (binary PNG). Served before the JSON /api router so the
  // bytes don't get JSON-wrapped. Path: /api/traffic/<z>/<x>/<y>.png
  // NOTE: tile x/y coordinates exceed 999 at zoom ≥ 10 (z13 has coords like
  // 1410/3273), so the coord groups allow up to 6 digits — the old \d{1,3} cap
  // 404'd every useful-zoom tile and left the traffic layer blank/blobby.
  const traffic = urlPath.match(/^\/api\/traffic\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
  if (traffic) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    // Flow tiles are fetched per visible tile, so the budget is generous per window;
    // the cap is mainly to stop an abusive client from burning the TomTom quota.
    if (!tomtom.hasKey()) { res.writeHead(503); res.end('traffic unavailable'); return; }
    if (!rateOk(ip, 300, 60 * 1000)) { res.writeHead(429); res.end('rate limited'); return; }
    tomtom.tile(traffic[1], traffic[2], traffic[3], (err, status, headers, buf) => {
      if (err || !buf || status !== 200) { res.writeHead(502); res.end('upstream'); return; }
      res.writeHead(200, {
        'Content-Type': headers['Content-Type'] || 'image/png',
        // 90s — matches the client's TRAFFIC_REFRESH_MS so a cache-busted tile URL
        // actually reaches TomTom fresh on the next refresh, instead of being served
        // from an intermediate/browser cache that would mask live flow changes.
        'Cache-Control': 'public, max-age=90'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }

  if (urlPath.indexOf('/api/') === 0) {
    handleApi(req, res, urlPath).catch((e) => { try { json(res, 500, { error: 'Server error' }); } catch (e2) {} });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // Resolve first so traversal (e.g. /js/../server/x) is normalized away, THEN
  // check the allowlist against the resolved top-level segment. Checking the
  // raw path before resolving let /js/../server/... slip through into /server.
  const file = path.resolve(ROOT, '.' + urlPath);
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
  const top = '/' + rel.split(path.sep)[0];
  if (!ALLOWED_TOP.includes(urlPath) && !ALLOWED_TOP.includes('/' + rel) && !ALLOWED_TOP.includes(top)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

/* ================= websocket wiring ================= */
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 8192 });

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    try { ws.send(JSON.stringify({ t: 'err', msg: 'Server is full' })); } catch (e) { }
    ws.close();
    return;
  }
  const c = {
    id: 'u' + crypto.randomBytes(5).toString('hex'),
    ws,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    userId: null,
    username: null,
    profile: null,
    pos: null,
    heading: 0,
    mode: 'cruise',
    party: null,
    known: new Set(),
    lastPosAt: 0,
    chatTimes: [],
    inviteTimes: [],
    micActive: false,
    ghost: false,
    isAlive: true
  };
  // Per-IP ceiling: a single source can't exhaust MAX_CLIENTS on its own.
  const cur = ipCount.get(c.ip) || 0;
  if (cur >= MAX_PER_IP) {
    try { ws.send(JSON.stringify({ t: 'err', msg: 'Too many connections from your network' })); } catch (e) { }
    ws.close();
    return;
  }
  ipCount.set(c.ip, cur + 1);
  clients.set(c.id, c);

  ws.on('pong', () => { c.isAlive = true; });
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'hello' && !c.profile) return; // must say hello first
    const h = handlers[m.t];
    if (h) {
      try { h(c, m); } catch (e) { console.error('[handler ' + m.t + ']', e.message); }
    }
  });
  ws.on('close', () => {
    if (c.party) leaveParty(c, false);
    clients.delete(c.id);
    const left = (ipCount.get(c.ip) || 1) - 1;
    if (left <= 0) ipCount.delete(c.ip); else ipCount.set(c.ip, left);
    if (c.userId && online.get(c.userId) === c) {
      online.delete(c.userId);
      const u = store.getById(c.userId);
      if (u) notifyFriendsOf(u, { t: 'friend:status', id: c.userId, online: false });
    }
    recomputeHumans();
    if (c.profile) console.log(`[leave] ${c.profile.name} — ${humans().length} online`);
    assignAnchors();
  });
  ws.on('error', () => { /* close handles cleanup */ });
});

setInterval(() => {
  for (const c of clients.values()) {
    if (!c.isAlive) { c.ws.terminate(); continue; }
    c.isAlive = false;
    try { c.ws.ping(); } catch (e) { }
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`Convoy server → http://localhost:${PORT}  (ws: /ws, bots: ${BOT_COUNT}, nearby: ${NEARBY_KM}km)`);
});

/* ================= process-level safety nets =================
   Log and survive stray rejections/exceptions instead of crashing the realtime
   server (Node's default terminates on unhandled rejections). Real bugs still
   show in the logs; this just stops a single bad request from taking everyone
   offline. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err.message || err));
});

/* ================= graceful shutdown =================
   On SIGTERM/SIGINT (e.g. `systemctl restart`), stop accepting connections,
   drain in-flight sockets, and flush the user store — instead of hard-resetting
   every client and risking losing the last few hundred ms of writes. */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${sig} received — draining…`);
  try { wss.close(); } catch (e) {}            // no new ws; existing sockets get 1001
  httpServer.close(() => {
    try { store.flush(); } catch (e) {}
    try { hotspots.flush(); } catch (e) {}   // persist accumulated observations
    console.log('[shutdown] done.');
    process.exit(0);
  });
  // Safety net: if something hangs the drain, force-exit after 5s.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
