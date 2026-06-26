/* Convoy — user store. JSON-file backed, atomic writes, async scrypt hashing.
   No database dependency: fine for friends-scale. Data lives in DATA_DIR
   (default server/data) which survives redeploys (the tarball never overwrites it). */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

let users = {};   // usernameLower -> user record
let byId = {};    // id -> user record
let dirty = false;
let flushTimer = null;
let flushInFlight = false;

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ } }

function load() {
  ensureDir();
  let raw;
  try {
    raw = fs.readFileSync(USERS_FILE, 'utf8');
  } catch (e) {
    return; // fresh install — no file yet
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    // Corrupt users.json (e.g. a partial write from a crash). Don't silently
    // boot empty and then overwrite the file — back it up first, then proceed
    // with whatever accounts we already have in memory (none on cold boot).
    const backup = USERS_FILE + '.corrupt.' + Date.now();
    try { fs.copyFileSync(USERS_FILE, backup); console.error('[store] users.json corrupt — backed up to ' + backup); }
    catch (e2) { console.error('[store] users.json corrupt and could not back up:', e2.message); }
    return;
  }
  if (Array.isArray(arr)) {
    arr.forEach((u) => {
      // migrate older records that predate friends / recovery / tokenVersion
      if (!Array.isArray(u.friends)) u.friends = [];
      if (!Array.isArray(u.reqIn)) u.reqIn = [];
      if (!Array.isArray(u.reqOut)) u.reqOut = [];
      if (typeof u.tokenVersion !== 'number') u.tokenVersion = 0;
      users[u.username.toLowerCase()] = u;
      byId[u.id] = u;
    });
    console.log('[store] loaded ' + arr.length + ' accounts');
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  // Arm a timer even if a flush is in flight — that flush captured a snapshot
  // at its start, so any write that lands during it must trigger a follow-up
  // flush or it's lost until the next unrelated mutation.
  flushTimer = setTimeout(flush, 800);
}

// Async flush: never blocks the realtime loop. Serializes via flushInFlight so a
// fast burst of writes can't kick off overlapping file operations.
async function flush() {
  if (flushInFlight) return; // scheduleFlush() keeps a follow-up timer armed
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  flushInFlight = true;
  ensureDir();
  const tmp = USERS_FILE + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(Object.values(byId)), 'utf8');
    await renameRetry(tmp, USERS_FILE);
  } catch (e) {
    console.error('[store] flush failed:', e.message);
    dirty = true; // try again on next schedule
    try { await fsp.unlink(tmp); } catch (e2) { /* may not exist */ }
  } finally {
    flushInFlight = false;
    // If writes landed while we were running, scheduleFlush armed a timer for us.
  }
}

// Async rename with a short backoff for Windows transient EPERM/EACCES/EBUSY
// (antivirus/backup tools briefly holding the file). No busy-spin — uses setTimeout.
function renameRetry(from, to, attempts) {
  attempts = attempts || 5;
  return new Promise((resolve, reject) => {
    let i = 0;
    function attempt() {
      fsp.rename(from, to).then(resolve, (e) => {
        const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
        if (!transient || i >= attempts - 1) return reject(e);
        i++;
        setTimeout(attempt, 40 * i);
      });
    }
    attempt();
  });
}

// Synchronous fallback used only by process 'exit' (which cannot run async work).
// Best-effort: writes the tmp file and renames in one shot.
function flushSync() {
  if (!dirty) return;
  dirty = false;
  ensureDir();
  const tmp = USERS_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.values(byId)), 'utf8');
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    console.error('[store] flushSync failed:', e.message);
    dirty = true;
    try { fs.unlinkSync(tmp); } catch (e2) { /* may not exist */ }
  }
}

/* ---------------- password hashing (async scrypt — never blocks the realtime loop) ---------------- */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, dk) => (err ? reject(err) : resolve({ salt, hash: dk.toString('hex') })));
  });
}

function verifyPassword(password, salt, hash) {
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (err, dk) => {
      if (err) return resolve(false);
      const hb = Buffer.from(hash, 'hex');
      resolve(dk.length === hb.length && crypto.timingSafeEqual(dk, hb));
    });
  });
}

/* ---------------- recovery codes ---------------- */
// Human-friendly, unambiguous (no 0/O/1/I): CVY-XXXX-XXXX
function genRecoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += A[bytes[i] % A.length];
  return 'CVY-' + s.slice(0, 4) + '-' + s.slice(4);
}
function normalizeCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/* ---------------- accounts ---------------- */
function getByUsername(username) { return users[String(username || '').toLowerCase()] || null; }
function getById(id) { return byId[id] || null; }

async function createUser(username, password, profile) {
  const lower = username.toLowerCase();
  // NOTE: do the (slow, constant-cost) scrypt BEFORE checking whether the name
  // is taken. Returning early on a collision would let an attacker enumerate
  // valid usernames by timing /api/register. We still re-check after the await
  // to handle a genuine create-create race.
  const { salt, hash } = await hashPassword(password);
  if (users[lower]) return { error: 'taken' }; // lost a race during hashing
  const recoveryCode = genRecoveryCode();
  const rec = await hashPassword(normalizeCode(recoveryCode));
  const user = {
    id: 'a' + crypto.randomBytes(6).toString('hex'),
    username,
    salt,
    hash,
    recovery: { salt: rec.salt, hash: rec.hash },
    tokenVersion: 0, // bumped on password change/recover to invalidate old tokens
    profile,
    friends: [],
    reqIn: [],
    reqOut: [],
    createdAt: Date.now()
  };
  users[lower] = user;
  byId[user.id] = user;
  scheduleFlush();
  return { user, recoveryCode };
}

async function verifyUser(username, password) {
  const u = getByUsername(username);
  if (!u) {
    // spend ~equal time so timing doesn't reveal whether the username exists
    await verifyPassword(password, 'deadbeefdeadbeefdeadbeefdeadbeef', '00');
    return null;
  }
  const ok = await verifyPassword(password, u.salt, u.hash);
  return ok ? u : null;
}

async function setPassword(id, newPassword) {
  const u = byId[id];
  if (!u) return false;
  const { salt, hash } = await hashPassword(newPassword);
  u.salt = salt; u.hash = hash;
  u.tokenVersion = (u.tokenVersion || 0) + 1; // invalidate all previously-minted tokens
  scheduleFlush();
  return true;
}

// Verify a recovery code for username; on success returns the user (does not consume it).
async function verifyRecovery(username, code) {
  const u = getByUsername(username);
  if (!u || !u.recovery) {
    await verifyPassword('x', 'deadbeefdeadbeefdeadbeefdeadbeef', '00');
    return null;
  }
  const ok = await verifyPassword(normalizeCode(code), u.recovery.salt, u.recovery.hash);
  return ok ? u : null;
}

// Regenerate a recovery code (e.g. after use, or from settings). Returns the new plaintext code.
async function regenRecovery(id) {
  const u = byId[id];
  if (!u) return null;
  const code = genRecoveryCode();
  const rec = await hashPassword(normalizeCode(code));
  u.recovery = { salt: rec.salt, hash: rec.hash };
  scheduleFlush();
  return code;
}

function updateProfile(id, profile) {
  const u = byId[id];
  if (!u) return false;
  u.profile = profile;
  scheduleFlush();
  return true;
}

/* ---------------- friends ---------------- */
function friendLite(u) {
  return { id: u.id, username: u.username, name: u.profile.name, emoji: u.profile.emoji, paint: u.profile.car.paint };
}
function pull(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }

// Returns { error } | { ok, autoAccepted, target }
function sendFriendRequest(fromId, toUsername) {
  const from = byId[fromId];
  const to = getByUsername(toUsername);
  if (!from) return { error: 'unauthorized' };
  if (!to) return { error: 'No rider with that username' };
  if (to.id === from.id) return { error: "You can't friend yourself" };
  if (from.friends.indexOf(to.id) >= 0) return { error: 'Already friends' };
  if (from.reqOut.indexOf(to.id) >= 0) return { error: 'Request already sent' };

  // they already asked us → accept immediately
  if (from.reqIn.indexOf(to.id) >= 0) {
    acceptFriend(from.id, to.id);
    return { ok: true, autoAccepted: true, target: to };
  }
  from.reqOut.push(to.id);
  to.reqIn.push(from.id);
  scheduleFlush();
  return { ok: true, autoAccepted: false, target: to };
}

function acceptFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u || !o) return false;
  pull(u.reqIn, otherId); pull(u.reqOut, otherId);
  pull(o.reqIn, userId); pull(o.reqOut, userId);
  if (u.friends.indexOf(otherId) < 0) u.friends.push(otherId);
  if (o.friends.indexOf(userId) < 0) o.friends.push(userId);
  scheduleFlush();
  return true;
}

function declineFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u) return false;
  pull(u.reqIn, otherId); pull(u.reqOut, otherId);
  if (o) { pull(o.reqOut, userId); pull(o.reqIn, userId); }
  scheduleFlush();
  return true;
}

function removeFriend(userId, otherId) {
  const u = byId[userId], o = byId[otherId];
  if (!u) return false;
  pull(u.friends, otherId);
  if (o) pull(o.friends, userId);
  scheduleFlush();
  return true;
}

function areFriends(aId, bId) {
  const a = byId[aId];
  return !!(a && a.friends.indexOf(bId) >= 0);
}

function count() { return Object.keys(byId).length; }

load();
// Shutdown is driven by server.js (graceful drain + store.flush()). We keep a
// bare `exit` fallback so a normal process end still writes any pending state;
// `exit` runs synchronously and cannot await, so use the sync fallback.
process.on('exit', flushSync);

module.exports = {
  getByUsername, getById, createUser, verifyUser, updateProfile, count, flush, flushSync, DATA_DIR,
  setPassword, verifyRecovery, regenRecovery,
  friendLite, sendFriendRequest, acceptFriend, declineFriend, removeFriend, areFriends
};
