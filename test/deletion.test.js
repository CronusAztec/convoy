/* Convoy — account deletion: does it actually finish?

   Deleting an account is two writes to two systems, and the interesting cases
   are all "the second one failed after the first one succeeded". Nothing else
   exercises them, and each one done wrong is a compliance failure that looks
   like a success:

     - The Postgres profile cascades to stats, PBs, friendships, friend
       requests, blocks, recovery codes and email tokens. The GoTrue user is
       separate, and holds the email address, the password hash and every linked
       social identity.
     - `sb.deleteUser()` returns a BOOLEAN and only throws when GoTrue is
       unreachable. store.deleteAccount() used to watch for a thrown exception,
       so a 500, a 429 or an expired admin key set no flag, logged nothing, and
       the rider was told { ok: true } while their address was still in
       auth.users — blocking them from ever re-registering it, too.
     - A 404 from GoTrue is the END STATE, not a failure. Treating it as one
       would leave the retry loop hammering an id that is already gone.
     - The retry list must only ever contain ids this server actually tried to
       delete. "Delete every auth user with no profile row" is the obvious
       reaper and it is wrong: that shape is also a legitimate half-finished
       OAuth sign-up, and a sweep would delete real users mid-registration.

   Runs the REAL server/authresidue.js and server/store.js, with GoTrue and
   Postgres faked out and DATA_DIR pointed at a temp directory.

   Run:  node test/deletion.test.js
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything requires authresidue.js — it resolves DATA_DIR at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convoy-deletion-'));
process.env.DATA_DIR = TMP;

const H = require('./harness');
const { group, ok, report } = H;

const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
const SB_PATH = require.resolve('../server/supabase.js');
const DB_PATH = require.resolve('../server/db.js');
const STORE_PATH = require.resolve('../server/store.js');
const RESIDUE_PATH = require.resolve('../server/authresidue.js');
const RESIDUE_FILE = path.join(TMP, 'auth-residue.json');

/* ================================================================== */
group('GoTrue delete: which statuses mean "gone"');

// The real supabase.js, with fetch stubbed. This is the layer where a 404 has
// to be read as success and a 500 must not be.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
let nextStatus = 200;
let fetchCalls = 0;
global.fetch = async function () {
  fetchCalls++;
  if (nextStatus === 0) throw new Error('socket hang up');
  return { status: nextStatus, json: async () => ({}) };
};
delete require.cache[SB_PATH];
const realSb = require(SB_PATH);

(async function statuses() {
  nextStatus = 200;
  ok('200 → deleted', (await realSb.deleteUser(UID)) === true);
  nextStatus = 204;
  ok('204 → deleted', (await realSb.deleteUser(UID)) === true);
  nextStatus = 404;
  ok('404 → deleted (there is no such user, which is the outcome we wanted)',
    (await realSb.deleteUser(UID)) === true,
    'a false here leaves the retry loop hammering an id that is already gone');
  nextStatus = 500;
  ok('500 → NOT deleted', (await realSb.deleteUser(UID)) === false);
  nextStatus = 429;
  ok('429 → NOT deleted', (await realSb.deleteUser(UID)) === false);
  nextStatus = 401;
  ok('401 (expired admin key) → NOT deleted', (await realSb.deleteUser(UID)) === false);

  let threw = false;
  nextStatus = 0;
  try { await realSb.deleteUser(UID); } catch (e) { threw = true; }
  ok('an unreachable GoTrue throws rather than returning false', threw,
    'callers distinguish "refused" from "could not ask"');

  await residueTests();
})();

/* ================================================================== */
async function residueTests() {
  group('the retry list');

  // A controllable GoTrue for authresidue.js and store.js to talk to.
  const sb = {
    _ok: false,
    calls: [],
    configured: () => true,
    forwardsIp: () => false,
    emailFor: (u) => u + '@users.convoy.test',
    verify: () => null,
    deleteUser: async function (id) {
      sb.calls.push(id);
      if (sb._ok === 'throw') throw new Error('Supabase Auth unreachable: timed out');
      return !!sb._ok;
    }
  };
  require.cache[SB_PATH] = { id: SB_PATH, filename: SB_PATH, loaded: true, children: [], paths: [], exports: sb };
  delete require.cache[RESIDUE_PATH];
  const residue = require(RESIDUE_PATH);
  residue._reset();

  sb._ok = false;
  sb.calls.length = 0;
  let done = await residue.dropAuthUser(UID, 'delete', 'rider');
  ok('a refused delete is reported as a failure, not swallowed', done === false);
  ok('...and the id is queued for retry', residue.has(UID) && residue.count() === 1,
    'count=' + residue.count());
  ok('...and written to disk, so a restart does not forget it', fs.existsSync(RESIDUE_FILE));

  sb._ok = 'throw';
  done = await residue.dropAuthUser(OTHER, 'delete', 'other');
  ok('an unreachable GoTrue is queued too, not thrown at the caller', done === false && residue.has(OTHER));

  // A queued entry is not retried instantly — a struggling GoTrue should not be
  // hammered — so an unforced sweep leaves it alone until its backoff is up.
  sb._ok = true;
  sb.calls.length = 0;
  ok('an unforced sweep respects the backoff', (await residue.sweep()) === 0 && sb.calls.length === 0,
    'asked ' + sb.calls.length + ' time(s) — a tight retry loop against a failing GoTrue makes it worse');

  // GoTrue comes back and an operator retries now. sweep(true) is that button.
  sb._ok = true;
  sb.calls.length = 0;
  const cleared = await residue.sweep(true);
  ok('the sweep finishes both deletions once GoTrue recovers', cleared === 2, 'cleared=' + cleared);
  ok('...and the list is empty afterwards', residue.count() === 0);
  ok('...and it only asked about the ids it was given',
    sb.calls.length === 2 && sb.calls.indexOf(UID) >= 0 && sb.calls.indexOf(OTHER) >= 0,
    JSON.stringify(sb.calls));

  // The one thing a naive reaper gets wrong.
  sb._ok = true;
  sb.calls.length = 0;
  await residue.sweep(true);
  ok('an id that was never recorded is never deleted', sb.calls.length === 0,
    'an auth user with no profile is ALSO an unfinished OAuth sign-up — a blind ' +
    '"delete every profile-less auth user" sweep would delete real people mid-registration');

  group('the retry list survives a restart');

  sb._ok = false;
  await residue.dropAuthUser(UID, 'delete', 'rider');
  ok('one outstanding deletion before the restart', residue.count() === 1);

  // Reload the module from disk, exactly as a process restart would.
  delete require.cache[RESIDUE_PATH];
  const reborn = require(RESIDUE_PATH);
  ok('it comes back after a restart', reborn.count() === 1 && reborn.has(UID),
    'count=' + reborn.count());
  const entry = reborn.list()[0];
  ok('...with the username and reason kept, so the log means something',
    entry.username === 'rider' && entry.why === 'delete', JSON.stringify(entry));

  // No force needed here: load() marks everything due immediately, because a
  // restart is itself a decent reason to think the outage may be over.
  sb._ok = true;
  ok('a reloaded entry is due at once, without waiting out its old backoff',
    (await reborn.sweep()) === 1);
  ok('and the restarted process finishes the job', reborn.count() === 0);

  await storeTests(sb, reborn);
}

/* ================================================================== */
async function storeTests(sb, residue) {
  group('store.deleteAccount reports what actually happened');

  const dbCalls = [];
  const db = {
    init: async () => ({ role: 'postgres', profiles: 1 }),
    loadAll: async () => ([{
      id: UID, username: 'rider', email: 'rider@example.com', emailVerified: true,
      provider: 'password', profile: {}, friends: [], reqIn: [], reqOut: [],
      blocked: [], blockedBy: [], stats: { pb: {}, runs: 0, wins: 0 }, createdAt: Date.now()
    }]),
    deleteProfile: async () => { dbCalls.push('deleteProfile'); },
    flush: async () => { dbCalls.push('flush'); return true; },
    close: async () => {}, pending: () => 0, query: async () => ({ rows: [] }),
    queueProfile() {}, queuePB() {}, queueRunIncrement() {}, queueWinIncrement() {},
    queueFriendRequest() {}, queueClearRequests() {}, queueFriendship() {}, queueUnfriend() {},
    queueBlock() {}, queueUnblock() {}
  };
  require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, children: [], paths: [], exports: db };
  delete require.cache[STORE_PATH];
  const store = require(STORE_PATH);
  await store.init();

  residue._reset();

  // The bug, as it shipped: GoTrue answers 500, sb.deleteUser returns false
  // WITHOUT throwing, and the old code only watched for a thrown exception.
  sb._ok = false;
  sb.calls.length = 0;
  dbCalls.length = 0;
  let res = await store.deleteAccount(UID);
  ok('the deletion still succeeds for the rider — their profile really is gone',
    res.ok === true, JSON.stringify(res));
  ok('the profile row was deleted first, so the cascade ran',
    dbCalls.indexOf('deleteProfile') >= 0);
  ok('the pending writes were flushed before the delete',
    dbCalls.indexOf('flush') >= 0 && dbCalls.indexOf('flush') < dbCalls.indexOf('deleteProfile'),
    JSON.stringify(dbCalls) + ' — a queued profile write landing after the delete resurrects the row');
  ok('a GoTrue 500 is now REPORTED as residue', res.authResidue === true,
    'this was false before the fix: no flag, no log, and the rider told { ok: true } ' +
    'while their email address was still in auth.users');
  ok('...and the unfinished half is queued for retry', residue.has(UID) && residue.count() === 1);
  ok('the account is gone from the read model either way', store.getById(UID) == null);
  ok('...and tombstoned, so its still-valid access token cannot walk back into sign-up',
    store.isDeleted(UID) === true);

  // GoTrue recovers; the reaper finishes it without anyone asking again.
  sb._ok = true;
  await residue.sweep(true);
  ok('the retry finishes the auth deletion later, unattended', residue.count() === 0);

  group('the happy path stays clean');

  delete require.cache[STORE_PATH];
  const store2 = require(STORE_PATH);
  await store2.init();
  residue._reset();
  sb._ok = true;
  sb.calls.length = 0;
  res = await store2.deleteAccount(UID);
  ok('a working GoTrue reports no residue', res.ok === true && res.authResidue === false,
    JSON.stringify(res));
  ok('...and nothing is queued', residue.count() === 0);
  ok('...and the auth user was actually asked about', sb.calls.indexOf(UID) >= 0);

  res = await store2.deleteAccount(UID);
  ok('deleting an account twice is a clean 404, not a crash',
    res.error === 'no-such-account', JSON.stringify(res));

  group('the ops surface');

  sb._ok = false;
  await store2.deleteAccount('nope');   // no such account — must not queue anything
  ok('a deletion that never started queues nothing', store2.pendingAuthDeletions() === 0);
  ok('store exposes the outstanding count for the dashboard',
    typeof store2.pendingAuthDeletions === 'function' &&
    typeof store2.retryAuthDeletions === 'function');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(report());
}
