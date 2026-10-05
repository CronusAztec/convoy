/* Convoy — keep-screen-awake (settings.keepAwake).

   Uses the web Wake Lock API (Chrome/WebView 84+, Safari 16.4+). The lock is
   auto-released by the browser whenever the tab hides, so we re-acquire on
   visibilitychange while the setting is on. No-ops gracefully where unsupported. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var S = A.state, ST = A.store;

  var sentinel = null;
  var warned = false;

  function supported() { return !!(navigator.wakeLock && navigator.wakeLock.request); }

  function acquire() {
    if (!S.settings.keepAwake || document.hidden || sentinel) return;
    if (!supported()) {
      if (!warned) { warned = true; A.ui.toast('Screen wake lock is not supported on this device', 'warn'); }
      return;
    }
    navigator.wakeLock.request('screen').then(function (s) {
      sentinel = s;
      s.addEventListener('release', function () { sentinel = null; });
    }).catch(function () { /* low battery / permission — nothing to do */ });
  }

  function release() {
    if (sentinel) { try { sentinel.release(); } catch (e) { } sentinel = null; }
  }

  function apply(on) { on ? acquire() : release(); }

  function init() {
    apply(S.settings.keepAwake);
    ST.on('setting', function (s) { if (s.key === 'keepAwake') apply(s.val); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) acquire(); // browser dropped the lock while hidden
    });
  }

  A.wake = { init: init };
})();
