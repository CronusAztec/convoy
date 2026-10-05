# Map overlays — feature pack `overlays`

Weather radar, live traffic flow and incidents, and hazards reported by riders
near you, as layers on the map. Restored from the pre-cut tree (`js/overlays.js`,
the hazard layers and popup in `js/mapview.js`, the "Map overlays" settings
section in `js/ui.js`, the `crowd:report` socket handler, the `/api/incidents`
and `/api/traffic` routes and the TomTom tile/incident helpers) as a pack served
only to accounts that redeemed a code. Nothing here is regulated, so there is no
legality notice; every layer defaults off.

## What it does

- **Weather** — RainViewer precipitation radar (keyless, fetched by the device),
  three colour schemes, refreshed every 5 minutes while on.
- **Traffic** — TomTom flow tiles through `/api/overlays/traffic/<z>/<x>/<y>.png`.
  The key stays on the server; the tile URL carries the pack's signed file token
  (`A.packs.token`), which the server checks against the grant on every tile.
  Needs `TOMTOM_KEY`; without it the row says so and the layer stays hidden.
- **Hazards** — pins from Open-Meteo conditions at the rider (heavy rain, snow,
  ice, wind, fog), TomTom incidents for the visible area
  (`POST /api/overlays/incidents`, needs `TOMTOM_KEY`), NWS weather alerts
  (keyless, US), and hazards reported by riders near you. Tap a pin for what it
  is, how far and which way.
- **Report a hazard** — the ⚠ map control (mounted after the global-riders
  control) drops a pin at your position and sends `overlays:report`; the
  server relays it as `overlays:hazard` to riders within `NEARBY_KM` who hold
  the pack and are not in a block pair with you. Reports are live-only.

## Renamed vs the old build

| Old | Now |
|---|---|
| `POST /api/incidents` (anonymous) | `POST /api/overlays/incidents` (bearer, pack-gated) |
| `GET /api/traffic/<z>/<x>/<y>.png` (anonymous) | `GET /api/overlays/traffic/<z>/<x>/<y>.png?t=<file token>` |
| `routeCaps.routing / .incidents` from `/api/route/caps` | `GET /api/overlays/caps` → `{ traffic, incidents }`, `A.overlays.caps()`, event `overlays:caps` |
| ws `crowd:report` / `crowd:report` fan-out | ws `overlays:report` in, `overlays:hazard` out (with `by: <rider id>`) |
| `A.net.sendCrowdReport` | `A.net.send({ t: 'overlays:report', … })` |
| `#ctl-hazard` in index.html | `packs/overlays/controls.html`, hidden until the pack is held |
| settings `showWeather`, `weatherLayer`, `showTraffic`, `showHazards` | same keys, registered by the pack, all default off |

## Left out

- Police reports from the picker: a police sighting is the enforcement pack's
  (`enforcement:report`, which also feeds its hotspot model).
- SABRE/native crowd publishing (the BLE plugins are out of the store build).
- Agent-pushed hazards (`/api/agent/update` is gone; see the enforcement pack).

## Env

| Key | Meaning |
|---|---|
| `TOMTOM_KEY` | Traffic tiles + incidents (the core's routing key). Unset = both off, radar and reports still work. |
| `REPORT_MAX_M` | How far from their position a rider may report (default 8000). |
| `UPSTREAM_TIMEOUT_MS` | Deadline for a TomTom call (default 8000). |

## Files

`packs/overlays/{pack.json, controls.html, overlays.css, overlays.js, ui.js}`,
`server/packs/overlays.js`, `server/packs/overlays/tomtom-extras.js`,
`test/packs-overlays.test.js`.
