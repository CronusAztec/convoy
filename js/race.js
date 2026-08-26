/* Convoy — side-by-side drag racing.

   An open ad-hoc race lobby any nearby rider can join (NOT convoy-gated). The
   host picks a dragy preset (0-60, ¼ mile, …), everyone stages on real GPS, a
   server-driven 3-2-1-GO fires, and each racer's time is measured by a local
   RaceTimer instance (js/racetimer.js — same math as the solo dragy meter).
   Racers broadcast their GPS at ~10Hz during the run so everyone else's HUD
   shows live speed + progress, and report their finish time to the server; the
   server tallies results and credits wins/PBs to each rider's profile.

   UI surfaces:
     - Lobby overlay (#onboarding via A.ui.openOverlay) — joiners, ready toggle,
       mode picker, host-only Start.
     - Live HUD (#race-hud) — per-racer speed + progress bars while running.
     - Results overlay — final leaderboard with times + PB badges.

   All network state is server-authoritative and proximity-scoped (the server
   refuses a join if the rider is outside NEARBY_KM of the host). */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var race = null;          // { id, modeId, host, status, startedAt, isHost, members[] } from server
  var timers = {};          // racerId -> RaceTimer instance (built on 'running')
  var fixListener = null;   // 'gpsfix' subscription (armed only while running)
  var fixSendTimer = null;  // ~10Hz race:fix relay
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

  /* ===================== public API ===================== */
  // Create a new race (you become host). Returns true on send.
  function create(modeId) {
    if (!A.net || !A.net.isLive()) { A.ui.toast('Racing needs a live connection', 'warn'); return false; }
    if (!A.sim.hasRealPos()) { A.ui.toast('Set your location first (tap ⌖)', 'warn'); return false; }
    A.net.sendRace({ t: 'race:create', modeId: modeId });
    return true;
  }

  // Join an existing race by id (used by future "open races" discovery; today the
  // entry is Challenge → create+invite).
  function join(raceId) {
    if (!A.net || !A.net.isLive()) { A.ui.toast('Racing needs a live connection', 'warn'); return false; }
    A.net.sendRace({ t: 'race:join', id: raceId });
    return true;
  }

  // Challenge a specific nearby rider: create a race (default ¼ mile) and invite
  // them via the standard party-style messaging. The invitee's client offers Join.
  // Returns false if we can't race (offline / no location / too far known already).
  function challenge(racerId) {
    if (!A.net || !A.net.isLive()) { A.ui.toast('Racing needs a live connection', 'warn'); return false; }
    if (!A.sim.hasRealPos()) { A.ui.toast('Set your location first (tap ⌖)', 'warn'); return false; }
    // Default to ¼ mile — the iconic drag distance. Open the lobby immediately;
    // the challenge invite goes out so the other rider gets a Join prompt.
    if (!race) create('quarter');
    // The invite rides on a normal wave-style nudge; the recipient opens their
    // own lobby + joins via the race id once we receive it from the server.
    pendingChallenge = racerId;
    return true;
  }
  var pendingChallenge = null;

  function setReady(on) { A.net.sendRace({ t: 'race:ready', on: !!on }); }
  function start() { A.net.sendRace({ t: 'race:start' }); }
  function leave() {
    if (fixListener) { ST.off('gpsfix', fixListener); fixListener = null; }
    if (fixSendTimer) { clearInterval(fixSendTimer); fixSendTimer = null; }
    if (hudRaf) { cancelAnimationFrame(hudRaf); hudRaf = null; }
    timers = {};
    hideHud();
    if (race) A.net.sendRace({ t: 'race:leave' });
    race = null;
    if (overlayCard) { overlayCard = null; A.ui.closeOverlay ? A.ui.closeOverlay() : closeOverlayLocal(); }
  }
  function endEarly() { if (race && race.isHost) A.net.sendRace({ t: 'race:end' }); }

  /* ===================== incoming (called from net.js) ===================== */
  function onState(m) {
    var was = race && race.status;
    race = m.race || null;
    if (!race) { leave(); return; }

    // Just-created → if we have a pending challenge, send the invite now that we
    // know the race id, then open the lobby.
    if (pendingChallenge && race.isHost) {
      A.net.sendRace({ t: 'race:invite', to: pendingChallenge, raceId: race.id, modeId: race.modeId, from: A.net.myId() });
      pendingChallenge = null;
    }

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
      hideHud();
      renderResults();
      race = null; // server tears the race down after a grace period
    }
  }

  function onInvite(m) {
    // Someone challenged us to a race. Show a toast with a Join action.
    A.ui.inviteToast(
      { name: m.fromName || 'A rider' },
      { name: modeLabel(m.modeId) + ' race' },
      function () { A.net.sendRace({ t: 'race:join', id: m.raceId }); },
      function () { /* declined — no-op */ }
    );
  }

  // Live GPS fix from another racer → feed their RaceTimer.
  function onFix(m) {
    if (!race || race.status !== 'running') return;
    var t = timers[m.from];
    if (!t) return;
    t.feed({ pos: [m.lng, m.lat], speed: m.speed, t: m.ts || Date.now() });
  }

  function onErr(m) { if (A.ui) A.ui.toast(m.msg || 'Race error', 'warn'); }

  /* ===================== run lifecycle ===================== */
  function beginRun() {
    timers = {};
    var mode = modeById(race.modeId);
    if (!mode) return;
    // One RaceTimer per racer (self included). Self's timer is fed by the local
    // gpsfix stream; remotes are fed by race:fix. onFinish reports to the server.
    race.members.forEach(function (mem) {
      var id = mem.id;
      timers[id] = A.racetimer.make(mode, {
        onFinish: function (res) {
          if (id === A.net.myId()) {
            A.net.sendRace({ t: 'race:finish', time: res.time, trap: res.trap });
            if (A.ui) A.ui.toast('You finished in ' + res.time.toFixed(2) + 's', 'success');
          }
        }
      });
      timers[id].resetArm();
    });
    // Feed self's GPS into our own timer + relay to others at ~10Hz.
    if (fixListener) ST.off('gpsfix', fixListener);
    fixListener = function (f) {
      var me = timers[A.net.myId()];
      if (me) me.feed({ pos: f.pos, speed: f.speed, t: f.t || Date.now() });
    };
    ST.on('gpsfix', fixListener);
    if (fixSendTimer) clearInterval(fixSendTimer);
    fixSendTimer = setInterval(function () {
      if (!race || race.status !== 'running') return;
      var p = A.sim.playerPos();
      if (!p) return;
      // The local gpsfix already drives our timer; this relays to OTHER racers.
      A.net.sendRace({
        t: 'race:fix',
        lng: p[0], lat: p[1],
        speed: liveSpeedForRelay(),
        heading: A.sim.playerHeading(),
        acc: A.sim.lastAccuracy ? A.sim.lastAccuracy() : null,
        ts: Date.now()
      });
    }, 100);

    if (hudRaf) cancelAnimationFrame(hudRaf);
    lastHudAt = 0; // force the first frame to paint immediately
    hudRaf = requestAnimationFrame(paintHud);
  }

  // The dragy meter tracks liveSpeed; if it's open it owns that. Otherwise derive
  // from the last gpsfix the race listener saw. Kept simple: pull from the
  // self timer's state (it already tracks liveSpeed internally).
  function liveSpeedForRelay() {
    var me = timers[A.net.myId()];
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
    else { var root = document.getElementById('onboarding'); root.hidden = false; root.innerHTML = ''; root.appendChild(card); requestAnimationFrame(function () { root.classList.add('show'); }); }
  }
  function hideOverlay() {
    if (A.ui.closeOverlay) { A.ui.closeOverlay(); overlayCard = null; }
    else { var root = document.getElementById('onboarding'); root.classList.remove('show'); setTimeout(function () { root.hidden = true; root.innerHTML = ''; }, 380); overlayCard = null; }
  }
  function closeOverlayLocal() { hideOverlay(); }

  function renderLobby() {
    if (!race) return;
    var card = U.el('div', 'modal-card race-overlay');
    var title = race.status === 'countdown'
      ? countdownText()
      : (race.isHost ? 'Your race lobby' : 'Race lobby');
    card.appendChild(authHead(title, function () { leave(); }));

    var mode = modeById(race.modeId);
    card.appendChild(U.el('div', 'race-mode-pill', mode ? mode.label : race.modeId));

    // Roster.
    var roster = U.el('div', 'race-roster');
    roster.innerHTML = race.members.map(function (mem) {
      var you = mem.id === A.net.myId();
      var tag = you ? ' <span class="race-you">(you)</span>' : '';
      var ready = mem.ready ? '<span class="tag tag-live"><span class="dot dot-live"></span>Ready</span>' : '<span class="tag">Not ready</span>';
      return '<div class="race-member" data-id="' + mem.id + '">' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(mem.paint) + '">' + U.riderIcon(mem.emoji, { size: 16 }) + '</span>' +
        '<span class="race-member-name">' + U.esc(mem.name) + tag + '</span>' +
        ready + '</div>';
    }).join('');
    card.appendChild(roster);

    // Actions.
    var act = U.el('div', 'race-actions');
    if (race.status === 'lobby') {
      var me = (race.members.filter(function (m) { return m.id === A.net.myId(); })[0]) || {};
      var readyBtn = U.el('button', 'btn ' + (me.ready ? 'btn-ghost' : 'btn-primary'));
      readyBtn.textContent = me.ready ? 'Not ready' : 'Ready';
      readyBtn.addEventListener('click', function () { setReady(!me.ready); });
      act.appendChild(readyBtn);

      if (race.isHost) {
        var startBtn = U.el('button', 'btn btn-primary', 'Start race');
        var canStart = race.members.length >= 2 && race.members.every(function (m) { return m.ready; });
        startBtn.disabled = !canStart;
        startBtn.title = canStart ? '' : 'Everyone must be ready (need ≥ 2 racers)';
        startBtn.addEventListener('click', start);
        act.appendChild(startBtn);
      }
      var leaveBtn = U.el('button', 'btn btn-ghost btn-danger-text', 'Leave');
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
  function showHud() {
    var hud = document.getElementById('race-hud');
    if (!hud) return;
    hud.hidden = false;
    requestAnimationFrame(function () { hud.classList.add('show'); });
  }
  function hideHud() {
    var hud = document.getElementById('race-hud');
    if (!hud) return;
    hud.classList.remove('show');
    setTimeout(function () { if (race == null || race.status !== 'running') hud.hidden = true; }, 250);
  }

  function paintHud() {
    if (!race || race.status !== 'running') { hudRaf = null; return; }
    var hud = document.getElementById('race-hud');
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

    var mode = modeById(race.modeId);
    var myId = A.net.myId();

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
    // `finished`/`time` live on the server-sent member record. These comparisons
    // used to read a.finished off the wrapper, which never had the field — so
    // every comparison was `undefined !== undefined` and finishers were never
    // ranked above still-running racers.
    order.sort(function (a, b) {
      if (a.mem.id === myId) return -1;
      if (b.mem.id === myId) return 1;
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
      var youCls = mem.id === myId ? ' race-row-self' : '';
      return '<div class="race-row' + youCls + '">' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(mem.paint) + '">' + U.riderIcon(mem.emoji, { size: 14 }) + '</span>' +
        '<div class="race-row-main">' +
          '<div class="race-row-top"><span class="race-row-name">' + U.esc(mem.name) + '</span>' +
            '<span class="race-row-speed">' + speedTxt + '</span></div>' +
          '<div class="race-row-bar"><i style="width:' + pct + '%"></i></div>' +
        '</div>' +
        '<span class="race-row-stat">' + status + '</span>' +
      '</div>';
    }).join('');

    hud.innerHTML =
      '<div class="race-hud-head">' +
        '<span class="race-hud-mode">' + U.esc(mode ? mode.label : race.modeId) + '</span>' +
        '<button class="race-hud-leave" title="Leave race">Leave</button>' +
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
      var you = m.id === A.net.myId() ? ' race-result-self' : '';
      return '<div class="race-result' + you + '">' +
        '<span class="race-medal">' + medal + '</span>' +
        '<span class="u-ava-mini" style="--paint:' + U.safePaint(m.paint) + '">' + U.riderIcon(m.emoji, { size: 16 }) + '</span>' +
        '<span class="race-result-name">' + U.esc(m.name) + '</span>' +
        '<b class="race-result-time">' + m.time.toFixed(2) + 's</b>' + trap + pb +
      '</div>';
    }).join('');
    rows += dnfs.map(function (m) {
      var you = m.id === A.net.myId() ? ' race-result-self' : '';
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
    close.addEventListener('click', function () { hideOverlay(); });
    act.appendChild(close);
    card.appendChild(act);

    openOverlay(card);
  }

  // Was this finish a new PB for the rider? Only knowable for ourselves (we hold
  // the local history). For others we can't tell, so we skip the badge.
  function isPB(mem) {
    if (mem.id !== A.net.myId()) return false;
    var h = (function () { try { return JSON.parse(localStorage.getItem('convoy.dragy.v1') || '[]'); } catch (e) { return []; } })();
    return !h.length || h.every(function (r) { return r.modeId !== race.modeId || r.time >= mem.time; });
  }

  /* ===================== shared header helper ===================== */
  function authHead(title, onClose) {
    var head = U.el('div', 'auth-head2');
    var x = U.el('button', 'auth-back',
      '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', onClose);
    head.appendChild(x);
    head.appendChild(U.el('h2', 'auth-title', U.esc(title)));
    return head;
  }

  /* ===================== exports ===================== */
  A.race = {
    create: create,
    join: join,
    challenge: challenge,
    setReady: setReady,
    start: start,
    leave: leave,
    endEarly: endEarly,
    // net.js inbound:
    onState: onState,
    onInvite: onInvite,
    onFix: onFix,
    onErr: onErr,
    active: function () { return !!race; }
  };
})();
