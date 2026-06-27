/* Convoy — realtime client. Connects to the Convoy server (same origin, /ws).
   If no server answers (file://, python http.server, offline) the app falls
   back to solo mode and js/sim.js simulates riders locally instead. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store;

  var CONNECT_TIMEOUT = 2500;
  var RETRIES = 4;

  var ws = null;
  var live = false;
  var myId = null;
  var lastMemberIds = [];
  var pendingInvites = [];
  var posTimer = null;
  var retriesLeft = RETRIES;
  var everConnected = false;

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
  function connect() {
    // file:// (no host, no native config) → solo mode. Capacitor provides a config.wsUrl.
    if (!A.config.wsUrl && !location.host) { fallbackSolo(false); return; }
    var socket;
    try { socket = new WebSocket(wsUrl()); }
    catch (e) { fallbackSolo(false); return; }

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
      clearTimeout(timer);
      ws = socket;
      everConnected = true;
      retriesLeft = RETRIES;
      flushQueue(); // deliver any party control messages queued during reconnect
      send({
        t: 'hello',
        token: S.auth ? S.auth.token : null,
        profile: S.profile,
        pos: A.sim.playerPos(),
        heading: A.sim.playerHeading()
      });
      // re-assert ghost state on (re)connect so the server knows immediately
      if (S.settings && S.settings.ghost) send({ t: 'ghost', on: true });
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
      if (!settled) { settled = true; clearTimeout(timer); onConnectFailed(); return; }
      if (ws !== socket) return;
      onDisconnected();
    };
    socket.onerror = function () { /* onclose follows */ };
  }

  function onConnectFailed() {
    if (retriesLeft-- > 0 && everConnected) {
      setTimeout(connect, 4000);
      return;
    }
    fallbackSolo(everConnected);
  }

  function onDisconnected() {
    ws = null;
    teardownLive();
    if (retriesLeft-- > 0) {
      A.ui.toast('Connection lost — reconnecting…', 'warn');
      setTimeout(connect, 4000);
    } else {
      fallbackSolo(true);
    }
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
    if (hadConnection) A.ui.toast('Server unreachable — retrying… (no other riders shown)', 'warn');
    else A.ui.toast('Offline — connect to see nearby riders', 'info');
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
      ST.emit('friends');
    }
    probeRoutingCaps();
    if (!posTimer) posTimer = setInterval(sendPos, 1000);
    ST.emit('nearby:seeded', A.sim.count());
    A.ui.toast('Connected — ' + (m.online || 1) + ' rider' + (m.online === 1 ? '' : 's') + ' online', 'success');
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
      .then(function (j) { A.config.routeCaps = { routing: !!j.routing, waze: !!j.waze, hotspots: !!j.hotspots }; })
      .catch(function () { A.config.routeCaps = { routing: false, waze: false, hotspots: false }; })
      .then(function () { ST.emit('routecaps', A.config.routeCaps); });
  }

  function sendPos() {
    if (!live) return;
    send({ t: 'pos', pos: A.sim.playerPos(), heading: A.sim.playerHeading(), mode: 'cruise' });
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
    return { from: e.from ? e.from.name : '?', emoji: e.from ? e.from.emoji : '', text: e.text, t: e.t };
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
      chat: (p.chat || []).map(mapChatEntry)
    };
    ST.emit('party');
    ST.emit('chat');

    while (pendingInvites.length) sendInvite(pendingInvites.shift());
  }

  /* ---------------- message handlers ---------------- */
  var handlers = {
    welcome: goLive,

    'rider:add': function (m) { A.sim.remoteAdd(m.rider); },

    'rider:remove': function (m) {
      var npc = A.sim.getNpc(m.id);
      if (npc && npc.member) return; // party members stay visible
      A.sim.remoteRemove(m.id);
    },

    'rider:update': function (m) { A.sim.remoteProfile(m.id, m.profile); },

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
      S.party.chat.push(mapChatEntry({ from: m.from, sys: m.sys, text: m.text, t: m.t2 }));
      if (S.party.chat.length > 100) S.party.chat.shift();
      ST.emit('chat');
    },

    wave: function (m) {
      A.ui.toast((m.from || 'Someone') + ' waved at you', 'success');
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
      var reloading = false; // multiple invalid sessions could arrive; reload once
      return function () {
        if (reloading) return;
        reloading = true;
        A.ui.toast('Your session expired — please sign in again', 'warn');
        ST.clearAuth();
        setTimeout(function () { location.reload(); }, 1400);
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
    sendPartySys: function (text) { send({ t: 'party:sys', text: text }); },
    sendWave: function (id) { send({ t: 'wave', to: id }); },
    sendPosNow: sendPos,
    sendPartyMode: function (mode) { send({ t: 'party:mode', mode: mode }); },
    sendPartyJoin: function (code) { send({ t: 'party:join', code: code }); },
    sendFriendAdd: function (username) { send({ t: 'friend:add', username: username }); },
    sendFriendAccept: function (id) { send({ t: 'friend:accept', id: id }); },
    sendFriendDecline: function (id) { send({ t: 'friend:decline', id: id }); },
    sendFriendRemove: function (id) { send({ t: 'friend:remove', id: id }); },
    // Walkie-talkie voice signaling (convoy-only; server validates party membership).
    sendVoiceSignal: function (payload) { send({ t: 'voice:signal', payload: payload }); },
    sendVoiceRelay: function (chunk, rate) { send({ t: 'voice:relay', chunk: chunk, rate: rate || 0 }); },
    sendVoiceMic: function (on) { send({ t: 'voice:mic', on: !!on }); },
    sendGhost: function (on) { send({ t: 'ghost', on: !!on }); },
    // Crowd hazard report (e.g. a live police sighting). The server sanitizes the
    // label, rate-limits per IP, and broadcasts only to riders within NEARBY_KM.
    sendCrowdReport: function (lat, lng, kind, label) {
      send({ t: 'crowd:report', lat: lat, lng: lng, kind: kind, label: label });
    }
  };
})();
