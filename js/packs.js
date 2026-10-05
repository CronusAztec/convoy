/* Convoy — feature packs (client loader).

   The app you install from a store is the core product: live riders, proximity
   voice, convoys, routes, profiles. Everything else Convoy can do — the
   enforcement awareness, scanner audio, performance timers, map overlays and
   the instrument HUD that were withdrawn from the store build — lives on the
   server under packs/<id>/ and is served ONLY to an account that has redeemed
   a code for it (Settings → Feature packs). None of it is in this file, in
   index.html, or anywhere in the bundle; this module is the hook that asks the
   server what the signed-in account holds and pulls exactly that in.

   Why it is built this way: a dormant feature inside the binary that a code
   switches on is what Apple's guideline 2.3.1 calls a hidden feature and what
   Play calls undisclosed functionality — a rejection either way. Code the app
   downloads from its own origin and runs in the WebView is permitted by both
   (Apple 2.5.2), and this screen is visible to every rider and to every
   reviewer, so nothing about it is hidden.

   The handshake:
     1. GET /api/packs (bearer) → { packs: [{ id, scripts, styles, fragments }],
        available: [...] }. Script and style URLs carry a short-lived signed
        token; the server will not serve a pack file without one, and it
        re-checks the grant on every request (server/packs/index.js).
     2. For each pack not yet loaded, in manifest order: mount the HTML
        fragments, add the stylesheets, then run the scripts one after another
        (they are ordinary App modules and may depend on each other in order).
     3. Pack scripts hook into the core through the extension points the core
        exposes — A.store.registerSettings, A.ui.addHook / legalGate,
        A.mapview.onStyle / onClick, A.net.on / send, A.routing.hook — and
        may call A.packs.register(id, { init }) to be initialised once their
        pack has fully loaded.

   Signed out, nothing is held: A.packs.has() answers false and pack code that
   listens for the 'packs' event stands down. A pack that was loaded cannot be
   unloaded within the page session; the server stops serving its data the
   moment the grant is gone, and a reload drops the code. */
(function () {
  'use strict';
  var A = window.App;
  var ST = A.store, S = A.state, U = A.util;

  var manifest = null;        // last /api/packs answer for the signed-in account
  var catalog = null;         // /api/packs/catalog — what exists, for the redeem screen
  var loaded = {};            // id -> true once its scripts have run
  var inFlight = null;        // the sync() in progress, shared by concurrent callers
  var defs = {};              // id -> { init } registered by the pack's own scripts
  var inits = {};             // id -> true once init ran

  function base() { return (A.config && A.config.base) || ''; }
  function token() { return S.auth && S.auth.token ? S.auth.token : null; }
  function headers(json) {
    var h = {};
    if (token()) h.Authorization = 'Bearer ' + token();
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function getJSON(path, opts) {
    return U.fetchT(base() + path, opts || { headers: headers() }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  /* ---------------- mounting ---------------- */
  function mountFragment(f) {
    var host = f.mount && f.mount !== 'body' ? document.querySelector(f.mount) : document.body;
    if (!host) { console.warn('[convoy packs] no mount for', f.mount); return; }
    var tpl = document.createElement('template');
    tpl.innerHTML = f.html || '';
    var frag = tpl.content;
    switch (f.position) {
      case 'prepend': host.insertBefore(frag, host.firstChild); break;
      case 'before': host.parentNode.insertBefore(frag, host); break;
      case 'after': host.parentNode.insertBefore(frag, host.nextSibling); break;
      default: host.appendChild(frag);
    }
  }
  // A stylesheet is cosmetic: wait for it so the pack's UI does not flash
  // unstyled, but never let a stalled request hold the scripts hostage.
  var STYLE_WAIT_MS = 3000;
  function loadStyle(url) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; clearTimeout(t); resolve(); } };
      var t = setTimeout(finish, STYLE_WAIT_MS);
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = base() + url;
      l.onload = finish; l.onerror = function () { l.remove(); finish(); }; // a missing stylesheet is cosmetic
      document.head.appendChild(l);
    });
  }
  function loadScripts(urls) {
    return urls.reduce(function (p, url) {
      return p.then(function () { return U.loadScript(base() + url); });
    }, Promise.resolve());
  }

  function loadPack(p) {
    if (loaded[p.id]) return Promise.resolve(false);
    (p.fragments || []).forEach(mountFragment);
    return Promise.all((p.styles || []).map(loadStyle)).then(function () {
      return loadScripts(p.scripts || []);
    }).then(function () {
      loaded[p.id] = true;
      runInit(p.id);
      ST.emit('pack:loaded', { id: p.id });
      return true;
    }).catch(function (e) {
      // A half-loaded pack would be a feature that errors; forget it so the
      // next sync() tries the whole thing again with fresh tokens.
      console.error('[convoy packs] ' + p.id + ' failed to load', e);
      if (A.telemetry) A.telemetry.capture(e, 'packs.' + p.id);
      return false;
    });
  }
  function runInit(id) {
    if (inits[id] || !loaded[id] || !defs[id]) return;
    inits[id] = true;
    try { if (typeof defs[id].init === 'function') defs[id].init(); }
    catch (e) { console.error('[convoy packs] ' + id + ' init', e); }
  }

  /* ---------------- sync ---------------- */
  function state() {
    var held = manifest ? manifest.packs.map(function (p) { return p.id; }) : [];
    return {
      signedIn: !!token(),
      held: held,
      loaded: Object.keys(loaded).filter(function (id) { return loaded[id]; }),
      packs: manifest ? manifest.packs.map(function (p) { return { id: p.id, title: p.title, blurb: p.blurb, legal: p.legal }; }) : [],
      available: manifest ? manifest.available : (catalog || [])
    };
  }
  function has(id) { return !!(manifest && manifest.packs.some(function (p) { return p.id === id; }) && loaded[id]); }
  function holds(id) { return !!(manifest && manifest.packs.some(function (p) { return p.id === id; })); }

  // Ask the server what this account holds and load whatever is new. Resolves
  // to the state; never rejects (a failed fetch leaves the last answer alone).
  function sync() {
    if (inFlight) return inFlight;
    if (!token()) { manifest = null; ST.emit('packs', state()); return Promise.resolve(state()); }
    inFlight = getJSON('/api/packs').then(function (m) {
      manifest = m && Array.isArray(m.packs) ? m : { packs: [], available: [] };
      return manifest.packs.reduce(function (p, pack) {
        return p.then(function () { return loadPack(pack); });
      }, Promise.resolve());
    }).catch(function (e) {
      if (e && e.status === 401) manifest = null;   // the session is gone; auth.js owns the refresh
      else console.warn('[convoy packs] sync failed', e && e.message);
    }).then(function () {
      inFlight = null;
      ST.emit('packs', state());
      return state();
    });
    return inFlight;
  }

  // The public catalogue, for the redeem screen when nobody is signed in (a
  // signed-in manifest already carries `available`). Cached for the session.
  function ensureCatalog() {
    if (catalog) return Promise.resolve(catalog);
    return getJSON('/api/packs/catalog', { headers: {} }).then(function (j) {
      catalog = Array.isArray(j.packs) ? j.packs : [];
      return catalog;
    }).catch(function () { return catalog || []; });
  }

  function redeem(code) {
    if (!token()) return Promise.reject(new Error('Sign in to redeem a code'));
    return getJSON('/api/packs/redeem', {
      method: 'POST', headers: headers(true), body: JSON.stringify({ code: String(code || '') })
    }).then(function (j) {
      if (A.telemetry) A.telemetry.track('pack_redeem', { n: (j.granted || []).length });
      return sync().then(function () { return { ok: true, granted: j.granted || [], label: j.label || '' }; });
    });
  }

  // The socket's welcome frame names what the server thinks this socket holds.
  // Anything we have not loaded means a grant landed since the last sync —
  // most often the one this device just redeemed on another tab.
  function onWelcome(ids) {
    if (!token() || !Array.isArray(ids)) return;
    var missing = ids.some(function (id) { return !loaded[id]; });
    if (missing || !manifest) sync();
  }

  function register(id, def) {
    defs[id] = def || {};
    runInit(id);
  }

  function init() {
    ST.on('auth', function (a) {
      if (a && a.token) sync(); else { manifest = null; ST.emit('packs', state()); }
    });
    if (token()) sync();
  }

  A.packs = {
    init: init, sync: sync, redeem: redeem, state: state, has: has, holds: holds,
    register: register, onWelcome: onWelcome, ensureCatalog: ensureCatalog,
    // test surface
    _loadPack: loadPack, _mountFragment: mountFragment
  };
})();
