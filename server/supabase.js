/* Convoy — Supabase Auth (GoTrue) client + access-token verification.

   Identity lives in Supabase Auth. GoTrue owns passwords, sessions and refresh
   tokens; this module is the only place that talks to it.

   WHY THE SERVER PROXIES GOTRUE INSTEAD OF THE BROWSER CALLING IT DIRECTLY:
   Convoy began username-only. GoTrue requires an email (or phone) per account,
   so a username with no address of its own is mapped to a synthetic one,
   <username>@<AUTH_EMAIL_DOMAIN>, which can never receive mail — making the
   normal /signup + confirmation flow unusable. Such accounts MUST be created
   through the admin API with email_confirm:true, which needs the secret key.
   Routing register/login through our own /api keeps that key on the server and
   keeps the existing per-IP and per-account rate limits in force.

   REAL ADDRESSES now exist alongside those. An account may carry a genuine
   email (registered with one, or supplied by an OAuth provider), in which case
   THAT is the address GoTrue holds and the synthetic one is never minted for it.
   Nothing here decides which an account has — store.js does, via loginEmail().
   Convoy still sends its own mail through Resend (mailer.js) rather than
   GoTrue's SMTP, so the admin/confirmed creation path is unchanged.

   The client still ends up holding a real Supabase session (access + refresh
   token) and every authenticated request carries a real Supabase JWT.
*/
'use strict';

const crypto = require('crypto');

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
// Modern secret key (sb_secret_…) or a legacy service_role JWT — either works as
// both the apikey and the admin bearer.
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// Legacy symmetric projects sign with HS256 against this shared secret. Projects
// created after ~2025-05 use asymmetric ES256/RS256 keys and need no secret here.
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
// Synthetic email domain. Never receives mail — it only satisfies GoTrue's
// requirement that every account has an identifier of some kind.
const EMAIL_DOMAIN = process.env.AUTH_EMAIL_DOMAIN || 'users.convoy.local';
const AUTH_URL = URL_BASE ? URL_BASE + '/auth/v1' : '';
const REQUEST_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '10000', 10);

// GoTrue meters /token (sign-in AND refresh) BY IP ADDRESS, with a token bucket
// of capacity 30. Every call from this module leaves the same VPS, so without
// forwarding the real caller's address the ENTIRE user base shares one bucket:
// a few dozen sign-ins, or the hourly refresh of a few dozen live sessions, and
// everyone starts getting 429s. Sb-Forwarded-For makes GoTrue meter the actual
// client instead - which also makes its own brute-force protection work
// per-attacker rather than per-server.
//
// Two hard requirements, both from Supabase: the header is only honoured for a
// modern sb_secret_ key (legacy anon/service_role JWTs are not supported), and
// the project must have IP Address Forwarding switched on under
// Dashboard -> Authentication -> Rate Limits. Sending it while that is off is
// harmless - GoTrue ignores the header rather than rejecting the request - so
// this defaults on whenever the key shape can support it. SUPABASE_FORWARD_IP=0
// suppresses it.
const FORWARD_IP = process.env.SUPABASE_FORWARD_IP === '0'
  ? false
  : SECRET_KEY.indexOf('sb_secret_') === 0;

function configured() { return !!(AUTH_URL && SECRET_KEY); }
function forwardsIp() { return FORWARD_IP; }

// Usernames are already validated to /^[A-Za-z0-9_]{3,20}$/ before they get here,
// so no escaping is needed — but lowercase so the address is stable regardless of
// how the user cased their name.
function emailFor(username) { return String(username).toLowerCase() + '@' + EMAIL_DOMAIN; }

/* ---------------- HTTP ---------------- */

// Every GoTrue call goes through here. Returns { status, body } and never throws
// for a non-2xx — callers decide what a given status means. A network failure or
// timeout DOES throw, so it surfaces as a 500 rather than being mistaken for a
// rejected credential.
async function call(pathname, opts) {
  opts = opts || {};
  if (!configured()) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
  const headers = {
    'apikey': SECRET_KEY,
    'Authorization': 'Bearer ' + (opts.bearer || SECRET_KEY),
    'Content-Type': 'application/json'
  };
  // See FORWARD_IP above - without this every caller shares one rate-limit bucket.
  if (FORWARD_IP && opts.ip) headers['Sb-Forwarded-For'] = opts.ip;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(AUTH_URL + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error('Supabase Auth unreachable: ' + (e.name === 'AbortError' ? 'timed out' : e.message));
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; } // 204s and empty bodies
  return { status: res.status, body: body || {} };
}

// GoTrue reports errors under several shapes depending on version and endpoint
// (error_description, msg, message, error). Collapse them so callers log one thing.
function errText(body) {
  if (!body) return 'unknown error';
  return body.error_description || body.msg || body.message || body.error || JSON.stringify(body);
}

// The machine-readable half of a GoTrue error ('email_exists', 'weak_password',
// 'invalid_credentials', ...). This is the ONLY reliable way to tell those apart:
// GoTrue returns several unrelated failures under the same HTTP status, and the
// prose in msg changes between versions. Note that `code` is the numeric status
// on some responses, so only a string counts.
function errCode(body) {
  if (!body) return '';
  const c = body.error_code || body.code;
  return typeof c === 'string' ? c : '';
}

/* ---------------- account lifecycle (admin) ---------------- */

// Create a confirmed account. Returns { user } | { error, status }.
//
// `email` is OPTIONAL: pass a real address to register with one, or omit it for
// the original username-only account, which gets the synthetic
// <username>@AUTH_EMAIL_DOMAIN address instead.
//
// email_confirm:true either way, and that is deliberate even for a real address.
// The synthetic one can't receive a confirmation mail at all, so without it a
// legacy account could never sign in — and for a real address Convoy runs its
// OWN verification (mailer.js + the email_tokens table, surfaced as
// profiles.email_verified) rather than GoTrue's, so that a rider who mistypes
// their address at signup is not locked out of the account they just created.
// Nothing that depends on owning the address unlocks until OUR flag is set.
async function createUser(username, password, ip, email) {
  const r = await call('/admin/users', {
    method: 'POST',
    ip: ip,
    body: {
      email: email || emailFor(username),
      password: password,
      email_confirm: true,
      // app_metadata is server-controlled and safe to trust later; user_metadata
      // is user-editable via GoTrue, so the username must NOT live there.
      app_metadata: { username: username, convoy: true }
    }
  });
  if (r.status === 200 || r.status === 201) return { user: r.body };
  // 422 is NOT a synonym for "taken". GoTrue returns it for a duplicate account
  // (email_exists) AND for a password its own rules rejected (weak_password -
  // which is what leaked-password protection and a raised minimum length both
  // surface as). Treating them alike sends someone off to invent a new username
  // over a problem that has nothing to do with their name, so branch on the
  // error_code and keep the two apart.
  const code = errCode(r.body);
  if (code === 'email_exists' || code === 'phone_exists' || r.status === 409) {
    return { error: 'taken', status: r.status };
  }
  if (code === 'weak_password') {
    return { error: 'weak-password', status: r.status, detail: errText(r.body) };
  }
  // Builds predating error_code: fall back to the prose. GoTrue's own wording is
  // "...has already been registered", which does NOT contain "already registered".
  /* A raw Postgres unique-violation on GoTrue's own users table.

     GoTrue's duplicate check is itself a check-then-insert, so two requests for
     the same identifier arriving together both pass the check and the SECOND
     fails on the index — surfacing 'duplicate key value violates unique
     constraint "users_email_partial_key"' as a 500 instead of the tidy
     email_exists above.

     That is still "taken", and it matters because the identifier is usually the
     SYNTHETIC <username>@users.convoy.local address: a username-only account has
     no real email, so a duplicate USERNAME collides on GoTrue's email index.
     Unclassified, it fell through to the generic branch and /api/register
     answered 502 "Could not create the account — try again" rather than "That
     username is taken". Double-tapping Create account on a slow connection is
     exactly this race.

     Checked OUTSIDE the `if (!code)` fallback below, deliberately: a 500 carries
     an error_code of its own (unexpected_failure), so a check that only ran when
     GoTrue supplied no code would never see this. The message is unambiguous
     either way. Matched narrowly, so a duplicate-key on an unrelated constraint
     is not reported as a taken identifier. */
  const raw = errText(r.body).toLowerCase();
  if (raw.indexOf('duplicate key') >= 0 &&
      (raw.indexOf('users_email') >= 0 || raw.indexOf('users_phone') >= 0 ||
       raw.indexOf('users_pkey') >= 0)) {
    return { error: 'taken', status: r.status };
  }
  if (!code) {
    if (raw.indexOf('already been registered') >= 0 || raw.indexOf('already registered') >= 0 ||
        raw.indexOf('already exists') >= 0) return { error: 'taken', status: r.status };
  }
  return { error: errText(r.body), status: r.status };
}

// TRUE means the user is gone from GoTrue — which includes 404, because "there
// is no such user" is the end state this call exists to reach, and treating it
// as a failure would leave authresidue.js retrying an id forever.
//
// Every other non-2xx is a real failure and must be reported as one: this
// returns a boolean and only THROWS when GoTrue is unreachable, so a caller that
// watches for an exception (as store.deleteAccount used to) sees a 500 as
// success and tells the rider their account is gone while it is not.
async function deleteUser(id) {
  const r = await call('/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
  return (r.status >= 200 && r.status < 300) || r.status === 404;
}

// Set a new password as admin (used by the recovery-code reset, which has already
// proven ownership by burning a valid code).
async function setPassword(id, password, ip) {
  const r = await call('/admin/users/' + encodeURIComponent(id), {
    method: 'PUT', ip: ip, body: { password: password }
  });
  if (r.status === 200) return { ok: true };
  // Same trap as createUser: a password GoTrue considers weak comes back here,
  // and must not be reported as a generic server fault the user can only retry.
  if (errCode(r.body) === 'weak_password') {
    return { error: 'weak-password', status: r.status, detail: errText(r.body) };
  }
  return { error: errText(r.body), status: r.status };
}

/* ---------------- sessions ---------------- */

// Password grant against a literal address. Returns { session } | { error }.
// A 400 here is a bad password, not a server fault, so it maps to 401 at the
// API layer.
async function signInEmail(email, password, ip) {
  const r = await call('/token?grant_type=password', {
    method: 'POST', ip: ip, body: { email: email, password: password }
  });
  if (r.status === 200 && r.body.access_token) return { session: r.body };
  return { error: errText(r.body), status: r.status };
}

// Sign in a username-only account. Accounts registered with a real address are
// signed in through store.js, which resolves the username to the address GoTrue
// actually holds and calls signInEmail directly — this stays as the path for
// legacy accounts, whose GoTrue address IS emailFor(username).
async function signIn(username, password, ip) {
  return signInEmail(emailFor(username), password, ip);
}

// Move an account to a different address, as admin.
//
// email_confirm:true ALWAYS, and it does not mean "Convoy believes this address
// is theirs" — it means "GoTrue must not block sign-in over it". GoTrue refuses
// to authenticate an unconfirmed address, so leaving it false here would lock a
// rider out of their own account the moment they attached an address to it.
// Convoy tracks real ownership separately, in profiles.email_verified, and that
// is the flag every email-dependent feature is gated on.
async function updateEmail(id, email, ip) {
  const r = await call('/admin/users/' + encodeURIComponent(id), {
    method: 'PUT', ip: ip, body: { email: email, email_confirm: true }
  });
  if (r.status === 200) return { user: r.body };
  const code = errCode(r.body);
  if (code === 'email_exists' || r.status === 409) return { error: 'taken', status: r.status };
  return { error: errText(r.body), status: r.status };
}

/* ---------------- control panel (admin) ----------------
   The admin panel's account powers that GoTrue itself enforces. */

// Ban / unban. Banning revokes the user's ability to authenticate: token
// verification fails for banned users, so API bearer calls 401 and the WS
// hello is rejected — the account's DATA stays intact (a ban is containment,
// not deletion). '876000h' is GoTrue's idiom for "a very long time"; 'none'
// lifts it. Convoy keeps an advisory mirror in the panel for display, but
// GoTrue is the enforcer.
async function setBanned(id, banned, ip) {
  const r = await call('/admin/users/' + encodeURIComponent(id), {
    method: 'PUT', ip: ip,
    body: { ban_duration: banned ? '876000h' : 'none' }
  });
  if (r.status === 200) return { ok: true };
  return { error: errText(r.body), status: r.status };
}

// Sync the username GoTrue carries in app_metadata (used to recognise convoy
// accounts server-side) after a panel rename. PUT merges app_metadata keys,
// so sending {username} leaves every other metadata key alone.
async function updateUsernameMeta(id, username, ip) {
  const r = await call('/admin/users/' + encodeURIComponent(id), {
    method: 'PUT', ip: ip, body: { app_metadata: { username: username } }
  });
  if (r.status === 200) return { ok: true };
  return { error: errText(r.body), status: r.status };
}

/* ---------------- one-time tokens (admin) ----------------
   Convoy mails its OWN links (mailer.js), so it never uses GoTrue's templates.
   But minting a SESSION for someone who has proven ownership of an address
   without knowing their password — passwordless sign-in — is something only
   GoTrue can do. The two calls below are that path:

     generateLink('magiclink', email) -> hashed_token   (no mail is sent; GoTrue
       only sends when its own SMTP is configured, which ours is not)
     verifyOtp('magiclink', hashed_token, email)        -> a real session

   We keep the hashed_token server-side against our own opaque token, so the
   thing that travels through the rider's inbox is ours and expires on our
   schedule. */

async function generateLink(type, email, ip) {
  const r = await call('/admin/generate_link', {
    method: 'POST', ip: ip, body: { type: type, email: email }
  });
  if (r.status === 200 && (r.body.hashed_token || (r.body.properties && r.body.properties.hashed_token))) {
    // Shape moved between GoTrue versions: flat on older builds, nested under
    // `properties` on newer ones.
    const props = r.body.properties || r.body;
    return { hashedToken: props.hashed_token, actionLink: props.action_link || r.body.action_link };
  }
  return { error: errText(r.body), status: r.status };
}

async function verifyOtp(type, token, email, ip) {
  const r = await call('/verify', {
    method: 'POST', ip: ip, body: { type: type, token: token, email: email }
  });
  if (r.status === 200 && r.body.access_token) return { session: r.body };
  return { error: errText(r.body), status: r.status };
}

/* ---------------- project settings ----------------
   GET /settings reports, among other things, which external providers the
   PROJECT has switched on — the half of social sign-in that lives in the
   dashboard and has no code equivalent. Listing a provider in OAUTH_PROVIDERS
   without enabling it there sends the browser to /authorize and gets back a raw
   GoTrue error page ("Unsupported provider: provider is not enabled"), which is
   the worst possible place to discover a config gap. Reading it here lets the
   server refuse, and warn at boot, instead.

   Cached with a TTL because it is read on an anonymous, frequently-hit route.
   A failed fetch leaves the previous answer in place and reports failure, so
   callers can decide to fall back rather than drop every button. */

let extProviders = null;      // { google: true, github: false, … } | null when never loaded
let settingsFetchedAt = 0;
let settingsInFlight = null;
const SETTINGS_TTL_MS = 10 * 60 * 1000;

async function loadSettings(force) {
  if (!AUTH_URL) return false;
  if (!force && extProviders && Date.now() - settingsFetchedAt < SETTINGS_TTL_MS) return true;
  if (settingsInFlight) return settingsInFlight;
  settingsInFlight = (async () => {
    let ok = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(AUTH_URL + '/settings', {
        headers: SECRET_KEY ? { apikey: SECRET_KEY, Authorization: 'Bearer ' + SECRET_KEY } : {},
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!body || typeof body.external !== 'object' || !body.external) {
        throw new Error('settings response had no provider list');
      }
      extProviders = body.external;
      settingsFetchedAt = Date.now();
      ok = true;
    } catch (e) {
      console.error('[supabase] could not read project settings:', e.message);
    } finally {
      clearTimeout(timer);
      settingsInFlight = null;
    }
    return ok;
  })();
  return settingsInFlight;
}

// TRUE / FALSE per the dashboard, or NULL when we have never managed to read the
// settings. Null is deliberately distinct from false: callers fall back to
// trusting their own configuration rather than hiding every sign-in button over
// a network blip.
function providerEnabled(name) {
  if (!extProviders) return null;
  return !!extProviders[String(name || '').toLowerCase()];
}

/* ---------------- OAuth ---------------- */

// The URL the BROWSER is sent to in order to start a provider sign-in. Not a
// call — GoTrue answers this one with a 302 to the provider, so it has to be a
// real navigation rather than a fetch. PKCE: we hold the verifier (see
// oauth.js) and only send its hash, so an intercepted redirect carrying the
// authorization code is useless without this server.
function authorizeUrl(provider, redirectTo, codeChallenge, scopes) {
  const q = new URLSearchParams({
    provider: provider,
    redirect_to: redirectTo,
    code_challenge: codeChallenge,
    code_challenge_method: 's256'
  });
  if (scopes) q.set('scopes', scopes);
  return AUTH_URL + '/authorize?' + q.toString();
}

// Trade the authorization code from the redirect for a session.
async function exchangePkce(authCode, verifier, ip) {
  const r = await call('/token?grant_type=pkce', {
    method: 'POST', ip: ip, body: { auth_code: authCode, code_verifier: verifier }
  });
  if (r.status === 200 && r.body.access_token) return { session: r.body };
  return { error: errText(r.body), status: r.status };
}

/* ---------------- the signed-in rider's own GoTrue record ---------------- */

// GET /user as the rider. This is the only way to see their linked identities
// (google, apple, email, …) — the admin read doesn't expose them in a stable
// shape across versions.
async function getUser(accessToken, ip) {
  const r = await call('/user', { bearer: accessToken, ip: ip });
  if (r.status === 200 && r.body.id) return { user: r.body };
  return { error: errText(r.body), status: r.status };
}

// Drop a linked provider. GoTrue refuses to remove the last identity on an
// account, which is exactly the guard we want — it stops a rider unlinking
// their only way back in.
async function unlinkIdentity(accessToken, identityId, ip) {
  const r = await call('/user/identities/' + encodeURIComponent(identityId), {
    method: 'DELETE', bearer: accessToken, ip: ip
  });
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { error: errText(r.body), status: r.status };
}

async function refresh(refreshToken, ip) {
  const r = await call('/token?grant_type=refresh_token', {
    method: 'POST', ip: ip, body: { refresh_token: refreshToken }
  });
  if (r.status === 200 && r.body.access_token) return { session: r.body };
  return { error: errText(r.body), status: r.status };
}

// Revoke sessions. scope 'global' kills every session for the user (used after a
// password change), 'local' just this one (used by sign-out). Best-effort: a
// failure here must not block the operation that triggered it.
async function signOut(accessToken, scope, ip) {
  try {
    const r = await call('/logout?scope=' + (scope === 'global' ? 'global' : 'local'), {
      method: 'POST', bearer: accessToken, ip: ip
    });
    return r.status >= 200 && r.status < 300;
  } catch (e) {
    console.error('[supabase] signOut:', e.message);
    return false;
  }
}

/* ---------------- access-token verification ----------------
   Verified LOCALLY against the project's JWKS — no network round-trip per
   request, which matters because every websocket 'hello' and every /api call
   runs through it. The public keys are refreshed in the background so
   verify() stays synchronous and the existing sync call sites are unchanged.

   Supabase caches this endpoint for 10 minutes and warns against caching it for
   longer, or key revocation is delayed; we re-fetch on that same cadence. */

let jwks = new Map();          // kid -> crypto.KeyObject
let jwksFetchedAt = 0;
let jwksForcedAt = 0;
let jwksInFlight = null;
const JWKS_TTL_MS = 10 * 60 * 1000;
// Floor between FORCED refreshes. A forced refresh is triggered by an
// unrecognised kid - i.e. by anything presenting a token we cannot place, which
// includes a flood of junk. jwksInFlight only collapses refreshes that overlap,
// so without this floor each successive wave of requests starts another fetch
// against an endpoint that is itself IP-rate-limited, precisely when it is
// already unhealthy.
const JWKS_FORCE_MIN_MS = 30 * 1000;

// Resolves TRUE only if a usable key set is now loaded. Callers that must not
// continue without one (boot) have to check it - this deliberately does not
// throw, because the periodic refresh treats a failure as "try again later".
async function loadJwks(force) {
  if (!URL_BASE) return false;
  if (!force && Date.now() - jwksFetchedAt < JWKS_TTL_MS && jwks.size) return true;
  if (jwksInFlight) return jwksInFlight;         // collapse concurrent refreshes
  if (force && Date.now() - jwksForcedAt < JWKS_FORCE_MIN_MS) return jwks.size > 0;
  if (force) jwksForcedAt = Date.now();
  jwksInFlight = (async () => {
    let ok = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(AUTH_URL + '/.well-known/jwks.json', {
        headers: SECRET_KEY ? { apikey: SECRET_KEY } : {},
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      const next = new Map();
      (body.keys || []).forEach((jwk) => {
        if (!jwk.kid) return;
        try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
        catch (e) { console.error('[supabase] bad JWK ' + jwk.kid + ':', e.message); }
      });
      // Only adopt a non-empty set. An empty/garbled response must not wipe the
      // keys we already hold and log every signed-in user out.
      if (!next.size) throw new Error('JWKS response contained no usable keys');
      jwks = next; jwksFetchedAt = Date.now(); ok = true;
    } catch (e) {
      console.error('[supabase] JWKS refresh failed:', e.message);
    } finally {
      clearTimeout(timer);
      jwksInFlight = null;
    }
    return ok;
  })();
  return jwksInFlight;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s), 'base64url');
}

// Node's hash names for the JWS `alg` values GoTrue can issue.
const HASH_FOR = { ES256: 'sha256', RS256: 'sha256', ES512: 'sha512', RS512: 'sha512' };

// Synchronous. Returns the token's claims, or null if the token is missing,
// malformed, expired, signed by an unknown key, or signed by the wrong key.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    claims = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch (e) { return null; }
  if (!header || !claims || !claims.sub) return null;

  const signed = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
  const sig = b64urlToBuf(parts[2]);

  if (header.alg === 'HS256') {
    // Legacy symmetric project. Without the shared secret we cannot verify it,
    // and an unverified token must never be accepted.
    if (!JWT_SECRET) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(signed).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  } else {
    const hash = HASH_FOR[header.alg];
    if (!hash || !header.kid) return null;
    const key = jwks.get(header.kid);
    if (!key) {
      // Unknown kid — most likely a signing-key rotation. Kick off a refresh and
      // reject this one request; the client retries with the same token and it
      // validates against the new key set.
      loadJwks(true);
      return null;
    }
    // JWS ECDSA signatures are raw R||S, not the DER encoding Node defaults to.
    const opts = header.alg.charAt(0) === 'E'
      ? { key: key, dsaEncoding: 'ieee-p1363' }
      : { key: key };
    let ok = false;
    try { ok = crypto.verify(hash, signed, opts, sig); } catch (e) { ok = false; }
    if (!ok) return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  // Issuer must be OUR project. Without this, a valid token from any other
  // Supabase project would authenticate here. (Older GoTrue builds can omit
  // iss on their own signed tokens — hence "when present". The signature has
  // already been verified by this point, so absence is not forgeable.)
  if (claims.iss && claims.iss !== AUTH_URL) return null;
  if (claims.aud && claims.aud !== 'authenticated' &&
      !(Array.isArray(claims.aud) && claims.aud.indexOf('authenticated') >= 0)) return null;
  return claims;
}

module.exports = {
  configured, forwardsIp, emailFor, loadJwks, verify,
  loadSettings, providerEnabled,
  createUser, deleteUser, setPassword, updateEmail, setBanned, updateUsernameMeta,
  signIn, signInEmail, refresh, signOut,
  generateLink, verifyOtp,
  authorizeUrl, exchangePkce, getUser, unlinkIdentity,
  get url() { return URL_BASE; },
  get syntheticDomain() { return EMAIL_DOMAIN; }
};
