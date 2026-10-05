/* Convoy — Performance timers pack: Top Speed Quest (packs/perf/quest.js).

   The js/quest.js module as it was before the 2026-10-04 store cut
   (git show a1de6fd:js/quest.js), re-homed as the LAST script of the "perf"
   feature pack — so it is also where A.packs.register('perf', { init })
   lives: the loader runs that init once every script of the pack has run,
   and it wires the chip, seeds the rider's own stats and arms the quest.

   An always-on record chase: tracks your all-time TOP SPEED and your fastest
   60–100 mph pull, straight from the same GPS fixes the rest of the app uses.
   Records persist in localStorage and survive sessions — beat one and the HUD
   card flashes + a toast celebrates the new record.

   - Top speed: every sane fix is a candidate. Fixes are plausibility-filtered
     (finite, < 335 mph, and the implied acceleration from the previous accepted
     fix must be physically possible) so a GPS glitch can't fake a record.
   - 60–100 mph: a permanently-armed rolling-start timer built on the SAME
     timing core as the dragy meter (racetimer.js) — dip below 60, floor it
     through 100 and the pull is timed with interpolated crossings. It re-arms
     itself after every run, so the quest is always live, no overlay needed.

   What changed against the old build: the card sat on the instrument HUD
   rail (A.hud.card), which is no longer in the core, so the card is the
   #hud-quest fragment (hud.html) and positions itself (perf.css). And because
   a 60–100 pull is a timed run, the quest is "always on" only while the
   regulated switch is: it arms when Settings → Performance timers is on (that
   switch went through the legality notice) and the account holds the pack,
   and idles otherwise. settings.showQuest shows/hides the card as before. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store, P = A.perf;

  var MS_TO_MPH = 2.2369362921, MS_TO_KMH = 3.6;
  var MPH = 1 / MS_TO_MPH; // mph -> m/s

  var MAX_SANE_MS = 150;   // ~335 mph — beyond this the fix is garbage
  var MAX_ACCEL = 15;      // m/s² (~1.5g) — max believable gain between fixes

  /* ---------- persisted records ---------- */
  var KEY = 'convoy.quest.v1';
  var rec = { topMs: 0, topWhen: 0, t60100: null, t60100When: 0 };
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && typeof raw === 'object') {
        if (typeof raw.topMs === 'number' && isFinite(raw.topMs) && raw.topMs >= 0 && raw.topMs < MAX_SANE_MS) {
          rec.topMs = raw.topMs; rec.topWhen = raw.topWhen || 0;
        }
        if (typeof raw.t60100 === 'number' && isFinite(raw.t60100) && raw.t60100 > 0) {
          rec.t60100 = raw.t60100; rec.t60100When = raw.t60100When || 0;
        }
      }
    } catch (e) { /* fresh quest */ }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) {} }

  /* ---------- unit helpers ---------- */
  function km() { return S.settings.units === 'km'; }
  function spTxt(ms) { return Math.round(ms * (km() ? MS_TO_KMH : MS_TO_MPH)); }
  function spUnit() { return km() ? 'km/h' : 'mph'; }

  /* ---------- HUD card (the #hud-quest fragment) ---------- */
  var box = null, elV = null, elL = null, elS = null;
  function build() {
    box = document.getElementById('hud-quest');
    if (!box) return;
    elV = box.querySelector('#qs-v');
    elL = box.querySelector('#qs-l');
    elS = box.querySelector('#qs-s');
    sync();
  }

  function render() {
    if (!elV) return;
    elV.textContent = rec.topMs > 0 ? String(spTxt(rec.topMs)) : '—';
    elL.textContent = 'top ' + spUnit();
    var running = timer && timer.state().phase === 'run';
    elS.textContent = running
      ? '60–100: GO!'
      : '60–100: ' + (rec.t60100 != null ? rec.t60100.toFixed(2) + 's' : '—');
  }

  // Brief celebratory flash on the card when a record lands.
  function flash() {
    if (!box) return;
    box.classList.remove('quest-flash');
    void box.offsetWidth; // restart the animation
    box.classList.add('quest-flash');
  }

  // The quest runs (card shown, timer armed) only while the regulated switch is
  // on, the account holds the pack and the card is wanted.
  function wanted() { return P.active() && S.settings.showQuest !== false; }
  function sync() {
    var on = wanted();
    if (box) box.hidden = !on;
    if (on) arm(); else disarm();
    render();
  }

  /* ---------- top speed tracking ---------- */
  var lastOk = null;      // last accepted sample {t, ms}
  var FRESH_MS = 4000;    // a record needs a corroborating fix within this window
  var lastTopToast = 0, TOP_TOAST_MS = 8000;   // the celebratory toast, at most once per 8 s of fixes
  function considerTop(ms, t) {
    if (ms == null || !isFinite(ms) || ms < 0 || ms > MAX_SANE_MS) return;
    // A record needs TWO mutually-consistent fixes close together: the jump from
    // the previous recent sample must be physically possible. A lone fix after a
    // gap only re-baselines — over a long gap ANY Δv looks like small Δv/Δt, so
    // without this a single GPS teleport-spike could fake a 300 mph record.
    var fresh = lastOk && t > lastOk.t && (t - lastOk.t) < FRESH_MS;
    if (fresh && Math.abs(ms - lastOk.ms) / ((t - lastOk.t) / 1000) > MAX_ACCEL) {
      return; // implausible jump — drop it, keep the trusted baseline
    }
    lastOk = { t: t, ms: ms };
    if (!fresh) return; // baseline only; the next consistent fix can score
    if (ms > rec.topMs + 0.05) {
      rec.topMs = ms; rec.topWhen = t;
      save(); render(); flash();
      // The card updates and flashes on every fix of a climbing record; the
      // toast says it once per pull (the old build toasted every fix, which
      // on a long run pushed every other toast — a race finish, say — off
      // the screen before it could be read).
      if (A.ui && A.ui.toast && t - lastTopToast > TOP_TOAST_MS) {
        lastTopToast = t;
        A.ui.toast('🏁 New top speed: ' + spTxt(ms) + ' ' + spUnit(), 'success');
      }
    }
  }

  /* ---------- 60–100 mph timer (armed while the quest runs) ---------- */
  var timer = null;
  function makeTimer() {
    if (!A.racetimer || !A.racetimer.make) return null;
    return A.racetimer.make(
      { id: '60-100', label: '60–100 mph', type: 'accel', from: 60 * MPH, to: 100 * MPH },
      {
        onProgress: render, // sub-line shows GO! while a pull is being timed
        onAbort: render,
        onFinish: function (result) {
          var t = result.time;
          if (t > 0 && (rec.t60100 == null || t < rec.t60100)) {
            rec.t60100 = t; rec.t60100When = Date.now();
            save(); flash();
            if (A.ui && A.ui.toast) A.ui.toast('🏁 Quest: fastest 60–100 · ' + t.toFixed(2) + 's', 'success');
          } else if (rec.t60100 != null && A.ui && A.ui.toast) {
            A.ui.toast('60–100 in ' + t.toFixed(2) + 's · best is ' + rec.t60100.toFixed(2) + 's', 'info');
          }
          // Immediately re-arm so the quest never sleeps (while it is on).
          if (wanted()) timer.resetArm(); else timer.idle();
          render();
        }
      });
  }
  function arm() {
    if (!timer) timer = makeTimer();
    if (timer && timer.state().phase === 'idle') timer.resetArm(); // arm once; it re-arms itself after every run
  }
  function disarm() {
    if (timer) timer.idle();
    lastOk = null;
  }

  /* ---------- wiring ---------- */
  var prevPos = null, prevT = 0;
  function onFix(f) {
    if (!f || !f.pos || !wanted()) return;
    var t = f.t || Date.now();
    // Speed: GPS Doppler when reported, else derive from the position delta
    // (same fallback the dragy meter uses on Doppler-less hardware).
    var ms = (f.speed != null && f.speed >= 0) ? f.speed : null;
    if (ms == null && prevPos && t > prevT) {
      var dt = (t - prevT) / 1000;
      if (dt > 0.15 && dt < 5) ms = U.haversine(prevPos, f.pos) / dt;
    }
    prevPos = f.pos.slice(); prevT = t;
    if (ms != null) considerTop(ms, t);
    if (timer) timer.feed({ pos: f.pos, speed: f.speed, t: t });
  }

  var inited = false;
  function init() {
    if (inited) { sync(); return; }
    inited = true;
    load();
    build();
    ST.on('gpsfix', onFix);
    ST.on('units', render);
    ST.on('setting', function (e) { if (e && (e.key === 'showQuest' || e.key === 'perfEnabled')) sync(); });
    ST.on('packs', sync);
  }

  A.quest = {
    init: init,
    records: function () { return { topMs: rec.topMs, topWhen: rec.topWhen, t60100: rec.t60100, t60100When: rec.t60100When }; },
    // Wipe the quest records (not exposed in the UI yet; console/debug hook).
    reset: function () { rec = { topMs: 0, topWhen: 0, t60100: null, t60100When: 0 }; lastOk = null; lastTopToast = 0; save(); render(); },
    // test surface
    _timer: function () { return timer; }, _sync: sync
  };

  /* ---------- the pack: one init, after every script has run ---------- */
  A.packs.register(P.PACK, {
    init: function () {
      try { if (A.dragy && A.dragy._init) A.dragy._init(); } catch (e) { console.error('[perf] dragy init', e); }
      try { if (A.race && A.race._init) A.race._init(); } catch (e) { console.error('[perf] race init', e); }
      try { init(); } catch (e) { console.error('[perf] quest init', e); }
      // The rider's own PBs / counters from the server, for the profile page.
      try { P.fetchOwnStats(); } catch (e) { /* offline: the local history still shows */ }
      ST.on('auth', function (a) { if (a && a.token) P.fetchOwnStats(); });
    }
  });
})();
