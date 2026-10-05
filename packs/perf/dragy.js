/* Convoy — Performance timers pack: the Dragy-style GPS performance meter
   (packs/perf/dragy.js).

   The js/dragy.js module as it was before the 2026-10-04 store cut
   (git show a1de6fd:js/dragy.js), re-homed as a feature pack script. Times
   acceleration runs (0–60 mph, 0–100 km/h, ⅛ & ¼ mile, 60–130 mph…) from the
   phone's GPS. It reuses the SINGLE geolocation watch in sim.js via the
   'gpsfix' event (one location source for the whole app). Speed comes from GPS
   Doppler (coords.speed) when the device reports it, else it's derived from
   position deltas. Distance is the time-integral of that speed, and crossings
   are solved inside the bracketing segment under a constant-acceleration
   model, so timing isn't capped at the ~1 Hz sample rate.
   HONEST: phone GPS (~1 Hz, Doppler missing on some hardware) can't match a
   10 Hz Dragy box — treat results as ballpark, best on a clear-sky run on a
   real road.

   What this file re-creates through the core's extension points, instead of
   the core hunks the cut removed:
     - js/ui.js      → the "Performance timers" settings section (A.ui.addHook
                       'settings'), the "Fastest times" section of the profile
                       page (hook 'profile') and the stats strip + "Best dragy
                       times" section of the public-profile overlay (hook
                       'profile-overlay') — bestsFromStats / pbRowsHtml /
                       renderTimes, verbatim; the #chip-dragy tap js/ui.js's
                       init() used to shim; the 'stats'-event refresh
     - js/net.js     → the 'dragy:pb' handler (now 'perf:dragy:pb') and the
                       pack's own 'perf:stats' answer, via A.net.on
     - server        → the PB upload. It was POST /api/dragy/pb; a pack route
                       cannot read a request body (the core consumes it before
                       dispatching to packs), so the upload rides the socket as
                       'perf:dragy:pb' — the second path the old server already
                       accepted — and GET /api/perf/dragy/pb seeds the stats
     - index.html    → chip.html, mounted into #chips by the loader
     - css/styles.css → perf.css

   REGULATED: the chip is hidden until Settings → Performance timers is on,
   and the switch and the chip tap both go through A.ui.legalGate('race', …). */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store, P = A.perf;

  /* ---------- units / conversions ---------- */
  var MS_TO_MPH = 2.2369362921, MS_TO_KMH = 3.6;
  var MPH = 1 / MS_TO_MPH, KMH = 1 / MS_TO_KMH;   // unit -> m/s
  var MILE = 1609.344, FOOT = 0.3048;

  /* ---------- launch / staging thresholds (m/s) ---------- */
  var STAGED = 0.7;     // below this = stationary (staged & ready)
  var LAUNCH = 1.3;     // crossing up through this = launch detected
  var EPS = 0.3;        // ~first-movement speed used to back-date t0
  var ABORT_MS = 1400;  // rolling to a stop this long mid-run aborts the run

  /* ---------- measurement presets ----------
     accel: time from `from` to `to` (m/s). from 0 ⇒ standing start (needs staging).
     dist : time + trap speed over `meters` from the launch point. */
  var MODES = [
    { id: '0-60',     label: '0–60 mph',     type: 'accel', from: 0,         to: 60 * MPH },
    { id: '0-100k',   label: '0–100 km/h',   type: 'accel', from: 0,         to: 100 * KMH },
    { id: '0-30',     label: '0–30 mph',     type: 'accel', from: 0,         to: 30 * MPH },
    { id: '0-100',    label: '0–100 mph',    type: 'accel', from: 0,         to: 100 * MPH },
    { id: '60-130',   label: '60–130 mph',   type: 'accel', from: 60 * MPH,  to: 130 * MPH },
    { id: '100-200k', label: '100–200 km/h', type: 'accel', from: 100 * KMH, to: 200 * KMH },
    { id: 'eighth',   label: '⅛ mile',       type: 'dist',  from: 0, meters: MILE / 8 },
    { id: 'quarter',  label: '¼ mile',       type: 'dist',  from: 0, meters: MILE / 4 }
  ];

  // Milestones recorded during ANY standing-start run for the splits table.
  var SPLITS = [
    { id: '60ft',   label: '60 ft',      type: 'dist',  meters: 60 * FOOT },
    { id: '0-30',   label: '0–30 mph',   type: 'accel', to: 30 * MPH },
    { id: '0-60',   label: '0–60 mph',   type: 'accel', to: 60 * MPH },
    { id: '0-100k', label: '0–100 km/h', type: 'accel', to: 100 * KMH },
    { id: 'eighth', label: '⅛ mile',     type: 'dist',  meters: MILE / 8, trap: true },
    { id: '0-100',  label: '0–100 mph',  type: 'accel', to: 100 * MPH },
    { id: 'quarter', label: '¼ mile',    type: 'dist',  meters: MILE / 4, trap: true }
  ];

  function modeById(id) { for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i]; return MODES[0]; }

  /* ---------- run state ---------- */
  var shown = false;          // overlay visible
  var mode = null;            // selected preset
  var phase = 'idle';         // idle | arm | run | done
  var staged = false;         // came to a stop (standing starts only)
  var prev = null;            // last raw fix {t, speed, pos}
  var runPrev = null;         // last processed run sample {t, speed, dist}
  var t0 = 0;                 // launch time (epoch ms)
  var runDist = 0;            // metres travelled since launch
  var liveSpeed = 0;          // current speed, m/s
  var splits = {};            // id -> {t, trap?}
  var result = null;          // finished run
  var lastFixAt = 0;          // wall-clock of last accepted fix
  var stoppedSince = 0;       // when the car first dropped to a stop mid-run

  /* ---------- unit helpers ---------- */
  function km() { return S.settings.units === 'km'; }
  function spVal(ms) { return ms * (km() ? MS_TO_KMH : MS_TO_MPH); }
  function spUnit() { return km() ? 'KM/H' : 'MPH'; }
  function spUnitLo() { return km() ? 'km/h' : 'mph'; }

  /* =================== timing core =================== */

  // Speed source: GPS Doppler when present, else derived from the last position.
  function speedOf(f) {
    if (f.speed != null && f.speed >= 0) return f.speed;
    if (!prev) return 0;
    var dt = (f.t - prev.t) / 1000;
    return dt > 0 ? U.haversine(prev.pos, f.pos) / dt : prev.speed;
  }

  function onFix(f) {
    if (!shown || !f || !f.pos) return;
    var t = f.t || Date.now();
    var sp = speedOf(f); if (!(sp >= 0)) sp = 0;
    liveSpeed = sp;
    lastFixAt = Date.now();

    if (phase === 'arm') {
      if (mode.from === 0) {                      // standing start
        if (sp < STAGED) staged = true;
        if (sp < EPS) { launchAt = 0; launchDist = 0; } // rolled back to a stop
        if (staged && prev) trackEpsCross(prev, sp, t);
        if (staged && prev && prev.speed < LAUNCH && sp >= LAUNCH) startStanding(f.pos, sp, t);
      } else if (prev && prev.speed < mode.from && sp >= mode.from) {
        startRolling(f.pos, sp, t);               // rolling start: crossed `from` going up
      }
    } else if (phase === 'run') {
      stepRun(f.pos, sp, t);
    }

    prev = { t: t, speed: sp, pos: f.pos.slice() };
  }

  // Distance covered over one segment. Trapezoidal integration of speed — EXACT
  // under the constant acceleration each segment is modelled with, and far
  // steadier than summing GPS chord lengths (which under-read through corners and
  // inflate from position noise at low speed). This is what a real Dragy box
  // does: it integrates Doppler velocity, it does not add up fixes. Distance,
  // crossing time and trap speed then all come from one model, so they can never
  // disagree with each other.
  function segDist(v0, v1, dtSec) {
    return dtSec > 0 ? 0.5 * (v0 + v1) * dtSec : 0;
  }

  /* ---- launch back-dating (standing starts) ----
     t0 must be the instant the car FIRST CREPT ABOVE EPS, which happens well
     before speed reaches the LAUNCH threshold. Interpolating between the two
     fixes that bracket LAUNCH only coincides with that on a slow receiver: at
     1 Hz the car goes 0 → well past 1.3 m/s in a single segment, so both events
     sit in the same pair. At 10 Hz they don't — the previous fix is already
     above EPS, the interpolation factor comes out negative, clamps to 0, and t0
     lands on that fix instead of the real crossing. The timer therefore started
     late and reported times ~0.2 s OPTIMISTIC, and got worse the faster the GPS
     was. So watch for the EPS crossing as it happens and integrate from there. */
  var launchAt = 0;     // epoch ms of the EPS crossing (0 = not seen yet)
  var launchDist = 0;   // metres covered since that crossing

  function trackEpsCross(p, sp, t) {
    if (p.speed < EPS && sp >= EPS) {
      var f = U.clamp((EPS - p.speed) / Math.max(1e-4, sp - p.speed), 0, 1);
      launchAt = p.t + f * (t - p.t);
      launchDist = segDist(EPS, sp, (t - launchAt) / 1000);
    } else if (launchAt && p.speed >= EPS) {
      launchDist += segDist(p.speed, sp, (t - p.t) / 1000);
    }
  }

  function startStanding(pos, sp, t) {
    if (launchAt) { beginRun({ t: (t0 = launchAt), speed: EPS, dist: 0 }, launchDist, sp, t); return; }
    // Never observed the sub-EPS side (the first fix after opening the meter was
    // already rolling) — fall back to bracketing this segment.
    var f = U.clamp((EPS - prev.speed) / Math.max(1e-4, sp - prev.speed), 0, 1);
    t0 = prev.t + f * (t - prev.t);
    beginRun({ t: t0, speed: EPS, dist: 0 }, segDist(EPS, sp, (t - t0) / 1000), sp, t);
  }

  function startRolling(pos, sp, t) {
    var f = U.clamp((mode.from - prev.speed) / Math.max(1e-4, sp - prev.speed), 0, 1);
    t0 = prev.t + f * (t - prev.t);
    beginRun({ t: t0, speed: mode.from, dist: 0 }, segDist(mode.from, sp, (t - t0) / 1000), sp, t);
  }

  function beginRun(launchSample, dist0, sp, t) {
    phase = 'run'; splits = {}; result = null; stoppedSince = 0;
    runDist = dist0;
    runPrev = launchSample;
    processSegment(sp, t);   // first segment: launch sample -> this fix
  }

  function stepRun(pos, sp, t) {
    if (prev) runDist += segDist(prev.speed, sp, (t - prev.t) / 1000);
    processSegment(sp, t);
    if (phase !== 'run') return;
    var floor = mode.from > 0 ? mode.from * 0.7 : STAGED;   // lifted / rolled to a stop?
    if (sp < floor) {
      if (!stoppedSince) stoppedSince = t;
      else if (t - stoppedSince > ABORT_MS) resetArm();
    } else stoppedSince = 0;
  }

  // Process the segment runPrev -> {speed, dist} for the selected target + every split.
  function processSegment(curSpeed, curT) {
    var a = runPrev, b = { t: curT, speed: curSpeed, dist: runDist };

    if (mode.type === 'accel') crossAccel(mode.to, a, b, function (ct) { finish((ct - t0) / 1000, null); });
    else crossDist(mode.meters, a, b, function (ct, trap) { finish((ct - t0) / 1000, trap); });

    if (mode.from === 0) {     // splits only make sense from a standing start
      SPLITS.forEach(function (m) {
        if (splits[m.id]) return;
        if (m.type === 'accel') crossAccel(m.to, a, b, function (ct) { splits[m.id] = { t: (ct - t0) / 1000 }; });
        else crossDist(m.meters, a, b, function (ct, trap) { splits[m.id] = { t: (ct - t0) / 1000, trap: m.trap ? trap : null }; });
      });
    }
    runPrev = b;
  }

  /* ---- segment crossings (constant-acceleration model) ----
     Within one ~1 Hz segment the car is modelled as accelerating uniformly from
     a.speed to b.speed. Under that model:
       v(τ) = v0 + aτ            ⇒ speed crossings are LINEAR IN TIME
       d(τ) = d0 + v0τ + ½aτ²    ⇒ distance crossings are QUADRATIC
     So a speed target (0–60) interpolates linearly, but a distance target
     (60 ft, ⅛, ¼ mile) must solve the quadratic. Interpolating distance linearly
     — as this used to — assumes constant speed across the segment and lands the
     crossing late while accelerating: at a 12 s quarter it biased the time by
     tens of milliseconds and the trap speed by ~1 mph. The trap speed is then
     read at the SOLVED time, which is exact under this model. */
  function crossAccel(target, a, b, hit) {
    if (a.speed < target && b.speed >= target) {
      var f = (target - a.speed) / (b.speed - a.speed);
      hit(a.t + f * (b.t - a.t));
    }
  }
  function crossDist(target, a, b, hit) {
    if (!(a.dist < target && b.dist >= target)) return;
    var dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) { hit(b.t, b.speed); return; }
    var v0 = a.speed, accel = (b.speed - v0) / dt, D = target - a.dist, tau;
    if (Math.abs(accel) < 1e-6) {
      tau = v0 > 1e-6 ? D / v0 : dt;                 // steady speed → linear
    } else {
      // ½aτ² + v0τ − D = 0, positive root. The discriminant cannot go negative
      // for a target that lies inside this segment (it bottoms out at v1²).
      var disc = Math.max(0, v0 * v0 + 2 * accel * D);
      tau = (Math.sqrt(disc) - v0) / accel;
    }
    tau = U.clamp(tau, 0, dt);
    hit(a.t + tau * 1000, v0 + accel * tau);
  }

  function finish(time, trap) {
    phase = 'done';
    result = {
      modeId: mode.id, label: mode.label, time: time, trap: trap,
      splits: splits, when: Date.now(), pb: isBest(mode.id, time)
    };
    pushHist(result);
    renderResult(); renderHistory();
    if (A.ui && A.ui.toast) A.ui.toast(mode.label + ' · ' + time.toFixed(2) + 's' + (result.pb ? '. Personal best!' : ''), 'success');
    // Sync the PB to the server (signed-in riders only) so it shows on profiles
    // and race results. Fire-and-forget — localStorage history is already the
    // source of truth locally; this makes it shared. The server only persists
    // when it actually beats the stored time, so retries are safe.
    if (result.pb && A.auth && A.auth.isLoggedIn()) uploadPB(mode.id, time, trap);
    renderTimes();
  }

  // The server answers with perf:stats { id:'self', stats } (adopted below), so
  // the profile overlay reflects the authoritative view without waiting for a
  // perf:dragy:pb fan-out to ourselves.
  function uploadPB(modeId, time, trap) {
    if (!A.net || !A.net.isLive() || !P.held()) return;
    A.net.send({ t: 'perf:dragy:pb', modeId: modeId, time: time, trap: trap != null ? trap : null });
  }

  function resetArm() {
    phase = 'arm'; staged = false; runPrev = null; runDist = 0; stoppedSince = 0; splits = {}; result = null;
    launchAt = 0; launchDist = 0;
    // Drop any raw sample carried over from a prior session: `prev` is only updated
    // inside onFix (which no-ops while the overlay is closed), so without this a
    // rolling-start launch on the first fix after (re)open would back-date t0
    // against a prev.t from minutes/hours ago — the timer would jump straight to a
    // huge bogus elapsed time. With prev cleared the meter takes one fresh fix to
    // re-baseline before it can launch (the `prev &&` guards below handle the rest).
    prev = null;
    if (els.result) els.result.hidden = true;
  }

  /* =================== history (localStorage) =================== */
  var HKEY = 'convoy.dragy.v1';
  function loadHist() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
  function saveHist(a) { try { localStorage.setItem(HKEY, JSON.stringify(a.slice(0, 60))); } catch (e) {} }
  function isBest(id, time) {
    var h = loadHist();
    for (var i = 0; i < h.length; i++) if (h[i].modeId === id && h[i].time <= time) return false;
    return true;
  }
  function pushHist(r) {
    var h = loadHist();
    h.unshift({ modeId: r.modeId, label: r.label, time: r.time, trap: r.trap, when: r.when });
    saveHist(h);
  }
  function bestMap(h) {
    var m = {};
    h.forEach(function (r) { if (m[r.modeId] == null || r.time < m[r.modeId]) m[r.modeId] = r.time; });
    return m;
  }

  /* =================== overlay UI =================== */
  var overlay = null, els = {}, raf = 0, lastFocus = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = U.el('div', 'modal-backdrop');
    overlay.id = 'dragy';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Performance meter');
    overlay.innerHTML =
      '<div class="dragy-modal" role="document">' +
      '  <header class="dragy-head">' +
      '    <div><h2>Performance</h2><span class="dragy-sub" id="dragy-sub">GPS drag timer</span></div>' +
      '    <button type="button" class="icon-btn" id="dragy-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '  </header>' +
      '  <div class="dragy-modes" id="dragy-modes" role="tablist" aria-label="Measurement"></div>' +
      '  <div class="dragy-gauge">' +
      '    <div class="dragy-speed"><b id="dragy-speed">0</b><span id="dragy-speed-unit">MPH</span></div>' +
      '    <div class="dragy-timer" id="dragy-timer">0.00<small>s</small></div>' +
      '    <div class="dragy-prog"><i id="dragy-prog-fill"></i></div>' +
      '    <div class="dragy-status" id="dragy-status">Pick a target, then come to a stop to stage.</div>' +
      '  </div>' +
      '  <div class="dragy-result" id="dragy-result" hidden></div>' +
      '  <div class="dragy-foot">' +
      '    <button type="button" class="dragy-btn" id="dragy-reset">Re-arm</button>' +
      '    <span class="dragy-note">GPS timer · best under open sky · not a track substitute</span>' +
      '  </div>' +
      '  <div class="dragy-hist-wrap"><div class="dragy-hist-head"><span>History</span><button type="button" class="dragy-clear" id="dragy-clear">Clear</button></div>' +
      '    <div class="dragy-history" id="dragy-history"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);

    els.sub = overlay.querySelector('#dragy-sub');
    els.modes = overlay.querySelector('#dragy-modes');
    els.speed = overlay.querySelector('#dragy-speed');
    els.speedUnit = overlay.querySelector('#dragy-speed-unit');
    els.timer = overlay.querySelector('#dragy-timer');
    els.prog = overlay.querySelector('#dragy-prog-fill');
    els.status = overlay.querySelector('#dragy-status');
    els.result = overlay.querySelector('#dragy-result');
    els.history = overlay.querySelector('#dragy-history');

    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    overlay.querySelector('#dragy-close').addEventListener('click', close);
    overlay.querySelector('#dragy-reset').addEventListener('click', function () { resetArm(); paint(); });
    overlay.querySelector('#dragy-clear').addEventListener('click', function () { saveHist([]); renderHistory(); renderTimes(); });
    return overlay;
  }

  function renderModes() {
    if (!els.modes) return;
    els.modes.innerHTML = MODES.map(function (m) {
      return '<button type="button" class="dragy-mode' + (mode && m.id === mode.id ? ' active' : '') +
        '" role="tab" data-id="' + m.id + '" aria-selected="' + (mode && m.id === mode.id) + '">' + U.esc(m.label) + '</button>';
    }).join('');
    Array.prototype.forEach.call(els.modes.querySelectorAll('.dragy-mode'), function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-id')); });
    });
  }

  function setMode(id) {
    mode = modeById(id);
    resetArm();
    renderModes();
    paint();
  }

  function statusText() {
    if (Date.now() - lastFixAt > 4000) return 'Waiting for a GPS fix… tap the locate control (⌖).';
    if (phase === 'done' && result) return result.label + ' complete. Re-arm for another run.';
    if (phase === 'run') return 'Running… ' + (mode.type === 'dist'
      ? U.fmtDist(runDist, S.settings.units) + ' / ' + U.fmtDist(mode.meters, S.settings.units)
      : 'go!');
    if (mode.from > 0) return 'Rolling start. Dip below ' + Math.round(spVal(mode.from)) + ' ' + spUnitLo() + ', then floor it through it.';
    if (!staged) return 'Come to a complete stop to stage.';
    return 'Staged. Floor it when ready.';
  }

  function progress() {
    if (mode.type === 'accel') {
      var v = (phase === 'done') ? mode.to : liveSpeed;
      return U.clamp((v - mode.from) / (mode.to - mode.from), 0, 1);
    }
    var d = (phase === 'done') ? mode.meters : runDist;
    return U.clamp(d / mode.meters, 0, 1);
  }

  function timerText() {
    if (phase === 'run') return ((Date.now() - t0) / 1000).toFixed(2);
    if (phase === 'done' && result) return result.time.toFixed(2);
    return '0.00';
  }

  // rAF tick: cheap text/width updates while the overlay is open.
  function paint() {
    if (!shown || !els.speed) return;
    var stale = Date.now() - lastFixAt > 4000;
    els.speed.textContent = stale ? '––' : Math.round(spVal(liveSpeed));
    els.speedUnit.textContent = spUnit();
    els.timer.innerHTML = timerText() + '<small>s</small>';
    els.prog.style.transform = 'scaleX(' + progress().toFixed(3) + ')';
    els.status.textContent = statusText();
    overlay.classList.toggle('is-run', phase === 'run');
    overlay.classList.toggle('is-done', phase === 'done');
  }

  function renderResult() {
    if (!els.result) return;
    if (!result) { els.result.hidden = true; return; }
    var r = result;
    var trapLine = r.trap != null
      ? '<div class="dragy-trap">trap ' + Math.round(spVal(r.trap)) + ' ' + spUnitLo() + '</div>' : '';
    var rows = SPLITS.map(function (m) {
      if (m.id === r.modeId) return '';            // the selected target is already the headline
      var s = r.splits[m.id]; if (!s) return '';
      var trap = (s.trap != null) ? '<i>@ ' + Math.round(spVal(s.trap)) + ' ' + spUnitLo() + '</i>' : '';
      return '<div class="dragy-split"><span>' + U.esc(m.label) + '</span><b>' + s.t.toFixed(2) + 's</b>' + trap + '</div>';
    }).join('');
    els.result.innerHTML =
      '<div class="dragy-headline' + (r.pb ? ' pb' : '') + '">' +
      '  <b>' + r.time.toFixed(2) + '<small>s</small></b>' +
      '  <span>' + U.esc(r.label) + (r.pb ? ' <em class="dragy-pb">PB</em>' : '') + '</span>' + trapLine +
      '</div>' +
      (rows ? '<div class="dragy-splits">' + rows + '</div>' : '') +
      '<button type="button" class="dragy-btn dragy-again" id="dragy-again">Run again</button>';
    els.result.hidden = false;
    var again = els.result.querySelector('#dragy-again');
    if (again) again.addEventListener('click', function () { resetArm(); paint(); });
  }

  function renderHistory() {
    if (!els.history) return;
    var h = loadHist();
    if (!h.length) { els.history.innerHTML = '<div class="dragy-empty">No runs yet. Your times will show up here.</div>'; return; }
    var best = bestMap(h);
    els.history.innerHTML = h.slice(0, 14).map(function (r) {
      var pb = r.time === best[r.modeId] ? '<em class="dragy-pb">PB</em>' : '';
      var trap = (r.trap != null) ? ' · ' + Math.round(spVal(r.trap)) + ' ' + spUnitLo() : '';
      return '<div class="dragy-run"><span class="dragy-run-l">' + U.esc(r.label) + ' ' + pb + '</span>' +
        '<span class="dragy-run-t">' + r.time.toFixed(2) + 's<small>' + trap + '</small></span>' +
        '<span class="dragy-run-w">' + U.fmtClock(new Date(r.when)) + '</span></div>';
    }).join('');
  }

  // Nudge sim.js's geolocation watch awake if no fix has arrived recently.
  function ensureGps() {
    if (Date.now() - lastFixAt < 4000) return;
    var b = document.getElementById('ctl-locate');
    if (b) b.click();
  }

  function loop() { paint(); if (shown) raf = requestAnimationFrame(loop); }

  function open() {
    if (!P.held()) return;                       // the grant is gone: nothing to show
    ensureOverlay();
    if (!mode) mode = modeById(km() ? '0-100k' : '0-60');
    lastFocus = document.activeElement;
    closeSeq++;                       // cancel any close still pending from a previous close()
    overlay.hidden = false;
    requestAnimationFrame(function () { if (overlay && !overlay.hidden) overlay.classList.add('show'); });
    resetArm();
    renderModes(); renderResult(); renderHistory();
    shown = true;
    ensureGps();
    var closeBtn = overlay.querySelector('#dragy-close'); if (closeBtn) closeBtn.focus();
    if (!raf) loop();
  }

  var closeSeq = 0;   // close→reopen inside 200ms used to let the stale hide-timer win: overlay invisible while `shown` stays true and GPS keeps feeding the meter
  function close() {
    if (!overlay) return;
    shown = false; phase = 'idle';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    overlay.classList.remove('show');
    var n = ++closeSeq;
    setTimeout(function () { if (n === closeSeq) overlay.hidden = true; }, 200);
    if (lastFocus) { try { lastFocus.focus(); } catch (e) {} lastFocus = null; }
  }
  function isOpen() { return !!(overlay && !overlay.hidden); }

  /* =================== profile: bests / fastest times (the old js/ui.js hunks) =================== */
  // Dragy personal-bests section. stats = { pb: { modeId: {time, trap, when} }, runs, wins }.
  // Falls back to the local localStorage history for the player's own profile so a
  // guest (no server stats) still sees their times.
  function bestsFromStats(stats, isSelf) {
    var pb = (stats && stats.pb) || {};
    var rows = [];
    for (var modeId in pb) {
      if (!pb.hasOwnProperty(modeId)) continue;
      var r = pb[modeId];
      if (!r || typeof r.time !== 'number') continue;
      rows.push({ modeId: modeId, time: r.time, trap: r.trap, when: r.when });
    }
    if (isSelf) {
      // Merge localStorage history (the full local log) so guests + unsynced runs show.
      var seen = {};
      rows.forEach(function (x) { seen[x.modeId] = 1; });
      var hist = loadHist();
      var best = {};
      hist.forEach(function (h) { if (!best[h.modeId] || h.time < best[h.modeId].time) best[h.modeId] = h; });
      for (var mid in best) {
        if (!best.hasOwnProperty(mid) || seen[mid]) continue;
        rows.push({ modeId: mid, time: best[mid].time, trap: best[mid].trap, when: best[mid].when, local: true });
      }
    }
    // Display order matches the dragy preset order; unknown ids sort last.
    var order = MODES.map(function (m) { return m.id; });
    rows.sort(function (a, b) {
      var ai = order.indexOf(a.modeId), bi = order.indexOf(b.modeId);
      if (ai < 0) ai = 99; if (bi < 0) bi = 99;
      return ai - bi;
    });
    return rows;
  }

  function pbRowsHtml(rows) {
    if (!rows.length) return '<div class="pf-empty">No timed runs yet</div>';
    var isKm = S.settings.units === 'km';
    return '<div class="pf-pb-table">' + rows.map(function (r) {
      var label = modeById(r.modeId).id === r.modeId ? modeById(r.modeId).label : r.modeId;
      var trapLine = (r.trap != null)
        ? '<i>trap ' + Math.round(r.trap * (isKm ? 3.6 : 2.23694)) + ' ' + (isKm ? 'km/h' : 'mph') + '</i>' : '';
      return '<div class="pf-pb-row">' +
        '<span class="pf-pb-mode">' + U.esc(label) + '</span>' +
        '<b class="pf-pb-time">' + r.time.toFixed(2) + 's</b>' + trapLine +
        '</div>';
    }).join('') + '</div>';
  }

  // Own-profile tally: runs/wins from the server when synced, topped up with
  // the local run log so guests see their numbers too.
  function selfTally() {
    var stats = P.getStats('self') || {};
    return { runs: Math.max(stats.runs || 0, loadHist().length), wins: stats.wins || 0 };
  }

  // "Fastest times" on the profile page (hook 'profile', after Awards).
  function renderTimes() {
    var el = document.getElementById('pf-times');
    if (!el) return;
    var t = selfTally();
    el.innerHTML = '<div class="pf-times-tally"><span><b>' + t.runs + '</b> runs</span><span><b>' + t.wins + '</b> wins</span></div>' +
      pbRowsHtml(bestsFromStats(P.getStats('self'), true));
  }
  if (A.ui && A.ui.addHook) A.ui.addHook('profile', function (body) {
    if (!P.held()) return;
    body.appendChild(U.el('div', 'section-label', 'Fastest times'));
    var times = U.el('div', 'pf-times');
    times.id = 'pf-times';
    body.appendChild(times);
    renderTimes();
  });

  // Stats strip + "Best dragy times" on the public-profile overlay (hook
  // 'profile-overlay'). The hook runs before the action row is appended, so
  // the sections are slotted in ahead of the "Car" label, where they sat.
  function overlayBests(card, subject) {
    var stats = P.getStats(subject.self ? 'self' : subject.id);
    var rows = bestsFromStats(stats, subject.self);
    var wins = (stats && stats.wins) || 0;
    var runs = (stats && stats.runs) || 0;
    var strip = card.querySelector('.pf-po-strip');
    var cells = '<span class="pf-po-stat perf-po-stat"><b>' + rows.length + '</b>bests</span>' +
      '<span class="pf-po-stat perf-po-stat"><b>' + runs + '</b>races</span>' +
      '<span class="pf-po-stat perf-po-stat"><b>' + wins + '</b>wins</span>';
    if (strip) {
      Array.prototype.forEach.call(strip.querySelectorAll('.perf-po-stat'), function (n) { strip.removeChild(n); });
      strip.insertAdjacentHTML('afterbegin', cells);
    } else {
      strip = U.el('div', 'pf-po-strip', cells);
      strip.setAttribute('data-perf', '1');
    }
    var label = card.querySelector('.section-label.perf-bests-label');
    var bests = card.querySelector('.pf-po-bests');
    if (bests) { bests.innerHTML = pbRowsHtml(rows); return; }
    label = U.el('div', 'section-label perf-bests-label', 'Best dragy times');
    bests = U.el('div', 'pf-po-bests', pbRowsHtml(rows));
    // Before the first section label the core drew (the "Car" card).
    var anchor = card.querySelector('.section-label');
    if (!strip.parentNode) card.insertBefore(strip, anchor || null);
    card.insertBefore(label, anchor || null);
    card.insertBefore(bests, anchor || null);
  }
  var overlaySubject = null;   // the rider the open overlay is about, for perf:stats refreshes
  if (A.ui && A.ui.addHook) A.ui.addHook('profile-overlay', function (actions, subject, card) {
    if (!P.held() || !subject || !card) return;
    overlaySubject = subject;
    overlayBests(card, subject);
    // Nothing known for this rider yet: ask, the answer re-renders in place.
    if (!subject.self && !P.getStats(subject.id)) P.requestStats(subject.id);
  });
  // A PB landed (ours or a rider's we are looking at): refresh what is on screen.
  ST.on('perf:stats', function (e) {
    renderTimes();
    if (!e || !overlaySubject) return;
    var root = document.getElementById('onboarding');
    var card = root && !root.hidden ? root.querySelector('.profile-overlay') : null;
    if (!card) { overlaySubject = null; return; }
    var want = overlaySubject.self ? 'self' : overlaySubject.id;
    if (e.id === want) overlayBests(card, overlaySubject);
  });

  /* =================== socket: stats in =================== */
  if (A.net && A.net.on) {
    // A rider set a new dragy PB (or the server answered perf:stats:get).
    A.net.on('perf:dragy:pb', function (m) { if (m && typeof m.id === 'string') P.remoteStats(m.id, m.stats); });
    A.net.on('perf:stats', function (m) {
      if (!m) return;
      if (m.id === 'self') P.adoptStats(m.stats);
      else if (typeof m.id === 'string') P.remoteStats(m.id, m.stats);
    });
  }

  /* =================== the chip, the setting, the stand-down =================== */
  function chipEl() { return document.getElementById('chip-dragy'); }
  function syncChip() {
    var chip = chipEl(); if (!chip) return;
    chip.hidden = !P.active();
  }
  // Gated the first time: a GPS drag timer on a public road is street racing,
  // and "track and private land only" has to be said where someone taps the
  // button, not only in §5 of the Terms.
  function onChipTap() {
    if (!P.active()) return;
    P.gate(open);
  }
  function setEnabled(on) {
    if (!!S.settings.perfEnabled !== !!on) ST.setSetting('perfEnabled', !!on);
    else syncChip();
    if (!on) close();
  }
  function standDown() {
    close();
    syncChip();
  }

  // Settings → "Performance timers": the regulated switch, through the notice,
  // and the quest card toggle the old Instruments section carried.
  if (A.ui && A.ui.addHook) A.ui.addHook('settings', function (body, kit) {
    if (!P.held()) return;
    body.appendChild(U.el('div', 'section-label', 'Performance timers'));
    var toggle = kit.toggle(P.enabled(), function (on) {
      if (!on) { setEnabled(false); return; }
      P.gate(function () { setEnabled(true); }, function () {
        // Refused: put the control back (mkToggle flipped itself on click).
        toggle.classList.remove('on');
        toggle.setAttribute('aria-checked', 'false');
      });
    });
    body.appendChild(kit.row('Performance timers', 'The 0–60 chip, side-by-side races with nearby riders and the top-speed quest', toggle));
    body.appendChild(kit.row('Top speed quest', 'All-time top speed & fastest 60–100 records',
      kit.toggle(S.settings.showQuest !== false, function (v) { ST.setSetting('showQuest', v); })));
    body.appendChild(U.el('div', 'perf-note',
      'GPS timing for a closed course, private land or a licensed track — the notice says so when you switch it on. ' +
      'Phone GPS is ~1 Hz: treat every time as ballpark.'));
  });

  ST.on('setting', function (e) {
    if (!e || e.key !== 'perfEnabled') return;
    syncChip();
    if (!e.val) close();
  });
  ST.on('packs', function () {
    if (!P.held()) standDown(); else syncChip();
  });
  ST.on('gpsfix', onFix);

  var chipWired = false;
  function init() {
    var chip = chipEl();
    if (chip && !chipWired) { chipWired = true; chip.addEventListener('click', onChipTap); }
    syncChip();
  }

  A.dragy = {
    open: open, close: close, setMode: setMode, isOpen: isOpen, setEnabled: setEnabled,
    modes: function () { return MODES.slice(); },
    // Human label for a mode id (e.g. '0-60' -> '0–60 mph'). Falls back to the id.
    modeLabel: function (id) { var m = modeById(id); return m && m.id === id ? m.label : id; },
    // mode object by id (shared by the race system to build a RaceTimer instance).
    modeById: modeById,
    bestsFromStats: bestsFromStats, pbRowsHtml: pbRowsHtml, renderTimes: renderTimes,
    // test/inspection helpers (used to verify the timing core without real GPS)
    _feed: onFix,
    _state: function () { return { phase: phase, staged: staged, runDist: runDist, result: result, splits: splits }; },
    _init: init, _standDown: standDown
  };
  // Publish the preset table + lookup on the shared racetimer module so the race
  // system can build per-racer RaceTimer instances against the SAME modes dragy uses.
  if (A.racetimer) { A.racetimer.PRESETS = MODES; A.racetimer.modeById = modeById; }
})();
