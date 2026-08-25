/* Convoy — server/store.js account lifecycle, with GoTrue and Postgres faked out.

   store.js coordinates two systems that can each fail independently, and the
   interesting cases are all "the second one failed after the first one
   succeeded". Those paths never run in normal use, so nothing else exercises
   them — and each one, done wrong, costs a rider their account:

     - A registration whose final sign-in fails would leave a real, complete
       account behind while telling the caller it failed. The username is then
       held forever by an account nobody was ever shown a recovery code for.
     - A recovery code is shown ONCE and is the only reset path Convoy has. If
       the reset fails AFTER the code is burned — GoTrue rejecting the new
       password, or being unreachable — the rider is locked out permanently
       unless the code is put back.
     - A GoTrue 429 must not reach the rider as "wrong password", or they head
       for the recovery flow and spend that one code over a transient limit.

   Run:  node test/store.test.js
*/
'use strict';
const path = require('path');
const H = require('./harness');

const DB_PATH = path.join(__dirname, '..', 'server', 'db.js');
const SB_PATH = path.join(__dirname, '..', 'server', 'supabase.js');
const STORE_PATH = path.join(__dirname, '..', 'server', 'store.js');

const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/* ---------------- fakes ---------------- */
function makeFakes(seed) {
  const calls = [];
  const rec = { row: null };          // the one recovery_codes row
  const tokens = new Map();           // token_hash -> the email_tokens row

  const db = {
    init: async () => ({ role: 'postgres', profiles: seed.length }),
    loadAll: async () => seed.map((u) => Object.assign({
      profile: {}, friends: [], reqIn: [], reqOut: [],
      stats: { pb: {}, runs: 0, wins: 0 }, createdAt: Date.now()
    }, u)),
    insertProfile: async (id, u, p, opts) => {
      calls.push('insertProfile:' + ((opts && opts.email) || 'no-email'));
      return db._insert || { ok: true };
    },
    deleteProfile: async () => { calls.push('deleteProfile'); },
    setRecovery: async (id, salt, hash) => { calls.push('setRecovery'); rec.row = { salt, hash }; },
    getRecovery: async () => (rec.row ? Object.assign({}, rec.row) : null),
    burnRecovery: async (id, hash) => {
      calls.push('burnRecovery');
      if (rec.row && rec.row.hash === hash) { rec.row = null; return true; }
      return false;
    },
    setEmail: async (id, email, verified) => {
      calls.push('setEmail:' + email + ':' + verified);
      return db._setEmail || { ok: true };
    },
    markEmailVerified: async (id) => { calls.push('markEmailVerified'); },
    setProvider: async () => { calls.push('setProvider'); },
    putEmailToken: async (hash, userId, purpose, email, payload, expiresAt) => {
      calls.push('putEmailToken:' + purpose);
      // The real one opens with a DELETE over (user_id, purpose): a new link
      // revokes the outstanding one. Mirror that, or the fake would let a test
      // pass against behaviour Postgres does not have.
      for (const [k, v] of tokens) if (v.user_id === userId && v.purpose === purpose) tokens.delete(k);
      tokens.set(hash, { user_id: userId, purpose, email, payload, expires_at: expiresAt });
    },
    takeEmailToken: async (hash, purpose) => {
      calls.push('takeEmailToken:' + purpose);
      const row = tokens.get(hash);
      // Mirrors the real DELETE … RETURNING: wrong purpose or expired matches
      // nothing, and a hit is burned in the same step.
      if (!row || row.purpose !== purpose || row.expires_at <= Date.now()) return null;
      tokens.delete(hash);
      return row;
    },
    purgeExpiredTokens: async () => 0,
    query: async () => ({ rows: [] }),
    flush: async () => true, close: async () => {}, pending: () => 0,
    queueProfile() {}, queuePB() {}, queueRunIncrement() {}, queueWinIncrement() {},
    queueFriendRequest() {}, queueClearRequests() {}, queueFriendship() {}, queueUnfriend() {}
  };

  const session = () => ({
    access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: UID }
  });

  const sb = {
    _create: { user: { id: UID } },
    _signIn: null,                    // null → succeed
    _setPassword: null,               // null → succeed
    _updateEmail: null,               // null → succeed
    _verifyOtp: null,                 // null → succeed
    configured: () => true,
    forwardsIp: () => true,
    emailFor: (u) => u + '@users.convoy.test',
    syntheticDomain: 'users.convoy.test',
    verify: () => null,
    loadJwks: async () => true,
    createUser: async (u, p, ip, email) => {
      // The real one takes an OPTIONAL address; recording it is what proves
      // store.js passes a real address through instead of the synthetic one.
      calls.push('sb.createUser:' + ip + ':' + (email || 'no-email'));
      return sb._create;
    },
    deleteUser: async () => { calls.push('sb.deleteUser'); return true; },
    setPassword: async (id, p, ip) => {
      calls.push('sb.setPassword:' + ip);
      return sb._setPassword || { ok: true };
    },
    signIn: async (u, p, ip) => {
      calls.push('sb.signIn:' + ip);
      return sb._signIn || { session: session() };
    },
    // Every password grant goes through here now; the address it is called with
    // is the thing worth asserting on.
    signInEmail: async (email, p, ip) => {
      calls.push('sb.signInEmail:' + email);
      return sb._signIn || { session: session() };
    },
    updateEmail: async (id, email, ip) => {
      calls.push('sb.updateEmail:' + email);
      return sb._updateEmail || { user: { id: id, email: email } };
    },
    generateLink: async (type, email) => {
      calls.push('sb.generateLink:' + type);
      return { hashedToken: 'gotrue-hashed-' + email };
    },
    verifyOtp: async (type, token, email) => {
      calls.push('sb.verifyOtp:' + type + ':' + token);
      return sb._verifyOtp || { session: session() };
    },
    refresh: async () => ({ session: session() }),
    signOut: async () => { calls.push('sb.signOut'); return true; }
  };

  delete require.cache[require.resolve(STORE_PATH)];
  require.cache[require.resolve(DB_PATH)] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: db };
  require.cache[require.resolve(SB_PATH)] = { id: SB_PATH, filename: SB_PATH, loaded: true, exports: sb };
  const store = require(STORE_PATH);
  return { store, db, sb, calls, rec };
}

const seeded = () => [{ id: UID, username: 'rider' }];

(async function main() {

  /* ================= registration ================= */
  H.group('A registration that cannot be completed leaves nothing behind');
  {
    const { store, sb, calls } = makeFakes(seeded());
    await store.init();
    sb._signIn = { error: 'boom', status: 500 };     // fails only at the final sign-in
    const r = await store.createUser('newrider', 'password1', {}, '203.0.113.7');

    H.ok('the caller is told it failed', !!r.error && !r.user, JSON.stringify(r));
    H.ok('the half-made auth user is deleted', calls.indexOf('sb.deleteUser') >= 0,
      calls.join(', '));
    H.ok('and so is its profile row', calls.indexOf('deleteProfile') >= 0, calls.join(', '));
    H.ok('the username is NOT left claimed in memory', store.getByUsername('newrider') === null);
    H.ok('the caller IP was forwarded on the way in',
      calls.indexOf('sb.createUser:203.0.113.7:no-email') >= 0, calls.join(', '));
  }
  {
    const { store, sb } = makeFakes(seeded());
    await store.init();
    sb._create = { user: { id: 'ffffffff-1111-2222-3333-444444444444' } };
    const r = await store.createUser('newrider', 'password1', {}, '203.0.113.7');
    H.ok('a clean registration still returns a session and a code',
      !!r.user && !!r.session && !!r.recoveryCode, JSON.stringify(r && r.error));
    H.ok('and the account is readable immediately', !!store.getByUsername('newrider'));
  }
  {
    const { store, sb } = makeFakes(seeded());
    await store.init();
    sb._create = { error: 'weak-password', status: 422, detail: 'too weak' };
    const r = await store.createUser('newrider', 'pw', {}, '1.2.3.4');
    H.ok('a password GoTrue rejects is reported as such, not as "taken"',
      r.error === 'weak-password', JSON.stringify(r));
    H.ok('with the reason carried through for the rider', r.detail === 'too weak');
  }

  /* ================= sign-in ================= */
  H.group('A rate limit is never reported as a wrong password');
  {
    const { store, sb } = makeFakes(seeded());
    await store.init();

    sb._signIn = { error: 'slow down', status: 429 };
    H.ok('429 → rate-limited', (await store.signIn('rider', 'pw', '1.2.3.4')).error === 'rate-limited');
    H.ok('and verifyPassword agrees',
      (await store.verifyPassword('rider', 'pw', '1.2.3.4')).error === 'rate-limited');

    sb._signIn = { error: 'Invalid login credentials', status: 400 };
    H.ok('400 → bad-credentials', (await store.signIn('rider', 'pw', '1.2.3.4')).error === 'bad-credentials');

    sb._signIn = { error: 'gateway', status: 503 };
    H.ok('5xx → unavailable, not a credential problem',
      (await store.signIn('rider', 'pw', '1.2.3.4')).error === 'unavailable');

    sb._signIn = null;
    const good = await store.signIn('rider', 'pw', '1.2.3.4');
    H.ok('a real sign-in returns the user and session', !!good.user && !!good.session);
    H.ok('verifyPassword succeeds the same way',
      (await store.verifyPassword('rider', 'pw', '1.2.3.4')).ok === true);
  }
  {
    const { store, sb } = makeFakes([]);          // auth knows the user, we don't
    await store.init();
    sb._signIn = null;
    H.ok('an auth user with no profile row is its own failure, not a bad password',
      (await store.signIn('ghost', 'pw', '1.2.3.4')).error === 'no-profile');
  }

  /* ================= recovery ================= */
  H.group('A recovery code is only spent when the reset actually happens');
  {
    const { store, sb, rec } = makeFakes(seeded());
    await store.init();
    const code = await store.regenRecovery(UID);
    const issued = { salt: rec.row.salt, hash: rec.row.hash };

    sb._setPassword = { error: 'weak-password', status: 422, detail: 'too weak' };
    const r = await store.resetWithRecovery('rider', code, 'password1', '1.2.3.4');

    H.ok('the reset is refused', r.error === 'weak-password', JSON.stringify(r));
    H.ok('and the code is PUT BACK, not spent', !!rec.row && rec.row.hash === issued.hash);

    // Proving it really still works is the point of the whole fix.
    sb._setPassword = null;
    const again = await store.resetWithRecovery('rider', code, 'password1', '1.2.3.4');
    H.ok('so the same code can be used on the retry', !!again.session && !again.error,
      JSON.stringify(again && again.error));
    H.ok('and the retry issues a fresh replacement code',
      !!again.recoveryCode && again.recoveryCode !== code);
  }
  {
    const { store, sb, rec } = makeFakes(seeded());
    await store.init();
    const code = await store.regenRecovery(UID);
    const issued = rec.row.hash;

    // Password change lands, but the re-sign-in that follows it does not.
    // freshSoleSession drives the grant through signInEmail now, so that is the
    // one to break.
    let n = 0;
    sb.signInEmail = async () => (++n === 1 ? { error: 'gateway', status: 503 } : { session: {} });
    const r = await store.resetWithRecovery('rider', code, 'password1', '1.2.3.4');
    H.ok('the caller is told it failed', !!r.error);
    H.ok('the account is not left with NO recovery code at all',
      !!rec.row && rec.row.hash === issued);
  }
  {
    const { store, rec } = makeFakes(seeded());
    await store.init();
    const code = await store.regenRecovery(UID);
    const r = await store.resetWithRecovery('rider', 'CVY-WRON-GXXX', 'password1', '1.2.3.4');
    H.ok('a wrong code is rejected', r.error === 'bad-code');
    H.ok('and does not burn the real one', !!rec.row);
    H.ok('an unknown username is rejected the same way',
      (await store.resetWithRecovery('nobody', code, 'password1', '1.2.3.4')).error === 'bad-code');
  }
  {
    const { store, rec } = makeFakes(seeded());
    await store.init();
    const code = await store.regenRecovery(UID);
    const ok = await store.resetWithRecovery('rider', code, 'password1', '1.2.3.4');
    H.ok('a successful reset does spend the code', !!ok.session);
    const replay = await store.resetWithRecovery('rider', code, 'password2', '1.2.3.4');
    H.ok('and it cannot be replayed', replay.error === 'bad-code', JSON.stringify(replay));
  }

  /* ================= email as a second identifier ================= */
  // Every account used to be reachable at exactly one derived address,
  // <username>@AUTH_EMAIL_DOMAIN, and every password grant could rebuild it from
  // the username alone. That stopped being true the moment real addresses
  // existed: an account registered with one is keyed in GoTrue by THAT address,
  // and signing it in with the synthetic one fails as "wrong password". Getting
  // this wrong locks people out of accounts whose passwords are perfectly
  // correct, so it is worth pinning down.
  H.group('The address GoTrue is asked about matches the account');
  {
    const { store, sb, calls } = makeFakes([]);
    await store.init();
    sb._create = { user: { id: UID } };
    const r = await store.createUser('newrider', 'password1', {}, '1.2.3.4', 'Rider@Example.COM');

    H.ok('registering with an email creates the auth user AT that address',
      calls.indexOf('sb.createUser:1.2.3.4:rider@example.com') >= 0, calls.join(', '));
    H.ok('and the address is normalised to lowercase on the way in',
      r.user.email === 'rider@example.com', r.user && r.user.email);
    H.ok('the sign-in that follows uses it too, not the synthetic address',
      calls.indexOf('sb.signInEmail:rider@example.com') >= 0, calls.join(', '));
    H.ok('it starts UNVERIFIED — nobody has opened the link yet',
      r.user.emailVerified === false);
    H.ok('and it is findable by address', store.getByEmail('RIDER@EXAMPLE.com') === r.user);
  }
  {
    const { store, sb, calls } = makeFakes([]);
    await store.init();
    sb._create = { error: 'taken', status: 422 };
    const r = await store.createUser('newrider', 'password1', {}, '1.2.3.4', 'taken@example.com');
    // GoTrue only knows the address at this point — the username has not been
    // offered to it — so its "taken" can only mean the address.
    H.ok('a duplicate address is reported as the ADDRESS, not the username',
      r.error === 'email-taken', JSON.stringify(r));
  }
  {
    const { store, calls } = makeFakes([{ id: UID, username: 'rider', email: 'rider@example.com' }]);
    await store.init();
    await store.signIn('rider', 'password1', '1.2.3.4');
    H.ok('a username on an email account resolves to the REAL address',
      calls.indexOf('sb.signInEmail:rider@example.com') >= 0, calls.join(', '));

    calls.length = 0;
    await store.signIn('RIDER@example.com', 'password1', '1.2.3.4');
    H.ok('and an address typed into the same box is used as given',
      calls.indexOf('sb.signInEmail:rider@example.com') >= 0, calls.join(', '));
  }
  {
    const { store, calls } = makeFakes([{ id: UID, username: 'legacy' }]);
    await store.init();
    await store.signIn('legacy', 'password1', '1.2.3.4');
    H.ok('an account with NO address still uses the synthetic one',
      calls.indexOf('sb.signInEmail:legacy@users.convoy.test') >= 0, calls.join(', '));

    // An unknown username must fail identically to a wrong password: returning
    // early here would make this a "does that username exist?" oracle.
    calls.length = 0;
    await store.signIn('nobody', 'password1', '1.2.3.4');
    H.ok('an unknown username is still sent to GoTrue rather than answered locally',
      calls.indexOf('sb.signInEmail:nobody@users.convoy.test') >= 0, calls.join(', '));
  }

  /* ================= one-time email links ================= */
  H.group('Email links are single-use, purpose-scoped and expiring');
  {
    const { store } = makeFakes(seeded());
    await store.init();
    const token = await store.issueEmailToken(UID, 'reset', 'rider@example.com');
    H.ok('the token is long enough to be unguessable', token.length >= 40, String(token.length));

    const wrongPurpose = await store.consumeEmailToken(token, 'magic');
    H.ok('it cannot be redeemed as a different KIND of link', wrongPurpose === null);

    const claim = await store.consumeEmailToken(token, 'reset');
    H.ok('it redeems once, for the right purpose', !!claim && claim.userId === UID);
    H.ok('and carries the address it was sent to', claim.email === 'rider@example.com');

    const replay = await store.consumeEmailToken(token, 'reset');
    H.ok('a second attempt finds nothing — burned on redemption', replay === null);
  }
  {
    const { store } = makeFakes(seeded());
    await store.init();
    const a = await store.issueEmailToken(UID, 'reset', 'rider@example.com');
    const b = await store.issueEmailToken(UID, 'reset', 'rider@example.com');
    // "Resend" must not leave the previous link alive, or a rider who asked
    // three times has three working reset links sitting in their history.
    H.ok('issuing a new link of the same purpose kills the previous one',
      (await store.consumeEmailToken(a, 'reset')) === null);
    H.ok('while the newest one still works', !!(await store.consumeEmailToken(b, 'reset')));
  }
  {
    const { store } = makeFakes(seeded());
    await store.init();
    H.ok('junk is rejected without a database round-trip',
      (await store.consumeEmailToken('', 'reset')) === null);
    H.ok('and so is an absurdly long token',
      (await store.consumeEmailToken('x'.repeat(500), 'reset')) === null);
  }

  /* ================= attaching and moving an address ================= */
  H.group('GoTrue decides who owns an address, not our index');
  {
    const { store, sb, calls } = makeFakes(seeded());
    await store.init();
    const u = store.getByUsername('rider');
    sb._updateEmail = { error: 'taken' };
    const r = await store.setEmailFor(u, 'someone@example.com', true, '1.2.3.4');

    H.ok('a refusal from GoTrue is reported', !!r.error, JSON.stringify(r));
    H.ok('our own row is NOT written when GoTrue said no',
      calls.filter((c) => c.indexOf('setEmail:') === 0).length === 0, calls.join(', '));
    H.ok('and the account keeps whatever it had', !u.email);
    H.ok('so nothing is findable at the address that was refused',
      store.getByEmail('someone@example.com') === null);
  }
  {
    const { store, sb, calls } = makeFakes([{ id: UID, username: 'rider', email: 'old@example.com' }]);
    await store.init();
    const u = store.getByUsername('rider');
    const r = await store.setEmailFor(u, 'New@Example.com', true, '1.2.3.4');

    H.ok('a successful move updates GoTrue first', calls.indexOf('sb.updateEmail:new@example.com') >= 0,
      calls.join(', '));
    H.ok('then our row', calls.indexOf('setEmail:new@example.com:true') >= 0, calls.join(', '));
    H.ok('the account now answers at the new address', store.getByEmail('new@example.com') === u);
    // A stale index entry here would let a password reset be requested for an
    // address the account no longer holds.
    H.ok('and no longer at the old one', store.getByEmail('old@example.com') === null);
    H.ok('the move is reported as done', !!r.ok);
  }
  {
    // The dangerous half: GoTrue accepted the new address and OUR write then
    // failed. Left alone that is an account LOCKOUT, not a failed edit — GoTrue
    // would be expecting the new address while loginEmail(), built from our row,
    // keeps offering the old one, so every password grant for this account
    // fails. Including the recovery-code reset, which is where someone locked
    // out would go next.
    const { store, db, calls } = makeFakes([{ id: UID, username: 'rider', email: 'old@example.com' }]);
    await store.init();
    const u = store.getByUsername('rider');
    db._setEmail = { taken: true };
    const r = await store.setEmailFor(u, 'new@example.com', true, '1.2.3.4');

    H.ok('the caller is told it failed', r.error === 'taken', JSON.stringify(r));
    H.ok('GoTrue was put BACK to the address the account still has',
      calls.indexOf('sb.updateEmail:old@example.com') > calls.indexOf('sb.updateEmail:new@example.com'),
      calls.join(', '));
    H.ok('the account still signs in at its real address', store.loginEmail(u) === 'old@example.com');
    H.ok('and our index was never moved', store.getByEmail('old@example.com') === u);
    H.ok('nor does it answer at the address that failed', store.getByEmail('new@example.com') === null);
  }
  {
    // Same gap, reached by a database outage rather than a constraint. The
    // error still has to propagate — but not before the rollback.
    const { store, db, calls } = makeFakes([{ id: UID, username: 'rider', email: 'old@example.com' }]);
    await store.init();
    const u = store.getByUsername('rider');
    db.setEmail = async () => { throw new Error('connection terminated'); };
    let threw = false;
    try { await store.setEmailFor(u, 'new@example.com', true, '1.2.3.4'); }
    catch (e) { threw = true; }

    H.ok('the failure is not swallowed', threw);
    H.ok('and GoTrue was still put back before it propagated',
      calls.indexOf('sb.updateEmail:old@example.com') >= 0, calls.join(', '));
    H.ok('so the account can still sign in', store.loginEmail(u) === 'old@example.com');
  }
  {
    // A legacy username-only account has no address of its own, so "put it
    // back" means back to the synthetic one GoTrue was minted with — the thing
    // loginEmail() returns when email is null.
    const { store, db, calls } = makeFakes([{ id: UID, username: 'legacy' }]);
    await store.init();
    const u = store.getByUsername('legacy');
    db._setEmail = { taken: true };
    await store.setEmailFor(u, 'new@example.com', false, '1.2.3.4');

    H.ok('the rollback targets the synthetic address, not an empty one',
      calls.indexOf('sb.updateEmail:legacy@users.convoy.test') >= 0, calls.join(', '));
    H.ok('and the account is unchanged', !u.email && store.loginEmail(u) === 'legacy@users.convoy.test');
  }

  /* ================= passwordless sign-in ================= */
  H.group('A magic link trades GoTrue\'s own token for a session');
  {
    const { store, sb, calls } = makeFakes([{ id: UID, username: 'rider', email: 'rider@example.com' }]);
    await store.init();
    const u = store.getByUsername('rider');
    const r = await store.magicSignIn(u, 'gotrue-hashed-rider@example.com', '1.2.3.4');

    H.ok('the session comes back', !!r.session && r.user === u, JSON.stringify(r && r.error));
    // The rider never sees this token — it stays server-side against our own
    // opaque one, which is what lets the link expire on our schedule.
    H.ok('GoTrue was handed its own hashed token, not ours',
      calls.indexOf('sb.verifyOtp:magiclink:gotrue-hashed-rider@example.com') >= 0, calls.join(', '));
  }
  {
    const { store, sb } = makeFakes([{ id: UID, username: 'rider', email: 'rider@example.com' }]);
    await store.init();
    sb._verifyOtp = { error: 'expired', status: 401 };
    const r = await store.magicSignIn(store.getByUsername('rider'), 'stale', '1.2.3.4');
    H.ok('a token GoTrue no longer accepts fails as a credential problem',
      r.error === 'bad-credentials', JSON.stringify(r));
  }

  /* ================= provider sign-up ================= */
  H.group('A provider sign-in becomes a real account only at the username step');
  {
    const { store, calls } = makeFakes([]);
    await store.init();
    const r = await store.completeOAuth(UID, 'newrider', { name: 'Rider' }, 'rider@example.com', 'google');

    H.ok('the account exists afterwards', !!r.user && store.getByUsername('newrider') === r.user);
    // The provider has already proven the address — re-verifying it by email
    // would be asking someone to confirm what Google just confirmed.
    H.ok('the provider-supplied address lands VERIFIED', r.user.emailVerified === true);
    H.ok('and the provider is recorded', r.user.provider === 'google');
    H.ok('it is findable by address too', store.getByEmail('rider@example.com') === r.user);
    // Providers go away and accounts get locked; this is the way back that does
    // not depend on someone else's service.
    H.ok('a recovery code is issued even here', !!r.recoveryCode);
    H.ok('and stored', calls.indexOf('setRecovery') >= 0, calls.join(', '));
  }
  {
    const { store } = makeFakes(seeded());
    await store.init();
    // A second /api/oauth/complete on the same session must not be able to
    // rename or re-home an account that already exists.
    const r = await store.completeOAuth(UID, 'somebodyelse', {}, 'x@example.com', 'google');
    H.ok('completing an account that already exists is refused',
      r.error === 'already-complete', JSON.stringify(r));
    H.ok('and the original username is untouched', store.getById(UID).username === 'rider');
  }
  {
    const { store, db } = makeFakes([]);
    await store.init();
    db._insert = { taken: true };
    const r = await store.completeOAuth(UID, 'newrider', {}, 'rider@example.com', 'google');
    H.ok('a username taken between the two steps is reported', r.error === 'taken', JSON.stringify(r));
    H.ok('and nothing is published to the read model', store.getByUsername('newrider') === null);
  }

  process.exit(H.report());
})();
