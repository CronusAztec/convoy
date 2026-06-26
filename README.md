# 🏁 Convoy — ride together

A sleek passenger-side map app: see live riders around you, route anywhere like Google Maps,
form convoys with nearby cars, and watch global drivers on a delayed feed.
**Built for passengers** — the driver drives, you run the map.

## Run it

| Mode | How | What you get |
|---|---|---|
| **LIVE (multiplayer)** | Double-click `start.bat` (or `node server/server.js`) → `http://localhost:5173` | Real riders via WebSocket + server bots, real convoys & chat across devices |
| **Solo** | Double-click `index.html`, or serve with `python -m http.server 5173` | Same app, riders simulated on-device |
| **On your VPS** | See **[DEPLOY.md](DEPLOY.md)** | LIVE mode on the internet, HTTPS, auto-restart |

The client auto-detects: if the Convoy server answers on the same origin it goes live,
otherwise it falls back to solo. One dependency (`ws`), no database, no API keys.

## Features

- **Accounts & friends** — register / log in / recover (recovery codes), or ride
  as a guest. Passwords are scrypt-hashed server-side; sessions are stateless
  HMAC tokens (revocable via a `tokenVersion` bump). Add friends by username,
  see who's online, invite friends to a convoy even when they're off your map.
- **Map** — MapLibre GL (GPU-rendered, smooth pan/zoom/rotate/pitch) with CARTO basemaps.
  Dark, light, and voyager styles; auto-matches your theme.
- **Routes** — search any destination (Nominatim) or tap the map → driving routes via
  TomTom (traffic-aware, when the server has a key) with OSRM as the keyless fallback.
  Distance, duration, arrival time, and a chase-camera trip player (1× / 5× / 20× demo
  speed) with optional spoken turn-by-turn navigation (self-hosted Piper neural TTS).
  Police/speed-camera avoidance re-routes around enforcement POIs.
- **Nearby riders (LIVE)** — riders stream around you in real time with smooth 60 fps
  interpolation. Tap a car for their profile card, wave at them, or invite them.
- **Global drivers (DELAYED)** — a world-wide layer (amber, clustered) refreshed on a slow
  cycle, marked "~5 min delay". Toggle via the globe button or the chip.
- **Convoys** — create a named convoy, invite nearby riders or friends, see members
  tethered to you on the map, group chat, kick/leave, join-by-code, and open/locked modes.
  Members trail behind you when you ride.
- **Walkie-talkie voice** — convoy-only push-to-talk / open-mic / toggle voice. WebRTC
  P2P mesh (Opus) with a WebSocket PCM relay fallback. Never global, always within your convoy.
- **Ghost Mode radar** — go invisible to non-convoy riders and turn on a HUD-style radar:
  live aircraft (OpenSky + ADS-B Exchange), police stations & speed cameras (OpenStreetMap),
  proximity sonar audio, and risk scoring. On Android, pairs with a hardware radar detector
  (BLE) and the SABRE crowd-alert host app.
- **Police scanners** — find live law-enforcement scanner feeds near you (OpenMHz, keyless)
  and listen in your browser. US coverage.
- **Map overlays** — precipitation radar (RainViewer), an optional live traffic-flow
  heatmap (TomTom, server-proxied), and weather/user-reported hazard pins.
- **Performance meter** — a 0–60 / drag-timer chip (dragy) for quick acceleration runs.
- **Profile & garage** — name, handle, emoji avatar, vibe, and your car: year / make / model /
  paint (14 presets + any custom color) / finish (gloss, matte, metallic, satin) / body /
  engine / trans / drive / hp / mods / exhaust. Your map marker is your actual car in your color.
- **Settings** — dark/light/auto theme, 6 accent colors + custom, map style, miles/km,
  global-drivers toggle, animation toggle, follow-cam toggle, voice-nav toggle + custom
  navigator voice, ghost target filters, sonar tuning, overlay layers, reset.

## How live mode works

- The Node server ([server/server.js](server/server.js)) serves the app **and** a WebSocket
  on `/ws`. Riders within 30 km of each other (configurable) stream positions at 1 Hz;
  the client interpolates to 60 fps. A fast lane refreshes your nearest riders several
  times a second.
- **Server bots** (default 12, `BOTS` env) anchor near connected humans so the map never
  feels empty — they accept invites, trail your convoy in formation, reply in chat, and
  wave back. Set `BOTS=0` for humans-only.
- The **global layer** is genuinely delayed in live mode: the server snapshots all riders
  and replays positions ~5 minutes old (plus ambient world dots for atmosphere).
- **Accounts, friends, convoys, invites, kicks, chat, waves, and voice relay** are all
  server-authoritative with rate limits, input sanitization, and per-IP ceilings.
- **Routing & traffic** are optionally server-proxied: set `TOMTOM_KEY` on the server and
  the client automatically uses traffic-aware TomTom routes (via `/api/route`) and a
  traffic heatmap (via `/api/traffic/*`). With no key set, both degrade to the keyless
  OSRM / hidden-layer fallbacks — the key never ships in client JS.
- **Spoken nav** uses a self-hosted Piper neural TTS served from `/api/tts`
  (`TTS_DIR`/`TTS_BIN`/`TTS_MODEL` env; absent → text nav cues only).

## Honest notes

- In **solo mode** riders/chat are simulated on-device; nothing leaves the browser. Voice
  and friends require the live server (and an account, for friends).
- **Guests** (no account) can ride, route, and convoy, but can't add friends or persist a
  profile across devices. Anyone with the URL can join as a guest — see DEPLOY.md to lock it down.
- Routing/search/scanners use free public services (OSRM, Nominatim, OpenMHz, OpenSky,
  OpenStreetMap/Overpass) — fine for development, not for production traffic. TomTom routing
  & traffic need your own `TOMTOM_KEY` (free tier available).
- Map tiles are free CARTO basemaps (attribution required, shown on-map).
- The Android native plugins (BLE radar detector, SABRE crowd alerts) are present and
  gracefully no-op on the web; the BLE/SABRE frame parsers still want validation against
  real hardware before shipping.

## Structure

```
index.html              shell + layout
css/styles.css          design system (themes, glass, motion, radar HUD)
js/config.js            platform config (native vs web, server base URL)
js/data.js              cars, paints, names, cities
js/util.js              geo math + DOM helpers
js/state.js             state, persistence, theming, event bus
js/mapview.js           MapLibre: layers, markers, popups, camera
js/sim.js               rider engine: markers, interpolation, trips, solo physics
js/net.js               realtime client (auto-connect, solo fallback, caps probe)
js/routing.js           search, routing (TomTom proxy → OSRM fallback), trip lifecycle
js/party.js             convoys, invites, chat (server-backed when live)
js/voice.js             walkie-talkie: WebRTC mesh + relay fallback
js/ghost.js             Ghost Mode data: live aircraft + police/camera POIs
js/radar.js             radar HUD: sonar, risk, detector alerts
js/scanners.js          police-scanner directory (OpenMHz)
js/overlays.js          weather radar + traffic heatmap + hazard pins
js/dragy.js             0–60 / drag-timer performance meter
js/ui.js                panels, dock, forms, settings, onboarding
js/auth.js              register/login/guest, token storage, boot gating
js/native.js            Android native bridge (bg GPS, BLE radar, SABRE); no-op on web
js/app.js               boot
server/server.js        realtime server: static hosting + ws + REST auth + TomTom/TTS proxies
server/auth.js          stateless HMAC token mint/verify
server/store.js         JSON-file user store: scrypt hashing, friends, recovery, atomic flush
server/tomtom.js        TomTom routing + traffic proxy (key from TOMTOM_KEY env, never client-side)
server/bots.js          server-side bots + shared geo helpers
deploy/                 VPS deploy scripts + systemd unit (see DEPLOY.md)
android/                Capacitor Android shell (Java plugins under app/src/main/java/...)
```
