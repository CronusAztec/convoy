/* Convoy — server/supabase.js behaviour against a stand-in GoTrue.

   auth.test.js covers token VERIFICATION. This suite covers the other half: how
   this module talks to GoTrue, and how it reports what comes back. Three things
   here are easy to get wrong in ways that are invisible until they hurt:

     - GoTrue rate-limits /token BY IP ADDRESS. Every call leaves the same VPS,
       so without Sb-Forwarded-For the whole user base shares one bucket. The
       header is only honoured for a modern sb_secret_… key, so the module has to
       decide whether to send it — and a wrong decision is silent either way.
     - GoTrue returns several unrelated failures as 422 and separates them with
       error_code, not with the status. Branching on the status alone reports a
       rejected password as "that username is taken".
     - The JWKS is load-bearing: with no keys, EVERY access token is rejected.
       loadJwks() must therefore be able to say whether it actually has keys, so
       boot can refuse to start rather than come up silently logged-out.

   Run:  node test/supabase.test.js
*/
'use strict';
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const H = require('./harness');

const KID = 'test-key-1';
const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }), {
  kid: KID, use: 'sig', alg: 'ES256'
});

/* ---------------- stand-in GoTrue ---------------- */
const state = {
  requests: [],
  jwksHits: 0,
  jwksMode: 'ok',                 // 'ok' | 'empty' | 'fail'
  admin: { status: 200, body: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
  token: {
    status: 200,
    body: {
      access_token: 'at', refresh_token: 'rt', expires_in: 3600,
      user: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    }
  }
};

const gotrue = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    state.requests.push({ url: req.url, method: req.method, headers: req.headers, body: body });
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.indexOf('/auth/v1/.well-known/jwks.json') === 0) {
      state.jwksHits++;
      if (state.jwksMode === 'fail') { res.writeHead(500); return res.end('nope'); }
      return send(200, { keys: state.jwksMode === 'empty' ? [] : [jwk] });
    }
    if (req.url.indexOf('/auth/v1/admin/users') === 0) return send(state.admin.status, state.admin.body);
    if (req.url.indexOf('/auth/v1/token') === 0) return send(state.token.status, state.token.body);
    if (req.url.indexOf('/auth/v1/logout') === 0) { res.writeHead(204); return res.end(); }
    send(404, {});
  });
});

// The module reads its config at require time, so each variant needs a fresh copy.
const MODULE = path.join(__dirname, '..', 'server', 'supabase.js');
function freshSb(base, env) {
  delete require.cache[require.resolve(MODULE)];
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.AUTH_EMAIL_DOMAIN = 'users.convoy.test';
  delete process.env.SUPABASE_FORWARD_IP;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  Object.keys(env || {}).forEach((k) => {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  });
  return require(MODULE);
}

const lastRequest = (match) => {
  for (let i = state.requests.length - 1; i >= 0; i--) {
    if (state.requests[i].url.indexOf(match) === 0) return state.requests[i];
  }
  return null;
};

(async function main() {
  await new Promise((r) => gotrue.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + gotrue.address().port;

  /* ================= Sb-Forwarded-For ================= */
  H.group('Client IPs are forwarded to GoTrue for rate limiting');
  {
    const sb = freshSb(base);
    H.ok('a modern sb_secret_ key enables forwarding', sb.forwardsIp() === true);

    await sb.signIn('rider', 'pw', '203.0.113.7');
    let r = lastRequest('/auth/v1/token?grant_type=password');
    H.ok('sign-in carries the caller IP', r && r.headers['sb-forwarded-for'] === '203.0.113.7',
      r ? 'got ' + r.headers['sb-forwarded-for'] : 'no request recorded');

    await sb.refresh('rt', '198.51.100.4');
    r = lastRequest('/auth/v1/token?grant_type=refresh_token');
    H.ok('token refresh carries the caller IP — the call that scales with users',
      r && r.headers['sb-forwarded-for'] === '198.51.100.4');

    await sb.createUser('rider', 'pw', '203.0.113.9');
    r = lastRequest('/auth/v1/admin/users');
    H.ok('account creation carries the caller IP', r && r.headers['sb-forwarded-for'] === '203.0.113.9');

    await sb.signOut('at', 'local', '203.0.113.11');
    r = lastRequest('/auth/v1/logout');
    H.ok('sign-out carries the caller IP', r && r.headers['sb-forwarded-for'] === '203.0.113.11');

    await sb.signIn('rider', 'pw');
    r = lastRequest('/auth/v1/token?grant_type=password');
    H.ok('no header when the caller IP is unknown',
      r && r.headers['sb-forwarded-for'] === undefined);
  }
  {
    // GoTrue only honours the header for a modern secret key; sending it with a
    // legacy service_role JWT would be a no-op we'd wrongly believe in.
    delete require.cache[require.resolve(MODULE)];
    process.env.SUPABASE_URL = base;
    process.env.SUPABASE_SECRET_KEY = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiJ9.legacy.service_role';
    delete process.env.SUPABASE_FORWARD_IP;
    const sb = require(MODULE);
    H.ok('a legacy service_role key does NOT enable forwarding', sb.forwardsIp() === false);
    await sb.signIn('rider', 'pw', '203.0.113.7');
    const r = lastRequest('/auth/v1/token?grant_type=password');
    H.ok('and no header is sent with it', r && r.headers['sb-forwarded-for'] === undefined);
  }
  {
    const sb = freshSb(base, { SUPABASE_FORWARD_IP: '0' });
    H.ok('SUPABASE_FORWARD_IP=0 suppresses forwarding', sb.forwardsIp() === false);
    await sb.signIn('rider', 'pw', '203.0.113.7');
    const r = lastRequest('/auth/v1/token?grant_type=password');
    H.ok('and no header is sent', r && r.headers['sb-forwarded-for'] === undefined);
  }

  /* ================= 422 is not a synonym for "taken" ================= */
  H.group('GoTrue failures are told apart by error_code, not by status');
  {
    const sb = freshSb(base);

    state.admin = { status: 422, body: { code: 422, error_code: 'email_exists', msg: 'already registered' } };
    let r = await sb.createUser('rider', 'pw');
    H.ok('email_exists → taken', r.error === 'taken', 'got ' + JSON.stringify(r));

    state.admin = {
      status: 422,
      body: { code: 422, error_code: 'weak_password', msg: 'Password is known to be weak and easy to guess' }
    };
    r = await sb.createUser('rider', 'pw');
    H.ok('weak_password → weak-password, NOT taken', r.error === 'weak-password',
      'got ' + JSON.stringify(r));
    H.ok('and the reason is passed through for the rider to read',
      /weak/i.test(r.detail || ''));

    // Leaked-password protection surfaces here, which is exactly the case that
    // used to tell people to invent a new username.
    state.admin = { status: 200, body: { id: 'x' } };
    r = await sb.createUser('rider', 'pw');
    H.ok('a successful create still returns the user', !!r.user && !r.error);

    // Builds predating error_code: GoTrue's prose is "…has already BEEN
    // registered", which does not contain the substring "already registered".
    state.admin = {
      status: 422,
      body: { msg: 'A user with this email address has already been registered' }
    };
    r = await sb.createUser('rider', 'pw');
    H.ok('legacy prose "already been registered" → taken', r.error === 'taken',
      'got ' + JSON.stringify(r));

    state.admin = { status: 500, body: { msg: 'boom' } };
    r = await sb.createUser('rider', 'pw');
    H.ok('an unrelated 500 is neither taken nor weak-password',
      r.error !== 'taken' && r.error !== 'weak-password', 'got ' + JSON.stringify(r));

    state.admin = { status: 200, body: { id: 'x' } };
  }

  /* ================= rate limiting is not a bad password ================= */
  H.group('A GoTrue 429 stays distinguishable from a wrong password');
  {
    const sb = freshSb(base);
    state.token = { status: 429, body: { code: 429, error_code: 'over_request_rate_limit', msg: 'slow down' } };
    const r = await sb.signIn('rider', 'pw', '203.0.113.7');
    H.ok('signIn surfaces the status so the caller can tell 429 from 400', r.status === 429,
      'got ' + JSON.stringify(r));

    const rr = await sb.refresh('rt', '203.0.113.7');
    H.ok('refresh surfaces it too', rr.status === 429);

    state.token = {
      status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }
    };
    const bad = await sb.signIn('rider', 'pw', '203.0.113.7');
    H.ok('a real bad password is still a 400', bad.status === 400 && !!bad.error);

    state.token = {
      status: 200,
      body: {
        access_token: 'at', refresh_token: 'rt', expires_in: 3600,
        user: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
      }
    };
  }

  /* ================= the JWKS is load-bearing ================= */
  H.group('loadJwks reports whether it actually has keys');
  {
    state.jwksMode = 'ok';
    const sb = freshSb(base);
    const before = state.jwksHits;
    H.ok('a good response resolves true', (await sb.loadJwks(true)) === true);
    H.ok('and it really fetched', state.jwksHits === before + 1);

    // The floor exists so an unknown kid — i.e. anything holding a token we
    // cannot place, including a flood of junk — cannot start a fetch per request
    // against an endpoint that is itself IP-rate-limited.
    const after = state.jwksHits;
    H.ok('a second forced refresh inside the floor still reports true',
      (await sb.loadJwks(true)) === true);
    H.ok('but does NOT re-fetch', state.jwksHits === after,
      'hits went ' + after + ' → ' + state.jwksHits);

    // An empty or garbled response must never wipe keys we already hold.
    state.jwksMode = 'empty';
    await sb.loadJwks(true);
    H.ok('an empty response cannot clear a good key set',
      (await sb.loadJwks(false)) === true);
  }
  {
    state.jwksMode = 'fail';
    const sb = freshSb(base);
    H.ok('a failed fetch resolves FALSE so boot can refuse to start',
      (await sb.loadJwks(true)) === false);
  }
  {
    state.jwksMode = 'empty';
    const sb = freshSb(base);
    H.ok('a key-less response resolves false too',
      (await sb.loadJwks(true)) === false);
  }
  {
    state.jwksMode = 'ok';
    const sb = freshSb('');
    H.ok('an unconfigured project resolves false rather than hanging',
      (await sb.loadJwks(true)) === false);
  }

  gotrue.close();
  process.exit(H.report());
})();
