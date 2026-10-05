# 🏁 Convoy — ride together

A passenger-side map app: see live riders around you and across the world, talk to
the ones in range, form convoys with chat and walkie-talkie voice, and route to
wherever you are meeting. **Built for passengers** — the driver drives, you run the map.

Ships as a web app, an Android app (Google Play / APK) and an iOS app (App Store).

## Run it

| Mode | How | What you get |
|---|---|---|
| **LIVE (multiplayer)** | Double-click `start.bat` (or `node server/server.js`) → `http://localhost:5173` | Real riders via WebSocket + server bots, real convoys, chat and voice across devices |
| **Solo** | Double-click `index.html`, or serve with `python -m http.server 5173` | Same app, riders simulated on-device |
| **On your VPS** | See **[DEPLOY.md](DEPLOY.md)** | LIVE mode on the internet, HTTPS, auto-restart |
| **In the stores** | See **[STORE-RELEASE.md](STORE-RELEASE.md)** | Android App Bundle for Play, Xcode project for the App Store |

The client auto-detects: if the Convoy server answers on the same origin it goes live,
otherwise it falls back to solo. Two server dependencies (`ws`, `pg`), no API keys required.

## What it does

- **Live riders around you** — riders within 30 km stream in real time with smooth
  60 fps interpolation, drawn as their actual car in their colour. Tap a car for their
  profile card, wave, add them as a friend, or invite them to a convoy. Filter the
  Nearby list to riders within range, on your road, or in sight ahead.
- **Live drivers across the world** — a world-wide layer (amber, clustered) on a
  deliberately delayed feed, marked "~5 min delay". Toggle it from the globe button or
  the chip; stars, planets and the day/night line are drawn around the globe.
- **Proximity voice** — auto-link voice chat with the riders around you: within a
  radius, on your road, or in sight. Off by default; one setting turns it on.
- **Convoys** — create a named convoy, invite nearby riders or friends, see members
  tethered to you on the map with edge arrows when they are off screen, group chat, a
  rally point, an SOS button, kick/leave, join-by-code, and open/locked modes.
- **Walkie-talkie voice** — push-to-talk / open-mic / toggle with mute, deafen, per-rider
  volume, mic and output pickers and enhancement toggles. WebRTC P2P mesh (Opus) with a
  WebSocket PCM relay fallback. Never recorded.
- **Routes** — search any destination (Nominatim) or tap the map → driving routes via
  TomTom (traffic-aware, when the server has a key) with OSRM as the keyless fallback.
  Distance, duration, arrival time, a chase-camera trip player and optional spoken
  turn-by-turn navigation (self-hosted Piper neural TTS).
- **Accounts & friends** — register / log in / recover, or ride as a guest. Identity is
  Supabase Auth, proxied by the server so the secret key never reaches a client. Email
  confirmation gates the social layer; social sign-in (Google, Apple, GitHub, Discord,
  Microsoft and the rest of Supabase's providers) works on the web, in the Android app
  (Custom Tab + deep link) and in the iOS app (SFSafariViewController + URL scheme).
  See [DEPLOY.md](DEPLOY.md).
- **Invisible mode** — hide from every rider outside your convoy, including the global
  feed; proximity voice pauses while you are hidden.
- **Profile & garage** — name, handle, avatar (photo screened on-device), vibe, and your
  car: year / make / model / paint / finish / body / engine / trans / drive / hp / mods.
- **Block & report** — from any rider card or chat line, both ways, with a blocked list
  in Settings. Required by both stores for an app with user-generated content.
- **Settings** — themes (11, plus a custom builder), accents, map style, miles/km,
  global-drivers toggle, follow camera, animation and glass-blur toggles, voice
  navigation and navigator voice, voice-chat controls, invisible mode, crash-report
  opt-out, account deletion.
- **Crash reporting & core-loop analytics** — global error + rejection handlers that post
  stacks, breadcrumbs and a fixed funnel to our own server. No location, no messages,
  no username; per-rider opt-out in Settings. Optionally mirrors to Sentry via a DSN.

## How live mode works

- The Node server ([server/server.js](server/server.js)) serves the app **and** a WebSocket
  on `/ws`. Riders within 30 km of each other (configurable) stream positions at 1 Hz;
  the client interpolates to 60 fps. A fast lane refreshes your nearest riders several
  times a second, and a per-viewer wire gate suppresses rows that have not moved.
- **Server bots** (`BOTS` env, default 0) anchor near connected humans so a demo map
  never feels empty — they accept invites, trail your convoy in formation, reply in chat,
  and wave back.
- The **global layer** is genuinely delayed in live mode: the server snapshots all riders
  and replays positions ~5 minutes old, jittered 100–400 m.
- **Accounts, friends, convoys, invites, kicks, chat, waves, voice signalling, voice relay
  and proximity-voice matching** are all server-authoritative with rate limits, input
  sanitization, and per-IP ceilings.
- **Routing** is optionally server-proxied: set `TOMTOM_KEY` on the server and the client
  automatically uses traffic-aware TomTom routes (via `/api/route`). With no key set it
  degrades to keyless OSRM — the key never ships in client JS.
- **Spoken nav** uses a self-hosted Piper neural TTS served from `/api/tts`
  (`TTS_DIR`/`TTS_BIN`/`TTS_MODEL` env; absent → text nav cues only).

## Feature packs

The store build is the core above. The features withdrawn for store review —
enforcement awareness (aircraft, police and camera layers, the radar HUD,
police-avoiding routes), police scanner audio, the performance timers and
racing, map overlays, the instrument HUD with drive log and saved places — live
under [packs/](packs/README.md) and are **served by the server to an account that
has redeemed a code** (Settings → Feature packs). Nothing under `packs/` is
bundled into the APK, the IPA or an OTA zip; `js/packs.js` is a loader only.
Codes are minted on `/admin/packs`, grants managed per account on
`/admin/account/<id>`, and every pack has a `pack:<id>` kill switch on
`/admin/flags`. Why it is built this way, and what it means for review, is in
[STORE-RELEASE.md](STORE-RELEASE.md#feature-packs-and-the-stores).

## Honest notes

- In **solo mode** riders/chat are simulated on-device; nothing leaves the browser. Voice
  and friends require the live server (and an account, for friends).
- **Guests** (no account) can ride, route, and convoy, but can't add friends or persist a
  profile across devices. Anyone with the URL can join as a guest — see DEPLOY.md to lock it down.
- Routing/search use free public services (OSRM, Nominatim) — fine for development, not
  for production traffic. TomTom routing needs your own `TOMTOM_KEY` (free tier available).
- Map tiles are free CARTO / OpenFreeMap basemaps (attribution required, shown on-map).
- **Diagnostics are on by default.** Crashes and a fixed funnel go to your own server
  (`TELEMETRY=0` turns it off; riders get their own switch in Settings). Reports carry a
  random per-launch session id and never a position, a destination, a message or an account.
  The dashboard at `/api/telemetry/stats` stays 404 until you set `TELEMETRY_TOKEN`.
- The iOS app does not take OTA web-bundle updates (that plugin is Android-only today);
  iOS fixes ship through App Store Connect.

## Tests

`npm test` runs the unit suites — no server, no network, no database.
`npm run test:frontend` runs the jsdom + axe-core + html-validate suite with a
ratchet on `test/frontend-baseline.json`. `npm run gate` runs both.

Three suites are deliberately **not** in that run, because they need a live server
and a real Supabase project. They register throwaway accounts and delete them in
a `finally` block whatever happens:

```bash
node server/server.js        # one terminal
npm run test:blocking        # blocking + reporting, end to end
npm run test:fuzz            # malformed frames at every ws handler
npm run test:concurrent      # simultaneous requests, invariant checks
```

`test:blocking` walks every path that reached another rider before it was closed —
the map, convoy roster and chat backlog, invites, waves, friend requests — and
asserts frame *ordering* where the order is what matters. `test:fuzz` **asserts
nothing**: it throws ~8k malformed frames at every handler from inside real convoy
and friend state, and the result is read from the *server's* output (after a run
the server should have logged neither `[handler …]` nor `[db] DROPPED …`).
`test:concurrent` fires simultaneous requests at the places a race can actually
exist and asserts **invariants** rather than winners.

## Legal

Convoy handles precise location, broadcasts it to strangers, and carries voice and
chat. That is a real compliance surface, so it has real documents.

| Document | Served at | Covers |
|---|---|---|
| [legal/terms.html](legal/terms.html) | `/terms` | Terms of Service + EULA — passenger-only condition, voice and recording consent, accuracy disclaimer, liability cap, indemnity |
| [legal/privacy.html](legal/privacy.html) | `/privacy` | GDPR Art. 13 notice — what we collect, who sees it, processors, retention, rights |
| [legal/delete-account.html](legal/delete-account.html) | `/delete-account` | Account-deletion URL both stores ask for — works without installing the app |
| [legal/notices.html](legal/notices.html) | `/notices` | Third-party licences + attribution (also [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)) |
| [SDK-INVENTORY.md](SDK-INVENTORY.md) | — | Every SDK and remote script in the app, what it collects, and the Play Data Safety / Apple App Privacy answers |
| [LICENSE](LICENSE) | — | The source is proprietary. Read it before you fork it. |

In the app:

- **A consent gate** stands in front of every entry path — register, guest and
  social sign-up alike. Three separate confirmations: *I'm the passenger*,
  *I'm 16+*, and *I agree to the Terms and Privacy Policy*. The result is stored
  with the document version and a timestamp (`js/state.js` → `LEGAL_VERSION`), so
  bumping that constant makes every rider re-accept before they can carry on.
- **Account deletion** lives in Settings → Legal & data, and at `/delete-account`
  for anyone without the app. It re-authenticates, erases the profile row
  (cascading to friends and recovery codes), deletes the GoTrue user, kicks any
  live socket, and tombstones the id so the stale access token can't walk back
  into account setup.

> **Before you ship publicly**, fill in the operator blanks — they are marked in
> red on every page and listed in [DEPLOY.md](DEPLOY.md#pre-launch-legal-checklist)
> — and walk [STORE-RELEASE.md](STORE-RELEASE.md).

## Structure

```
index.html              shell + layout
css/styles.css          design system (themes, glass, motion)
js/config.js            platform config (native vs web, platform, server base URL, lazy loaders)
js/data.js              cars, paints, names, cities (lazy)
js/util.js              geo math + DOM helpers + fetch deadlines + poll helper
js/state.js             state, persistence, theming, event bus, consent
js/themes.js            theme registry + custom theme builder
js/space.js             stars / planets / day-night around the globe
js/mapview.js           MapLibre: layers, markers, popups, camera
js/sim.js               rider engine: markers, interpolation, trips, solo physics
js/net.js               realtime client (auto-connect, solo fallback, caps probe)
js/routing.js           search, routing (TomTom proxy → OSRM fallback), trip lifecycle, spoken nav
js/wake.js              keep-screen-awake setting
js/party.js             convoys, invites, chat, rally point (server-backed when live)
js/riderarrows.js       edge arrows to off-screen convoy riders (lazy)
js/voice.js             walkie-talkie + proximity voice: WebRTC mesh + relay fallback (lazy)
js/ui.js                panels, dock, forms, settings, onboarding, consent gate, block & report
js/auth.js              register/login/guest/social, email links, session + refresh, boot gating
js/native.js            native bridge: background GPS, mic permission, sign-in deep links (Android + iOS); no-op on web
js/ota.js               OTA web-bundle updates (Android)
js/telemetry.js         crash reporter + core-loop funnel (loads 2nd, before what it watches)
js/vitals.js            field Web Vitals, shipped through telemetry (lazy)
js/app.js               boot
server/server.js        realtime server: static hosting + ws + REST auth + TomTom/TTS proxies + App Links / Universal Links files
server/supabase.js      Supabase Auth (GoTrue) client + ES256 access-token verification
server/db.js            Postgres data layer: profiles, friends, blocks, queued writes
server/store.js         account store — in-memory read cache over Supabase, recovery codes
server/mailer.js        outbound email over Resend: transport + link/notice templates
server/oauth.js         social sign-in: provider registry + server-held PKCE state
server/telemetry.js     crash/funnel sink: 30-day rollup + rotated error log + stats endpoint
server/authresidue.js   unfinished GoTrue deletions, retried across restarts until they land
server/tomtom.js        TomTom routing proxy (key from TOMTOM_KEY env, never client-side)
server/bots.js          server-side bots + shared geo helpers
server/wiregate.js      per-viewer wire gate (suppress unchanged rows, rate-limit distant riders)
server/flags.js         runtime kill switches for the control panel
server/admin.js         the /admin control panel (+ adminmap.js, audit.js, play.js, ota.js)
server/migrations/      SQL applied to the Supabase project, in order
legal/                  Terms, Privacy Policy, deletion page, third-party notices (served at /terms, /privacy, …)
landing/                marketing page served at /landing and /about
deploy/                 VPS deploy scripts + systemd unit (see DEPLOY.md)
android/                Capacitor Android shell (Java plugins under app/src/main/java/...)
  AuthPlugin.java       social sign-in + mailed links: Custom Tab out, deep links back
  BackgroundLocationPlugin.java + LocationService.java   foreground location service
  VoicePlugin.java      RECORD_AUDIO permission on demand
  LiveUpdatePlugin.java OTA web-bundle updates
ios/                    Capacitor iOS shell (Swift Package Manager)
  App/App/BackgroundLocationPlugin.swift   background location updates
  App/App/ViewController.swift             registers the local plugin with the bridge
  App/App/Info.plist, App.entitlements, PrivacyInfo.xcprivacy
```
