/* Convoy — TomTom routing proxy.
   The TomTom Web key is a server secret: it lives in the TOMTOM_KEY env var,
   never in client JS. Clients hit our /api/route endpoint; this module
   forwards to api.tomtom.com with the key injected and strips it out of
   anything we send back.

   - /api/route        POST {from:[lng,lat], to:[lng,lat], via?:[lng,lat]}
                          → the raw TomTom routing JSON (client normalizes it)

   Rate-limited per IP (the free TomTom tier is ~2,500/day) and bails cleanly
   when no key is configured, so the client falls back to OSRM exactly as
   before. */
'use strict';

// Server-side only (never served to browsers), but still a billable secret — keep
// it out of source control. Supply it via the environment (e.g. systemd
// Environment=TOMTOM_KEY=… or a gitignored .env). Empty = TomTom routing disabled;
// hasKey() lets the server degrade gracefully instead of calling with no key.
// Read per-call (not a require-time const): the env is the DEFAULT state, and
// the admin panel's kill switches (flags.js) need caps to reflect the live
// environment without a restart. The key used in requests below stays the same
// frozen value for the process's lifetime — only the gate is live.
const TOMTOM_KEY = process.env.TOMTOM_KEY || '';
function currentKey() { return process.env.TOMTOM_KEY || ''; }
const ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute/';

function hasKey() { return !!currentKey(); }

// Node's fetch has NO default timeout, so a hung upstream held our client's
// request, socket and response object open indefinitely. Every call below is
// bounded.
const UPSTREAM_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
function withTimeout(ms) {
  // AbortSignal.timeout is Node 17.3+; fall back for anything older.
  if (AbortSignal.timeout) return AbortSignal.timeout(ms || UPSTREAM_MS);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms || UPSTREAM_MS).unref?.();
  return c.signal;
}

// Upstream body cap (bytes). A route reply is tens of KB; an upstream contract
// change returning something enormous would otherwise be buffered whole into
// memory on the main thread.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
function oversize(r) {
  const clen = parseInt(r.headers.get('content-length') || '0', 10);
  return clen > MAX_BODY_BYTES;
}

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
    const r = await fetch(url, { method: 'GET', signal: withTimeout() });
    if (oversize(r)) return cb(new Error('upstream response too large'), r.status);
    const text = await r.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return cb(new Error('upstream response too large'), r.status);
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

module.exports = { hasKey, isLngLat, route, TOMTOM_KEY };
