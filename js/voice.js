/* Convoy — walkie-talkie voice.
   WebRTC P2P mesh between convoy members (low-latency Opus).
   Falls back to WebSocket PCM relay when P2P can't connect.
   Three mic modes: push-to-talk (hold), open mic (amplitude gate), toggle (tap).
   Voice flows within an active convoy, plus — when the "Auto voice chat"
   setting is on — with riders around you (proximity voice: radius / in sight /
   on your road, mirroring the Nearby filters). Never globally. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var ST = A.store;
  var U = A.util;

  var ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  var OPEN_MIC_THRESHOLD = 0.04;   // RMS amplitude that opens the gate
  var OPEN_MIC_HANG_MS = 600;      // keep transmitting this long after voice drops
  var RELAY_CHUNK_MS = 60;         // PCM capture slice for the relay fallback

  var ctx = null;          // AudioContext
  var stream = null;       // MediaStream from getUserMedia
  var micTrack = null;     // the audio track (toggle .enabled for PTT/toggle)
  var analyser = null;     // amplitude probe for open mic
  var levelBuf = null;

  var mode = 'ptt';        // 'ptt' | 'open' | 'toggle'
  var active = false;      // voice session running (peers present + mic acquired)
  var members = [];        // [id, ...] of ALL session peers (convoy ∪ proximity)
  var peers = {};          // id -> { pc, relayOnly, src, gain, snd }
  var toggleOn = false;    // toggle-mode mic state
  var pttHeld = false;
  var openHotUntil = 0;    // timestamp until which open mic stays open

  /* ---- proximity voice (auto-connect, like proximity chat) ---- */
  var proxMode = 'off';    // off | radius | sight | road (S.settings.proxVoice)
  var partyIds = [];       // current convoy peer ids
  var proxIds = [];        // riders auto-linked by proximity
  var micDenied = false;   // mic failed once — stop auto-retrying until a user gesture
  var lastProxCount = 0;   // for the "linked with N riders" toast (fires on 0 → N only)
  var PROX_POLL_MS = 3000; // how often the proximity set is re-evaluated
  var EXIT_MARGIN = 1.3;   // keep a linked peer until they're 30% beyond range (no flapping)

  var relayScriptNode = null;
  var relayEnc = null;     // AudioEncoder for fallback path (if available)

  /* ---------------- mic acquisition ---------------- */
  async function acquireMic() {
    if (stream) return true;
    // Android: the WebView will only grant getUserMedia() if the app ALREADY holds
    // the RECORD_AUDIO runtime permission. That used to be requested blindly in
    // MainActivity.onCreate — a mic prompt on the launch screen with no context.
    // Now it is requested here, at the moment the rider actually opens voice, so
    // the prompt arrives when it makes sense. No-op on the web.
    if (A.native && A.native.ensureMic) {
      var okPerm = await A.native.ensureMic();
      if (!okPerm) {
        if (!micDenied && A.ui) A.ui.toast('Mic permission denied. Voice off', 'warn');
        micDenied = true;
        return false;
      }
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (e) {
      // Only toast the first failure — the proximity poll would otherwise
      // re-attempt (and re-toast) every few seconds after a denial.
      if (!micDenied && A.ui) A.ui.toast('Mic permission denied. Voice off', 'warn');
      micDenied = true;
      return false;
    }
    micTrack = stream.getAudioTracks()[0];
    micTrack.enabled = false; // start muted; PTT/open/toggle gates open it

    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();

    var src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    levelBuf = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    return true;
  }

  function releaseMic() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    micTrack = null;
    analyser = null;
    levelBuf = null;
  }

  /* ---------------- transmitting gate ---------------- */
  // True when the mic should be live right now given the current mode.
  function shouldTransmit() {
    if (!micTrack) return false;
    if (mode === 'ptt') return pttHeld;
    if (mode === 'toggle') return toggleOn;
    if (mode === 'open') {
      // open mic is hot while amplitude is above threshold, with a short hang
      if (Date.now() < openHotUntil) return true;
      var rms = measureRMS();
      if (rms > OPEN_MIC_THRESHOLD) { openHotUntil = Date.now() + OPEN_MIC_HANG_MS; return true; }
      return false;
    }
    return false;
  }

  function measureRMS() {
    if (!analyser || !levelBuf) return 0;
    analyser.getByteTimeDomainData(levelBuf);
    var sum = 0;
    for (var i = 0; i < levelBuf.length; i++) {
      var v = (levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / levelBuf.length);
  }

  var gateTimer = null;
  var lastMicState = false;
  // Polls the gate ~30x/s and flips the mic track + announces state changes.
  function startGate() {
    if (gateTimer) return;
    gateTimer = setInterval(function () {
      var on = shouldTransmit();
      if (on !== lastMicState) {
        lastMicState = on;
        if (micTrack) micTrack.enabled = on;
        announceMic(on);
        updateUi(on);
        // Any peer on the relay fallback needs the sender armed the moment we go
        // live — not just in open-mic mode. The previous `mode === 'open'` guard
        // meant PTT (the default) and toggle never sent relay audio, so voice was
        // dead for any convoy where P2P couldn't connect (common on mobile NAT).
        if (on) ensureRelayIfNeeded();
      }
    }, 33);
  }
  function stopGate() {
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (micTrack) micTrack.enabled = false;
    if (lastMicState) { lastMicState = false; announceMic(false); updateUi(false); }
  }

  function announceMic(on) {
    if (A.net && A.net.isLive()) A.net.sendVoiceMic(on);
  }

  /* ---------------- WebRTC mesh ---------------- */
  function ensurePeer(id) {
    if (peers[id]) return peers[id];
    // Never open a connection to someone blocked. Without this, syncMembers
    // re-creates the peer dropPeer just tore down on the very next roster
    // broadcast — the block would appear to work for about a second.
    // Fall back to a bare {id} when sim has no record: a proximity peer can be
    // adopted from a signalling frame before their pin exists, and passing null
    // would skip the session-hide check that keys on the rider id.
    var npc = (A.sim && A.sim.getNpc && A.sim.getNpc(id)) || { id: id };
    if (ST && ST.isBlockedRider && ST.isBlockedRider(npc)) return null;
    var peer = { pc: null, relayOnly: false, makingOffer: false };
    peers[id] = peer;
    setupPeer(id, peer);
    return peer;
  }

  function setupPeer(id, peer) {
    var pc;
    try { pc = new RTCPeerConnection(ICE_SERVERS); }
    catch (e) { peer.relayOnly = true; return; }
    peer.pc = pc;

    // Send our mic to them
    if (stream) {
      try {
        stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
        peer.hasLocalTrack = true;
      } catch (e) { peer.relayOnly = true; }
    }

    pc.onicecandidate = function (e) {
      if (e.candidate && A.net && A.net.isLive()) {
        A.net.sendVoiceSignal({ to: id, ice: e.candidate });
      }
    };
    pc.ontrack = function (e) {
      peer.relayOnly = false;
      attachPlayback(id, e.streams[0]);
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed') {
        peer.relayOnly = true;
        if (lastMicState) ensureRelayScript();
      }
    };

    // Polite-offer mesh: the peer with the lexicographically smaller id offers.
    if (myId() < id) makeOffer(id, peer);
  }

  async function makeOffer(id, peer) {
    if (!peer.pc) return;
    peer.makingOffer = true;
    try {
      await peer.pc.setLocalDescription();
      if (A.net && A.net.isLive()) A.net.sendVoiceSignal({ to: id, sdp: peer.pc.localDescription });
    } catch (e) { /* will retry on next party sync */ }
    peer.makingOffer = false;
  }

  async function onSignal(msg) {
    var id = msg.from;
    if (members.indexOf(id) < 0) {
      // Not a convoy member — maybe a proximity rider who linked to US first.
      // Sight/road matching is asymmetric (the rider behind sees the one ahead,
      // not vice-versa), so accept any opted-in rider inside the mode's range
      // and adopt them into the session; reconcile() keeps them while in scope.
      if (!adoptProxPeer(id)) return;
    }
    // Defense in depth: ignore signaling addressed to another member (the server
    // routes on payload.to now, but an old server broadcasts to the whole party).
    if (msg.payload && msg.payload.to && msg.payload.to !== myId()) return;
    var peer = ensurePeer(id);
    if (!peer) return;            // blocked — no connection to negotiate
    var pc = peer.pc;
    if (!pc) { peer.relayOnly = true; return; }
    try {
      if (msg.payload && msg.payload.sdp) {
        var sd = msg.payload.sdp;
        var desc = new RTCSessionDescription(sd);
        if (sd.type === 'offer') {
          if (peer.makingOffer) return; // glare
          await pc.setRemoteDescription(desc);
          await pc.setLocalDescription();
          if (A.net && A.net.isLive()) A.net.sendVoiceSignal({ to: id, sdp: pc.localDescription });
        } else if (sd.type === 'answer') {
          await pc.setRemoteDescription(desc);
        }
      } else if (msg.payload && msg.payload.ice) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.payload.ice)); } catch (e) { /* race */ }
      }
    } catch (e) { peer.relayOnly = true; }
  }

  /* ---------------- playback ---------------- */
  function attachPlayback(id, remoteStream) {
    var peer = peers[id];
    if (!peer) return;
    if (peer.snd) { peer.snd.disconnect(); }
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    // Chrome/WebView quirk: a remote WebRTC audio track is SILENT through
    // WebAudio alone — the stream must also be bound to an HTMLAudioElement to
    // start flowing. Bind a muted one (the audible path stays the gain graph,
    // which keeps per-peer volume control).
    var el = peer.el || (peer.el = new Audio());
    el.muted = true;
    el.srcObject = remoteStream;
    var p = el.play(); if (p && p.catch) p.catch(function () {});
    var src = ctx.createMediaStreamSource(remoteStream);
    var gain = ctx.createGain();
    gain.gain.value = 1.0;
    src.connect(gain).connect(ctx.destination);
    peer.src = src; peer.gain = gain; peer.snd = src;
  }

  function playRelayChunk(fromId, b64, rate) {
    // Scope check: convoy members always play; unknown senders only when they
    // qualify as a proximity peer (the server relays coarsely — exact mode
    // filtering is ours).
    if (members.indexOf(fromId) < 0 && !adoptProxPeer(fromId)) return;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var peer = peers[fromId];
    if (!peer) peer = ensurePeer(fromId);
    if (!peer) return;            // blocked — drop the relayed audio
    if (peer.pc && peer.pc.connectionState === 'connected') return; // P2P wins
    peer.relayOnly = true;
    // The sender downsamples before encoding, so it stamps the effective sample
    // rate on each chunk. Play back at that rate, else speech runs slow/pitched.
    if (rate) peer.relayRate = rate;
    try {
      var f32 = decodeFloat32(b64);
      if (!f32 || !f32.length) return;
      var buf = ctx.createBuffer(1, f32.length, peer.relayRate || ctx.sampleRate);
      buf.getChannelData(0).set(f32);
      var srcNode = ctx.createBufferSource();
      srcNode.buffer = buf;
      srcNode.connect(ctx.destination);
      srcNode.start();
    } catch (e) { /* drop */ }
  }

  function decodeFloat32(b64) {
    try {
      var bin = atob(b64);
      var n = bin.length / 4;
      if (n < 1 || n !== Math.floor(n)) return null;
      var out = new Float32Array(n);
      var view = new DataView(new ArrayBuffer(bin.length));
      for (var i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
      for (var j = 0; j < n; j++) out[j] = view.getFloat32(j * 4, true);
      return out;
    } catch (e) { return null; }
  }

  /* ---------------- relay sender (fallback path) ---------------- */
  // Only runs when at least one peer is relay-only and we're transmitting.
  function ensureRelayScript() {
    if (relayScriptNode || !ctx || !stream) return;
    try {
      var src = ctx.createMediaStreamSource(stream);
      var node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = function (e) {
        if (!lastMicState) return;
        var input = e.inputBuffer.getChannelData(0);
        // Downsample-ish: send every 3rd sample to cut bandwidth. The receiver
        // must play these samples back at ctx.sampleRate/step, not full rate —
        // otherwise relayed speech runs ~3× slow and pitched down. We stamp the
        // effective rate on the payload so each peer decodes at the right speed.
        var step = 3, out = [];
        for (var i = 0; i < input.length; i += step) out.push(input[i]);
        var f32 = new Float32Array(out);
        if (f32.length && A.net && A.net.isLive()) A.net.sendVoiceRelay(encodeFloat32(f32), Math.round(ctx.sampleRate / step));
      };
      src.connect(node);
      // The processor must be connected to destination to run on some engines,
      // BUT connecting straight to ctx.destination pipes the mic back out through
      // the speakers — full-throated echo/feedback. Tap it through a zero-gain
      // node so the graph is pulled (keeping onaudioprocess firing) with no sound.
      var mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      relayScriptNode = node;
    } catch (e) { relayScriptNode = null; }
  }

  function ensureRelayIfNeeded() {
    var anyRelay = members.some(function (id) { return peers[id] && peers[id].relayOnly; });
    if (anyRelay) ensureRelayScript();
  }

  function encodeFloat32(f32) {
    var buf = new ArrayBuffer(f32.length * 4);
    var view = new DataView(buf);
    for (var i = 0; i < f32.length; i++) view.setFloat32(i * 4, f32[i], true);
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
    return btoa(bin);
  }

  /* ---------------- proximity peers ---------------- */
  // Distance-only acceptance test for a rider who signaled/relayed to us.
  // Deliberately looser than the initiation filter: sight/road are asymmetric
  // (FOV, heading), and requiring BOTH sides to match would deadlock the pair.
  // Whoever "sees" the other initiates; the other side accepts by range alone.
  function inAcceptScope(id) {
    if (proxMode === 'off' || !A.sim || !A.sim.getNpc) return false;
    var npc = A.sim.getNpc(id);
    if (!npc) return false;
    var pos = npc.livePos || npc.pos;
    var me = A.sim.playerPos && A.sim.playerPos();
    if (!me || !pos) return false;
    var range = proxMode === 'road' ? 4000 : proxMode === 'sight' ? 600 : 2000;
    return U.haversine(me, pos) <= range * EXIT_MARGIN;
  }

  // A proximity rider reached out first — take them into the session (and spin
  // the session up if it wasn't running). Returns true when the sender is now
  // a legitimate peer.
  function adoptProxPeer(id) {
    if (!inAcceptScope(id)) return false;
    if (proxIds.indexOf(id) < 0) proxIds.push(id);
    members = sessionIds();
    if (!active && !micDenied) startParty(members); // async mic; answering works meanwhile
    return true;
  }

  // Riders matching the chosen proximity mode right now, with hysteresis:
  // already-linked peers stay until they leave the (larger) accept scope, so a
  // pair riding at the edge of range doesn't connect/disconnect every poll.
  function computeProxIds() {
    if (proxMode === 'off') return [];
    if (!A.net || !A.net.isLive()) return [];
    if (A.state && A.state.settings && A.state.settings.ghost) return []; // ghosts stay silent + hidden
    if (!A.sim || !A.sim.proximityIds) return [];
    var keep = {};
    A.sim.proximityIds(proxMode).forEach(function (id) { keep[id] = 1; });
    proxIds.forEach(function (id) { if (!keep[id] && inAcceptScope(id)) keep[id] = 1; });
    return Object.keys(keep);
  }

  // Union of convoy + proximity peers (deduped, never ourselves).
  function sessionIds() {
    var seen = {}, out = [];
    partyIds.concat(proxIds).forEach(function (id) {
      if (!id || seen[id] || id === myId()) return;
      seen[id] = 1;
      out.push(id);
    });
    return out;
  }

  // Single source of truth for who the voice session should include. Runs on
  // every party change and on a slow poll (proximity sets drift as riders move).
  function reconcile() {
    partyIds = membersOf();
    proxIds = computeProxIds();
    var ids = sessionIds();
    if (!ids.length) {
      lastProxCount = 0;
      if (active) stopParty();
      return;
    }
    if (!active) { if (!micDenied) startParty(ids); }
    else syncMembers(ids);
    if (proxIds.length && !lastProxCount && A.ui) {
      A.ui.toast('Voice linked · ' + proxIds.length + ' rider' + (proxIds.length === 1 ? '' : 's') + ' in range', 'info');
    }
    lastProxCount = proxIds.length;
  }

  function setProxMode(m) {
    if (['off', 'radius', 'sight', 'road'].indexOf(m) < 0) return;
    proxMode = m;
    if (ST && ST.setSetting) ST.setSetting('proxVoice', m);
    if (A.net && A.net.isLive() && A.net.sendVoiceProx) A.net.sendVoiceProx(m);
    if (A.ui) {
      A.ui.toast(m === 'off' ? 'Auto voice chat off · convoy voice only'
        : 'Auto voice chat on · linking riders ' +
          (m === 'radius' ? 'around you' : m === 'sight' ? 'in sight ahead' : 'on your road'), 'info');
    }
    reconcile();
  }

  /* ---------------- session lifecycle ---------------- */
  async function startParty(memberIds) {
    members = (memberIds || []).slice();
    if (!members.length) return;
    // Voice only makes sense against real peers (live mode). In solo mode the
    // "members" are simulated NPCs — no point acquiring the mic.
    if (!A.net || !A.net.isLive()) { active = false; return; }
    var ok = await acquireMic();
    if (!ok) return;
    active = true;
    members.forEach(function (id) {
      var peer = ensurePeer(id);
      if (!peer) return;          // blocked — skip
      // A peer created before the mic existed (a proximity rider adopted while
      // answering their signal) has no local track — add it and renegotiate,
      // otherwise they'd hear nothing from us over P2P.
      if (peer.pc && stream && !peer.hasLocalTrack) {
        try {
          stream.getTracks().forEach(function (t) { peer.pc.addTrack(t, stream); });
          peer.hasLocalTrack = true;
          makeOffer(id, peer);
        } catch (e) { peer.relayOnly = true; }
      }
    });
    startGate();
    showOverlay(true);
  }

  function stopParty() {
    active = false;
    members = [];
    stopGate();
    if (relayScriptNode) { try { relayScriptNode.disconnect(); } catch (e) { } relayScriptNode = null; }
    Object.keys(peers).forEach(function (id) {
      var p = peers[id];
      try { if (p.pc) p.pc.close(); } catch (e) { }
      try { if (p.snd) p.snd.disconnect(); } catch (e) { }
      try { if (p.el) { p.el.pause(); p.el.srcObject = null; } } catch (e) { }
    });
    peers = {};
    releaseMic();
    showOverlay(false);
  }

  // Called when the convoy roster changes — reconcile peers.
  function syncMembers(memberIds) {
    members = (memberIds || []).slice();
    if (!active) return;
    Object.keys(peers).forEach(function (id) {
      if (members.indexOf(id) < 0) {
        var p = peers[id];
        try { if (p.pc) p.pc.close(); } catch (e) { }
        try { if (p.snd) p.snd.disconnect(); } catch (e) { }
        try { if (p.el) { p.el.pause(); p.el.srcObject = null; } } catch (e) { }
        delete peers[id];
      }
    });
    members.forEach(function (id) { if (!peers[id]) ensurePeer(id); });
  }

  // Tear down one peer immediately. The server already stops relaying a blocked
  // rider's audio, but an ESTABLISHED WebRTC connection is peer-to-peer and does
  // not pass through the server at all — nothing server-side can close it. So the
  // client has to drop it the moment the block is made, or the person just
  // blocked keeps talking straight into the blocker's ear over the existing pipe.
  function dropPeer(id) {
    var p = peers[id];
    if (!p) return;
    try { if (p.pc) p.pc.close(); } catch (e) { }
    try { if (p.snd) p.snd.disconnect(); } catch (e) { }
    try { if (p.el) { p.el.pause(); p.el.srcObject = null; } } catch (e) { }
    delete peers[id];
    var i = members.indexOf(id);
    if (i >= 0) members.splice(i, 1);
  }

  /* ---------------- PTT / toggle controls ---------------- */
  // Browsers gate audio behind a user gesture — every control press is one, so
  // use it to unstick a suspended AudioContext (startParty may have run from a
  // network event where resume() silently failed).
  function gestureResume() {
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } }
  }
  // Voice couldn't start (mic denied, or the party event ran outside a user
  // gesture so getUserMedia was blocked) — retry from this press, which IS one.
  function retryStart() {
    if (active) return true;
    micDenied = false; // a user gesture may re-grant the mic — try again
    partyIds = membersOf();
    proxIds = computeProxIds();
    var ids = sessionIds();
    if (!ids.length || !A.net || !A.net.isLive()) {
      if (A.ui) {
        A.ui.toast(proxMode !== 'off'
          ? 'No riders in voice range yet. Voice links automatically when one is'
          : 'Voice works in a live convoy. Join one first', 'info');
      }
      return false;
    }
    startParty(ids);
    return false;
  }

  function pttDown() {
    gestureResume();
    if (!active) { retryStart(); return; }
    if (mode !== 'ptt') return;
    pttHeld = true;
  }
  function pttUp() {
    pttHeld = false;
  }
  function toggle() {
    gestureResume();
    if (!active) { retryStart(); return; }
    if (mode !== 'toggle') return;
    toggleOn = !toggleOn;
    if (A.ui) A.ui.toast(toggleOn ? 'Mic on' : 'Mic off', 'info');
  }

  // One-press talk control for surfaces with a single button (the radar dock
  // mic): whatever the current mode, flip into toggle mode and go live; press
  // again to go quiet. PTT users keep PTT on the walkie-talkie overlay.
  function talkToggle() {
    gestureResume();
    if (!active) { retryStart(); return; }
    if (mode !== 'toggle') { setMode('toggle'); toggleOn = true; }
    else toggleOn = !toggleOn;
    if (A.ui) A.ui.toast(toggleOn ? 'Mic on · tap again to mute' : 'Mic off', 'info');
  }

  function setMode(m) {
    if (['ptt', 'open', 'toggle'].indexOf(m) < 0) return;
    // Reset gates from the old mode
    pttHeld = false;
    toggleOn = false;
    openHotUntil = 0;
    mode = m;
    updateModeLabel();
    updateUi(lastMicState); // armed-ring state depends on the mode, not just transmit
  }

  var MODE_ORDER = ['ptt', 'open', 'toggle'];
  var MODE_HINT = {
    ptt: 'Push to talk · hold the mic button (or Space)',
    open: 'Open mic · transmits when you speak',
    toggle: 'Toggle · tap the mic button to talk / mute'
  };
  function cycleMode() {
    gestureResume();
    if (!active) { retryStart(); return; }
    var next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
    setMode(next);
    if (A.ui) A.ui.toast(MODE_HINT[next], 'info');
  }

  /* ---------------- UI ---------------- */
  function myId() { return A.net && A.net.myId ? A.net.myId() : ''; }

  function showOverlay(on) {
    var ov = document.getElementById('wt-overlay');
    if (ov) ov.hidden = !on;
    if (on) { updateModeLabel(); wirePttButton(); }
  }

  function wirePttButton() {
    var btn = document.getElementById('wt-ptt');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    // Mode-aware main button: hold = PTT, tap = toggle-mode mic flip. (Open mic
    // is hands-free; a tap there just reminds how it works.)
    var down = function (e) { e.preventDefault(); pttDown(); };
    var up = function () { pttUp(); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('click', function () {
      if (mode === 'toggle') toggle();
      else if (mode === 'open' && active && A.ui) A.ui.toast('Open mic · transmits when you speak', 'info');
    });
    // The little mode chip cycles PTT → Open → Toggle. (It was never wired
    // before, which left every mode except hold-to-talk unreachable.)
    var cyc = document.getElementById('wt-cycle');
    if (cyc && !cyc.dataset.wired) {
      cyc.dataset.wired = '1';
      cyc.addEventListener('click', function (e) { e.stopPropagation(); cycleMode(); });
    }
    // Keyboard space = PTT hold
    document.addEventListener('keydown', function (e) {
      if (!active) return;
      if (e.code === 'Space' && !isTyping(e)) { e.preventDefault(); pttDown(); }
    });
    document.addEventListener('keyup', function (e) {
      if (e.code === 'Space') pttUp();
    });
  }

  function isTyping(e) {
    var t = e.target && e.target.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function updateUi(transmitting) {
    var btn = document.getElementById('wt-ptt');
    if (!btn) return;
    btn.classList.toggle('wt-live', !!transmitting);
    // Armed-but-quiet state: toggle mode with the mic flipped on, or open mic
    // waiting for speech — a steady ring so you know the mic is hot.
    var armed = (mode === 'toggle' && toggleOn) || (mode === 'open' && active);
    btn.classList.toggle('wt-on', !!armed && !transmitting);
  }

  function updateModeLabel() {
    var lbl = document.getElementById('wt-mode');
    if (!lbl) return;
    lbl.textContent = mode === 'ptt' ? 'PTT' : mode === 'open' ? 'Open' : 'Toggle';
    var btn = document.getElementById('wt-ptt');
    if (btn) btn.setAttribute('data-mode', mode);
  }

  // Someone else's mic state arrived — flash their chip.
  function onPeerMic(msg) {
    var chip = document.querySelector('[data-member="' + msg.from + '"]');
    if (chip) chip.classList.toggle('wt-speaking', !!msg.on);
  }

  /* ---------------- init ---------------- */
  function init() {
    // Adopt the persisted auto-voice mode (server opt-in is sent on connect by net.js).
    var saved = A.state && A.state.settings && A.state.settings.proxVoice;
    if (['radius', 'sight', 'road'].indexOf(saved) >= 0) proxMode = saved;

    // Reconcile voice with convoy membership AND the proximity set.
    // - all peers gone (left convoy, nobody in range) → tear down mic + peers
    // - peers exist and voice isn't running → start it
    // - roster changed while running → sync peers
    ST.on('party', reconcile);
    // Proximity drifts as riders move — re-evaluate on a slow poll.
    setInterval(reconcile, PROX_POLL_MS);
    // Ghost mode change: going invisible silences proximity voice immediately.
    ST.on('ghost', reconcile);
  }

  // Local helpers reading app state without a hard import cycle.
  function S_party() { return A.state && A.state.party; }
  function membersOf() {
    var p = S_party();
    return p ? (p.members || []).slice() : [];
  }

  A.voice = {
    init: init,
    setMode: setMode,
    getMode: function () { return mode; },
    startParty: startParty,
    stopParty: stopParty,
    syncMembers: syncMembers,
    dropPeer: dropPeer,
    pttDown: pttDown,
    pttUp: pttUp,
    toggle: toggle,
    talkToggle: talkToggle, // single-button talk control (radar dock mic)
    cycleMode: cycleMode,
    setProxMode: setProxMode,                      // auto voice chat: off | radius | sight | road
    getProxMode: function () { return proxMode; },
    isActive: function () { return active; },
    onSignal: onSignal,
    onRelay: playRelayChunk,
    onPeerMic: onPeerMic
  };
})();
