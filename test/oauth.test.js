/* Convoy — server/oauth.js, the PKCE half of social sign-in.

   This module holds the only thing standing between an intercepted redirect and
   a stolen account. Four properties carry that weight, and none of them fail
   visibly when they break — a sign-in that works is a sign-in that works,
   whether or not the proof was real:

     - The challenge sent to the provider must be the SHA-256 of a verifier that
       never leaves this server. Send the verifier itself (or a challenge that
       doesn't match it) and the authorization code becomes a bearer credential
       anyone who sees the redirect can spend.
     - A state must redeem exactly ONCE. A replayable state means a callback URL
       out of someone's browser history can be re-submitted.
     - Expiry has to be enforced at redemption, not merely swept on a timer.
     - Only providers this deployment enabled may start a flow, whatever the
       request body says.

   Run:  node test/oauth.test.js
*/
'use strict';
const crypto = require('crypto');
const path = require('path');
const H = require('./harness');

const SB_PATH = path.join(__dirname, '..', 'server', 'supabase.js');
const OAUTH_PATH = path.join(__dirname, '..', 'server', 'oauth.js');

// oauth.js reads OAUTH_PROVIDERS at require time, so the env has to be set
// before the module is pulled in — and re-set for each configuration under test.
// `upstream` stands in for what the Supabase DASHBOARD has switched on:
//   undefined  → settings never read (providerEnabled returns null)
//   { google: true, github: false }
function load(providers, upstream) {
  process.env.OAUTH_PROVIDERS = providers;
  delete require.cache[require.resolve(OAUTH_PATH)];
  // A stand-in for supabase.authorizeUrl that just reports what it was given,
  // so the assertions can look at the parameters rather than parse a real URL.
  require.cache[require.resolve(SB_PATH)] = {
    id: SB_PATH, filename: SB_PATH, loaded: true,
    exports: {
      authorizeUrl: (provider, redirectTo, challenge, scopes) =>
        'https://auth.test/authorize?provider=' + provider +
        '&redirect_to=' + encodeURIComponent(redirectTo) +
        '&code_challenge=' + challenge +
        '&code_challenge_method=s256' +
        (scopes ? '&scopes=' + encodeURIComponent(scopes) : ''),
      // Mirrors the real one: null when the project settings have never been
      // read, which is a different answer from "off".
      providerEnabled: (name) => (upstream ? !!upstream[name] : null)
    }
  };
  return require(OAUTH_PATH);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function paramOf(url, key) {
  return new URL(url).searchParams.get(key);
}

(function main() {

  H.group('Only enabled providers can start a sign-in');
  {
    const oauth = load('google,github');
    H.ok('the enabled list is what the client is offered',
      oauth.list().map((p) => p.id).join(',') === 'google,github',
      JSON.stringify(oauth.list()));
    H.ok('an enabled provider starts', !!oauth.start('google', 'https://app.test').url);
    H.ok('a provider that exists but is NOT enabled here is refused',
      oauth.start('discord', 'https://app.test').error === 'provider-not-enabled');
    H.ok('a provider that does not exist at all is refused the same way',
      oauth.start('myspace', 'https://app.test').error === 'provider-not-enabled');
    // Nothing about the request body may widen the allowlist.
    H.ok('nor does casing or padding get one past',
      oauth.start('  Discord ', 'https://app.test').error === 'provider-not-enabled');
  }
  {
    const oauth = load('');
    H.ok('an empty setting offers nothing', oauth.list().length === 0);
    H.ok('and refuses everything', oauth.start('google', 'https://app.test').error === 'provider-not-enabled');
  }
  {
    const oauth = load('google,myspace,github');
    // A typo in the env must not become a button that dead-ends at GoTrue.
    H.ok('unknown names in OAUTH_PROVIDERS are dropped, not passed through',
      oauth.list().map((p) => p.id).join(',') === 'google,github',
      JSON.stringify(oauth.list()));
  }

  H.group('A provider the DASHBOARD has off never becomes a button');
  {
    // The failure this prevents, seen for real: OAUTH_PROVIDERS said google,
    // the Supabase project had it switched off, and the app navigated the
    // browser to GoTrue — which answered with a raw JSON error page reading
    // "Unsupported provider: provider is not enabled".
    const oauth = load('google,github', { google: false, github: true });
    H.ok('the disabled one is not offered to the client',
      oauth.list().map((p) => p.id).join(',') === 'github', JSON.stringify(oauth.list()));
    H.ok('and starting it is refused HERE, not at GoTrue',
      oauth.start('google', 'https://app.test').error === 'provider-not-configured');
    H.ok('the working one is unaffected', !!oauth.start('github', 'https://app.test').url);
    H.ok('and it is reported as misconfigured for the boot warning',
      oauth.misconfigured().join(',') === 'google', oauth.misconfigured().join(','));
  }
  {
    // Settings unreadable (network blip, or a project that never answered).
    // Hiding every sign-in button over one failed fetch would be a worse
    // failure than the one being prevented, so this falls back to the env.
    const oauth = load('google,github', undefined);
    H.ok('an unknown upstream state trusts the local config',
      oauth.list().map((p) => p.id).join(',') === 'google,github', JSON.stringify(oauth.list()));
    H.ok('and start() still works', !!oauth.start('google', 'https://app.test').url);
    H.ok('nothing is reported as misconfigured', oauth.misconfigured().length === 0);
  }
  {
    const oauth = load('google', { google: true });
    H.ok('both halves agreeing is the normal case', oauth.list().length === 1);
    H.ok('and it starts', !!oauth.start('google', 'https://app.test').url);
  }
  {
    // A provider the dashboard has on but this deployment did not ask for stays
    // off: the env is still the narrower of the two.
    const oauth = load('google', { google: true, discord: true });
    H.ok('upstream cannot widen what OAUTH_PROVIDERS offers',
      oauth.list().map((p) => p.id).join(',') === 'google', JSON.stringify(oauth.list()));
    H.ok('and discord is still refused',
      oauth.start('discord', 'https://app.test').error === 'provider-not-enabled');
  }

  H.group('The challenge really is the hash of a verifier we kept');
  {
    const oauth = load('google');
    const r = oauth.start('google', 'https://app.test');
    const challenge = paramOf(r.url, 'code_challenge');
    const held = oauth.take(r.state);

    H.ok('a verifier was kept server-side', !!held && !!held.verifier);
    H.ok('the challenge is S256 of it, base64url',
      challenge === b64url(crypto.createHash('sha256').update(held.verifier).digest()),
      challenge);
    H.ok('the method is declared as s256', paramOf(r.url, 'code_challenge_method') === 's256');
    // RFC 7636 §4.1: 43–128 characters. 32 random bytes base64url is exactly 43.
    H.ok('the verifier is a legal PKCE length',
      held.verifier.length >= 43 && held.verifier.length <= 128, String(held.verifier.length));
    H.ok('and the verifier itself is NOT in the URL', r.url.indexOf(held.verifier) < 0);
    H.ok('the provider is remembered alongside it', held.provider === 'google');
  }
  {
    const oauth = load('google');
    const a = oauth.start('google', 'https://app.test');
    const b = oauth.start('google', 'https://app.test');
    H.ok('two flows get different states', a.state !== b.state);
    H.ok('and different challenges',
      paramOf(a.url, 'code_challenge') !== paramOf(b.url, 'code_challenge'));
  }

  H.group('State is single-use and rides back inside redirect_to');
  {
    const oauth = load('google');
    const r = oauth.start('google', 'https://app.test');
    // GoTrue manages its own `state` parameter and would drop ours, so it has to
    // travel as an existing query param on redirect_to — which GoTrue appends
    // the authorization code to.
    const redirect = paramOf(r.url, 'redirect_to');
    H.ok('redirect_to points back at the app', redirect.indexOf('https://app.test/') === 0, redirect);
    H.ok('and carries the state as a query param', paramOf(redirect, 'cvst') === r.state, redirect);

    H.ok('the state redeems once', !!oauth.take(r.state));
    H.ok('a replay finds nothing', oauth.take(r.state) === null);
    H.ok('and an invented state finds nothing', oauth.take('not-a-real-state') === null);
    H.ok('nor does an empty one', oauth.take('') === null);
  }
  {
    const oauth = load('google');
    const before = oauth.pendingCount();
    oauth.start('google', 'https://app.test');
    H.ok('a pending flow is held', oauth.pendingCount() === before + 1);
    const r2 = oauth.start('google', 'https://app.test');
    oauth.take(r2.state);
    H.ok('redeeming releases it', oauth.pendingCount() === before + 1);
  }

  H.group('An expired state cannot be redeemed');
  {
    const oauth = load('google');
    const realNow = Date.now;
    const r = oauth.start('google', 'https://app.test');
    // The sweep runs on a timer; redemption must not depend on it having run.
    Date.now = () => realNow() + 11 * 60 * 1000;
    const taken = oauth.take(r.state);
    Date.now = realNow;
    H.ok('a state older than the window is refused at redemption', taken === null);
  }

  H.group('The APK gets its own redirect target');
  {
    // The Capacitor WebView's origin is https://localhost, which no provider can
    // redirect to, so the native flow comes back through a scheme the APK claims
    // in its manifest. Everything else about the flow has to stay identical, or
    // the two builds would need two code paths on the client.
    const oauth = load('google');
    const web = oauth.start('google', 'https://app.test', false);
    const app = oauth.start('google', 'https://app.test', true);

    const webRedirect = paramOf(web.url, 'redirect_to');
    const appRedirect = paramOf(app.url, 'redirect_to');

    H.ok('the web target is still the app URL', webRedirect.indexOf('https://app.test/') === 0, webRedirect);
    H.ok('the native target is the custom scheme',
      appRedirect.indexOf('tech.odoreeci.convoy://auth') === 0, appRedirect);
    H.ok('and it matches what the manifest and the server report',
      appRedirect.indexOf(oauth.nativeRedirect()) === 0, oauth.nativeRedirect());
    // Same query param, so js/auth.js reads the state the same way whether it
    // came out of a URL bar or out of an Android intent.
    H.ok('the state still rides along as ?cvst', paramOf(appRedirect, 'cvst') === app.state, appRedirect);
    H.ok('the caller is told which target it got', app.native === true && web.native === false);

    // PKCE is not weakened for native. It is the ONLY thing protecting a custom
    // scheme, which another installed app can in principle claim.
    H.ok('native still sends a challenge', !!paramOf(app.url, 'code_challenge'));
    const held = oauth.take(app.state);
    H.ok('and the verifier is still held server-side, never in the redirect',
      !!held.verifier && appRedirect.indexOf(held.verifier) < 0);
    H.ok('the challenge is S256 of it',
      paramOf(app.url, 'code_challenge') ===
        b64url(crypto.createHash('sha256').update(held.verifier).digest()));
  }
  {
    const oauth = load('google');
    // The flag only chooses between two server-side constants; nothing about the
    // request can name a redirect of its own.
    const a = oauth.start('google', 'https://app.test', 'https://evil.test');
    H.ok('a truthy non-boolean still selects the configured native target, not itself',
      paramOf(a.url, 'redirect_to').indexOf('tech.odoreeci.convoy://auth') === 0,
      paramOf(a.url, 'redirect_to'));
  }

  H.group('Scopes come from the registry, not the caller');
  {
    const oauth = load('google,github');
    // The address an account is created against depends on the provider
    // returning one, which depends on the scope. Hard-coding it per provider is
    // what keeps that from being a per-request mistake.
    H.ok('google asks for email', paramOf(oauth.start('google', 'https://app.test').url, 'scopes')
      .indexOf('email') >= 0);
    H.ok('github asks for user:email', paramOf(oauth.start('github', 'https://app.test').url, 'scopes')
      === 'user:email');
  }

  process.exit(H.report());
})();
