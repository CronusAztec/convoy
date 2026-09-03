/* Convoy — crash reporting + core-loop analytics.

   Without this file the crash reporter is the review section: a launch-day
   WebView crash reaches us days late, from an angry stranger, with no stack and
   no idea which screen they were on. This module is the alternative — every
   uncaught error, every unhandled rejection and a small, fixed set of core-loop
   milestones, shipped off the device while the rider is still using the app.

   Two transports, and they answer different questions:

     · Our own server (/api/telemetry) ALWAYS receives everything. It is what
       makes "99% crash-free sessions" a number we can actually read on day one,
       with no third-party account, no SDK bundle, and nothing in the request
       that a rider would not expect us to have. It also holds the funnel, which
       is the only way to see the screen where people quit.

     · Sentry ALSO receives errors, but only once a DSN is configured in
       js/config.js. That is the grouping, alerting and release-tracking half —
       the part that is genuinely painful to rebuild — and it is opt-in precisely
       so the app is never broken by an account that does not exist yet.

   Deliberate design constraints, each one load-bearing:

   1. This module depends on NOTHING except js/config.js, and it installs its
      handlers at load time rather than in init(). A crash reporter that boots
      after state.js cannot report a crash IN state.js, which is exactly the
      class of bug that kills a launch. The opt-out is therefore read straight
      out of localStorage here instead of through A.state.

   2. It never sends a position. Not in a breadcrumb, not in an event property,
      not in a URL. §3 of the privacy policy says we do not store location
      history and that stays literally true — the funnel records THAT a trip
      started, never where it went.

   3. Everything is bounded: events per session, events per fingerprint,
      breadcrumbs, message length, batch size. A tight error loop inside a
      render tick must cost the rider one report, not their data plan.

   Sentry ingest is a plain https POST, and the CSP already allows connect-src
   https:, so nothing here needs a policy change (and nothing loads a script
   from a third party — script-src stays as tight as it is). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});

  /* ---------------- budgets ---------------- */
  var MAX_EVENTS = 60;          // hard ceiling on what one session may send
  var MAX_PER_FP = 3;           // same error, same session: send 3, then count only
  var MAX_CRUMBS = 20;
  var MAX_BATCH = 10;
  // The server's readBody() refuses a body over 48KB with a 413, and a batch of
  // stack-carrying errors gets there easily — so batches are bounded in BYTES,
  // not just in count. A report that is dropped for being too big is a report
  // we never see, which is the one outcome this file exists to prevent.
  var BATCH_BYTES = 30000;
  var FLUSH_MS = 5000;
  var MSG_MAX = 500;
  var STACK_MAX = 4000;
  var TRACK_MIN_GAP = 1000;     // per-name floor between analytics events

  /* ---------------- session identity ----------------
     A per-LAUNCH random id, never persisted. It is enough to count sessions and
     to tell "one rider hit this 40 times" from "40 riders hit this once", and it
     is deliberately not enough to follow anyone between launches. */
  var sid = rid(16);
  var bootAt = now();
  var queue = [];
  var crumbs = [];
  var seen = {};                // fingerprint -> times seen this session
  var sent = 0;                 // events actually queued this session
  var dropped = 0;              // events refused by a budget
  var crashed = false;          // ≥1 error this session — drives crash-free %
  var steps = {};               // funnel step -> ms since boot
  var lastTrack = {};           // event name -> last send time
  var screenName = 'map';
  var started = false;          // init() ran
  var flushTimer = null;
  var ended = false;

  function now() { return Date.now(); }
  function since() { return now() - bootAt; }

  function rid(n) {
    var s = '';
    // crypto where we have it; Math.random is a fine fallback for something that
    // only has to be unique, not unguessable.
    if (window.crypto && window.crypto.getRandomValues) {
      var b = new Uint8Array(n / 2);
      window.crypto.getRandomValues(b);
      for (var i = 0; i < b.length; i++) s += (b[i] + 0x100).toString(16).slice(1);
      return s;
    }
    while (s.length < n) s += Math.random().toString(16).slice(2);
    return s.slice(0, n);
  }

  /* ---------------- build tag ----------------
     Read off this script's own cache-buster (js/telemetry.js?v=cy108) rather
     than kept as a second constant somebody has to remember to bump. The query
     is already bumped on every ship, so the release stamp can never drift from
     the build the rider is actually running. */
  var release = (function () {
    try {
      var s = document.currentScript;
      var m = s && s.src && s.src.match(/[?&]v=([A-Za-z0-9._-]{1,32})/);
      return m ? m[1] : 'dev';
    } catch (e) { return 'dev'; }
  })();

  /* ---------------- opt-out ----------------
     Parsed from the same localStorage record state.js owns, because this module
     runs before state.js does and must keep working if state.js is what broke.
     Anything unreadable reads as OPTED IN — the default the settings screen and
     the privacy policy both describe — except that a rider who has explicitly
     turned diagnostics off stays off even when the rest of the save is corrupt. */
  var KEY = 'convoy.v1';
  var optedOut = false;
  function readOptOut() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      return !!(saved && saved.settings && saved.settings.diagnostics === false);
    } catch (e) { return false; }
  }
  optedOut = readOptOut();

  function on() { return !optedOut; }

  /* ---------------- scrubbing ----------------
     Applied to every string that leaves the device. Stack traces carry URLs,
     URLs carry tokens, and error messages carry whatever was interpolated into
     them — so this runs at the boundary rather than at each call site, where one
     forgotten call is a leak. */
  function scrub(s) {
    if (s == null) return '';
    s = String(s);
    // Avatar data URLs are up to 24KB of base64 and appear in "failed to load"
    // messages; keep the shape, drop the payload.
    s = s.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:<redacted>');
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>');
    // Query values that are credentials in this app's URLs. The key stays so the
    // report still says WHICH parameter was involved.
    s = s.replace(/([?&](?:token|access_token|refresh_token|key|code|apikey|sentry_key)=)[^&\s"']+/gi,
      '$1<redacted>');
    return s;
  }

  // Same idea for a URL we are reporting on its own (a failed resource load).
  // The path is the useful part; the query is never worth the risk.
  function scrubUrl(u) {
    u = scrub(u).split('?')[0].split('#')[0];
    return u.slice(0, 200);
  }

  function clip(s, n) {
    s = scrub(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ---------------- fingerprinting ----------------
     Groups "the same bug" across riders. Digits, hex ids and URL paths are
     stripped out of the message so `rider id7f3a not found` and `rider idb91c
     not found` land in one group instead of one group per rider. */
  function fingerprint(type, msg, frame) {
    // scrub() FIRST. The fingerprint travels with every report and is a rollup
    // key on the server, so building it from the raw message put redacted
    // content straight back on the wire — an email address survived the scrubbed
    // `msg` field and rode out inside `fp`.
    var norm = scrub(msg)
      .replace(/https?:\/\/[^\s)'"]+/g, '<url>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\d+/g, 'N')
      .slice(0, 160);
    return (type || 'Error') + '|' + norm + '|' + (frame || '');
  }

  /* ---------------- stack frames ----------------
     Chrome/Android-WebView ("at fn (url:line:col)") and Safari/Firefox
     ("fn@url:line:col") both appear — the app ships as an APK and as a web page,
     so both matter. Frames come back newest-first here; the Sentry payload
     reverses them, because Sentry renders oldest-first. */
  function parseStack(stack) {
    var out = [];
    var lines = String(stack || '').split('\n');
    for (var i = 0; i < lines.length && out.length < 30; i++) {
      var l = lines[i].trim();
      var m = l.match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/) ||
              l.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
      if (!m) continue;
      out.push({
        fn: (m[1] || '?').replace(/^new\s+/, '').slice(0, 120),
        file: scrubUrl(m[2]),
        line: +m[3] || 0,
        col: +m[4] || 0
      });
    }
    return out;
  }

  /* ---------------- breadcrumbs ----------------
     The last 20 things that happened before the crash. Screen changes, network
     transitions, funnel steps and toasts — enough to reconstruct "they opened
     Convoy, lost the socket, then it threw", which is the difference between a
     stack trace and a repro. Values only, never free text from other riders. */
  function crumb(cat, msg, data) {
    if (!on()) return;
    crumbs.push({ t: since(), c: cat, m: clip(msg, 120), d: data || undefined });
    if (crumbs.length > MAX_CRUMBS) crumbs.shift();
  }

  /* ---------------- queue ---------------- */
  function push(ev) {
    if (!on()) return;
    if (sent >= MAX_EVENTS) { dropped++; return; }
    sent++;
    ev.t = since();
    queue.push(ev);
    // Errors go now: the next thing that happens may be the WebView dying, and a
    // report still sitting in a 5s batch is a report we never see.
    if (ev.k === 'error') flush();
    else arm();
  }

  function arm() {
    if (flushTimer || !queue.length) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(); }, FLUSH_MS);
  }

  /* ---------------- capture ---------------- */
  function record(o) {
    var frames = parseStack(o.stack);
    var top = frames.length ? (frames[0].file + ':' + frames[0].line) : (o.src || '');
    var fp = fingerprint(o.type, o.msg, top);
    var n = (seen[fp] = (seen[fp] || 0) + 1);
    // Past the per-fingerprint cap we stop sending but keep counting, and the
    // total rides out with the session summary. A render-loop error that fires
    // 4000 times must not cost 4000 POSTs — but "4000" is itself the finding.
    if (n > MAX_PER_FP) { dropped++; return; }

    var wasFirst = !crashed;
    crashed = true;

    var ev = {
      k: 'error',
      type: String(o.type || 'Error').slice(0, 80),
      msg: clip(o.msg, MSG_MAX),
      stack: clip(o.stack, STACK_MAX),
      frames: frames.slice(0, 20),
      src: o.src ? scrubUrl(o.src) : undefined,
      line: o.line || undefined,
      col: o.col || undefined,
      handled: !!o.handled,
      fp: fp,
      seen: n,
      screen: screenName,
      crumbs: crumbs.slice(-MAX_CRUMBS)
    };
    push(ev);
    // The first error in a session is what flips it out of "crash-free". Say so
    // on the wire immediately rather than only in the session summary, which a
    // hard WebView kill would never send.
    if (wasFirst) crumb('error', 'session marked crashed');
    if (A.config && A.config.debugTelemetry) console.warn('[telemetry]', ev.type, ev.msg);
  }

  function fromError(err, ctx) {
    if (err && typeof err === 'object' && (err.stack || err.message)) {
      return { type: err.name || 'Error', msg: err.message || String(err), stack: err.stack, ctx: ctx };
    }
    // A thrown string/object — no stack to be had, so synthesize one so the
    // report still says where it came from.
    var msg;
    try { msg = typeof err === 'string' ? err : JSON.stringify(err); }
    catch (e) { msg = String(err); }
    return { type: 'NonError', msg: String(msg).slice(0, MSG_MAX), stack: new Error().stack };
  }

  /* ---------------- global handlers (installed NOW, not in init) ---------------- */
  window.addEventListener('error', function (e) {
    try {
      // Capture phase also sees failed resource loads, where `target` is the
      // element and there is no `error`. A dead CDN is why the map is blank, so
      // it is worth a report — just a different kind of one.
      var t = e && e.target;
      if (t && t !== window && (t.src || t.href)) {
        record({
          type: 'ResourceError',
          msg: 'failed to load ' + (t.tagName || '?').toLowerCase() + ': ' + scrubUrl(t.src || t.href),
          handled: false
        });
        return;
      }
      var o = e && e.error ? fromError(e.error) : { type: 'Error', msg: (e && e.message) || 'script error' };
      o.src = (e && e.filename) || undefined;
      o.line = (e && e.lineno) || undefined;
      o.col = (e && e.colno) || undefined;
      record(o);
    } catch (err) { /* never let the reporter throw inside the error path */ }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && ('reason' in e ? e.reason : e.detail && e.detail.reason);
      var o = fromError(r);
      o.type = 'UnhandledRejection: ' + o.type;
      record(o);
    } catch (err) { /* as above */ }
  });

  /* ---------------- transports ---------------- */
  function base() {
    try { return (A.config && A.config.base) || ''; } catch (e) { return ''; }
  }

  function post(url, body, beacon) {
    try {
      // Page is going away: sendBeacon is the only thing the browser promises to
      // finish. text/plain keeps it a CORS-simple request, so the native shell's
      // cross-origin POST needs no preflight it will not get time to make.
      if (beacon && navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      if (window.fetch) {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: body,
          keepalive: body.length < 60000,
          mode: 'cors',
          credentials: 'omit',
          // Inline, not A.util.fetchT(): this file loads before util.js (index.html,
          // second on purpose) and must still report when util.js never loaded.
          // test/fetchtimeout.test.js accepts a static `signal` here for that reason.
          signal: (typeof AbortSignal === 'function' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined
        }).catch(function () { /* telemetry must never surface an error to the rider */ });
        return;
      }
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      x.onerror = function () {};
      x.send(body);
    } catch (e) { /* offline, blocked, no transport — drop it */ }
  }

  /* Sentry, via the envelope endpoint, with no SDK on the page.

     The DSN's public key travels in the query string rather than an
     X-Sentry-Auth header on purpose: a custom header would make this a
     preflighted request, and the native WebView's OPTIONS round-trip is exactly
     what fails when the app is being killed. */
  var dsn = (function () {
    try {
      var raw = (A.config && A.config.sentryDsn) || '';
      var m = String(raw).match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)\/?$/);
      if (!m) return null;
      return {
        url: 'https://' + m[2] + '/api/' + m[3] + '/envelope/?sentry_key=' + m[1] + '&sentry_version=7',
        raw: raw
      };
    } catch (e) { return null; }
  })();

  function sentryLevel(type) {
    return /ResourceError/.test(type) ? 'warning' : 'error';
  }

  function toSentry(ev, beacon) {
    var id = rid(32);
    var frames = (ev.frames || []).slice().reverse().map(function (f) {
      return { function: f.fn, filename: f.file, lineno: f.line, colno: f.col, in_app: true };
    });
    var payload = {
      event_id: id,
      timestamp: (bootAt + ev.t) / 1000,
      platform: 'javascript',
      level: sentryLevel(ev.type),
      release: 'convoy@' + release,
      environment: (A.config && A.config.isNative) ? 'android' : 'web',
      logger: 'convoy',
      exception: {
        values: [{
          type: ev.type,
          value: ev.msg,
          mechanism: { type: 'generic', handled: !!ev.handled },
          stacktrace: frames.length ? { frames: frames } : undefined
        }]
      },
      tags: { screen: ev.screen, session: sid, native: !!(A.config && A.config.isNative) },
      contexts: { app: { app_start_time: new Date(bootAt).toISOString() } },
      breadcrumbs: {
        values: (ev.crumbs || []).map(function (c) {
          return {
            timestamp: (bootAt + c.t) / 1000,
            category: c.c,
            message: c.m,
            level: 'info',
            data: c.d
          };
        })
      },
      extra: { seen_this_session: ev.seen, dropped_this_session: dropped }
    };
    var body = JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn: dsn.raw }) + '\n' +
      JSON.stringify({ type: 'event' }) + '\n' +
      JSON.stringify(payload);
    post(dsn.url, body, beacon);
  }

  /* Pull as much of the queue as fits the byte budget, always at least one
     event — a single oversized report is better truncated by the server's clamps
     than stuck in the queue forever blocking everything behind it. */
  function takeBatch() {
    var out = [], bytes = 0;
    while (queue.length && out.length < MAX_BATCH) {
      var size;
      try { size = JSON.stringify(queue[0]).length; } catch (e) { queue.shift(); continue; }
      if (out.length && bytes + size > BATCH_BYTES) break;
      bytes += size;
      out.push(queue.shift());
    }
    return out;
  }

  function flush(beacon) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length || !on()) return;
    var batch = takeBatch();
    if (!batch.length) return;

    if (dsn) {
      for (var i = 0; i < batch.length; i++) {
        if (batch[i].k === 'error') toSentry(batch[i], beacon);
      }
    }

    post(base() + '/api/telemetry', JSON.stringify({
      sid: sid,
      release: release,
      native: !!(A.config && A.config.isNative),
      events: batch
    }), beacon);

    // More than one batch waiting (an error storm): keep going, still bounded by
    // MAX_EVENTS, so nothing sits in the queue until the app closes.
    if (queue.length) { if (beacon) flush(true); else arm(); }
  }

  /* ---------------- public API ---------------- */

  // A caught error worth knowing about. `where` is a short static label, never
  // interpolated rider content.
  function capture(err, where) {
    try {
      var o = fromError(err);
      o.handled = true;
      if (where) o.msg = '[' + String(where).slice(0, 40) + '] ' + o.msg;
      record(o);
    } catch (e) { /* swallow */ }
  }

  // A product event. Props must be small, bounded and non-identifying — numbers,
  // booleans and short enums. Strings are clipped; objects are refused.
  function track(name, props) {
    if (!on()) return;
    name = String(name || '').slice(0, 40);
    if (!name) return;
    var last = lastTrack[name] || 0;
    if (now() - last < TRACK_MIN_GAP) { dropped++; return; }
    lastTrack[name] = now();
    push({ k: 'event', name: name, props: safeProps(props), screen: screenName });
    crumb('event', name, safeProps(props));
  }

  function safeProps(p) {
    if (!p || typeof p !== 'object') return undefined;
    var out = {}, n = 0;
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k) || n >= 8) continue;
      var v = p[k];
      var t = typeof v;
      if (t === 'number') out[k] = isFinite(v) ? Math.round(v * 100) / 100 : 0;
      else if (t === 'boolean') out[k] = v;
      else if (t === 'string') out[k] = clip(v, 60);
      else continue;   // objects/arrays/functions are refused, not serialized
      n++;
    }
    return n ? out : undefined;
  }

  /* A core-loop milestone, recorded once per session with the time it took to
     get there. This is the funnel: the step a session never reaches is the
     screen where that rider quit. */
  function step(name) {
    if (!on()) return;
    name = String(name || '').slice(0, 32);
    if (!name || steps[name] != null) return;
    steps[name] = since();
    push({ k: 'event', name: 'step:' + name, props: { ms: steps[name] }, screen: screenName });
    crumb('step', name, { ms: steps[name] });
  }

  function screen(name) {
    name = String(name || 'map').slice(0, 32);
    if (name === screenName) return;
    screenName = name;
    crumb('screen', name);
    track('screen', { name: name });
  }

  /* The session summary, and the other half of the crash-free number: `started`
     counts sessions, `crashed` counts the ones that saw at least one error. It
     is sent on the first hide rather than on unload — mobile WebViews are killed
     from the background without ever firing unload — and only once. */
  function end(reason) {
    if (ended || !on()) return;
    ended = true;
    // Bypass the queue's normal batching: this is the last thing we will ever
    // get to say for this session.
    if (sent < MAX_EVENTS) {
      sent++;
      queue.push({
        k: 'end', t: since(), ms: since(), reason: String(reason || 'hidden').slice(0, 24),
        lastScreen: screenName, steps: steps, crashed: crashed,
        events: sent, dropped: dropped,
        errors: Object.keys(seen).length
      });
    }
    flush(true);
  }

  /* ---------------- wiring ----------------
     Called from app.js once state.js and the event bus exist. Everything below
     is instrumentation the bus already broadcasts, so the core loop is measured
     without scattering track() calls through eight modules. */
  function init() {
    if (started) return;
    started = true;
    // Re-read the opt-out now that state.js has merged defaults over the save —
    // load() may have repaired a partial settings object we could not parse.
    try {
      if (A.state && A.state.settings && A.state.settings.diagnostics === false) optedOut = true;
    } catch (e) { }
    if (!on()) { queue.length = 0; return; }

    push({
      k: 'session',
      release: release,
      native: !!(A.config && A.config.isNative),
      ua: clip(navigator.userAgent, 200),
      lang: (navigator.language || '').slice(0, 12),
      tz: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
      })().slice(0, 40),
      screen: (window.screen ? (window.screen.width + 'x' + window.screen.height) : ''),
      dpr: window.devicePixelRatio || 1
    });
    step('boot');

    var ST = A.store;
    if (ST && ST.on) {
      // The funnel, in the order a rider actually walks it.
      ST.on('gpsfix', function () { step('gps_fix'); });
      ST.on('route', function (r) { if (r) step('route_set'); });
      ST.on('trip', function (t) { if (t) step('trip_start'); });
      ST.on('party', function () { if (A.state && A.state.party) step('convoy'); });
      ST.on('auth', function (a) { if (a && a.username) step('signed_in'); });
      // Settings changes are the cheapest possible signal about which features
      // riders actually turn on — the key only, never the value's contents.
      ST.on('setting', function (s) {
        if (!s || !s.key) return;
        if (s.key === 'diagnostics') return;   // handled by setEnabled
        crumb('setting', s.key);
      });
    }

    // A session ends when the app goes to the background, because on Android
    // that is frequently the last moment we get. `pagehide` covers the web tab.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) end('hidden'); else arm();
    });
    window.addEventListener('pagehide', function () { end('pagehide'); });

    arm();
  }

  // The settings toggle. Turning it OFF drops everything queued and stops all
  // sending immediately — an opt-out that still ships the current batch is not
  // an opt-out. Turning it back on starts a fresh session record.
  function setEnabled(v) {
    optedOut = !v;
    if (optedOut) {
      queue.length = 0;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    } else if (started) {
      ended = false;
      track('diagnostics_on');
    }
  }

  A.telemetry = {
    init: init,
    capture: capture,
    track: track,
    step: step,
    screen: screen,
    crumb: crumb,
    end: end,
    flush: flush,
    setEnabled: setEnabled,
    enabled: function () { return on(); },
    // Inspection hook for tests and for the debug console; never sent anywhere.
    snapshot: function () {
      return {
        sid: sid, release: release, crashed: crashed, sent: sent, dropped: dropped,
        steps: steps, screen: screenName, queued: queue.length,
        fingerprints: Object.keys(seen).length, sentry: !!dsn
      };
    }
  };
})();
