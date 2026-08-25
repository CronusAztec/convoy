/* Convoy — Postgres data layer (Supabase).

   Account data (profiles, friends, stats, PBs, recovery codes) lives in the
   project's Postgres. Identity itself lives in Supabase Auth — see supabase.js.

   Connects as the database owner (the `postgres` role in SUPABASE_DB_URL), so
   RLS is bypassed by design: the tables have RLS enabled with NO policies and no
   grants to anon/authenticated, which means the node server is the only thing
   that can reach them even if the Data API is switched on later. init() logs
   current_user at boot so the role in use is never a guess.

   WRITE MODEL: store.js keeps the authoritative in-memory copy and calls the
   queue* helpers below. Writes are appended to a serialized queue and drained in
   order, so a burst of friend/stat mutations can never race each other or
   overlap on a connection, and a transient outage retries instead of dropping
   the write. drain() is awaited on shutdown. This replaces the old debounced
   users.json flush and keeps every store.js read synchronous. */
'use strict';

const { Pool } = require('pg');

const CONN = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
// Supabase terminates TLS with a cert chain that isn't in Node's default trust
// store, so plain verification fails. Point SUPABASE_DB_CA at the project CA
// (Dashboard → Settings → Database → SSL configuration) to verify properly;
// without it we still use TLS but skip chain verification.
// Either a PATH to the CA file or the PEM text itself. Inline matters because
// the VPS sets this through systemd Environment=/a secrets manager, where
// shipping a file alongside the unit is the step most likely to be skipped —
// and skipping it silently downgrades the connection (see sslOpts).
const CA = process.env.SUPABASE_DB_CA || '';
// Fail closed. Strict by DEFAULT in production (NODE_ENV=production): an
// unverified owner-role connection is exactly what the strict flag exists for,
// and leaving it opt-in meant the common deployment posture was fail-open with
// only a boot warning. Explicit values always win: '1' forces strict even in
// dev, '0' explicitly accepts an unverified chain (staging without a CA).
const STRICT_TLS = process.env.SUPABASE_DB_STRICT_TLS !== undefined
  ? process.env.SUPABASE_DB_STRICT_TLS === '1'
  : process.env.NODE_ENV === 'production';
const POOL_MAX = parseInt(process.env.SUPABASE_DB_POOL || '8', 10);

let pool = null;

function configured() { return !!CONN; }

// Accepts the PEM inline or as a path. \n escapes are unescaped first, because
// a multi-line value fed through systemd Environment= or a .env arrives that way.
function readCa() {
  if (!CA) return '';
  if (CA.indexOf('-----BEGIN') >= 0) return CA.replace(/\\n/g, '\n');
  return require('fs').readFileSync(CA, 'utf8');
}

function sslOpts() {
  let ca = '';
  try {
    ca = readCa();
  } catch (e) {
    // Configured but unusable is a mistake, not a reason to quietly fall back to
    // an unverified connection — that would defeat the point of setting it.
    throw new Error('SUPABASE_DB_CA is set but could not be read (' + CA + '): ' + e.message);
  }
  if (ca) return { ca: ca, rejectUnauthorized: true };
  if (STRICT_TLS) {
    throw new Error('SUPABASE_DB_STRICT_TLS=1 but SUPABASE_DB_CA is not set — refusing to ' +
      'connect without certificate verification.');
  }
  // Encrypted but UNVERIFIED: without the project CA the connection is open
  // to an active MITM on the path to the database. Log it loudly once at
  // boot so an operator can't run like this by accident — set SUPABASE_DB_CA
  // (Dashboard → Settings → Database → SSL configuration) to verify.
  console.warn('[db] TLS certificate verification DISABLED (no SUPABASE_DB_CA set) — ' +
    'the Postgres connection is encrypted but vulnerable to interception.');
  console.warn('[db] Set SUPABASE_DB_CA (and SUPABASE_DB_STRICT_TLS=1) in production.');
  return { rejectUnauthorized: false };
}

// Open the pool and prove the credentials work. Throws on failure so boot fails
// loudly rather than the server coming up and 500-ing every sign-in.
async function init() {
  if (!configured()) throw new Error('SUPABASE_DB_URL is not set');
  pool = new Pool({
    connectionString: CONN,
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: sslOpts()
  });
  // A pool-level error (server restart, idle connection reaped) is emitted on
  // the pool, and an unhandled 'error' event would take the whole process down.
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  const r = await pool.query('select current_user, count(*)::int as profiles from public.profiles');
  return { role: r.rows[0].current_user, profiles: r.rows[0].profiles };
}

function query(text, params) { return pool.query(text, params); }

/* ---------------- boot load ----------------
   One round-trip per table, then stitched in memory — five small queries beats
   an N+1 over profiles. At friends-scale the whole account set is a few hundred
   rows; if this ever outgrows memory the store's read API is the thing to
   change, not this. */
async function loadAll() {
  const [profiles, friendships, requests, stats, pbs] = await Promise.all([
    query('select id, username, profile, email, email_verified, auth_provider, ' +
      'extract(epoch from created_at) * 1000 as created_ms from public.profiles'),
    query('select user_a, user_b from public.friendships'),
    query('select from_id, to_id from public.friend_requests'),
    query('select user_id, runs, wins from public.user_stats'),
    query('select user_id, mode_id, time_s, trap, extract(epoch from achieved_at) * 1000 as when_ms from public.dragy_pbs')
  ]);

  const byId = new Map();
  profiles.rows.forEach((r) => {
    byId.set(r.id, {
      id: r.id,
      username: r.username,
      profile: r.profile || {},
      // null for the username-only accounts that predate email support, and for
      // anyone who registers without one — the column is deliberately optional.
      email: r.email || null,
      emailVerified: !!r.email_verified,
      provider: r.auth_provider || 'password',
      friends: [],
      reqIn: [],
      reqOut: [],
      stats: { pb: {}, runs: 0, wins: 0 },
      createdAt: Number(r.created_ms) || Date.now()
    });
  });

  // Friendships are stored once, canonically ordered; the in-memory shape wants
  // both directions.
  friendships.rows.forEach((r) => {
    const a = byId.get(r.user_a), b = byId.get(r.user_b);
    if (a && b) { a.friends.push(b.id); b.friends.push(a.id); }
  });
  requests.rows.forEach((r) => {
    const f = byId.get(r.from_id), t = byId.get(r.to_id);
    if (f && t) { f.reqOut.push(t.id); t.reqIn.push(f.id); }
  });
  stats.rows.forEach((r) => {
    const u = byId.get(r.user_id);
    if (u) { u.stats.runs = r.runs; u.stats.wins = r.wins; }
  });
  pbs.rows.forEach((r) => {
    const u = byId.get(r.user_id);
    if (u) u.stats.pb[r.mode_id] = { time: r.time_s, trap: r.trap, when: Number(r.when_ms) };
  });

  return [...byId.values()];
}

/* ---------------- awaited writes (account lifecycle) ----------------
   These run on the /api request path, where the caller needs to know whether
   they succeeded before answering the user. */

// Claim a username. The unique index on lower(username) is what actually decides
// the race between two simultaneous registrations — not a read-then-write check.
// Returns { ok } | { taken }.
// `opts` carries the optional email identity: { email, emailVerified, provider }.
// A username-only registration passes none of it and the columns keep their
// defaults (null / false / 'password'). An OAuth signup arrives with an address
// the provider has already verified, so emailVerified is true from the start.
async function insertProfile(id, username, profile, opts) {
  opts = opts || {};
  try {
    await query(
      'insert into public.profiles (id, username, profile, email, email_verified, auth_provider) ' +
      'values ($1, $2, $3::jsonb, $4, $5, $6)',
      [id, username, JSON.stringify(profile || {}),
        opts.email || null, !!opts.emailVerified, opts.provider || 'password']
    );
    // Stats row up front so recordRun/recordWin never have to branch on absence.
    await query('insert into public.user_stats (user_id) values ($1) on conflict do nothing', [id]);
    return { ok: true };
  } catch (e) {
    // unique_violation. TWO unique indexes can raise it now, and they mean very
    // different things to the rider ("pick another name" vs "that address
    // already has an account"), so branch on which one fired rather than
    // reporting both as a taken username.
    if (e.code === '23505') {
      if (String(e.constraint || '').indexOf('email') >= 0) return { emailTaken: true };
      return { taken: true };
    }
    throw e;
  }
}

/* ---------------- email identity ---------------- */

// Set (or clear) the address on an account. Returns { ok } | { taken }.
async function setEmail(id, email, verified) {
  try {
    await query('update public.profiles set email = $2, email_verified = $3, updated_at = now() where id = $1',
      [id, email || null, !!verified]);
    return { ok: true };
  } catch (e) {
    if (e.code === '23505') return { taken: true };
    throw e;
  }
}

async function markEmailVerified(id) {
  await query('update public.profiles set email_verified = true, updated_at = now() where id = $1', [id]);
}

async function setProvider(id, provider) {
  await query('update public.profiles set auth_provider = $2, updated_at = now() where id = $1', [id, provider]);
}

/* ---------------- one-time email tokens ----------------
   Only the SHA-256 of the token is stored, so a database dump yields no working
   links. See migrations/002_email_oauth.sql for why that hash and not scrypt. */

// Issuing a token INVALIDATES any earlier one of the same purpose for that
// account: "resend the email" must not leave the previous link alive, or a
// rider who requested three resets has three live password-reset links in three
// inboxes-worth of history.
// ONE statement, deliberately: delete-then-insert as two awaited calls could
// interleave (A.delete → B.delete → A.insert → B.insert) under a double-clicked
// "send link", leaving TWO live rows and the documented invariant broken. A
// single modifying CTE is atomic in Postgres.
async function putEmailToken(hash, userId, purpose, email, payload, expiresAt) {
  await query(
    'with old as (delete from public.email_tokens where user_id = $2 and purpose = $3) ' +
    'insert into public.email_tokens (token_hash, user_id, purpose, email, payload, expires_at) ' +
    'values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ' +
    'on conflict (token_hash) do nothing',
    [hash, userId, purpose, email, payload, expiresAt]
  );
}

// Redeem a token: a DELETE … RETURNING, so verifying it and burning it are one
// atomic step. Two requests racing with the same link mean exactly one row comes
// back, and only that caller proceeds — the same trick burnRecovery uses.
// Expired rows are filtered here rather than swept-then-read, so a token can
// never be redeemed in the window before the sweep notices it.
async function takeEmailToken(hash, purpose) {
  const r = await query(
    'delete from public.email_tokens where token_hash = $1 and purpose = $2 and expires_at > now() ' +
    'returning user_id, purpose, email, payload',
    [hash, purpose]
  );
  return r.rows[0] || null;
}

// Housekeeping only — takeEmailToken already refuses expired rows.
async function purgeExpiredTokens() {
  const r = await query('delete from public.email_tokens where expires_at < now()');
  return r.rowCount;
}

async function setRecovery(id, salt, hash) {
  await query(
    `insert into public.recovery_codes (user_id, salt, hash) values ($1, $2, $3)
     on conflict (user_id) do update set salt = excluded.salt, hash = excluded.hash, created_at = now()`,
    [id, salt, hash]
  );
}

async function getRecovery(id) {
  const r = await query('select salt, hash from public.recovery_codes where user_id = $1', [id]);
  return r.rows[0] || null;
}

// Burn a recovery code. Deleting with the hash in the WHERE clause makes this
// atomic: of several concurrent recover attempts holding the same code, exactly
// one DELETE reports a row, and only that one is allowed to reset the password.
async function burnRecovery(id, hash) {
  const r = await query('delete from public.recovery_codes where user_id = $1 and hash = $2', [id, hash]);
  return r.rowCount === 1;
}

async function deleteProfile(id) {
  await query('delete from public.profiles where id = $1', [id]);   // cascades
}

/* ---------------- queued writes (realtime paths) ----------------
   Called from synchronous websocket handlers, which cannot await. */

const queue = [];
let draining = false;
let retryTimer = null;

function enqueue(text, params) {
  queue.push({ text: text, params: params });
  if (!draining) drainSoon();
}

// unref'd: a pending backoff is not a reason to keep the process alive. The
// http server holds the loop open while we're running, and shutdown drains
// explicitly through flush(), so an armed retry timer would only ever delay a
// restart by up to the full backoff.
function arm(ms) {
  retryTimer = setTimeout(() => { retryTimer = null; drain(); }, ms);
  if (retryTimer.unref) retryTimer.unref();
}

function drainSoon() {
  if (retryTimer || draining) return;
  arm(0);
}

// Drains in FIFO order. A failed task stays at the head and is retried with a
// backoff — writes are never silently dropped, and later writes to the same row
// can't jump ahead of an earlier one.
// Is this error worth retrying? Retrying a constraint violation or a SQL bug can
// never succeed, and because the queue is strictly ordered such a task would sit
// at the head forever and block EVERY later write — the persistence layer would
// go silently dead while the app carried on happily serving from memory.
// So: retry infrastructure problems, drop logic problems (loudly).
//
// A real way to hit this: an in-memory account whose row was deleted straight in
// the database. The cache still has it, a friend request against it queues an
// insert, and the foreign key rejects it on every single attempt.
function isPermanent(e) {
  const c = e && e.code;
  if (!c || typeof c !== 'string') return false;      // network/no code → transient
  const cls = c.slice(0, 2);
  // 23 integrity constraint, 22 data exception, 42 syntax/access rule,
  // 3F invalid schema name, 21 cardinality.
  return cls === '23' || cls === '22' || cls === '42' || cls === '3F' || cls === '21';
}

const MAX_ATTEMPTS = 12;   // ~5 min of backoff before giving up on one write
let backoff = 250;
async function drain() {
  if (draining || !pool) return;
  draining = true;
  try {
    while (queue.length) {
      const task = queue[0];
      try {
        await query(task.text, task.params);
        queue.shift();
        backoff = 250;
      } catch (e) {
        task.attempts = (task.attempts || 0) + 1;
        // Drop rather than block the queue behind something that cannot succeed.
        if (isPermanent(e) || task.attempts >= MAX_ATTEMPTS) {
          console.error('[db] DROPPED a write after ' + task.attempts + ' attempt(s) — ' +
            (isPermanent(e) ? 'permanent error ' + e.code : 'gave up') + ': ' + e.message);
          console.error('[db]   ' + task.text.replace(/\s+/g, ' ').slice(0, 120));
          queue.shift();
          backoff = 250;
          continue;                      // keep going; later writes are unaffected
        }
        console.error('[db] write failed (retry ' + task.attempts + ' in ' + backoff + 'ms): ' + e.message);
        const wait = backoff;
        backoff = Math.min(backoff * 2, 30000);
        draining = false;
        arm(wait);
        return;
      }
    }
  } finally {
    // Only clear the flag if we finished the queue; the error path already
    // cleared it and armed a retry.
    if (queue.length === 0) draining = false;
  }
}

function pending() { return queue.length; }

function queueProfile(id, profile) {
  enqueue('update public.profiles set profile = $2::jsonb, updated_at = now() where id = $1',
    [id, JSON.stringify(profile || {})]);
}

function queuePB(id, modeId, time, trap, when) {
  // Guarded by the same "only if better" rule the store applies in memory, so a
  // replayed or out-of-order write can't regress a personal best.
  enqueue(
    `insert into public.dragy_pbs (user_id, mode_id, time_s, trap, achieved_at)
     values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
     on conflict (user_id, mode_id) do update
       set time_s = excluded.time_s, trap = excluded.trap, achieved_at = excluded.achieved_at
       where excluded.time_s < public.dragy_pbs.time_s`,
    [id, modeId, time, trap, when]
  );
}

// Counters are incremented in SQL rather than written as absolute values, so the
// database stays correct even if the in-memory copy and the queue disagree.
function queueRunIncrement(id) {
  enqueue(
    `insert into public.user_stats (user_id, runs) values ($1, 1)
     on conflict (user_id) do update set runs = public.user_stats.runs + 1, updated_at = now()`,
    [id]
  );
}
function queueWinIncrement(id) {
  enqueue(
    `insert into public.user_stats (user_id, wins) values ($1, 1)
     on conflict (user_id) do update set wins = public.user_stats.wins + 1, updated_at = now()`,
    [id]
  );
}

/* friends */
// Canonical ordering for the undirected friendship row.
function pair(a, b) { return a < b ? [a, b] : [b, a]; }

function queueFriendRequest(fromId, toId) {
  enqueue('insert into public.friend_requests (from_id, to_id) values ($1, $2) on conflict do nothing',
    [fromId, toId]);
}
// Clears a pending request in EITHER direction between the two accounts.
function queueClearRequests(a, b) {
  enqueue('delete from public.friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)',
    [a, b]);
}
function queueFriendship(a, b) {
  const p = pair(a, b);
  enqueue('insert into public.friendships (user_a, user_b) values ($1, $2) on conflict do nothing', p);
}
function queueUnfriend(a, b) {
  const p = pair(a, b);
  enqueue('delete from public.friendships where user_a = $1 and user_b = $2', p);
}

/* ---------------- shutdown ---------------- */
// Flush everything still queued. Bounded so a dead database can't hang the
// restart past the drain window server.js allows.
async function flush(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000);
  drain();
  while (queue.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (queue.length) console.error('[db] shutdown with ' + queue.length + ' write(s) unflushed');
  return queue.length === 0;
}

async function close() {
  // Disarm any pending backoff first: pool.end() below makes query() throw, so a
  // retry that fired afterwards would just log a confusing failure against a
  // closed pool.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (pool) { try { await pool.end(); } catch (e) { /* already closing */ } pool = null; }
}

module.exports = {
  configured, init, loadAll, query, flush, close, pending,
  insertProfile, deleteProfile, setRecovery, getRecovery, burnRecovery,
  setEmail, markEmailVerified, setProvider,
  putEmailToken, takeEmailToken, purgeExpiredTokens,
  queueProfile, queuePB, queueRunIncrement, queueWinIncrement,
  queueFriendRequest, queueClearRequests, queueFriendship, queueUnfriend
};
