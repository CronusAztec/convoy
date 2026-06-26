/* Convoy — client auth: register/login/guest, token storage, boot gating.
   On boot decides whether to show the auth screen or enter the app, then
   triggers the realtime connection (net.connect) once identity is settled. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, ST = A.store;

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

  function register(username, password, profile) {
    return api('/api/register', 'POST', { username: username, password: password, profile: profile })
      .then(function (res) {
        if (res.status === 200) {
          ST.setAuth(res.body.token, res.body.username, res.body.profile);
          return { ok: true, recoveryCode: res.body.recoveryCode };
        }
        return { ok: false, error: res.body.error || 'Could not create account' };
      })
      .catch(function () { return { ok: false, error: 'Network error — is the server running?' }; });
  }

  function recover(username, code, newPassword) {
    return api('/api/recover', 'POST', { username: username, code: code, password: newPassword })
      .then(function (res) {
        if (res.status === 200) {
          ST.setAuth(res.body.token, res.body.username, res.body.profile);
          return { ok: true, recoveryCode: res.body.recoveryCode };
        }
        return { ok: false, error: res.body.error || 'Could not reset password' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function changePassword(oldPassword, newPassword) {
    if (!S.auth || !S.auth.token) return Promise.resolve({ ok: false, error: 'Not signed in' });
    return api('/api/change-password', 'POST', { oldPassword: oldPassword, newPassword: newPassword }, S.auth.token)
      .then(function (res) {
        if (res.status === 200) {
          // The server rotates the token on password change (tokenVersion bumped),
          // so adopt the fresh token — otherwise the next request would 401.
          if (res.body.token) ST.setAuth(res.body.token, S.auth.username);
          return { ok: true };
        }
        return { ok: false, error: res.body.error || 'Could not change password' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function regenRecovery(password) {
    if (!S.auth || !S.auth.token) return Promise.resolve({ ok: false });
    return api('/api/recovery', 'POST', { password: password }, S.auth.token)
      .then(function (res) {
        return res.status === 200 ? { ok: true, recoveryCode: res.body.recoveryCode } : { ok: false, error: res.body.error || 'Could not regenerate' };
      })
      .catch(function () { return { ok: false, error: 'Network error' }; });
  }

  function login(username, password) {
    return api('/api/login', 'POST', { username: username, password: password })
      .then(function (res) {
        if (res.status === 200) { ST.setAuth(res.body.token, res.body.username, res.body.profile); return { ok: true }; }
        return { ok: false, error: res.body.error || 'Could not sign in' };
      })
      .catch(function () { return { ok: false, error: 'Network error — is the server running?' }; });
  }

  function me() {
    if (!S.auth || !S.auth.token) return Promise.resolve({ ok: false });
    return api('/api/me', 'GET', null, S.auth.token).then(function (res) {
      if (res.status === 200) {
        ST.setAuth(S.auth.token, res.body.username, res.body.profile);
        return { ok: true };
      }
      return { ok: false }; // token rejected/expired
    }).catch(function () {
      return { ok: 'offline' }; // server unreachable — trust the cached session for now
    });
  }

  function saveProfileToServer(profile) {
    if (!S.auth || !S.auth.token) return;
    // Previously fire-and-forget: a failed sync (quota, offline, 4xx) was
    // silently dropped, so a profile edit could look "saved" without being.
    // Now report failures; the local copy is still persisted either way.
    api('/api/profile', 'POST', { profile: profile }, S.auth.token).then(function (res) {
      if (res.status !== 200 && A.ui) A.ui.toast('Profile not synced — will retry next edit', 'warn');
    }).catch(function () {
      if (A.ui) A.ui.toast('Profile not synced — check your connection', 'warn');
    });
  }

  function logout() {
    ST.clearAuth();
    location.reload();
  }

  /* ---------------- boot gating ---------------- */
  var entered = false;
  function enterApp() {
    if (entered) return;
    entered = true;
    A.ui.refreshAvatarBtn();
    A.mapview.refreshPlayer();
    if (A.ui.renderAccount) A.ui.renderAccount();
    A.net.init();
    A.net.connect();
  }

  function boot() {
    if (S.auth && S.auth.token) {
      me().then(function (res) {
        if (res.ok) { enterApp(); A.ui.welcomeBack(); }
        else { ST.clearAuth(); A.ui.showAuth(enterApp); }
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
    register: register,
    login: login,
    recover: recover,
    changePassword: changePassword,
    regenRecovery: regenRecovery,
    me: me,
    logout: logout,
    saveProfileToServer: saveProfileToServer,
    isLoggedIn: function () { return !!(S.auth && S.auth.token); },
    username: function () { return S.auth ? S.auth.username : null; }
  };
})();
