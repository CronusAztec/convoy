/* Convoy — walkie-talkie voice.
   WebRTC P2P mesh between convoy members (low-latency Opus).
   Falls back to WebSocket PCM relay when P2P can't connect.
   Three mic modes: push-to-talk (hold), open mic (amplitude gate), toggle (tap).
   Voice flows within an active convoy, plus — when the "Auto voice chat"
   setting is on — with riders around you (proximity voice: radius / in sight /
   on your road, mirroring the Nearby filters). Never globally.

   ── The output bus ────────────────────────────────────────────────────────
   Both transports land on ONE graph, which is what makes the controls real:

       peer source (WebRTC stream | relay buffer)
            -> peer.gain      per-rider volume + per-rider mute
            -> busIn
            -> masterGain     master volume + deafen
            -> [compressor]   optional, evens out a rider who is much louder
            -> destination    (or a MediaStreamDestination feeding one <audio>
                               element, when output routing needs setSinkId on
                               an element rather than on the context)

   This used to be two graphs. Relayed audio went straight to ctx.destination
   and skipped peer.gain entirely, so any per-rider volume or mute silently did
   nothing the moment P2P failed over to the relay — which is exactly when the
   call is already going badly. Every peer source now goes through its gain
   node, created lazily by ensurePeerGain() so a relay-only peer (one that never
   fires ontrack, and so never reaches attachPlayback) still gets one.

   ── Capability gating ─────────────────────────────────────────────────────
   Output device selection, device enumeration, voice isolation and
   replaceTrack() are all optional. capabilities() reports what this engine
   actually has, and the settings UI hides what it cannot do rather than
   rendering a control that throws. The Android WebView is not desktop Chrome;
   nothing here may assume it is. */
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
  var micSrc = null;       // MediaStreamSource feeding the analyser
  var analyser = null;     // amplitude probe for open mic
  var levelBuf = null;

  /* ---- the shared output bus (see the header) ---- */
  var busIn = null;        // every peer gain connects here
  var masterGain = null;   // master volume + deafen
  var compNode = null;     // optional DynamicsCompressor
  var outNode = null;      // MediaStreamDestination, only for element sink routing
  var sinkEl = null;       // the one unmuted <audio> that carries setSinkId

  /* ---- per-rider levels. Session-scoped on purpose: rider ids are
     connection-scoped, so persisting this map would key on ids that do not
     survive a reconnect. Resets with the session, like any other call app. ---- */
  var peerVol = {};        // id -> 0..1
  var peerMuted = {};      // id -> true

  /* ---- rider-facing voice settings, mirrored from state so the audio graph
     never has to reach through A.state on a hot path ---- */
  var cfg = {
    voiceSelfMute: false,
    voiceDeafen: false,
    voiceOutVol: 1,
    voiceInputId: '',
    voiceOutputId: '',
    voiceEc: true,
    voiceNs: true,
    voiceAgc: true,
    voiceIsolation: false,
    voiceLeveler: false
  };

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

  /* ---------------- settings mirror ---------------- */
  function loadCfg() {
    var s = A.state && A.state.settings;
    if (!s) return cfg;
    Object.keys(cfg).forEach(function (k) { if (s[k] !== undefined) cfg[k] = s[k]; });
    return cfg;
  }
  function saveSetting(k, v) { if (ST && ST.setSetting) ST.setSetting(k, v); }
  function clamp01(v) {
    v = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(v)) return 1;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* ---------------- capability detection ----------------
     Asked before anything is built, so it reads prototypes rather than live
     objects wherever it can. The settings panel hides every control this
     returns false for — a missing API must never surface as a dead switch. */
  function mediaDevs() {
    return (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;
  }
  function supportedConstraints() {
    var md = mediaDevs();
    if (!md || !md.getSupportedConstraints) return {};
    try { return md.getSupportedConstraints() || {}; } catch (e) { return {}; }
  }
  function ctxSinkSupported() {
    if (ctx && typeof ctx.setSinkId === 'function') return true;
    var C = window.AudioContext || window.webkitAudioContext;
    return !!(C && C.prototype && typeof C.prototype.setSinkId === 'function');
  }
  function elSinkSupported() {
    if (typeof Audio !== 'function' || !Audio.prototype) return false;
    if (typeof Audio.prototype.setSinkId !== 'function') return false;
    // Element routing also needs somewhere to send the bus.
    var C = window.AudioContext || window.webkitAudioContext;
    return !!(C && C.prototype && typeof C.prototype.createMediaStreamDestination === 'function');
  }
  function replaceTrackSupported() {
    if (typeof RTCRtpSender === 'function' && RTCRtpSender.prototype) {
      return typeof RTCRtpSender.prototype.replaceTrack === 'function';
    }
    // No RTCRtpSender global to inspect — ask a live sender instead.
    var ids = Object.keys(peers);
    for (var i = 0; i < ids.length; i++) {
      var pc = peers[ids[i]] && peers[ids[i]].pc;
      if (pc && pc.getSenders) {
        var s = pc.getSenders()[0];
        if (s) return typeof s.replaceTrack === 'function';
      }
    }
    return true; // nothing to disprove it yet; the swap path checks per sender
  }
  function capabilities() {
    var md = mediaDevs();
    var sup = supportedConstraints();
    var C = window.AudioContext || window.webkitAudioContext;
    return {
      audio: !!C,
      devices: !!(md && md.enumerateDevices),
      inputPicker: !!(md && md.enumerateDevices && sup.deviceId),
      outputPicker: ctxSinkSupported() || elSinkSupported(),
      echoCancellation: !!sup.echoCancellation,
      noiseSuppression: !!sup.noiseSuppression,
      autoGainControl: !!sup.autoGainControl,
      voiceIsolation: !!sup.voiceIsolation,
      leveler: !!(C && C.prototype && typeof C.prototype.createDynamicsCompressor === 'function'),
      replaceTrack: replaceTrackSupported()
    };
  }

  /* ---------------- the output bus ---------------- */
  function ensureCtx() {
    if (ctx) return ctx;
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { ctx = new C(); } catch (e) { ctx = null; }
    return ctx;
  }

  function applyMaster() {
    if (!masterGain) return;
    masterGain.gain.value = cfg.voiceDeafen ? 0 : clamp01(cfg.voiceOutVol);
  }

  // Everything after masterGain. Re-run whenever the leveler toggles or the
  // sink element appears, since both change where the tail terminates.
  function rewireTail() {
    if (!masterGain || !ctx) return;
    try { masterGain.disconnect(); } catch (e) { }
    if (compNode) { try { compNode.disconnect(); } catch (e) { } }
    var out = outNode || ctx.destination;
    if (cfg.voiceLeveler && ctx.createDynamicsCompressor) {
      if (!compNode) compNode = ctx.createDynamicsCompressor();
      masterGain.connect(compNode);
      compNode.connect(out);
    } else {
      masterGain.connect(out);
    }
  }

  function ensureBus() {
    if (!ensureCtx()) return null;
    if (busIn) return busIn;
    busIn = ctx.createGain();
    busIn.gain.value = 1;
    masterGain = ctx.createGain();
    applyMaster();
    busIn.connect(masterGain);
    rewireTail();
    // A device chosen in a previous session applies as soon as there is a graph.
    if (cfg.voiceOutputId) applyOutputDevice();
    return busIn;
  }

  // A peer's own volume/mute node. Created here rather than in attachPlayback
  // because a relay-only peer never fires ontrack, and it still needs a gain.
  function ensurePeerGain(id) {
    var p = peers[id];
    if (!p) return null;
    if (p.gain) return p.gain;
    var bus = ensureBus();
    if (!bus) return null;
    var g = ctx.createGain();
    g.gain.value = peerLevel(id);
    g.connect(bus);
    p.gain = g;
    return g;
  }

  /* ---------------- per-rider volume + mute ---------------- */
  function peerLevel(id) {
    if (peerMuted[id]) return 0;
    var v = peerVol[id];
    return v === undefined ? 1 : clamp01(v);
  }
  function applyPeerGain(id) {
    var p = peers[id];
    if (p && p.gain) p.gain.gain.value = peerLevel(id);
  }
  function setPeerVolume(id, v) {
    if (!id) return 1;
    peerVol[id] = clamp01(v);
    applyPeerGain(id);
    return peerVol[id];
  }
  function setPeerMute(id, on) {
    if (!id) return false;
    if (on) peerMuted[id] = true; else delete peerMuted[id];
    applyPeerGain(id);
    return !!peerMuted[id];
  }
  function getPeerVolume(id) { var v = peerVol[id]; return v === undefined ? 1 : v; }
  function isPeerMuted(id) { return !!peerMuted[id]; }

  /* ---------------- master volume, deafen, leveler ---------------- */
  function setMasterVolume(v) {
    cfg.voiceOutVol = clamp01(v);
    saveSetting('voiceOutVol', cfg.voiceOutVol);
    applyMaster();
    return cfg.voiceOutVol;
  }
  function getMasterVolume() { return cfg.voiceOutVol; }
  // Silences every peer at once WITHOUT closing a single connection, so
  // undeafening is instant and nobody has to renegotiate.
  function setDeafen(on) {
    cfg.voiceDeafen = !!on;
    saveSetting('voiceDeafen', cfg.voiceDeafen);
    applyMaster();
    return cfg.voiceDeafen;
  }
  function isDeafened() { return !!cfg.voiceDeafen; }
  function setLeveler(on) {
    cfg.voiceLeveler = !!on;
    saveSetting('voiceLeveler', cfg.voiceLeveler);
    if (busIn) rewireTail();
    return cfg.voiceLeveler;
  }

  /* ---------------- output device ---------------- */
  function ensureSinkElement() {
    if (outNode || !ctx || !ctx.createMediaStreamDestination) return;
    outNode = ctx.createMediaStreamDestination();
    sinkEl = new Audio();
    sinkEl.autoplay = true;
    sinkEl.srcObject = outNode.stream;
    var p = sinkEl.play();
    if (p && p.catch) p.catch(function () { });
    rewireTail();
  }

  // Returns a result object rather than throwing: "this browser cannot do it"
  // is a normal answer here, and the caller hides the control instead.
  function applyOutputDevice() {
    var id = cfg.voiceOutputId || '';
    if (!ctx) return Promise.resolve({ ok: true, applied: false, reason: 'no-context' });
    if (typeof ctx.setSinkId === 'function') {
      try {
        return Promise.resolve(ctx.setSinkId(id))
          .then(function () { return { ok: true, applied: true, via: 'context' }; })
          .catch(function (e) { return { ok: false, applied: false, reason: String(e) }; });
      } catch (e) {
        return Promise.resolve({ ok: false, applied: false, reason: String(e) });
      }
    }
    if (elSinkSupported()) {
      ensureSinkElement();
      if (sinkEl && typeof sinkEl.setSinkId === 'function') {
        try {
          return Promise.resolve(sinkEl.setSinkId(id))
            .then(function () { return { ok: true, applied: true, via: 'element' }; })
            .catch(function (e) { return { ok: false, applied: false, reason: String(e) }; });
        } catch (e) {
          return Promise.resolve({ ok: false, applied: false, reason: String(e) });
        }
      }
    }
    return Promise.resolve({ ok: false, applied: false, reason: 'unsupported' });
  }

  function setOutputDevice(id) {
    cfg.voiceOutputId = id || '';
    saveSetting('voiceOutputId', cfg.voiceOutputId);
    return applyOutputDevice();
  }

  /* ---------------- device list ----------------
     Labels come back empty until the mic has been granted once — that is a
     browser privacy rule, not a bug, so report it and let the UI ask. */
  function listDevices() {
    var md = mediaDevs();
    var empty = { supported: false, inputs: [], outputs: [], labelled: false };
    if (!md || !md.enumerateDevices) return Promise.resolve(empty);
    return md.enumerateDevices().then(function (list) {
      var inputs = [], outputs = [], labelled = false;
      (list || []).forEach(function (d) {
        if (d.label) labelled = true;
        var row = { id: d.deviceId, label: d.label || '' };
        if (d.kind === 'audioinput') inputs.push(row);
        else if (d.kind === 'audiooutput') outputs.push(row);
      });
      return { supported: true, inputs: inputs, outputs: outputs, labelled: labelled };
    }).catch(function () { return empty; });
  }

  /* ---------------- mic constraints ----------------
     Built from settings, then filtered through what the engine says it
     supports. An unsupported key is dropped rather than sent: some engines
     reject the whole request over one unknown constraint. */
  function micConstraints() {
    var sup = supportedConstraints();
    var a = {};
    if (sup.echoCancellation) a.echoCancellation = !!cfg.voiceEc;
    if (sup.noiseSuppression) a.noiseSuppression = !!cfg.voiceNs;
    if (sup.autoGainControl) a.autoGainControl = !!cfg.voiceAgc;
    if (sup.voiceIsolation) a.voiceIsolation = !!cfg.voiceIsolation;
    if (sup.deviceId && cfg.voiceInputId) a.deviceId = { exact: cfg.voiceInputId };
    return { audio: Object.keys(a).length ? a : true, video: false };
  }

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
    loadCfg();
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (e) {
      // A remembered device that has since been unplugged fails with an
      // over-constrained error, not a permission one. Drop the deviceId and
      // take the system default rather than leaving the rider with no voice.
      if (cfg.voiceInputId) {
        cfg.voiceInputId = '';
        saveSetting('voiceInputId', '');
        try {
          stream = await navigator.mediaDevices.getUserMedia(micConstraints());
          if (A.ui) A.ui.toast('Microphone changed — using default', 'warn');
        } catch (e2) { stream = null; }
      }
      if (!stream) {
        // Only toast the first failure — the proximity poll would otherwise
        // re-attempt (and re-toast) every few seconds after a denial.
        if (!micDenied && A.ui) A.ui.toast('Mic permission denied. Voice off', 'warn');
        micDenied = true;
        return false;
      }
    }
    micTrack = stream.getAudioTracks()[0];
    micTrack.enabled = false; // start muted; PTT/open/toggle gates open it

    if (!ensureCtx()) return false;
    if (ctx.state === 'suspended') await ctx.resume();
    ensureBus();
    rebuildMicTaps();
    return true;
  }

  // (Re)build everything that reads the local mic: the open-mic amplitude probe
  // and, when it is already running, the relay sender. Called on first
  // acquisition and after any device or constraint swap, since both replace the
  // MediaStream the old taps were bound to.
  function rebuildMicTaps() {
    if (!ctx || !stream) return;
    if (micSrc) { try { micSrc.disconnect(); } catch (e) { } micSrc = null; }
    micSrc = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    levelBuf = new Uint8Array(analyser.frequencyBinCount);
    micSrc.connect(analyser);
    if (relayScriptNode) {
      try { relayScriptNode.disconnect(); } catch (e) { }
      relayScriptNode = null;
      ensureRelayScript();
    }
  }

  function releaseMic() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (micSrc) { try { micSrc.disconnect(); } catch (e) { } micSrc = null; }
    micTrack = null;
    analyser = null;
    levelBuf = null;
  }

  /* ---------------- transmitting gate ---------------- */
  // True when the mic should be live right now given the current mode.
  function shouldTransmit() {
    if (!micTrack) return false;
    // Self-mute outranks every mode. It is the one control a rider reaches for
    // when they need to be certain they are off, so it cannot be a mode that
    // open-mic amplitude or a stuck PTT key can talk its way past.
    if (cfg.voiceSelfMute) return false;
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

  /* ---------------- self-mute ---------------- */
  // Cuts transmission immediately rather than waiting for the ~30 Hz gate poll,
  // and clears the mode gates so releasing PTT later cannot un-mute by accident.
  function setSelfMute(on) {
    cfg.voiceSelfMute = !!on;
    saveSetting('voiceSelfMute', cfg.voiceSelfMute);
    if (cfg.voiceSelfMute) {
      pttHeld = false;
      toggleOn = false;
      openHotUntil = 0;
      if (micTrack) micTrack.enabled = false;
      if (lastMicState) { lastMicState = false; announceMic(false); updateUi(false); }
    }
    updateMuteUi();
    return cfg.voiceSelfMute;
  }
  function isSelfMuted() { return !!cfg.voiceSelfMute; }
  function toggleSelfMute() {
    gestureResume();
    var next = setSelfMute(!cfg.voiceSelfMute);
    if (A.ui) A.ui.toast(next ? 'Mic muted' : 'Mic unmuted', 'info');
    return next;
  }

  /* Live input level 0..1, for the settings meter. */
  function level() { return measureRMS(); }

  /* ---------------- swapping the local mic mid-call ----------------
     The call must survive this. replaceTrack() swaps the outgoing track inside
     the existing connection with no renegotiation and no gap in the session;
     only a peer whose sender cannot do it falls back to add-track-and-offer. */
  async function adoptStream(next) {
    var newTrack = next && next.getAudioTracks ? next.getAudioTracks()[0] : null;
    if (!newTrack) return { ok: false, applied: false, reason: 'no-track' };
    newTrack.enabled = micTrack ? !!micTrack.enabled : false;

    var old = stream;
    var oldTrack = micTrack;
    stream = next;
    micTrack = newTrack;

    var renegotiate = [];
    Object.keys(peers).forEach(function (id) {
      var p = peers[id];
      if (!p || !p.pc || !p.pc.getSenders) return;
      var swapped = false;
      p.pc.getSenders().forEach(function (s) {
        if (s.track && s.track.kind && s.track.kind !== 'audio') return;
        if (typeof s.replaceTrack === 'function') {
          try { s.replaceTrack(newTrack); swapped = true; } catch (e) { }
        }
      });
      if (!swapped && p.hasLocalTrack) renegotiate.push(id);
    });
    renegotiate.forEach(function (id) {
      var p = peers[id];
      try {
        stream.getTracks().forEach(function (t) { p.pc.addTrack(t, stream); });
        p.hasLocalTrack = true;
        makeOffer(id, p);
      } catch (e) { p.relayOnly = true; }
    });

    rebuildMicTaps();
    if (old) {
      try {
        old.getTracks().forEach(function (t) { if (t !== newTrack) t.stop(); });
      } catch (e) { }
    }
    if (oldTrack && oldTrack !== newTrack && oldTrack.readyState !== 'ended') {
      try { oldTrack.stop(); } catch (e) { }
    }
    return { ok: true, applied: true, renegotiated: renegotiate.length };
  }

  async function setInputDevice(id) {
    var prev = cfg.voiceInputId;
    cfg.voiceInputId = id || '';
    saveSetting('voiceInputId', cfg.voiceInputId);
    if (!stream) return { ok: true, applied: false, reason: 'mic-not-open' };
    var next;
    try {
      next = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (e) {
      // Keep the call alive on the old device and put the setting back, rather
      // than leaving the rider silent on a microphone that would not open.
      cfg.voiceInputId = prev;
      saveSetting('voiceInputId', prev);
      if (A.ui) A.ui.toast('Could not switch microphone — keeping the current one', 'warn');
      return { ok: false, applied: false, reason: String(e) };
    }
    return await adoptStream(next);
  }

  /* ---------------- enhancement toggles ----------------
     applyConstraints() retunes the live track with no gap, which is what a
     rider expects mid-call. Engines that refuse it get a full re-acquire. */
  var ENHANCEMENTS = {
    ec: 'voiceEc', echoCancellation: 'voiceEc',
    ns: 'voiceNs', noiseSuppression: 'voiceNs',
    agc: 'voiceAgc', autoGainControl: 'voiceAgc',
    isolation: 'voiceIsolation', voiceIsolation: 'voiceIsolation'
  };
  async function setEnhancement(key, on) {
    var k = ENHANCEMENTS[key];
    if (!k) return { ok: false, applied: false, reason: 'unknown-enhancement' };
    cfg[k] = !!on;
    saveSetting(k, cfg[k]);
    if (!stream || !micTrack) return { ok: true, applied: false, reason: 'mic-not-open' };
    var want = micConstraints().audio;
    if (typeof micTrack.applyConstraints === 'function') {
      try {
        await micTrack.applyConstraints(want);
        return { ok: true, applied: true, via: 'applyConstraints' };
      } catch (e) { /* fall through to a re-acquire */ }
    }
    try {
      var next = await navigator.mediaDevices.getUserMedia(micConstraints());
      var r = await adoptStream(next);
      r.via = 'reacquire';
      return r;
    } catch (e) {
      return { ok: false, applied: false, reason: String(e) };
    }
  }
  function getEnhancement(key) {
    var k = ENHANCEMENTS[key];
    return k ? !!cfg[k] : false;
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
    // Build the volume node with the peer, not when their first audio arrives.
    // A rider can be muted from the member list before they have ever spoken,
    // and a control that only starts existing once you have heard someone is
    // the wrong way round.
    ensurePeerGain(id);
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
    if (peer.snd) { try { peer.snd.disconnect(); } catch (e) { } }
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    // Chrome/WebView quirk: a remote WebRTC audio track is SILENT through
    // WebAudio alone — the stream must also be bound to an HTMLAudioElement to
    // start flowing. Bind a muted one (the audible path stays the gain graph,
    // which keeps per-peer volume control).
    var el = peer.el || (peer.el = new Audio());
    el.muted = true;
    el.srcObject = remoteStream;
    var p = el.play(); if (p && p.catch) p.catch(function () {});
    var gain = ensurePeerGain(id);
    if (!gain) return;
    var src = ctx.createMediaStreamSource(remoteStream);
    src.connect(gain);
    peer.src = src; peer.snd = src;
  }

  function playRelayChunk(fromId, b64, rate) {
    // Scope check: convoy members always play; unknown senders only when they
    // qualify as a proximity peer (the server relays coarsely — exact mode
    // filtering is ours).
    if (members.indexOf(fromId) < 0 && !adoptProxPeer(fromId)) return;
    if (!ensureCtx()) return;
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
      // Through the peer's own gain node, NOT straight to the destination.
      // Connecting to ctx.destination here is what made per-rider mute and
      // volume silently inert on the relay path — the fallback that carries the
      // call precisely when P2P has already failed.
      var gain = ensurePeerGain(fromId);
      if (!gain) return;
      srcNode.connect(gain);
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
      try { if (p.gain) p.gain.disconnect(); } catch (e) { }
      try { if (p.el) { p.el.pause(); p.el.srcObject = null; } } catch (e) { }
    });
    peers = {};
    // Per-rider levels are session state by design — a rider you muted an hour
    // ago on a connection id that no longer exists should not stay muted.
    peerVol = {};
    peerMuted = {};
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
        try { if (p.gain) p.gain.disconnect(); } catch (e) { }
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
    try { if (p.gain) p.gain.disconnect(); } catch (e) { }
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
    // Mic mute. Deliberately its own control rather than a fourth mic mode:
    // "am I off?" has to be answerable at a glance, without reading a mode.
    var mute = document.getElementById('wt-mute');
    if (mute && !mute.dataset.wired) {
      mute.dataset.wired = '1';
      mute.addEventListener('click', function (e) { e.stopPropagation(); toggleSelfMute(); });
    }
    updateMuteUi();
    wireSpaceKey();
  }

  // The Space listeners go on `document`, so they cannot be re-added per button:
  // rebuilding #wt-ptt clears its dataset.wired flag, and every reopen of the
  // overlay used to stack another keydown/keyup pair, firing PTT once per
  // stacked listener. Bind them once for the life of the module instead.
  var spaceWired = false;
  function wireSpaceKey() {
    if (spaceWired) return;
    spaceWired = true;
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
    // waiting for speech — a steady ring so you know the mic is hot. A muted
    // mic is never armed, whatever the mode would otherwise say.
    var armed = !cfg.voiceSelfMute && ((mode === 'toggle' && toggleOn) || (mode === 'open' && active));
    btn.classList.toggle('wt-on', !!armed && !transmitting);
  }

  function updateMuteUi() {
    var b = document.getElementById('wt-mute');
    if (!b) return;
    b.classList.toggle('wt-muted', !!cfg.voiceSelfMute);
    b.setAttribute('aria-pressed', cfg.voiceSelfMute ? 'true' : 'false');
    b.setAttribute('aria-label', cfg.voiceSelfMute ? 'Unmute microphone' : 'Mute microphone');
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
    // Mirror the rider's saved voice settings before anything can build a graph.
    loadCfg();
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
    onPeerMic: onPeerMic,

    /* ---- rider controls (js/ui.js reaches voice only through this object) ---- */
    capabilities: capabilities,   // what this engine can actually do; hide the rest
    reloadSettings: loadCfg,
    setSelfMute: setSelfMute,
    toggleSelfMute: toggleSelfMute,
    isSelfMuted: isSelfMuted,
    setDeafen: setDeafen,
    isDeafened: isDeafened,
    setMasterVolume: setMasterVolume,
    getMasterVolume: getMasterVolume,
    setLeveler: setLeveler,
    isLeveler: function () { return !!cfg.voiceLeveler; },
    setInputDevice: setInputDevice,
    getInputDevice: function () { return cfg.voiceInputId; },
    setOutputDevice: setOutputDevice,
    getOutputDevice: function () { return cfg.voiceOutputId; },
    listDevices: listDevices,
    setEnhancement: setEnhancement,
    getEnhancement: getEnhancement,
    setPeerVolume: setPeerVolume,
    getPeerVolume: getPeerVolume,
    setPeerMute: setPeerMute,
    isPeerMuted: isPeerMuted,
    peerIds: function () { return Object.keys(peers); },
    level: level,                 // 0..1 input level, for the settings meter

    /* Test seam: the graph is the contract these controls rest on, and it is
       not otherwise observable from outside the module. */
    _graph: function () {
      return { ctx: ctx, busIn: busIn, master: masterGain, comp: compNode, out: outNode, sinkEl: sinkEl, peers: peers };
    }
  };
})();
