/* Convoy — realtime client. Connects to the Convoy server (same origin, /ws).
   If no server answers (file://, python http.server, offline) the app falls
   back to solo mode and js/sim.js simulates riders locally instead. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  // 2500ms was far too tight for a cold cellular connect (DNS + TLS + upgrade),
  // so a first launch on mobile data routinely "failed" and dropped to solo.
  var CONNECT_TIMEOUT = 9000;
  var RETRY_MIN = 2000;    // first backoff step
  var RETRY_MAX = 30000;   // ceiling — we never stop trying

  var ws = null;
  var live = false;
  var myId = null;
  var lastMemberIds = [];
  var pendingInvites = [];
  var posTimer = null;
  var attempt = 0;         // consecutive failures, drives the backoff
  var retryTimer = null;   // pending reconnect (only ever one)
  var connecting = false;  // a socket is mid-handshake
  var everConnected = false;
  var toldOffline = false; // only toast the outage once per outage

  function wsUrl() {
    // Capacitor shell gets an absolute wss URL; web client derives same-origin.
    if (A.config.wsUrl) return A.config.wsUrl;
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) { }
    }
  }

  // Outbound queue for party control messages that must not be silently dropped
  // while the socket is mid-(re)connect. A lost invite used to leave the UI
  // stuck on "Invited…" forever. Flushed as soon as the socket opens.
  var outQueue = [];
  var Q_MAX = 64;
  function sendQueued(obj) {
    if (ws && ws.readyState === 1) {
      send(obj);
    } else {
      outQueue.push(obj);
      if (outQueue.length > Q_MAX) outQueue.shift(); // bound memory under a long outage
    }
  }
  function flushQueue() {
    if (!outQueue.length) return;
    var q = outQueue; outQueue = [];
    for (var i = 0; i < q.length; i++) send(q[i]);
  }

  /* ---------------- lifecycle ---------------- */
  // Schedule the next attempt. We NEVER give up: this is a driving app, and the
  // old fixed budget of 4 total retries meant one tunnel ended realtime for the
  // rest of the session (the "auto-retry continues" comment was simply wrong —
  // there was no timer). Geometric backoff to a 30s ceiling, with jitter so a
  // server restart doesn't bring every client back in the same millisecond.
  function scheduleRetry() {
    if (retryTimer) return;
    var base = Math.min(RETRY_MAX, RETRY_MIN * Math.pow(2, Math.min(attempt, 5)));
    var delay = base * (0.75 + Math.random() * 0.5);
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, delay);
  }

  // Something changed that makes a connection plausible again (network came
  // back, app returned to the foreground) — don't sit out the rest of a 30s
  // backoff.
  function reconnectNow() {
    if (live || connecting) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    attempt = 0;
    connect();
  }

  function connect() {
    // file:// (no host, no native config) → solo mode. Capacitor provides a config.wsUrl.
    if (!A.config.wsUrl && !location.host) { fallbackSolo(false); return; }
    if (connecting || (ws && ws.readyState === 1)) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    connecting = true;
    var socket;
    try { socket = new WebSocket(wsUrl()); }
    catch (e) { onConnectFailed(); return; }   // clears `connecting`, bumps `attempt`

    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (e) { }
      onConnectFailed();
    }, CONNECT_TIMEOUT);

    socket.onopen = function () {
      if (settled) { try { socket.close(); } catch (e) { } return; }
      settled = true;
      connecting = false;
      clearTimeout(timer);
      ws = socket;
      everConnected = true;
      attempt = 0;
      toldOffline = false;
      send({
        t: 'hello',
        token: S.auth ? S.auth.token : null,
        profile: S.profile,
        // Only ever publish a REAL position. player.pos starts at S.playerStart —
        // a randomised point in downtown LA used purely so the map has something
        // to draw before a fix lands. Sending it made every rider who denied the
        // location prompt appear to other users as a live rider in Los Angeles:
        // inside their proximity scope, counted in "LIVE · N riders near you",
        // and reverse-geocoded into the delayed global feed.
        pos: realPos(),
        heading: A.sim.playerHeading()
      });
      // re-assert ghost state on (re)connect so the server knows immediately
      if (S.settings && S.settings.ghost) send({ t: 'ghost', on: true });
      // QUEUED PARTY MESSAGES GO AFTER hello, never before: WebSocket is an
      // ordered stream and the server drops every non-hello frame from a socket
      // that hasn't said hello yet (server.js: "must say hello first"). The
      // queue used to flush first, so a `party:invite`/`kick`/`leave` buffered
      // during an outage was popped, sent into that drop, and lost forever.
      flushQueue();
    };
    socket.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      var h = handlers[m.t];
      if (h) {
        try { h(m); } catch (e) { console.error('[convoy net]', m.t, e); }
      }
    };
    socket.onclose = function () {
      // A close BEFORE the attempt settled is a live failure (refused, TLS
      // error): count the attempt and go through the shared failure path.
      if (!settled) { settled = true; clearTimeout(timer); onConnectFailed(); return; }
      if (ws !== socket) return;
      onDisconnected();
    };
    socket.onerror = function () { /* onclose follows */ };
  }

  // A connect attempt never completed. Report the situation once, then keep
  // trying in the background — including on the very FIRST attempt, which used
  // to require everConnected and so dropped a cold launch straight into solo.
  // The `connecting = false` here is load-bearing: the 9s TIMEOUT path settles
  // the attempt, closes the socket and lands in this handler WITHOUT ever
  // touching onopen/onDisconnected (the only other places the flag cleared), so
  // before this line one stalled handshake left `connecting` true forever —
  // every retry and every 'online'/visibility fast-reconnect no-opped, and the
  // rider spent the whole session riderless until a page reload.
  function onConnectFailed() {
    connecting = false;
    attempt++;
    if (!toldOffline) { toldOffline = true; fallbackSolo(everConnected); }
    else { teardownLive(); }
    scheduleRetry();
  }

  // An established socket dropped (tunnel, handover, server restart).
  function onDisconnected() {
    ws = null;
    teardownLive();
    connecting = false;
    attempt++;
    if (!toldOffline) { toldOffline = true; A.ui.toast('Connection lost. Reconnecting…', 'warn'); }
    scheduleRetry();
  }

  function teardownLive() {
    live = false;
    S.netMode = 'connecting';
    if (posTimer) { clearInterval(posTimer); posTimer = null; }
    if (S.party) {
      clearPartyFlags();
      S.party = null;
      A.mapview.setLinksData(null);
      ST.emit('party');
    }
  }

  // Server unreachable / offline. No fake riders — the map shows just the player
  // until a real server connection is re-established (auto-retry continues).
  function fallbackSolo(hadConnection) {
    teardownLive();
    A.sim.enableSolo(); // no-op for fake riders; just keeps netMode honest
    // Retrying really does continue now — scheduleRetry() always arms.
    if (hadConnection) A.ui.toast('Server unreachable. Retrying… (no other riders shown)', 'warn');
    else A.ui.toast('Offline. Retrying in the background', 'info');
  }

  function goLive(m) {
    live = true;
    myId = m.id;
    S.netMode = 'live';
    A.sim.disableSolo();
    (m.riders || []).forEach(function (r) { A.sim.remoteAdd(r); });
    if (m.global) A.mapview.setGlobalData(m.global);
    if (m.account) {
      S.friends = m.account.friends || [];
      S.friendReqs = m.account.requests || [];
      // The server is the authority on who this account has blocked — it is what
      // enforces it — so its list replaces whatever this device had cached.
      ST.setBlocks(m.account.blocked || []);
      ST.emit('friends');
    }
    probeRoutingCaps();
    // Re-assert the proximity-voice opt-in so the server relays voice from
    // riders around us (setting persists across sessions/reconnects).
    var pv = S.settings && S.settings.proxVoice;
    if (pv && pv !== 'off') send({ t: 'voice:prox', mode: pv });
    if (!posTimer) posTimer = setInterval(sendPos, 1000);
    ST.emit('nearby:seeded', A.sim.count());
    A.ui.toast('Connected · ' + (m.online || 1) + ' rider' + (m.online === 1 ? '' : 's') + ' online', 'success');
  }

  // Ask the server once whether it has a TomTom key configured. The result gates
  // traffic-aware routing (routing.js) and the traffic heatmap (overlays.js):
  // no key server-side → both stay gracefully off and we fall back to OSRM / a
  // hidden layer, exactly as before. Cheap GET, run once per live session and
  // cached on A.config.routeCaps.
  function probeRoutingCaps() {
    if (A.config.routeCaps !== undefined) return;
    fetch(A.config.base + '/api/route/caps')
      .then(function (r) { return r.ok ? r.json() : { routing: false, waze: false, hotspots: false }; })
      // Carry ALL caps through: ghost.js gates the live Waze police layer on
      // routeCaps.waze and the probability-hotspots layer on routeCaps.hotspots.
      // Dropping a cap here silently disables that feature even when the server
      // advertises it, so every cap the server returns must be forwarded.
      .then(function (j) {
        A.config.routeCaps = {
          routing: !!j.routing, waze: !!j.waze, hotspots: !!j.hotspots,
          // Older servers don't send `incidents` — fall back to the routing cap,
          // which is what the incidents layer used to gate on.
          incidents: j.incidents != null ? !!j.incidents : !!j.routing
        };
      })
      .catch(function () { A.config.routeCaps = { routing: false, waze: false, hotspots: false, incidents: false }; })
      .then(function () { ST.emit('routecaps', A.config.routeCaps); });
  }

  // The player's position, or null until a real GPS fix / explicit relocate has
  // replaced the demo spawn. A.sim.hasRealPos() already existed for exactly this
  // distinction (race.js and routing.js both use it) — net.js just never asked.
  function realPos() {
    return (A.sim.hasRealPos && A.sim.hasRealPos()) ? A.sim.playerPos() : null;
  }

  function sendPos() {
    if (!live) return;
    var pos = realPos();
    if (!pos) return;   // nothing real to share yet — stay off everyone's map
    send({ t: 'pos', pos: pos, heading: A.sim.playerHeading(), mode: 'cruise' });
  }

  /* ---------------- party helpers ---------------- */
  function clearPartyFlags() {
    lastMemberIds.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      if (npc) { npc.member = false; A.mapview.setNpcMember(id, false); }
    });
    lastMemberIds = [];
  }

  function mapChatEntry(e) {
    if (e.sys) return { from: null, sys: true, text: e.text, t: e.t };
    if (e.from && e.from.id === myId) return { from: 'me', text: e.text, t: e.t };
    // fromId is carried through so a message can be reported. Without it the UI
    // has only a display name, which is not enough to identify the rider — and
    // convoy chat is never persisted server-side, so the report has to name who
    // said it at the moment it is filed.
    return {
      from: e.from ? e.from.name : '?',
      fromId: e.from ? e.from.id : null,
      emoji: e.from ? e.from.emoji : '',
      text: e.text, t: e.t
    };
  }

  function applyParty(p) {
    var newIds = [];
    p.members.forEach(function (m) { if (m.id !== myId) newIds.push(m.id); });

    lastMemberIds.forEach(function (id) {
      if (newIds.indexOf(id) === -1) {
        var npc = A.sim.getNpc(id);
        if (npc) { npc.member = false; A.mapview.setNpcMember(id, false); }
      }
    });
    newIds.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      if (npc) {
        npc.member = true;
        npc.invited = false;
        A.mapview.setNpcMember(id, true);
      }
    });
    lastMemberIds = newIds;

    S.party = {
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      leader: p.leader,
      isLeader: p.leader === myId,
      mode: p.mode || 'invite',
      code: p.code || '',
      members: newIds,
      chat: (p.chat || []).map(mapChatEntry),
      rally: p.rally || null
    };
    ST.emit('party');
    ST.emit('chat');

    while (pendingInvites.length) sendInvite(pendingInvites.shift());
  }

  /* ---------------- message handlers ---------------- */
  var handlers = {
    welcome: goLive,

    // The server already refuses to send a blocked rider, so this is belt-and-
    // braces for the two cases it cannot cover: a session-only guest hide, and a
    // frame that was already in flight when the block was made.
    'rider:add': function (m) {
      if (m.rider && ST.isBlockedRider(m.rider)) return;
      A.sim.remoteAdd(m.rider);
    },

    'rider:remove': function (m) {
      var npc = A.sim.getNpc(m.id);
      if (npc && npc.member) return; // party members stay visible
      A.sim.remoteRemove(m.id);
    },

    'rider:update': function (m) { A.sim.remoteProfile(m.id, m.profile); },

    // The email-confirmation gate just lifted for this session. The server has
    // already re-sent every rider with their real name attached; this is the
    // signal to stop saying so in the UI. Arrives on the socket rather than as a
    // reply because the link is usually opened on a DIFFERENT device from the
    // one running the map.
    verified: function () {
      A.store.setAuth({ emailVerified: true });
      if (A.ui.refreshVerifyBanner) A.ui.refreshVerifyBanner();
      if (A.ui.renderAccount) A.ui.renderAccount();
      A.ui.toast('Email confirmed. Names and stats are back', 'success');
    },

    // A rider set a new dragy PB → update their NPC stats so any open profile
    // view (Nearby, popup, overlay) reflects it live.
    'dragy:pb': function (m) { if (A.sim && A.sim.remoteStats) A.sim.remoteStats(m.id, m.stats); },

    /* ----- drag races ----- */
    'race:state': function (m) { if (A.race && A.race.onState) A.race.onState(m); },
    'race:invite': function (m) { if (A.race && A.race.onInvite) A.race.onInvite(m); },
    'race:fix': function (m) { if (A.race && A.race.onFix) A.race.onFix(m); },

    tick: function (m) { A.sim.remoteTick(m.r || []); },

    party: function (m) { applyParty(m.party); },

    'party:left': function () {
      clearPartyFlags();
      S.party = null;
      A.mapview.setLinksData(null);
      ST.emit('party');
      A.ui.toast('You left the convoy', 'info');
    },

    invite: function (m) {
      A.ui.inviteToast(m.from, m.party, function () {
        send({ t: 'party:accept', pid: m.party.id });
      }, function () {
        send({ t: 'party:decline', pid: m.party.id });
      });
    },

    'invite:result': function (m) {
      var npc = A.sim.getNpc(m.to);
      if (npc) npc.invited = false;
      A.ui.toast((m.name || 'They') + " can't make it right now", 'warn');
      ST.emit('party');
    },

    chat: function (m) {
      if (!S.party) return;
      if (m.from && ST.isBlockedRider(m.from)) return;
      S.party.chat.push(mapChatEntry({ from: m.from, sys: m.sys, text: m.text, t: m.t2 }));
      if (S.party.chat.length > 100) S.party.chat.shift();
      ST.emit('chat');
    },

    wave: function (m) {
      A.ui.toast((m.from || 'Someone') + ' waved at you', 'success');
    },

    // Canonical block list, pushed after every block/unblock.
    'block:list': function (m) {
      ST.setBlocks(m.blocked || []);
      if (A.ui && A.ui.refreshBlockedList) A.ui.refreshBlockedList();
    },

    /* ----- walkie-talkie voice ----- */
    'voice:signal': function (m) { if (A.voice) A.voice.onSignal(m); },
    'voice:relay': function (m) { if (A.voice) A.voice.onRelay(m.from, m.chunk, m.rate); },
    'voice:mic': function (m) { if (A.voice) A.voice.onPeerMic(m); },

    global: function (m) { A.mapview.setGlobalData(m.fc); },

    // A nearby rider reported a crowd hazard (e.g. live police sighting). Render
    // it on the existing hazard layer via addReportedHazard. `from` lets us drop
    // our own echo (we already drew it locally at report time) so it isn't doubled.
    'crowd:report': function (m) {
      if (!A.overlays || !A.overlays.addReportedHazard) return;
      if (m.from && m.from.id === myId) return; // own report — already drawn locally
      if (typeof m.lat !== 'number' || typeof m.lng !== 'number') return;
      A.overlays.addReportedHazard({
        lat: m.lat, lng: m.lng,
        kind: m.kind || 'hazard',
        label: m.label || undefined,
        crowd: true
      });
    },

    'auth:invalid': (function () {
      var handling = false; // multiple invalid sessions could arrive; act once
      return function () {
        if (handling) return;
        handling = true;
        // Supabase access tokens expire in about an hour, so the common cause of
        // this is simply a stale token — not a revoked account. Try one refresh
        // and reconnect before throwing the rider back to the sign-in screen.
        var attempt = A.auth && A.auth.refresh ? A.auth.refresh() : Promise.resolve(false);
        attempt.then(function (ok) {
          if (ok) {
            handling = false;
            try { if (ws) ws.close(); } catch (e) { /* already closing */ }
            ws = null;
            connect();   // re-sends `hello` with the refreshed token
            return;
          }
          A.ui.toast('Your session expired. Please sign in again', 'warn');
          ST.clearAuth();
          setTimeout(function () { location.reload(); }, 1400);
        });
      };
    })(),

    /* ----- friends ----- */
    friends: function (m) {
      S.friends = m.friends || [];
      S.friendReqs = m.requests || [];
      ST.emit('friends');
    },

    'friend:request': function (m) {
      if (m.from && !S.friendReqs.some(function (r) { return r.id === m.from.id; })) {
        S.friendReqs.push(m.from);
      }
      ST.emit('friends');
      A.ui.toast((m.from ? m.from.name + ' (@' + m.from.username + ')' : 'Someone') + ' sent you a friend request', 'info');
    },

    'friend:added': function (m) {
      if (m.friend) {
        S.friends = S.friends.filter(function (f) { return f.id !== m.friend.id; });
        S.friends.push(m.friend);
        S.friendReqs = S.friendReqs.filter(function (r) { return r.id !== m.friend.id; });
      }
      ST.emit('friends');
      if (m.friend) A.ui.toast('You and ' + m.friend.name + ' are now friends', 'success');
    },

    'friend:status': function (m) {
      var f = S.friends.filter(function (x) { return x.id === m.id; })[0];
      if (f) { f.online = !!m.online; ST.emit('friends'); }
    },

    'friend:result': function (m) { A.ui.toast(m.msg || 'Done', m.ok ? 'success' : 'warn'); },

    err: function (m) { A.ui.toast(m.msg || 'Server hiccup', 'warn'); }
  };

  /* ---------------- api (used by party.js / mapview.js / sim.js) ---------------- */
  function sendCreate(name, emoji) { send({ t: 'party:create', name: name, emoji: emoji }); }

  function sendInvite(id) {
    var npc = A.sim.getNpc(id);
    if (npc) { npc.invited = true; ST.emit('party'); }
    if (!S.party) {
      pendingInvites.push(id);
      sendCreate('', 0);
      return;
    }
    sendQueued({ t: 'party:invite', to: id });
  }

  // Invite by account id (a friend who may be out of map range — no local npc)
  function sendInviteAccount(accountId) {
    if (!S.party) { pendingInvites.push(accountId); sendCreate('', 0); return; }
    sendQueued({ t: 'party:invite', to: accountId });
  }

  function init() {
    ST.on('profile', function (p) { if (live) send({ t: 'profile', profile: p }); });
    // Don't sit out the rest of a 30s backoff when the situation has obviously
    // changed: coming out of a tunnel fires 'online', and returning from the
    // background fires 'visibilitychange'.
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) reconnectNow();
    });
  }

  A.net = {
    init: init,
    connect: connect,
    isLive: function () { return live; },
    myId: function () { return myId; },
    sendInvite: sendInvite,
    sendInviteAccount: sendInviteAccount,
    sendCreate: sendCreate,
    sendKick: function (id) { sendQueued({ t: 'party:kick', id: id }); },
    sendLeave: function () { sendQueued({ t: 'party:leave' }); },
    sendChat: function (text) { sendQueued({ t: 'chat', text: text }); }, // sys lines are server-only now
    // Queued like its siblings: a sys line minted while the socket is down used
    // to vanish with no trace (raw send no-ops offline), and the server — not
    // the client — is what turns it into the delivered chat line.
    sendPartySys: function (text) { sendQueued({ t: 'party:sys', text: text }); },
    sendWave: function (id) { send({ t: 'wave', to: id }); },
    sendPosNow: sendPos,
    sendPartyMode: function (mode) { send({ t: 'party:mode', mode: mode }); },
    sendPartyJoin: function (code) { send({ t: 'party:join', code: code }); },
    // Rally point: queued like other party control messages so a mid-reconnect
    // drop doesn't silently lose the pin.
    sendRally: function (lng, lat, label) { sendQueued({ t: 'party:rally', lng: lng, lat: lat, label: label }); },
    sendRallyClear: function () { sendQueued({ t: 'party:rally', clear: true }); },
    sendFriendAdd: function (username) { send({ t: 'friend:add', username: username }); },
    sendFriendAccept: function (id) { send({ t: 'friend:accept', id: id }); },
    sendFriendDecline: function (id) { send({ t: 'friend:decline', id: id }); },
    sendFriendRemove: function (id) { send({ t: 'friend:remove', id: id }); },
    // Blocking. Queued rather than raw-sent: a block made while the socket is
    // reconnecting is the one message that must not be silently dropped — the
    // rider believes they are protected the moment they tap it.
    // username is the durable half: a rider who disconnects between the card
    // opening and the tap no longer resolves by rider id, and refusing to block
    // someone because they went offline is the wrong failure.
    sendBlock: function (riderId, username) {
      sendQueued({ t: 'block:add', to: riderId || '', username: username || '' });
    },
    sendUnblock: function (userId) { sendQueued({ t: 'block:remove', userId: userId }); },
    // Walkie-talkie voice signaling (convoy-only; server validates party membership).
    sendVoiceSignal: function (payload) { send({ t: 'voice:signal', payload: payload }); },
    sendVoiceRelay: function (chunk, rate) { send({ t: 'voice:relay', chunk: chunk, rate: rate || 0 }); },
    sendVoiceMic: function (on) { send({ t: 'voice:mic', on: !!on }); },
    // Proximity-voice opt-in (auto voice chat with riders around you).
    sendVoiceProx: function (mode) { send({ t: 'voice:prox', mode: mode }); },
    sendGhost: function (on) { send({ t: 'ghost', on: !!on }); },
    // Crowd hazard report (e.g. a live police sighting). The server sanitizes the
    // label, rate-limits per IP, and broadcasts only to riders within NEARBY_KM.
    sendCrowdReport: function (lat, lng, kind, label) {
      send({ t: 'crowd:report', lat: lat, lng: lng, kind: kind, label: label });
    },
    // Drag races (open ad-hoc lobby, any nearby rider). race.js owns the client.
    sendRace: function (msg) {
      if (!msg || typeof msg.t !== 'string') return;
      // race:fix is high-frequency during a run → queue-skipped (it's only useful
      // live; a buffered sample from a mid-reconnect outage is stale and misleading).
      if (msg.t === 'race:fix') send(msg);
      else sendQueued(msg);
    }
  };
})();
