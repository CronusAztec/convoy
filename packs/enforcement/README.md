# Enforcement awareness (`enforcement`)

The enforcement feature set the 2026-10-04 store cut withdrew from the app,
restored as a server-served feature pack: nothing in this directory ships in
the binary, and every byte of it reaches an app only for an account that has
redeemed a code for `enforcement` (see `packs/README.md` for the contract).

## What the pack does

Once held, the pack adds to the map and to Settings → *Enforcement awareness*:

| Piece | What it is |
|---|---|
| **Radar** (`radar`, off by default, legal-gated) | The master switch. On: live aircraft (OpenSky, sorted military / police / EMS / civilian / unidentified with fading trails), police stations, speed and ALPR cameras (OpenStreetMap), live police sightings (Waze if the server is keyed, the collector's findings, other riders' reports), the "usually here" probability hotspots with an hour scrubber, the radar HUD (alert stack, risk meter, status strip, range rings, floating labels, the rotating sweep) and the proximity sonar with spoken callouts. |
| **Go invisible with the radar** (`radarGhost`) | Restores the old Ghost Mode pairing: switching the radar on also turns the core's Invisible mode on, and off again with it (`A.ui.applyGhost`). |
| **Avoid police & cameras** (`avoidPolice`, off by default, legal-gated) | Background route refinement: after the core draws the fastest route, the pack counts police stations and speed cameras within 160 m of each alternative and quietly swaps in the cleanest, or builds a waypoint detour around the worst on-route POI. |
| **Cruise loop** (`#ctl-loop`) | One tap plans a route that loops back to where you are, scored keyless on police, cameras, stop signs and signals. Legal-gated like the radar. |
| **Report police here** (radar dock) | Sends `enforcement:report` with your position; the server fans it to nearby holders of the pack, feeds the hotspot model and the live feed. |
| Radar audio, Police & cameras, Aircraft sections | The per-kind filters and sonar settings the old build had (`sonarVol`, `heartSense`, `ghostPolice`, `ghostAirMil`, …), same keys so a rider's old preferences carry over. |

Regulated features default **off** and pass `A.ui.legalGate('radar', …)` with
the pre-cut notice text before they switch on; the acknowledgement is per
Terms version (a persisted "on" under an older Terms starts off again).

## Files

```
packs/enforcement/
  pack.json         manifest — scripts in load order, the stylesheet, two fragments
  controls.html     #ctl-radar + #ctl-loop, mounted after #ctl-global
  hud.html          the radar HUD (#radar-*, #rst-*), appended to <body>
  enforcement.css   HUD, legend, controls, settings rows (no backdrop-filter)
  settings.js       A.store.registerSettings(...) — first script
  maplayers.js      sources, layers, popups, taps (A.mapview.onStyle / onClick)
  ghost.js          the data loops: aircraft, OSM enforcement, live police, hotspots
  radar.js          the HUD, sonar, rings, labels
  routing.js        police-avoid (A.routing.hook('routes')) + the cruise loop
  ui.js             the notice, the settings sections, the radar funnel, the controls
  boot.js           A.packs.register('enforcement', { init }) — last script
server/packs/enforcement.js            the server half (routes + ws handler)
server/packs/enforcement/
  aircraft.js, overpass.js, waze.js    the upstream proxies, verbatim from the old server/
  hotspots.js                          the probability model, now persisted via ctx.db.query
  agent.js                             the live-sightings store + the collector inbox
  police-finder.js                     the multi-source collector (standalone or in-process)
  collect-hotspots.js                  the Waze-only collector (standalone or in-process)
  collect-regions.json                 the sweep regions (nationwide USA)
  convoy-police-finder.service         systemd SAMPLE for the standalone finder
  convoy-collector.service             systemd SAMPLE for the standalone Waze collector
server/migrations/007_enforcement.sql  the sightings table
test/packs-enforcement.test.js         the pack's suite
```

## Environment keys (server/.env or the unit's environment)

| Key | Needed for | Notes |
|---|---|---|
| `OPENWEBNINJA_KEY` | Live Waze police sightings (`/api/enforcement/waze`), the Waze source of both collectors | Billable. Legacy name `RAPIDAPI_KEY` still works. Unset: the live feed still answers with the collector's findings and riders' reports. |
| `ENFORCEMENT_COLLECTOR` | Running a collector **inside the server** | `finder` (every source), `waze` (Waze-only), `all` / `1` (both), `0` / unset (none). |
| `ENFORCEMENT_INBOX_DIR` | Ingesting batches from a **standalone** collector | Opt-in: set the same directory on the server and on the collector's unit (the samples use `/var/lib/convoy/enforcement-inbox`). `ENFORCEMENT_INBOX_SCAN_MS` (default 30000) is the scan cadence. |
| `OVERPASS_URLS`, `OVERPASS_TIMEOUT_MS`, `OVERPASS_COOL_MS`, `OVERPASS_TTL_MS`, `OVERPASS_MAX_SPAN_DEG` | The OpenStreetMap proxy | Defaults: the two public mirrors, 30000, 120000, 1800000, 4. |
| `UPSTREAM_TIMEOUT_MS` | The Waze call's deadline | Default 8000. |
| `REPORT_MAX_M` | How far from their own position a rider may report police | Default 8000. |
| `FINDER_*`, `COLLECT_*`, `GOOGLE_INCIDENTS_URL`, `PP_PER_SWEEP`, `CAMERA_EVERY` | The collectors | Documented in the headers of `police-finder.js` and `collect-hotspots.js`. |
| `DATA_DIR` | Only the default inbox location for a standalone collector | Same variable the core uses. |

OpenSky is called anonymously; `aircraft.js` reads no key. There is **no
`AGENT_KEY`** any more (below).

## Running a collector

The hotspot model is empty on day one and fills from observations. Three ways
to feed it, from simplest to most elaborate:

1. **Nothing.** Riders' reports and, with `OPENWEBNINJA_KEY`, every Waze
   police alert a holder's map polls are recorded as they pass through.
2. **In-process.** `ENFORCEMENT_COLLECTOR=finder` (or `waze`, or `all`) in
   `convoy.service`'s environment. The server half starts the collector at
   boot and its findings go straight into the model — no second process.
3. **Standalone.** Install `convoy-police-finder.service` (or
   `convoy-collector.service`) from `server/packs/enforcement/`, set
   `ENFORCEMENT_INBOX_DIR` to the same directory in **both** units. The
   collector drops one JSON file per sweep (`{ "items": [...] }`, written to a
   `.tmp` name and renamed) and the server ingests and deletes them.

The finder reaches sources that have no public API (Waze's private live-map
endpoint, Citizen, PulsePoint). That stays strictly server-side:
`test/packs-enforcement.test.js` pins that `police-finder.js` is the only file
in the repository that names those hosts, and that no client file — including
this pack's own scripts — ever does. Scraped data carries a neutral label
("Police reported"); only the licensed OpenWeb Ninja path credits Waze.

### Importing the old `hotspots.json`

The pre-cut server kept observations in `server/data/hotspots.json`. To carry
them into the table (migration `007_enforcement.sql` applied, server env
loaded):

```
cd /opt/convoy/server && node -e "
  require('./db').init().then(async (db) => {
    const h = require('./packs/enforcement/hotspots');
    await h.init({ query: (t, p) => require('./db').query(t, p) });
    console.log(h.importJson('/var/lib/convoy/hotspots.json'));
    await h.flush(); await require('./db').close();
  })"
```

## What moved or was renamed

| Old (pre-cut build) | Now |
|---|---|
| `POST /api/aircraft` | `POST /api/enforcement/aircraft?minLat&minLng&maxLat&maxLng` |
| `POST /api/overpass` | `POST /api/enforcement/overpass?kind&minLat&minLng&maxLat&maxLng` |
| `POST /api/waze` `{bottomLeft, topRight}` | `POST /api/enforcement/waze?minLat&minLng&maxLat&maxLng` |
| `POST /api/hotspots` `{bottomLeft, topRight, hour}` | `POST /api/enforcement/hotspots?minLat&minLng&maxLat&maxLng&hour` |
| `GET /api/agent/status` (X-Agent-Key) | `POST /api/enforcement/agent/status` (holder bearer, like every pack route) |
| `POST /api/agent/update` (X-Agent-Key) | **gone** — collectors feed the model in-process or via the inbox directory; the HTTP ingest and `AGENT_KEY` no longer exist |
| `/api/route/caps` `.waze` / `.hotspots` | `POST /api/enforcement/caps` → `{ waze, wazeKey, hotspots, aircraft, overpass }` |
| ws `crowd:report` (police branch) | ws `enforcement:report` both ways (`{ lat, lng, label }` in; `{ from, lat, lng, label }` out). Hazard reports belong to the overlays pack. |
| ws `ghost` / `S.settings.ghost` | unchanged, core — Invisible mode. The radar is `S.settings.radar`. |
| `#ctl-ghost` (ghost mode = invisible + radar) | `#ctl-radar` (radar only; `radarGhost` re-couples Invisible mode) |
| `#radar-hazard` (report a road hazard) | `#radar-report` (report police here) |
| `A.ghost`, `A.radar`, `A.mapview.setAircraftData` & co. | `A.enforcement.ghost`, `.radar`, `.map`, `.routing`, `.ui`, `.caps`, `.api` |
| `A.config.routeCaps.waze` / `.hotspots` | `A.enforcement.caps` (event `enforcement:caps`) |
| `U.FETCH_TIMEOUT.overpass` / `.aircraft` | the pack's own deadlines (`FETCH_MS` in `ghost.js`, `OVERPASS_MS` in `routing.js`) |
| `server/data/hotspots.json` | `public.enforcement_sightings` (migration 007) |
| `deploy/convoy-police-finder.service`, `deploy/convoy-collector.service` | samples under `server/packs/enforcement/` — standalone units write the inbox instead of calling the API |

Why the query string: pack routes are dispatched inside the core's POST
handler after the request body has been consumed, and the route signature
carries no body. Parameters therefore ride `req.url`, on both sides.

## Known gaps

* **No Bluetooth radar detector.** The BLE / SABRE plugins stayed out of the
  store build and no pack may reinstate them, so the hardware-contact path of
  the old HUD (the detector banner, `A.detectors`, the "share detections"
  upload) is not here.
* **The police layer is no longer always-on.** The old build drew police
  stations and hotspots whether or not Ghost Mode was on; everything in this
  pack hangs off the `radar` switch, because it is the regulated part.
* **Detours are OSRM-only.** The old `routeVia` tried the TomTom proxy first
  and fell back to OSRM; the pack cannot reach the core's private TomTom
  normaliser, so a forced detour is always computed by OSRM (keyless).
* **Hazard, traffic and weather items** that the old agent API accepted are
  rejected by `agent.ingest()` — they are the overlays pack's.
* **No `GET` routes.** The registry dispatches pack routes inside the core's
  POST branch only, so every route here is `POST` (including `caps` and
  `agent/status`).
* **Aircraft helicopter/airplane split** is still the OpenSky heuristic (low
  and slow ⇒ rotorcraft); the authoritative category needs a feed that
  carries one.
