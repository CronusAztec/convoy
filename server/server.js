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

// Lightweight .env loader (no dependency): fills process.env from server/.env so
// secrets like TOMTOM_KEY stay OUT of tracked files (.env is gitignored). MUST run
// before the local requires below — tomtom.js / waze.js capture their keys from
// process.env at require time. Vars already set WIN (production uses systemd
// Environment=, which must override the file); a missing .env is a silent no-op.
(function loadDotenv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) return;                                       // skip blanks/comments
      const k = m[1], v = m[2].replace(/^["']|["']$/g, ''); // strip optional quotes
      if (process.env[k] === undefined) process.env[k] = v;
    });
  } catch (e) { /* dev convenience only — ignore */ }
})();

const B = require('./bots');
const store = require('./store');
const sb = require('./supabase');
const mail = require('./mailer');
const oauth = require('./oauth');
const overpass = require('./overpass');
const tomtom = require('./tomtom');
const waze = require('./waze');
const hotspots = require('./hotspots');
const agent = require('./agent');

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
  // No ASCII angle brackets though — the comment above promises "no angle
  // brackets", so a crafted 8-char string can't lean on a missed client sink.
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 8).replace(/[<>]/g, '');
  return 0;
}

const CAR_BODY_TYPES = ['Sedan', 'SUV', 'Coupe', 'Truck', 'Hatchback', 'Van', 'Convertible', 'Wagon', 'Motorcycle'];
const CAR_TRANS = ['Automatic', 'Manual', 'CVT', 'Dual-Clutch'];
const CAR_DRIVE = ['FWD', 'RWD', 'AWD'];
const CAR_EXHAUST = ['Stock', 'Deep rumble', 'High-pitched', 'Turbo whistle', 'Straight pipe', 'Quiet'];
const carEnum = (v, arr, dflt) => (typeof v === 'string' && arr.indexOf(v) >= 0 ? v : dflt);

// Profile photo: a small client-produced data URL. Strict shape check (jpeg/webp/png
// base64 only — the alphabet can't break out of an attribute) + a hard size cap so
// one rider can't bloat every welcome/rider:add frame. The NSFW screen runs client-
// side before upload; this only enforces shape/size.
const AVATAR_MAX_CHARS = 24000;
function sanitizeAvatar(v) {
  if (typeof v !== 'string' || v.length > AVATAR_MAX_CHARS) return '';
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
}

function sanitizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const car = p.car && typeof p.car === 'object' ? p.car : {};
  const paintOk = typeof car.paint === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(car.paint);
  return {
    name: str(p.name, 24, 'Rider'),
    handle: str(p.handle, 16, 'rider').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'rider',
    emoji: sanitizeEmoji(p.emoji),
    avatar: sanitizeAvatar(p.avatar),
    vibe: str(p.vibe, 24, 'Chill cruise'),
    car: {
      year: Math.round(num(car.year, 1900, 2030, 2020)),
      make: str(car.make, 24, 'Toyota'),
      model: str(car.model, 24, 'Supra'),
      trim: str(car.trim, 32, ''),
      paint: paintOk ? car.paint : '#4f8cff',
      paintName: str(car.paintName, 24, 'Custom'),
      finish: ['Gloss', 'Matte', 'Metallic', 'Satin'].indexOf(car.finish) >= 0 ? car.finish : 'Gloss',
      body: carEnum(car.body, CAR_BODY_TYPES, 'Sedan'),
      // engine + mods are free text now (the garage supports custom entries) —
      // length-capped here, HTML-escaped by every client that renders them.
      engine: str(car.engine, 24, '2.0L'),
      trans: carEnum(car.trans, CAR_TRANS, 'Automatic'),
      drive: carEnum(car.drive, CAR_DRIVE, 'FWD'),
      hp: Math.round(num(car.hp, 50, 2000, 200)),
      mods: str(car.mods, 40, 'None'),
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
  // GoTrue hashes with bcrypt, which ignores everything past 72 BYTES — two
  // passwords sharing a 72-byte prefix are literally the same password to it.
  // Accepting a longer one would sell strength the hash never sees. Bytes, not
  // characters: one emoji is four of them.
  if (Buffer.byteLength(p, 'utf8') > 72) {
    return 'Password is too long (max 72 bytes — note accents and emoji count as several)';
  }
  return null;
}
// Deliberately loose. The only thing this has to catch is a typo shaped like
// "not an address at all" — whether the mailbox exists is decided by the
// verification link, not by a regex, and every regex strict enough to feel
// clever rejects addresses that genuinely work. 254 is the RFC 5321 maximum.
function validEmail(e) {
  if (typeof e !== 'string') return 'Email required';
  e = e.trim();
  if (!e) return 'Email required';
  if (e.length > 254) return 'That email address is too long';
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) return 'That doesn\'t look like an email address';
  // The synthetic domain backs the username-only accounts. Letting someone
  // register "someone@users.convoy.local" would let them claim an address the
  // system mints for other people.
  if (e.toLowerCase().endsWith('@' + sb.syntheticDomain.toLowerCase())) {
    return 'That email domain isn\'t allowed';
  }
  return null;
}
/* ---------------- client IP (trusted-proxy aware) ----------------
   X-Forwarded-For is a CLIENT-CONTROLLED header unless the request actually
   arrived from a proxy we run. Reading it unconditionally meant anyone could
   send a fresh random value per request and get a fresh bucket for EVERY per-IP
   limit in this file — auth (14/10min), route/waze/hotspots/incidents (30/min),
   tiles (300/min), tts, crowd:report — plus a fresh slot against the MAX_PER_IP
   websocket ceiling. Effectively: no rate limiting at all, and unlimited
   password guessing.

   TRUST_PROXY is a comma list of peer addresses whose XFF we honour
   ('loopback' covers 127.0.0.1 / ::1). The shipped deployment puts Caddy on
   loopback in front of this server, so that is the default; set TRUST_PROXY=''
   when the server is exposed directly. When trusted we take the LAST hop —
   the one our own proxy appended — not the first, which the client can forge. */
const TRUST_PROXY = (process.env.TRUST_PROXY === undefined ? 'loopback' : process.env.TRUST_PROXY)
  .split(',').map((s) => s.trim()).filter(Boolean);
const bareIp = (a) => String(a || '').replace(/^::ffff:/, '');
function isTrustedProxy(addr) {
  if (!TRUST_PROXY.length) return false;
  const a = bareIp(addr);
  if (!a) return false;
  return TRUST_PROXY.some((t) => t === a || (t === 'loopback' && (a === '127.0.0.1' || a === '::1')));
}
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (isTrustedProxy(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return bareIp(hops[hops.length - 1]);
    }
  }
  return bareIp(peer);
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  // Scheme is case-insensitive (RFC 7235); accept "Bearer" in any case.
  return /^bearer\s+/i.test(h) ? h.replace(/^\S+\s+/, '').trim() : null;
}
// Verify a Supabase access token and resolve it to the local account record.
// The JWT is checked against the project's cached JWKS (see supabase.js), so
// this stays synchronous and the realtime handlers can keep calling it inline.
// `sub` is the auth.users uuid, which is also the profiles primary key.
//
// NOTE ON REVOCATION: a Supabase access token stays cryptographically valid
// until it expires, even after a global sign-out — revoking a session only stops
// the refresh token from minting new ones. Convoy therefore has a window of at
// most one access-token lifetime (the project's JWT expiry, 1h by default) where
// an already-issued token still works after a password change. Shorten the JWT
// expiry in the dashboard if that window matters more than the refresh traffic.
function userFromToken(token) {
  const claims = sb.verify(token);
  if (!claims || !claims.sub) return null;
  return store.getById(claims.sub) || null;
}

/* Claims from a token, but only for a subject that still exists.

   Everywhere the server accepts a verified token WITHOUT a profile behind it, it
   is reading that as "provider sign-in that hasn't finished yet" and offering to
   create the account. A just-deleted rider's access token has exactly that shape
   and stays valid for up to an hour after the account is gone (stateless JWT —
   see store.tombstone), so it would be handed the account-setup path.

   Anything that acts on bare claims must come through here instead of calling
   sb.verify directly. */
function liveClaims(token) {
  const claims = sb.verify(token);
  if (!claims || !claims.sub) return null;
  if (store.isDeleted(claims.sub)) return null;
  return claims;
}

// Pre-fill the "pick a username" step after a provider sign-in. Everything here
// is a SUGGESTION the rider can overwrite — it is never trusted as an identity,
// and the username they end up with goes through validUsername() and the same
// uniqueness check as any other. Google's name/avatar arrive in user_metadata,
// which is user-editable in GoTrue, so it must not be used for anything but this.
function suggestFromClaims(claims) {
  const meta = (claims && claims.user_metadata) || {};
  const name = String(meta.full_name || meta.name || meta.preferred_username || '').trim();
  const email = String(claims.email || '');
  // Fall back to the local part of the address, then to nothing at all.
  const seed = (meta.preferred_username || name || email.split('@')[0] || '');
  const username = String(seed).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  return {
    // Empty rather than a too-short stub: the field is better left blank than
    // pre-filled with something validUsername() will reject.
    username: username.length >= 3 ? username : '',
    name: name.slice(0, 40)
  };
}

// Mail the rider a confirm-your-address link. Shared by registration (fired
// automatically) and the "resend" button. Returns { ok } | { error }.
async function sendVerifyEmail(user, address) {
  const token = await store.issueEmailToken(user.id, 'verify', address);
  const link = mail.appUrl() + '/l/verify?token=' + encodeURIComponent(token);
  return mail.send(mail.verifyEmail(address, user.username, link));
}

// Shape the client-facing session payload. The client stores the refresh token
// and calls /api/refresh before `expiresAt`.
function sessionPayload(session, user) {
  return {
    token: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: Date.now() + (Number(session.expires_in) || 3600) * 1000,
    username: user.username,
    profile: user.profile,
    // The client needs all three to decide what the account screen offers: an
    // unverified address gets a "confirm it" prompt, no address at all gets an
    // "add one" prompt, and only a verified one unlocks reset-by-email.
    email: user.email || null,
    emailVerified: !!user.emailVerified,
    provider: user.provider || 'password'
  };
}
// Answer the two store/GoTrue failures that must NOT fall through to a generic
// 401/502, and report whether it did so:
//   rate-limited  — GoTrue's own per-IP limit, not a wrong password. Answering
//     "invalid password" sends riders into the recovery flow, which SPENDS their
//     one-shot code, over something that clears by itself in a minute.
//   weak-password — GoTrue rejected the password itself (leaked-password
//     protection, or a dashboard minimum above ours). That is a 400 the rider
//     can act on, not a 502 they can only retry forever.
function authFail(res, r) {
  if (!r || !r.error) return false;
  if (r.error === 'rate-limited') {
    json(res, 429, { error: 'Too many attempts right now — wait a minute and try again' });
    return true;
  }
  if (r.error === 'weak-password') {
    json(res, 400, { error: r.detail || 'Please choose a stronger password' });
    return true;
  }
  return false;
}

// CORS — the native Android app runs at https://localhost and calls this API
// cross-origin (https://odoreeci.tech/api/*). Without these, every /api fetch from
// the app is blocked by the WebView (the JSON POSTs even get a preflight first),
// which silently disabled traffic, hotspots and Waze on Android. The API is
// anonymous + token-in-header (no cookies), so '*' is safe — no credentials mode.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS_HEADERS));
  res.end(body);
}
function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;             // real BYTES, not UTF-16 code units
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    // 48KB: /api/profile now carries a base64 profile photo (≤24KB) plus the
    // rest of the profile; everything else stays far below this.
    if (size > 49152) {
      // Answer NOW. This used to just set a flag and destroy the request, then
      // wait for 'end' to send the 413 — but a destroyed request emits 'close',
      // not 'end', so the callback never fired and the client hung until its own
      // timeout with no response at all.
      aborted = true;
      try { json(res, 413, { error: 'Request too large' }); } catch (e) { /* gone */ }
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const data = Buffer.concat(chunks).toString('utf8');
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
  // Don't re-enter the handler after we already answered (the 413 above destroys
  // the request, which can surface here as an error).
  req.on('error', () => { if (!aborted) { aborted = true; cb(null); } });
}

// Rate buckets are keyed 'scope:ip' — every caller MUST prefix a scope. A single
// shared per-IP bucket meant the map's background polls (waze/hotspots/incidents
// at 30/min, traffic tiles at 300/min) filled the same bucket the auth check
// read, so a user whose map was open couldn't register ("Too many attempts").
const authHits = new Map(); // 'scope:ip' -> [timestamps]
function rateOk(key, max, windowMs) {
  const now = Date.now();
  const arr = (authHits.get(key) || []).filter((t) => now - t < windowMs);
  authHits.set(key, arr);
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

// Expired email links are already unusable — takeEmailToken filters on
// expires_at — so this is housekeeping, not a security control. Without it the
// table only ever grows, one row per reset request that was never opened.
setInterval(() => {
  store.purgeExpiredTokens().catch((e) => console.error('[db] token purge:', e.message));
}, 60 * 60 * 1000).unref();

async function handleApi(req, res, urlPath) {
  const ip = clientIp(req);

  if (req.method === 'GET' && urlPath === '/api/me') {
    const token = bearer(req);
    const u = userFromToken(token);
    if (!u) {
      // A token that verifies but has no profile row behind it is the OAuth
      // half-signup: GoTrue knows this person, Convoy doesn't yet. Say so
      // distinctly, so the client can resume at "pick a username" instead of
      // throwing the session away and sending them round the provider again.
      const claims = liveClaims(token);
      if (claims && claims.sub) {
        return json(res, 409, {
          error: 'no-profile', needsProfile: true,
          email: claims.email || null,
          suggested: suggestFromClaims(claims)
        });
      }
      return json(res, 401, { error: 'unauthorized' });
    }
    return json(res, 200, {
      username: u.username, profile: u.profile,
      email: u.email || null, emailVerified: !!u.emailVerified, provider: u.provider || 'password'
    });
  }

  // What sign-in methods this deployment actually offers. Anonymous, cheap, and
  // read on the auth screen so the UI only ever draws buttons that work — a
  // Google button on a server with no Google credentials is worse than none.
  if (req.method === 'GET' && urlPath === '/api/auth/config') {
    return json(res, 200, {
      providers: oauth.list(),
      email: mail.configured(),      // gates register-with-email, reset-by-email, verification
      magicLink: mail.configured(),
      // Not used by the app — it is here so the APK's redirect can be read back
      // from a running server and checked against the Supabase allowlist,
      // instead of being three places that have to be kept in step by memory.
      nativeRedirect: oauth.nativeRedirect()
    });
  }

  // Anonymous capability probe: tells the client which optional data sources the
  // server has keys for, so it can opt in or fall back to keyless alternatives.
  // Cheap GET, no upstream call — safe to hit on every connect.
  if (req.method === 'GET' && urlPath === '/api/route/caps') {
    // waze/incidents stay "on" when the agent ingest is configured, even without
    // upstream keys — agent-pushed police/hazards flow through those endpoints.
    return json(res, 200, {
      routing: tomtom.hasKey(),
      waze: waze.hasKey() || agent.enabled(),
      hotspots: true,
      incidents: tomtom.hasKey() || agent.enabled()
    });
  }

  // Agent status probe (auth'd): live item counts for debugging an integration.
  if (req.method === 'GET' && urlPath === '/api/agent/status') {
    if (!agent.enabled()) return json(res, 503, { error: 'Agent API not configured (set AGENT_KEY)' });
    if (!agent.authed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { ok: true, live: agent.counts() });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  // Every anonymous credential-shaped endpoint shares the per-IP auth budget.
  // The email routes belong in it for the same reason the originals do: each one
  // either checks a secret or spends an outbound email, and both are things an
  // attacker would otherwise get for free.
  const ANON_AUTH_ROUTES = [
    '/api/register', '/api/login', '/api/recover',
    '/api/forgot', '/api/reset', '/api/magic', '/api/magic/consume',
    '/api/email/verify', '/api/email/change/confirm',
    '/api/oauth/start', '/api/oauth/callback'
  ];
  if (ANON_AUTH_ROUTES.indexOf(urlPath) >= 0 && !rateOk('auth:' + ip, 24, RATE_WINDOW)) {
    return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
  }

  readBody(req, res, async (body) => {
    if (body == null) return json(res, 400, { error: 'Bad request' }); // parse error / socket error
    try {
      if (urlPath === '/api/register') {
        const ue = validUsername(body.username);
        if (ue) return json(res, 400, { error: ue });
        const pe = validPassword(body.password);
        if (pe) return json(res, 400, { error: pe });
        // Email is REQUIRED wherever it can actually be confirmed. New accounts
        // start gated (see gated()) and the confirmation link is what lifts it,
        // so registering without an address would mean an account that can never
        // reach full functionality.
        //
        // Where there is NO mailer, it stays optional and nothing is gated: a
        // deployment with RESEND_API_KEY unset is the original username-only
        // Convoy, and demanding an address it could never send to would just
        // block sign-ups.
        let email = null;
        const gaveEmail = body.email != null && String(body.email).trim() !== '';
        if (!gaveEmail && mail.configured()) {
          return json(res, 400, { error: 'Email is required' });
        }
        if (gaveEmail) {
          const ee = validEmail(body.email);
          if (ee) return json(res, 400, { error: ee });
          if (!mail.configured()) return json(res, 503, { error: 'Email sign-up is not available on this server' });
          email = String(body.email).trim().toLowerCase();
        }
        const profile = sanitizeProfile(body.profile);
        profile.handle = body.username.trim().toLowerCase();
        const r = await store.createUser(body.username.trim(), body.password, profile, ip, email);
        if (r.error === 'taken') return json(res, 409, { error: 'That username is taken' });
        if (r.error === 'email-taken') {
          return json(res, 409, { error: 'That email already has an account — sign in instead' });
        }
        if (authFail(res, r)) return;
        if (r.error) {
          console.error('[register] ' + body.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not create the account — try again' });
        }
        console.log('[register] ' + r.user.username +
          (email ? ' (with email)' : '') + ' (' + store.count() + ' accounts)');
        // Fire the confirmation mail, but never fail the registration over it —
        // the account exists and works; an unsent link is a "resend" button away.
        let mailed = false;
        if (email) {
          const sent = await sendVerifyEmail(r.user, email);
          mailed = !!sent.ok;
          if (!mailed) console.error('[register] verification mail to ' + email + ' failed: ' + sent.error);
        }
        return json(res, 200, Object.assign(sessionPayload(r.session, r.user),
          { recoveryCode: r.recoveryCode, verificationSent: mailed }));
      }
      if (urlPath === '/api/login') {
        // Per-ACCOUNT throttle, independent of the per-IP one above. An attacker
        // spreading guesses across many source addresses (botnet, or a forged
        // X-Forwarded-For before clientIp() started gating that) would otherwise
        // get unlimited attempts against a single username, against a 6-char
        // password minimum.
        // `identifier` is the current field name and may be a username OR an
        // email; `username` is still read so an older client build keeps working.
        const ident = String(body.identifier || body.username || '').trim().toLowerCase().slice(0, 254);
        if (ident && !rateOk('login:' + ident, 10, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts on this account — wait a few minutes' });
        }
        const r = await store.signIn(ident, String(body.password || ''), ip);
        if (authFail(res, r)) return;
        // A reachable-but-broken account (auth user with no profile row) or an
        // unreachable GoTrue is our fault, not a bad password — don't tell the
        // rider their credentials are wrong when they aren't.
        if (r.error === 'no-profile' || r.error === 'unavailable') {
          console.error('[login] ' + ident + ': ' + r.error);
          return json(res, 502, { error: 'Sign-in is temporarily unavailable — try again' });
        }
        if (r.error) return json(res, 401, { error: 'Invalid username, email or password' });
        return json(res, 200, sessionPayload(r.session, r.user));
      }
      if (urlPath === '/api/recover') {
        const rname = String(body.username || '').trim().toLowerCase().slice(0, 20);
        if (rname && !rateOk('recover:' + rname, 10, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts on this account — wait a few minutes' });
        }
        // Validate the new password BEFORE the code is spent — rejecting it
        // afterwards would burn a single-use recovery code for nothing.
        const pe = validPassword(body.password);
        if (pe) return json(res, 400, { error: pe });
        // resetWithRecovery BURNS the code as part of verifying it, so a valid
        // code can only drive one reset even if several requests race.
        const r = await store.resetWithRecovery(
          String(body.username || ''), String(body.code || ''), body.password, ip);
        if (r.error === 'bad-code') return json(res, 401, { error: 'Wrong username or recovery code' });
        // store.resetWithRecovery puts the code back for these two, so the rider
        // really can try again — which is the whole reason they get their own answer.
        if (authFail(res, r)) return;
        if (r.error) {
          console.error('[recover] ' + body.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not reset the password — try again' });
        }
        console.log('[recover] ' + r.user.username + ' reset their password');
        return json(res, 200, Object.assign(sessionPayload(r.session, r.user), { recoveryCode: r.recoveryCode }));
      }
      if (urlPath === '/api/change-password') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        // A valid access token is not a licence to brute-force the CURRENT
        // password. This check is what stands between a borrowed or stolen
        // session and a permanent takeover, and every attempt also costs a
        // GoTrue /token call, so throttle it per account AND per source.
        if (!rateOk('chpw:' + u.id, 10, RATE_WINDOW) || !rateOk('chpw:' + ip, 20, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        // Validate before spending a round-trip on the old password.
        const pe = validPassword(body.newPassword);
        if (pe) return json(res, 400, { error: pe });
        const ok = await store.verifyPassword(u, String(body.oldPassword || ''), ip);
        if (authFail(res, ok)) return;
        if (!ok.ok) return json(res, 401, { error: 'Current password is incorrect' });
        const changed = await store.changePassword(u, body.newPassword, ip);
        if (authFail(res, changed)) return;
        if (changed.error) {
          console.error('[change-password] ' + u.username + ': ' + changed.error);
          return json(res, 502, { error: 'Could not change the password — try again' });
        }
        // Tell the account holder out-of-band. This is the notice that turns a
        // silent takeover into something the real owner finds out about, so it
        // is sent on a successful change and never blocks the response.
        if (u.email && u.emailVerified) {
          mail.send(mail.passwordChangedNotice(u.email, u.username));
        }
        // Hand back the fresh session so the caller stays signed in.
        return json(res, 200, Object.assign({ ok: true }, sessionPayload(changed.session, u)));
      }
      /* ---- account deletion (right to erasure) ----
         Google Play's account-deletion policy and GDPR Art. 17 both require this
         to be reachable by the account holder without asking us, so it is a
         first-class endpoint rather than a support-inbox workflow.

         Re-authentication is mandatory. A valid access token proves someone has
         the device, not that they are the owner — and this is the single most
         destructive thing the API can do, so a borrowed session must not be
         enough on its own:
           · password accounts confirm with the password;
           · provider accounts (Google et al.) have no Convoy password to confirm
             with, so they type their own username exactly instead. Weaker, but
             the alternative is a provider account that can never be deleted,
             which is itself the policy violation. */
      if (urlPath === '/api/account/delete') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!rateOk('del:' + u.id, 5, RATE_WINDOW) || !rateOk('del:' + ip, 10, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        // Typed into the UI as a deliberate speed bump, and re-checked here so
        // the confirmation is not something a client can decide to skip.
        if (String(body.confirm || '').trim().toUpperCase() !== 'DELETE') {
          return json(res, 400, { error: 'Type DELETE to confirm' });
        }
        const viaProvider = (u.provider || 'password') !== 'password';
        if (viaProvider) {
          if (String(body.confirmUsername || '').trim().toLowerCase() !== u.username.toLowerCase()) {
            return json(res, 401, { error: 'That username doesn\'t match this account' });
          }
        } else {
          const ok = await store.verifyPassword(u, String(body.password || ''), ip);
          if (authFail(res, ok)) return;
          if (!ok.ok) return json(res, 401, { error: 'Password is incorrect' });
        }

        // Captured before the record is destroyed — the notice below needs them.
        const goneName = u.username;
        const goneEmail = (u.email && u.emailVerified) ? u.email : null;

        const done = await store.deleteAccount(u.id);
        if (done.error === 'no-such-account') return json(res, 404, { error: 'No such account' });
        if (done.error) {
          console.error('[delete] ' + goneName + ': ' + done.error);
          return json(res, 502, { error: 'Could not delete the account — try again' });
        }

        // Drop any live socket still riding on this account. Without it the
        // rider keeps streaming positions and appearing in other people's maps
        // and friend lists until they happen to disconnect.
        //
        // Closed, not messaged: there is no client handler for a "your account
        // is gone" frame, and inventing one would be a frame every client
        // silently drops. The close is what the client reacts to — it reconnects,
        // the token no longer resolves, and net.js's existing 'auth:invalid' path
        // signs it out. On the device that did the deleting the UI has already
        // cleared local state and reloaded, so it never gets that far.
        for (const [, c] of clients) {
          if (c.userId !== u.id) continue;
          try { c.ws.close(); } catch (e) { /* already gone */ }
        }

        // Best-effort, never blocking: the account is already gone either way.
        if (goneEmail) mail.send(mail.accountDeletedNotice(goneEmail, goneName));

        return json(res, 200, { ok: true });
      }

      if (urlPath === '/api/recovery') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        // Same reasoning as /api/change-password: a password check reachable with
        // only a token needs its own throttle, and each try costs a GoTrue call.
        if (!rateOk('regen:' + u.id, 10, RATE_WINDOW) || !rateOk('regen:' + ip, 20, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        const ok = await store.verifyPassword(u, String(body.password || ''), ip);
        if (authFail(res, ok)) return;
        if (!ok.ok) return json(res, 401, { error: 'Password is incorrect' });
        const code = await store.regenRecovery(u.id);
        return json(res, 200, { recoveryCode: code });
      }

      /* ==================== email ====================
         Four flows, all built on the same single-use token table:
           forgot/reset          — password reset for a VERIFIED address
           magic/magic-consume   — passwordless sign-in for a VERIFIED address
           email/verify          — prove ownership of an address
           email/change(+confirm)— move an account to a different address

         The rule every one of them obeys: a route that takes an address from an
         anonymous caller answers the SAME WAY whether or not that address has an
         account. Anything else turns this into a "does X ride with Convoy?"
         lookup for anyone with an email list. */

      // Ask for a password-reset link.
      if (urlPath === '/api/forgot') {
        if (!mail.configured()) return json(res, 503, { error: 'Password reset by email is not available on this server' });
        const address = String(body.email || '').trim().toLowerCase().slice(0, 254);
        // Per-address budget on top of the per-IP one: without it, one address
        // can be mailbombed from a spread of source addresses.
        if (address && !rateOk('forgot:' + address, 5, RATE_WINDOW)) {
          return json(res, 200, { ok: true });     // still the uniform answer
        }
        const u = address ? store.getByEmail(address) : null;
        // Unverified means nobody has proven they hold the mailbox, so a reset
        // link sent there could hand over an account to whoever typed the
        // address in at signup.
        if (u && u.emailVerified) {
          const token = await store.issueEmailToken(u.id, 'reset', address);
          const link = mail.appUrl() + '/l/reset?token=' + encodeURIComponent(token);
          const sent = await mail.send(mail.resetPassword(address, u.username, link));
          if (sent.error) console.error('[forgot] mail to ' + address + ' failed: ' + sent.error);
          else console.log('[forgot] reset link sent for ' + u.username);
        }
        return json(res, 200, { ok: true });
      }

      // Redeem a reset link and set the new password.
      if (urlPath === '/api/reset') {
        const pe = validPassword(body.password);
        // Checked BEFORE the token is spent, for the same reason /api/recover
        // validates first: burning a single-use link on a password we were
        // always going to reject strands the rider.
        if (pe) return json(res, 400, { error: pe });
        const claim = await store.consumeEmailToken(String(body.token || ''), 'reset');
        if (!claim) return json(res, 400, { error: 'That reset link has expired or was already used' });
        const u = store.getById(claim.userId);
        if (!u) return json(res, 400, { error: 'That reset link is no longer valid' });
        // The link proves ownership of the address it was SENT to. If the
        // account has moved to a different address since, that proof is about a
        // mailbox this account no longer uses — and honouring it would let a
        // former address (or an attacker who briefly held one) still take over.
        if (store.normalizeEmail(u.email) !== store.normalizeEmail(claim.email)) {
          return json(res, 400, { error: 'That link was for an email address this account no longer uses' });
        }
        const r = await store.resetPasswordFor(u, body.password, ip);
        if (authFail(res, r)) return;
        if (r.error) {
          console.error('[reset] ' + u.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not reset the password — request a new link' });
        }
        console.log('[reset] ' + u.username + ' reset their password by email');
        return json(res, 200, sessionPayload(r.session, u));
      }

      // Ask for a passwordless sign-in link.
      if (urlPath === '/api/magic') {
        if (!mail.configured()) return json(res, 503, { error: 'Email sign-in is not available on this server' });
        const address = String(body.email || '').trim().toLowerCase().slice(0, 254);
        if (address && !rateOk('magic:' + address, 5, RATE_WINDOW)) return json(res, 200, { ok: true });
        const u = address ? store.getByEmail(address) : null;
        if (u && u.emailVerified) {
          // GoTrue mints the one-time credential that can later be traded for a
          // session; we keep it here and mail our own token instead, so the link
          // in the rider's inbox expires on our schedule and burns on our terms.
          const gen = await sb.generateLink('magiclink', address, ip);
          if (gen.error) {
            console.error('[magic] generate_link for ' + u.username + ': ' + gen.error);
          } else {
            const token = await store.issueEmailToken(u.id, 'magic', address, gen.hashedToken);
            const link = mail.appUrl() + '/l/magic?token=' + encodeURIComponent(token);
            const sent = await mail.send(mail.magicLink(address, u.username, link));
            if (sent.error) console.error('[magic] mail to ' + address + ' failed: ' + sent.error);
            else console.log('[magic] sign-in link sent for ' + u.username);
          }
        }
        return json(res, 200, { ok: true });
      }

      // Redeem a sign-in link.
      if (urlPath === '/api/magic/consume') {
        const claim = await store.consumeEmailToken(String(body.token || ''), 'magic');
        if (!claim) return json(res, 400, { error: 'That sign-in link has expired or was already used' });
        const u = store.getById(claim.userId);
        if (!u) return json(res, 400, { error: 'That sign-in link is no longer valid' });
        // Same staleness rule as /api/reset — a link is only proof about the
        // address it went to, and this one signs someone in outright.
        if (store.normalizeEmail(u.email) !== store.normalizeEmail(claim.email)) {
          return json(res, 400, { error: 'That link was for an email address this account no longer uses' });
        }
        const r = await store.magicSignIn(u, claim.payload, ip);
        if (r.error === 'rate-limited') {
          return json(res, 429, { error: 'Too many attempts right now — wait a minute and try again' });
        }
        if (r.error) {
          console.error('[magic] verify for ' + u.username + ': ' + r.error);
          return json(res, 400, { error: 'That sign-in link is no longer valid — request a new one' });
        }
        console.log('[magic] ' + u.username + ' signed in by email link');
        return json(res, 200, sessionPayload(r.session, u));
      }

      // Resend the confirm-your-address mail (authenticated: it can only ever go
      // to the address already on the caller's own account).
      if (urlPath === '/api/email/verify/send') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!mail.configured()) return json(res, 503, { error: 'Email is not available on this server' });
        if (!u.email) return json(res, 400, { error: 'Add an email address first' });
        if (u.emailVerified) return json(res, 200, { ok: true, alreadyVerified: true });
        if (!rateOk('verifysend:' + u.id, 5, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many emails — wait a few minutes' });
        }
        const sent = await sendVerifyEmail(u, u.email);
        if (sent.error) {
          console.error('[verify] mail to ' + u.email + ' failed: ' + sent.error);
          return json(res, 502, { error: 'Could not send the email — try again' });
        }
        return json(res, 200, { ok: true });
      }

      // Redeem a confirmation link. Anonymous on purpose: the link is opened
      // from a mail client that very often is not the signed-in device.
      if (urlPath === '/api/email/verify') {
        const claim = await store.consumeEmailToken(String(body.token || ''), 'verify');
        if (!claim) return json(res, 400, { error: 'That confirmation link has expired or was already used' });
        const u = store.getById(claim.userId);
        if (!u) return json(res, 400, { error: 'That confirmation link is no longer valid' });
        // The address may have moved on since the link was sent. Confirming a
        // stale one would mark the CURRENT address verified without anyone
        // having proven they hold it.
        if (store.normalizeEmail(u.email) !== store.normalizeEmail(claim.email)) {
          return json(res, 400, { error: 'That link was for a different email address' });
        }
        if (!u.emailVerified) {
          await store.markEmailVerified(u);
          console.log('[verify] ' + u.username + ' confirmed their email');
          // Lift the gate on any LIVE session for this account, right now. The
          // check itself reads the account record, so it is already open — but
          // every rider this socket has been told about was sent anonymised, and
          // those records live on the client until something replaces them.
          // Re-send them.
          liftGateFor(u.id);
        }
        return json(res, 200, { ok: true, username: u.username });
      }

      // Start moving the account to a different address. Requires the password:
      // a borrowed session must not be able to redirect the account's recovery
      // path to an attacker's inbox.
      if (urlPath === '/api/email/change') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!mail.configured()) return json(res, 503, { error: 'Email is not available on this server' });
        if (!rateOk('chmail:' + u.id, 6, RATE_WINDOW) || !rateOk('chmail:' + ip, 20, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        const ee = validEmail(body.email);
        if (ee) return json(res, 400, { error: ee });
        const next = String(body.email).trim().toLowerCase();
        if (store.normalizeEmail(u.email) === next) {
          return json(res, 400, { error: 'That is already your email address' });
        }
        // A provider account has no password to check, so this route can't gate
        // on one. Those riders change the address with the provider instead.
        if (u.provider !== 'password') {
          return json(res, 400, { error: 'This account signs in with ' + u.provider + ' — change your email there' });
        }
        const ok = await store.verifyPassword(u, String(body.password || ''), ip);
        if (authFail(res, ok)) return;
        if (!ok.ok) return json(res, 401, { error: 'Password is incorrect' });
        // Deliberately NOT reported: whether `next` already belongs to someone.
        // The address is only revealed as taken at confirm time, to the person
        // who can read the mailbox. Everyone else just never gets a link.
        const taken = store.getByEmail(next);
        if (!taken) {
          const token = await store.issueEmailToken(u.id, 'change', next, next);
          const link = mail.appUrl() + '/l/change?token=' + encodeURIComponent(token);
          const sent = await mail.send(mail.confirmNewEmail(next, u.username, link));
          if (sent.error) {
            console.error('[email-change] mail to ' + next + ' failed: ' + sent.error);
            return json(res, 502, { error: 'Could not send the email — try again' });
          }
          // Warn the address currently on file. If this change wasn't the
          // owner's doing, this is the only place they hear about it.
          if (u.email && u.emailVerified) mail.send(mail.emailChangedNotice(u.email, u.username, next));
        }
        return json(res, 200, { ok: true, sentTo: next });
      }

      // Finish the move.
      if (urlPath === '/api/email/change/confirm') {
        const claim = await store.consumeEmailToken(String(body.token || ''), 'change');
        if (!claim) return json(res, 400, { error: 'That link has expired or was already used' });
        const u = store.getById(claim.userId);
        if (!u) return json(res, 400, { error: 'That link is no longer valid' });
        const next = store.normalizeEmail(claim.payload || claim.email);
        const r = await store.setEmailFor(u, next, true, ip);
        if (r.error === 'taken') {
          return json(res, 409, { error: 'That email now belongs to another account' });
        }
        if (r.error) {
          console.error('[email-change] ' + u.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not update the email — try again' });
        }
        console.log('[email-change] ' + u.username + ' moved to a new email');
        return json(res, 200, { ok: true, email: next, username: u.username });
      }

      // Attach an address to an account that has none (the legacy username-only
      // case). Verification still has to happen before it does anything.
      if (urlPath === '/api/email/add') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!mail.configured()) return json(res, 503, { error: 'Email is not available on this server' });
        if (u.email) return json(res, 400, { error: 'This account already has an email — change it instead' });
        if (!rateOk('addmail:' + u.id, 6, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        const ee = validEmail(body.email);
        if (ee) return json(res, 400, { error: ee });
        const next = String(body.email).trim().toLowerCase();
        const ok = await store.verifyPassword(u, String(body.password || ''), ip);
        if (authFail(res, ok)) return;
        if (!ok.ok) return json(res, 401, { error: 'Password is incorrect' });
        if (store.getByEmail(next)) {
          return json(res, 409, { error: 'That email already has an account' });
        }
        // Attached UNVERIFIED. It becomes real only when the link is opened,
        // which is what stops someone parking a stranger's address on an
        // account and then "recovering" it later.
        const moved = await store.setEmailFor(u, next, false, ip);
        if (moved.error === 'taken') return json(res, 409, { error: 'That email already has an account' });
        if (moved.error) {
          console.error('[email-add] ' + u.username + ': ' + moved.error);
          return json(res, 502, { error: 'Could not save the email — try again' });
        }
        const sent = await sendVerifyEmail(u, next);
        if (sent.error) console.error('[email-add] verification mail failed: ' + sent.error);
        return json(res, 200, { ok: true, email: next, verificationSent: !!sent.ok });
      }

      /* ==================== OAuth (Google et al.) ==================== */

      // Step 1: hand the client the provider URL to open.
      //
      // `native` picks the APK's custom-scheme redirect over the website's. It
      // only SELECTS between two server-configured targets — the caller never
      // supplies one — so a web client asking for the native target just gets a
      // URL its browser can't come back from.
      if (urlPath === '/api/oauth/start') {
        const r = oauth.start(body.provider, mail.appUrl(), !!body.native);
        if (r.error === 'provider-not-enabled') {
          return json(res, 400, { error: 'That sign-in method isn\'t enabled here' });
        }
        // Listed in OAUTH_PROVIDERS but switched off in the Supabase dashboard.
        // Answering the API call is the whole point: navigating to GoTrue would
        // put a raw "provider is not enabled" JSON body on the rider's screen.
        if (r.error === 'provider-not-configured') {
          console.error('[oauth] ' + body.provider + ' is not enabled in Supabase Auth — ' +
            'Dashboard → Authentication → Providers');
          return json(res, 503, { error: 'That sign-in method isn\'t available right now' });
        }
        if (r.error) return json(res, 503, { error: 'Sign-in is busy right now — try again' });
        // Login-CSRF binding for the WEB flow. `state` alone is a pure bearer:
        // an attacker could complete their OWN provider sign-in, copy the landing
        // URL (?cvst=…&code=…) and send it to a victim, whose app would silently
        // POST it and land signed into the ATTACKER's account. Echoing the state
        // in an HttpOnly SameSite=Lax cookie means the callback must arrive from
        // the same browser session that started the flow. Non-cookie clients
        // (the APK's cross-origin WebView fetch) are allowed to omit it — their
        // gate is the client-side remembered-state check in js/auth.js.
        const secure = /^https:/i.test(mail.appUrl()) ? '; Secure' : '';
        res.setHeader('Set-Cookie', 'cvst=' + encodeURIComponent(r.state) +
          '; Max-Age=600; Path=/; HttpOnly; SameSite=Lax' + secure);
        return json(res, 200, { url: r.url, state: r.state, native: r.native });
      }

      // Step 2: trade the authorization code from the redirect for a session.
      // A brand-new provider account has no profile row yet, so this can return
      // needsProfile — see /api/oauth/complete.
      if (urlPath === '/api/oauth/callback') {
        // If a browser DID send our cvst cookie it must match the state being
        // redeemed — a mismatch is a link minted in someone else's session.
        // decodeURIComponent throws URIError on a malformed escape ('%ZZ', a bare
        // '%'), and the outer catch would turn that into an opaque 500 instead of
        // the 400 below. A cookie we cannot decode cannot match the state either,
        // so fold it into the mismatch case rather than letting it escape.
        const cvstRaw = (String(req.headers.cookie || '').match(/(?:^|;\s*)cvst=([^;]+)/) || [])[1];
        let cvstCookie = null;
        if (cvstRaw !== undefined) {
          try { cvstCookie = decodeURIComponent(cvstRaw); } catch (e) { cvstCookie = null; }
        }
        if (cvstRaw !== undefined && cvstCookie !== String(body.state || '')) {
          return json(res, 400, { error: 'That sign-in link was started somewhere else — sign in again' });
        }
        const pend = oauth.take(body.state);
        // No pending state = a replayed, expired, or forged callback. The code
        // is worthless without the verifier we are refusing to look up.
        if (!pend) return json(res, 400, { error: 'That sign-in expired — try again' });
        const code = String(body.code || '');
        if (!code) return json(res, 400, { error: 'Sign-in was cancelled' });
        const r = await sb.exchangePkce(code, pend.verifier, ip);
        if (r.error) {
          console.error('[oauth] ' + pend.provider + ' exchange: ' + r.error);
          return json(res, 401, { error: 'Could not complete sign-in — try again' });
        }
        const authUser = r.session.user || {};
        const existing = store.getById(authUser.id);
        if (existing) {
          console.log('[oauth] ' + existing.username + ' signed in with ' + pend.provider);
          return json(res, 200, sessionPayload(r.session, existing));
        }
        // First time through: GoTrue has them, Convoy doesn't. Hand back the
        // session so the client can finish, plus something to pre-fill with.
        const meta = authUser.user_metadata || {};
        return json(res, 200, {
          needsProfile: true,
          provider: pend.provider,
          token: r.session.access_token,
          refreshToken: r.session.refresh_token,
          expiresAt: Date.now() + (Number(r.session.expires_in) || 3600) * 1000,
          email: authUser.email || null,
          suggested: suggestFromClaims({ email: authUser.email, user_metadata: meta })
        });
      }

      // Step 3: claim a username and a car, which is what actually creates the
      // Convoy account behind a provider sign-in.
      if (urlPath === '/api/oauth/complete') {
        const token = bearer(req);
        const claims = liveClaims(token);
        if (!claims || !claims.sub) return json(res, 401, { error: 'unauthorized' });
        if (store.getById(claims.sub)) return json(res, 409, { error: 'This account is already set up' });
        if (!rateOk('oauthdone:' + ip, 20, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        const ue = validUsername(body.username);
        if (ue) return json(res, 400, { error: ue });
        const profile = sanitizeProfile(body.profile);
        profile.handle = body.username.trim().toLowerCase();
        // The address comes from the VERIFIED token, never from the request
        // body — otherwise the caller could claim any address they liked and
        // get it marked verified.
        const email = claims.email && !String(claims.email).toLowerCase()
          .endsWith('@' + sb.syntheticDomain.toLowerCase()) ? String(claims.email).toLowerCase() : null;
        const provider = String((claims.app_metadata && claims.app_metadata.provider) || 'oauth').slice(0, 24);
        const r = await store.completeOAuth(claims.sub, body.username.trim(), profile, email, provider);
        if (r.error === 'taken') return json(res, 409, { error: 'That username is taken' });
        if (r.error === 'email-taken') {
          return json(res, 409, { error: 'That email already has a Convoy account — sign in with your password instead' });
        }
        if (r.error === 'already-complete') return json(res, 409, { error: 'This account is already set up' });
        if (r.error) {
          console.error('[oauth-complete] ' + body.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not finish setting up the account — try again' });
        }
        console.log('[oauth-complete] ' + r.user.username + ' via ' + provider +
          ' (' + store.count() + ' accounts)');
        // No new session is minted: the one the caller already holds is valid
        // and now resolves to a real account.
        return json(res, 200, {
          ok: true, username: r.user.username, profile: r.user.profile,
          email: r.user.email, emailVerified: r.user.emailVerified, provider: r.user.provider,
          recoveryCode: r.recoveryCode
        });
      }

      /* ==================== linked sign-in methods ==================== */

      // What this account can sign in with. Read straight from GoTrue rather
      // than cached, because linking happens on its side.
      if (urlPath === '/api/identities') {
        const token = bearer(req);
        const u = userFromToken(token);
        if (!u) return json(res, 401, { error: 'unauthorized' });
        // Every call here is a round-trip to GoTrue. The panel that reads it
        // opens once in a while, so this ceiling is invisible in normal use and
        // stops a signed-in client from spending the project's request budget.
        if (!rateOk('idlist:' + u.id, 20, RATE_WINDOW) || !rateOk('idlist:' + ip, 40, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many requests — wait a few minutes' });
        }
        const r = await sb.getUser(token, ip);
        if (r.error) {
          console.error('[identities] ' + u.username + ': ' + r.error);
          return json(res, 502, { error: 'Could not load your sign-in methods' });
        }
        const list = (r.user.identities || []).map((i) => ({
          id: i.identity_id || i.id,
          provider: i.provider,
          // identity_data is provider-supplied and user-editable; it is shown as
          // a label and nothing more.
          email: (i.identity_data && i.identity_data.email) || null,
          since: i.created_at || null
        }));
        return json(res, 200, { identities: list, canUnlink: list.length > 1 });
      }

      // Detach a provider. GoTrue itself refuses to remove the last identity on
      // an account, which is the guard that stops someone locking themselves out.
      if (urlPath === '/api/identities/unlink') {
        const token = bearer(req);
        const u = userFromToken(token);
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!rateOk('unlink:' + u.id, 10, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
        }
        const r = await sb.unlinkIdentity(token, String(body.identityId || ''), ip);
        if (r.error) {
          console.error('[unlink] ' + u.username + ': ' + r.error);
          return json(res, 400, { error: 'Could not unlink that — an account must keep at least one sign-in method' });
        }
        console.log('[unlink] ' + u.username + ' removed a sign-in method');
        return json(res, 200, { ok: true });
      }

      // Exchange a Supabase refresh token for a fresh session. Deliberately does
      // NOT require a valid access token — by the time the client calls this its
      // access token has usually already expired, which is the whole point.
      // Rate-limited per IP because a refresh token is a bearer credential.
      if (urlPath === '/api/refresh') {
        if (!rateOk('refresh:' + ip, 60, RATE_WINDOW)) {
          return json(res, 429, { error: 'Too many refreshes — wait a few minutes' });
        }
        const rt = String(body.refreshToken || '');
        if (!rt) return json(res, 400, { error: 'Missing refresh token' });
        const r = await sb.refresh(rt, ip);
        // GoTrue's own rate limit is NOT an expired session. The client clears
        // its stored session on a 401 and keeps it on anything else, so getting
        // this wrong signs a rider out over a limit that clears by itself.
        if (r.error && r.status === 429) {
          return json(res, 429, { error: 'Too many refreshes — wait a minute and try again' });
        }
        // Rotated, revoked or expired → the client must sign in again.
        if (r.error) return json(res, 401, { error: 'Session expired' });
        const u = store.getById(r.session.user && r.session.user.id);
        if (!u) return json(res, 401, { error: 'Session expired' });
        return json(res, 200, sessionPayload(r.session, u));
      }

      // Revoke the current session server-side. The client clears its own copy
      // regardless; this stops the refresh token from minting anything new.
      if (urlPath === '/api/logout') {
        // Every call is a GoTrue round-trip even with a garbage token, and the
        // route is anonymous — unthrottled it was a free lever on the project's
        // shared auth budget (exhausting it degraded everyone's sign-ins).
        if (!rateOk('logout:' + ip, 30, RATE_WINDOW)) return json(res, 429, { error: 'Too many requests' });
        const token = bearer(req);
        if (token) await sb.signOut(token, body && body.everywhere ? 'global' : 'local', ip);
        return json(res, 200, { ok: true });
      }
      if (urlPath === '/api/profile') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        const profile = sanitizeProfile(body.profile);
        profile.handle = u.username.toLowerCase();
        store.updateProfile(u.id, profile);
        return json(res, 200, { ok: true, profile });
      }

      // Dragy personal best (auth'd). The client POSTs after finish() when it
      // computes a new PB; the server only persists if it beats the stored time.
      // Returns the full stats object so the client adopts the authoritative view.
      if (urlPath === '/api/dragy/pb') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (!rateOk('pb:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        const DRAGY_MODES = ['0-60', '0-100k', '0-30', '0-100', '60-130', '100-200k', 'eighth', 'quarter'];
        const modeId = str(body && body.modeId, 16, '');
        if (DRAGY_MODES.indexOf(modeId) < 0) return json(res, 400, { error: 'bad mode' });
        const time = Number(body && body.time);
        const trap = body && body.trap != null ? Number(body.trap) : null;
        if (!Number.isFinite(time) || time <= 0 || time > 600) return json(res, 400, { error: 'bad time' });
        if (trap != null && (!Number.isFinite(trap) || trap < 0)) return json(res, 400, { error: 'bad trap' });
        const stats = store.recordPB(u.id, modeId, time, trap == null ? null : trap);
        // Propagate to the live client + notify scoped riders (live profile updates).
        const c = online.get(u.id);
        if (c) {
          c.stats = stats;
          fanoutStat(c, stats);
        }
        return json(res, 200, { ok: true, stats: stats });
      }

      // Traffic-aware routing via TomTom (key is a server secret). Anonymous:
      // routing is core app functionality and routing isn't sensitive data, so
      // no token required — but it is rate-limited per IP to protect the quota.
      if (urlPath === '/api/route') {
        const ip = clientIp(req);
        if (!rateOk('route:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many route requests — slow down' });
        if (!tomtom.hasKey()) return json(res, 503, { error: 'Routing key not configured' });
        tomtom.route(body, (err, status, j) => {
          // A bad from/to is the CALLER's mistake — 400, not an upstream-looking
          // 502 that sends the client into retry/fallback for its own bug.
          if (err) return json(res, status === 400 ? 400 : 502,
            { error: status === 400 ? 'bad coords' : 'Routing service unavailable' });
          return json(res, 200, j);
        });
        return;
      }

      // Live Waze alerts (police/accidents/hazards) via OpenWeb Ninja. Anonymous —
      // the bbox is public road data — but rate-limited per IP to protect the
      // upstream quota. Returns normalized GeoJSON the client layers consume.
      // body: { bottomLeft:[lng,lat], topRight:[lng,lat] }
      if (urlPath === '/api/waze') {
        const ip = clientIp(req);
        if (!rateOk('waze:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        const bl = body && body.bottomLeft, tr = body && body.topRight;
        if (!tomtom.isLngLat(bl) || !tomtom.isLngLat(tr)) return json(res, 400, { error: 'bad bbox' });
        // Agent-pushed live police merge into every response (already recorded
        // into the hotspot model at ingest — don't record them again here).
        const agentFeats = agent.enabled() ? agent.policeFeatures(bl, tr) : [];
        if (!waze.hasKey()) {
          // No upstream key but the agent feed is on → serve agent sightings alone.
          if (agent.enabled()) return json(res, 200, { type: 'FeatureCollection', features: agentFeats });
          return json(res, 503, { error: 'Waze key not configured' });
        }
        waze.alerts(bl, tr, (err, status, fc) => {
          // Surface upstream rate-limiting as 429 (not a generic 502) so the client +
          // collector back off instead of retry-storming the shared free-tier key —
          // unless the agent feed has sightings for this view: those are local and
          // quota-free, so serving them beats an empty error (waze.js's cooldown
          // still protects the upstream key either way).
          if (err) {
            if (agentFeats.length) return json(res, 200, { type: 'FeatureCollection', features: agentFeats });
            return json(res, status === 429 ? 429 : 502,
              { error: status === 429 ? 'Waze rate limited — backing off' : 'Waze service unavailable' });
          }
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
            if (agentFeats.length) fc.features = fc.features.concat(agentFeats);
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
      // OpenStreetMap lookups (police stations, speed cameras, ALPR, stops,
      // signals). Proxied because overpass-api.de serves no CORS header, so the
      // browser cannot call it at all — and because one cached answer here
      // serves every rider in the area instead of each of them asking.
      //
      // Anonymous: this is public map data and guests use the same map layers.
      // The caller picks a KIND, never a query — see server/overpass.js.
      if (urlPath === '/api/overpass') {
        if (!rateOk('overpass:' + ip, 30, 60 * 1000)) {
          return json(res, 429, { error: 'Too many requests — slow down' });
        }
        const kind = String(body && body.kind || '');
        if (!overpass.hasKind(kind)) return json(res, 400, { error: 'Unknown lookup' });
        const r = await overpass.query(kind, body && body.bbox);
        if (r.error === 'bad-bbox') return json(res, 400, { error: 'Bad bounding box' });
        // 502, not 500: upstream is down or busy, and the client already treats
        // a failure here as "skip this layer" rather than as an error to show.
        if (r.error) return json(res, 502, { error: 'Map data is unavailable right now' });
        return json(res, 200, r.body);
      }

      if (urlPath === '/api/hotspots') {
        const ip = clientIp(req);
        if (!rateOk('hotspots:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        const bl = body && body.bottomLeft, tr = body && body.topRight;
        if (!tomtom.isLngLat(bl) || !tomtom.isLngLat(tr)) return json(res, 400, { error: 'bad bbox' });
        let hour = Number(body && body.hour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = new Date().getHours();
        return json(res, 200, hotspots.query(bl[0], bl[1], tr[0], tr[1], hour));
      }

      // Live traffic INCIDENTS (accidents, closures, road hazards) via TomTom — same
      // key as the traffic heatmap. Anonymous + rate-limited. Returns hazard-pin GeoJSON
      // the client's hazard layer consumes. body: { bottomLeft:[lng,lat], topRight:[lng,lat] }
      if (urlPath === '/api/incidents') {
        const ip = clientIp(req);
        if (!rateOk('incidents:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Too many requests — slow down' });
        const bl = body && body.bottomLeft, tr = body && body.topRight;
        if (!tomtom.isLngLat(bl) || !tomtom.isLngLat(tr)) return json(res, 400, { error: 'bad bbox' });
        // Agent-pushed hazards/traffic/weather ride on the same hazard-pin feed.
        const agentFeats = agent.enabled() ? agent.hazardFeatures(bl, tr) : [];
        if (!tomtom.hasKey()) {
          if (agent.enabled()) return json(res, 200, { type: 'FeatureCollection', features: agentFeats });
          return json(res, 503, { error: 'Incidents key not configured' });
        }
        tomtom.incidents(bl[0], bl[1], tr[0], tr[1], (err, status, fc) => {
          if (err) {
            // Upstream down: agent pins are better than an empty error for the map.
            if (agentFeats.length) return json(res, 200, { type: 'FeatureCollection', features: agentFeats });
            return json(res, 502, { error: 'Incidents service unavailable' });
          }
          if (fc && fc.features && agentFeats.length) fc.features = fc.features.concat(agentFeats);
          return json(res, 200, fc);
        });
        return;
      }

      // Agent ingest: an external AI/script pushes live map data (police, hazards,
      // traffic, weather, hotspot observations). See AGENT-API.md for the contract.
      // Auth is the AGENT_KEY env var — unset means the feature is off.
      if (urlPath === '/api/agent/update') {
        if (!agent.enabled()) return json(res, 503, { error: 'Agent API not configured (set AGENT_KEY)' });
        if (!agent.authed(req)) return json(res, 401, { error: 'unauthorized' });
        if (!rateOk('agent:' + ip, 120, 60 * 1000)) return json(res, 429, { error: 'Too many agent updates — slow down' });
        const items = Array.isArray(body && body.items) ? body.items : (body && body.type ? [body] : null);
        if (!items || !items.length) return json(res, 400, { error: 'body must be {items:[...]} or a single item' });
        if (items.length > 100) return json(res, 400, { error: 'max 100 items per call' });
        const result = agent.ingest(items);
        return json(res, 200, { ok: true, accepted: result.accepted, rejected: result.rejected, live: agent.counts() });
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
// Ad-hoc drag races (NOT convoy-gated). Any nearby rider can create/join. A race
// is proximity-scoped at join (B.haversine ≤ NEARBY_KM) so two riders out of range
// can't race. Auto-cleans up on finish, abandon, or leader disconnect.
const races = new Map();   // raceId -> race
const RACE_DRAGY_MODES = ['0-60', '0-100k', '0-30', '0-100', '60-130', '100-200k', 'eighth', 'quarter'];
const RACE_MAX = 8;        // racers per race (matches the parking-lot feel of a drag strip)
// race:fix budgets. The client relays at 10Hz for the WHOLE race (js/race.js
// fixSendTimer), so one racer needs 600/min — a 200/min PER-IP bucket starved
// every race 10–20s in (instantly so for two riders sharing a phone-hotspot
// NAT, which is this app's home turf). Budget per CONNECTION at the real
// cadence, and per IP at "a full NAT'd race group" headroom.
const RACE_FIX_BUDGET = parseInt(process.env.RACE_FIX_BUDGET || '700', 10);        // per connection /min
const RACE_FIX_IP_BUDGET = parseInt(process.env.RACE_FIX_IP_BUDGET || '3600', 10); // per IP /min (6 racers @10Hz)
// How far from your own position you may drop a crowd report. Generous enough
// for "police a couple of exits up", tight enough that the hotspot model can't
// be seeded from the other side of the planet.
const REPORT_MAX_M = parseInt(process.env.REPORT_MAX_M || '8000', 10);
// voice:relay budget. Each accepted chunk fans out to up to MAX_PARTY-1 convoy
// members plus VOICE_PROX_MAX nearby riders, so an unmetered sender amplified
// its own bandwidth ~16x through the server. ~20 chunks/s is well clear of the
// client encoder's real cadence.
const VOICE_RELAY_BUDGET = parseInt(process.env.VOICE_RELAY_BUDGET || '1200', 10);

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

/* ================= the unverified-email gate =================
   An account that has an email address but has not confirmed it sees the map
   ANONYMISED: other riders keep their car and their pin, but lose their name,
   handle, photo, username and stats. Confirming the address restores all of it,
   live, without a reconnect.

   WHO IS **NOT** GATED, and why each matters:
     · guests — they never gave an address, so there is nothing to confirm. They
       are a separate, pre-existing tier.
     · accounts with `email: null` — everyone who registered before email
       existed. Gating them would take away something they already had over a
       box they were never shown.
     · every account, when the server has no mailer — with RESEND_API_KEY unset
       nobody CAN confirm, so a gate would be a permanent lockout.

   The check reads the live account record, so store.markEmailVerified() lifts it
   the moment the link is opened. */
function gated(c) {
  if (!c || !c.userId) return false;              // guest
  if (!mail.configured()) return false;           // nothing could ever confirm it
  const u = store.getById(c.userId);
  if (!u || !u.email) return false;               // legacy username-only account
  return !u.emailVerified;
}

// What a rider looks like to someone who hasn't confirmed their address. The pin,
// the car and the movement all stay — this hides WHO, not WHERE, so the map is
// still a map and the restriction is legible rather than looking broken.
//
// KEPT ON PURPOSE: id, emoji, vibe, car, pos, heading, mode. Those are what the
// map draws; strip them and the layer looks broken rather than limited.
//
// This overrides named fields rather than picking from an allowlist, which means
// A NEW IDENTITY FIELD ON riderRecord() WOULD PASS THROUGH UNREDACTED. If you
// add one — a display title, a badge, a club tag — add it here too.
function anonymise(rec) {
  return Object.assign({}, rec, {
    name: 'Rider',
    handle: '',
    avatar: null,
    account: null,   // no username → no "add friend" either
    stats: null
  });
}

// `viewer` is the client this record is being sent TO. Omit it only where the
// record is not going straight to one client (the global snapshot), and redact
// at the send instead.
function riderRecord(r, viewer) {
  let rec;
  if (r.bot) {
    rec = {
      id: r.id, name: r.name, handle: r.handle, emoji: r.emoji, vibe: r.vibe,
      car: r.car, pos: r.pos, heading: r.heading, mode: r.mode, account: null, stats: null
    };
  } else {
    rec = {
      id: r.id, name: r.profile.name, handle: r.profile.handle, emoji: r.profile.emoji,
      avatar: r.profile.avatar || null, // profile photo (small data URL) — null keeps the glyph
      vibe: r.profile.vibe, car: r.profile.car, pos: r.pos, heading: r.heading, mode: r.mode,
      account: r.username || null, // username when this rider is signed in (enables "add friend")
      stats: r.stats || null       // dragy PBs + race win/run counters (null on guests/old records)
    };
  }
  return gated(viewer) ? anonymise(rec) : rec;
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

/* ================= proximity voice ================= */
// "Auto voice chat" — riders opted in (voice:prox) exchange walkie-talkie
// traffic with other opted-in riders around them, no convoy needed.
const VOICE_PROX_M = 4500;   // server envelope; the client filters the exact mode (radius/road/sight)
const VOICE_PROX_MAX = 10;   // nearest-N cap so a dense area can't fan audio out to everyone

// Everyone eligible to receive c's voice traffic right now: convoy members
// (always, unchanged behavior) plus, for opted-in riders, other opted-in
// riders within the proximity envelope. Ghost riders are invisible — they
// neither send nor receive proximity voice (convoy voice still works).
function voiceTargets(c) {
  const out = new Set();
  const party = c.party && parties.get(c.party);
  if (party) {
    for (const id of party.members) {
      if (id !== c.id && clients.has(id)) out.add(id);
    }
  }
  if (c.voiceProx && !c.ghost && c.pos) {
    const cand = [];
    for (const [id, other] of clients) {
      if (id === c.id || out.has(id)) continue;
      if (!other.voiceProx || other.ghost || !other.pos) continue;
      const d = B.haversine(c.pos, other.pos);
      if (d <= VOICE_PROX_M) cand.push({ id, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (let i = 0; i < cand.length && i < VOICE_PROX_MAX; i++) out.add(cand[i].id);
  }
  return out;
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
      send(c, { t: 'rider:add', rider: riderRecord(getRider(id), c) });
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
      send(c, { t: 'rider:add', rider: riderRecord(r, c) });
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
        members: lites, chat: party.chat.slice(-50),
        rally: party.rally || null
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
    chat: [],
    rally: null      // shared meetup pin: { lng, lat, label, by, byName, t }
  };
  parties.set(party.id, party);
  partyByCode.set(code, party);
  c.party = party.id;
  partySys(party, 'Convoy created — invite riders, or switch to “Code” to share a join code');
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

/* ================= races =================
   Open ad-hoc drag-race lobby (NOT convoy-gated). Helpers used by the race:*
   handlers above + the socket-close cleanup. Mirrors the party helpers' shape. */
function raceLite(r, id) {
  const c = clients.get(id);
  if (!c) return null;
  const res = r.results[id];
  return {
    id: c.id, name: riderName(c),
    emoji: c.profile.emoji, paint: c.profile.car.paint,
    ready: !!r.ready[id],
    finished: !!res,
    time: res ? res.time : null,
    trap: res ? res.trap : null,
    dnf: res ? !!res.dnf : false
  };
}
function sendRaceState(race) {
  const members = race.members.map((id) => raceLite(race, id)).filter(Boolean);
  for (const id of race.members) {
    const c = clients.get(id);
    if (!c) continue;
    send(c, {
      t: 'race:state',
      race: {
        id: race.id, modeId: race.modeId, host: race.host,
        status: race.status, startedAt: race.startedAt,
        isHost: race.host === c.id,
        members: members
      }
    });
  }
}
// True once every member has a result (a finish or a DNF).
function raceFinished(race) {
  for (const id of race.members) if (!race.results[id]) return false;
  return true;
}
// Resolve a race: mark anyone without a finish as DNF, credit the winner, broadcast.
function endRace(race) {
  if (race.status === 'finished') return;
  race.status = 'finished';
  // Mark no-shows as DNF. A DNF is still a race entered, so it counts as a run —
  // otherwise the denominator behind the win rate only ever includes finishers.
  for (const id of race.members) {
    if (race.results[id]) continue;
    race.results[id] = { time: null, trap: null, dnf: true };
    const dc = clients.get(id);
    if (dc && dc.userId) { dc.stats = store.recordRun(dc.userId); fanoutStat(dc, dc.stats); }
  }
  // Fastest legal time wins. Tally a win on the winner's user record.
  let winnerId = null, bestTime = Infinity;
  for (const id of race.members) {
    const r = race.results[id];
    if (!r.dnf && r.time != null && r.time < bestTime) { bestTime = r.time; winnerId = id; }
  }
  if (winnerId) {
    const wc = clients.get(winnerId);
    if (wc && wc.userId) { store.recordWin(wc.userId); wc.stats = store.getStats(wc.userId); fanoutStat(wc, wc.stats); }
  }
  sendRaceState(race);
  // Tear down after a short grace so clients can render the final leaderboard.
  const id = race.id;
  setTimeout(() => {
    const r = races.get(id);
    if (!r) return;
    for (const mid of r.members) { const mc = clients.get(mid); if (mc && mc.raceId === id) mc.raceId = null; }
    races.delete(id);
  }, 8000).unref();
}
// A racer leaves (or disconnects). DNF them if the race is running; if the host
// leaves mid-race, the race ends. `silent` suppresses the re-broadcast (used
// when the rider is mid-join into another race).
function leaveRace(c, silent) {
  const race = c.raceId && races.get(c.raceId);
  c.raceId = null;
  if (!race) return;
  const i = race.members.indexOf(c.id);
  if (i >= 0) race.members.splice(i, 1);
  delete race.ready[c.id];
  // If they finished already, keep their result; otherwise DNF them so the race
  // can still resolve (only meaningful while running).
  if (race.status === 'running' && !race.results[c.id]) {
    race.results[c.id] = { time: null, trap: null, dnf: true };
    // Bailing out mid-race is still a race entered — count the run so the win
    // rate isn't computed against finishers only.
    if (c.userId) c.stats = store.recordRun(c.userId);
  }
  const humanLeft = race.members.filter((id) => clients.has(id));
  if (!humanLeft.length) { races.delete(race.id); return; }
  // Host left mid-lobby → promote the next racer; mid-race → end the race.
  if (race.host === c.id) {
    if (race.status === 'lobby') { race.host = humanLeft[0]; }
    else { endRace(race); return; }
  }
  if (!silent) sendRaceState(race);
  if (raceFinished(race)) endRace(race);
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

// Fan a stats update (new dragy PB) to every client currently scoping this rider,
// so open profile views + the Nearby list update live. Mirrors the rider:update
// fanout in the `profile` handler.
// Re-send every rider a now-verified session already knows, un-anonymised, plus
// a fresh global feed. Without this the map keeps saying "Rider" until each pin
// happens to leave and re-enter scope — which for a parked rider is never, and
// looks exactly like the confirmation not having worked.
//
// Called from the /api/email/verify route, which is anonymous: the link is
// usually opened on a different device from the one running the map, so the
// socket being upgraded is not the caller's.
function liftGateFor(userId) {
  const c = online.get(userId);
  if (!c) return;                       // not currently connected; next hello is clean
  for (const id of c.known) {
    const r = getRider(id);
    if (r) send(c, { t: 'rider:add', rider: riderRecord(r, c) });   // same id → replaces
  }
  send(c, { t: 'global', fc: buildGlobalFC() });
  send(c, { t: 'verified' });           // the client drops its banner on this
}

function fanoutStat(c, stats) {
  const msg = { t: 'dragy:pb', id: c.id, stats: stats };
  // Built per recipient rather than once, because a viewer who has not confirmed
  // their email gets no stats at all — sending the shared message to everyone
  // would leak straight past the gate riderRecord() applies.
  const hidden = { t: 'dragy:pb', id: c.id, stats: null };
  for (const other of clients.values()) {
    if (other.known && other.known.has(c.id)) send(other, gated(other) ? hidden : msg);
  }
}

/* ================= message handlers ================= */
const handlers = {
  hello(c, m) {
    // Exactly once per socket. The dispatcher exempts 'hello' from the
    // "must say hello first" gate, which left it replayable without limit: each
    // replay re-ran recomputeHumans() + assignAnchors(), re-sent a full welcome
    // frame, and fired friend:status at every online friend.
    if (c.profile) return;
    let friendData = null;
    if (m.token) {
      const u = userFromToken(m.token);
      if (!u) { send(c, { t: 'auth:invalid' }); return; }
      c.userId = u.id;
      c.username = u.username;
      c.profile = u.profile;           // account profile is authoritative
      c.stats = u.stats || { pb: {} };  // dragy PBs + race counters (live profile view)
      // One session per account. The previous socket used to be left open and
      // still in `clients`, so the account showed up as two rider pins on every
      // nearby map until it happened to time out.
      const prev = online.get(u.id);
      if (prev && prev !== c) {
        send(prev, { t: 'err', msg: 'Signed in on another device' });
        try { prev.ws.close(); } catch (e) { /* already gone */ }
      }
      online.set(u.id, c);
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
      riders: [...c.known].map((id) => riderRecord(getRider(id), c)),
      // Anonymised here as well when the gate applies — this frame is the
      // rider's first sight of the global layer.
      global: gated(c) ? anonymiseGlobal(buildGlobalFC()) : buildGlobalFC()
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
    // Each profile update fans out to every client currently scoping this rider
    // AND queues a DB write, so an unthrottled sender multiplied one small
    // socket message into N broadcasts. Real profile edits are human-rare.
    const now = Date.now();
    if (now - (c.lastProfileAt || 0) < 2000) return;
    c.lastProfileAt = now;
    c.profile = sanitizeProfile(m.profile);
    if (c.userId) {
      c.profile.handle = c.username.toLowerCase();
      store.updateProfile(c.userId, c.profile); // persist account edits
    }
    const upd = { t: 'rider:update', id: c.id, profile: c.profile };
    // The anonymised twin: a rider renaming themselves must not become visible
    // to a viewer the gate is hiding names from.
    const hidden = { t: 'rider:update', id: c.id, profile: Object.assign({}, c.profile,
      { name: 'Rider', handle: '', avatar: null }) };
    for (const other of clients.values()) {
      if (other.known && other.known.has(c.id)) send(other, gated(other) ? hidden : upd);
    }
  },

  // Ghost Mode: the toggling rider goes invisible to non-convoy riders.
  ghost(c, m) {
    // Toggling recomputes scope against every other client (O(C×N) per message)
    // — throttle to human toggle cadence so it can't be spun as a CPU load.
    const now = Date.now();
    if (now - (c.lastGhostAt || 0) < 1000) return;
    c.lastGhostAt = now;
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

  // Rally point: any member drops (or clears) a shared meetup pin. Relayed to
  // the whole convoy through the normal party-state broadcast.
  'party:rally'(c, m) {
    const party = c.party && parties.get(c.party);
    if (!party) return send(c, { t: 'err', msg: 'Join a convoy first' });
    if (m.clear) {
      if (!party.rally) return;
      party.rally = null;
      partySys(party, riderName(c) + ' cleared the rally point');
      sendPartyState(party);
      return;
    }
    const pos = [m.lng, m.lat];
    if (!validPos(pos)) return;
    party.rally = {
      lng: m.lng, lat: m.lat,
      label: str(m.label, 60, 'Rally point'),
      by: c.id, byName: riderName(c), t: Date.now()
    };
    partySys(party, riderName(c) + ' set a rally point — ' + party.rally.label);
    sendPartyState(party);
  },

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
    // Only 'code' mode opens the convoy to anyone holding the code. 'invite' is
    // the DEFAULT and its UI says "Invite-only" — but this path used to reject
    // 'locked' alone, so two of the three modes behaved identically and an
    // invite-only convoy could be joined by code.
    if (party.mode !== 'code') return send(c, { t: 'err', msg: 'That convoy is invite-only' });
    if (!rateOk('join:' + c.ip, 20, 60 * 1000)) return send(c, { t: 'err', msg: 'Too many attempts — slow down' });
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
    // Delivered to the target as a toast; without a budget one socket could
    // spam a victim's screen at line rate. 20/min is far past human waving.
    if (!rateOk('wave:' + c.id, 20, 60 * 1000)) return;
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

  // Walkie-talkie signaling: relay WebRTC SDP/ICE between voice peers — convoy
  // members plus, when both sides opted into proximity voice, riders in range.
  'voice:signal'(c, m) {
    // Rate: signaling is bursty but tiny in volume (SDP once + a handful of
    // ICE per peer). Without a budget a convoy member could push 16KB frames
    // at line rate into ONE targeted peer (payload.to routing) — mobile-data
    // drain and a frozen WebView. 40/5s ≈ 8/s is far above real WebRTC cadence.
    if (!rateOk('sig:' + c.id, 40, 5000)) return;
    // Payload must be reasonably small (SDP + a few ICE candidates). Cap to avoid abuse.
    const payload = m.payload;
    if (payload == null || JSON.stringify(payload).length > 16384) return;
    const targets = voiceTargets(c);
    if (!targets.size) return;
    // SDP/ICE is addressed to ONE peer (payload.to). Broadcasting it to the whole
    // party made every member apply offers meant for someone else, cross-wiring
    // the mesh in any convoy of 3+. Route to the target only; fall back to the
    // old broadcast just for payloads without a target.
    const to = typeof payload.to === 'string' ? payload.to : null;
    for (const id of targets) {
      if (to && id !== to) continue;
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:signal', from: c.id, payload });
    }
  },

  // Audio relay fallback (when P2P fails): fan a chunk out to voice peers.
  'voice:relay'(c, m) {
    if (!c.micActive) return;
    const chunk = m.chunk;
    if (typeof chunk !== 'string' || chunk.length > 8192) return; // base64 PCM, capped
    if (!rateOk('voice:' + c.ip, VOICE_RELAY_BUDGET, 60 * 1000)) return;
    const rate = num(m.rate, 0, 192000, 0); // effective sample rate the sender encoded at
    for (const id of voiceTargets(c)) {
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:relay', from: c.id, chunk, rate });
    }
  },

  // Announce mic state so convoy/proximity UI can show who's speaking.
  'voice:mic'(c, m) {
    // Relayed to every voice peer per message — bound it to toggle cadence.
    const now = Date.now();
    if (now - (c.lastMicAt || 0) < 1000) return;
    c.lastMicAt = now;
    c.micActive = !!m.on;
    for (const id of voiceTargets(c)) {
      const tc = clients.get(id);
      if (tc) send(tc, { t: 'voice:mic', from: c.id, on: c.micActive, name: c.profile.name });
    }
  },

  // Proximity-voice opt-in ("auto voice chat"). Stored as a flag — the exact
  // mode geometry (radius / road corridor / field of view) is enforced client-
  // side; the server only relays inside the VOICE_PROX_M envelope and only
  // between riders who BOTH opted in.
  'voice:prox'(c, m) {
    const mode = ['radius', 'road', 'sight'].indexOf(m.mode) >= 0 ? m.mode : null;
    c.voiceProx = mode;
  },

  // A rider set a new dragy personal best (reported over the socket so live
  // profile views of this rider update without a reload). Auth'd riders only —
  // guests have no server-side stats. The authoritative path is /api/dragy/pb,
  // but this lets a pure-WS client (e.g. the native shell) push a PB too.
  'dragy:pb'(c, m) {
    if (!c.userId) return;
    // Same per-IP budget as the /api/dragy/pb path: every accepted update can
    // queue a DB write + fan out to viewers, so it must not be spinnable.
    if (!rateOk('wspb:' + c.ip, 30, 60 * 1000)) return;
    const DRAGY_MODES = ['0-60', '0-100k', '0-30', '0-100', '60-130', '100-200k', 'eighth', 'quarter'];
    const modeId = str(m && m.modeId, 16, '');
    if (DRAGY_MODES.indexOf(modeId) < 0) return;
    const time = Number(m && m.time);
    const trap = m && m.trap != null ? Number(m.trap) : null;
    if (!Number.isFinite(time) || time <= 0 || time > 600) return;
    if (trap != null && (!Number.isFinite(trap) || trap < 0)) return;
    const stats = store.recordPB(c.userId, modeId, time, trap == null ? null : trap);
    c.stats = stats;
    fanoutStat(c, stats);
  },

  /* ----- drag races (open lobby, any nearby rider) ----- */
  'race:create'(c, m) {
    if (!c.pos) return send(c, { t: 'err', msg: 'Set your location first' });
    const modeId = str(m && m.modeId, 16, '');
    if (RACE_DRAGY_MODES.indexOf(modeId) < 0) return send(c, { t: 'err', msg: 'Pick a race type' });
    if (c.raceId) leaveRace(c, true); // one race at a time
    const race = {
      id: 'r' + crypto.randomBytes(4).toString('hex'),
      modeId: modeId,
      host: c.id,
      status: 'lobby',           // lobby | countdown | running | finished
      startedAt: 0,
      members: [c.id],           // rider ids
      ready: {},                 // id -> bool
      results: {},               // id -> { time, trap, dnf }  (filled on finish)
      createdAt: Date.now()
    };
    races.set(race.id, race);
    c.raceId = race.id;
    race.ready[c.id] = false;
    sendRaceState(race);
  },

  'race:join'(c, m) {
    if (!c.pos) return send(c, { t: 'err', msg: 'Set your location first' });
    const race = races.get(str(m && m.id, 40));
    if (!race) return send(c, { t: 'err', msg: 'That race is gone' });
    if (race.status !== 'lobby') return send(c, { t: 'err', msg: 'Race already started' });
    if (race.members.length >= RACE_MAX) return send(c, { t: 'err', msg: 'Race is full' });
    // Proximity gate: only nearby riders can join (mirrors crowd:report scoping).
    const host = getRider(race.host);
    if (host && host.pos && B.haversine(c.pos, host.pos) > NEARBY_KM * 1000) {
      return send(c, { t: 'err', msg: 'Too far to race — move closer to the host' });
    }
    if (c.raceId) leaveRace(c, true);
    race.members.push(c.id);
    race.ready[c.id] = false;
    c.raceId = race.id;
    sendRaceState(race);
  },

  'race:ready'(c, m) {
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.status !== 'lobby') return;
    // Each flip re-broadcasts state to every member; throttle to UI toggle
    // cadence so it can't be spun as an amplification flood.
    const now = Date.now();
    if (now - (c.lastReadyAt || 0) < 500) return;
    c.lastReadyAt = now;
    race.ready[c.id] = !!m.on;
    sendRaceState(race);
  },

  // Host starts the race. Server mints startedAt and broadcasts a countdown;
  // everyone arms their own RaceTimer from their real GPS. A 3s countdown gives
  // racers a fair同步 launch (everyone goes green together).
  'race:start'(c, m) {
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.host !== c.id) return;
    if (race.status !== 'lobby') return;
    if (race.members.length < 2) return send(c, { t: 'err', msg: 'Need at least 2 racers' });
    race.status = 'countdown';
    race.startedAt = Date.now() + 3000; // green light in 3s
    sendRaceState(race);
    // Flip to running at green. Each racer's client arms on 'running'.
    const id = race.id;
    setTimeout(() => {
      const r = races.get(id);
      if (!r || r.status !== 'countdown') return;
      r.status = 'running';
      sendRaceState(r);
    }, 3000).unref();
  },

  // Live GPS relay during a race (~10Hz, only while running). Bounded + rate-
  // limited so it can't be abused out of a race.
  'race:fix'(c, m) {
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.status !== 'running') return;
    if (!rateOk('racefix:' + c.id, RACE_FIX_BUDGET, 60 * 1000) ||
        !rateOk('racefixip:' + c.ip, RACE_FIX_IP_BUDGET, 60 * 1000)) return;
    const pos = [m && m.lng, m && m.lat];
    if (!validPos(pos)) return;
    const payload = {
      t: 'race:fix', from: c.id,
      lng: m.lng, lat: m.lat,
      speed: num(m && m.speed, 0, 250, null),   // m/s, may be null
      heading: num(m && m.heading, 0, 360, null),
      acc: num(m && m.acc, 0, 5000, null),
      // Coerce: m.ts arrives unvalidated and is relayed verbatim — a non-number
      // (object/array) would ride the 64KB frame out to every race peer.
      ts: Number.isFinite(Number(m && m.ts)) ? Number(m.ts) : Date.now()
    };
    for (const id of race.members) {
      if (id === c.id) continue;
      const tc = clients.get(id);
      if (tc) send(tc, payload);
    }
  },

  // A racer finished (their local RaceTimer crossed the target). Server records
  // the result; when everyone's in, the race ends and results are broadcast.
  'race:finish'(c, m) {
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.status !== 'running') return;
    if (race.results[c.id]) return; // already finished
    const time = Number(m && m.time);
    const trap = m && m.trap != null ? Number(m.trap) : null;
    if (!Number.isFinite(time) || time <= 0 || time > 600) return;
    race.results[c.id] = { time: time, trap: trap != null && Number.isFinite(trap) ? trap : null, dnf: false };
    // Tally a race stat on the user record (auth'd riders only) + a win for the
    // fastest finisher once the race resolves.
    if (c.userId) c.stats = store.recordRun(c.userId);
    sendRaceState(race);
    if (raceFinished(race)) endRace(race);
  },

  'race:leave'(c) {
    if (c.raceId) leaveRace(c, false);
  },

  // Host invited a specific rider to their race (from the profile "Challenge"
  // button). Relay an invite toast to that rider with the race id so they can
  // join. Validates the sender actually owns the race + the target is nearby.
  'race:invite'(c, m) {
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.host !== c.id) return;
    const target = getRider(str(m && m.to, 40));
    if (!target || !target.pos || !c.pos) return;
    if (B.haversine(c.pos, target.pos) > NEARBY_KM * 1000) {
      return send(c, { t: 'err', msg: 'Too far to challenge — move closer' });
    }
    send(target, {
      t: 'race:invite',
      from: c.id, fromName: riderName(c),
      raceId: race.id, modeId: race.modeId
    });
  },

  'race:end'(c) {
    // Host can end a not-yet-finished race early (e.g. someone won't stage).
    const race = c.raceId && races.get(c.raceId);
    if (!race || race.host !== c.id) return;
    endRace(race);
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
    // Proximity gate. The BROADCAST below is already scoped to riders near the
    // report, but hotspots.record() ran unconditionally — so one client could
    // walk the globe writing permanent police observations into the probability
    // model that every user's map reads from. You can only report what you can
    // see, so the pin has to be near where you actually are.
    if (!c.pos || B.haversine(c.pos, pos) > REPORT_MAX_M) {
      return send(c, { t: 'err', msg: 'You can only report what’s near you' });
    }
    // Per-IP throttle so one source can't flood the area. Reuses the auth/window
    // rate limiter; a 60s budget is generous for genuine reporting cadence.
    if (!rateOk('report:' + c.ip, 20, 60 * 1000)) return send(c, { t: 'err', msg: 'Too many reports — slow down' });
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
    // Ghost Mode hides a rider from EVERYONE except their own convoy — and the
    // global feed goes to everyone, so ghosted riders must not be snapshotted.
    // (Nearby visibility is handled per-viewer in scopeFor; this is the global half.)
    if (r.ghost) continue;
    const rec = riderRecord(r);
    items.push({
      id: r.id, // server-side only (never serialized to clients) — lets buildGlobalFC drop riders who ghost AFTER this snapshot was taken
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

// Privacy jitter for the global layer: dots are offset ~100-400m so the feed
// never exposes an exact position. The offset is DERIVED from the rider's name
// (stable across rebuilds) — a fresh random one per build made every dot dance
// a few hundred meters on each 45s refresh.
function globalJitter(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return { bearing: (h >>> 3) % 360, dist: 100 + ((h >>> 11) % 300) };
}

// Strip names from a global-feed collection. Positions, cars and cities stay:
// the layer is still a map of who is out there, just not of who they are.
function anonymiseGlobal(fc) {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => Object.assign({}, f, {
      properties: Object.assign({}, f.properties, { name: 'Rider' })
    }))
  };
}

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
  // the real (delayed) layer: only a snapshot at least GLOBAL_DELAY_MS old.
  // The old `else the oldest we have` fallback served near-real-time positions
  // for the first GLOBAL_DELAY_MS after every boot — exactly the window where
  // the privacy delay exists to protect. An empty layer for a few minutes
  // after a restart is the correct behaviour, not a regression.
  let snap = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (Date.now() - snapshots[i].t >= GLOBAL_DELAY_MS) { snap = snapshots[i]; break; }
  }
  if (snap) {
    const seenMin = Math.max(1, Math.round((Date.now() - snap.t) / 60000));
    for (const it of snap.items) {
      // The feed is delayed, so a rider can ghost AFTER this snapshot was taken —
      // honor their CURRENT ghost state, not the one from capture time.
      const liveClient = it.id ? clients.get(it.id) : null;
      if (liveClient && liveClient.ghost) continue;
      const jit = globalJitter(it.name);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: B.destPoint(it.pos, jit.bearing, jit.dist) },
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
  // Serialized once and sent as a raw string rather than JSON.stringify'd per
  // client every 45s. TWO strings now, not one: the delayed global layer carries
  // names, so a viewer who has not confirmed their email gets the anonymised
  // variant. Still two serializations for any number of clients.
  const fc = buildGlobalFC();
  const raw = JSON.stringify({ t: 'global', fc: fc });
  let rawHidden = null;
  for (const c of humans()) {
    if (!gated(c)) { sendRaw(c, raw); continue; }
    if (rawHidden === null) rawHidden = JSON.stringify({ t: 'global', fc: anonymiseGlobal(fc) });
    sendRaw(c, rawHidden);
  }
}, 45000);

/* ================= static file server ================= */
const ROOT = path.resolve(__dirname, '..');
// Explicit allowlist of top-level paths that may be served. Anything else 404s.
// (Formerly a denylist, which silently served any new file added at the repo root —
// a path-traversal-class bug waiting for the next config/backup file to land here.)
const ALLOWED_TOP = ['/', '/index.html', '/js', '/css', '/legal', '/convoy.apk'];

/* ---- legal pages ----
   Served at clean, stable, linkable paths because other people's rules point at
   them: Google Play's Data Safety form wants a privacy-policy URL and a
   *separate* account-deletion URL reachable WITHOUT installing the app, and the
   in-app consent gate links to /terms and /privacy by these exact names. Keep
   these paths stable — a store listing points at them, and a 404 here is a
   policy violation, not a broken link. */
const LEGAL_PAGES = {
  '/privacy': 'legal/privacy.html',
  '/privacy.html': 'legal/privacy.html',
  '/terms': 'legal/terms.html',
  '/terms.html': 'legal/terms.html',
  '/notices': 'legal/notices.html',
  '/licenses': 'legal/notices.html',
  '/delete-account': 'legal/delete-account.html',
  '/account-deletion': 'legal/delete-account.html'
};

/* ---- Android App Links ----
   Serving /.well-known/assetlinks.json is what lets the APK claim the /l/…
   links Convoy emails, instead of them opening in a browser. Android only
   honours the claim if the certificate the installed APK is signed with appears
   below, so this has to list every signing identity in play.

   The default is the release keystore in android/. If the app is distributed
   through Google Play with Play App Signing, Play RE-SIGNS the upload — and it
   is PLAY's fingerprint the installed app carries, not this one. Set
   ANDROID_CERT_SHA256 to a comma list covering both (Play Console → Setup →
   App integrity → App signing key certificate), or links will open in the
   browser for every Play install while working fine for a sideloaded APK. */
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'tech.odoreeci.convoy';
const ANDROID_FINGERPRINTS = (process.env.ANDROID_CERT_SHA256 ||
  '0F:B0:BB:9D:6D:99:D0:40:E2:C7:3C:44:AF:96:90:F6:C2:63:76:C6:EB:23:FB:8B:D5:02:00:B9:21:4D:1E:08')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
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
  if (!rateOk('tts:' + ip, TTS_RATE_MAX, TTS_RATE_WINDOW)) return false;
  const n = ttsInflightByIp.get(ip) || 0;
  if (n >= 2) return false; // max 2 concurrent synth per source
  ttsInflightByIp.set(ip, n + 1);
  return true;
}
function ttsRelease(ip) {
  const n = (ttsInflightByIp.get(ip) || 1) - 1;
  if (n <= 0) ttsInflightByIp.delete(ip); else ttsInflightByIp.set(ip, n);
}

// Set CSP='' to disable (e.g. while debugging a blocked resource).
const CSP = process.env.CSP !== undefined ? process.env.CSP : [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // maplibre-gl + tfjs/nsfwjs (jsDelivr); wasm-unsafe-eval is required by tfjs.
  "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",              // maplibre spawns blob workers
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",    // basemap raster tiles + avatar data URLs
  "media-src 'self' blob: https:",        // scanner audio + /api/tts
  "connect-src 'self' blob: data: https: wss:"
].join('; ');

const httpServer = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end(); return; }

  // Set CORS as response defaults up front so EVERY response carries them —
  // including the bare res.writeHead(4xx/5xx) error paths below. Without this the
  // native WebView blocks the app from reading rate-limit / upstream-error bodies
  // (and a failed traffic/police tile poisons the layer). writeHead() still wins
  // for any header it sets explicitly, so the per-response CORS_HEADERS merges stay
  // harmless duplicates of the same values.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Baseline security headers on EVERY response (the API + the static app).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Only the app itself uses geolocation (rider pins) and the microphone
  // (walkie-talkie); everything else powerful is off. Blocks a stray iframe
  // or embedded context from ever prompting for them.
  res.setHeader('Permissions-Policy',
    'geolocation=(self), microphone=(self), camera=(), payment=(), usb=(), bluetooth=(), midi=(), serial=()');
  // Caddy terminates TLS in front of us; announce HSTS from here so it survives
  // a proxy config that forgets to add it.
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

  // CSP for the app shell. The allowlist mirrors what the client actually loads
  // today — the map library and the NSFW model come from jsDelivr, fonts from
  // Google, and the map/traffic/weather/scanner layers talk to a fixed set of
  // APIs. Note there is no 'unsafe-inline' for script-src: index.html has no
  // inline <script>, so nothing needs it. Inline STYLE attributes are used
  // throughout (paint swatches, marker sizing), hence 'unsafe-inline' there.
  // Vendoring maplibre + tfjs locally would let script-src collapse to 'self'.
  if (CSP) res.setHeader('Content-Security-Policy', CSP);

  // CORS preflight — the native app POSTs JSON cross-origin, which the WebView
  // gates behind an OPTIONS preflight. Answer it for every path with the CORS
  // headers so the real request is allowed to proceed.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  // Neural TTS (binary audio, so handled before the JSON /api router).
  if (urlPath === '/api/tts/health') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS_HEADERS));
    res.end(JSON.stringify({ ok: ttsReady() }));
    return;
  }
  if (urlPath === '/api/tts') {
    if (!ttsReady()) { res.writeHead(503); res.end('tts unavailable'); return; }
    const ip = clientIp(req);
    if (!ttsRateOk(ip)) { res.writeHead(429); res.end('tts rate limited'); return; }
    var text = '';
    try { text = (new URLSearchParams(req.url.split('?')[1] || '').get('text') || '').slice(0, TTS_MAX_LEN).trim(); }
    catch (e) { text = ''; }
    if (!text) { ttsRelease(ip); res.writeHead(400); res.end('no text'); return; }
    ttsSynth(text, function (err, buf) {
      ttsRelease(ip);
      if (err || !buf) { res.writeHead(503); res.end('synth failed'); return; }
      res.writeHead(200, Object.assign({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' }, CORS_HEADERS));
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
    // Bounds-check BEFORE spending quota: any z/x/y the regex admits goes
    // straight into the upstream URL, and a garbage tile still burns one of the
    // ~2,500 free calls/day. x,y must be < 2^z; z > 22 doesn't exist anywhere.
    const tz = +traffic[1], tx = +traffic[2], ty = +traffic[3];
    if (tz > 22 || tx >= (1 << tz) || ty >= (1 << tz)) { res.writeHead(400); res.end('bad tile'); return; }
    const ip = clientIp(req);
    // Flow tiles are fetched per visible tile, so the budget is generous per window;
    // the cap is mainly to stop an abusive client from burning the TomTom quota.
    if (!tomtom.hasKey()) { res.writeHead(503); res.end('traffic unavailable'); return; }
    if (!rateOk('tile:' + ip, 300, 60 * 1000)) { res.writeHead(429); res.end('rate limited'); return; }
    tomtom.tile(traffic[1], traffic[2], traffic[3], (err, status, headers, buf) => {
      if (err || !buf || status !== 200) { res.writeHead(502); res.end('upstream'); return; }
      res.writeHead(200, Object.assign({
        'Content-Type': headers['Content-Type'] || 'image/png',
        // 90s — matches the client's TRAFFIC_REFRESH_MS so a cache-busted tile URL
        // actually reaches TomTom fresh on the next refresh, instead of being served
        // from an intermediate/browser cache that would mask live flow changes.
        'Cache-Control': 'public, max-age=90'
      }, CORS_HEADERS));   // WebGL textures (MapLibre raster tiles) require CORS cross-origin
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

  /* ---- Android App Links: the digital asset link statement ----
     This is what makes Android open /l/… links in the APK instead of the
     browser. The OS fetches it once at install time (and periodically after),
     and will only hand the app a link if the certificate the APK is signed with
     is listed here. A fingerprint is a PUBLIC value — it is the hash of a
     certificate, not a key — and publishing it is the entire point.

     Served from code rather than as a static file so the operator can add the
     Play App Signing fingerprint through the environment without a redeploy of
     the app tree. With no fingerprints configured this 404s, which fails
     verification loudly rather than serving a statement that claims nothing. */
  if (urlPath === '/.well-known/assetlinks.json') {
    if (!ANDROID_FINGERPRINTS.length) { res.writeHead(404); res.end('Not found'); return; }
    const body = JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: ANDROID_FINGERPRINTS
      }
    }]);
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json',
      // Android re-checks periodically; an hour keeps a fingerprint change (a
      // new upload key, adding Play App Signing) from taking a day to land.
      'Cache-Control': 'public, max-age=3600'
    }, CORS_HEADERS));
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  /* ---- mailed links ----
     Every link Convoy emails points at /l/<kind>?token=… rather than at the
     root with a query. That is not cosmetic: Android App Links match on PATH
     ONLY — query strings are ignored for matching — so a link shaped
     "/?cv=reset&token=…" could only be claimed by claiming "/", which would
     hand the app every link to the website, including the APK download.
     A path prefix keeps the claim to exactly these four links.

     In a browser (no app installed, or a desktop) this redirects to the query
     form the app already knows how to read at boot. Android intercepts the
     original URL before any of this runs, so the redirect only ever serves the
     people who don't have the app. */
  const mailed = urlPath.match(/^\/l\/(reset|verify|magic|change)$/);
  if (mailed) {
    // Re-encoded rather than passed through: whatever arrives goes straight back
    // out in a Location header, and a raw copy would let a crafted token inject
    // further parameters (or a header break) into the URL the browser follows.
    const token = new URLSearchParams(req.url.split('?')[1] || '').get('token') || '';
    res.writeHead(302, {
      Location: '/?cv=' + mailed[1] + '&token=' + encodeURIComponent(token.slice(0, 200)),
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }

  // Legal pages, before the allowlist: /privacy and /terms are the URLs the
  // consent gate, the store listing and the emails all point at, and they must
  // resolve whether or not the file layout under legal/ ever changes.
  if (Object.prototype.hasOwnProperty.call(LEGAL_PAGES, urlPath)) {
    urlPath = '/' + LEGAL_PAGES[urlPath];
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
// 64KB: the client's hello/profile frames now include the profile photo
// (≤24KB base64). The old 8KB cap would hard-kill any socket that sent one.
const wss = new WebSocketServer({
  server: httpServer, path: '/ws', maxPayload: 65536,
  // WebSockets are NOT gated by CORS — a browser page on ANY origin can open
  // one and drive the full guest realtime API (rider pins, chat fan-out,
  // party traffic). MAX_CLIENTS/MAX_PER_IP blunt the volume, but a hostile
  // page shouldn't get sockets at all. Non-browser clients (the native app,
  // scripts, tests) send no Origin header and are always allowed; browsers
  // must be on one of our own origins:
  //   - the deployed site (+ any extra hosts listed in WS_ORIGINS)
  //   - localhost / 127.0.0.1 on any port/scheme (dev server, Capacitor's
  //     https://localhost WebView origin)
  verifyClient: wsOriginOk
});

// WS_ORIGINS: extra browser hosts allowed to open /ws. Pre-seeded with the
// deployment's own domain so the shipped config keeps the site working; add a
// comma list to open more (e.g. a second domain or a preview deploy).
const WS_EXTRA_ORIGINS = (process.env.WS_ORIGINS || 'odoreeci.tech,www.odoreeci.tech')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function wsOriginOk(info, cb) {
  const origin = info.req && info.req.headers.origin;
  if (!origin) return cb(true);                       // native / non-browser client
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); }
  catch (e) { return cb(false, 403, 'bad origin'); }
  const ok = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    WS_EXTRA_ORIGINS.indexOf(host) >= 0;
  if (!ok) return cb(false, 403, 'origin not allowed');
  cb(true);
}

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    try { ws.send(JSON.stringify({ t: 'err', msg: 'Server is full' })); } catch (e) { }
    ws.close();
    return;
  }
  const c = {
    id: 'u' + crypto.randomBytes(5).toString('hex'),
    ws,
    ip: clientIp(req),
    userId: null,
    username: null,
    profile: null,
    pos: null,
    heading: 0,
    mode: 'cruise',
    party: null,
    raceId: null,            // active drag race (ad-hoc lobby), if any
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
    // Own properties only, and only callables: m.t comes off the wire, and a
    // bare lookup would hand back inherited Object.prototype members
    // ('constructor', 'toString', …) as if they were message handlers.
    const h = Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : null;
    if (typeof h === 'function') {
      try { h(c, m); } catch (e) { console.error('[handler ' + m.t + ']', e.message); }
    }
  });
  ws.on('close', () => {
    if (c.party) leaveParty(c, false);
    if (c.raceId) leaveRace(c, false);
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

/* ================= boot =================
   Accounts and identity both live in Supabase now, so the server must not start
   serving until it has (a) a working Postgres connection and the account set in
   memory, and (b) the JWKS needed to verify access tokens. Coming up without
   either would mean every sign-in 500s and every existing session is rejected —
   a loud failed boot is far better than a server that looks healthy and isn't. */
(async function boot() {
  if (!sb.configured()) {
    console.error('[boot] Supabase Auth is not configured.');
    console.error('[boot] Set SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env (see .env.example).');
    process.exit(1);
  }
  try {
    await store.init();
  } catch (e) {
    console.error('[boot] could not reach the Supabase database: ' + e.message);
    console.error('[boot] Check SUPABASE_DB_URL in server/.env.');
    process.exit(1);
  }
  // Without a key set, verify() rejects EVERY access token: the server would
  // come up looking healthy while silently logging out the entire user base and
  // 401-ing every request until a later refresh happened to succeed. The comment
  // above has always said this is a boot requirement — enforce it.
  if (!await sb.loadJwks(true)) {
    console.error('[boot] could not load the Supabase JWKS — every access token would be');
    console.error('[boot] rejected, i.e. every signed-in rider silently logged out.');
    console.error('[boot] Check SUPABASE_URL and outbound network access, then restart.');
    process.exit(1);
  }
  // Supabase caches the JWKS endpoint for 10 minutes and warns against holding
  // it longer, or a revoked signing key stays trusted here. Match that cadence.
  setInterval(() => sb.loadJwks(false), 10 * 60 * 1000).unref();

  // Social sign-in needs the dashboard half too, and nothing in this repo can
  // set it. Read the project's settings once at boot so a provider that is
  // listed here but switched OFF upstream is reported HERE — instead of the
  // rider discovering it as a raw GoTrue error page mid sign-in.
  if (oauth.enabled().length) {
    await sb.loadSettings(true);
    const dead = oauth.misconfigured();
    const live = oauth.liveEnabled();
    if (dead.length) {
      console.warn('[boot] OAUTH_PROVIDERS lists ' + dead.join(', ') + ', but Supabase Auth does');
      console.warn('[boot]   NOT have ' + (dead.length > 1 ? 'them' : 'it') + ' enabled. Those buttons are hidden.');
      console.warn('[boot]   Fix: Dashboard → Authentication → Providers → enable + add the client');
      console.warn('[boot]   ID/secret, and set the redirect URI in the provider\'s own console to');
      console.warn('[boot]   ' + sb.url + '/auth/v1/callback');
    }
    console.log('[boot] social sign-in: ' + (live.length ? live.join(', ') : 'none available'));
  }
  // Providers can be switched on in the dashboard without restarting us.
  setInterval(() => sb.loadSettings(false), 10 * 60 * 1000).unref();

  if (sb.forwardsIp()) {
    console.log('[boot] forwarding client IPs to Supabase Auth (Sb-Forwarded-For).');
    console.log('[boot]   Requires "IP Address Forwarding" ON: Dashboard → Authentication → Rate Limits.');
  } else {
    console.warn('[boot] NOT forwarding client IPs to Supabase Auth — every sign-in and every');
    console.warn('[boot]   token refresh shares ONE per-IP rate-limit bucket (capacity 30).');
    console.warn('[boot]   Needs a modern sb_secret_… key; see SUPABASE_FORWARD_IP in .env.example.');
  }

  httpServer.listen(PORT, () => {
    console.log(`Convoy server → http://localhost:${PORT}  (ws: /ws, bots: ${BOT_COUNT}, nearby: ${NEARBY_KM}km)`);
  });
  // Slowloris bounds. MAX_CLIENTS/MAX_PER_IP gate only the /ws upgrade — plain
  // HTTP sockets had nothing but Node's 5-minute default requestTimeout, so a
  // few hundred POSTs with Content-Length set and no body pinned every socket
  // until EMFILE, which also kills WS acceptance. 20s is far beyond the time
  // any legitimate client needs to deliver a ≤48KB body.
  httpServer.headersTimeout = 12000;
  httpServer.requestTimeout = 20000;
  httpServer.keepAliveTimeout = 15000;
})();

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
  httpServer.close(async () => {
    // AWAIT these. store.flush()/hotspots.flush() are async, and firing them
    // un-awaited immediately before process.exit(0) meant the write never ran —
    // and the process-'exit' flushSync fallback couldn't cover for it either.
    // Net effect: every account, password change and PB from the last ~800ms
    // before a restart was silently discarded.
    try { await store.flush(); } catch (e) { console.error('[shutdown] store flush:', e.message); }
    try { await hotspots.flush(); } catch (e) { console.error('[shutdown] hotspots flush:', e.message); }
    // Close the pool only AFTER the queued writes have drained, or the drain
    // fails on a dead pool and the last few mutations are lost.
    try { await store.close(); } catch (e) { console.error('[shutdown] db close:', e.message); }
    console.log('[shutdown] done.');
    process.exit(0);
  });
  // Safety net: if something hangs the drain, force-exit after 5s.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
