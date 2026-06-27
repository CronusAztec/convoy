/* Convoy — TomTom proxy.
   The TomTom Web key is a server secret: it lives in the TOMTOM_KEY env var,
   never in client JS. Clients hit our /api/route and /api/traffic/* endpoints;
   this module forwards to api.tomtom.com with the key injected and strips it
   out of anything we send back.

   - /api/route        POST {from:[lng,lat], to:[lng,lat], via?:[lng,lat]}
                          → the raw TomTom routing JSON (client normalizes it)
   - /api/traffic/<z>/<x>/<y>.png  GET → TomTom flow tile bytes, no key in URL

   Both paths are rate-limited per IP (the free TomTom tier is ~2,500/day) and
   bail cleanly when no key is configured, so the client falls back to OSRM /
   a hidden traffic layer exactly as before. */
'use strict';

// Server-side only (never served to browsers), but still a billable secret — keep
// it out of source control. Supply it via the environment (e.g. systemd
// Environment=TOMTOM_KEY=… or a gitignored .env). Empty = routing/traffic disabled;
// hasKey() lets the server degrade gracefully instead of calling with no key.
const TOMTOM_KEY = process.env.TOMTOM_KEY || '';
const ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute/';
const TRAFFIC_TILE = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/';

function hasKey() { return !!TOMTOM_KEY; }

// lng/lat guard reused by the routing endpoint.
function isLngLat(p) {
  return Array.isArray(p) && p.length === 2 &&
    typeof p[0] === 'number' && isFinite(p[0]) && p[0] >= -180 && p[0] <= 180 &&
    typeof p[1] === 'number' && isFinite(p[1]) && p[1] >= -85 && p[1] <= 85;
}

// Build a "lat,lon:lat,lon[:...]" TomTom route path from [lng,lat] pairs.
// Mirrors the client's old ttPath() so the upstream URL is identical.
function ttPath(pts) { return pts.map((p) => p[1] + ',' + p[0]).join(':'); }

// POST {from, to, via?} → TomTom routing JSON. cb(err, status, json).
async function route(body, cb) {
  if (!TOMTOM_KEY) return cb(new Error('no key'));
  const from = body && body.from, to = body && body.to, via = body && body.via;
  if (!isLngLat(from) || !isLngLat(to)) return cb(new Error('bad coords'));
  const pts = via && isLngLat(via) ? [from, via, to] : [from, to];
  const hasVia = pts.length > 2;
  const url = ROUTE_URL + ttPath(pts) + '/json?key=' + TOMTOM_KEY +
    '&traffic=true&travelMode=car' +
    (hasVia ? '' : '&maxAlternatives=2') + // via = a forced detour; alternatives only on plain A→B
    '&instructionsType=text&routeRepresentation=polyline';
  try {
    const r = await fetch(url, { method: 'GET' });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return cb(new Error('bad upstream'), r.status); }
    // TomTom sometimes returns HTTP 200 with an error body (e.g. an invalid key
    // yields {"detailedError":{"code":"Unauthorized",...}}) instead of a 4xx.
    // Forwarding that 200 to the client would make routing.js crash on
    // j.routes being undefined, so detect it here and surface a real failure.
    if (!j || j.detailedError || !Array.isArray(j.routes)) {
      return cb(new Error('upstream error'), r.status);
    }
    cb(null, r.status, j);
  } catch (e) { cb(e); }
}

// Stream a single flow tile. cb(err, status, headers, buffer).
async function tile(z, x, y, cb) {
  if (!TOMTOM_KEY) return cb(new Error('no key'));
  const url = TRAFFIC_TILE + z + '/' + x + '/' + y + '.png?tileSize=256&key=' + TOMTOM_KEY;
  try {
    const r = await fetch(url);
    const buf = Buffer.from(await r.arrayBuffer());
    cb(null, r.status, { 'Content-Type': r.headers.get('content-type') || 'image/png' }, buf);
  } catch (e) { cb(e); }
}

module.exports = { hasKey, isLngLat, route, tile, TOMTOM_KEY };
