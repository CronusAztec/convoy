# Convoy Agent API — Overview for External AI

## What You're Building

You are building a real-time map data ingestion system that lets external AI agents (or any script/service) push live observations onto a rideshare safety app's map.

The app is called **Convoy** — a private convoy/group ride app with live tracking, voice chat, and hazard warnings.

## The Problem It Solves

Convoy clients already display live police sightings, traffic incidents, and weather hazards from upstream providers (Waze, TomTom). But those providers have:
- Rate limits
- Slow updates
- Limited coverage (may not include local events you know about)

The Agent API lets you inject your own real-time data into those same feeds with **zero client changes** — your data merges seamlessly into the existing polling cycles riders already use.

## How It Works

### Authentication
You set a shared secret key on the server:
```bash
# server/.env (dev) or systemd Environment= (production)
AGENT_KEY=your-long-random-string
```

Send it on every request as a header:
```bash
X-Agent-Key: your-long-random-string
# or
Authorization: Bearer your-long-random-string
```

### Endpoints

**POST `/api/agent/update`** — Push items
- Body: single item object or `{ "items": [ ... ] }` (max 100 per call)
- Response: `{ "ok": true, "accepted": 3, "rejected": [...], "live": {...} }`

**GET `/api/agent/status`** — Check live counts
- Response: `{ "live": { "police": N, "hazards": N, "hotspotObservations": N } }`

### Item Schema

Each item requires `type`, `lat`, `lng`. Optional: `label` (max 60 chars), `ttl` (seconds, default 1800, max 86400), `kind` (for hazards/weather).

| type | Required | Optional | Shows up as |
|------|----------|----------|------------|
| `police` | lat, lng | label, ttl | Blue dot on police layer; feeds Ghost mode radar |
| `hazard` | lat, lng | kind, label, ttl | Pin on hazard layer (accidents, debris, obstacles) |
| `traffic` | lat, lng | kind, label, ttl | Heavy traffic incident pin |
| `weather` | lat, lng | kind, label, ttl | Weather alert (snow, fog, rain, etc.) |
| `hotspot` | lat, lng | time (epoch ms) | Historical observation; builds probability heatmap by hour-of-day |

**Hazard kinds:** `accident, stopped, debris, hazard, ice, snow, fog, rain, wind, flood, closure, alert`

### Example Payload

```json
{
  "type": "police",
  "lat": 34.05,
  "lng": -118.24,
  "label": "Speed trap on Main St",
  "ttl": 1800
}
```

Or batch:
```json
{
  "items": [
    {"type": "police", "lat": 34.05, "lng": -118.24, "label": "Speed trap"},
    {"type": "traffic", "lat": 34.06, "lng": -118.25, "label": "Stadium letout — avoid Fig"},
    {"type": "hotspot", "lat": 34.09, "lng": -118.36, "time": 1719800000000}
  ]
}
```

## Where Items Land

- **In memory**: Max 500 police, max 500 hazards. Oldest items evict when you exceed limits.
- **Expiration**: Each item expires after its TTL (default 30 min). Server doesn't clear them; clients poll and ignore stale timestamps.
- **Served via**: Existing `/api/waze` (police) and `/api/incidents` (hazards) endpoints that Convoy clients already poll every 60–120 seconds.
- **Visibility**: Your data appears on riders' maps as new pins, no client code changes needed.

**Exception — Hotspot observations:**
- Persist to disk (`server/data/hotspots.json`)
- Train the police probability heatmap (what hours/locations have the most sightings)
- Never expire automatically

## Rate Limits & Scale

- **120 calls/min** per IP
- **Max 100 items** per POST
- **Batch instead of looping** — send 100 items in one call, not 100 separate calls
- **Memory cap**: ~500 police + ~500 hazards total across all agents (FIFO eviction)

## Use Case Example

An external traffic AI monitors cameras + Waze. It spots a fender-bender on I-405 that Waze hasn't picked up yet.

```bash
curl -X POST https://your-convoy-server/api/agent/update \
  -H 'X-Agent-Key: secret-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "hazard",
    "lat": 34.05,
    "lng": -118.24,
    "kind": "accident",
    "label": "Fender-bender I-405 NB, right shoulder",
    "ttl": 1800
  }'
```

**Result**: Within 60–120 seconds (Convoy's refresh cycle), all connected riders see a new hazard pin on their map.

## Notes for Agent Builders

1. **Don't duplicate upstream data**: If TomTom or Waze already covers an incident, don't re-push it — you'll double-pin the same event.
2. **Capability advertisement**: `/api/route/caps` reports `waze` and `incidents` as available whenever `AGENT_KEY` is set, even if upstream keys (TomTom, Waze) aren't. This lets the client show the police/hazard layers.
3. **Server restart**: Items in memory are cleared on restart (except hotspots, which persist). Plan accordingly.
4. **Batch for scale**: Push 100 items at once instead of 100 separate requests; it's faster, cheaper, and respects rate limits.

## Related Files

- **Implementation**: `server/agent.js` (validation, storage, TTL logic)
- **Integration**: `server/server.js` (endpoints, rate limiting, feed merging)
- **Client feeds**: `/api/waze` and `/api/incidents` consume agent data
- **Full docs**: See `AGENT-API.md` for curl examples and complete reference
