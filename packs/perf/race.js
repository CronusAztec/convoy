/* Convoy — Performance timers pack: side-by-side drag racing
   (packs/perf/race.js).

   The js/race.js module as it was before the 2026-10-04 store cut
   (git show a1de6fd:js/race.js), re-homed as a feature pack script.

   An open ad-hoc race lobby any nearby rider can join (NOT convoy-gated). The
   host picks a dragy preset (0-60, ¼ mile, …), everyone stages on real GPS, a
   server-driven 3-2-1-GO fires, and each racer's time is measured by a local
   RaceTimer instance (racetimer.js — same math as the solo dragy meter).
   Racers broadcast their GPS at ~10Hz during the run so everyone else's HUD
   shows live speed + progress, and report their finish time to the server; the
   server tallies results and credits wins/PBs to each rider's profile.

   UI surfaces:
     - Lobby overlay (#onboarding via A.ui.openOverlayRaw) — joiners, ready
       toggle, mode picker, host-only Start.
     - Live HUD (#race-hud, from hud.html) — per-racer speed + progress bars.
     - Results overlay — final leaderboard with times + PB badges.

   All network state is server-authoritative and proximity-scoped (the server
   refuses a join if the rider is outside NEARBY_KM of the host).

   What this file re-creates through the core's extension points, instead of
   the core hunks the cut removed:
     - js/net.js  → the race:state / race:invite / race:fix handlers and
                    sendRace(), via A.net.on / A.net.send. Every message type
                    is renamed 'perf:race:…' on both sides; the server's
                    'err' replies are 'perf:err'.
     - js/ui.js   → the "Challenge to race" button on the public-profile
                    action row (A.ui.addHook 'profile-overlay'), #race-hud
     - index.html → hud.html (#race-hud), mounted into <body> by the loader

   REGULATED: a challenge goes through A.ui.legalGate('race', …) and the
   button only shows while Settings → Performance timers is on. */
(function () {
  'use strict';
  var A = window.App;
  var U = A.util, S = A.state, ST = A.store, P = A.perf;

  var race = null;          // { id, modeId, host, status, startedAt, isHost, members[] } from server
  var timers = {};          // racerId -> RaceTimer instance (built on 'running')
  var fixListener = null;   // 'gpsfix' subscription (armed only while running)
  var fixSendTimer = null;  // ~10Hz perf:race:fix relay
  var hudRaf = null;        // HUD paint loop
  var lastHudAt = 0;        // last HUD repaint (throttled — see paintHud)
  var HUD_PAINT_MS = 100;   // 10 Hz: matches the race:fix relay rate
  var overlayCard = null;   // current overlay card (lobby or results)

  /* ---------------- mode table ---------------- */
  function modeById(id) {
    if (A.dragy && A.dragy.modeById) return A.dragy.modeById(id);
    if (A.racetimer && A.racetimer.modeById) return A.racetimer.modeById(id);
    return null;
  }
  function modeLabel(id) { return A.dragy ? A.dragy.modeLabel(id) : id; }
  function km() { return S.settings.units === 'km'; }
  function spVal(ms) { return ms * (km() ? 3.6 : 2.23694); }
  function spUnitLo() { return km() ? 'km/h' : 'mph'; }
  function myId() { return A.net && A.net.myId ? A.net.myId() : null; }
  function live() { return !!(A.net && A.net.isLive && A.net.isLive()); }
  function toast(msg, kind) { if (A.ui && A.ui.toast) A.ui.toast(msg, kind); }
  // Every outbound race frame. The old sendRace() queued control frames behind
  // a reconnect and sent fixes raw; the core no longer exposes its queue, so a
  // frame sent while the socket is down is dropped and the caller toasts.
  function wire(msg) {
    if (!msg || typeof msg.t !== 'string' || !A.net || !A.net.send) return false;
    if (!P.held()) return false;
    A.net.send(msg);
    return true;
  }

  /* ===================== public API ===================== */
  // Create a new race (you become host). Returns true on send.
  function create(modeId) {
    if (!P.active()) { toast('Switch on Performance timers in Settings first', 'warn'); return false; }
    if (!live()) { toast('Racing needs a live connection', 'warn'); return false; }
    if (!A.sim.hasRealPos()) { toast('Set your location first (tap ⌖)', 'warn'); return false; }
    return wire({ t: 'perf:race:create', modeId: modeId });
  }

  // Join an existing race by id (used by future "open races" discovery; today the
  // entry is Challenge → create+invite).
  function join(raceId) {
    if (!P.active()) { toast('Switch on Performance timers in Settings first', 'warn'); return false; }
    if (!live()) { toast('Racing needs a live connection', 'warn'); return false; }
    return wire({ t: 'perf:race:join', id: raceId });
  }

  // Challenge a specific nearby rider: create a race (default ¼ mile) and invite
  // them via the standard party-style messaging. The invitee's client offers Join.
  // Returns false if we can't race (offline / no location / not switched on).
  function challenge(racerId) {
    if (!P.active()) { toast('Switch on Performance timers in Settings first', 'warn'); return false; }
    if (!live()) { toast('Racing needs a live connection', 'warn'); return false; }
    if (!A.sim.hasRealPos()) { toast('Set your location first (tap ⌖)', 'warn'); return false; }
    // Default to ¼ mile — the iconic drag distance. Open the lobby immediately;
    // the challenge invite goes out so the other rider gets a Join prompt.
    pendingChallenge = racerId;
    if (!race) { if (!create('quarter')) { pendingChallenge = null; return false; } }
    else sendPendingInvite();
    return true;
  }
  var pendingChallenge = null;
  function sendPendingInvite() {
    if (!pendingChallenge || !race || !race.isHost) return;
    wire({ t: 'perf:race:invite', to: pendingChallenge });
    pendingChallenge = null;
  }

  function setReady(on) { wire({ t: 'perf:race:ready', on: !!on }); }
  function start() { wire({ t: 'perf:race:start' }); }
  function leave() {
    teardownRun();
    timers = {};
    hideHud();
    if (race) wire({ t: 'perf:race:leave' });
    race = null;
    pendingChallenge = null;
    if (overlayCard) { overlayCard = null; hideOverlay(); }
  }
  function endEarly() { if (race && race.isHost) wire({ t: 'perf:race:end' }); }

  /* ===================== incoming (A.net.on) ===================== */
  function onState(m) {
    if (!m) return;
    var was = race && race.status;
    race = m.race && typeof m.race === 'object' && Array.isArray(m.race.members) ? m.race : null;
    if (!race) { leave(); return; }

    // Just-created → if we have a pending challenge, send the invite now that we
    // know the race id, then open the lobby.
    sendPendingInvite();

    if (race.status === 'lobby') {
      teardownRun();
      renderLobby();
    } else if (race.status === 'countdown') {
      // Show the countdown inside the lobby card; arm racers when green lands.
      renderLobby();
    } else if (race.status === 'running') {
      if (was !== 'running') beginRun();
      hideOverlay();
      showHud();
    } else if (race.status === 'finished') {
      teardownRun();
      timers = {};
      hideHud();
      renderResults();
      race = null; // server tears the race down after a grace period
    }
  }

  function onInvite(m) {
    if (!m || typeof m.raceId !== 'string' || !P.active()) return;
    // Someone challenged us to a race. Show a toast with a Join action.
    if (!A.ui || !A.ui.inviteToast) return;
    A.ui.inviteToast(
      { name: m.fromName || 'A rider' },
      { name: modeLabel(m.modeId) + ' race' },
      function () { P.gate(function () { wire({ t: 'perf:race:join', id: m.raceId }); }); },
      function () { /* declined — no-op */ }
    );
  }

  // Live GPS fix from another racer → feed their RaceTimer.
  function onFix(m) {
    if (!m || !race || race.status !== 'running') return;
    var t = timers[m.from];
    if (!t) return;
    if (typeof m.lng !== 'number' || typeof m.lat !== 'number') return;
    t.feed({ pos: [m.lng, m.lat], speed: typeof m.speed === 'number' ? m.speed : null, t: m.ts || Date.now() });
  }

  function onErr(m) { toast((m && m.msg) || 'Race error', 'warn'); }

  /* ===================== run lifecycle ===================== */
  function beginRun() {
    timers = {};
    var mode = modeById(race.modeId);
    if (!mode) return;
    if (A.telemetry) {
      try {
        if (A.telemetry.step) A.telemetry.step('race');
        if (A.telemetry.track) A.telemetry.track('race_start', { mode: race.modeId, racers: race.members.length });
      } catch (e) { /* telemetry is optional */ }
    }
    // One RaceTimer per racer (self included). Self's timer is fed by the local
    // gpsfix stream; remotes are fed by perf:race:fix. onFinish reports to the server.
    race.members.forEach(function (mem) {
      var id = mem.id;
      timers[id] = A.racetimer.make(mode, {
        onFinish: function (res) {
          if (id === myId()) {
            wire({ t: 'perf:race:finish', time: res.time, trap: res.trap });
            toast('You finished in ' + res.time.toFixed(2) + 's', 'success');
            if (A.telemetry && A.telemetry.track) { try { A.telemetry.track('race_finish', { mode: race.modeId, time: res.time }); } catch (e) { /* optional */ } }
          }
        }
      });
      timers[id].resetArm();
    });
    // Feed self's GPS into our own timer + relay to others at ~10Hz.
    if (fixListener) ST.off('gpsfix', fixListener);
    fixListener = function (f) {
      var me = timers[myId()];
      if (me && f && f.pos) me.feed({ pos: f.pos, speed: f.speed, t: f.t || Date.now() });
    };
    ST.on('gpsfix', fixListener);
    if (fixSendTimer) clearInterval(fixSendTimer);
    // Relay at ~10Hz ONLY while something is changing. A staged racer used to
    // ship 10 identical frames a second for the whole red light — pure bandwidth
    // and peer-side churn. A frame is suppressed when position/speed/heading are
    // unchanged, but never for longer than 2s: a peer's RaceTimer brackets its
    // next segment against the last frame it saw, so an unbounded gap would
    // back-date a late launcher's t0 across the whole pause.
    // (A plain interval on purpose: it TRANSMITS; U.poll would pause it on a
    // hidden page and freeze every peer's view of this racer.)
    var lastSig = null, lastSentAt = 0;
    fixSendTimer = setInterval(function () {
      if (!race || race.status !== 'running') return;
      var p = A.sim.playerPos();
      if (!p) return;
      var sp = liveSpeedForRelay();
      var hd = A.sim.playerHeading();
      var sig = p[0].toFixed(6) + '|' + p[1].toFixed(6) + '|' +
        (sp == null ? '' : sp.toFixed(2)) + '|' + (hd == null ? '' : Math.round(hd));
      if (sig === lastSig && Date.now() - lastSentAt < 2000) return;
      lastSig = sig; lastSentAt = Date.now();
      // The local gpsfix already drives our timer; this relays to OTHER racers.
      wire({
        t: 'perf:race:fix',
        lng: p[0], lat: p[1],
        speed: sp,
        heading: hd,
        acc: A.sim.lastAccuracy ? A.sim.lastAccuracy() : null,
        ts: Date.now()
      });
    }, 100);

    if (hudRaf) cancelAnimationFrame(hudRaf);
    lastHudAt = 0; // force the first frame to paint immediately
    hudRaf = requestAnimationFrame(paintHud);
  }

  // Pull live speed from the self timer's state (it already tracks liveSpeed).
  function liveSpeedForRelay() {
    var me = timers[myId()];
    return me ? me.state().liveSpeed : null;
  }

  function teardownRun() {
    if (fixListener) { ST.off('gpsfix', fixListener); fixListener = null; }
    if (fixSendTimer) { clearInterval(fixSendTimer); fixSendTimer = null; }
    if (hudRaf) { cancelAnimationFrame(hudRaf); hudRaf = null; }
  }

  /* ===================== UI: lobby ===================== */
  function openOverlay(card) {
    overlayCard = card;
    if (A.ui.openOverlayRaw) A.ui.openOverlayRaw(card);
    else if (A.ui.openOverlay) A.ui.openOverlay(card);
  }
  function hideOverlay() {
    overlayCard = null;
    if (A.ui.closeOverlay) A.ui.closeOverlay();
  }

  function renderLobby() {
    if (!race) return;
    var card = U.el('div', 'modal-card race-overlay');
    var title = race.status === 'countdown'
      ? countdownText()
      : (race.isHost ? 'Your race lobby' : 'Race lobby');
    card.appendChild(authHead(title, function () { leave(); }));

    var mode = modeById(race.modeId);
    card.appendChild(U.el('div', 'race-mode-pill', U.esc(mode ? mode.label : race.modeId)));

    // Roster.
    var roster = U.el('div', 'race-roster');
    roster.innerHTML = race.members.map(function (mem) {
      var you = mem.id === myId();
      var tag = you ? ' <span class="race-you">(you)</span>' : '';
      var ready = mem.ready ? '<span class="tag tag-live"><span class="dot dot-live"></span>Ready</span>' : '<span class="tag">Not ready</span>';
      return '<div class="race-member" data-id="' + U.esc(mem.id) + '">' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(mem.paint) + '">' + U.riderIcon(mem.emoji, { size: 16 }) + '</span>' +
        '<span class="race-member-name">' + U.esc(mem.name) + tag + '</span>' +
        ready + '</div>';
    }).join('');
    card.appendChild(roster);

    // Actions.
    var act = U.el('div', 'race-actions');
    if (race.status === 'lobby') {
      var me = (race.members.filter(function (m) { return m.id === myId(); })[0]) || {};
      var readyBtn = U.el('button', 'btn ' + (me.ready ? 'btn-ghost' : 'btn-primary'));
      readyBtn.type = 'button';
      readyBtn.textContent = me.ready ? 'Not ready' : 'Ready';
      readyBtn.addEventListener('click', function () { setReady(!me.ready); });
      act.appendChild(readyBtn);

      if (race.isHost) {
        var startBtn = U.el('button', 'btn btn-primary', 'Start race');
        startBtn.type = 'button';
        var canStart = race.members.length >= 2 && race.members.every(function (m) { return m.ready; });
        startBtn.disabled = !canStart;
        startBtn.title = canStart ? '' : 'Everyone must be ready (need ≥ 2 racers)';
        startBtn.addEventListener('click', start);
        act.appendChild(startBtn);
      }
      var leaveBtn = U.el('button', 'btn btn-ghost btn-danger-text', 'Leave');
      leaveBtn.type = 'button';
      leaveBtn.addEventListener('click', leave);
      act.appendChild(leaveBtn);
    } else if (race.status === 'countdown') {
      var cd = U.el('div', 'race-countdown', countdownText());
      act.appendChild(cd);
    }
    card.appendChild(act);

    if (race.status === 'lobby' && race.isHost) {
      card.appendChild(U.el('div', 'race-hint',
        'Share a Challenge from a rider\'s profile to fill the grid. Everyone stages on real GPS. Come to a stop, then floor it on green.'));
    }
    openOverlay(card);
  }

  function countdownText() {
    if (!race || !race.startedAt) return 'Starting…';
    var secs = Math.max(0, Math.ceil((race.startedAt - Date.now()) / 1000));
    return secs > 0 ? String(secs) : 'GO!';
  }

  /* ===================== UI: live HUD ===================== */
  function hudEl() { return document.getElementById('race-hud'); }
  function showHud() {
    var hud = hudEl();
    if (!hud) return;
    hud.hidden = false;
    requestAnimationFrame(function () { if (!hud.hidden) hud.classList.add('show'); });
  }
  function hideHud() {
    var hud = hudEl();
    if (!hud) return;
    hud.classList.remove('show');
    setTimeout(function () { if (race == null || race.status !== 'running') hud.hidden = true; }, 250);
  }

  function paintHud() {
    if (!race || race.status !== 'running') { hudRaf = null; return; }
    var hud = hudEl();
    if (!hud) { hudRaf = null; return; }
    hudRaf = requestAnimationFrame(paintHud);
    // The whole board is one innerHTML write. Rebuilding it every animation
    // frame threw away and recreated the Leave button ~60×/s, so a tap landed on
    // an element that no longer existed by the time the click resolved — the
    // button was effectively dead. Repaint at a readable cadence instead, and
    // only when something actually changed.
    var now = Date.now();
    if (now - lastHudAt < HUD_PAINT_MS) return;
    lastHudAt = now;
    paintHudNow(hud);
  }
  function paintHudNow(hud) {
    var mode = modeById(race.modeId);
    var me = myId();

    // Sort: finished first (by time), then by progress desc, self pinned to top.
    var order = race.members.slice().map(function (mem) {
      var t = timers[mem.id];
      var st = t ? t.state() : { progress: 0, liveSpeed: 0, phase: 'arm' };
      return {
        mem: mem, st: st,
        finished: !!mem.finished,
        sortKey: mem.finished ? -1 : st.progress,
        time: mem.time
      };
    });
    // `finished`/`time` live on the server-sent member record.
    order.sort(function (a, b) {
      if (a.mem.id === me) return -1;
      if (b.mem.id === me) return 1;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return (a.time || 0) - (b.time || 0);
      return b.sortKey - a.sortKey;
    });

    var rows = order.map(function (o) {
      var mem = o.mem, st = o.st;
      var pct = Math.round((mem.finished ? 1 : st.progress) * 100);
      var speedTxt = mem.finished ? (mem.time != null ? mem.time.toFixed(2) + 's' : 'DNF')
        : (Math.round(spVal(st.liveSpeed)) + ' ' + spUnitLo().toUpperCase());
      var status = mem.dnf ? 'DNF' : mem.finished ? (mem.time != null ? '🏁' : 'DNF') : phaseLabel(st.phase);
      var youCls = mem.id === me ? ' race-row-self' : '';
      return '<div class="race-row' + youCls + '">' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(mem.paint) + '">' + U.riderIcon(mem.emoji, { size: 14 }) + '</span>' +
        '<div class="race-row-main">' +
          '<div class="race-row-top"><span class="race-row-name">' + U.esc(mem.name) + '</span>' +
            '<span class="race-row-speed">' + speedTxt + '</span></div>' +
          '<div class="race-row-bar"><i style="transform:scaleX(' + (pct / 100) + ')"></i></div>' +
        '</div>' +
        '<span class="race-row-stat">' + status + '</span>' +
      '</div>';
    }).join('');

    hud.innerHTML =
      '<div class="race-hud-head">' +
        '<span class="race-hud-mode">' + U.esc(mode ? mode.label : race.modeId) + '</span>' +
        '<button type="button" class="race-hud-leave" title="Leave race">Leave</button>' +
      '</div>' +
      '<div class="race-hud-rows">' + rows + '</div>';

    var lb = hud.querySelector('.race-hud-leave');
    if (lb) lb.addEventListener('click', leave);
  }
  function phaseLabel(p) {
    if (p === 'run') return 'GO';
    if (p === 'done') return '🏁';
    if (p === 'arm') return 'stage';
    return '–';
  }

  /* ===================== UI: results ===================== */
  function renderResults() {
    if (!race) return;
    var card = U.el('div', 'modal-card race-overlay race-results');
    card.appendChild(authHead('Results', function () { hideOverlay(); }));

    var finishers = race.members.filter(function (m) { return !m.dnf && m.time != null; })
      .sort(function (a, b) { return a.time - b.time; });
    var dnfs = race.members.filter(function (m) { return m.dnf || m.time == null; });

    var rows = finishers.map(function (m, i) {
      var pb = isPB(m) ? '<em class="dragy-pb">PB</em>' : '';
      var trap = (m.trap != null) ? '<i>trap ' + Math.round(spVal(m.trap)) + ' ' + spUnitLo() + '</i>' : '';
      var medal = ['🥇', '🥈', '🥉'][i] || ('#' + (i + 1));
      var you = m.id === myId() ? ' race-result-self' : '';
      return '<div class="race-result' + you + '">' +
        '<span class="race-medal">' + medal + '</span>' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(m.paint) + '">' + U.riderIcon(m.emoji, { size: 16 }) + '</span>' +
        '<span class="race-result-name">' + U.esc(m.name) + '</span>' +
        '<b class="race-result-time">' + m.time.toFixed(2) + 's</b>' + trap + pb +
      '</div>';
    }).join('');
    rows += dnfs.map(function (m) {
      var you = m.id === myId() ? ' race-result-self' : '';
      return '<div class="race-result race-result-dnf' + you + '">' +
        '<span class="race-medal">–</span>' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(m.paint) + '">' + U.riderIcon(m.emoji, { size: 16 }) + '</span>' +
        '<span class="race-result-name">' + U.esc(m.name) + '</span>' +
        '<b class="race-result-time">DNF</b>' +
      '</div>';
    }).join('');

    var body = U.el('div', 'race-results-list', rows);
    card.appendChild(body);

    var act = U.el('div', 'race-actions');
    var close = U.el('button', 'btn btn-primary btn-block', 'Done');
    close.type = 'button';
    close.addEventListener('click', function () { hideOverlay(); });
    act.appendChild(close);
    card.appendChild(act);

    openOverlay(card);
  }

  // Was this finish a new PB for the rider? Only knowable for ourselves (we hold
  // the local history). For others we can't tell, so we skip the badge.
  function isPB(mem) {
    if (mem.id !== myId()) return false;
    var h = (function () { try { return JSON.parse(localStorage.getItem('convoy.dragy.v1') || '[]'); } catch (e) { return []; } })();
    return !h.length || h.every(function (r) { return r.modeId !== race.modeId || r.time >= mem.time; });
  }

  /* ===================== shared header helper ===================== */
  function authHead(title, onClose) {
    var head = U.el('div', 'auth-head2');
    var x = U.el('button', 'auth-back',
      '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', onClose);
    head.appendChild(x);
    head.appendChild(U.el('h2', 'auth-title', U.esc(title)));
    return head;
  }

  /* ===================== hooks: the Challenge button, the socket, the stand-down ===================== */
  // "Challenge to race" on a rider's public profile (the old js/ui.js button).
  if (A.ui && A.ui.addHook) A.ui.addHook('profile-overlay', function (actions, subject) {
    if (!P.active() || !subject || subject.self || !actions) return;
    var raceBtn = U.el('button', 'btn btn-small', 'Challenge to race');
    raceBtn.type = 'button';
    raceBtn.addEventListener('click', function () {
      P.gate(function () {
        if (challenge(subject.id)) { if (A.ui.closeOverlay) A.ui.closeOverlay(); }
      });
    });
    actions.appendChild(raceBtn);
  });

  if (A.net && A.net.on) {
    A.net.on('perf:race:state', onState);
    A.net.on('perf:race:invite', onInvite);
    A.net.on('perf:race:fix', onFix);
    A.net.on('perf:err', onErr);
  }

  // Everything that can take the feature away ends the race on this side too:
  // the grant going, the switch going off, the session ending.
  function standDown() { if (race || overlayCard) leave(); else { teardownRun(); hideHud(); } }
  ST.on('packs', function () { if (!P.held()) standDown(); });
  ST.on('setting', function (e) { if (e && e.key === 'perfEnabled' && !e.val) standDown(); });
  ST.on('auth', function (a) { if (!a || !a.token) standDown(); });

  function init() { /* nothing to wire: the HUD is a fragment and every entry is a hook */ }

  /* ===================== exports ===================== */
  A.race = {
    create: create,
    join: join,
    challenge: challenge,
    setReady: setReady,
    start: start,
    leave: leave,
    endEarly: endEarly,
    // inbound (A.net.on), kept public for the suite:
    onState: onState,
    onInvite: onInvite,
    onFix: onFix,
    onErr: onErr,
    active: function () { return !!race; },
    // test surface
    _init: init, _standDown: standDown, _timers: function () { return timers; }, _paintHud: function () { var h = hudEl(); if (h && race) paintHudNow(h); }
  };
})();
