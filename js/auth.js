/* Convoy — client auth: register/login/guest/social, Supabase session handling,
   boot gating.

   Identity is Supabase Auth. The server proxies GoTrue (see server/supabase.js),
   but what the client ends up holding is a real Supabase session: a short-lived
   access token plus a refresh token.

   SIGN-IN METHODS. A username and password is still the baseline and still works
   with no email at all. On top of it:
     · register with an email, confirm it, and reset the password by link
     · sign in with the email instead of the username
     · sign in with no password at all (a link mailed to a confirmed address)
     · sign in with Google and whichever other providers the server enables
   What is actually available depends on the deployment, so the UI asks
   /api/auth/config rather than assuming — see config().

   LINKS COME BACK THROUGH THE APP ITSELF. Every mailed link and every OAuth
   redirect lands on the app's own origin with a query string ( ?cv=reset&token=…
   or ?code=…&cvst=… ), which readRedirect() picks up during boot and clears out
   of the address bar. That is why there are no separate callback pages.

   IN THE APK the OAuth half of that arrives differently — the provider round
   trip happens in a Custom Tab outside the WebView and returns as a deep link on
   the app's own scheme, delivered by the native Auth plugin. Same parameters,
   same handler: see oauthStart() and wireNativeRedirect().

   That is the main difference from the old scheme, where the token was valid for
   30 days and could just sit in localStorage. Now it expires in about an hour,
   so this module keeps it fresh: a timer refreshes ahead of expiry, any
   authenticated call refreshes first if the token is stale, and a 401 triggers
   one refresh-and-retry before giving up. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, ST = A.store;

  // Refresh this far before the token actually expires, so an in-flight request
  // can't land on the far side of the boundary.
  var REFRESH_MARGIN_MS = 120000; // 2 min
  var refreshTimer = null;
  var refreshInFlight = null;

  function api(path, method, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // A.config.base is '' on the web (same-origin) and the deployed origin inside Capacitor.
    return fetch(A.config.base + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, body: j };
      });
    });
  }

  /* ---------------- session ---------------- */

  function hasSession() { return !!(S.auth && S.auth.token); }
  function expiringSoon() {
    if (!S.auth || !S.auth.expiresAt) return false;
    return Date.now() > S.auth.expiresAt - REFRESH_MARGIN_MS;
  }

  // Exchange the refresh token for a new session. Single-flight: the boot check,
  // the timer and a 401 retry can all want this at once, and firing several
  // refreshes in parallel would rotate the token out from under each other.
  // Resolves true on success, false if the session is gone for good.
  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    if (!S.auth || !S.auth.refreshToken) return Promise.resolve(false);
    var rt = S.auth.refreshToken;
    refreshInFlight = api('/api/refresh', 'POST', { refreshToken: rt })
      .then(function (res) {
        if (res.status === 200 && res.body.token) {
          ST.setAuth(res.body);
          scheduleRefresh();
          return true;
        }
        // 401 means the refresh token was rotated, revoked or expired — the only
        // way back is a fresh sign-in. Any other status is a transient server or
        // network problem, so keep the session and let the caller retry later.
        if (res.status === 401) ST.clearAuth();
        // ...but "later" has to be SCHEDULED, not hoped for. The timer armed by
        // the last successful refresh is gone, and nothing re-arms it: without
        // this, one 500/429/offline moment during the hourly top-up ended the
        // background refresh chain for the whole session (the header's
        // "a timer refreshes ahead of expiry" quietly stopped being true).
        else retryRefreshSoon();
        return false;
      })
      .catch(function () { retryRefreshSoon(); return false; })   // offline — keep the session, retry on a timer
      .then(function (ok) { refreshInFlight = null; return ok; });
    return refreshInFlight;
  }

  // Bounded backoff for failed refreshes: 30s, then 2min, capped at 10min. A
  // tight loop would hammer /api/refresh against a struggling server; no loop
  // at all was the bug this fixes.
  var refreshFails = 0;
  function retryRefreshSoon() {
    if (refreshTimer || !hasSession()) return;
    var delay = Math.min(600000, 30000 * Math.pow(2, refreshFails++));
    refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, delay);
  }

  // Keep a live session topped up in the background so the websocket's `hello`
  // always carries a valid token.
  function scheduleRefresh() {
    refreshFails = 0;                       // a scheduled refresh means the chain is healthy again
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (!hasSession() || !S.auth.expiresAt) return;
    // setTimeout clamps to a 32-bit delay; an hour is well inside that, but floor
    // at 5s so a clock skew that puts expiry in the past can't spin.
    var delay = Math.max(5000, S.auth.expiresAt - Date.now() - REFRESH_MARGIN_MS);
    refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, delay);
  }

  // Authenticated request with automatic token maintenance: refresh first if the
  // token is stale, and refresh-and-retry once on a 401.
  function authed(path, method, body) {
    if (!hasSession()) return Promise.resolve({ status: 401, body: {} });
    var pre = expiringSoon() ? refresh() : Promise.resolve(true);
    return pre.then(function () {
      return api(path, method, body, S.auth && S.auth.token);
    }).then(function (res) {
      if (res.status !== 401 || !S.auth || !S.auth.refreshToken) return res;
      return refresh().then(function (ok) {
        if (!ok) return res;
        return api(path, method, body, S.auth && S.auth.token);
      });
    });
  }

  /* ---------------- account actions ---------------- */

  // What this deployment supports. Fetched once and cached — it can't change
  // without a server restart, and the auth screen reads it on every render.
  var configCache = null;
  function config() {
    if (configCache) return Promise.resolve(configCache);
    var fallback = { providers: [], email: false, magicLink: false };
    return api('/api/auth/config', 'GET', null)
      .then(function (res) {
        // Cache ONLY a real answer. A transient 500/429/502 (mid-restart, proxy
        // blip) used to be cached as "nothing is configured" for the whole page
        // lifetime — the sign-in screen lost Google/email/magic for the session
        // over an error that cleared itself seconds later. Return the fallback
        // for THIS render, but leave configCache null so the next render re-probes.
        if (res.status === 200) { configCache = res.body; return configCache; }
        return fallback;
      })
      // A failed probe must not blank the sign-in screen: fall back to the one
      // method that needs nothing configured at all.
      .catch(function () { return fallback; });
  }

  // `email` is optional — omit it for the original username-only account.
  function register(username, password, profile, email) {
    var body = { username: username, password: password, profile: profile };
    if (email) body.email = email;
    return api('/api/register', 'POST', body)
      .then(function (res) {
        if (res.status === 200) {
          ST.setAuth(res.body);
          scheduleRefresh();
          return { ok: true, recoveryCode: res.body.recoveryCode, verificationSent: res.body.verificationSent };
        }
        return { ok: false, error: res.body.error || 'Could not create account' };
      })
      .catch(function () { return { ok: false, error: 'Network error. Is the server running?' }; });
  }

  // `identifier` is a username OR an email address; the server works out which.
  function login(identifier, password) {
    return api('/api/login', 'POST', { identifier: identifier, password: password })
      .then(function (res) {
        if (res.status === 200) { ST.setAuth(res.body); scheduleRefresh(); return { ok: true }; }
        return { ok: false, error: res.body.error || 'Could not sign in' };
      })
      .catch(function () { return { ok: false, error: 'Network error. Is the server running?' }; });
  }

  /* ---------------- email flows ----------------
     forgot() and magicRequest() always report success. The server answers them
     identically whether or not the address has an account — telling the caller
     apart here would undo that and turn the app into a membership oracle. */

  function forgot(email) {
    return api('/api/forgot', 'POST', { email: email })
      .then(function (res) {
        if (res.status === 200) return { ok: true };
        return { ok: false, error: res.body.error || 'Could not send the email' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function resetWithToken(token, newPassword) {
    return api('/api/reset', 'POST', { token: token, password: newPassword })
      .then(function (res) {
        if (res.status === 200) { ST.setAuth(res.body); scheduleRefresh(); return { ok: true }; }
        return { ok: false, error: res.body.error || 'Could not reset the password' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function magicRequest(email) {
    return api('/api/magic', 'POST', { email: email })
      .then(function (res) {
        if (res.status === 200) return { ok: true };
        return { ok: false, error: res.body.error || 'Could not send the link' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function magicConsume(token) {
    return api('/api/magic/consume', 'POST', { token: token })
      .then(function (res) {
        if (res.status === 200) { ST.setAuth(res.body); scheduleRefresh(); return { ok: true }; }
        return { ok: false, error: res.body.error || 'That link is no longer valid' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  // Anonymous by design: confirmation links are usually opened in a mail app on
  // a device that was never signed in.
  function verifyEmailToken(token) {
    return api('/api/email/verify', 'POST', { token: token })
      .then(function (res) {
        if (res.status === 200) {
          // Reflect it immediately if this IS the signed-in device.
          if (S.auth && S.auth.username === res.body.username) ST.setAuth({ emailVerified: true });
          return { ok: true, username: res.body.username };
        }
        return { ok: false, error: res.body.error || 'That link is no longer valid' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function confirmEmailChange(token) {
    return api('/api/email/change/confirm', 'POST', { token: token })
      .then(function (res) {
        if (res.status === 200) {
          if (S.auth && S.auth.username === res.body.username) {
            ST.setAuth({ email: res.body.email, emailVerified: true });
          }
          return { ok: true, email: res.body.email };
        }
        return { ok: false, error: res.body.error || 'That link is no longer valid' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function resendVerification() {
    return authed('/api/email/verify/send', 'POST', {})
      .then(function (res) {
        if (res.status === 200) return { ok: true, alreadyVerified: !!res.body.alreadyVerified };
        return { ok: false, error: res.body.error || 'Could not send the email' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  // Attach an address to an account that has none (every account made before
  // email support is in this state).
  function addEmail(email, password) {
    return authed('/api/email/add', 'POST', { email: email, password: password })
      .then(function (res) {
        if (res.status === 200) {
          ST.setAuth({ email: res.body.email, emailVerified: false });
          return { ok: true, verificationSent: res.body.verificationSent };
        }
        return { ok: false, error: res.body.error || 'Could not save the email' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  // Nothing changes until the link mailed to the NEW address is opened, so this
  // resolves with "check your inbox", not "done".
  function changeEmail(email, password) {
    return authed('/api/email/change', 'POST', { email: email, password: password })
      .then(function (res) {
        if (res.status === 200) return { ok: true, sentTo: res.body.sentTo };
        return { ok: false, error: res.body.error || 'Could not change the email' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  // Right to erasure. `opts` carries whichever re-authentication this account
  // supports: { password } for a Convoy password, { confirmUsername } for a
  // provider account that has none. The typed 'DELETE' is checked server-side
  // too — this is a confirmation, not a client-side formality.
  //
  // On success the account no longer exists, so there is nothing left to keep a
  // session for: clear it and reload into the signed-out app. Deliberately not
  // calling logout(), which would POST a revoke for a session GoTrue has already
  // destroyed and log a spurious failure.
  function deleteAccount(opts) {
    var payload = { confirm: 'DELETE' };
    if (opts && opts.password) payload.password = opts.password;
    if (opts && opts.confirmUsername) payload.confirmUsername = opts.confirmUsername;
    return authed('/api/account/delete', 'POST', payload)
      .then(function (res) {
        if (res.status === 200) {
          if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
          ST.clearAuth();
          return { ok: true };
        }
        return { ok: false, error: res.body.error || 'Could not delete the account' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  /* ---------------- social sign-in ---------------- */

  function isNativeApp() { return !!(A.config && A.config.isNative); }

  // Ask the server for the provider URL and go there. The verifier for the PKCE
  // exchange stays on the server, so there is nothing to stash on this side —
  // the round-trip comes back with a code and a state either way.
  //
  // WEB: a full-page navigation. Not a popup — popups are blocked by default in
  // the Android WebView and often by desktop browsers too, and the redirect
  // lands back on our own URL where readRedirect() picks it up at boot.
  //
  // APK: neither half of that works. Google answers `disallowed_useragent` to
  // OAuth started inside an embedded WebView, and the WebView's
  // https://localhost origin is not somewhere a provider can redirect to. So the
  // server hands back a URL whose redirect target is the app's own scheme, the
  // native plugin opens it in a Custom Tab, and the deep link comes back through
  // onAuthRedirect below.
  function oauthStart(provider) {
    var native = isNativeApp();
    return api('/api/oauth/start', 'POST', { provider: provider, native: native })
      .then(function (res) {
        if (res.status !== 200 || !res.body.url) {
          return { ok: false, error: res.body.error || 'Could not start sign-in' };
        }
        // Bind this flow to this device: the eventual redirect must carry THIS
        // state or it gets refused (see oauthStateIsOurs — login-CSRF defence).
        rememberOauthState(res.body.state);
        if (!native) { location.href = res.body.url; return { ok: true }; }
        return A.native.openAuthUrl(res.body.url).then(function (opened) {
          // No browser on the device at all. Say so rather than leaving a
          // disabled button and no explanation.
          if (!opened) return { ok: false, error: 'No browser available to sign in with' };
          // Deliberately NOT { ok: true }: the caller uses that to mean "we are
          // navigating away, leave the button spinning". Here the app stays on
          // screen behind the Custom Tab and the result arrives later, so the
          // sign-in screen has to stay usable in case the rider backs out.
          return { ok: true, pending: true };
        });
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  // Attach the APK's deep-link listeners. Wired once during boot, BEFORE
  // anything else runs, because both of these can arrive having COLD-STARTED the
  // app — the plugin retains each event until a listener exists, and this is
  // where that listener starts existing.
  //
  // Two sources, one handler:
  //   redirect — the provider round-trip, on the app's own scheme
  //   link     — a mailed link (reset / verify / magic / change) that Android
  //              routed here as an App Link instead of opening a browser
  function wireNativeRedirect() {
    if (!isNativeApp() || !A.native) return;

    if (A.native.onAuthRedirect) {
      A.native.onAuthRedirect(function (r) {
        // Same shape the web build parses out of its query string, so both go
        // through one handler.
        if (r.error || !r.code) {
          A.ui.showAuth(enterApp);
          A.ui.toast(r.errorDescription || r.error || 'Sign-in was cancelled', 'warn');
          return;
        }
        // The custom scheme can be fired by ANY web page or installed app, so
        // an attacker can deliver their own completed redirect here. Only a
        // state THIS device minted at oauthStart() is consumed.
        if (!oauthStateIsOurs(r.state)) {
          console.warn('[auth] ignored a native OAuth redirect with an unexpected state');
          A.ui.showAuth(enterApp);
          A.ui.toast('That sign-in didn\'t start here. Tap the button to sign in', 'warn');
          return;
        }
        handleRedirect({ kind: 'oauth', code: r.code, state: r.state });
      });
    }

    if (A.native.onAuthLink) {
      A.native.onAuthLink(function (r) {
        if (!r.kind || !r.token || LINK_KINDS.indexOf(r.kind) < 0) return;
        // No bootSession() follow-up here, unlike the web path. The APK's
        // WebView always loads a bare https://localhost/ with no query string,
        // so boot() has already run readRedirect() (which found nothing) and
        // called bootSession() by the time this retained event is delivered.
        // Booting again would just re-render the screen it already drew.
        handleRedirect({ kind: r.kind, token: r.token });
      });
    }
  }

  // Finish a provider round-trip. Resolves { ok: true } for a returning rider,
  // or { needsProfile: true, … } for a first-timer who still has to pick a
  // username and a car — the session is real either way, it just doesn't resolve
  // to a Convoy account yet.
  function oauthCallback(code, state) {
    return api('/api/oauth/callback', 'POST', { code: code, state: state })
      .then(function (res) {
        clearOauthState();   // single-use server-side; never accept a second redirect
        if (res.status !== 200) return { ok: false, error: res.body.error || 'Could not complete sign-in' };
        if (res.body.needsProfile) {
          // Hold the session so /api/oauth/complete can be called with it. The
          // username is still unknown, hence the placeholder.
          ST.setAuth({
            token: res.body.token, refreshToken: res.body.refreshToken,
            expiresAt: res.body.expiresAt, username: null
          });
          scheduleRefresh();
          return {
            ok: true, needsProfile: true, provider: res.body.provider,
            email: res.body.email, suggested: res.body.suggested || {}
          };
        }
        ST.setAuth(res.body);
        scheduleRefresh();
        return { ok: true };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function oauthComplete(username, profile) {
    return authed('/api/oauth/complete', 'POST', { username: username, profile: profile })
      .then(function (res) {
        if (res.status !== 200) return { ok: false, error: res.body.error || 'Could not finish setting up' };
        // Same session, now backed by a real account — adopt the identity the
        // server just created rather than re-authenticating.
        ST.setAuth({
          username: res.body.username, profile: res.body.profile,
          email: res.body.email, emailVerified: res.body.emailVerified, provider: res.body.provider
        });
        return { ok: true, recoveryCode: res.body.recoveryCode };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function identities() {
    return authed('/api/identities', 'POST', {})
      .then(function (res) {
        if (res.status === 200) return { ok: true, identities: res.body.identities, canUnlink: res.body.canUnlink };
        return { ok: false, error: res.body.error || 'Could not load sign-in methods' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function unlinkIdentity(identityId) {
    return authed('/api/identities/unlink', 'POST', { identityId: identityId })
      .then(function (res) {
        if (res.status === 200) return { ok: true };
        return { ok: false, error: res.body.error || 'Could not unlink that method' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function recover(username, code, newPassword) {
    return api('/api/recover', 'POST', { username: username, code: code, password: newPassword })
      .then(function (res) {
        if (res.status === 200) {
          ST.setAuth(res.body);
          scheduleRefresh();
          return { ok: true, recoveryCode: res.body.recoveryCode };
        }
        return { ok: false, error: res.body.error || 'Could not reset password' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function changePassword(oldPassword, newPassword) {
    if (!hasSession()) return Promise.resolve({ ok: false, error: 'Not signed in' });
    return authed('/api/change-password', 'POST', { oldPassword: oldPassword, newPassword: newPassword })
      .then(function (res) {
        if (res.status === 200) {
          // Changing the password revokes every other session, including the one
          // this device was using — adopt the replacement the server minted or
          // the next request 401s.
          if (res.body.token) { ST.setAuth(res.body); scheduleRefresh(); }
          return { ok: true };
        }
        return { ok: false, error: res.body.error || 'Could not change password' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function regenRecovery(password) {
    if (!hasSession()) return Promise.resolve({ ok: false });
    return authed('/api/recovery', 'POST', { password: password })
      .then(function (res) {
        return res.status === 200
          ? { ok: true, recoveryCode: res.body.recoveryCode }
          : { ok: false, error: res.body.error || 'Could not regenerate' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function me() {
    if (!hasSession()) return Promise.resolve({ ok: false });
    return authed('/api/me', 'GET', null).then(function (res) {
      if (res.status === 200) {
        ST.setAuth({
          username: res.body.username, profile: res.body.profile,
          email: res.body.email, emailVerified: res.body.emailVerified, provider: res.body.provider
        });
        return { ok: true };
      }
      // A valid session with no Convoy account behind it: a provider sign-in
      // that was abandoned before the username step. Resumable, not broken —
      // do NOT throw the session away.
      if (res.status === 409 && res.body.needsProfile) {
        return { ok: false, needsProfile: true, email: res.body.email, suggested: res.body.suggested || {} };
      }
      return { ok: false }; // token rejected and un-refreshable
    }).catch(function () {
      return { ok: 'offline' }; // server unreachable — trust the cached session for now
    });
  }

  function saveProfileToServer(profile) {
    if (!hasSession()) return;
    // Previously fire-and-forget: a failed sync (quota, offline, 4xx) was
    // silently dropped, so a profile edit could look "saved" without being.
    // Now report failures; the local copy is still persisted either way.
    authed('/api/profile', 'POST', { profile: profile }).then(function (res) {
      if (res.status !== 200 && A.ui) A.ui.toast('Profile not synced. Will retry next edit', 'warn');
    }).catch(function () {
      if (A.ui) A.ui.toast('Profile not synced. Check your connection', 'warn');
    });
  }

  function logout() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    var token = S.auth && S.auth.token;
    var done = function () { ST.clearAuth(); location.reload(); };
    if (!token) return done();
    // Revoke the session server-side so the refresh token can't be reused, but
    // never block signing out on it — clear locally either way.
    api('/api/logout', 'POST', {}, token).then(done, done);
  }

  /* ---------------- boot gating ---------------- */
  var entered = false;
  // Set when someone arrived from /delete-account signed out: they have to sign
  // in before there is an account to erase, so the intent is parked here and
  // honoured the moment they land in the app.
  var pendingDelete = false;
  function enterApp() {
    if (entered) return;
    entered = true;
    scheduleRefresh();
    A.ui.refreshAvatarBtn();
    A.mapview.refreshPlayer();
    if (A.ui.renderAccount) A.ui.renderAccount();
    // A returning session may still be unconfirmed — the map will be showing
    // everyone as "Rider" and needs the bar that explains why.
    if (A.ui.refreshVerifyBanner) A.ui.refreshVerifyBanner();
    A.net.init();
    A.net.connect();

    var next = function () {
      if (!pendingDelete) return;
      pendingDelete = false;
      if (hasSession() && A.ui.showDeleteAccount) A.ui.showDeleteAccount();
    };

    // Everyone who reaches the app comes through here — a restored session, a
    // returning guest, and a rider who just signed up — which makes this the one
    // place that can guarantee nobody rides under terms they haven't accepted.
    // A fresh sign-up already recorded consent on the way in, so the gate is a
    // no-op for them; it only ever appears for a stored consent that is missing
    // or predates a revision of the documents.
    if (ST.hasConsent && !ST.hasConsent()) A.ui.showConsentGate(next);
    else next();
  }

  /* ---------------- links coming back into the app ----------------
     Both the mailed links and the OAuth redirect land on the app's own URL with
     a query string. Read it once at boot, act on it, and scrub it out of the
     address bar — a reset or sign-in token sitting in the URL survives into
     browser history, gets copy-pasted into chats, and leaks through Referer on
     the next outbound link. */

  var LINK_KINDS = ['reset', 'verify', 'magic', 'change'];

  function stripLinkParams(keys) {
    if (!window.history || !history.replaceState) return;
    try {
      var url = new URL(location.href);
      keys.forEach(function (k) { url.searchParams.delete(k); });
      history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
    } catch (e) { /* older WebView — the token stays in the bar, nothing else breaks */ }
  }

  /* ---------------- OAuth state binding (login-CSRF defence) ----------------
     `state` is a pure bearer: an attacker can complete THEIR OWN provider
     sign-in, copy the landing URL (?cvst=…&code=…) and hand it to a victim,
     whose app would otherwise silently POST it and land signed into the
     ATTACKER's account (every GPS fix afterwards written where the attacker
     can read it). The fix: remember the state THIS device minted at start
     (localStorage, so it also survives the APK being killed mid-round-trip)
     and refuse to consume any OAuth redirect whose state doesn't match. The
     server adds the same check via an HttpOnly cookie for cookie-carrying
     clients; this one covers the APK and any no-cookie client. */
  var OAUTH_STATE_KEY = 'cv_oauth_state';
  var OAUTH_STATE_TTL_MS = 10 * 60 * 1000;   // matches oauth.js STATE_TTL_MS
  var oauthStorageOk = true;   // false once a write has thrown (private mode etc.)
  function rememberOauthState(state) {
    try { localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify({ state: state, at: Date.now() })); }
    catch (e) { oauthStorageOk = false; }
  }
  function oauthStateExpected() {
    try {
      var raw = localStorage.getItem(OAUTH_STATE_KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || !rec.state || Date.now() - rec.at > OAUTH_STATE_TTL_MS) return null;
      return rec.state;
    } catch (e) { return null; }
  }
  function clearOauthState() {
    try { localStorage.removeItem(OAUTH_STATE_KEY); } catch (e) { }
  }
  // A redirect is only ours if it carries the state we minted. Unknown/stale
  // state ⇒ someone else's sign-in landing in our URL bar — ignore it.
  // Exception: if OUR storage is broken (private mode), we never managed to
  // remember anything, so the check can't distinguish ours from foreign — and
  // an attacker has no way to break the victim's localStorage from another
  // origin. Fail open there rather than bricking OAuth entirely.
  function oauthStateIsOurs(state) {
    if (!oauthStorageOk) return true;
    var expected = oauthStateExpected();
    return !!expected && expected === state;
  }

  function readRedirect() {
    var q;
    try { q = new URLSearchParams(location.search || ''); } catch (e) { return null; }
    var state = q.get('cvst');
    if (state && q.get('code')) {
      stripLinkParams(['code', 'cvst', 'state', 'error', 'error_description', 'error_code']);
      if (!oauthStateIsOurs(state)) {
        console.warn('[auth] ignored an OAuth redirect with an unexpected state (possible login-CSRF link)');
        return null;
      }
      return { kind: 'oauth', code: q.get('code'), state: state };
    }
    // The provider (or the rider) said no. GoTrue redirects back with an error
    // rather than a code.
    if (state && (q.get('error') || q.get('error_description'))) {
      var msg = q.get('error_description') || q.get('error');
      stripLinkParams(['code', 'cvst', 'state', 'error', 'error_description', 'error_code']);
      clearOauthState();
      return { kind: 'oauth-error', message: msg };
    }
    var cv = q.get('cv'), token = q.get('token');
    if (cv && token && LINK_KINDS.indexOf(cv) >= 0) {
      stripLinkParams(['cv', 'token']);
      return { kind: cv, token: token };
    }
    // The one link shape with no token: /delete-account sends people here to
    // reach the in-app erasure flow. It carries no authority of its own — it
    // opens a screen that then re-authenticates — so there is nothing to verify.
    if (cv === 'delete') {
      stripLinkParams(['cv']);
      return { kind: 'delete' };
    }
    return null;
  }

  // A sign-in that completed. On the web this always follows a fresh page load,
  // so entering the app is all that's left. In the APK the app may have been
  // running the whole time — as a guest, behind the Custom Tab — and enterApp()
  // is a once-only gate that would return without re-rendering anything for the
  // account that just signed in. Reload instead, which is what the existing
  // guest→account path in ui.js already does for the same reason.
  function finishSignedIn(msg) {
    if (entered) { location.reload(); return; }
    enterApp();
    A.ui.toast(msg, 'success');
  }

  // Resolves TRUE when the link has taken over boot entirely (it is showing its
  // own screen), FALSE when boot should carry on as normal afterwards.
  function handleRedirect(r) {
    if (r.kind === 'oauth-error') {
      A.ui.showAuth(enterApp);
      A.ui.toast(r.message || 'Sign-in was cancelled', 'warn');
      return Promise.resolve(true);
    }

    if (r.kind === 'oauth') {
      return oauthCallback(r.code, r.state).then(function (res) {
        if (!res.ok) {
          A.ui.showAuth(enterApp);
          A.ui.toast(res.error, 'warn');
          return true;
        }
        if (res.needsProfile) { A.ui.showOAuthSetup(res, enterApp); return true; }
        finishSignedIn('Signed in as ' + (S.auth && S.auth.username ? '@' + S.auth.username : 'you'));
        return true;
      });
    }

    if (r.kind === 'magic') {
      return magicConsume(r.token).then(function (res) {
        if (!res.ok) { A.ui.showAuth(enterApp); A.ui.toast(res.error, 'warn'); return true; }
        finishSignedIn('Signed in as @' + S.auth.username);
        return true;
      });
    }

    if (r.kind === 'reset') {
      A.ui.showResetPassword(r.token, enterApp);
      return Promise.resolve(true);
    }

    // verify / change are one-shot confirmations with nothing to fill in, so
    // they report and hand boot back — the rider may or may not be signed in on
    // this device, and either way the normal path is right afterwards.
    if (r.kind === 'verify') {
      return verifyEmailToken(r.token).then(function (res) {
        A.ui.toast(res.ok ? 'Email confirmed ✓' : res.error, res.ok ? 'success' : 'warn');
        return false;
      });
    }
    if (r.kind === 'change') {
      return confirmEmailChange(r.token).then(function (res) {
        A.ui.toast(res.ok ? 'Email updated to ' + res.email : res.error, res.ok ? 'success' : 'warn');
        return false;
      });
    }

    // Arrived from /delete-account. Signed in, we go straight to the erasure
    // screen; signed out, the rider has to sign in first — there is no account
    // to delete until we know which one — so hand boot back and open the flow
    // once they're in.
    if (r.kind === 'delete') {
      if (hasSession()) {
        return me().then(function () {
          enterApp();
          A.ui.showDeleteAccount();
          return true;
        });
      }
      pendingDelete = true;
      return Promise.resolve(false);
    }
    return Promise.resolve(false);
  }

  function boot() {
    // First, so a redirect the plugin is holding from a cold start is delivered
    // as soon as it has somewhere to go.
    wireNativeRedirect();
    var link = readRedirect();
    if (link) {
      handleRedirect(link).then(function (handled) { if (!handled) bootSession(); });
      return;
    }
    bootSession();
  }

  function bootSession() {
    if (hasSession()) {
      // A session restored from localStorage is very often already expired — the
      // access token only lives about an hour. Refresh before /api/me so a
      // returning rider isn't bounced to the sign-in screen for no reason.
      var first = expiringSoon() ? refresh() : Promise.resolve(true);
      first.then(function () {
        if (!hasSession()) { A.ui.showAuth(enterApp); return; }  // refresh token was dead
        me().then(function (res) {
          if (res.ok) { enterApp(); A.ui.welcomeBack(); return; }
          // Provider sign-in that never got a username. Pick up where it stopped
          // instead of dropping a perfectly good session.
          if (res.needsProfile) { A.ui.showOAuthSetup(res, enterApp); return; }
          ST.clearAuth(); A.ui.showAuth(enterApp);
        });
      });
    } else if (S.onboarded) {
      enterApp(); A.ui.welcomeBack(); // returning guest
    } else {
      A.ui.showAuth(enterApp); // first run — pick login / register / guest
    }
  }

  A.auth = {
    boot: boot,
    enterApp: enterApp,
    config: config,
    register: register,
    login: login,
    recover: recover,
    changePassword: changePassword,
    regenRecovery: regenRecovery,
    // email
    forgot: forgot,
    resetWithToken: resetWithToken,
    magicRequest: magicRequest,
    magicConsume: magicConsume,
    verifyEmailToken: verifyEmailToken,
    confirmEmailChange: confirmEmailChange,
    resendVerification: resendVerification,
    addEmail: addEmail,
    changeEmail: changeEmail,
    deleteAccount: deleteAccount,
    // social
    oauthStart: oauthStart,
    oauthComplete: oauthComplete,
    identities: identities,
    unlinkIdentity: unlinkIdentity,
    me: me,
    refresh: refresh,
    logout: logout,
    saveProfileToServer: saveProfileToServer,
    isLoggedIn: hasSession,
    username: function () { return S.auth ? S.auth.username : null; },
    email: function () { return S.auth ? S.auth.email : null; },
    emailVerified: function () { return !!(S.auth && S.auth.emailVerified); },
    provider: function () { return (S.auth && S.auth.provider) || 'password'; }
  };
})();
