/* Convoy — social sign-in (Google and friends) over Supabase Auth, PKCE flow.

   HOW IT HANGS TOGETHER

     1. POST /api/oauth/start {provider, native?}
        This module mints a PKCE verifier, keeps it here, and hands the client
        the GoTrue /authorize URL carrying only the verifier's SHA-256.
     2. The browser navigates there. GoTrue bounces it to Google, Google bounces
        it back to GoTrue, GoTrue redirects to the target with ?code=… — plus
        the ?cvst=<state> we smuggled through in redirect_to.
     3. The app notices the code and POSTs it back with the state.
     4. POST /api/oauth/callback trades code + verifier for a real session.

   TWO REDIRECT TARGETS, ONE FLOW. Step 2 ends differently depending on where
   the app is running, and this module is the only place that knows the
   difference:

     web    APP_URL/?cvst=…&code=…            js/auth.js reads it at boot
     APK    tech.odoreeci.convoy://auth?…     Android routes it to MainActivity,
                                              AuthPlugin forwards it to the same
                                              js/auth.js code path

   The APK needs its own target because the Capacitor WebView's origin is
   https://localhost — not somewhere a provider can redirect to — and because
   Google refuses to run OAuth inside an embedded WebView at all, so the round
   trip happens in a Custom Tab outside the app. Steps 1, 3 and 4 are identical
   either way.

   WHY THE VERIFIER LIVES ON THE SERVER, not in the browser as supabase-js does
   it: the client never holds a Supabase key here — every GoTrue call in Convoy
   is proxied so the secret key and the per-IP/per-account rate limits stay on
   this side (see the header of supabase.js). Keeping the verifier here matches
   that, and means a stolen redirect URL is worthless on its own.

   IN-MEMORY STATE is fine and deliberate: Convoy runs as a single systemd unit
   (same assumption store.js documents for its account cache). Entries live for
   ten minutes — long enough to finish a provider round-trip including a fresh
   Google login, short enough that abandoning one costs nothing. A restart
   mid-sign-in just means the rider taps the button again. */
'use strict';

const crypto = require('crypto');

// The providers Supabase itself supports that make sense for a driving app,
// with the scopes each needs for an email address to come back. Enabling one
// here is NOT enough — it also has to be switched on, with a client ID and
// secret, under Dashboard → Authentication → Providers.
const PROVIDERS = {
  google:        { label: 'Google',    scopes: 'email profile' },
  apple:         { label: 'Apple',     scopes: 'email name' },
  github:        { label: 'GitHub',    scopes: 'user:email' },
  discord:       { label: 'Discord',   scopes: 'identify email' },
  facebook:      { label: 'Facebook',  scopes: 'email' },
  azure:         { label: 'Microsoft', scopes: 'openid email profile' },
  twitter:       { label: 'X',         scopes: '' },
  twitch:        { label: 'Twitch',    scopes: 'user:read:email' },
  spotify:       { label: 'Spotify',   scopes: 'user-read-email' },
  gitlab:        { label: 'GitLab',    scopes: 'read_user' },
  linkedin_oidc: { label: 'LinkedIn',  scopes: 'openid email profile' }
};

// Which of them this deployment offers. Unset defaults to google only: every
// extra entry is a promise the dashboard has matching credentials, and a button
// that dead-ends at a GoTrue error is worse than no button.
//
// SET-BUT-EMPTY means none, the same way CSP='' means "no CSP" in server.js.
// `|| 'google'` here would quietly re-enable a provider an operator had just
// switched off, which is the opposite of what blanking a setting should do.
// Unknown names are dropped rather than passed through, so a typo costs a
// button rather than producing one that fails at the provider.
const ENABLED = (process.env.OAUTH_PROVIDERS === undefined ? 'google' : process.env.OAUTH_PROVIDERS)
  .split(',').map((s) => s.trim().toLowerCase()).filter((p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p));

// Where the APK's round-trip ends. The Capacitor WebView runs at
// https://localhost, which is not an origin anyone can redirect to, so the
// native flow comes back through a scheme the app claims in its manifest
// (AuthPlugin + the intent-filter in AndroidManifest.xml) instead of through
// APP_URL. Changing this means changing all three, plus the Supabase redirect
// allowlist.
const NATIVE_REDIRECT = (process.env.OAUTH_NATIVE_REDIRECT || 'tech.odoreeci.convoy://auth')
  .replace(/\/+$/, '');

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5000;      // ceiling so a flood of /start calls can't grow this without bound

const pending = new Map();     // state -> { verifier, provider, createdAt }

function enabled() { return ENABLED.slice(); }
function isEnabled(p) { return ENABLED.indexOf(String(p || '').toLowerCase()) >= 0; }

/* ---------------- the other half of "enabled" ----------------
   OAUTH_PROVIDERS is only this deployment's INTENT. The switch that actually
   works is in the Supabase dashboard, and there is no code equivalent for it —
   so the two can disagree, and when they do the failure is horrible: the app
   sends the browser to GoTrue's /authorize, which answers with a raw JSON error
   page reading "Unsupported provider: provider is not enabled". The rider is
   left staring at a 400 body.

   So a provider counts as enabled only when BOTH agree. supabase.providerEnabled
   returns null when the project settings have never been read (a network blip,
   an unconfigured project), and null means "fall back to trusting the env" —
   hiding every button because one settings fetch failed would be a worse failure
   than the one this prevents. */
function liveEnabled() {
  const sb = require('./supabase');
  return ENABLED.filter((id) => sb.providerEnabled(id) !== false);
}

// Providers listed here but switched OFF in the dashboard. Used at boot to say
// so plainly, which is the point where it is cheapest to fix.
function misconfigured() {
  const sb = require('./supabase');
  return ENABLED.filter((id) => sb.providerEnabled(id) === false);
}

// What the client needs to draw the buttons — never one that cannot work.
function list() {
  return liveEnabled().map((id) => ({ id: id, label: PROVIDERS[id].label }));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > STATE_TTL_MS) pending.delete(k);
}
setInterval(sweep, 60 * 1000).unref();

// Begin a sign-in. Returns { url, state, native } | { error }.
//
// `appUrl` is the deployment's own origin (mailer.appUrl()), never anything
// derived from the request — the redirect target decides where the
// authorization code lands, so it must not be attacker-influenced. Note the
// same holds for `native`: it selects between two SERVER-CONFIGURED targets, it
// does not let the caller supply one. It also has to be listed under Dashboard
// → Authentication → URL Configuration → Redirect URLs or GoTrue refuses the
// round-trip — both targets do, separately.
function start(provider, appUrl, native) {
  provider = String(provider || '').toLowerCase();
  if (!isEnabled(provider)) return { error: 'provider-not-enabled' };
  // Caught here rather than at GoTrue, which would answer the BROWSER with a
  // raw JSON error page instead of answering this API call.
  if (require('./supabase').providerEnabled(provider) === false) {
    return { error: 'provider-not-configured' };
  }
  if (pending.size >= MAX_PENDING) {
    sweep();
    if (pending.size >= MAX_PENDING) return { error: 'busy' };
  }

  // RFC 7636: verifier is 43-128 chars of unreserved characters; base64url of 32
  // random bytes is 43 and satisfies that exactly.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(18));

  // GoTrue APPENDS its own query params to redirect_to, so our state rides along
  // as an existing one rather than being handed to GoTrue (which manages its own
  // `state` and would drop ours).
  //
  // The web target is the app's own URL, which boots and reads the query string.
  // The native one is the APK's custom scheme, which Android routes to
  // MainActivity — same parameters either way, so js/auth.js handles both with
  // one code path.
  const redirectTo = native
    ? NATIVE_REDIRECT + '?cvst=' + encodeURIComponent(state)
    : appUrl + '/?cvst=' + encodeURIComponent(state);

  pending.set(state, { verifier: verifier, provider: provider, createdAt: Date.now() });
  return {
    url: require('./supabase').authorizeUrl(provider, redirectTo, challenge, PROVIDERS[provider].scopes),
    state: state,
    native: !!native
  };
}

// The redirect the APK must have allowlisted in Supabase. Reported by
// /api/auth/config so the setup can be checked from the app rather than guessed.
function nativeRedirect() { return NATIVE_REDIRECT; }

// Redeem the state exactly once. A second callback with the same state — a
// double-submit, a refreshed callback URL, or a replay — finds nothing.
function take(state) {
  const s = String(state || '');
  const entry = pending.get(s);
  if (!entry) return null;
  pending.delete(s);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
}

function pendingCount() { return pending.size; }

module.exports = {
  PROVIDERS, enabled, isEnabled, liveEnabled, misconfigured, list,
  start, take, pendingCount, nativeRedirect
};
