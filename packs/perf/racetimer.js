/* Convoy — Performance timers pack: the reusable GPS drag-timing core
   (packs/perf/racetimer.js).

   The js/racetimer.js module as it was before the 2026-10-04 store cut
   (git show a1de6fd:js/racetimer.js), re-homed as the FIRST script of the
   "perf" feature pack: served by the Convoy server only to an account that
   redeemed a code, never shipped in the binary (packs/README.md). The SAME
   timing math backs the solo dragy meter (dragy.js), per-racer side-by-side
   racing (race.js) and the always-armed 60–100 quest timer (quest.js). Each
   instance owns its own launch state (prev / runPrev / t0 / runDist / splits),
   so you can time N riders in parallel — the local player fed by the device's
   own GPS, and remote racers fed by streamed fixes over the network.

   Being first, this file also carries what the whole pack needs before any
   other module reads it:
     - js/state.js   → ST.registerSettings({ perfEnabled, showQuest })
     - js/ui.js      → the FEATURE_NOTICES.perf text, registered under the key
                       'race' (pack.json "legal"), and the gate every timer
                       goes through before it arms
     - js/sim.js     → the per-rider stats map that remoteStats / getStats /
                       adoptStats used to keep on the NPC records, now A.perf
                       (fed by the pack's own perf:stats / perf:dragy:pb
                       socket messages and GET /api/perf/dragy/pb)

   REGULATED. A timed run on a public road is street racing, so every timer
   defaults OFF: perfEnabled is false until the rider switches the pack on in
   Settings → Performance timers, and that switch, the chip tap, a race
   challenge and the quest all go through A.ui.legalGate('race', …) with the
   notice below. When the account stops holding the pack (the 'packs' event,
   A.packs.has('perf') false) every module stands its UI down.

   Lifecycle of one timer:
     var t = A.racetimer.make(mode, callbacks);
     t.resetArm();
     t.feed({ pos:[lng,lat], speed:m/s|null, t:epochMs });   // each GPS fix
     // ...t.state().phase transitions 'arm' → 'run' → 'done'
     t.state().result   // { modeId, label, time, trap, splits, when }
   callbacks = { onLaunch, onFinish, onProgress, onAbort } — all optional. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, ST = A.store, S = A.state;

  var PACK = 'perf';          // A.packs id
  var LEGAL_KEY = 'race';     // pack.json "legal" — was 'perf' in the core's FEATURE_NOTICES

  /* ---------------- settings (registered before anything reads them) ----------------
     perfEnabled — the regulated master switch; OFF until the rider turns it on
                   through the legality notice. Shows the 0–60 chip, allows
                   race challenges and arms the quest.
     showQuest   — the Top Speed Quest card (true, as the old build's default;
                   it does nothing while perfEnabled is off). */
  ST.registerSettings({ perfEnabled: false, showQuest: true });

  /* ---------------- the legality notice (the core's old FEATURE_NOTICES.perf, verbatim) ---------------- */
  if (A.ui && A.ui.registerFeatureNotice) A.ui.registerFeatureNotice(LEGAL_KEY, {
    title: 'Track and private land only',
    lede: 'The performance meter and race timer measure acceleration from GPS.',
    points: [
      '<b>These are for a closed course, private land, or a licensed track</b> — with the ' +
        'operator\'s or landowner\'s permission.',
      'Using them on a public road is street racing. It is illegal everywhere, it is the ' +
        'fastest way to lose a licence and a car, and it is a breach of the Terms.',
      'Timing runs is a passenger\'s job. The driver drives.'
    ]
  });
  function gate(proceed, cancel) {
    if (A.ui && A.ui.legalGate) A.ui.legalGate(LEGAL_KEY, proceed, cancel);
    else proceed();
  }
  function held() { return !!(A.packs && A.packs.has(PACK)); }
  function enabled() { return !!S.settings.perfEnabled; }
  // Both: the pack is granted AND the rider switched it on.
  function active() { return held() && enabled(); }

  /* ---------------- per-rider stats (what js/sim.js used to keep) ----------------
     stats = { pb: { modeId: { time, trap, when } }, runs, wins }. 'self' is the
     local player's own slot (null for guests); every other key is a rider id
     the server told us about. Emits ST 'perf:stats' { id, stats } on change so
     the profile page / overlay refresh, exactly as the old 'stats' event did. */
  var statsMap = {};
  var STATS_MAX = 400;    // riders we remember stats for (pruned oldest-first)
  var statsOrder = [];
  function cleanStats(s) {
    if (!s || typeof s !== 'object') return null;
    var out = { pb: {}, runs: Number(s.runs) > 0 ? Math.floor(Number(s.runs)) : 0, wins: Number(s.wins) > 0 ? Math.floor(Number(s.wins)) : 0 };
    var pb = s.pb && typeof s.pb === 'object' ? s.pb : {};
    for (var k in pb) {
      if (!Object.prototype.hasOwnProperty.call(pb, k) || !pb[k]) continue;
      var t = Number(pb[k].time);
      if (!isFinite(t) || t <= 0) continue;
      var trap = pb[k].trap == null ? null : Number(pb[k].trap);
      out.pb[String(k).slice(0, 16)] = { time: t, trap: isFinite(trap) ? trap : null, when: Number(pb[k].when) || 0 };
    }
    return out;
  }
  function getStats(id) {
    if (id == null) id = 'self';
    return Object.prototype.hasOwnProperty.call(statsMap, id) ? statsMap[id] : null;
  }
  function setStats(id, stats) {
    var clean = cleanStats(stats);
    if (clean) {
      if (!Object.prototype.hasOwnProperty.call(statsMap, id)) {
        statsOrder.push(id);
        while (statsOrder.length > STATS_MAX) {
          var old = statsOrder.shift();
          if (old !== 'self') delete statsMap[old];
        }
      }
      statsMap[id] = clean;
    } else {
      delete statsMap[id];
      var i = statsOrder.indexOf(id); if (i >= 0) statsOrder.splice(i, 1);
    }
    ST.emit('perf:stats', { id: id, stats: clean });
  }
  // Authoritative stats for the local player (from GET /api/perf/dragy/pb or
  // the server's perf:stats echo after a PB) — the old A.sim.adoptStats.
  function adoptStats(stats) { setStats('self', stats); }
  // Stats arrived over the wire for another rider — the old A.sim.remoteStats.
  function remoteStats(id, stats) { if (typeof id === 'string' && id && id !== 'self') setStats(id, stats); }
  function clearStats() {
    statsMap = {}; statsOrder = [];
    ST.emit('perf:stats', { id: 'self', stats: null });
  }

  function token() { return S.auth && S.auth.token ? S.auth.token : null; }
  // Seed the local player's own stats from the server (signed-in riders only).
  // Resolves to the stats (or null); never rejects.
  var fetching = null;
  function fetchOwnStats() {
    if (!token() || !held()) return Promise.resolve(getStats('self'));
    if (fetching) return fetching;
    var base = (A.config && A.config.base) || '';
    fetching = U.fetchT(base + '/api/perf/dragy/pb', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { fetching = null; if (j && j.stats) adoptStats(j.stats); return getStats('self'); })
      .catch(function () { fetching = null; return getStats('self'); });
    return fetching;
  }
  // Ask the server for a rider's stats (when a profile opens on someone we
  // have nothing for). The answer lands as perf:stats { id, stats }.
  function requestStats(id) {
    if (!id || id === 'self' || !held() || !A.net || !A.net.isLive()) return;
    A.net.send({ t: 'perf:stats:get', id: String(id).slice(0, 40) });
  }
  ST.on('auth', function (a) { if (!a || !a.token) clearStats(); });

  A.perf = {
    PACK: PACK, LEGAL_KEY: LEGAL_KEY,
    gate: gate, held: held, enabled: enabled, active: active,
    getStats: getStats, adoptStats: adoptStats, remoteStats: remoteStats, clearStats: clearStats,
    fetchOwnStats: fetchOwnStats, requestStats: requestStats
  };

  /* ===================== the timing core ===================== */
  var STAGED = 0.7;     // below this = stationary (staged & ready)
  var LAUNCH = 1.3;     // crossing up through this = launch detected (standing starts)
  var EPS = 0.3;        // ~first-movement speed used to back-date t0
  var ABORT_MS = 1400;  // rolling to a stop this long mid-run aborts the run

  function make(mode, callbacks) {
    if (!mode) throw new Error('racetimer: mode required');
    callbacks = callbacks || {};

    var phase = 'idle';     // idle | arm | run | done
    var staged = false;
    var prev = null;        // last raw fix {t, speed, pos}
    var runPrev = null;     // last processed run sample {t, speed, dist}
    var t0 = 0;             // launch time (epoch ms)
    var runDist = 0;        // metres travelled since launch
    var liveSpeed = 0;      // current speed, m/s
    var splits = {};        // id -> {t, trap?}
    var result = null;      // finished run
    var lastFixAt = 0;      // wall-clock of last accepted fix
    var stoppedSince = 0;   // when the car first dropped to a stop mid-run

    function speedOf(f) {
      if (f.speed != null && f.speed >= 0) return f.speed;
      if (!prev) return 0;
      var dt = (f.t - prev.t) / 1000;
      return dt > 0 ? U.haversine(prev.pos, f.pos) / dt : prev.speed;
    }

    // Distance covered over one segment. Trapezoidal integration of speed —
    // EXACT under the constant acceleration each segment is modelled with, and
    // far steadier than summing GPS chord lengths (which under-read through
    // corners and inflate from position noise at low speed). This is what a real
    // Dragy box does: it integrates Doppler velocity, it does not add up fixes.
    // Distance, crossing time and trap speed then all come from one model, so
    // they can never disagree with each other.
    function segDist(v0, v1, dtSec) {
      return dtSec > 0 ? 0.5 * (v0 + v1) * dtSec : 0;
    }

    /* ---- launch back-dating (standing starts) ----
       t0 must be the instant the car FIRST CREPT ABOVE EPS, which happens well
       before speed reaches the LAUNCH threshold. Interpolating between the two
       fixes that bracket LAUNCH only coincides with that on a slow receiver: at
       1 Hz the car goes 0 → well past 1.3 m/s in a single segment, so both
       events sit in the same pair. At 10 Hz they don't — the previous fix is
       already above EPS, the interpolation factor comes out negative, clamps to
       0, and t0 lands on that fix instead of the real crossing. The timer
       therefore started late and reported times ~0.2 s OPTIMISTIC, and got worse
       the faster the GPS was. So watch for the EPS crossing as it happens and
       integrate distance from there. */
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
      // Never observed the sub-EPS side (the first fix of the session was
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
      if (callbacks.onLaunch) callbacks.onLaunch(state());
      processSegment(sp, t);   // first segment: launch sample -> this fix
    }

    function stepRun(pos, sp, t) {
      if (prev) runDist += segDist(prev.speed, sp, (t - prev.t) / 1000);
      processSegment(sp, t);
      if (phase !== 'run') return;
      var floor = mode.from > 0 ? mode.from * 0.7 : STAGED;   // lifted / rolled to a stop?
      if (sp < floor) {
        if (!stoppedSince) stoppedSince = t;
        else if (t - stoppedSince > ABORT_MS) {
          // Sustained stop mid-run → abort + re-arm (caller is told via onAbort).
          if (callbacks.onAbort) callbacks.onAbort(state());
          resetArm();
        }
      } else stoppedSince = 0;
    }

    // Process the segment runPrev -> {speed, dist} for the selected target.
    // Split milestones are NOT tracked here (the solo meter adds them; a race
    // only cares about the headline time + trap), keeping the race payload small.
    function processSegment(curSpeed, curT) {
      var a = runPrev, b = { t: curT, speed: curSpeed, dist: runDist };
      if (mode.type === 'accel') {
        crossAccel(mode.to, a, b, function (ct) { finish((ct - t0) / 1000, null); });
      } else {
        crossDist(mode.meters, a, b, function (ct, trap) { finish((ct - t0) / 1000, trap); });
      }
      runPrev = b;
      if (callbacks.onProgress && phase === 'run') callbacks.onProgress(state());
    }

    /* ---- segment crossings (constant-acceleration model) ----
       Within one ~1 Hz segment the car is modelled as accelerating uniformly
       from a.speed to b.speed. Under that model:
         v(τ) = v0 + aτ                       ⇒ speed crossings are LINEAR IN TIME
         d(τ) = d0 + v0τ + ½aτ²               ⇒ distance crossings are QUADRATIC
       So a speed target (0–60) interpolates linearly, but a distance target
       (60 ft, ⅛, ¼ mile) must solve the quadratic. Interpolating distance
       linearly — as this used to — assumes constant speed across the segment
       and lands the crossing late during acceleration: at a 12 s quarter it
       biased the time by tens of milliseconds and the trap speed by ~1 mph.
       The trap speed is then read at the SOLVED time, which is exact here. */
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
        // ½aτ² + v0τ − D = 0, positive root. The discriminant cannot go
        // negative for a target inside this segment (it bottoms out at v1²).
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
        splits: splits, when: Date.now()
      };
      if (callbacks.onFinish) callbacks.onFinish(result, state());
    }

    function resetArm() {
      phase = 'arm'; staged = false; runPrev = null; runDist = 0; stoppedSince = 0;
      splits = {}; result = null;
      launchAt = 0; launchDist = 0;
      // Drop any raw sample carried over from a prior run: prev is only updated
      // inside feed(), so without this a rolling-start launch on the first fix
      // after re-arm would back-date t0 against a prev.t from minutes ago.
      prev = null;
    }

    // Public state snapshot (liveSpeed/phase/etc read by the race HUD each frame).
    function state() {
      return {
        phase: phase, staged: staged, runDist: runDist, result: result,
        splits: splits, liveSpeed: liveSpeed, t0: t0,
        progress: progress()
      };
    }
    // 0..1 fraction toward the target — drives the HUD's progress bar.
    function progress() {
      if (phase === 'done') return 1;
      if (phase !== 'run') return 0;
      if (mode.type === 'accel') {
        return U.clamp((liveSpeed - mode.from) / (mode.to - mode.from), 0, 1);
      }
      return U.clamp(runDist / mode.meters, 0, 1);
    }

    // Feed one GPS fix. { pos:[lng,lat], speed:m/s|null, t:epochMs }. No-op unless armed.
    function feed(f) {
      if (!f || !f.pos) return;
      if (phase === 'idle' || phase === 'done') return;
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

    function idle() { phase = 'idle'; }
    function lastFixAge() { return lastFixAt ? Date.now() - lastFixAt : Infinity; }

    return {
      feed: feed,
      resetArm: resetArm,
      idle: idle,
      state: state,
      lastFixAge: lastFixAge,
      mode: function () { return mode; }
    };
  }

  A.racetimer = { make: make, PRESETS: null }; // PRESETS + modeById filled by dragy.js on load (mode table is there)
})();
