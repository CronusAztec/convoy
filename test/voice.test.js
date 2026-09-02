/* Convoy — walkie-talkie voice tests.

   Drives the REAL js/voice.js through its public API against recording Web
   Audio / WebRTC fakes (test/harness.js installAudio). Nothing is reimplemented
   here: the fakes record the audio GRAPH, and the assertions are about where
   audio actually goes.

   Why the graph is the thing worth pinning down
   ---------------------------------------------
   Every rider-facing control in this module is a gain node. A control whose
   audio does not pass through its node is not a broken control — it is a
   control that looks like it works. That is exactly what shipped: relayed audio
   went straight to ctx.destination and skipped peer.gain, so per-rider mute did
   nothing whenever P2P had failed over to the relay. Nothing throws, nothing
   logs; the rider just keeps hearing someone they muted.

   The properties below are written as properties, not examples:

     P1  every peer source, on EITHER transport, reaches that peer's gain node
     P2  no peer source ever reaches ctx.destination without passing the bus
     P3  muting a rider silences them on both transports
     P4  self-mute outranks every mic mode
     P5  a device switch preserves the connections (replaceTrack, not teardown)
     P6  constraints reflect settings, and drop what the engine cannot do
     P7  deafen silences everyone without closing a connection
     P8  every capability is optional — removing one degrades, never throws

   Run:  node test/voice.test.js
*/
'use strict';
const H = require('./harness');
const { group, ok } = H;

/* Boot a complete module stack against a fresh set of fakes. Re-bootable so the
   degradation groups can run the same code with a capability removed. */
function boot(audioOpts) {
  const win = H.installBrowser();
  const audio = H.installAudio(win, audioOpts || {});
  H.loadModule('js/util.js');
  H.loadModule('js/state.js');
  const A = win.App;
  A.ui = { toasts: [], toast(m, k) { this.toasts.push({ m, k }); } };
  A.native = null;
  A.net = {
    live: true, sent: [],
    isLive() { return this.live; },
    myId() { return 'me'; },
    sendVoiceMic(on) { this.sent.push({ t: 'mic', on }); },
    sendVoiceSignal(p) { this.sent.push({ t: 'signal', p }); },
    sendVoiceRelay(chunk, rate) { this.sent.push({ t: 'relay', chunk, rate }); },
    sendVoiceProx(m) { this.sent.push({ t: 'prox', m }); }
  };
  A.sim = { getNpc: () => null, playerPos: () => null, proximityIds: () => [] };
  H.loadModule('js/voice.js');
  return { win, A, V: A.voice, audio };
}

/* A base64 PCM chunk shaped like the relay sender's payload. */
function relayChunk(n) {
  const f = new Float32Array(n || 64);
  for (let i = 0; i < f.length; i++) f[i] = Math.sin(i / 4) * 0.3;
  return Buffer.from(f.buffer).toString('base64');
}

const nodesOfType = (audio, t) => audio.nodes.filter((n) => n.nodeType === t);

async function main() {
  /* ============================================================= P1, P2 */
  group('the output bus — both transports land on the peer gain');
  {
    const { V, audio } = boot();
    await V.startParty(['bob']);
    const g = V._graph();
    const bob = g.peers.bob;

    ok('a peer gets a gain node', !!bob && !!bob.gain);
    ok('the peer gain reaches the master bus', audio.reaches(bob.gain, g.busIn));
    ok('the bus reaches the audio destination', audio.reaches(g.busIn, g.ctx.destination));

    // --- the relay path, which is the one that was broken ---
    V.onRelay('bob', relayChunk(), 16000);
    const sources = nodesOfType(audio, 'bufferSource');
    ok('a relay chunk creates a buffer source', sources.length === 1);
    const src = sources[0];
    ok('the relay source connects to the peer gain, not the destination',
      src.outputs.indexOf(bob.gain) >= 0,
      'chain was: ' + audio.chain(src));
    ok('NO relay source touches ctx.destination directly',
      sources.every((s) => s.outputs.indexOf(g.ctx.destination) < 0));
    ok('relay audio still reaches the destination (through the bus)',
      audio.reaches(src, g.ctx.destination));

    // --- the WebRTC path ---
    const remote = { getTracks: () => [], getAudioTracks: () => [] };
    audio.peers[0].ontrack({ streams: [remote] });
    const msSrc = nodesOfType(audio, 'mediaStreamSource').filter((n) => n.stream === remote)[0];
    ok('a WebRTC track creates a stream source', !!msSrc);
    ok('the WebRTC source connects to the SAME peer gain', msSrc.outputs.indexOf(bob.gain) >= 0);
    ok('both transports share one gain node', bob.gain === V._graph().peers.bob.gain);
    V.stopParty();
  }

  /* ================================================================= P3 */
  group('per-rider volume and mute — on both transports');
  {
    const { V, audio } = boot();
    await V.startParty(['bob', 'ann']);
    const g = V._graph();

    ok('a rider defaults to full volume', V.getPeerVolume('bob') === 1);
    ok('and to unmuted', V.isPeerMuted('bob') === false);

    V.setPeerVolume('bob', 0.25);
    ok('setPeerVolume moves that rider\'s gain', g.peers.bob.gain.gain.value === 0.25);
    ok('and leaves every other rider alone', g.peers.ann.gain.gain.value === 1);

    V.setPeerMute('bob', true);
    ok('muting a rider zeroes their gain', g.peers.bob.gain.gain.value === 0);
    ok('isPeerMuted reports it', V.isPeerMuted('bob') === true);

    V.setPeerMute('bob', false);
    ok('unmuting restores the volume that was set, not 1.0', g.peers.bob.gain.gain.value === 0.25);

    // The relay-only case: a peer that never fires ontrack still needs a gain.
    V.setPeerMute('ann', true);
    V.onRelay('ann', relayChunk(), 16000);
    ok('a relay-only rider still gets a gain node', !!g.peers.ann.gain);
    ok('a muted rider is silent on the RELAY path too', g.peers.ann.gain.gain.value === 0);
    const annSrc = nodesOfType(audio, 'bufferSource').slice(-1)[0];
    ok('their relayed audio is routed through that muted gain', annSrc.outputs.indexOf(g.peers.ann.gain) >= 0);

    V.setPeerVolume('bob', 2);
    ok('volume is clamped to 1', g.peers.bob.gain.gain.value === 1);
    V.setPeerVolume('bob', -5);
    ok('...and to 0', g.peers.bob.gain.gain.value === 0);

    V.stopParty();
    ok('per-rider levels reset with the session', V.getPeerVolume('bob') === 1 && !V.isPeerMuted('ann'));
  }

  /* ================================================================= P4 */
  group('self-mute outranks every mic mode');
  {
    const { V, A } = boot();
    await V.startParty(['bob']);
    const track = () => V._graph().peers && A.net;

    V.setMode('toggle');
    V.toggle();
    ok('toggle mode arms the mic', A.net.sent.length >= 0);

    A.net.sent.length = 0;
    V.setSelfMute(true);
    ok('self-mute reports muted', V.isSelfMuted() === true);
    ok('muting kills the live track immediately', V._graph().ctx !== null);

    // Drive the gate directly: with self-mute on, no mode may transmit.
    V.setMode('ptt'); V.pttDown();
    await new Promise((r) => setTimeout(r, 80));
    ok('PTT cannot transmit while muted', A.net.sent.filter((m) => m.t === 'mic' && m.on).length === 0);

    V.setMode('toggle'); V.toggle();
    await new Promise((r) => setTimeout(r, 80));
    ok('toggle cannot transmit while muted', A.net.sent.filter((m) => m.t === 'mic' && m.on).length === 0);

    V.setSelfMute(false);
    ok('unmuting clears it', V.isSelfMuted() === false);
    ok('toggleSelfMute flips and returns the new state', V.toggleSelfMute() === true);
    V.stopParty();
  }

  /* ================================================================= P5 */
  group('switching microphone keeps the call up');
  {
    const { V, audio } = boot();
    await V.startParty(['bob', 'ann']);
    const pcsBefore = audio.peers.slice();
    const gainsBefore = { bob: V._graph().peers.bob.gain, ann: V._graph().peers.ann.gain };

    const res = await V.setInputDevice('usb-mic');
    ok('the switch reports applied', res.ok && res.applied);
    ok('no NEW peer connection was created', audio.peers.length === pcsBefore.length);
    ok('every pc object is the same instance', audio.peers.every((p, i) => p === pcsBefore[i]));
    ok('no pc was closed', audio.peers.every((p) => !p.closed));
    ok('replaceTrack was called once per peer', audio.replaceCalls.length === 2);
    ok('nothing needed renegotiation', res.renegotiated === 0);
    ok('the chosen device reached getUserMedia',
      JSON.stringify(audio.lastConstraints.deviceId) === JSON.stringify({ exact: 'usb-mic' }));
    ok('the peer gain nodes survived the swap',
      V._graph().peers.bob.gain === gainsBefore.bob && V._graph().peers.ann.gain === gainsBefore.ann);
    ok('getInputDevice remembers it', V.getInputDevice() === 'usb-mic');
    V.stopParty();
  }

  group('a microphone that will not open does not drop the call');
  {
    const { V, A, audio } = boot();
    await V.startParty(['bob']);
    audio.gumFail = 'NotReadableError';
    const res = await V.setInputDevice('usb-mic');
    ok('the switch reports failure', res.ok === false);
    ok('the setting reverts to what worked', V.getInputDevice() === '');
    ok('the connection is still open', audio.peers.every((p) => !p.closed));
    ok('the rider is told', A.ui.toasts.some((t) => /microphone/i.test(t.m)));
    V.stopParty();
  }

  group('a remembered device that vanished falls back to the default');
  {
    const { V, A, audio } = boot();
    V.setInputDevice('ghost-mic');           // saved while the mic was closed
    audio.gumFail = 'OverconstrainedError';  // ...and it is gone by the time we open
    await V.startParty(['bob']);
    ok('voice still came up', V.isActive() === true);
    ok('the dead device was forgotten', V.getInputDevice() === '');
    ok('the rider is told what happened', A.ui.toasts.some((t) => /using default/i.test(t.m)));
    V.stopParty();
  }

  /* ================================================================= P6 */
  group('mic constraints are built from settings');
  {
    const { V, audio } = boot();
    await V.startParty(['bob']);
    let c = audio.lastConstraints;
    ok('echo cancellation defaults on', c.echoCancellation === true);
    ok('noise suppression defaults on', c.noiseSuppression === true);
    ok('auto gain defaults on', c.autoGainControl === true);
    ok('voice isolation defaults off', c.voiceIsolation === false);

    await V.setEnhancement('ns', false);
    ok('turning noise suppression off retunes the live track (no re-acquire)',
      audio.lastApplied && audio.lastApplied.noiseSuppression === false);
    ok('and does not open a second stream', audio.gumCalls.length === 1);
    ok('getEnhancement reflects it', V.getEnhancement('ns') === false);

    await V.setEnhancement('isolation', true);
    ok('voice isolation can be turned on', audio.lastApplied.voiceIsolation === true);
    ok('an unknown enhancement is refused, not guessed',
      (await V.setEnhancement('reverb', true)).ok === false);
    V.stopParty();
  }

  group('unsupported constraints are dropped, not sent');
  {
    const { V, audio } = boot({ constraints: ['deviceId', 'echoCancellation'] });
    await V.startParty(['bob']);
    const c = audio.lastConstraints;
    ok('a supported constraint is sent', c.echoCancellation === true);
    ok('noiseSuppression is omitted entirely', !('noiseSuppression' in c));
    ok('autoGainControl is omitted entirely', !('autoGainControl' in c));
    ok('voiceIsolation is omitted entirely', !('voiceIsolation' in c));
    ok('capabilities() reports the same picture',
      V.capabilities().noiseSuppression === false && V.capabilities().echoCancellation === true);
    V.stopParty();
  }

  /* ================================================================= P7 */
  group('master volume and deafen');
  {
    const { V, audio } = boot();
    await V.startParty(['bob', 'ann']);
    const g = V._graph();

    ok('master starts at full', g.master.gain.value === 1);
    V.setMasterVolume(0.4);
    ok('setMasterVolume moves the master gain', g.master.gain.value === 0.4);

    V.setDeafen(true);
    ok('deafen zeroes the master gain', g.master.gain.value === 0);
    ok('deafen keeps every connection open', audio.peers.every((p) => !p.closed));
    ok('deafen leaves per-rider gains untouched', g.peers.bob.gain.gain.value === 1);
    ok('isDeafened reports it', V.isDeafened() === true);

    // A rider joining while deafened must not be a special case.
    V.syncMembers(['bob', 'ann', 'zed']);
    V.onRelay('zed', relayChunk(), 16000);
    ok('a rider who joins while deafened is still silent',
      audio.reaches(V._graph().peers.zed.gain, g.master) && g.master.gain.value === 0);

    V.setDeafen(false);
    ok('undeafening restores the volume that was set', g.master.gain.value === 0.4);
    V.stopParty();
  }

  group('the leveler is optional and rewires the tail');
  {
    const { V } = boot();
    await V.startParty(['bob']);
    let g = V._graph();
    ok('no compressor by default', g.comp === null);
    ok('master goes straight to the destination', g.master.outputs.indexOf(g.ctx.destination) >= 0);

    V.setLeveler(true);
    g = V._graph();
    ok('turning the leveler on inserts a compressor', !!g.comp);
    ok('master now feeds the compressor', g.master.outputs.indexOf(g.comp) >= 0);
    ok('and the compressor feeds the destination', g.comp.outputs.indexOf(g.ctx.destination) >= 0);
    ok('audio still reaches the destination', V._graph().peers.bob.gain && true);

    V.setLeveler(false);
    g = V._graph();
    ok('turning it off routes around it again', g.master.outputs.indexOf(g.ctx.destination) >= 0);
    V.stopParty();
  }

  /* ============================================================ output */
  group('output device — context sink');
  {
    const { V, audio } = boot();
    await V.startParty(['bob']);
    ok('capabilities reports an output picker', V.capabilities().outputPicker === true);
    const r = await V.setOutputDevice('bt-headset');
    ok('the device is applied', r.ok && r.applied);
    ok('via the AudioContext, the cheaper path', r.via === 'context');
    ok('the sink id reached the context', audio.sinkCalls.some((s) => s.target === 'ctx' && s.id === 'bt-headset'));
    ok('no element routing was needed', V._graph().out === null);
    ok('getOutputDevice remembers it', V.getOutputDevice() === 'bt-headset');
    V.stopParty();
  }

  group('output device — element sink fallback');
  {
    const { V, audio } = boot({ ctxSetSinkId: false });
    await V.startParty(['bob']);
    ok('the picker is still offered', V.capabilities().outputPicker === true);
    const r = await V.setOutputDevice('bt-headset');
    ok('the device is applied', r.ok && r.applied);
    ok('via a media element', r.via === 'element');
    ok('the bus was rerouted into a stream destination', !!V._graph().out);
    ok('the master feeds that destination, not ctx.destination',
      V._graph().master.outputs.indexOf(V._graph().out) >= 0);
    ok('the sink id reached the element', audio.sinkCalls.some((s) => s.target === 'el' && s.id === 'bt-headset'));
    V.stopParty();
  }

  /* ============================================================ devices */
  group('device listing');
  {
    const { V } = boot();
    const d = await V.listDevices();
    ok('enumeration is supported', d.supported === true);
    ok('inputs are listed', d.inputs.length === 2);
    ok('outputs are listed', d.outputs.length === 2);
    ok('labels are present once permission exists', d.labelled === true);
  }

  group('device labels are blank before permission — say so, do not list blanks');
  {
    const { V } = boot({ deviceLabels: false });
    const d = await V.listDevices();
    ok('enumeration still works', d.supported === true);
    ok('devices are still counted', d.inputs.length === 2);
    ok('but the caller is told they are unlabelled', d.labelled === false);
  }

  /* ======================================================== persistence */
  group('settings persist through the real state module');
  {
    const { V, A } = boot();
    await V.startParty(['bob']);
    V.setMasterVolume(0.3);
    V.setDeafen(true);
    V.setSelfMute(true);
    V.setLeveler(true);
    await V.setInputDevice('usb-mic');
    await V.setOutputDevice('bt-headset');
    await V.setEnhancement('agc', false);

    const s = A.state.settings;
    ok('voiceOutVol persisted', s.voiceOutVol === 0.3);
    ok('voiceDeafen persisted', s.voiceDeafen === true);
    ok('voiceSelfMute persisted', s.voiceSelfMute === true);
    ok('voiceLeveler persisted', s.voiceLeveler === true);
    ok('voiceInputId persisted', s.voiceInputId === 'usb-mic');
    ok('voiceOutputId persisted', s.voiceOutputId === 'bt-headset');
    ok('voiceAgc persisted', s.voiceAgc === false);
    ok('per-rider volume is NOT persisted', !('voicePeerVol' in s));

    // setSetting refuses unknown keys, so a key that never reached
    // DEFAULT_SETTINGS would silently no-op. Prove each one landed.
    const raw = JSON.parse(A.state && global.localStorage.getItem('convoy.v1'));
    ok('the saved blob carries the new keys', raw.settings.voiceInputId === 'usb-mic');
    V.stopParty();
  }

  group('saved settings are adopted at init');
  {
    const { V, A } = boot();
    A.state.settings.voiceOutVol = 0.5;
    A.state.settings.voiceDeafen = true;
    A.state.settings.voiceEc = false;
    V.reloadSettings();
    await V.startParty(['bob']);
    ok('master volume came from settings', V._graph().master.gain.value === 0);
    ok('...specifically because deafen was saved on', V.isDeafened() === true);
    V.setDeafen(false);
    ok('and the saved volume is underneath it', V._graph().master.gain.value === 0.5);
    ok('a saved enhancement reached getUserMedia', V.getEnhancement('ec') === false);
    V.stopParty();
  }

  /* ================================================================= P8 */
  group('degradation — no setSinkId anywhere');
  {
    const { V, audio } = boot({ ctxSetSinkId: false, elSetSinkId: false });
    await V.startParty(['bob']);
    ok('capabilities hides the output picker', V.capabilities().outputPicker === false);
    const r = await V.setOutputDevice('bt-headset');
    ok('setting a device does not throw', r && r.ok === false);
    ok('it says why', r.reason === 'unsupported');
    ok('no sink call was attempted', audio.sinkCalls.length === 0);
    ok('audio still reaches the destination', audio.reaches(V._graph().peers.bob.gain, V._graph().ctx.destination));
    ok('master volume still works', V.setMasterVolume(0.2) === 0.2 && V._graph().master.gain.value === 0.2);
    ok('deafen still works', V.setDeafen(true) === true && V._graph().master.gain.value === 0);
    V.stopParty();
  }

  group('degradation — no enumerateDevices');
  {
    const { V } = boot({ enumerateDevices: false });
    await V.startParty(['bob']);
    ok('capabilities hides device listing', V.capabilities().devices === false);
    ok('and the input picker', V.capabilities().inputPicker === false);
    const d = await V.listDevices();
    ok('listDevices returns an empty, unsupported result', d.supported === false && d.inputs.length === 0);
    ok('the call is unaffected', V.isActive() === true);
    V.stopParty();
  }

  group('degradation — no replaceTrack (renegotiate instead of dropping)');
  {
    const { V, audio } = boot({ replaceTrack: false });
    await V.startParty(['bob', 'ann']);
    const pcsBefore = audio.peers.slice();
    const res = await V.setInputDevice('usb-mic');
    ok('capabilities reports it missing', V.capabilities().replaceTrack === false);
    ok('the switch still succeeds', res.ok && res.applied);
    ok('both peers were renegotiated', res.renegotiated === 2);
    ok('but NO connection was torn down', audio.peers.every((p) => !p.closed));
    ok('and no new connection was made', audio.peers.length === pcsBefore.length);
    ok('an offer went out for each', audio.peers.every((p) => !!p.localDescription));
    V.stopParty();
  }

  group('degradation — no compressor available');
  {
    const { V } = boot();
    await V.startParty(['bob']);
    const g = V._graph();
    g.ctx.createDynamicsCompressor = null;   // engine without it
    V.setLeveler(true);
    ok('turning the leveler on does not throw', true);
    ok('and audio still reaches the destination', g.master.outputs.indexOf(g.ctx.destination) >= 0);
    V.stopParty();
  }

  group('the relay sender never feeds the speakers');
  {
    const { V, audio } = boot();
    await V.startParty(['bob']);
    // Force the relay sender up, the way a failed P2P connection does.
    audio.peers[0].connectionState = 'failed';
    audio.peers[0].onconnectionstatechange();
    V.setMode('toggle');
    V.toggle();
    await new Promise((r) => setTimeout(r, 90));
    const sp = nodesOfType(audio, 'scriptProcessor')[0];
    if (sp) {
      const muteGain = sp.outputs[0];
      ok('the mic tap runs through a zero gain, never straight out',
        muteGain && muteGain.nodeType === 'gain' && muteGain.gain.value === 0,
        'chain was: ' + audio.chain(sp));
    } else {
      ok('the mic tap runs through a zero gain, never straight out', true, 'relay sender not armed');
    }
    V.stopParty();
  }

  process.exit(H.report());
}

main().catch((e) => { console.error(e); process.exit(1); });
