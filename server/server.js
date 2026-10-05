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
// before the local requires below — tomtom.js captures its key from
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
const tomtom = require('./tomtom');
const telemetry = require('./telemetry');
const ota = require('./ota');
const flags = require('./flags');
const audit = require('./audit');
const admin = require('./admin');
const packs = require('./packs');   // feature packs: served only to accounts that unlocked them
const packcodes = require('./packcodes');
const db = require('./db');          // handed to packs through packCtx only
const play = require('./play');
const httpcache = require('./httpcache');
const wiregate = require('./wiregate');

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

/* ---- anonymous credential routes: two tiers, on purpose (server-017) ----
   One shared per-IP bucket used to gate all eleven routes, so 24 fat-fingered
   logins from one carrier-NAT address took /api/recover away from everyone
   behind it — the exact route the locked-out rider needs next. It was also
   charged BEFORE readBody(), so a malformed or oversized body burned a login
   attempt.

   Splitting it, rather than moving the charge, keeps the property that made
   the pre-body ordering right in the first place: a flooder still cannot make
   this process read bodies. The flood tier is per IP across all eleven routes
   and is sized ABOVE the sum of the attempt budgets by construction (asserted
   in test/serverpolicy.test.js group Y1), so it can only ever bind on traffic
   that never produced a well-formed body — which is the only thing it is for.

   Null prototype: the lookup key is a URL path, so no inherited key is
   reachable — but a table with nothing to inherit needs no argument.

   Charged per well-formed attempt, not per failure: reading the handler's
   outcome would mean threading it back out of eleven code paths, and an
   unbounded stream of SUCCESSFUL anonymous auth calls is not a thing we
   want either. The per-identity buckets (login:<ident> &c., in the route
   handlers) are the tight, outcome-aware control and are untouched. */
const ANON_AUTH_BUDGET = Object.assign(Object.create(null), {
  '/api/login': 24,                  // unchanged from the old shared limit — the route people actually mistype
  '/api/register': 12,
  '/api/recover': 12,
  '/api/forgot': 12,
  '/api/reset': 12,
  '/api/magic': 12,
  '/api/magic/consume': 24,
  '/api/email/verify': 24,
  '/api/email/change/confirm': 24,
  '/api/oauth/start': 24,
  '/api/oauth/callback': 24
});
const ANON_AUTH_ROUTES = Object.keys(ANON_AUTH_BUDGET);   // derived: the two cannot drift
const AUTH_FLOOD_MAX = 240;          // >= sum of the table (204); see test/serverpolicy.test.js Y1 check 8

/* ================= crash reporting + analytics ================= */
// Diagnostics are ON by default: shipping a beta with no crash reporter means
// learning about launch-day crashes from the review section, days late, with no
// stack traces. Set TELEMETRY=0 to refuse every report at the door (the client
// keeps its own per-rider opt-out either way).
const TELEMETRY_ON = process.env.TELEMETRY !== '0';
// Bearer secret for GET /api/telemetry/stats. Unset = the dashboard endpoint
// does not exist at all, which is the right default for a public server.
const TELEMETRY_TOKEN = process.env.TELEMETRY_TOKEN || '';

// Constant-time string compare for bearer secrets. Buffer lengths differing is
// itself a (harmless) leak, but timingSafeEqual THROWS on a length mismatch, so
// the guard has to come first.
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

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

// Free text that other riders' screens render — profile name, vibe, garage
// entries, convoy titles — is character-ALLOWLISTED here, at the data layer,
// so the invariant holds no matter which door the string walks through
// (register, /api/profile, the ws profile push, anything added later). str()
// above only trims and truncates: right for shape, wrong for content — a
// 21-char name fits its cap and still carries a whole <svg onload=…> payload.
// This check existed as an endpoint-level rejection, got lost in a refactor,
// and a pen-test round caught the gap; it lives HERE now so it cannot be
// walked around, with the doors (/api/register, /api/profile) additionally
// answering 400 "Bad request" so honest clients get feedback, not silent
// stripping.
//
// The classes: letters/marks/numbers in any script; emoji with their joiners
// and modifiers (\p{So}\p{Sk}\u200D\uFE0F — 👨‍👩‍👧 and 👍🏽 must survive intact);
// spaces; and the punctuation a name plausibly wants. What is deliberately
// NOT in the set is the markup skeleton: < > " = ` ; : \ { } [ ] | ^ @ $ % —
// text that cannot contain them cannot become a tag, break out of an
// attribute, or start a formula, no matter which client (or old APK bundle)
// misses an escape someday. sanitizeEmoji below is the same idea, tighter.
const TEXT_ALLOW = "\\p{L}\\p{M}\\p{N}\\p{So}\\p{Sk}\\p{Zs}\\u200D\\uFE0F.,'\\u2019()\\-_!?&/+*#~\\u00B0\\u00A7";
// "Bad" = anything outside the allowlist, PLUS two carve-outs: ^ and ` are
// \p{Sk} (modifier symbols), so the allowlist class alone would wave them
// through — and they are the classic template-literal/attribute-context
// troublemakers. Alternation, not a class, because the outside-the-set half
// is already a negated class.
const TEXT_BAD = new RegExp('(?:[\\^`]|[^' + TEXT_ALLOW + '])', 'u');
// Same pattern, global — cleanText replaces EVERY offender, not just the
// first (a non-global replace leaves char 2..n of a payload armed, which a
// round of pen-testing caught immediately).
const TEXT_STRIP = new RegExp('(?:[\\^`]|[^' + TEXT_ALLOW + '])', 'gu');
function cleanText(v, max, dflt) {
  if (typeof v !== 'string') return dflt || '';
  const s = v.replace(TEXT_STRIP, '').trim().slice(0, max);
  return s || (dflt || '');
}
function textHasViolations(v) {
  return typeof v === 'string' && TEXT_BAD.test(v);
}
// Door-check twin of cleanText: does this INCOMING profile contain characters
// the allowlist would strip? Used by the HTTP endpoints to reject with 400
// instead of storing a silently-mangled name.
function profileTextViolations(p) {
  if (!p || typeof p !== 'object') return false;
  const car = p.car && typeof p.car === 'object' ? p.car : {};
  return textHasViolations(p.name) || textHasViolations(p.vibe) ||
    textHasViolations(car.make) || textHasViolations(car.model) || textHasViolations(car.trim) ||
    textHasViolations(car.paintName) || textHasViolations(car.engine) || textHasViolations(car.mods);
}

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
    name: cleanText(p.name, 24, 'Rider'),
    handle: str(p.handle, 16, 'rider').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'rider',
    emoji: sanitizeEmoji(p.emoji),
    avatar: sanitizeAvatar(p.avatar),
    vibe: cleanText(p.vibe, 24, 'Chill cruise'),
    car: {
      year: Math.round(num(car.year, 1900, 2030, 2020)),
      make: cleanText(car.make, 24, 'Toyota'),
      model: cleanText(car.model, 24, 'Supra'),
      trim: cleanText(car.trim, 32, ''),
      paint: paintOk ? car.paint : '#4f8cff',
      paintName: cleanText(car.paintName, 24, 'Custom'),
      finish: ['Gloss', 'Matte', 'Metallic', 'Satin'].indexOf(car.finish) >= 0 ? car.finish : 'Gloss',
      body: carEnum(car.body, CAR_BODY_TYPES, 'Sedan'),
      // engine + mods are free text (the garage supports custom entries) —
      // allowlisted like every other rider-visible string, on top of the
      // HTML-escaping every client already does.
      engine: cleanText(car.engine, 24, '2.0L'),
      trans: carEnum(car.trans, CAR_TRANS, 'Automatic'),
      drive: carEnum(car.drive, CAR_DRIVE, 'FWD'),
      hp: Math.round(num(car.hp, 50, 2000, 200)),
      mods: cleanText(car.mods, 40, 'None'),
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
   limit in this file — auth (14/10min), route (30/min), tts — plus a fresh
   slot against the MAX_PER_IP
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
// which silently disabled TomTom routing on Android. The API is
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
// shared per-IP bucket meant the map's background polls (route caps, TTS)
// filled the same bucket the auth check
// read, so a user whose map was open couldn't register ("Too many attempts").
//
// The scope half of the key is the UNIT the limit counts, and there are exactly
// three in use, so every limit in this file reads unambiguously:
//   '<scope>:<ip>'    per source address — everything HTTP (see clientIp for
//                    why that is trusted-proxy-aware)
//   '<scope>:<userId>' per account — actions where the actor is authenticated
//                    (chpw, del, report…) and the account outlives sockets
//   '<scope>:<c.id>'  per websocket CONNECTION — chat, invites, friend requests.
//                    The client id is minted fresh per socket, so this behaves
//                    exactly like the old per-socket timestamp arrays it
//                    replaced (a reconnect is a new bucket) while keeping ONE
//                    throttling mechanism, one prune pass and one mental model.
const authHits = new Map(); // 'scope:unit' -> [timestamps]
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

/* ================= refresh-token reuse detection =================
   GoTrue rotates refresh tokens: every /api/refresh retires the token that was
   presented and hands back a fresh one. Rotation only protects a rider whose
   token was stolen if a RETIRED token stops working the moment it is replayed —
   and left to GoTrue alone, that is not quite what happens:

     · A replay INSIDE GoTrue's reuse interval (10s by default) is answered with
       the session the first rotation already produced — silently minting a
       second holder instead of refusing.
     · Outside the interval modern GoTrue revokes the family itself, but older
       builds just 400, and nothing anywhere revokes on a replay that races the
       legitimate client's own refresh.

   Convoy is the only path a refresh can take (the client never learns the
   Supabase project URL — it only ever holds the token), so this server sees
   every presentation of every token and can enforce the rule itself: a token
   that has ALREADY completed a refresh here is replayed-or-stolen, and the
   session family it belongs to is revoked — the OAuth 2.1 prescribed answer.
   Two legitimate presentations are still fine, because those only ever happen
   CONCURRENTLY (two tabs racing the one stored session): they are coalesced
   onto a single GoTrue call with one shared answer, not counted as reuse.
   js/auth.js single-flights refreshes per tab, so a SEQUENTIAL second
   presentation of the same token is never an accident.

   In-memory on purpose. A restart forgets the seen-set, but a restart also
   means the replayed token's last rotation is at least as old as the downtime —
   outside GoTrue's reuse interval, where GoTrue's own refusal (and the 401
   below) already covers it. For the same reason the access token saved for the
   revocation call is, in every live window, at most one JWT lifetime old. */
const RT_SEEN_MAX = 4096;      // remembered token presentations (bounded memory)
const rtSeen = new Map();      // sha256(refresh token) -> userId it last minted for
const rtInFlight = new Map();  // sha256(refresh token) -> the shared in-progress refresh
const rtLatest = new Map();    // userId -> access token from their most recent refresh

function rtHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function rtRemember(hash, userId, accessToken) {
  rtSeen.set(hash, userId);
  rtLatest.set(userId, accessToken);
  // Bound the memory: shed the oldest quarter when full. Insertion order is
  // presentation order, and the entries dropped are long-retired tokens whose
  // replay GoTrue already refuses on its own.
  if (rtSeen.size > RT_SEEN_MAX) {
    let drop = rtSeen.size - Math.floor(RT_SEEN_MAX * 0.75);
    for (const k of rtSeen.keys()) { if (drop-- <= 0) break; rtSeen.delete(k); }
  }
}

// Revoke every session of the account a replayed token belonged to. Best-effort
// by design: the 401 the replayer receives is enforced right here in this
// process, the revocation is the cleanup that also ends the session whoever
// holds the other branch of the stolen token had been keeping alive. sb.signOut
// never throws (network failures come back as false), so fire-and-forget is
// safe, and the rider's 401 is not held hostage to a slow GoTrue.
function revokeRtFamily(userId, ip) {
  const access = rtLatest.get(userId);
  rtLatest.delete(userId);
  const u = store.getById(userId);
  const who = u ? u.username : userId;
  if (!access) {
    // No fresh access token held (e.g. the server restarted since the last
    // refresh). Nothing we can sign out with — GoTrue still refuses the
    // replayed token, and the legit client's next refresh mints from a token
    // the replayer never saw.
    console.warn('[refresh] replayed refresh token (' + who + ') — no held access token to revoke with');
    return;
  }
  sb.signOut(access, 'global', ip).then((ok) => {
    console.warn('[refresh] replayed refresh token (' + who + ') — session family ' +
      (ok ? 'revoked' : 'could not be revoked (GoTrue refused the sign-out)'));
  });
}

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
  /* ---- feature packs (server/packs/index.js) ----
     The catalogue is public and the redeem screen is always visible: a
     reviewer can read what a code unlocks without holding one. The manifest
     and the redeem call need an account, because a grant is a row against
     one. The redeem budget is per account AND per IP so a code cannot be
     guessed at — the code space is ~79 bits (server/packcodes.js), so the
     limit is belt-and-braces, not the lock. */
  if (req.method === 'GET' && urlPath === '/api/packs/catalog') {
    return json(res, 200, { packs: packs.catalog() });
  }
  if (req.method === 'GET' && urlPath === '/api/packs') {
    const u = userFromToken(bearer(req));
    if (!u) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, packs.manifestFor(u));
  }
  if (req.method === 'POST' && urlPath === '/api/packs/redeem') {
    const u = userFromToken(bearer(req));
    if (!u) return json(res, 401, { error: 'unauthorized' });
    if (!rateOk('packs:' + u.id, 10, 15 * 60 * 1000) || !rateOk('packs-ip:' + ip, 30, 15 * 60 * 1000)) {
      return json(res, 429, { error: 'Too many attempts. Try again in a few minutes' });
    }
    return readBody(req, res, async (body) => {
      try {
        if (!body || !packcodes.looksValid(body.code)) return json(res, 400, { error: 'That doesn\'t look like a Convoy code' });
        const r = await store.redeemPack(u.id, body.code);
        if (r.error === 'unknown') return json(res, 404, { error: 'That code isn\'t valid' });
        if (r.error) {
          console.log('[packs] ' + u.username + ' tried a code that is ' + r.error);
          return json(res, 410, { error: 'That code can\'t be used any more' });
        }
        console.log('[packs] ' + u.username + ' redeemed code #' + r.code + (r.label ? ' (' + r.label + ')' : '') +
          ' → ' + (r.granted.length ? r.granted.join(', ') : 'nothing new'));
        // A live socket picks the new packs up on its next hello; tell this
        // one now so the loader can fetch without a reconnect.
        const live = online.get(u.id);
        if (live) packs.onHello(live, u);
        return json(res, 200, Object.assign({ ok: true, granted: r.granted, label: r.label || '' }, packs.manifestFor(u)));
      } catch (e) {
        console.error('[packs redeem]', e.message);
        return json(res, 500, { error: 'Server error' });
      }
    });
  }

  if (req.method === 'GET' && urlPath === '/api/route/caps') {
    // The cap flows through the runtime flag store (flags.js): env/key state
    // is the DEFAULT, the admin panel can force it on/off live, and riders see
    // the change on their next app open (caps are session-cached).
    return json(res, 200, {
      routing: flags.pick('routing', tomtom.hasKey())
    });
  }

  /* ---- OTA channel status ----
     What bundle the channel is serving and what it can roll back to. Anonymous
     and cheap on purpose: release.js health-probes it after every --ota push,
     and it is the data `--rollback` reads. Metadata only — no download URL
     beyond the filename, which is public by construction anyway. */
  if (req.method === 'GET' && urlPath === '/api/ota') {
    return json(res, 200, ota.summary());
  }

  /* ---- crash + funnel dashboard (auth'd) ----
     The number the launch checklist actually asks for: crash-free sessions,
     with the funnel and the top error groups beside it so a bad release is
     visible in one request instead of one grep.

     Gated on TELEMETRY_TOKEN, and 404 when that is unset. This is operational
     data about riders' sessions; it is not something to leave open on the
     public internet because nobody remembered to lock it. */
  if (req.method === 'GET' && urlPath === '/api/telemetry/stats') {
    if (!TELEMETRY_TOKEN) return json(res, 404, { error: 'not found' });
    if (!rateOk('telstats:' + ip, 30, RATE_WINDOW)) return json(res, 429, { error: 'Slow down' });
    const tok = bearer(req);
    // Constant-time compare: this is a bearer secret, and a length-leaking
    // early-exit === is the one mistake worth not making on a token check.
    if (!tok || !safeEqual(tok, TELEMETRY_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    let days = 7;
    try { days = parseInt(new URLSearchParams(req.url.split('?')[1] || '').get('days') || '7', 10) || 7; }
    catch (e) { days = 7; }
    const stats = telemetry.stats(days);
    // Deletions that have not finished on the GoTrue side. Non-zero means we
    // have told someone their account is gone while their email address and
    // social identities are still in auth.users — a compliance failure that is
    // being retried, not one that has been shrugged off. See authresidue.js.
    stats.pendingAuthDeletions = store.pendingAuthDeletions();
    return json(res, 200, stats);
  }

  // A pack's own GET (or any non-POST) routes — server/packs/<id>.js — each
  // gated on the account holding that pack. POST pack routes are tried below,
  // once the body has been read, so they receive it.
  if (req.method !== 'POST') {
    if (await packs.handleApi(req, res, urlPath, null)) return;
    return json(res, 404, { error: 'not found' });
  }

  // Flood tier (server-017): every anonymous credential-shaped endpoint —
  // each one either checks a secret or spends an outbound email — shares one
  // generous per-IP ceiling, charged BEFORE the body is read so a flooder
  // cannot make this process read bodies. Honest use never reaches it: it is
  // sized above the sum of the per-route attempt budgets, which are charged
  // inside the readBody() callback below, once a well-formed body exists.
  if (ANON_AUTH_ROUTES.indexOf(urlPath) >= 0 && !rateOk('authflood:' + ip, AUTH_FLOOD_MAX, RATE_WINDOW)) {
    return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
  }

  readBody(req, res, async (body) => {
    if (body == null) return json(res, 400, { error: 'Bad request' }); // parse error / socket error
    // Per-route, per-IP attempt budget — charged only once a well-formed body
    // exists, so a 400 or a 413 costs a rider nothing (server-017). Routes
    // absent from the table (/api/telemetry, /api/ota, every authenticated
    // route below) read undefined here and are ungated by this tier, exactly
    // as before.
    const attempts = ANON_AUTH_BUDGET[urlPath];
    if (attempts !== undefined && !rateOk('auth:' + urlPath + ':' + ip, attempts, RATE_WINDOW)) {
      return json(res, 429, { error: 'Too many attempts — wait a few minutes' });
    }
    try {
      /* ---- crash reports + core-loop analytics ----
         Unauthenticated on purpose: the crash we most need to see is the one
         that happens before a rider ever signs in, and a report that requires a
         working session cannot tell us the session broke. Nothing here is
         trusted — telemetry.ingest() re-clamps every field — and the reply is a
         bare 204 so this endpoint is useless as an oracle for anything.

         The budget is per-IP and generous, because carrier NAT puts a lot of
         genuine riders behind one address; it exists to stop a script, not to
         ration honest clients. Over budget we still answer 204 rather than 429:
         the client has no retry logic and nothing useful to do with the
         difference, and silence is the cheaper failure. */
      if (urlPath === '/api/telemetry') {
        // Env TELEMETRY=0 is the boot default; the panel's telemetry kill
        // switch can force it either way at runtime. Swallowed either way:
        // the client has no retry logic, so silence beats a 429.
        if (!flags.pick('telemetry', TELEMETRY_ON)) { res.writeHead(204, CORS_HEADERS); return res.end(); }
        if (rateOk('tel:' + ip, 120, 5 * 60 * 1000)) {
          try { telemetry.ingest(body); }
          catch (e) { console.error('[telemetry] ingest:', e && e.message); }
        }
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

      /* ---- OTA update check (the LiveUpdate plugin's one call per app open) ----
         The plugin POSTs what it is running; the server alone decides whether an
         update is offered (see server/ota.js decide()). Anonymous like the caps
         probe, and deliberately unauthenticated: the body carries platform +
         versions and NOTHING ELSE — no device identifier exists to authenticate,
         and the response is version metadata any browser can already read at
         GET /api/ota. Rate limit exists to keep a buggy client from polling in a
         loop; 30/min is 30× a healthy app's rate. */
      if (urlPath === '/api/ota') {
        if (!rateOk('ota:' + ip, 30, 60 * 1000)) return json(res, 429, { error: 'Slow down' });
        // The panel's ota flag is the channel's big red button: while halted,
        // checks succeed but offer nothing — devices keep what they run and
        // the manifest stays intact for when the channel resumes.
        if (!flags.pick('ota', true)) return json(res, 200, {});
        return json(res, 200, ota.decide(body));
      }

      if (urlPath === '/api/register') {
        // Panel kill switch: freeze new sign-ups without touching anyone
        // already registered. 503 + plain words, the client shows it as-is.
        if (!flags.pick('registration', true)) {
          return json(res, 503, { error: 'Sign-ups are paused on this server' });
        }
        const ue = validUsername(body.username);
        if (ue) return json(res, 400, { error: ue });
        const pe = validPassword(body.password);
        if (pe) return json(res, 400, { error: pe });
        // Free-text allowlist door-check (see cleanText above): reject rather
        // than silently strip, so a rider who typed markup into a name hears
        // about it instead of wondering where their characters went.
        if (profileTextViolations(body.profile)) return json(res, 400, { error: 'Bad request' });
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
        // Panel kill switch: sign-in freeze (maintenance window / incident
        // containment). Existing sessions keep working — this gates NEW
        // sign-ins only, so nobody's live ride is dropped by it.
        if (!flags.pick('login', true)) {
          return json(res, 503, { error: 'Sign-in is paused on this server — try again soon' });
        }
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
      /* ---- abuse reports ----
         The other half of the UGC obligation. Blocking protects the reporter;
         this is what lets an operator act on the rider, which blocking alone
         never does.

         Deliberately NOT rate-limited into uselessness: someone being harassed
         in real time may file several reports in a minute, and refusing them is
         the wrong failure. The budgets below are sized to stop scripted
         report-bombing (which is its own abuse vector — weaponised reporting)
         while leaving genuine bursts through, and the durable per-account count
         is the one that survives cycling IPs or devices. */
      if (urlPath === '/api/report') {
        const u = userFromToken(bearer(req));
        if (!u) return json(res, 401, { error: 'Sign in to report a rider' });
        if (!rateOk('report:' + u.id, 12, 10 * 60 * 1000) || !rateOk('reportip:' + ip, 30, 10 * 60 * 1000)) {
          return json(res, 429, { error: 'Too many reports right now — give it a few minutes' });
        }
        const REASONS = ['harassment', 'hate', 'sexual', 'threats', 'spam',
          'impersonation', 'dangerous', 'false-reports', 'other'];
        const reason = String(body.reason || '').slice(0, 24);
        if (REASONS.indexOf(reason) < 0) return json(res, 400, { error: 'Pick a reason' });

        // The subject may be an account, or a guest with only a display name.
        // Both are worth recording: a pattern of reports against one guest name
        // in one area is still a signal, and the reporter should never be told
        // "we can't take that" for reporting the rider actually bothering them.
        const subjectRider = getRider(String(body.riderId || '').slice(0, 40));
        const subjectUserId = (subjectRider && subjectRider.userId) ||
          String(body.subjectUserId || '').slice(0, 40) || null;
        const subjectAccount = subjectUserId ? store.getById(subjectUserId) : null;
        const subjectLabel = subjectRider
          ? String((subjectRider.profile && subjectRider.profile.name) || subjectRider.name || '').slice(0, 60)
          : String(body.subjectLabel || '').slice(0, 60);
        if (!subjectAccount && !subjectLabel) {
          return json(res, 400, { error: 'Nothing to report — pick a rider' });
        }
        if (subjectAccount && subjectAccount.id === u.id) {
          return json(res, 400, { error: "You can't report yourself" });
        }

        // A soft ceiling on the durable count. Past this the report is ACCEPTED
        // and stored — dropping it would let an abuser silence a victim by
        // provoking them into reporting a lot — but flagged so a reviewer sees
        // the volume rather than being buried by it.
        const recent = await store.recentReportCount(u.id, 24 * 60 * 60 * 1000);

        const filed = await store.fileReport({
          reporterId: u.id,
          reporterUsername: u.username,
          subjectId: subjectAccount ? subjectAccount.id : null,
          subjectUsername: subjectAccount ? subjectAccount.username : null,
          subjectLabel: subjectLabel || null,
          reason: reason,
          detail: String(body.detail || '').slice(0, 1000) || null,
          context: ['chat', 'voice', 'profile', 'map'].indexOf(String(body.context)) >= 0
            ? String(body.context) : null,
          evidence: body.evidence && typeof body.evidence === 'object'
            ? { quoted: String(body.evidence.quoted || '').slice(0, 500),
                at: Number(body.evidence.at) || Date.now(),
                highVolumeReporter: recent >= 20 }
            : { highVolumeReporter: recent >= 20 }
        });
        if (filed.error) return json(res, 502, { error: 'Could not file the report — try again' });

        console.log('[report] ' + u.username + ' reported ' +
          (subjectAccount ? '@' + subjectAccount.username : '"' + subjectLabel + '" (guest)') +
          ' for ' + reason + ' (#' + filed.id + ')');
        return json(res, 200, { ok: true, id: filed.id });
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
        // Same panel login freeze as /api/login — magic links ARE sign-ins.
        if (!flags.pick('login', true)) {
          return json(res, 503, { error: 'Sign-in is paused on this server — try again soon' });
        }
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
        const th = rtHash(rt);
        // Reuse: this exact token already completed a refresh once. Whatever
        // GoTrue's reuse interval would have said about it, Convoy refuses it
        // outright and kills the whole session family it minted — see the
        // reuse-detection block above handleApi for why sequential replay is
        // never a legitimate client.
        if (rtSeen.has(th)) {
          revokeRtFamily(rtSeen.get(th), ip);
          return json(res, 401, { error: 'Session expired' });
        }
        // Concurrent presentation (second tab, same stored token): wait on the
        // SAME GoTrue call the first one started rather than racing it. Both
        // callers get the same rotated session — which is what they'd have
        // gotten anyway, minus a second upstream call and minus any chance of
        // one branch rotating the token out from under the other.
        let pending = rtInFlight.get(th);
        if (!pending) {
          pending = sb.refresh(rt, ip);
          rtInFlight.set(th, pending);
          // Cleanup in a settled handler, not .finally(): the promise .finally
          // returns would be orphaned if sb.refresh throws (network), and an
          // unhandled rejection is a process-killer under load.
          pending.then(() => rtInFlight.delete(th), () => rtInFlight.delete(th));
        }
        const r = await pending;
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
        // From here on this token is dead: remember it, and hold onto the fresh
        // access token so a later replay of it has something to revoke with.
        rtRemember(th, u.id, r.session.access_token);
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
        // Same door-check as register: the allowlist runs at the data layer
        // regardless, this just makes the rejection observable.
        if (profileTextViolations(body.profile)) return json(res, 400, { error: 'Bad request' });
        const profile = sanitizeProfile(body.profile);
        profile.handle = u.username.toLowerCase();
        store.updateProfile(u.id, profile);
        return json(res, 200, { ok: true, profile });
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

      // A pack's own POST routes (server/packs/<id>.js), each gated on the
      // account holding that pack, handed the parsed body. Nothing here is
      // reachable without a grant.
      if (await packs.handleApi(req, res, urlPath, body)) return;

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
// A rider riding through a tunnel is not a rider leaving the convoy. The socket
// dies, but the seat is held for PARTY_GRACE_MS so the next `hello` carrying the
// same resume token drops straight back into the same convoy (server-035; the
// client half is js/net.js, whose PARTY_GRACE_MS must stay <= this one —
// test/partyresume.test.js pins it). 0 disables the hold: every close is a
// leave again, exactly the pre-cycle-58 behaviour.
const PARTY_GRACE_MS = Number(process.env.PARTY_GRACE_MS || 90000);
const RESUME_MAX = 500;                 // hard ceiling; seats are pruned on write
const resumeSeats = new Map();          // token -> { pid, userId, at }  (the socket was already reaped)
const seatOwner = new Map();            // token -> the client that still owns it (the socket is still open)
// Global per-connection websocket message budget (server-024). Every bucket
// above throttles ONE message type; this is the ceiling over ALL of them, so a
// signed-in client cannot push {"t":"wave"} at line rate and turn each one
// into a scoped broadcast. Sized against a legitimate client's documented peak:
// pos at 1Hz (60/min, js/net.js sendPos) + voice:signal at its own ceiling of
// 40 per 5s (480/min) + voice:relay at its own 1200/min ≈ 1740/min. 1800
// leaves headroom and still cuts a line-rate flood by orders of magnitude;
// test/serverpolicy.test.js W1 pins that arithmetic. Per connection, per fixed
// 60s window; the gate itself sits in the socket's message handler, after the
// hello-first guard and before the handler lookup.
const WS_MSG_BUDGET = parseInt(process.env.WS_MSG_BUDGET || '1800', 10);
const WS_MSG_WINDOW_MS = 60 * 1000;
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
   handle, photo and username. Confirming the address restores all of it,
   live, without a reconnect.

   WHO IS **NOT** GATED, and why each matters:
     · guests — they never gave an address, so there is nothing to confirm. They
       are a separate, pre-existing tier.
     · accounts with `email: null` — everyone who registered before email
       existed. Gating them would take away something they already had over a
       box they were never shown.
     · every account, when the server has no mailer — with RESEND_API_KEY unset
       nobody CAN confirm, so a gate would be a permanent lockout.

   WHAT THE GATE DOES NOT DO, equally deliberate (verified in source, kept on
   purpose): it never mutes POSITION. A gated viewer — and a guest, who is not
   gated at all — still receives every in-scope rider's exact pin in real time
   (rider:add on scope, then the 1Hz tick and the ~3Hz fast lane), because the
   live nearby map is the product and hiding WHERE would hide the map itself.
   Anyone holding a socket therefore "harvests" nearby GPS by construction; that
   is the feature, bounded rather than prevented:
     · scope  — only riders within NEARBY_KM (30km) are ever sent, and only to
       a viewer that presented a position of its own;
     · ghost  — the rider-side opt-out; a ghosted rider is in nobody's scope
       and nobody's global feed;
     · blocks — a blocked pair leaves both scopes immediately;
     · global — the everyone-layer is 5 minutes delayed and jittered 100-400m
       (GLOBAL_DELAY_MS / globalJitter), so it is coarse by design.
   Identity, not location, is what account state buys: the gate (and only the
   gate) strips WHO a pin is. If position ever needs to be gated too, that is a
   product decision to make in the Terms first — the privacy story riders are
   told is the list above.

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
    account: null    // no username → no "add friend" either
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
      car: r.car, pos: r.pos, heading: r.heading, mode: r.mode, account: null
    };
  } else {
    rec = {
      id: r.id, name: r.profile.name, handle: r.profile.handle, emoji: r.profile.emoji,
      avatar: r.profile.avatar || null, // profile photo (small data URL) — null keeps the glyph
      vibe: r.profile.vibe, car: r.profile.car, pos: r.pos, heading: r.heading, mode: r.mode,
      account: r.username || null  // username when this rider is signed in (enables "add friend")
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

// Deferred work runs outside every request/socket try/catch: a throw in one of
// these lands on the process-level uncaughtException handler, which logs and
// keeps the process up — by luck, not design, and it silently swallows the rest
// of the callback. Every deferred body in this file goes through here
// (server-002). Argument order matches setTimeout on purpose, and the timer
// handle is returned so a caller can still .unref() it.
function defer(fn, ms) {
  return setTimeout(() => {
    try { fn(); } catch (e) { console.error('[defer] deferred task threw:', (e && e.message) || e); }
  }, ms);
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
// Every voice path — SDP/ICE signalling, the PCM relay fallback, and mic-state
// announcements — routes through this one set, so the block check belongs here
// and nowhere else. Blocking someone silences them in both directions: they are
// not offered a peer connection, and none of their audio is relayed.
function voiceTargets(c) {
  const out = new Set();
  const party = c.party && parties.get(c.party);
  if (party) {
    for (const id of party.members) {
      if (id !== c.id && clients.has(id) && !blockedPair(c, clients.get(id))) out.add(id);
    }
  }
  if (c.voiceProx && !c.ghost && c.pos) {
    const cand = [];
    for (const [id, other] of clients) {
      if (id === c.id || out.has(id)) continue;
      if (!other.voiceProx || other.ghost || !other.pos) continue;
      if (blockedPair(c, other)) continue;
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
/* Is either of these two riders blocking the other?

   Takes CLIENTS (or bots) rather than account ids, because that is what every
   fan-out site here already holds. Two shapes fall through as "not blocked":

     bots      — server-generated, nobody's harasser, and they have no account.
     guests    — a block has to survive the other side reconnecting, and a guest
                 has no durable identity to hang one on. The in-app copy is
                 explicit that blocking needs an account on both sides; the
                 client still hides a guest locally for the session (see
                 js/state.js), which is the most an anonymous id can honestly
                 promise.

   Everything else defers to store.blockedBetween, which reads the relationship
   in BOTH directions — see server/store.js. */
function blockedPair(a, b) {
  if (!a || !b || a.bot || b.bot) return false;
  if (!a.userId || !b.userId) return false;
  return store.blockedBetween(a.userId, b.userId);
}

// Cheap pre-check so the 45s global broadcast only pays for a per-viewer build
// where one is actually needed.
function hasBlocks(c) {
  if (!c || !c.userId) return false;
  const u = store.getById(c.userId);
  return !!(u && ((u.blocked && u.blocked.length) || (u.blockedBy && u.blockedBy.length)));
}

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
    // A block outranks everything above it, convoy membership included: two
    // people who have blocked each other must not appear on each other's map
    // even if they end up in the same convoy.
    if (blockedPair(c, r)) continue;
    if (B.haversine(c.pos, r.pos) <= radius) out.add(r.id);
  }
  if (c.party) {
    if (viewerParty) {
      for (const id of viewerParty.members) {
        if (id === c.id) continue;
        if (blockedPair(c, getRider(id))) continue;
        out.add(id);
      }
    }
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
  // Collect first, delete after. The spread that used to guard this iteration
  // allocated a copy of every rider in scope, for every client, every second —
  // and in the overwhelmingly common case nothing is being removed at all, so
  // the copy bought nothing. `gone` stays null until there is actually a
  // removal to make.
  let gone = null;
  for (const id of c.known) {
    if (!want.has(id)) (gone || (gone = [])).push(id);
  }
  if (gone) {
    for (let i = 0; i < gone.length; i++) {
      c.known.delete(gone[i]);
      c.wire.delete(gone[i]);
      send(c, { t: 'rider:remove', id: gone[i] });
    }
  }
}

function ensureKnown(c, id) {
  if (id !== c.id && !c.known.has(id)) {
    const r = getRider(id);
    // Blocked riders are never force-known. This is the path convoy membership
    // uses to pull a member onto your map regardless of distance, so without the
    // check a block could be defeated by joining the target's convoy.
    if (r && r.pos && !blockedPair(c, r)) {
      c.known.add(id);
      send(c, { t: 'rider:add', rider: riderRecord(r, c) });
    }
  }
}

/* Tear down a live pairing the instant a block is made.

   Waiting for the next scope tick would leave the blocked rider's pin on screen
   and, worse, keep the blocker's position streaming to them for up to a second
   after they asked for it to stop. Both sides are dropped from each other's
   known-set here, and any shared convoy is re-broadcast so the member lists and
   chat backlogs are rebuilt with the other party filtered out. */
function applyBlockNow(c, targetUserId) {
  const tc = online.get(targetUserId);
  // Packs with shared state between the two (a race they are both in) end it.
  packs.onBlock(c, targetUserId, tc || null);
  if (tc) {
    // ORDER MATTERS. The client refuses a rider:remove for anyone still flagged
    // as a convoy member ("party members stay visible", net.js) — a guard that
    // keeps a member's pin from flickering out when they drift past the 30km
    // scope radius. Sent the other way round, the removes below would arrive
    // first, be refused, and leave each rider's pin on the other's map with
    // nothing to re-send it. Re-broadcasting the party state first drops them
    // from each other's roster, which clears the flag and lets the removes land.
    const shared = c.party && tc.party && c.party === tc.party && parties.get(c.party);
    if (shared) sendPartyState(shared);

    if (c.known && c.known.has(tc.id)) { c.known.delete(tc.id); c.wire.delete(tc.id); send(c, { t: 'rider:remove', id: tc.id }); }
    if (tc.known && tc.known.has(c.id)) { tc.known.delete(c.id); tc.wire.delete(c.id); send(tc, { t: 'rider:remove', id: c.id }); }
    // Mic state is sticky on the receiving end — clear it, or a rider blocked
    // mid-transmission stays lit up as "speaking" forever.
    send(c, { t: 'voice:mic', from: tc.id, on: false, name: '' });
    send(tc, { t: 'voice:mic', from: c.id, on: false, name: '' });
  }
  syncScope(c);
}

/* ================= parties ================= */
// Null-safe because its one map/filter caller already expects nulls: the
// `.filter(Boolean)` beside it in sendPartyState was unreachable, since liteOf
// threw on `r.id` before the filter ever saw the null. A member id that outlives
// its client for even one tick — a socket closing mid-broadcast — would have
// taken down the whole party-state send instead of dropping one row.
function liteOf(r) {
  if (!r) return null;
  return { id: r.id, name: riderName(r), emoji: r.bot ? r.emoji : (r.profile && r.profile.emoji) };
}

// The roster and the chat backlog are built PER RECIPIENT rather than once for
// the convoy. Two riders who have blocked each other can legitimately be in the
// same convoy — one of them joined first — and each has to see it without the
// other in it: no pin, no name in the member list, and no replay of their
// messages when the panel re-renders.
function sendPartyState(party) {
  for (const id of party.members) {
    const c = clients.get(id);
    if (!c) continue;
    const visible = party.members.filter((mid) => mid === c.id || !blockedPair(c, getRider(mid)));
    const lites = visible.map((mid) => liteOf(getRider(mid))).filter(Boolean);
    for (const mid of visible) ensureKnown(c, mid);
    send(c, {
      t: 'party',
      party: {
        id: party.id, name: party.name, emoji: party.emoji, leader: party.leader,
        mode: party.mode, code: party.code,
        members: lites,
        chat: visibleChat(party, c, 50),
        rally: party.rally || null
      }
    });
  }
}

// The last `n` messages this rider is allowed to see. System messages have no
// author and always pass.
function visibleChat(party, c, n) {
  const out = [];
  for (let i = party.chat.length - 1; i >= 0 && out.length < n; i--) {
    const msg = party.chat[i];
    if (msg && msg.from && msg.from.id && blockedPair(c, getRider(msg.from.id))) continue;
    out.push(msg);
  }
  return out.reverse();
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
    // Broadcast to every member's screen — same free-text allowlist as profile
    // names, applied at the data layer (ws doors don't have a reply frame to
    // reject with).
    name: cleanText(name, 30, (c.profile.name || 'My') + "'s convoy"),
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

function joinParty(rider, party, quiet) {
  if (party.members.length >= MAX_PARTY) return false;
  if (rider.bot) {
    if (rider.party) return false;
    rider.party = party.id;
  } else {
    if (rider.party) leaveParty(rider, true);
    rider.party = party.id;
  }
  party.members.push(rider.id);
  // quiet: restoreSeat() re-seating a rider who never left (server-035).
  if (!quiet) partySys(party, riderName(rider) + ' joined the convoy');
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
    // party.members is push-ordered and only ever spliced, so humanMembers[0] is
    // already the longest-tenured member — that half of the ledger entry was wrong.
    // What it is NOT is necessarily still connected: ws.on('close') calls
    // leaveParty() BEFORE clients.delete(), so when two riders drop together the
    // first close handler still sees the second in `clients` with a socket that has
    // already left OPEN. Prefer the earliest member whose socket is live; fall back
    // to the old pick so a party is never left leaderless.  (server-020)
    const live = humanMembers.find((id) => {
      const m = clients.get(id);
      return m && m.ws && m.ws.readyState === 1;
    });
    party.leader = live || humanMembers[0];
    partySys(party, riderName(getRider(party.leader)) + ' now leads the convoy');
  }
  sendPartyState(party);
}

/* ---------------- seat hold (server-035) ----------------
   Two ways a rider's seat can still exist when their next `hello` arrives: the
   server already reaped the old socket (resumeSeats, written by ws.on('close')),
   or it has not noticed the socket is dead yet (seatOwner — the COMMON case:
   the client retries in 2 s, the ping loop needs 30-60 s to terminate a phone
   that vanished). A resume that only consulted the close-time map would almost
   never fire. All three are top-level on purpose: test/partyresume.test.js
   lifts them out of this file by text and runs them. */
function pruneSeats(now) {
  for (const [token, seat] of resumeSeats) {
    if (now - seat.at > PARTY_GRACE_MS) resumeSeats.delete(token);
  }
}

/* The socket died. Hold the seat, and tell the convoy the truth: they lost
   signal, they did not leave. Returns true when the seat was held — the close
   handler makes the leave silent exactly then. */
function rememberSeat(rider, now) {
  if (!PARTY_GRACE_MS || !rider || rider.bot || !rider.resume || !rider.party) return false;
  const party = parties.get(rider.party);
  if (!party) return false;
  pruneSeats(now);
  if (resumeSeats.size >= RESUME_MAX) return false;      // never grow unbounded
  resumeSeats.set(rider.resume, { pid: rider.party, userId: rider.userId || null, at: now });
  partySys(party, riderName(rider) + ' lost signal');
  return true;
}

/* `hello` carries the token from this rider's last `welcome`. Returns the party
   to re-join, or null. The token is a session capability at the trust level of
   the socket that received it (128-bit, sent only inside that socket's own
   welcome): single use, expiring, bound to the account that was signed in when
   it was minted, and good for the seat it was minted for — never another convoy. */
function claimSeat(rider, token, now) {
  if (!PARTY_GRACE_MS || !rider || typeof token !== 'string' || !token) return null;
  pruneSeats(now);
  const prev = seatOwner.get(token);
  if (prev && prev !== rider) {                    // half-open: the old socket is still live
    // A different identity holding a signed-in socket's token is not that
    // rider: leave the live seat to the reaper, seat nobody.
    if (prev.userId && prev.userId !== (rider.userId || null)) return null;
    seatOwner.delete(token);
    const party = prev.party ? parties.get(prev.party) : null;
    leaveParty(prev, true);                        // silent: moving sockets, not leaving
    try { prev.ws.close(); } catch (e) { /* already gone */ }
    if (party && parties.has(party.id) && party.members.length < MAX_PARTY) return party;
    return null;
  }
  const seat = resumeSeats.get(token);
  if (!seat) return null;
  resumeSeats.delete(token);                       // single use — spent even by a refused claim
  if (now - seat.at > PARTY_GRACE_MS) return null;
  if (seat.userId && seat.userId !== (rider.userId || null)) return null;
  const party = parties.get(seat.pid);
  if (!party || party.members.length >= MAX_PARTY) return null;
  return party;
}

/* Runs AFTER the welcome frame: joinParty() -> sendPartyState() reaches the
   client as a `party` frame, and js/net.js applyParty() needs its own id from
   `welcome` first (isLeader: p.leader === myId). */
function restoreSeat(rider, party) {
  if (!joinParty(rider, party, true)) return false;   // quiet: no "joined the convoy"
  partySys(party, riderName(rider) + ' reconnected');
  return true;
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
      packs.onHello(c, u);                 // c.packs = what this account has unlocked
    } else {
      c.profile = sanitizeProfile(m.profile); // guest
      packs.onHello(c, null);              // guests hold nothing
    }
    if (validPos(m.pos)) c.pos = m.pos;
    c.heading = num(m.heading, 0, 360, 0);
    recomputeHumans();
    assignAnchors();
    syncScope(c);
    // The seat resume (server-035): claim BEFORE the welcome so `resumed` is
    // truthful, restore AFTER it so the roster reaches a client that already
    // knows its own id (js/net.js applyParty: isLeader = leader === myId).
    const seat = claimSeat(c, m.resume, Date.now());
    send(c, {
      t: 'welcome',
      id: c.id,
      resume: c.resume,
      resumed: !!seat,
      online: humans().length,
      account: c.userId ? {
        username: c.username,
        friends: friendData.friends,
        requests: friendData.requests,
        // Sent at join so the client can render the blocked list in Settings and
        // suppress anything that slips through locally (a guest it hid for the
        // session, a frame already in flight).
        blocked: store.blockList(c.userId)
      } : null,
      riders: [...c.known].map((id) => riderRecord(getRider(id), c)),
      // Anonymised here as well when the gate applies — this frame is the
      // rider's first sight of the global layer.
      global: gated(c) ? anonymiseGlobal(buildGlobalFC(c)) : buildGlobalFC(c),
      // Feature packs this socket is entitled to: the client loader compares
      // it with what it has loaded and fetches the rest (js/packs.js).
      packs: packs.packsForSocket(c)
    });
    if (seat) restoreSeat(c, seat);
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
            other.wire.delete(c.id);
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
    if (!rateOk('invite:' + c.id, 10, 60 * 1000)) {
      return send(c, { t: 'err', msg: 'Too many invites — give it a minute' });
    }

    // m.to may be a rider/client id (nearby) or a friend's account id (any distance)
    const target = getRider(str(m.to, 40)) || clientByUserId(str(m.to, 40));
    if (!target || party.members.indexOf(target.id) >= 0) return;
    // Silently dropped rather than refused: telling the sender 'that rider blocked
    // you' hands them confirmation they were blocked, which is exactly the signal
    // someone blocks to avoid giving.
    if (blockedPair(c, target)) return;

    if (target.bot) {
      const pid = party.id, tid = target.id;
      defer(() => {
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
    if (!rateOk('chat:' + c.id, 5, 5000)) {
      return send(c, { t: 'err', msg: 'Slow down — too many messages' });
    }
    const text = str(m.text, 140);
    if (text) partySys(party, text);
  },

  /* ----- blocking (account required both sides) -----
     Blocking is the half of the UGC obligation that has to WORK, not just be
     recorded: the point is that the other rider stops reaching you. So the
     handler does the durable write and then immediately tears down every live
     relationship the two of them have, rather than waiting for the next scope
     tick to notice. */
  'block:add'(c, m) {
    if (!c.userId) return send(c, { t: 'err', msg: 'Sign in to block riders' });
    if (!rateOk('block:' + c.userId, 30, 60 * 1000)) {
      return send(c, { t: 'err', msg: 'Too many changes — give it a minute' });
    }
    // Three ways to name the target, tried in order. The username matters:
    // without it, blocking someone who disconnected between opening their card
    // and tapping Block would fail with "that rider is a guest", because the
    // rider id no longer resolves to anyone. Someone reaching for Block has a
    // reason to, and a rider going offline is not a reason to refuse.
    const target = getRider(str(m.to, 40)) || clientByUserId(str(m.to, 40));
    const byName = !target && m.username ? store.getByUsername(str(m.username, 20)) : null;
    const targetUserId = (target && target.userId) || (byName && byName.id) || str(m.userId, 40);
    if (!targetUserId) {
      return send(c, { t: 'err', msg: 'That rider is a guest — blocking needs an account on both sides' });
    }
    const r = store.blockUser(c.userId, targetUserId);
    if (r.error === 'self') return send(c, { t: 'err', msg: "You can't block yourself" });
    if (r.error) return send(c, { t: 'err', msg: 'Could not block that rider' });

    // A block also ends any relationship that would keep them in contact.
    // Leaving the friendship in place would keep them on each other's friends
    // list, online status and all, which is not what "block" means to anyone.
    if (store.areFriends(c.userId, targetUserId)) {
      store.removeFriend(c.userId, targetUserId);
      const tc = online.get(targetUserId);
      if (tc) pushFriends(tc);
      pushFriends(c);
    }
    applyBlockNow(c, targetUserId);
    send(c, { t: 'block:list', blocked: store.blockList(c.userId) });
  },

  'block:remove'(c, m) {
    if (!c.userId) return send(c, { t: 'err', msg: 'Sign in to manage blocks' });
    if (!rateOk('block:' + c.userId, 30, 60 * 1000)) {
      return send(c, { t: 'err', msg: 'Too many changes — give it a minute' });
    }
    const r = store.unblockUser(c.userId, str(m.userId, 40));
    if (r.error) return send(c, { t: 'err', msg: 'Could not unblock that rider' });
    // Re-scope both sides so the pins come back without a reconnect.
    syncScope(c);
    const tc = online.get(str(m.userId, 40));
    if (tc) syncScope(tc);
    send(c, { t: 'block:list', blocked: store.blockList(c.userId) });
  },

  /* ----- friends (account required) ----- */
  'friend:add'(c, m) {
    if (!c.userId) return send(c, { t: 'err', msg: 'Sign in to add friends' });
    if (!rateOk('freq:' + c.id, 15, 60 * 1000)) {
      return send(c, { t: 'err', msg: 'Too many requests — give it a minute' });
    }
    // Echoed back AS TYPED on every path below. The stored casing differs from
    // the probe's ("mike24" vs "Mike24"), so echoing the canonical name for
    // real riders and the raw input for missing ones would leak exactly what
    // the silent no-op below exists to hide.
    const who = str(m.username, 20);

    const r = store.sendFriendRequest(c.userId, who);
    // The username oracle, closed. Any observable difference between "sent" and
    // "no such rider / blocked" — a distinct message, an err instead of an ok, a
    // missing friends push — answers "does this account exist", and the only
    // party with a use for that answer is someone sweeping the namespace. The
    // no-such-rider outcome is therefore answered with the SAME frame, in the
    // SAME order, as a genuine request, and quietly creates nothing.
    if (r.error === 'no-such-rider') {
      send(c, { t: 'friend:result', ok: true, msg: 'Friend request sent to ' + who });
      pushFriends(c);
      return;
    }
    if (r.error) return send(c, { t: 'err', msg: r.error });
    const me = store.getById(c.userId);
    if (r.autoAccepted) {
      send(c, { t: 'friend:result', ok: true, msg: 'You and ' + r.target.username + ' are now friends' });
      const tc = online.get(r.target.id);
      if (tc) { send(tc, { t: 'friend:added', friend: friendLiteOnline(me) }); pushFriends(tc); }
      pushFriends(c);
    } else {
      send(c, { t: 'friend:result', ok: true, msg: 'Friend request sent to ' + who });
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
    if (!rateOk('chat:' + c.id, 5, 5000)) {
      return send(c, { t: 'err', msg: 'Slow down — too many messages' });
    }

    const text = str(m.text, 140);
    if (!text) return;

    // System messages can only originate server-side (partySys). Clients sending
    // {t:'chat', sys:true} used to be able to forge convoy announcements — now
    // the flag is ignored entirely on the incoming path.
    const entry = { from: liteOf(c), text, t: Date.now() };
    party.chat.push(entry);
    if (party.chat.length > 100) party.chat.shift();
    for (const id of party.members) {
      const member = clients.get(id);
      if (!member) continue;
      // Two riders who have blocked each other can still share a convoy — one of
      // them may have been in it first. Neither hears the other, and neither is
      // told the other is there.
      if (blockedPair(c, member)) continue;
      // `t` is the envelope's message-type key, so the timestamp travels as
      // `t2` — the same field partySys() and the bot reply below already fill
      // correctly (from `m.t` / `reply.t`). From the initial commit until
      // cycle 55 this line read `now` instead of `entry.t`, and `now` was never
      // defined: the handler threw before the first send() and no rider-typed
      // chat line was ever delivered in live mode, the sender's own echo
      // included (server-032; pinned by test/serverpolicy.test.js X1 and
      // test/globals.test.js).
      send(member, { t: 'chat', from: entry.from, text, t2: entry.t });
    }

    const botMembers = party.members.filter((id) => bots.has(id));
    if (botMembers.length && B.chance(0.75)) {
      const pid = party.id;
      defer(() => {
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
    // A wave is a notification on someone's screen; a block has to stop it.
    if (blockedPair(c, target)) return;
    if (target.bot) {
      const tid = target.id, cid = c.id;
      defer(() => {
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
  const now = Date.now();
  for (const c of humans()) {
    if (!c.pos) continue;
    syncScope(c, pool);
    if (!c.known.size) continue;
    const rows = [];
    for (const id of c.known) {
      const r = getRider(id);
      if (!r || !r.pos) continue;
      const row = rowOf(r);
      const rowStr = row.join(',');
      const distM = B.haversine(c.pos, r.pos);
      const sent = wiregate.shouldSend(c.wire.get(id), rowStr, distM, now);
      wiregate.record(c.wire, id, rowStr, now, sent);
      if (sent) rows.push(row);
    }
    // Skip the send entirely (envelope included) when the gate suppressed
    // every row this tick — the common case once riders settle down.
    if (rows.length) send(c, { t: 'tick', r: rows });
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
    const near = nearestRows(c, now);
    if (near.length) send(c, { t: 'tick', r: near });
  }
}, FAST_MS);

/* The NEAR_FAST closest riders to `c`, as wire rows.

   This used to be a six-stage array chain — spread the Set, map to riders,
   filter, map to {r,d} pairs, sort the whole thing, slice, map to rows — which
   allocated six intermediate arrays plus one wrapper object per known rider and
   fully sorted every rider within 30 km, ~3 times a second, per client. All to
   take six of them.

   Selecting the top K in one pass instead is both less code and strictly less
   work: an insertion into a fixed K-slot buffer, with an early skip for anyone
   farther than the current worst keeper. Output is byte-identical to the sort
   (ties included — insertion only shifts on a strict >, so equal distances keep
   their original order, exactly like the stable sort did).

   Measured against the old chain, same inputs and outputs: 1.65x faster at 20
   known riders, 3.0x at 60, 4.2x at 150 — it scales better precisely because
   the sort was the part that grew. */
const nearR = new Array(NEAR_FAST);
const nearD = new Array(NEAR_FAST);
function nearestRows(c, now) {
  let n = 0;
  for (const id of c.known) {
    const r = getRider(id);
    if (!r || !r.pos) continue;
    const d = B.haversine(c.pos, r.pos);
    if (n === NEAR_FAST && d >= nearD[n - 1]) continue;   // farther than our worst keeper
    let i = n < NEAR_FAST ? n++ : NEAR_FAST - 1;
    while (i > 0 && nearD[i - 1] > d) { nearD[i] = nearD[i - 1]; nearR[i] = nearR[i - 1]; i--; }
    nearD[i] = d; nearR[i] = r;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = nearR[i];
    const row = rowOf(r);
    const rowStr = row.join(',');
    // Fast lane is by definition the viewer's nearest riders — always inside
    // the "near" tier (distM 0), so the only gate that applies here is the
    // identical-row hold/suppress (rule 4). No distance rate-limiting: that
    // would fight the fast lane's own purpose.
    const sent = wiregate.shouldSend(c.wire.get(r.id), rowStr, 0, now);
    wiregate.record(c.wire, r.id, rowStr, now, sent);
    if (sent) out.push(row);
  }
  // The scratch buffers are module-level and reused every call, so drop the
  // rider references — otherwise a disconnected client stays reachable from
  // here until the next tick happens to overwrite its slot.
  for (let i = 0; i < n; i++) nearR[i] = null;
  return out;
}

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
      // Also server-side only. Needed because the delayed feed can outlive the
      // socket: by the time this snapshot is sent, the rider may be gone, so a
      // block check has to key on the durable account rather than the rider id.
      userId: r.userId || null,
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

// `viewer` is optional. Passing one filters riders they have blocked (in either
// direction) out of the delayed layer. It is optional because the layer is built
// ONCE per 45s cycle and shared by every client — rebuilding per viewer would be
// wasteful when almost nobody has blocked anyone. The broadcast below only asks
// for a filtered build for the clients that actually have blocks.
//
// Without this the delayed layer contradicts what blocking promises: a blocked
// rider still surfaces there by name, car and city. Coarse and five minutes old,
// but still on the map the Terms say they disappear from.
function buildGlobalFC(viewer) {
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
      if (viewer && viewer.userId && it.userId &&
          store.blockedBetween(viewer.userId, it.userId)) continue;
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
    // The exception to "serialize once": a client who has blocked someone needs
    // that rider filtered out of the layer, which is a different FeatureCollection.
    // Kept to clients that actually have blocks so the common path is unchanged —
    // almost nobody has blocked anyone, and this runs for every client every 45s.
    if (hasBlocks(c)) {
      const own = buildGlobalFC(c);
      sendRaw(c, JSON.stringify({ t: 'global', fc: gated(c) ? anonymiseGlobal(own) : own }));
      continue;
    }
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
const ALLOWED_TOP = ['/', '/index.html', '/js', '/css', '/legal', '/convoy.apk', '/fonts', '/landing', '/packs'];

/* ---- landing page ----
   The marketing page lives under landing/ (index.html + img/) and is reached
   at /landing (and /about). The app itself stays at / — every OAuth redirect,
   magic link and Android App Link points at the root, so the landing page is
   a sibling, never a replacement. Same shape as the legal pages: a clean path
   rewritten to a file inside an allowlisted directory. */
const LANDING_PAGES = {
  '/landing': 'landing/index.html',
  '/landing/': 'landing/index.html',
  '/about': 'landing/index.html'
};

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
/* ---- iOS Universal Links ----
   The iOS half of the same arrangement: /.well-known/apple-app-site-association
   lets the iPhone app claim the /l/… links, given the associated-domains
   entitlement in ios/App/App/App.entitlements. Apple identifies the app as
   <TEAMID>.<bundle id> — set APPLE_APP_IDS to that (comma list if several
   builds are signed by different teams). Unset ⇒ 404, and the links keep
   opening in Safari, which still works. */
const APPLE_APP_IDS = (process.env.APPLE_APP_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ANDROID_FINGERPRINTS = (process.env.ANDROID_CERT_SHA256 ||
  '0F:B0:BB:9D:6D:99:D0:40:E2:C7:3C:44:AF:96:90:F6:C2:63:76:C6:EB:23:FB:8B:D5:02:00:B9:21:4D:1E:08')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
  '.apk': 'application/vnd.android.package-archive',  // downloadable Android build (/convoy.apk)
  '.woff2': 'font/woff2',  // self-hosted boot fonts (cycle 19, /fonts/*.woff2)
  '.webp': 'image/webp'    // landing-page screenshots (/landing/img/*.webp)
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
//
// The jsDelivr entries are FILE-PINNED, not origin-wide: an allowlist of the
// whole host lets a compromise (or a typo) of ANY package on the CDN execute as
// Convoy, while these exact five URLs are the only things the app actually
// loads from it — maplibre-gl + tfjs/nsfwjs (see index.html and js/ui.js's
// loadScript calls). Bumping one of those versions means editing it HERE and in
// index.html/www/index.html; test/serverpolicy.test.js pins the pairing so a
// half-done bump fails loudly. Note CSP path matching is exact including the
// absence of a query string — which is how the app loads these, no ?v= on CDN
// URLs (the stamp only decorates same-origin assets).
const CSP = process.env.CSP !== undefined ? process.env.CSP : [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // maplibre-gl + tfjs/nsfwjs (jsDelivr, exact files); wasm-unsafe-eval is required by tfjs.
  "script-src 'self' https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.js https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/dist/browser.min.js https://cdn.jsdelivr.net/npm/nsfwjs@2.4.2/dist/nsfwjs.min.js 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",              // maplibre spawns blob workers
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.min.css",
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
  // (and a failed response poisons the layer). writeHead() still wins
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
  // Google, and the map layers talk to a fixed set of
  // APIs. Note there is no 'unsafe-inline' for script-src: index.html has no
  // inline <script>, so nothing needs it. Inline STYLE attributes are used
  // throughout (paint swatches, marker sizing), hence 'unsafe-inline' there.
  // Vendoring maplibre + tfjs locally would let script-src collapse to 'self'.
  if (CSP) res.setHeader('Content-Security-Policy', CSP);

  // CORS preflight — the native app POSTs JSON cross-origin, which the WebView
  // gates behind an OPTIONS preflight. Answer it for every path with the CORS
  // headers so the real request is allowed to proceed.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  /* ---- the master kill switch (admin panel → Flags → app) ----
     Placed HERE, above every route, so killing the app does not depend on any
     downstream handler still working — that is the whole point of a kill
     switch. Two deliberate holes:

       /api/health  a monitor must be able to tell "off on purpose" from
                    "the box is dead", and this is the endpoint that says so.
       /api/ota     the OTA channel is the recovery path. Cutting it off
                    during a kill would mean the one way to ship the fix that
                    ends the outage is itself switched off. It has its OWN
                    flag (`ota`) for when the channel is the problem.

     Static assets keep serving: the app shell loads and shows its offline
     state rather than a browser error page, which is a better outage than a
     dead host. /admin is not under /api and is never gated — locking the
     operator out of the switch they just flipped is not an option. */
  if (urlPath.indexOf('/api/') === 0 && urlPath !== '/api/health' && urlPath !== '/api/ota' &&
      !flags.pick('app', true)) {
    res.writeHead(503, Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // Riders' clients back off on 503; tell them how long rather than
      // letting every app in the fleet retry as fast as it likes.
      'Retry-After': '120'
    }, CORS_HEADERS));
    res.end(JSON.stringify({ error: 'Convoy is down for maintenance', maintenance: true }));
    return;
  }

  // Liveness + kill-switch state, in one cheap unauthenticated call. Says
  // nothing an attacker can use (no versions, no counts) and stays answering
  // while the master switch is off, which is exactly when it is needed.
  if (urlPath === '/api/health') {
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json', 'Cache-Control': 'no-store'
    }, CORS_HEADERS));
    res.end(JSON.stringify({ ok: true, maintenance: !flags.pick('app', true) }));
    return;
  }

  // The admin control panel (/admin/**). Mounted BEFORE the static tree so it
  // can never be shadowed by a file, and it 404s as if it did not exist when
  // ADMIN_TOKEN is unset — an unconfigured panel should not advertise itself.
  if (admin.handles(urlPath)) {
    // handle() catches its own errors into an HTML error page; the .catch is
    // for the pathological case where even that fails, so a broken panel can
    // never take the process down with an unhandled rejection.
    admin.handle(req, res, urlPath, clientIp(req)).catch((e) => {
      console.error('[admin] unhandled:', e && e.message);
      try { res.writeHead(500); res.end('Admin error'); } catch (e2) { /* already sent */ }
    });
    return;
  }

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
      // Free the in-flight slot FIRST, whether or not anyone is still listening:
      // an aborting client must not permanently burn one of its concurrent-synth
      // slots (server-022, the ordering is the subtle part).
      ttsRelease(ip);
      // The rider can drive out of the tab (or background the app) mid-synth;
      // writing headers to a response the client already destroyed throws out
      // of this async callback and lands in uncaughtException. Nothing to send
      // to, so just stop.
      if (res.writableEnded || res.destroyed) return;
      if (err || !buf) { res.writeHead(503); res.end('synth failed'); return; }
      res.writeHead(200, Object.assign({ 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' }, CORS_HEADERS));
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }

  if (urlPath.indexOf('/api/') === 0) {
    handleApi(req, res, urlPath).catch((e) => { try { json(res, 500, { error: 'Server error' }); } catch (e2) {} });
    return;
  }

  // OTA bundle download (binary zip, so like the tiles it bypasses the JSON
  // router). ota.bundlePath() only resolves filenames the current or a
  // historical manifest vouched for — there is no on-disk path a request can
  // name that the operator did not publish. Immutable caching: a bundle file
  // name embeds its version and its content is checksum-pinned in the
  // manifest, so a cached copy can never go stale-and-wrong, only stale.
  // Bodies ship with CORS headers like everything else — the download itself
  // is native HttpURLConnection (no CORS), but the WebView diagnostics probe
  // and any future browser tooling can then read metadata from HEAD requests.
  const otaZip = urlPath.match(/^\/ota\/([A-Za-z0-9._-]+\.zip)$/);
  if (otaZip) {
    const ip = clientIp(req);
    if (!rateOk('otaz:' + ip, 20, 60 * 1000)) { res.writeHead(429); res.end('rate limited'); return; }
    const p = ota.bundlePath(otaZip[1]);
    if (!p) { res.writeHead(404); res.end('Not found'); return; }
    fs.stat(p, (stErr, st) => {
      if (stErr || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, Object.assign({
        'Content-Type': 'application/zip',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable'
      }, CORS_HEADERS));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(p).on('error', () => { try { res.end(); } catch (e) {} }).pipe(res);
    });
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
  if (urlPath === '/.well-known/apple-app-site-association') {
    if (!APPLE_APP_IDS.length) { res.writeHead(404); res.end('Not found'); return; }
    // No file extension by Apple's spec; served as JSON. Only the /l/ links are
    // claimed — claiming "/" would route every website link into the app.
    const body = JSON.stringify({
      applinks: {
        apps: [],
        details: [{ appIDs: APPLE_APP_IDS, components: [{ '/': '/l/*', comment: 'Mailed links: reset, verify, magic, change' }] }]
      },
      webcredentials: { apps: APPLE_APP_IDS }
    });
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    }, CORS_HEADERS));
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

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
  if (Object.prototype.hasOwnProperty.call(LANDING_PAGES, urlPath)) {
    urlPath = '/' + LANDING_PAGES[urlPath];
  }

  if (urlPath === '/') urlPath = '/index.html';
  // Feature packs (/packs/<id>/<file>) are the one static tree that is NOT
  // public: a file leaves this server only for a request carrying a signed,
  // unexpired token for that pack whose account still holds it. Decided before
  // the allowlist and before any stat, so a probe learns nothing about what is
  // on disk. See server/packs/index.js (staticOk) for the rule.
  if (urlPath === '/packs' || urlPath.indexOf('/packs/') === 0) {
    // A bare 403: browsers never heuristically cache one, and the cache policy
    // (server/httpcache.js) stays the only place that writes caching headers.
    if (!packs.staticOk(req, urlPath)) { res.writeHead(403); res.end('Forbidden'); return; }
  }
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

  // Stat first; read only when a body is actually going out. The cache policy
  // lives in server/httpcache.js (require-able, proven by real round-trips in
  // test/httpcache.test.js, which also lifts the block below and runs it):
  // stamped `?v=cyNNN` assets are cached for a year without revalidation,
  // everything unstamped — index.html, the legal pages, /convoy.apk — stays
  // `no-cache` but now carries an ETag, so a revalidation is a ~200-byte 304
  // instead of the body. index.html must NEVER be cached long-term: it is the
  // unstamped entry point that names the current stamp, and the policy keys on
  // the stamp alone — do not add a special case here, in either direction.
  // Any change to the block below must keep it self-contained (fs, path, req,
  // res, file, httpcache, MIME) or the executed test stops compiling it.
  const qAt = req.url.indexOf('?');
  fs.stat(file, (err, st) => {
    // A directory (e.g. /js) stats fine but is not a file: 404 it exactly as
    // fs.readFile's EISDIR used to, rather than minting it a validator.
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const meta = {
      stamped: httpcache.isStamped(qAt >= 0 ? req.url.slice(qAt + 1) : '') || httpcache.isImmutablePath(file),
      immutable: httpcache.IMMUTABLE_ENABLED,
      etag: httpcache.etagFor(st),
      mtime: st.mtime
    };
    if (httpcache.matchesEtag(req.headers['if-none-match'], meta.etag)) {
      // RFC 7232 §4.1: the 304 repeats Cache-Control / ETag / Last-Modified,
      // carries no body and — since nothing was read — no Content-Type.
      res.writeHead(304, httpcache.headersFor(meta));
      res.end();
      return;
    }
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      meta.type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, httpcache.headersFor(meta));
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
});

/* ================= websocket wiring ================= */
// 64KB: the client's hello/profile frames now include the profile photo
// (≤24KB base64). The old 8KB cap would hard-kill any socket that sent one.
//
// perMessageDeflate (P-E, T2.6b, cycle 12): every tick frame today crosses
// the network as raw JSON — `ws`'s server-side default for this option is
// `false`, and until this line nothing here ever set it. The client side
// needs ZERO changes: permessage-deflate is negotiated per-connection in the
// HTTP Upgrade handshake, and every client already deployed (Chrome, the
// Android WebView, Safari, node `ws`) advertises the extension by default —
// the server just has to accept it.
//
// `threshold: 0` is the load-bearing setting. `ws`'s own default threshold is
// 1024 bytes; our tick rows are ~150-500 bytes, so leaving the default would
// compress nothing and this whole change would measure a 0% improvement.
//
// The frugal-window choice (`serverMaxWindowBits: 11`, `zlibDeflateOptions`
// below) trades a slightly worse compression ratio for far less per-socket
// memory: a deflate context costs roughly (1 << (windowBits+2)) + (1 <<
// (memLevel+9)) bytes ~= 8KB + 64KB ~= 72KB, plus a small inflate context and
// Node's own per-stream chunk buffers -- call it ~100KB/connection. At
// MAX_CLIENTS=200 (:62) that is a worst case of roughly 20MB, which is why
// w11/m7 was chosen even though a synthetic-frame simulation this cycle
// measured `ws`'s w15/m8 default compresses marginally better on our exact
// row shape (0.243 vs 0.254 ratio) -- not worth 10x the memory for that gap.
// `concurrencyLimit` bounds how many deflate/inflate operations the libuv
// threadpool runs at once; zlib work happens off the event loop, so it never
// blocks a tick callback, but it does consume threadpool slots other work
// (file I/O, DNS) also needs.
//
// Traded away, recorded rather than hand-waved: (1) the ~100KB/connection
// memory above (bounded, see MAX_CLIENTS math); (2) a CRIME/BREACH-shaped
// side channel where an attacker who can inject chosen plaintext into a
// compressed stream alongside a secret can sometimes infer the secret from
// compressed-length changes. Tick frames carry no secrets (rider id/lat/lng/
// heading, all either public-to-viewers-in-scope or already known to the
// attacker if they're a rider themselves). The `hello` message's `m.token`
// (a Supabase JWT, read by userFromToken() at :382) DOES ride a WS data
// frame, but an attacker can't get a socket onto this server in the first
// place to mount a same-stream chosen-plaintext attack unless they're
// already on an allowlisted origin (verifyClient: wsOriginOk, above) --
// that origin check, not "tokens never cross the socket", is the actual
// mitigation here.
//
// WS_DEFLATE=0 is a same-code kill switch: revert by restarting the process
// with that env var set, no redeploy needed.
const WS_DEFLATE_OFF = process.env.WS_DEFLATE === '0';
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
  verifyClient: wsOriginOk,
  perMessageDeflate: WS_DEFLATE_OFF ? false : {
    threshold: 0,
    zlibDeflateOptions: { level: 6, memLevel: 7 },
    serverMaxWindowBits: 11,
    // Never force clientMaxWindowBits: some clients reject that negotiation
    // parameter outright and the WHOLE extension then fails to negotiate.
    // Let the client keep its own default.
    concurrencyLimit: 10
  }
});

// WS_ORIGINS: extra browser hosts allowed to open /ws. Pre-seeded with the
// deployment's own domain so the shipped config keeps the site working; add a
// comma list to open more (e.g. a second domain or a preview deploy).
const WS_EXTRA_ORIGINS = (process.env.WS_ORIGINS || 'odoreeci.tech,www.odoreeci.tech')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function wsOriginOk(info, cb) {
  // The realtime half of the master kill switch. Refused at the handshake, so
  // a killed server never accepts the socket in the first place — checking
  // inside the connection handler would still cost a full WS upgrade per
  // rider, and every app in the fleet retries.
  if (!flags.pick('app', true)) return cb(false, 503, 'maintenance');
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
    // Seat-resume token (server-035): sent only inside this socket's own welcome.
    resume: crypto.randomBytes(16).toString('hex'),
    ws,
    ip: clientIp(req),
    userId: null,
    username: null,
    profile: null,
    pos: null,
    heading: 0,
    mode: 'cruise',
    party: null,
    known: new Set(),
    wire: new Map(),   // per-rider wiregate memory — see server/wiregate.js
    lastPosAt: 0,
    micActive: false,
    ghost: false,
    packs: new Set(),  // feature packs this socket holds — filled by packs.onHello
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
  seatOwner.set(c.resume, c);

  ws.on('pong', () => { c.isAlive = true; });
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'hello' && !c.profile) return; // must say hello first
    // Global budget (server-024): a fixed 60s window and two integers on the
    // connection — O(1) per message, on purpose. rateOk() is the ONE throttling
    // mechanism everything else rides (U1 in test/serverpolicy.test.js), but it
    // .filter()s its timestamp array on every call: at an 1800/min budget that
    // is ~1800 array operations per message, so under the exact flood this gate
    // exists to stop, the limiter would become the amplifier. This is the one
    // deliberate exception to U1. The fields are initialised lazily here (the
    // first message sees msgWinStart undefined → NaN → a fresh window) rather
    // than in the connection literal, so nothing else has to know about them.
    // 'hello' is counted but never dropped: dropping it would break sign-in
    // during a reconnect storm, and hello floods are already bounded by
    // MAX_PER_IP plus the once-per-socket guard in the handler itself. Over
    // budget → drop the MESSAGE, keep the socket: every high-rate type (pos at
    // 1Hz) is superseded within a second, and disconnecting
    // a rider whose phone burped is worse than the flood. Logged once per
    // window so a real rider tripping it shows up in journalctl with a name
    // and the limit — WS_MSG_BUDGET in convoy.env is the dial.
    const now = Date.now();
    if (!(now - c.msgWinStart < WS_MSG_WINDOW_MS)) { c.msgWinStart = now; c.msgCount = 0; }
    c.msgCount++;
    if (c.msgCount > WS_MSG_BUDGET) {
      if (c.msgCount === WS_MSG_BUDGET + 1) {
        console.warn('[ws] ' + ((c.profile && c.profile.name) || c.id) + ' (' + c.ip + ') crossed WS_MSG_BUDGET (' +
          WS_MSG_BUDGET + ' msgs/min) — dropping the rest of this window');
      }
      if (m.t !== 'hello') return;
    }
    // Own properties only, and only callables: m.t comes off the wire, and a
    // bare lookup would hand back inherited Object.prototype members
    // ('constructor', 'toString', …) as if they were message handlers.
    // The core's own handlers first; then a pack's (server/packs/<id>.js),
    // which packs.wsHandler() wraps so it only runs for a socket whose account
    // holds that pack — for anyone else the frame is as unknown as a typo.
    const h = Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : packs.wsHandler(m.t);
    if (typeof h === 'function') {
      try { h(c, m); } catch (e) { console.error('[handler ' + m.t + ']', e.message); }
    }
  });
  ws.on('close', () => {
    packs.onClose(c);
    seatOwner.delete(c.resume);
    // Hold the seat FIRST: a held seat makes the leave silent and posts "lost
    // signal" instead of "left the convoy" (server-035).
    const held = rememberSeat(c, Date.now());
    if (c.party) leaveParty(c, held);
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
/* What a pack's server half (server/packs/<id>.js) may reach. Deliberately a
   named surface rather than the module scope: a pack that needs something
   not listed here adds it HERE, in one line, where the next reader can see
   what the packs lean on. Everything is live (the Maps are the real ones). */
const packCtx = {
  clients, parties, online, bots,
  humans, getRider, riderRecord, riderName, clientByUserId,
  send, defer, rateOk, validPos, num, cleanText, sanitizeProfile, clientIp,
  blockedPair, scopeFor, syncScope, ensureKnown, liteOf, sendPartyState, partySys,
  joinParty, leaveParty, friendsPayload, notifyFriendsOf, buildGlobalFC, anonymiseGlobal, gated,
  json, readBody, bearer, userFromToken, liveClaims, CORS_HEADERS,
  store, db, flags, tomtom, B,
  MAX_PARTY, NEARBY_KM, TICK_MS, FAST_MS,
  packs
};

(async function boot() {
  if (!sb.configured()) {
    console.error('[boot] Supabase Auth is not configured.');
    console.error('[boot] Set SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env (see .env.example).');
    process.exit(1);
  }
  try {
    await store.init();
  } catch (e) {
    // A `systemctl restart` that lands mid-boot runs shutdown(), which ends the
    // pool under this await; the rejection that produces ("Cannot use a pool
    // after calling end on the pool") is indistinguishable from a dead
    // database unless we ask first. Return — shutdown() owns the exit from
    // here (it has its own 5 s force-exit safety net) — instead of exit(1),
    // which logged a spurious status=1/FAILURE and sent the operator hunting
    // for a SUPABASE_DB_URL problem that does not exist (server-033).
    // `shuttingDown` is declared ~190 lines below, next to shutdown(); that is
    // safe because this catch can only run after the await above, by which
    // time the whole module body (that `let` included) has executed — do not
    // "fix" it by moving the declaration.
    if (shuttingDown) { console.log('[boot] aborted — shutting down before the database was ready'); return; }
    console.error('[boot] could not reach the Supabase database: ' + e.message);
    console.error('[boot] Check SUPABASE_DB_URL in server/.env.');
    process.exit(1);
  }
  // Without a key set, verify() rejects EVERY access token: the server would
  // come up looking healthy while silently logging out the entire user base and
  // 401-ing every request until a later refresh happened to succeed. The comment
  // above has always said this is a boot requirement — enforce it.
  const jwksOk = await sb.loadJwks(true);
  // Same race as the catch above, one await later: a restart during this fetch
  // must not be reported as a JWKS outage.
  if (shuttingDown) { console.log('[boot] aborted — shutting down before the JWKS was loaded'); return; }
  if (!jwksOk) {
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

  // OTA channel: reads DATA_DIR/ota/manifest.json (re-read on mtime change per
  // request, so hotfix pushes land without a restart). Never fatal — no
  // manifest just means the channel is off and APKs keep their bundled assets.
  try { ota.init(); } catch (e) { console.error('[boot] OTA channel unavailable:', e.message); }

  // Feature packs: read packs/*/pack.json and server/packs/*.js. Fatal on a
  // malformed pack — a pack that half-loads is a rider-visible feature that
  // errors, and the fix is a file name away.
  try { packs.init(packCtx, handlers); } catch (e) { console.error('[boot] feature packs: ' + e.message); process.exit(1); }

  // Runtime flag overrides, read from DATA_DIR/flags.json. Must come up BEFORE
  // the listener: booting with the master switch forced off and then serving
  // normally for a second would defeat the switch.
  try { flags.init(); } catch (e) { console.error('[boot] flag store unavailable:', e.message); }
  if (!flags.pick('app', true)) {
    console.warn('[boot] ⚠  MASTER KILL SWITCH IS ON — /api/* answers 503 and sockets are refused.');
    console.warn('[boot]    Clear it at /admin/flags, or delete "app" from DATA_DIR/flags.json.');
  }

  // Play publishing. Never fatal: an unconfigured service account means the
  // panel's Play page explains itself and refuses, which is the correct
  // behaviour for a server that has no business talking to Google.
  try { play.init(); } catch (e) { console.error('[boot] Play publishing unavailable:', e.message); }

  /* The admin control panel. Everything it needs from this module is handed
     over explicitly rather than exported — the panel gets a capability, not a
     handle on the server's internals. */
  admin.init({
    snapshot: () => ({ clients: clients.size, parties: parties.size }),
    // Close a rider's live sockets. Used by ban and delete: without it a
    // banned rider keeps their socket (and their pin on everyone's map) until
    // they happen to disconnect, because auth is checked at connect time.
    kick: (userId) => {
      let n = 0;
      for (const c of clients.values()) {
        if (c.userId && c.userId === userId) {
          try { c.ws.send(JSON.stringify({ t: 'err', msg: 'Signed out by an administrator' })); } catch (e) { }
          try { c.ws.close(); } catch (e) { }
          n++;
        }
      }
      return n;
    },
    /* A serialisable snapshot of everyone currently connected, for the panel's
       presence map. Built here rather than handing the panel the `clients` Map
       directly: `ws` is a live socket and `known` is a per-rider scope Set,
       neither of which has any business leaving this module.

       Ghosted riders ARE included. Ghost mode hides a rider from OTHER RIDERS
       (scopeFor / buildGlobalFC); it was never a promise that the operator of
       the service cannot see them, and an operator who cannot see a ghosted
       rider cannot act on a report about one. The map labels them as ghosted
       so that override is visible rather than silent. */
    riders: () => {
      const now = Date.now();
      const out = [];
      for (const c of clients.values()) {
        if (!c.profile) continue;            // still mid-handshake, not a rider yet
        out.push({
          id: c.id,
          userId: c.userId || null,
          username: c.username || (c.profile && c.profile.name) || 'guest',
          guest: !c.userId,
          bot: false,
          pos: validPos(c.pos) ? [c.pos[0], c.pos[1]] : null,
          heading: c.heading || 0,
          mode: c.mode === 'parked' ? 'parked' : 'cruise',
          ghost: !!c.ghost,
          party: c.party || null,
          mic: !!c.micActive,
          ageMs: c.lastPosAt ? now - c.lastPosAt : null,
          ip: c.ip || ''
        });
      }
      // Simulated riders (BOTS=N) ride along, flagged. An operator looking at a
      // busy map must be able to tell which pins are real; on the production
      // default (BOTS=0) this loop does nothing.
      for (const b of bots.values()) {
        out.push({
          id: b.id, userId: null, username: b.name || 'bot', guest: false, bot: true,
          pos: validPos(b.pos) ? [b.pos[0], b.pos[1]] : null,
          heading: b.heading || 0, mode: b.mode === 'parked' ? 'parked' : 'cruise',
          ghost: false, party: b.party || null, mic: false,
          ageMs: 0, ip: ''
        });
      }
      return out;
    },
    parties: () => {
      const out = [];
      for (const [pid, p] of parties) {
        out.push({ id: pid, code: p.code || '', members: (p.members || []).length });
      }
      return out;
    },
    sanitizeProfile, validUsername, validPassword, validEmail,
    // A grant or revoke from the panel reaches a live socket now: its pack set
    // is recomputed and the client told to resync (js/packs.js) — a revoked
    // pack's frames are dropped from this moment, loaded code or not.
    kickPacks: (userId) => {
      const c = online.get(userId);
      const u = store.getById(userId);
      if (!c || !u) return 0;
      packs.onHello(c, u);
      send(c, { t: 'packs', packs: packs.packsForSocket(c) });
      return 1;
    },
    tomtomKeyed: () => tomtom.hasKey(),
    telemetryOn: () => TELEMETRY_ON,
    // Cookies get Secure only on an https deployment; setting it on a plain
    // http dev server would make the session cookie silently undeliverable
    // and the panel unusable exactly where it is most often tested.
    secure: /^https:/i.test(process.env.APP_URL || '')
  });

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
  // Also into the telemetry rollup: a server that is quietly throwing is a
  // worse day for riders than a WebView that is, and it would be strange for
  // the dashboard to show only the client half.
  try { telemetry.serverError('unhandledRejection', reason); } catch (e) { /* never re-throw here */ }
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err.message || err));
  try { telemetry.serverError('uncaughtException', err); } catch (e) { /* never re-throw here */ }
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
    // AWAIT this. store.flush() is async, and firing it un-awaited immediately
    // before process.exit(0) meant the write never ran — and the process-'exit'
    // flushSync fallback couldn't cover for it either. Net effect: every
    // account and password change from the last ~800ms before a restart was
    // silently discarded.
    try { await store.flush(); } catch (e) { console.error('[shutdown] store flush:', e.message); }
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
