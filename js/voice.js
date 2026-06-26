/* Convoy — walkie-talkie voice.
   WebRTC P2P mesh between convoy members (low-latency Opus).
   Falls back to WebSocket PCM relay when P2P can't connect.
   Three mic modes: push-to-talk (hold), open mic (amplitude gate), toggle (tap).
   Voice only flows within an active convoy — never globally. */
(function () {
  'use strict';
  var A = (window.App = window.App || {});
  var ST = A.store;

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
  var active = false;      // voice session running (convoy joined + mic acquired)
  var members = [];        // [id, ...] of convoy peers
  var peers = {};          // id -> { pc, relayOnly, src, gain, snd }
  var toggleOn = false;    // toggle-mode mic state
  var pttHeld = false;
  var openHotUntil = 0;    // timestamp until which open mic stays open

  var relayScriptNode = null;
  var relayEnc = null;     // AudioEncoder for fallback path (if available)

  /* ---------------- mic acquisition ---------------- */
  async function acquireMic() {
    if (stream) return true;
    // The Android WebView surfaces its own permission dialog for getUserMedia as
    // long as RECORD_AUDIO is declared in the manifest — no mic plugin needed.
    // Inside Capacitor we still nudge the geolocation-style flow is not required here.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (e) {
      if (A.ui) A.ui.toast('Mic permission denied — voice off', 'warn');
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
        if (on && mode === 'open') ensureRelayIfNeeded();
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
      try { stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); }); }
      catch (e) { peer.relayOnly = true; }
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
    if (members.indexOf(id) < 0) return;
    var peer = ensurePeer(id);
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
    var src = ctx.createMediaStreamSource(remoteStream);
    var gain = ctx.createGain();
    gain.gain.value = 1.0;
    src.connect(gain).connect(ctx.destination);
    peer.src = src; peer.gain = gain; peer.snd = src;
  }

  function playRelayChunk(fromId, b64, rate) {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    var peer = peers[fromId];
    if (!peer) peer = ensurePeer(fromId);
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
      node.connect(ctx.destination); // needed for some browsers to run the processor
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

  /* ---------------- party lifecycle ---------------- */
  async function startParty(memberIds) {
    members = (memberIds || []).slice();
    if (!members.length) return;
    // Voice only makes sense against real peers (live mode). In solo mode the
    // "members" are simulated NPCs — no point acquiring the mic.
    if (!A.net || !A.net.isLive()) { active = false; return; }
    var ok = await acquireMic();
    if (!ok) return;
    active = true;
    members.forEach(function (id) { ensurePeer(id); });
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
        delete peers[id];
      }
    });
    members.forEach(function (id) { if (!peers[id]) ensurePeer(id); });
  }

  /* ---------------- PTT / toggle controls ---------------- */
  function pttDown() {
    if (!active || mode !== 'ptt') return;
    pttHeld = true;
  }
  function pttUp() {
    pttHeld = false;
  }
  function toggle() {
    if (!active || mode !== 'toggle') return;
    toggleOn = !toggleOn;
  }

  function setMode(m) {
    if (['ptt', 'open', 'toggle'].indexOf(m) < 0) return;
    // Reset gates from the old mode
    pttHeld = false;
    toggleOn = false;
    openHotUntil = 0;
    mode = m;
    updateModeLabel();
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
    // Hold to talk (pointer + keyboard space)
    var down = function (e) { e.preventDefault(); pttDown(); };
    var up = function () { pttUp(); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('pointercancel', up);
    // Tap cycles mode in toggle, holds in ptt; mode switch handled by a small cycle button.
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
    if (btn) btn.classList.toggle('wt-live', !!transmitting);
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
    // Reconcile voice with convoy membership.
    // - convoy ended (or left) → tear down mic + peers
    // - convoy has members and voice isn't running → start it
    // - roster changed while running → sync peers
    ST.on('party', function () {
      var p = S_party();
      var ids = membersOf();
      if (!p || !ids.length) {
        if (active) stopParty();
        return;
      }
      if (!active) startParty(ids);
      else syncMembers(ids);
    });
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
    pttDown: pttDown,
    pttUp: pttUp,
    toggle: toggle,
    isActive: function () { return active; },
    onSignal: onSignal,
    onRelay: playRelayChunk,
    onPeerMic: onPeerMic
  };
})();
