# Convoy Agent API

An HTTP API that lets an external AI agent (or any script) push live map data —
police sightings, hazards, traffic, weather, and police-hotspot observations —
onto every rider's map.

Pushed items are merged into the same feeds the app already polls
(`/api/waze` for the police layer, `/api/incidents` for hazard pins), so they
appear on connected clients within their normal refresh cycle (~60–120 s, or on
the next map pan) with no client changes.

## Setup

Set a secret key on the server (pick a long random string):

```
# systemd:   Environment=AGENT_KEY=your-long-random-secret
# or server/.env (gitignored):
AGENT_KEY=your-long-random-secret
```

Unset ⇒ the feature is off and the routes return 503.

## Authentication

Send the key on every request, either way:

```
X-Agent-Key: your-long-random-secret
Authorization: Bearer your-long-random-secret
```

## POST /api/agent/update

Body: `{ "items": [ ... ] }` (max 100 per call), or a single item object.

| type      | required          | optional                        | shows up as |
|-----------|-------------------|---------------------------------|-------------|
| `police`  | `lat`, `lng`      | `label`, `ttl`                  | Live police pin (blue) on the always-on police layer; also feeds the Ghost radar and the hotspot model |
| `hazard`  | `lat`, `lng`      | `kind`, `label`, `ttl`          | Hazard pin |
| `traffic` | `lat`, `lng`      | `kind`, `label`, `ttl`          | Hazard pin (default "Heavy traffic") |
| `weather` | `lat`, `lng`      | `kind`, `label`, `ttl`          | Hazard pin (default kind `alert`, "Weather alert") |
| `hotspot` | `lat`, `lng`      | `time` (epoch ms, may be past)  | Nothing visible immediately — one observation in the police-probability model (builds the hotspot heatmap per hour-of-day) |

- `ttl` — seconds the item stays live (default 1800 = 30 min, max 86400).
- `label` — free text shown in the pin popup (max 60 chars, `<`/`>` stripped).
- `kind` — hazard icon, one of:
  `accident, stopped, debris, hazard, ice, snow, fog, rain, wind, flood, closure, alert`.
  Weather items should use `rain, snow, fog, ice, wind` or `alert`.
- Items are held in memory (500 per store, oldest evicted) and cleared on server
  restart. `hotspot` observations persist (server/data/hotspots.json).

Response:

```json
{ "ok": true, "accepted": 3, "rejected": [ { "index": 1, "reason": "bad lat/lng" } ],
  "live": { "police": 4, "hazards": 7, "hotspotObservations": 1234 } }
```

## GET /api/agent/status

Auth'd probe returning the live item counts (same `live` object as above).

## Examples

```bash
# One police sighting (visible ~30 min)
curl -sX POST https://your-server/api/agent/update \
  -H 'X-Agent-Key: SECRET' -H 'Content-Type: application/json' \
  -d '{"type":"police","lat":34.0522,"lng":-118.2437,"label":"Speed trap reported"}'

# Batch: weather + traffic + a historical hotspot observation
curl -sX POST https://your-server/api/agent/update \
  -H 'X-Agent-Key: SECRET' -H 'Content-Type: application/json' \
  -d '{"items":[
        {"type":"weather","kind":"snow","lat":39.74,"lng":-104.99,"label":"Snow squall on I-70","ttl":7200},
        {"type":"traffic","lat":34.05,"lng":-118.24,"label":"Stadium letout — avoid Fig"},
        {"type":"hotspot","lat":34.09,"lng":-118.36,"time":1719800000000}
      ]}'
```

## Notes for agent builders

- Rate limit: 120 update calls/min per IP. Batch items instead of looping.
- If the server has no TomTom/Waze upstream keys, agent data alone still renders:
  the capability probe (`/api/route/caps`) advertises `waze`/`incidents` as
  available whenever `AGENT_KEY` is configured.
- Don't push what the server already ingests upstream (TomTom incidents, Waze
  alerts) — you'd double-pin the same event.
