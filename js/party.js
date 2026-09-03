/* Convoy — parties/convoys: invites, membership, chat.
   Live mode delegates to the server (js/net.js); solo mode simulates locally. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var U = A.util, S = A.state, ST = A.store, D = A.data;

  var MAX_MEMBERS = 6;
  var CHAT_MAX = 100; // chat ring ceiling (pushChat)

  // Live, or the socket is down with the server still holding our seat
  // (js/net.js PARTY_GRACE_MS, server-035): every delegated action below is
  // queued behind the next hello and lands on the resumed seat. Before the
  // seat hold S.party was null during any outage, so the solo branches below
  // only ever touched a simulated convoy; with a real roster kept on screen
  // they would answer a rider's tunnel chat with a fake reply from a real
  // member. joinByCode() is the one action that needs a socket right now.
  function isLive() { return !!(A.net && (A.net.isLive() || (A.net.isResuming && A.net.isResuming()))); }

  /* ================= create ================= */
  function create(name, emoji) {
    if (isLive()) {
      A.net.sendCreate((name && name.trim()) || U.pick(D.CONVOY_NAMES), emoji || 0);
      return;
    }
    S.party = {
      id: U.uid(),
      name: (name && name.trim()) || U.pick(D.CONVOY_NAMES),
      emoji: (emoji != null && emoji !== '') ? emoji : 0,
      isLeader: true,
      members: [],
      chat: []
    };
    systemMsg('Convoy created. Invite riders from the Nearby tab');
    ST.emit('party');
    A.ui.toast('Convoy "' + S.party.name + '" created', 'success');
  }

  function ensure() {
    if (!S.party) {
      S.party = {
        id: U.uid(),
        name: (S.profile.name || 'My') + "'s convoy",
        emoji: 0,
        isLeader: true,
        members: [],
        chat: []
      };
      systemMsg('Convoy created');
      ST.emit('party');
    }
    return S.party;
  }

  /* ================= invites ================= */
  function invite(npcId) {
    var npc = A.sim.getNpc(npcId);
    if (!npc || npc.member || npc.invited) return;

    if (isLive()) {
      A.net.sendInvite(npcId);
      A.ui.toast('Invite sent to ' + npc.name, 'info');
      return;
    }

    var party = ensure();
    if (party.members.length >= MAX_MEMBERS) {
      A.ui.toast('Convoy is full (' + MAX_MEMBERS + ' riders max)', 'warn');
      return;
    }
    npc.invited = true;
    ST.emit('party');
    A.ui.toast('Invite sent to ' + npc.name, 'info');

    var partyId = S.party.id; // snapshot — if the user leaves/swaps convoys during
                              // the accept window, the NPC must not join the wrong one.
    setTimeout(function () {
      npc.invited = false;
      if (!S.party || S.party.id !== partyId) return;
      if (U.chance(0.88) && S.party.members.length < MAX_MEMBERS) {
        npc.member = true;
        S.party.members.push(npc.id);
        A.mapview.setNpcMember(npc.id, true);
        systemMsg(npc.name + ' joined the convoy');
        A.ui.toast(npc.name + ' joined your convoy', 'success');
      } else {
        A.ui.toast(npc.name + " can't make it right now", 'warn');
      }
      ST.emit('party');
    }, U.randInt(1200, 2900));
  }

  /* ================= membership ================= */
  function kick(npcId) {
    if (isLive()) { A.net.sendKick(npcId); return; }
    if (!S.party) return;
    var i = S.party.members.indexOf(npcId);
    if (i === -1) return;
    S.party.members.splice(i, 1);
    var npc = A.sim.getNpc(npcId);
    if (npc) {
      npc.member = false;
      A.mapview.setNpcMember(npcId, false);
      systemMsg(npc.name + ' left the convoy');
    }
    ST.emit('party');
  }

  function leave() {
    if (isLive()) { A.net.sendLeave(); return; }
    if (!S.party) return;
    S.party.members.forEach(function (id) {
      var npc = A.sim.getNpc(id);
      if (npc) { npc.member = false; A.mapview.setNpcMember(id, false); }
    });
    S.party = null;
    A.mapview.setLinksData(null);
    ST.emit('party');
    A.ui.toast('You left the convoy', 'info');
  }

  /* ================= chat ================= */
  // Every chat line lands here (js/net.js inbound, solo me/sys/NPC lines), so
  // the ring has one ceiling and the renderer's cursor stays honest (ui-002).
  function pushChat(entry) {
    if (!S.party) return;
    S.party.chat.push(entry);
    while (S.party.chat.length > CHAT_MAX) S.party.chat.shift();
    ST.emit('chat');
  }

  function systemMsg(text) {
    if (!S.party) return;
    if (isLive()) { A.net.sendPartySys(text); return; } // server mints the sys line
    pushChat({ from: null, sys: true, text: text, t: Date.now() });
  }

  function sendChat(text) {
    if (!S.party || !text.trim()) return;
    if (isLive()) { A.net.sendChat(text.trim()); return; }

    pushChat({ from: 'me', text: text.trim(), t: Date.now() });
    if (S.party.members.length && U.chance(0.75)) {
      var partyId = S.party.id;
      setTimeout(function () {
        if (!S.party || S.party.id !== partyId || !S.party.members.length) return;
        var npc = A.sim.getNpc(U.pick(S.party.members));
        if (!npc) return;
        pushChat({ from: npc.name, emoji: npc.emoji, text: U.pick(D.CHAT_REPLIES), t: Date.now() });
      }, U.randInt(900, 3600));
    }
  }

  function setMode(mode) {
    if (isLive()) { A.net.sendPartyMode(mode); return; }
    if (S.party) { S.party.mode = mode; ST.emit('party'); }
  }

  function joinByCode(code) {
    if (!(A.net && A.net.isLive())) { A.ui.toast('Join codes need a live connection', 'warn'); return; }
    A.net.sendPartyJoin(code);
  }

  /* ================= rally point ================= */
  // A shared meetup flag the whole convoy sees. Live mode relays through the
  // server (any member may set/clear); solo mode just updates local state.
  function setRally(lngLat, label) {
    if (!S.party) { A.ui.toast('Join a convoy first', 'warn'); return; }
    if (isLive()) { A.net.sendRally(lngLat[0], lngLat[1], label || 'Rally point'); return; }
    S.party.rally = { lng: lngLat[0], lat: lngLat[1], label: label || 'Rally point', byName: 'You', t: Date.now() };
    systemMsg('Rally point set · ' + S.party.rally.label);
    ST.emit('party');
  }
  function clearRally() {
    if (!S.party || !S.party.rally) return;
    if (isLive()) { A.net.sendRallyClear(); return; }
    S.party.rally = null;
    systemMsg('Rally point cleared');
    ST.emit('party');
  }

  // Keep the rally flag on the map in sync with party state (covers live party
  // broadcasts, solo updates, and leaving/disbanding the convoy).
  var lastRallySig = '';
  ST.on('party', function () {
    var r = S.party && S.party.rally;
    var sig = r ? r.lng + ',' + r.lat + ',' + (r.label || '') : '';
    if (sig === lastRallySig) return;
    var had = !!lastRallySig;
    lastRallySig = sig;
    if (A.mapview && A.mapview.setRallyPoint) A.mapview.setRallyPoint(r || null);
    if (r) A.ui.toast((r.byName || 'Convoy') + ' set a rally point · ' + (r.label || 'Rally point'), 'info');
    else if (had) A.ui.toast('Rally point cleared', 'info');
  });

  A.party = {
    create: create,
    ensure: ensure,
    invite: invite,
    kick: kick,
    leave: leave,
    setMode: setMode,
    joinByCode: joinByCode,
    sendChat: sendChat,
    pushChat: pushChat,
    CHAT_MAX: CHAT_MAX,
    systemMsg: systemMsg,
    setRally: setRally,
    clearRally: clearRally
  };
})();
