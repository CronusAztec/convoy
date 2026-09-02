# Plan: Overhaul Convoy voice chat — one audio bus, real controls

One-line goal: riders get mute, per-rider volume, mic/output device pickers and
enhancement toggles that work on **both** voice transports, replacing a feature
that today ships a single setting and silently ignores volume whenever the relay
fallback is carrying the call.

## Execution record

Phases 1–9 are done and proven. Phase 10 is done except its final step.

- `node test/run.js` → **19 suites, all passing**, including the new
  `test/voice.test.js` (127 checks of its own).
- Verified in the running app at `http://localhost:5173`: the module loads with
  no console errors, all 11 new `A.voice` members are present, the settings
  panel renders every new control, and clicking them moves module state, the
  saved settings blob, and the walkie overlay button together.
- Stamped: 44 assets bumped to `?v=cy109`, `versionName "1.0.109"`,
  `npm run copy-web` run so `www/` matches.
- **Not done, and not doable from here:** the real two-tab audio call. Microphone
  capture is blocked in this browser (`navigator.permissions` reports `denied`
  and `getUserMedia` throws `NotAllowedError`), so no audio can be captured or
  heard. What was verified instead is that the denied-mic path degrades cleanly:
  no throw, no console error, the session correctly stays inactive, and mute,
  volume and `capabilities()` all keep working with no audio graph at all. The
  listening checks under **Verification** remain for a human with a microphone.
- Also not done: anything on a real Android device. `adb` is absent (verified),
  so [A1] is still an assumption, covered only by the removed-capability tests.

## Classification

Track: **Feature** (code exists — `js/voice.js`, 709 lines, is the thing being
overhauled). One correctness defect is folded in because the requested controls
cannot work without fixing it: relay audio bypasses the per-peer gain node.

Parked secondary asks, named, not dropped:

- **Button-by-button verification sweep of the whole app** — the previous ask.
  201 interactive handlers across 41 modules (verified: greps over `js/*.js`).
  Untouched by this plan except that Phase 10 sweeps the voice surface.
- **Transport replacement** (SFU, mesh redesign) — explicitly out, see Approach.
- **Native Android audio routing** (earpiece / speaker / Bluetooth SCO via
  `AudioManager`) — out, see Risks. It would require a Play release, not an OTA push.

## Interview Ledger

- Q1 what should the plan cover → superseded; the ask was redirected twice
- Q2 access grant → Supabase MCP connected, VPS reached over HTTPS, Resend unavailable
- Q3 Android device in the loop → superseded by the pivot to voice chat
- Q4 how deep does "complete change" cut → **accepted Recommended**: keep the
  mesh-plus-relay transport, rebuild the control surface and the audio graph
- "do it" → exit signal; everything still open was defaulted and tagged below

Questions spent: 4 of 14.

## Goal & Success Criteria

1. A rider can mute their own mic from the walkie overlay in one tap, and other
   riders stop hearing them within one audio frame.
2. A rider can mute or set the volume of **one specific other rider**, and it
   holds whether that rider's audio arrives over WebRTC **or** the relay.
3. A rider can pick which microphone is used from a list of their input devices,
   and switching does not drop the call.
4. A rider can pick which output device is used where the browser supports it,
   and where it does not the control is absent rather than broken.
5. A rider can turn echo cancellation, noise suppression and auto gain on or off
   independently, and the change takes effect on the next mic acquisition.
6. A rider can set one master output volume and a "deafen" switch that silences
   every peer at once without dropping the session.
7. All of the above survive a page reload, except per-rider volume, which is
   session-scoped by design [A6].
8. `node test/run.js` reports every suite passing, with a new `voice.test.js`
   among them.

## Current State

- Voice is a WebRTC P2P mesh between convoy members with a WebSocket PCM relay
  fallback; three mic modes — push-to-talk hold, open-mic RMS gate at `0.04`,
  and toggle (verified: `js/voice.js` header comment and lines 15-17).
- Proximity voice auto-links riders around you — `off | radius | sight | road` —
  gated server-side by `voiceTargets()` and capped at 10 peers (verified:
  `server/server.js:1902-1930`, `VOICE_PROX_MAX = 10` at line 1906).
- The rider's entire voice control surface today is **one** segmented row,
  "Auto voice chat" (verified: `js/ui.js:2150-2164`), backed by the single
  settings key `proxVoice` (verified: `js/state.js:58`).
- A per-peer `GainNode` already exists in the graph, created at `1.0` and never
  changed: `src.connect(gain).connect(ctx.destination)` (verified:
  `js/voice.js:262-264`).
- Each peer also owns a **muted** `HTMLAudioElement`, kept only because a remote
  WebRTC track is silent through WebAudio alone in Chrome/WebView (verified:
  `js/voice.js:255-259`).
- **Defect:** the relay fallback connects its decoded buffer straight to
  `ctx.destination`, bypassing that gain node entirely (verified:
  `js/voice.js:288-291`). Any volume or mute control built on the gain node is
  therefore inert exactly when P2P has failed.
- The mic is opened with `echoCancellation`, `noiseSuppression` and
  `autoGainControl` hardcoded `true`, with no `deviceId` (verified:
  `js/voice.js:62-63`). There is no `enumerateDevices` and no `setSinkId` call
  anywhere in the file (verified: grep over `js/voice.js`).
- Browser capability, measured this session inside the app's own page on Chrome 148:
  `AudioContext.prototype.setSinkId` = function,
  `HTMLMediaElement.prototype.setSinkId` = function,
  `createMediaStreamDestination` = function, `createDynamicsCompressor` = function,
  `navigator.mediaDevices.selectAudioOutput` = **undefined**. `enumerateDevices()`
  returns one `audioinput` and one `audiooutput`, both with **empty labels** until
  mic permission is granted. Supported constraints include `deviceId`,
  `echoCancellation`, `noiseSuppression`, `autoGainControl`, `channelCount`,
  `sampleRate` and `voiceIsolation` (verified: `javascript_tool` against
  `http://localhost:5173`).
- `android/app/src/main/java/tech/odoreeci/convoy/VoicePlugin.java` is 2,328
  bytes and exposes only `has()` and `ensure()` for the `RECORD_AUDIO`
  permission — no audio routing (verified: file listing and grep).
- Test harness: `test/harness.js` `installBrowser()` sets `AudioContext: null`
  and a `navigator` with no `mediaDevices`, and there is no `RTCPeerConnection`
  stub (verified: `test/harness.js:44-75`). `test/routegeo.test.js` is the
  pattern for driving a real client module under it (verified: that file).
- Asset convention: every asset in `index.html` carries `?v=cy108`, 44
  occurrences, and `android/app/build.gradle` tracks it as `versionName "1.0.108"`,
  which `release.js` re-syncs on an APK build (verified: grep on `index.html`,
  `android/app/build.gradle:19-24`). `www/index.html` is a stale copy at `cy107`,
  regenerated by `npm run copy-web` (verified: grep, `package.json` scripts).

## Scope (v1)

Rebuild the client-side audio graph and the rider-facing voice controls. Server
protocol, signalling, proximity gating and the relay budget are untouched — no
`server/*.js` change is in this plan.

## Out of Scope & Parked Items

- **Transport replacement.** The mesh and relay stay. Accepted at Q4.
- **Native Android output routing.** `AudioManager` work in `VoicePlugin.java`
  would make this overhaul un-shippable over OTA. Parked as its own follow-up.
- **Recording, voice effects, spatial audio, transcription.** Not asked for.
- **Changing mic modes** (PTT / open / toggle) or the open-mic threshold. The
  three modes stay exactly as they are; only their controls get better placed.
- **Per-rider volume persistence across sessions.** See [A6].
- **The 201-control app-wide sweep.** Separate ask, parked above.

## Approach

Two structural moves; everything the rider sees hangs off them.

**Move 1 — one bus, two transports.** Today WebRTC audio and relay audio reach
`ctx.destination` by different routes, so a control on one is invisible to the
other. Build a single output chain once per session:

```
peer source (WebRTC MediaStreamSource | relay BufferSource)
      -> peer.gain        per-rider volume, per-rider mute
      -> busIn            shared GainNode
      -> masterGain       master volume, deafen
      -> [compressor]     optional, levels out loud riders
      -> ctx.destination
```

The relay path stops calling `srcNode.connect(ctx.destination)` and connects to
the same `peers[id].gain` the WebRTC path uses. Every control below then behaves
identically on both transports, which is the entire point of the move.

**Move 2 — a settings-driven mic.** `acquireMic()` stops hardcoding its
constraints and builds them from settings, including `deviceId`. Changing a mic
setting re-acquires the stream and republishes the new track onto every live
`RTCPeerConnection` through `RTCRtpSender.replaceTrack()`, so the call does not drop.

Output device selection uses `AudioContext.setSinkId()` where present, falls back
to routing the master through `createMediaStreamDestination()` into a single
unmuted `<audio>` element carrying `setSinkId()`, and where neither exists the
picker is not rendered at all.

Executor's choice, decide freely: internal function names, where new helpers sit
inside `js/voice.js`, exact CSS class names for new rows, and the wording of
sub-labels on settings rows.

## Requirements

- **R1** WHEN relayed audio is played for rider X THE SYSTEM SHALL route it
  through `peers[X].gain` rather than `ctx.destination`.
  *Acceptance:* `voice.test.js` asserts the buffer source's connect target is the
  peer gain node. Phase 2.
- **R2** WHEN the rider sets rider X's volume to 0, or mutes X, THE SYSTEM SHALL
  silence X on both transports.
  *Acceptance:* a test drives one WebRTC peer and one relay peer and asserts both
  gains read 0. Phase 6.
- **R3** WHEN the rider toggles self-mute THE SYSTEM SHALL set
  `micTrack.enabled = false` and emit `voice:mic {on:false}` to peers.
  *Acceptance:* a test asserts track state and the emitted message. Phase 4.
- **R4** WHEN the rider selects an input device THE SYSTEM SHALL re-acquire with
  that `deviceId` and call `replaceTrack()` on every sender, without tearing down
  any `RTCPeerConnection`.
  *Acceptance:* a test asserts peer count and `pc` identity are unchanged across a
  device switch, and that `replaceTrack` was called once per peer. Phase 4.
- **R5** WHEN the rider selects an output device AND `setSinkId` exists THE SYSTEM
  SHALL apply it; WHEN it does not exist THE SYSTEM SHALL NOT render the output picker.
  *Acceptance:* a test runs both with and without `setSinkId` on the fake context,
  asserting no throw and correct control visibility. Phase 5.
- **R6** WHEN echo cancellation, noise suppression, auto gain or voice isolation is
  toggled THE SYSTEM SHALL include the new value in the next `getUserMedia`
  constraint object, omitting any constraint the browser does not report in
  `getSupportedConstraints()`.
  *Acceptance:* a test asserts the constraint object for both a full-support and a
  reduced-support fake. Phase 4.
- **R7** WHEN "deafen" is on THE SYSTEM SHALL silence all peers while keeping every
  `RTCPeerConnection` open.
  *Acceptance:* a test asserts master gain 0 and peer count unchanged. Phase 5.
- **R8** WHEN the app reloads THE SYSTEM SHALL restore input device, output device,
  master volume, deafen, self-mute and all enhancement toggles from settings;
  per-rider volumes SHALL reset.
  *Acceptance:* a test writes settings, reloads the module, and reads them back. Phase 3.
- **R9** WHEN device labels are empty because permission has not been granted THE
  SYSTEM SHALL show a labelled prompt to allow the mic rather than a list of blank entries.
  *Acceptance:* observable in the settings panel before granting mic. Phase 7.
- **R10** WHEN any new voice control is used THE SYSTEM SHALL NOT change the
  behaviour of mic modes, proximity linking, or any server message shape.
  *Acceptance:* the existing 18 suites still pass unchanged. Phase 10.

## Key Decisions

- Keep the mesh + relay transport — (user, Q4 accepted)
- Unify both transports onto the per-peer gain node — (verified: `js/voice.js:262-264, 288-291`)
- Output device via `AudioContext.setSinkId()`, `<audio>.setSinkId()` as fallback,
  hidden when absent — (verified: both are functions on Chrome 148, and
  `selectAudioOutput` is undefined)
- No server change — (verified: every requirement is client-side; the
  `voice:relay` / `voice:signal` / `voice:mic` shapes at `server/server.js:2841-2892`
  stay as they are)
- No native change, so the whole overhaul ships over OTA — (verified: the
  `server/play.js` header states OTA cannot ship native code; `server/ota.js`
  exists and `/api/ota` answers 200 in production)
- Build the UI from the existing helpers `mkRow`, `mkField`, `mkToggle`,
  `mkSegmented`, `mkSelect` and a range input, matching the sonar block —
  (verified: `js/ui.js:111-227, 2177-2197, 2388`)
- Persist through `ST.setSetting(key, val)`, which refuses keys absent from
  `DEFAULT_SETTINGS`, so every new key must be declared there first —
  (verified: `setSetting` in `js/state.js`)

## Data & State Changes

No database, no server state, no migration. Client settings only, added to
`DEFAULT_SETTINGS` in `js/state.js` beside `proxVoice` (verified: `js/state.js:58`):

| Key | Default | Meaning |
|---|---|---|
| `voiceSelfMute` | `false` | mic muted |
| `voiceDeafen` | `false` | all incoming audio silenced |
| `voiceOutVol` | `1.0` | master output volume, 0..1 |
| `voiceInputId` | `''` | chosen mic `deviceId`; `''` = system default |
| `voiceOutputId` | `''` | chosen output `deviceId`; `''` = system default |
| `voiceEc` | `true` | echo cancellation |
| `voiceNs` | `true` | noise suppression |
| `voiceAgc` | `true` | auto gain control |
| `voiceIsolation` | `false` | Chrome `voiceIsolation` constraint, feature-detected |
| `voiceLeveler` | `false` | `DynamicsCompressor` on the master bus |

Settings persist through the `save()` path already in use, so the storage format
does not change. Unknown keys are ignored by older clients, and missing keys fall
back to the defaults above — both are existing behaviour of `setSetting` and
`DEFAULT_SETTINGS` (verified: `js/state.js`).

## Interfaces, Integrations & Credentials

- **No new external dependency.** Everything used — `getUserMedia`,
  `enumerateDevices`, `setSinkId`, `GainNode`, `DynamicsCompressorNode`,
  `RTCRtpSender.replaceTrack` — is platform API.
- **No new credentials.** No `${ENV_VAR}` is added.
- **Frozen contracts, must not move:** the WebSocket messages `voice:signal`,
  `voice:relay` (`{chunk, rate}`) and `voice:mic` (`{from, on, name}`), and the
  server-side scope gate `voiceTargets()` (verified: `server/server.js:2841-2892`).
  A client that changes any of these breaks against the deployed server.
- **`A.native.ensureMic()`** stays the Android permission gate and is called before
  every acquisition, unchanged (verified: `js/voice.js:52-59`).
- **`A.voice` is the module's only public surface.** It exports 18 members today
  and the UI reaches voice exclusively through it — `A.voice.setProxMode` at
  `js/ui.js:2158`, `A.voice.dropPeer` at `js/ui.js:1392` (verified:
  `js/voice.js:689-708`). **Every new setter must be added to that object**, or
  the settings panel cannot call it. New members: `setSelfMute`, `getSelfMute`,
  `setDeafen`, `setMasterVolume`, `setInputDevice`, `setOutputDevice`,
  `setPeerVolume`, `setPeerMute`, `setEnhancement(key, on)`, `listDevices`,
  `capabilities()` (the feature-detect table), and `level()` for the meter.
  Existing members keep their names and signatures — `js/ui.js` and the radar
  dock already call them.

## Edge Cases & Failure Handling

Default posture: degrade silently where the platform is the limit, toast loudly
where the rider's action failed.

- `setSinkId` missing → output picker not rendered; master volume and deafen still
  work. No toast; this is a platform fact, not an error.
- `enumerateDevices` returns blank labels (permission not yet granted) → show a
  single "Allow microphone to see your devices" row instead of blank options [R9].
- Chosen device disappears (unplugged) → fall back to system default, re-acquire,
  toast "Microphone changed — using default".
- `getUserMedia` rejects on a device switch → keep the previous track live, revert
  the setting, toast the failure. The call must not drop.
- `replaceTrack` unavailable on a peer → renegotiate that one peer only, leaving
  the others alone.
- `voiceIsolation` unsupported → omit from constraints, hide the toggle.
- Deafen on while a peer joins → the new peer's gain still routes through the muted
  master, so no special case is needed; a test pins it anyway.
- `AudioContext` suspended by autoplay policy → the existing `gestureResume()` path
  stays and is called from every new control (verified: `js/voice.js:516-521`).
- Relay chunk arrives for a peer with no gain node yet → create the peer chain
  first, exactly as `ensurePeer` already does (verified: `js/voice.js:275-278`).

## Risks, Landmines & Adaptations

- **Relay bypasses the gain node** → this is why Phase 2 precedes every control
  phase. Building the UI first would produce controls that appear to work and
  silently do not.
- **Android WebView is not Chrome 148.** Every capability above was measured on
  desktop Chrome 148 only → every new control is feature-detected at runtime and
  hidden when its API is absent, and Phase 9 is a dedicated degradation pass that
  runs the module against a fake with each capability removed. [A1]
- **Native audio routing would force a Play release.** `VoicePlugin.java` has no
  `AudioManager`, and OTA cannot ship native code → v1 is deliberately web-only so
  the whole overhaul reaches installed APKs over the OTA channel. The native work
  is parked as a named follow-up rather than scoped in.
- **Production is in maintenance mode, running uncommitted code, with an empty OTA
  channel** (verified: `/api/health` → `{"ok":true,"maintenance":true}`, `/api/ota`
  → `{"current":null,"history":[]}`, `git status`) → Phase 10 pushes nothing. It
  stops at a green suite and local verification, and names the ship steps for a
  human to run deliberately.
- **The local dev server writes to production Supabase** — boot logged "loaded 2
  accounts from Supabase (role: postgres)", the same 2 accounts the project holds
  (verified: `preview_logs`, `list_tables`) → no phase in this plan registers,
  deletes or mutates an account. Voice needs no auth beyond an existing session. If
  a phase ever needs a second signed-in rider, use the two existing accounts; do
  not create or delete any.
- **`BUGS.md` is stale** — dated 2026-07-05, and spot-checks found one entry fixed,
  one deliberately redesigned, and drifted line numbers (verified) → do not use it
  as a work list. One entry is still worth folding in: `frontend-004`, duplicated
  document-level Space listeners in `wirePttButton()`, which Phase 8 fixes while it
  is in that function anyway.
- **Residual risk: no device testing.** `adb` is not on PATH (verified) and no phone
  is attached → Android behaviour is reasoned and feature-detected, never observed.
  Phase 9's done-check is explicitly a code-and-fake check, and Verification names
  the manual on-device checks a human must run.

## Assumptions Ledger

| ID | Assumption | Basis | Blast radius if wrong | Check |
|----|-----------|-------|----------------------|-------|
| A1 | The Android WebView supports `enumerateDevices` and `deviceId` input selection, but may lack `setSinkId` | desktop Chrome 148 measured; the WebView version is unknown | Output picker hidden on the APK; the input picker may need hiding too | Phase 1 writes the feature-detect table; Phase 9 tests each capability removed |
| A2 | `RTCRtpSender.replaceTrack()` is available on every live peer | standard WebRTC surface, not measured this session | A device switch would drop and rebuild calls instead of swapping tracks | Phase 4 step 1 feature-detects and falls back to renegotiation |
| A3 | `voiceIsolation` is Chrome-only | it appears in this browser's `getSupportedConstraints()` (verified) but was not tested elsewhere | The toggle is hidden on other engines, which is the intended behaviour | The constraint is filtered through `getSupportedConstraints()` at build time |
| A4 | A `DynamicsCompressor` on the master bus is the right "sound enhancement" for loud riders | it is the only relevant node the platform offers here (verified: `createDynamicsCompressor` present) | The leveler feels wrong and gets switched off; it ships off by default | Phase 5 |
| A5 | No second live rider is needed to verify the graph | the fakes drive both transports directly | An integration bug escapes to the two-tab check | Phase 10 runs a real two-tab call |
| A6 | Per-rider volume should be session-scoped, not persisted | rider ids are connection-scoped in `peers`/`members` (verified: `js/voice.js`), so a persisted map would key on ids that do not survive | Riders re-mute someone each session | Phase 6; flip to persisted-by-account-handle on request |
| A7 | Bumping the cache-buster to `cy109` and `versionName "1.0.109"` is the right ship stamp | repo convention, 44 occurrences at `cy108` (verified) | Clients serve stale JS | Phase 10 step 2 |
| A8 | Mic input gain beyond the platform AGC is not wanted | not asked for, and AGC is already exposed as a toggle | A quiet rider stays quiet | Add a `voiceMicGain` node later; the chain has the slot |

## Open Items (none blocking)

- Whether the walkie overlay should also carry a compact output-volume slider or
  only mute — proceed with **mute plus a link into settings**, keeping the overlay
  a driving-safe two-button surface.
- Whether "deafen" should also stop transmitting — proceed with **no**; they are
  independent controls, matching how riders expect deafen to behave.
- Whether to show a live input level meter in settings — proceed with **yes**,
  reusing the existing `analyser` and `measureRMS()` (verified: `js/voice.js:110-123`).

## Verification

```
node test/run.js
```

Expect every suite passing, including the new `voice.test.js`.

```
node server/server.js
```

Then open `http://localhost:5173` in two tabs, both signed in as riders in the
same convoy:

- Talk from tab A; tab B hears it. Mute A's rider row in tab B; B goes silent
  while A's mic indicator still shows active.
- Self-mute in tab A from the walkie overlay; B stops hearing A within a second
  and A's chip stops showing as speaking.
- In tab B, deafen; every rider goes silent, the member list stays populated, and
  undeafening restores audio without a reconnect.
- Change the input device in tab A's settings while talking; B hears a brief gap
  at most, and the call does not drop.
- Reload tab A; every setting except per-rider volume comes back as it was.

How you personally confirm done: open the settings panel, find a "Voice chat"
block holding mute, deafen, output volume, input device, output device, the three
enhancement toggles and a live level meter, and confirm each one changes what you hear.

Manual, on a real Android device, because none of this can be verified from this
machine — `adb` is absent (verified):

- The output-device picker is hidden rather than broken.
- The input picker either lists devices or is hidden; it never lists blanks.
- Switching to a Bluetooth headset at the OS level still routes call audio.

## Build Phases

- [x] Phase 1: Pin the assumptions and build the audio fakes
    Done when: `node test/voice.test.js` runs and reports at least one passing
    check, driving the real `js/voice.js` under the harness.
    Steps:
    - Extend `test/harness.js` `installBrowser()` with a fake `AudioContext`
      recording `createGain`, `createBufferSource`, `createMediaStreamSource`,
      `createMediaStreamDestination`, `createDynamicsCompressor`, `destination`
      and every `connect()` edge, so a test can assert the graph shape.
    - Add a fake `navigator.mediaDevices` (`getUserMedia`, `enumerateDevices`,
      `getSupportedConstraints`) and a fake `RTCPeerConnection` with
      `getSenders()` and `replaceTrack`.
    - Make every fake capability individually removable — Phase 9 needs this.
    - Create `test/voice.test.js` on the `test/routegeo.test.js` pattern
      (`H.installBrowser()`, `H.loadModule('js/util.js')`, `H.loadModule('js/voice.js')`).
    - Add `'voice.test.js'` to the `suites` array in `test/run.js`.
    - Write the feature-detect table the client will use, recording which
      capabilities the fake defaults to.
    Covers: groundwork for R1-R10; checks: A1, A2, A3

- [x] Phase 2: One bus — route both transports through the per-peer gain
    Done when: `node test/voice.test.js` proves a relay chunk for peer X reaches
    `peers[X].gain` and never `ctx.destination` directly, and the existing 18
    suites still pass.
    Steps:
    - Write the failing test first: play a relay chunk, assert the connect edge.
    - Add `ensureBus()` building `busIn -> masterGain -> ctx.destination` once per
      `AudioContext`.
    - Change `attachPlayback()` so the peer gain connects to `busIn`, not
      `ctx.destination`.
    - Change `playRelayChunk()` so its `BufferSource` connects to the peer's gain
      node, creating the peer chain first when absent.
    - Leave the muted `<audio>` element per peer exactly as it is; it is the
      documented Chrome/WebView unstick, not dead code.
    Covers: R1

- [x] Phase 3: Declare and persist the settings
    Done when: a test writes each new key through `ST.setSetting`, reloads the
    state module, and reads the value back.
    Steps:
    - Add all ten keys from Data & State Changes to `DEFAULT_SETTINGS` in
      `js/state.js`, beside `proxVoice`, each with a one-line comment in the
      file's existing style.
    - Confirm `setSetting` accepts them; it refuses keys absent from the defaults.
    - Have `js/voice.js` read them at `init()` and apply them to the bus.
    - Extend the `A.voice` export object at `js/voice.js:689-708` with the new
      members listed under Interfaces, adding each one as its phase implements it.
      Nothing in `js/ui.js` can reach a setter that is not on that object.
    Covers: R8

- [x] Phase 4: Mic pipeline — self-mute, input device, enhancement toggles
    Done when: tests prove the constraint object reflects settings, unsupported
    constraints are omitted, self-mute flips `micTrack.enabled` and emits
    `voice:mic {on:false}`, and a device switch calls `replaceTrack` once per peer
    with every `pc` identity unchanged.
    Steps:
    - Write those four failing tests first.
    - Replace the hardcoded constraints at `js/voice.js:62-63` with a
      `micConstraints()` built from settings and filtered through
      `getSupportedConstraints()`.
    - Add `setSelfMute(on)` and `setInputDevice(id)`; the latter re-acquires and
      calls `replaceTrack()` on every sender, falling back to renegotiation where
      `replaceTrack` is absent [A2].
    - On acquisition failure, keep the old track, revert the setting, and toast.
    Covers: R3, R4, R6

- [x] Phase 5: Output — master volume, deafen, output device
    Done when: tests prove deafen zeroes master gain with peer count unchanged,
    volume maps to master gain, and `setOutputDevice` is a no-op that does not
    throw when `setSinkId` is absent from both the context and the element.
    Steps:
    - Write those failing tests first, running the last against a fake with
      `setSinkId` removed.
    - Add `setMasterVolume(v)` and `setDeafen(on)` over `masterGain`.
    - Add `setOutputDevice(id)`: try `ctx.setSinkId(id)`; else route the master
      through `createMediaStreamDestination()` into one unmuted `<audio>` and call
      `el.setSinkId(id)`; else return a "not supported" result the UI reads.
    - Add the optional `DynamicsCompressor` on the master bus, default off [A4].
    Covers: R5, R7

- [x] Phase 6: Per-rider volume and mute
    Done when: a test with one WebRTC peer and one relay peer proves muting each
    silences it on its own transport, and that values reset on a new session.
    Steps:
    - Write the failing test first, covering both transports — this is the
      requirement Phase 2 existed to make possible.
    - Add `setPeerVolume(id, v)` and `setPeerMute(id, on)` over `peers[id].gain`.
    - Keep the map session-scoped; do not persist [A6].
    - Apply the stored value inside `ensurePeer`/`attachPlayback` so a peer that
      reconnects mid-session keeps its setting.
    Covers: R2

- [x] Phase 7: The settings panel
    Done when: loading `http://localhost:5173`, opening Settings and reading the
    page shows a Voice chat block containing mute, deafen, output volume, input
    device, output device, the enhancement toggles and a level meter — and every
    control changes what you hear.
    Steps:
    - Rebuild the block at `js/ui.js:2150-2164`, keeping the existing "Auto voice
      chat" segmented row at its top.
    - Build rows with `mkRow`, `mkField`, `mkToggle`, `mkSegmented`, `mkSelect` and
      a range input, following the sonar block at `js/ui.js:2177-2197`.
    - Populate device lists from `enumerateDevices()`; when labels are blank,
      render one "Allow microphone to see your devices" row instead [R9].
    - Hide any control whose capability the feature-detect table reports absent.
    - Add the live level meter from the existing `analyser` and `measureRMS()`.
    Covers: R9, and the visible half of R3-R7

- [x] Phase 8: The walkie overlay
    Done when: with the overlay open, a mute control is present and one tap
    silences the mic, confirmed by reading the page and by tab B going quiet.
    Steps:
    - Add a mute button to `#wt-overlay` in `index.html` beside `#wt-ptt` and
      `#wt-cycle` (markup at `index.html:196-205`), with an `aria-label` and a
      pressed state, styled in `css/styles.css` beside the existing `.wt-*` rules.
    - Wire it in `wirePttButton()` in `js/voice.js`, and reflect self-mute state on
      the button whenever it changes from settings.
    - While in that function, fix `BUGS.md` `frontend-004`: guard the
      document-level Space keydown/keyup listeners with a module-level flag so
      reopening the overlay cannot stack duplicate pairs.
    Covers: R3

- [x] Phase 9: Degradation pass
    Done when: `node test/voice.test.js` passes once per capability-removed fake —
    no `setSinkId` anywhere, no `enumerateDevices`, no `replaceTrack`, and a
    reduced `getSupportedConstraints()` — with no throw and the documented fallback
    each time.
    Steps:
    - Add one test group per removed capability, using the removable fakes from Phase 1.
    - Fix whatever throws; prefer hiding a control over rendering a broken one.
    - Re-read every new `js/ui.js` control and confirm it is gated on the
      feature-detect table rather than on a user-agent string.
    - This phase is risky: the whole Android story rests on it and none of it can be
      observed on this machine. Run the Critique Engine — hand the diff plus this
      phase's acceptance criteria to a blind critic that did not write it, apply
      every blocker it returns, and loop to consensus or three rounds. Use whatever
      sub-agent or orchestration tooling is available.
    Covers: R5, R6, R10; checks: A1, A2, A3

- [ ] Phase 10: Green suite, stamped, and a real two-tab call
    Done when: `node test/run.js` reports every suite passing, and a real call
    between two browser tabs demonstrates every check in Verification.
    Steps:
    - Run the full suite; all 18 pre-existing suites must pass unchanged [R10].
    - Bump all 44 `?v=cy108` occurrences in `index.html` to `?v=cy109`, and
      `versionName` in `android/app/build.gradle` to `"1.0.109"` [A7].
    - Run `npm run copy-web` so `www/index.html` stops trailing at `cy107`.
    - Run the two-tab call and walk the Verification list [A5].
    - **Stop here.** Do not deploy, do not publish an OTA bundle, do not lift
      maintenance, do not touch Play. Production is in maintenance mode running
      uncommitted code (verified), and shipping is a human decision. Hand back:
      commit the work, then `node scripts/pack-ota.js` and the OTA publish
      documented in `DEPLOY.md` section 8.
    Covers: R10
