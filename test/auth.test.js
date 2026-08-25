/* Convoy — Supabase access-token verification tests.

   server/supabase.js verifies Supabase JWTs itself rather than calling GoTrue on
   every request, because userFromToken() runs synchronously on the realtime hot
   path. That makes it the single thing standing between a stranger and every
   signed-in account, and it is built on two details that fail silently when they
   are wrong:

     - JWS ECDSA signatures are raw R||S, but Node's crypto.verify() defaults to
       DER. Get that wrong and *every* real token is rejected (loud), or — if the
       check is loosened to compensate — forged ones are accepted (not loud).
     - A token is only trustworthy if the issuer, audience and expiry are checked
       too. A perfectly-signed token from a different Supabase project is still
       not one of our users.

   These tests run against a local JWKS endpoint with a real P-256 keypair, so
   the crypto path exercised here is the same one production uses.

   Run:  node test/auth.test.js
*/
'use strict';
const crypto = require('crypto');
const http = require('http');
const H = require('./harness');

/* ---------------- a stand-in Supabase project ---------------- */
const KID = 'test-key-1';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
// A second keypair, published under no kid — used to prove a valid signature
// from the wrong key is rejected.
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }), {
  kid: KID, use: 'sig', alg: 'ES256'
});

const jwksServer = http.createServer((req, res) => {
  if (req.url.indexOf('/auth/v1/.well-known/jwks.json') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.writeHead(404); res.end();
});

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mint a token the way GoTrue does: ES256 over base64url(header).base64url(claims),
// signature in raw R||S form.
function sign(claims, opts) {
  opts = opts || {};
  const header = { alg: opts.alg || 'ES256', typ: 'JWT' };
  if (header.alg !== 'none' && opts.kid !== null) header.kid = opts.kid || KID;
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  if (header.alg === 'none') return body + '.';
  if (header.alg === 'HS256') {
    return body + '.' + b64url(crypto.createHmac('sha256', opts.secret || 'x').update(body).digest());
  }
  const key = opts.key || privateKey;
  const sig = crypto.sign('sha256', Buffer.from(body, 'utf8'), { key: key, dsaEncoding: 'ieee-p1363' });
  return body + '.' + b64url(sig);
}

const now = () => Math.floor(Date.now() / 1000);

function claimsFor(over) {
  return Object.assign({
    sub: '11111111-2222-3333-4444-555555555555',
    aud: 'authenticated',
    role: 'authenticated',
    iat: now() - 10,
    exp: now() + 3600
  }, over || {});
}

(async function main() {
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  const port = jwksServer.address().port;
  const base = 'http://127.0.0.1:' + port;

  // The module captures its config at require time, so set it up first.
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.AUTH_EMAIL_DOMAIN = 'users.convoy.test';
  delete process.env.SUPABASE_JWT_SECRET;
  const sb = require('../server/supabase.js');

  const ISS = base + '/auth/v1';

  H.group('JWKS loading');
  H.ok('starts with no keys, so nothing verifies before the fetch',
    sb.verify(sign(claimsFor({ iss: ISS }))) === null);
  await sb.loadJwks(true);
  H.ok('the project is configured', sb.configured() === true);

  H.group('A genuine token is accepted');
  const good = sign(claimsFor({ iss: ISS }));
  const claims = sb.verify(good);
  H.ok('verifies an ES256 token signed by the published key', claims !== null);
  H.ok('returns the auth user id as `sub`',
    claims && claims.sub === '11111111-2222-3333-4444-555555555555', claims && claims.sub);
  H.ok('a token with no `iss` at all still verifies (older GoTrue)',
    sb.verify(sign(claimsFor())) !== null);

  H.group('Forged and tampered tokens are rejected');
  // Re-sign a modified payload with a key we control but the project does not.
  H.ok('a valid signature from a DIFFERENT key is rejected',
    sb.verify(sign(claimsFor({ iss: ISS }), { key: other.privateKey })) === null);

  // Swap the payload, keep the original signature.
  const parts = good.split('.');
  const swapped = parts[0] + '.' +
    b64url(JSON.stringify(claimsFor({ iss: ISS, sub: 'attacker' }))) + '.' + parts[2];
  H.ok('a tampered payload with the original signature is rejected',
    sb.verify(swapped) === null);

  H.ok('alg:none is rejected', sb.verify(sign(claimsFor({ iss: ISS }), { alg: 'none' })) === null);
  H.ok('HS256 is rejected when no shared secret is configured',
    sb.verify(sign(claimsFor({ iss: ISS }), { alg: 'HS256', secret: 'sb_secret_test' })) === null);
  H.ok('an unknown kid is rejected',
    sb.verify(sign(claimsFor({ iss: ISS }), { kid: 'rotated-away' })) === null);
  H.ok('a token with no kid is rejected',
    sb.verify(sign(claimsFor({ iss: ISS }), { kid: null })) === null);

  H.group('Claims are enforced, not just the signature');
  H.ok('an expired token is rejected',
    sb.verify(sign(claimsFor({ iss: ISS, exp: now() - 1 }))) === null);
  H.ok('a token with no exp is rejected',
    sb.verify(sign({ sub: 'x', aud: 'authenticated', iss: ISS })) === null);
  H.ok('a token from another Supabase project is rejected',
    sb.verify(sign(claimsFor({ iss: 'https://someone-else.supabase.co/auth/v1' }))) === null);
  H.ok('a token for the wrong audience is rejected',
    sb.verify(sign(claimsFor({ iss: ISS, aud: 'anon' }))) === null);
  H.ok('an aud array containing "authenticated" is accepted',
    sb.verify(sign(claimsFor({ iss: ISS, aud: ['authenticated'] }))) !== null);
  H.ok('a token with no sub is rejected',
    sb.verify(sign({ aud: 'authenticated', iss: ISS, exp: now() + 60 })) === null);

  H.group('Malformed input never throws');
  let threw = null;
  ['', 'x', 'a.b', 'a.b.c', 'a.b.c.d', '...', null, undefined, 42, {}].forEach((bad) => {
    try { if (sb.verify(bad) !== null) threw = 'accepted ' + JSON.stringify(bad); }
    catch (e) { threw = 'threw on ' + JSON.stringify(bad) + ': ' + e.message; }
  });
  H.ok('garbage input returns null rather than throwing', threw === null, threw || 'all rejected');

  H.group('Username to synthetic email');
  H.ok('maps a username onto the configured domain',
    sb.emailFor('Rider_99') === 'rider_99@users.convoy.test', sb.emailFor('Rider_99'));
  H.ok('casing does not change the address',
    sb.emailFor('RIDER') === sb.emailFor('rider'));

  jwksServer.close();
  H.report();
})().catch((e) => { console.error(e); process.exit(1); });
