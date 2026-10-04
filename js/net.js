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

  // A rider riding through a tunnel is not a rider leaving the convoy. The
  // server holds their seat for its PARTY_GRACE_MS (server/server.js,
  // server-035) and the next `hello` carrying the token from the last
  // `welcome` drops them straight back in. Until then the roster stays on
  // screen — but only for as long as the server can still be holding the
  // seat, so this must never exceed the server's window (pinned across both
  // files by test/partyresume.test.js R3): a client that keeps the roster
  // after the server let the seat go is showing the rider a convoy they are
  // no longer in. Before this, teardownLive() threw the roster, links and
  // chat away on every drop and nothing ever rejoined (frontend-022).
  var PARTY_GRACE_MS = 90000;
  var resumeToken = null;       // from the last welcome; in memory only, never persisted
  var partyGraceUntil = 0;      // while now < this, a dropped socket keeps the roster on screen
  var graceTimer = null;        // clears a roster nobody came back for (only ever one)

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
        // The seat-resume token from the last welcome (server-035): the server
        // seats us back in the convoy we were in when the socket died.
        resume: resumeToken,
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
      // Same guard as onclose: a frame arriving on a socket this client has
      // already replaced must not reach the shared handler table. It used to
      // — and the seat resume makes that load-bearing: the server's half-open
      // branch sends `party:left` to the OLD socket while unseating it, and a
      // late delivery would clear the roster the new socket just restored
      // (frontend-023).
      if (ws !== socket) return;
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
    if (S.party) holdParty();   // BEFORE teardownLive() looks at the window
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
      // Inside the grace window the roster stays: the server is holding the
      // seat and the HUD link light (radar.js 'rst-link') is already dark,
      // which is the "stale roster" affordance. Past it the seat is gone —
      // clear, exactly as every drop used to.
      if (Date.now() < partyGraceUntil) ST.emit('party');
      else clearParty();
    }
  }

  function clearParty() {
    dropGrace();                // no roster, no timer
    clearPartyFlags();
    S.party = null;
    A.mapview.setLinksData(null);
    ST.emit('party');
  }

  // The socket died with a convoy on screen: keep it for the grace window and
  // arm the one timer that clears it if nobody reconnects — a rider who never
  // comes back must not stare at a frozen roster forever.
  function holdParty() {
    partyGraceUntil = Date.now() + PARTY_GRACE_MS;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(function () {
      graceTimer = null;
      if (!live && S.party) clearParty();
    }, PARTY_GRACE_MS);
  }

  function dropGrace() {
    partyGraceUntil = 0;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  }

  // Server unreachable / offline. No fake riders — the map shows just the player
  // until a real server connection is re-established (auto-retry continues).
  function fallbackSolo(hadConnection) {
    teardownLive();
    A.sim.enableSolo(); // no-op for fake riders; just keeps netMode honest
    // Solo means the rider is looking at an empty map. How often that happens,
    // and whether it happens after a working connection or instead of one, is
    // the difference between "our server is down" and "their tunnel is long".
    if (A.telemetry) A.telemetry.track('link_solo', { hadConnection: !!hadConnection, attempt: attempt });
    // Retrying really does continue now — scheduleRetry() always arms.
    if (hadConnection) A.ui.toast('Server unreachable. Retrying… (no other riders shown)', 'warn');
    else A.ui.toast('Offline. Retrying in the background', 'info');
  }

  function goLive(m) {
    live = true;
    myId = m.id;
    S.netMode = 'live';
    // The seat resume (server-035). Keep the newest token for the next drop,
    // and let the server's answer win over the client's optimism: a roster
    // kept through the outage is only honest if the server says it resumed
    // the seat — otherwise the seat expired (or was never held) and the
    // `party` frame this client is waiting for will never come.
    resumeToken = m.resume || resumeToken;
    dropGrace();
    if (S.party && m.resumed !== true) clearParty();
    if (A.telemetry) { A.telemetry.step('live'); A.telemetry.track('link_live', { reconnect: everConnected }); }
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
  // traffic-aware routing (routing.js): no key server-side → OSRM stays the
  // keyless fallback, exactly as before. Cheap GET, run once per live session
  // and cached on A.config.routeCaps.
  function probeRoutingCaps() {
    if (A.config.routeCaps !== undefined) return;
    U.fetchT(A.config.base + '/api/route/caps')
      .then(function (r) { return r.ok ? r.json() : { routing: false }; })
      .then(function (j) { A.config.routeCaps = { routing: !!j.routing }; })
      .catch(function () { A.config.routeCaps = { routing: false }; })
      .then(function () { ST.emit('routecaps', A.config.routeCaps); });
  }

  // The player's position, or null until a real GPS fix / explicit relocate has
  // replaced the demo spawn. A.sim.hasRealPos() already existed for exactly this
  // distinction (routing.js uses it) — net.js just never asked.
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
      A.ui.toast('Email confirmed. Rider names are back', 'success');
    },

    tick: function (m) { A.sim.remoteTick(m.r || []); },

    party: function (m) { applyParty(m.party); },

    'party:left': function () {
      clearParty();   // drops the grace too: never resurrect a convoy the rider left or was kicked from
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
      A.party.pushChat(mapChatEntry({ from: m.from, sys: m.sys, text: m.text, t: m.t2 }));
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
    // The socket is down but the server may still be holding our seat: party
    // actions queue behind the next hello instead of falling into the solo
    // simulation (js/party.js).
    isResuming: function () { return !live && !!S.party && Date.now() < partyGraceUntil; },
    myId: function () { return myId; },
    sendInvite: sendInvite,
    sendInviteAccount: sendInviteAccount,
    sendCreate: sendCreate,
    sendKick: function (id) { sendQueued({ t: 'party:kick', id: id }); },
    // A convoy the rider chose to leave is never kept warm: zero the grace so
    // the next drop clears it, and inside a grace window show the leave now —
    // the queued frame lands on the resumed seat and party:left confirms it.
    sendLeave: function () {
      dropGrace();
      if (!live && S.party) clearParty();
      sendQueued({ t: 'party:leave' });
    },
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
    sendGhost: function (on) { send({ t: 'ghost', on: !!on }); }
  };
})();
