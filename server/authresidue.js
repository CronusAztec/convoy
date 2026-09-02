/* Convoy — unfinished GoTrue deletions, retried until they actually finish.

   Deleting an account is two writes to two systems: the Postgres profile row
   (which cascades to stats, PBs, friendships, friend requests, blocks, recovery
   codes and email tokens) and the GoTrue auth user (which holds the email
   address, the password hash and every linked social identity). The second one
   can fail on its own — a 500, a 429, a timeout — and when it does the rider has
   been told their account is gone while their email address is still sitting in
   auth.users.

   That is not a cosmetic residue. Under GDPR Art. 17 and Google Play's
   account-deletion policy the deletion is simply not complete, and the address
   is also still occupying its unique index, so the same person re-registering is
   told their email is "already taken" by an account that no longer exists.

   Before this module the failure was worse than unhandled, it was INVISIBLE:
   sb.deleteUser() returns a boolean and only throws when the network is
   unreachable, but store.deleteAccount() looked for a thrown exception. Every
   HTTP-level failure — by far the likeliest kind — set no flag, logged nothing,
   and returned { ok: true }.

   So: every failed auth deletion is recorded here, persisted, and retried on a
   backoff until GoTrue confirms it. A 404 counts as done — the user is gone,
   which is the outcome we wanted.

   WHY A LIST AND NOT A SWEEP: "delete every auth user with no profile row" would
   be a one-line reaper and it would be wrong. That shape is also a legitimate,
   in-progress OAuth sign-up — GoTrue knows the person, Convoy does not have a
   username for them yet — and a sweep would delete real users mid-registration.
   Only ids this server actually tried to delete are ever retried. */
'use strict';

const fs = require('fs');
const path = require('path');
const sb = require('./supabase');

// Derived the same way store.js derives it, and deliberately NOT imported from
// store.js: store.js requires THIS module, and reaching back would be a cycle.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'auth-residue.json');

// Backoff between attempts, then hourly forever. A 429 or a restarting GoTrue
// clears in seconds; a project that is genuinely down deserves the long tail
// rather than a tight loop against an endpoint that is already struggling.
const BACKOFF_MS = [5 * 1000, 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
const SWEEP_MS = 60 * 1000;
// A bound, because this file is written from a failure path. If it ever grows
// past this something systemic is wrong and the oldest entries are the ones
// most likely to have been resolved by hand already.
const MAX = 500;

let pending = new Map();   // id -> { username, why, at, tries, nextAt }
let timer = null;
let sweeping = false;

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ } }

/* ---------------- persistence ----------------
   Written on a failure path, so at most a handful of times ever — no debounce,
   no queue, just an atomic write when the set changes. */
function save() {
  ensureDir();
  const tmp = FILE + '.' + process.pid + '.tmp';
  const arr = [];
  for (const [id, r] of pending) arr.push(Object.assign({ id: id }, r));
  try {
    fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
    renameSyncRetry(tmp, FILE);
  } catch (e) {
    console.error('[authresidue] could not persist:', e.message);
    try { fs.unlinkSync(tmp); } catch (e2) { /* may not exist */ }
  }
}

// Windows-safe rename with short backoff for transient EPERM/EACCES/EBUSY
// (antivirus/backup tools briefly holding the file). Same pattern as store.js.
function renameSyncRetry(from, to, attempts) {
  attempts = attempts || 5;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
      if (!transient || i === attempts - 1) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* brief spin; this runs at most a few ms */ }
    }
  }
}

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return; }  // nothing has ever failed — the normal case
  let arr;
  try { arr = JSON.parse(raw); } catch (e) {
    console.error('[authresidue] auth-residue.json is corrupt — starting empty');
    return;
  }
  if (!Array.isArray(arr)) return;
  for (const r of arr) {
    if (!r || typeof r.id !== 'string') continue;
    pending.set(r.id, {
      username: String(r.username || ''),
      why: String(r.why || 'unknown'),
      at: Number(r.at) || Date.now(),
      tries: Number(r.tries) || 0,
      // Due immediately on boot: a restart is itself a decent reason to think
      // whatever was broken last time may not be broken now.
      nextAt: 0
    });
  }
  if (pending.size) {
    console.error('[authresidue] ' + pending.size + ' auth user(s) still to delete — retrying');
    arm(1000);
  }
}

/* ---------------- the one call sites use ----------------
   Deletes the GoTrue user and TELLS YOU whether it worked. On failure the id is
   recorded and retried in the background, so callers can carry on: the profile
   and everything cascading from it is already gone, and making the rider retry
   the whole deletion would be answering a question they cannot act on. */
async function dropAuthUser(id, why, username) {
  if (!id) return false;
  let ok = false, err = null;
  try {
    ok = await sb.deleteUser(id);
  } catch (e) {
    err = e && e.message;
  }
  if (ok) {
    // A retry that finally lands clears the record.
    if (pending.delete(id)) save();
    return true;
  }
  record(id, why, username, err);
  return false;
}

function record(id, why, username, err) {
  if (!id) return;
  const existing = pending.get(id);
  if (existing) {
    existing.tries++;
    existing.nextAt = Date.now() + backoff(existing.tries);
  } else {
    if (pending.size >= MAX) {
      // Drop the oldest rather than refuse the newest: Map iterates in insertion
      // order, and a brand-new failure is the one someone is waiting on.
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
      console.error('[authresidue] list full — dropped ' + oldest + ' to make room');
    }
    pending.set(id, {
      username: String(username || ''),
      why: String(why || 'unknown'),
      at: Date.now(), tries: 1, nextAt: Date.now() + backoff(1)
    });
  }
  save();
  console.error('[authresidue] AUTH USER NOT DELETED ' + id +
    (username ? ' (' + username + ')' : '') + ' [' + why + ']' +
    (err ? ': ' + err : ' — GoTrue refused') + ' — will retry');
  arm(backoff((pending.get(id) || {}).tries || 1));
}

function backoff(tries) {
  return BACKOFF_MS[Math.min(tries, BACKOFF_MS.length) - 1];
}

/* ---------------- the reaper ----------------
   `force` ignores the backoff and tries everything now. The timer never passes
   it — a struggling GoTrue should not be retried in a tight loop — but an
   operator who has just fixed the thing that was broken should not have to wait
   out an hour-long backoff to find out. That is what store.retryAuthDeletions()
   is. */
async function sweep(force) {
  if (sweeping || !pending.size) return 0;
  sweeping = true;
  const now = Date.now();
  let cleared = 0;
  try {
    for (const [id, r] of Array.from(pending)) {
      if (!force && r.nextAt > now) continue;
      let ok = false;
      try { ok = await sb.deleteUser(id); }
      catch (e) { ok = false; }
      if (ok) {
        pending.delete(id);
        cleared++;
        console.log('[authresidue] finished deleting auth user ' + id +
          (r.username ? ' (' + r.username + ')' : '') + ' after ' + (r.tries + 1) + ' attempt(s)');
      } else {
        r.tries++;
        r.nextAt = Date.now() + backoff(r.tries);
      }
    }
    save();
  } finally {
    sweeping = false;
  }
  if (pending.size) arm(SWEEP_MS);
  return cleared;
}

// .unref()'d: a pending retry is not a reason to hold the process open. A
// restart re-arms from load() anyway, and shutdown should not wait on it.
function arm(ms) {
  if (timer) return;
  timer = setTimeout(function () { timer = null; sweep(); }, Math.max(1000, ms || SWEEP_MS));
  if (timer.unref) timer.unref();
}

load();

module.exports = {
  dropAuthUser: dropAuthUser,
  sweep: sweep,
  count: function () { return pending.size; },
  // Ops probe: what is still outstanding, and since when.
  list: function () {
    const out = [];
    for (const [id, r] of pending) {
      out.push({ id: id, username: r.username, why: r.why, since: r.at, tries: r.tries });
    }
    return out;
  },
  has: function (id) { return pending.has(id); },
  _reset: function () {
    pending = new Map();
    if (timer) { clearTimeout(timer); timer = null; }
    try { fs.unlinkSync(FILE); } catch (e) { /* may not exist */ }
  },
  _load: load
};
