/* Convoy — account store, backed by Supabase.

   Identity (passwords, sessions, refresh tokens) lives in Supabase Auth via
   supabase.js. Account data (profile, friends, stats, PBs, recovery codes) lives
   in the project's Postgres via db.js.

   READ MODEL: every account is held in memory and refreshed on write. The whole
   set is loaded once at boot. That is deliberate — the realtime websocket
   handlers in server.js read accounts synchronously on the hot path (every
   'hello', every friend fan-out, every stat broadcast), and making those async
   would mean restructuring the entire realtime layer. Postgres is the durable
   record; memory is a write-through cache in front of it. This assumes ONE
   server process, which is how Convoy is deployed (a single systemd unit).

   Passwords are no longer stored or hashed here at all — GoTrue owns them. The
   scrypt code below is only for recovery codes.

   IDENTIFIERS: a username is still required and is still what other riders see.
   An email address is OPTIONAL and additive — accounts created before email
   support (and anyone who declines to give one) have `email: null` and keep the
   recovery code as their only reset path, which is why that machinery is still
   here. Accounts that DO have a verified address get reset-by-email and
   passwordless sign-in on top of it, and accounts created through a provider
   (Google et al., see oauth.js) arrive with one already verified. */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const sb = require('./supabase');

// Still exported: hotspots.js keeps its own JSON cache alongside the accounts
// that used to live here, and honours the VPS DATA_DIR override through it.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

let users = {};   // usernameLower -> user record
let byId = {};    // id (auth.users uuid) -> user record
let byEmail = {}; // emailLower -> user record (only accounts that have one)
let ready = false;

/* ---------------- boot ---------------- */
async function init() {
  const info = await db.init();
  const rows = await db.loadAll();
  users = {};
  byId = {};
  byEmail = {};
  rows.forEach((u) => { index(u); });
  ready = true;
  console.log('[store] loaded ' + rows.length + ' accounts from Supabase (role: ' + info.role + ')');
  return rows.length;
}

/* ---------------- recovery codes ---------------- */
function hashSecret(secret) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(secret, salt, 64, (err, dk) => (err ? reject(err) : resolve({ salt, hash: dk.toString('hex') })));
  });
}

function verifySecret(secret, salt, hash) {
  return new Promise((resolve) => {
    crypto.scrypt(secret, salt, 64, (err, dk) => {
      if (err) return resolve(false);
      const hb = Buffer.from(hash, 'hex');
      resolve(dk.length === hb.length && crypto.timingSafeEqual(dk, hb));
    });
  });
}

// Human-friendly, unambiguous (no 0/O/1/I): CVY-XXXX-XXXX
function genRecoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += A[bytes[i] % A.length];
  return 'CVY-' + s.slice(0, 4) + '-' + s.slice(4);
}
function normalizeCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Burn a constant-ish amount of time on paths that fail before any real hashing,
// so response timing doesn't reveal whether a username exists.
function decoyHash() { return verifySecret('x', 'deadbeefdeadbeefdeadbeefdeadbeef', '00'); }

/* ---------------- reads (synchronous — realtime hot path) ---------------- */
function getByUsername(username) { return users[String(username || '').toLowerCase()] || null; }
function getById(id) { return byId[id] || null; }
function getByEmail(email) { return byEmail[normalizeEmail(email)] || null; }
function count() { return Object.keys(byId).length; }
function isReady() { return ready; }

// Addresses are compared and indexed case-insensitively. The local part is
// technically case-sensitive per RFC 5321, but no mail provider anyone uses
// treats it that way, and GoTrue itself lowercases — matching it keeps our index
// and GoTrue's idea of "the same account" from ever disagreeing.
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }

// Keep the three in-memory indexes in step. Called on load and after any write
// that can change a username or an address.
function index(u) {
  users[u.username.toLowerCase()] = u;
  byId[u.id] = u;
  if (u.email) byEmail[normalizeEmail(u.email)] = u;
}

// The address GoTrue actually holds for this account, which is the one every
// password grant has to use. Legacy accounts have no real address and are keyed
// by the synthetic <username>@AUTH_EMAIL_DOMAIN one; accounts registered with an
// email, or created through a provider, are keyed by the real thing.
function loginEmail(u) { return u.email || sb.emailFor(u.username); }

function blank(id, username, profile, email, emailVerified, provider) {
  return {
    id: id,
    username: username,
    profile: profile,
    email: email || null,
    emailVerified: !!emailVerified,
    provider: provider || 'password',
    friends: [],
    reqIn: [],
    reqOut: [],
    blocked: [],
    blockedBy: [],
    stats: { pb: {}, runs: 0, wins: 0 },
    createdAt: Date.now()
  };
}

/* ---------------- account lifecycle ---------------- */

// Classify a failed GoTrue call. The distinction that matters is 429: that means
// we hit GOTRUE's rate limit, not that the password was wrong. Reporting it as
// "invalid username or password" pushes riders into the recovery flow, which
// SPENDS their one-shot code, over something that clears by itself in a minute.
function authErrorKind(r) {
  if (r.status === 429) return 'rate-limited';
  if (r.status === 400 || r.status === 401 || r.status === 422) return 'bad-credentials';
  return 'unavailable';
}

// Create a Supabase Auth user, then its profile row. Returns
// { user, recoveryCode, session } | { error: 'taken' } | { error: <message> }.
//
// Two systems have to agree here, so every failure after the auth user exists
// unwinds it — otherwise a half-created account would hold the username in
// GoTrue forever while being invisible to the app.
async function createUser(username, password, profile, ip, email) {
  email = email ? normalizeEmail(email) : null;
  const created = await sb.createUser(username, password, ip, email);
  // sb.createUser reports a duplicate as 'taken' regardless of which identifier
  // collided, but at this point only one of them CAN have: the username hasn't
  // been offered to GoTrue at all. So a duplicate here is always the address.
  if (created.error === 'taken' && email) return { error: 'email-taken' };
  if (created.error) return { error: created.error, detail: created.detail };
  const id = created.user && created.user.id;
  if (!id) { return { error: 'Auth did not return a user id' }; }

  let inserted;
  try {
    inserted = await db.insertProfile(id, username, profile, { email: email, emailVerified: false });
  } catch (e) {
    await sb.deleteUser(id);
    throw e;
  }
  if (inserted.emailTaken) {
    // GoTrue accepted the address but our own index already has it — the two
    // stores disagree, which means a half-deleted account somewhere. Unwind.
    await sb.deleteUser(id);
    return { error: 'email-taken' };
  }
  if (inserted.taken) {
    // The unique index rejected the name even though GoTrue accepted the email.
    await sb.deleteUser(id);
    return { error: 'taken' };
  }

  const recoveryCode = genRecoveryCode();
  try {
    const rec = await hashSecret(normalizeCode(recoveryCode));
    await db.setRecovery(id, rec.salt, rec.hash);
  } catch (e) {
    await db.deleteProfile(id);
    await sb.deleteUser(id);
    throw e;
  }

  // Hand back a real Supabase session so registration signs the rider straight in.
  const signed = await sb.signInEmail(email || sb.emailFor(username), password, ip);
  if (signed.error) {
    // Everything above succeeded, so the account is REAL - but the caller is
    // about to be told the registration failed. Leaving it behind strands the
    // username: the retry hits the unique index and comes back "taken", against
    // an account nobody can prove they own and no recovery code was ever shown
    // for. Unwind like every other failure here does, so the retry can succeed.
    try { await db.deleteProfile(id); }
    catch (e) { console.error('[store] rollback: profile ' + id + ': ' + e.message); }
    await sb.deleteUser(id);
    return { error: authErrorKind(signed) === 'rate-limited' ? 'rate-limited' : signed.error };
  }

  // Only now is the account complete - publish it to the in-memory read model.
  const user = blank(id, username, profile, email, false, 'password');
  index(user);
  return { user: user, recoveryCode: recoveryCode, session: signed.session };
}

/* ---------------- OAuth accounts ----------------
   A provider sign-in produces a GoTrue user before Convoy knows anything about
   the rider: no username, no car, no profile row. That gap is intentional and
   is what /api/oauth/complete closes — the account is not usable (store.signIn
   and userFromToken both refuse it) until a profile row exists, so an abandoned
   half-signup is inert rather than a broken account.

   Returns { user, recoveryCode } | { error }. */
async function completeOAuth(id, username, profile, email, provider) {
  if (byId[id]) return { error: 'already-complete' };
  email = email ? normalizeEmail(email) : null;

  // The provider has already proven the address, so it lands verified. That is
  // the difference from the email-registration path, where OUR link has to be
  // opened first.
  const inserted = await db.insertProfile(id, username, profile,
    { email: email, emailVerified: !!email, provider: provider || 'oauth' });
  if (inserted.emailTaken) return { error: 'email-taken' };
  if (inserted.taken) return { error: 'taken' };

  // A recovery code even here: providers go away, accounts get locked, and this
  // is the only path back that doesn't depend on someone else's service.
  let recoveryCode = null;
  try {
    recoveryCode = genRecoveryCode();
    const rec = await hashSecret(normalizeCode(recoveryCode));
    await db.setRecovery(id, rec.salt, rec.hash);
  } catch (e) {
    await db.deleteProfile(id);
    throw e;
  }

  const user = blank(id, username, profile, email, !!email, provider || 'oauth');
  index(user);
  return { user: user, recoveryCode: recoveryCode };
}

// Password grant. `identifier` is a username OR an email address — riders who
// registered with one shouldn't have to remember which box it went in.
// Returns { user, session } | { error: kind }, where kind is one of
// 'bad-credentials' | 'rate-limited' | 'unavailable' | 'no-profile'.
async function signIn(identifier, password, ip) {
  // 254 is the longest legal address; anything past it can only be junk, and
  // trimming here keeps a megabyte of "username" out of the GoTrue request.
  const id0 = String(identifier || '').trim().slice(0, 254);
  let email;
  if (id0.indexOf('@') >= 0) {
    // Straight to GoTrue with what they typed. Note we do NOT check our own
    // index first: an address we don't know might still be a valid GoTrue
    // account (one whose profile row failed to write), and either way the
    // failure has to look identical to a wrong password.
    email = normalizeEmail(id0);
  } else {
    const known = getByUsername(id0);
    // Unknown username: fall through to the synthetic address anyway rather than
    // returning early. GoTrue rejects it exactly as it rejects a wrong password,
    // which is what stops this being a username-existence oracle.
    email = known ? loginEmail(known) : sb.emailFor(id0);
  }
  const r = await sb.signInEmail(email, password, ip);
  if (r.error) return { error: authErrorKind(r) };
  const id = r.session.user && r.session.user.id;
  const user = id ? byId[id] : null;
  if (!user) {
    // Auth knows this account but we have no profile row — a create that died
    // between the two systems. Refuse rather than serving a broken session.
    console.error('[store] signIn for auth user ' + id + ' with no profile row');
    return { error: 'no-profile' };
  }
  return { user: user, session: r.session };
}

// Re-authenticate an already-signed-in rider (used before password changes and
// recovery-code regeneration). Returns { ok: true } | { error: kind } - the kind
// matters so a GoTrue 429 isn't shown as "your password is wrong".
// Takes the USER RECORD, not a username: the address GoTrue holds for an
// account is no longer derivable from its name once real emails are in play.
async function verifyPassword(user, password, ip) {
  if (!user) return { error: 'bad-credentials' };
  const r = await sb.signInEmail(loginEmail(user), password, ip);
  if (r.error) return { error: authErrorKind(r) };
  // That grant minted a session we don't need; drop it so re-auth doesn't leave
  // stray refresh tokens behind.
  if (r.session && r.session.access_token) sb.signOut(r.session.access_token, 'local', ip);
  return { ok: true };
}

// Sign in, revoke every session for the account, then sign in again — leaving
// exactly one live session, the one returned here.
//
// An admin password update does NOT by itself revoke existing sessions, so
// without this a device that was signed in before a password change (or before
// a recovery reset, i.e. possibly an attacker) would keep a working refresh
// token indefinitely. The old HMAC scheme got this for free by bumping
// tokenVersion; with GoTrue it has to be done explicitly. Global sign-out also
// kills the session we used to authorise it, hence the second sign-in.
async function freshSoleSession(user, password, ip) {
  const email = loginEmail(user);
  const first = await sb.signInEmail(email, password, ip);
  if (first.error) return { error: first.error };
  await sb.signOut(first.session.access_token, 'global', ip);
  const second = await sb.signInEmail(email, password, ip);
  if (second.error) return { error: second.error };
  return { session: second.session };
}

// Change a password for a rider who has already proven the current one.
async function changePassword(user, newPassword, ip) {
  const r = await sb.setPassword(user.id, newPassword, ip);
  if (r.error) return { error: r.error, detail: r.detail };
  return freshSoleSession(user, newPassword, ip);
}

// Verify a recovery code and BURN it in the same step, then reset the password.
// The burn is a conditional DELETE in Postgres, so if several recover requests
// race with the same code exactly one of them wins the row and proceeds.
// Returns { user, session, recoveryCode } | { error }.
async function resetWithRecovery(username, code, newPassword, ip) {
  const u = getByUsername(username);
  if (!u) { await decoyHash(); return { error: 'bad-code' }; }
  const rec = await db.getRecovery(u.id);
  if (!rec) { await decoyHash(); return { error: 'bad-code' }; }
  const ok = await verifySecret(normalizeCode(code), rec.salt, rec.hash);
  if (!ok) return { error: 'bad-code' };
  const won = await db.burnRecovery(u.id, rec.hash);
  if (!won) return { error: 'bad-code' };   // a concurrent reset already used it

  // The code is spent from here on. If the reset then fails for a reason that is
  // NOT the rider's fault - GoTrue rejecting the new password as weak, or being
  // unreachable - putting the code back is the difference between "try again"
  // and being locked out of the account permanently, because a recovery code is
  // shown exactly once and this is the only reset path Convoy has.
  const putBack = async (why) => {
    try { await db.setRecovery(u.id, rec.salt, rec.hash); }
    catch (e) { console.error('[store] could not restore the recovery code for ' +
      u.username + ' after ' + why + ': ' + e.message); }
  };

  const set = await sb.setPassword(u.id, newPassword, ip);
  if (set.error) { await putBack('a rejected password'); return { error: set.error, detail: set.detail }; }
  // Recovery is the "I lost access" path, so anyone else still holding a session
  // on this account must be kicked out, not just locked out of new logins.
  const signed = await freshSoleSession(u, newPassword, ip);
  // The password DID change here, so the rider can sign in with it - but they
  // never got a replacement code, so hand the old one back rather than leaving
  // the account with no recovery path at all.
  if (signed.error) { await putBack('a failed re-sign-in'); return { error: signed.error }; }
  const fresh = await regenRecovery(u.id);  // issue a replacement for the burned one
  return { user: u, session: signed.session, recoveryCode: fresh };
}

// Issue a new recovery code, replacing any existing one. Returns the plaintext.
async function regenRecovery(id) {
  const u = byId[id];
  if (!u) return null;
  const code = genRecoveryCode();
  const rec = await hashSecret(normalizeCode(code));
  await db.setRecovery(id, rec.salt, rec.hash);
  return code;
}

/* ---------------- email links ----------------
   One table, four purposes (verify / reset / change / magic), all single-use and
   all expiring. The token itself is 32 random bytes and is never stored — only
   its SHA-256 — so this half of the system is worthless in a database dump.

   These are NOT recovery codes and are not hashed like them: a recovery code is
   eight human-typable characters (~40 bits) and needs scrypt to be worth
   anything, while these are 256 bits of entropy that arrive by machine. scrypt
   here would only add latency to a request path. */

const TOKEN_TTL_MS = {
  verify: 24 * 3600 * 1000,   // generous: people confirm addresses whenever they get round to it
  reset: 3600 * 1000,         // a live password-reset link is a credential; keep the window short
  change: 3600 * 1000,
  magic: 15 * 60 * 1000       // shortest of the lot — it signs someone in outright
};

/* ---------------- payload encryption at rest ----------------
   The token_hash column is a SHA-256, so a dump yields no working LINKS — but
   the magic flow's `payload` holds GoTrue's hashed_token, which despite the
   name IS the redeemable OTP. Stored raw it made the "a dump yields nothing
   usable" promise above false for every live magic row (email + a working
   passwordless credential for it, side by side). Encrypt it with AES-256-GCM
   under a key that never touches the database: TOKEN_PAYLOAD_KEY (64 hex chars
   or base64 decoding to 32 bytes), or a generated key persisted to
   DATA_DIR/.payload-key — same pattern the old token .secret used.
   Rows written before this change (or after a key loss) decrypt to null and
   fail as "link no longer valid": magic links live 15 minutes, so the blast
   radius of deploying/rotating the key is at most one in-flight link per user. */
let PAYLOAD_KEY = null;
function payloadKey() {
  if (PAYLOAD_KEY) return PAYLOAD_KEY;
  const env = (process.env.TOKEN_PAYLOAD_KEY || '').trim();
  if (env) {
    const k = Buffer.from(env, /^[0-9a-fA-F]{64}$/.test(env) ? 'hex' : 'base64');
    if (k.length !== 32) throw new Error('TOKEN_PAYLOAD_KEY must decode to 32 bytes (64 hex chars or base64)');
    PAYLOAD_KEY = k;
    return k;
  }
  const file = path.join(DATA_DIR, '.payload-key');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const k = Buffer.from(raw, /^[0-9a-fA-F]{64}$/.test(raw) ? 'hex' : 'base64');
    if (k.length !== 32) throw new Error('bad key length in ' + file);
    PAYLOAD_KEY = k;
  } catch (e) {
    PAYLOAD_KEY = crypto.randomBytes(32);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // 'wx': refuses rather than overwrites if another boot won the create race.
      fs.writeFileSync(file, PAYLOAD_KEY.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e2) {
      if (e2.code === 'EEXIST') {
        try { PAYLOAD_KEY = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); }
        catch (e3) { console.error('[store] payload key race, unreadable:', e3.message); }
      } else {
        // In-memory key (works until restart) is better than failing every
        // magic sign-in over a persistence error — but say so loudly.
        console.error('[store] could not persist the payload key (' + e2.message +
          ') — in-flight magic links will break on the next restart.');
      }
    }
  }
  return PAYLOAD_KEY;
}

function encryptPayload(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', payloadKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decryptPayload(stored) {
  if (stored == null) return null;
  if (typeof stored !== 'string' || stored.slice(0, 3) !== 'v1.') return null; // pre-encryption row
  try {
    const raw = Buffer.from(stored.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', payloadKey(), raw.slice(0, 12));
    d.setAuthTag(raw.slice(12, 28));
    return Buffer.concat([d.update(raw.slice(28)), d.final()]).toString('utf8');
  } catch (e) {
    return null;   // wrong key or tampered — treat as an unusable row
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Returns the PLAINTEXT token to put in the link. It is never recoverable
// afterwards, which is the point.
async function issueEmailToken(userId, purpose, email, payload) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.putEmailToken(hashToken(token), userId, purpose, normalizeEmail(email), encryptPayload(payload),
    Date.now() + (TOKEN_TTL_MS[purpose] || 3600 * 1000));
  return token;
}

// Verify + burn in one atomic step. Returns { userId, email, payload } | null.
async function consumeEmailToken(token, purpose) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = await db.takeEmailToken(hashToken(token), purpose);
  if (!row) return null;
  return { userId: row.user_id, email: row.email, payload: decryptPayload(row.payload) };
}

/* ---------------- email identity ---------------- */

// Attach or move an address. Writes GoTrue FIRST — it owns the identity, and its
// unique constraint is the real arbiter of "already in use". Only once it agrees
// do we record our copy, so the two can't drift apart in the direction that
// matters (our index claiming an address GoTrue never accepted).
// Returns { ok } | { error: 'taken' | <message> }.
async function setEmailFor(user, email, verified, ip) {
  const next = normalizeEmail(email);
  // What GoTrue holds right now, and what it has to be put back to if the
  // second write fails. For an account with no address of its own that is the
  // synthetic one, which is exactly what loginEmail() already returns.
  const previous = loginEmail(user);

  const moved = await sb.updateEmail(user.id, next, ip);
  if (moved.error) return { error: moved.error };

  // FROM HERE THE TWO STORES DISAGREE until db.setEmail lands, and that gap is
  // an account lockout if it is left open: GoTrue is the authority for sign-in,
  // so it would be expecting `next` while loginEmail() — built from our row —
  // keeps offering `previous`. Every password grant for this account fails,
  // including the recovery-code reset, which is the path someone locked out
  // would reach for. So any failure past this point puts GoTrue back.
  let wrote;
  try {
    wrote = await db.setEmail(user.id, next, !!verified);
  } catch (e) {
    await rollbackEmail(user, previous, ip, 'a database error');
    throw e;
  }
  if (wrote.taken) {
    // GoTrue accepted the address but our partial unique index did not, so some
    // other profile row already claims it. Undo and report it as taken.
    await rollbackEmail(user, previous, ip, 'a duplicate address');
    return { error: 'taken' };
  }

  if (user.email) delete byEmail[normalizeEmail(user.email)];
  user.email = next;
  user.emailVerified = !!verified;
  byEmail[next] = user;
  return { ok: true };
}

// Best-effort undo of the GoTrue half of setEmailFor. If even this fails the
// account really is stranded, so it is logged loudly with everything needed to
// repair it by hand — silence here would mean a rider who simply cannot sign in
// and no record of why.
async function rollbackEmail(user, previous, ip, why) {
  const back = await sb.updateEmail(user.id, previous, ip);
  if (!back.error) return;
  console.error('[store] COULD NOT ROLL BACK the auth email for ' + user.username +
    ' (' + user.id + ') after ' + why + ': ' + back.error);
  console.error('[store]   Supabase Auth now expects a different address than the ' +
    'profiles row holds, so this account cannot sign in. Set its auth email back to ' +
    previous + ' in the dashboard.');
}

async function markEmailVerified(user) {
  if (!user.email) return;   // nothing to verify; never index the empty string
  await db.markEmailVerified(user.id);
  user.emailVerified = true;
  byEmail[normalizeEmail(user.email)] = user;
}

// Reset a password for someone who proved ownership of the address rather than
// knowing the old password. Mirrors resetWithRecovery's tail: every other
// session dies, because "I lost access" has to lock out whoever else was in.
async function resetPasswordFor(user, newPassword, ip) {
  const set = await sb.setPassword(user.id, newPassword, ip);
  if (set.error) return { error: set.error, detail: set.detail };
  const signed = await freshSoleSession(user, newPassword, ip);
  if (signed.error) return { error: signed.error };
  return { user: user, session: signed.session };
}

// Passwordless sign-in. GoTrue mints the session from a token it issued to us
// (see supabase.generateLink); we only ever hand the rider our own opaque token
// and keep GoTrue's on this side.
async function magicSignIn(user, hashedToken, ip) {
  const r = await sb.verifyOtp('magiclink', hashedToken, loginEmail(user), ip);
  if (r.error) return { error: authErrorKind(r) };
  return { user: user, session: r.session };
}

/* ---------------- account deletion ----------------
   The right-to-erasure path, and a hard requirement of Google Play's account
   deletion policy: an account someone can create in the app is one they must be
   able to destroy in the app.

   Order matters, and it is deliberately the safe one:
     1. flush queued writes, so an in-flight profile/stat write cannot land after
        the row is gone (it would be dropped as a permanent FK error and logged
        as if something were broken);
     2. delete the Postgres profile, which cascades to stats, PBs, friendships,
        friend requests and recovery codes;
     3. delete the GoTrue user, which revokes every session and refresh token the
        account had anywhere;
     4. only then drop it from the in-memory read model.

   If step 3 fails we are left with an auth user that has no profile. That is the
   SAFE failure: sign-in resolves to nothing and the rider is not in the map or
   anyone's friend list. It is reported so the operator can finish the job, and
   it is why this returns the residue rather than swallowing it. */
/* Tombstones for deleted accounts.

   Supabase access tokens are stateless ES256 JWTs: deleting the GoTrue user
   revokes the REFRESH token, but every access token already minted stays
   cryptographically valid until it expires, roughly an hour later. Nothing about
   deletion can reach back and invalidate one.

   That matters because a verified token with no profile behind it is exactly the
   shape of an unfinished provider sign-up, and the server answers that shape by
   offering to create an account ("pick a username"). Without this, the hour after
   a deletion is a window in which the deleted rider's own token walks straight
   back into account setup.

   So the id is remembered for longer than any access token can live, and a token
   naming a tombstoned subject is refused outright. */
const TOMBSTONE_MS = 3 * 60 * 60 * 1000;  // 3h — comfortably past a ~1h access token
const tombstones = new Map();             // id -> expiry ms

function tombstone(id) {
  tombstones.set(id, Date.now() + TOMBSTONE_MS);
  // Swept opportunistically rather than on a timer: the map only ever grows by
  // one per deletion, and this keeps it from being a permanent leak.
  if (tombstones.size > 64) {
    const now = Date.now();
    for (const [k, exp] of tombstones) if (exp <= now) tombstones.delete(k);
  }
}

function isDeleted(id) {
  const exp = tombstones.get(id);
  if (!exp) return false;
  if (exp <= Date.now()) { tombstones.delete(id); return false; }
  return true;
}

async function deleteAccount(id) {
  const u = byId[id];
  if (!u) return { error: 'no-such-account' };

  try { await db.flush(4000); } catch (e) { /* best effort — deletion still proceeds */ }

  try {
    await db.deleteProfile(id);
  } catch (e) {
    console.error('[delete] profile row for ' + u.username + ': ' + (e && e.message));
    return { error: 'db-failed' };
  }

  let authResidue = false;
  try {
    await sb.deleteUser(id);
  } catch (e) {
    authResidue = true;
    console.error('[delete] ORPHANED AUTH USER ' + id + ' (' + u.username +
      ') — profile is gone, GoTrue user is not: ' + (e && e.message));
  }

  // Before the record leaves the read model, so there is no instant in which the
  // account is unfindable AND not yet tombstoned.
  tombstone(id);

  // Drop from the read model last, so nothing above can read a half-deleted
  // account through the cache while the writes are still going out.
  delete users[u.username.toLowerCase()];
  delete byId[id];
  if (u.email) delete byEmail[normalizeEmail(u.email)];

  // The cascade cleared the friendship and friend_request ROWS; these are the
  // in-memory mirrors of them held on every OTHER account. Missing any of the
  // three leaves dangling ids that outlive the account until the next restart:
  // the friend fan-out tries to resolve them on every broadcast, and a pending
  // request to or from the deleted rider sits in someone's list as an entry that
  // can never be accepted, declined, or rendered.
  const drop = (arr) => {
    if (!Array.isArray(arr)) return;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
  };
  Object.keys(byId).forEach((otherId) => {
    const o = byId[otherId];
    if (!o) return;
    drop(o.friends);
    drop(o.reqIn);
    drop(o.reqOut);
    // The blocks rows cascade with the profile, so these mirrors have to go too.
    // Note this is the one place a deletion is visible to someone else: a rider
    // who had blocked the deleted account will find it gone from their block
    // list, which is correct — there is no longer an account to block.
    drop(o.blocked);
    drop(o.blockedBy);
  });

  console.log('[delete] account ' + u.username + ' deleted' +
    (authResidue ? ' (auth user orphaned — needs manual cleanup)' : ''));
  return { ok: true, username: u.username, email: u.email || null, authResidue: authResidue };
}

/* ---------------- profile ---------------- */
function updateProfile(id, profile) {
  const u = byId[id];
  if (!u) return false;
  u.profile = profile;
  db.queueProfile(id, profile);
  return true;
}

/* ---------------- blocking ----------------

   Symmetric by design. The row records a direction, because a reviewer needs to
   know who blocked whom, but `blockedBetween` is what every visibility check
   calls and it reads both ways.

   The reason is specific to this app: Convoy streams live position. A one-way
   block would take the harasser off the victim's map while leaving the victim's
   pin, heading and speed flowing to the harasser — the exact capability someone
   blocks to remove. See migrations/003_blocks_reports.sql. */

function blockUser(userId, targetId) {
  const u = byId[userId], t = byId[targetId];
  if (!u || !t) return { error: 'no-such-account' };
  if (userId === targetId) return { error: 'self' };
  if (u.blocked.indexOf(targetId) >= 0) return { ok: true, already: true };
  u.blocked.push(targetId);
  t.blockedBy.push(userId);
  db.queueBlock(userId, targetId);
  return { ok: true };
}

function unblockUser(userId, targetId) {
  const u = byId[userId], t = byId[targetId];
  if (!u) return { error: 'no-such-account' };
  const i = u.blocked.indexOf(targetId);
  if (i < 0) return { ok: true, already: true };
  u.blocked.splice(i, 1);
  // The target may have been deleted since the block was made; the row is gone
  // either way and the mirror simply has nowhere to be removed from.
  if (t) {
    const j = t.blockedBy.indexOf(userId);
    if (j >= 0) t.blockedBy.splice(j, 1);
  }
  db.queueUnblock(userId, targetId);
  return { ok: true };
}

// TRUE if either account has blocked the other. Both ids are account ids; a
// guest has none, and guests can neither block nor be blocked durably.
function blockedBetween(aId, bId) {
  if (!aId || !bId || aId === bId) return false;
  const a = byId[aId];
  if (!a) return false;
  return a.blocked.indexOf(bId) >= 0 || a.blockedBy.indexOf(bId) >= 0;
}

// The viewer's own list, resolved for display: who they blocked and when the
// account still exists to name.
function blockList(userId) {
  const u = byId[userId];
  if (!u) return [];
  return u.blocked.map((id) => {
    const t = byId[id];
    return {
      id: id,
      username: t ? t.username : null,
      name: t && t.profile ? (t.profile.name || t.username) : 'Removed account',
      emoji: t && t.profile ? t.profile.emoji : null
    };
  });
}

/* ---------------- reports ---------------- */

// Awaited, not queued — see db.insertReport. Returns { ok, id } or { error }.
async function fileReport(rep) {
  try {
    const id = await db.insertReport(rep);
    return { ok: true, id: id };
  } catch (e) {
    console.error('[report] insert failed: ' + (e && e.message));
    return { error: 'insert-failed' };
  }
}

async function recentReportCount(reporterId, windowMs) {
  try { return await db.countRecentReports(reporterId, windowMs); }
  catch (e) { return 0; }   // never let a counting failure block a real report
}

/* ---------------- stats ---------------- */
function getStats(id) {
  const u = byId[id];
  if (!u || !u.stats) return { pb: {} };
  if (!u.stats.pb || typeof u.stats.pb !== 'object') u.stats.pb = {};
  return u.stats;
}

// Record a dragy personal best. Only persists when it beats the stored time for
// the same modeId (lower is better). Returns the updated stats object.
function recordPB(id, modeId, time, trap) {
  const u = byId[id];
  if (!u) return { pb: {} };
  if (!u.stats || !u.stats.pb) u.stats = { pb: {}, runs: 0, wins: 0 };
  const prev = u.stats.pb[modeId];
  if (!prev || time < prev.time) {
    const when = Date.now();
    u.stats.pb[modeId] = { time: time, trap: trap != null ? trap : null, when: when };
    db.queuePB(id, modeId, time, trap != null ? trap : null, when);
  }
  return u.stats;
}

// Race counters. Deliberately SEPARATE calls:
//   recordRun — exactly once per racer per race, on a finish OR a DNF.
//   recordWin — additionally, for the fastest legal finisher.
function statsOf(id) {
  const u = byId[id];
  if (!u) return null;
  if (!u.stats) u.stats = { pb: {} };
  if (typeof u.stats.runs !== 'number') u.stats.runs = 0;
  if (typeof u.stats.wins !== 'number') u.stats.wins = 0;
  return u.stats;
}
function recordRun(id) {
  const s = statsOf(id);
  if (!s) return { pb: {} };
  s.runs++;
  db.queueRunIncrement(id);
  return s;
}
function recordWin(id) {
  const s = statsOf(id);
  if (!s) return { pb: {} };
  s.wins++;
  db.queueWinIncrement(id);
  return s;
}

/* ---------------- friends ---------------- */
function friendLite(u) {
  // Defensive on `profile`: it is a jsonb column now, so a row touched outside
  // the app (a manual fix in the dashboard, a partial import) can lack `car`.
  // This runs inside friend fan-outs, where a throw would break the broadcast
  // for everyone else in the loop, not just this rider.
  const p = u.profile || {};
  const car = p.car || {};
  return { id: u.id, username: u.username, name: p.name, emoji: p.emoji, paint: car.paint };
}
function pull(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }

// Returns { error } | { ok, autoAccepted, target }
function sendFriendRequest(fromId, toUsername) {
  const from = byId[fromId];
  const to = getByUsername(toUsername);
  if (!from) return { error: 'unauthorized' };
  if (!to) return { error: 'No rider with that username' };
  if (to.id === from.id) return { error: "You can't friend yourself" };
  // Deliberately the same message a wrong username gets. A distinct "they
  // blocked you" would turn this endpoint into a block-detector, and letting
  // someone confirm they were blocked is the first step to working around it.
  if (blockedBetween(from.id, to.id)) return { error: 'No rider with that username' };
  if (from.friends.indexOf(to.id) >= 0) return { error: 'Already friends' };
  if (from.reqOut.indexOf(to.id) >= 0) return { error: 'Request already sent' };

  // they already asked us → accept immediately
  if (from.reqIn.indexOf(to.id) >= 0) {
    acceptFriend(from.id, to.id);
    return { ok: true, autoAccepted: true, target: to };
  }
  from.reqOut.push(to.id);
  to.reqIn.push(from.id);
  db.queueFriendRequest(from.id, to.id);
  return { ok: true, autoAccepted: false, target: to };
}

function acceptFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u || !o) return false;
  pull(u.reqIn, otherId); pull(u.reqOut, otherId);
  pull(o.reqIn, userId); pull(o.reqOut, userId);
  if (u.friends.indexOf(otherId) < 0) u.friends.push(otherId);
  if (o.friends.indexOf(userId) < 0) o.friends.push(userId);
  db.queueClearRequests(userId, otherId);
  db.queueFriendship(userId, otherId);
  return true;
}

function declineFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u) return false;
  pull(u.reqIn, otherId); pull(u.reqOut, otherId);
  if (o) { pull(o.reqOut, userId); pull(o.reqIn, userId); }
  db.queueClearRequests(userId, otherId);
  return true;
}

function removeFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u) return false;
  pull(u.friends, otherId);
  if (o) pull(o.friends, userId);
  db.queueUnfriend(userId, otherId);
  return true;
}

function areFriends(aId, bId) {
  const a = byId[aId];
  return !!(a && a.friends.indexOf(bId) >= 0);
}

/* ---------------- shutdown ---------------- */
function flush(timeoutMs) { return db.flush(timeoutMs); }
function close() { return db.close(); }

module.exports = {
  init, isReady, DATA_DIR,
  getByUsername, getById, getByEmail, count, normalizeEmail, loginEmail,
  createUser, completeOAuth, signIn, verifyPassword, changePassword, resetWithRecovery, regenRecovery,
  issueEmailToken, consumeEmailToken, purgeExpiredTokens: db.purgeExpiredTokens,
  setEmailFor, markEmailVerified, resetPasswordFor, magicSignIn,
  updateProfile, deleteAccount, isDeleted, flush, close,
  friendLite, sendFriendRequest, acceptFriend, declineFriend, removeFriend, areFriends,
  blockUser, unblockUser, blockedBetween, blockList,
  fileReport, recentReportCount,
  getStats, recordPB, recordRun, recordWin
};
