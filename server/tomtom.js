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

// Node's fetch has NO default timeout, so a hung upstream held our client's
// request, socket and response object open indefinitely — and the tile route
// alone permits hundreds of requests a minute. Every call below is bounded.
const UPSTREAM_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
function withTimeout(ms) {
  // AbortSignal.timeout is Node 17.3+; fall back for anything older.
  if (AbortSignal.timeout) return AbortSignal.timeout(ms || UPSTREAM_MS);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms || UPSTREAM_MS).unref?.();
  return c.signal;
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
    const r = await fetch(url, { signal: withTimeout() });
    const buf = Buffer.from(await r.arrayBuffer());
    cb(null, r.status, { 'Content-Type': r.headers.get('content-type') || 'image/png' }, buf);
  } catch (e) { cb(e); }
}

// Live traffic incidents (same key as routing/tiles). TomTom's iconCategory maps to
// our hazard pins; we surface genuine point HAZARDS only. Jams (6), lane-closed (7),
// road-works (9) AND road-closed (8) are intentionally dropped — the live traffic
// heatmap already shows congestion + closed roads (dark/no flow), and TomTom reports
// hundreds of freeway-segment "closures" per metro that would bury the real hazards.
const INCIDENT_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const INCIDENT_KINDS = {
  1:  { kind: 'accident', label: 'Accident',             color: '#ff3b3b' },
  3:  { kind: 'hazard',   label: 'Dangerous conditions', color: '#ff5a3c' },
  5:  { kind: 'ice',      label: 'Ice on road',          color: '#7fe3ff' },
  11: { kind: 'flood',    label: 'Flooding',             color: '#3aa0ff' },
  14: { kind: 'stopped',  label: 'Stopped vehicle',      color: '#ff9f43' }
};
const INCIDENT_CAP = 250; // bound the payload + on-map pin count

// Pick one representative point for an incident: the affected segment is a LineString,
// so use its midpoint; a Point is used as-is.
function incidentPoint(geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'LineString' && geom.coordinates.length) {
    const p = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    return Array.isArray(p) ? p : null;
  }
  return null;
}

// GET incidents for a bbox → hazard-pin GeoJSON. cb(err, status, featureCollection).
async function incidents(minLng, minLat, maxLng, maxLat, cb) {
  if (!TOMTOM_KEY) return cb(new Error('no key'));
  const bbox = minLng + ',' + minLat + ',' + maxLng + ',' + maxLat;
  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,iconCategory}}}}';
  const url = INCIDENT_URL + '?bbox=' + encodeURIComponent(bbox) +
    '&fields=' + encodeURIComponent(fields) + '&language=en-GB&timeValidityFilter=present&key=' + TOMTOM_KEY;
  try {
    const r = await fetch(url, { signal: withTimeout() });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { return cb(new Error('bad upstream'), r.status); }
    if (!j || !Array.isArray(j.incidents)) return cb(new Error('upstream error'), r.status);
    const feats = [];
    for (let i = 0; i < j.incidents.length && feats.length < INCIDENT_CAP; i++) {
      const inc = j.incidents[i], props = inc.properties || {};
      // Own properties only: iconCategory is whatever the upstream sent, and a
      // bare lookup would resolve inherited Object.prototype members as if they
      // were incident kinds, defeating the `if (!def) continue` drop below.
      const def = Object.prototype.hasOwnProperty.call(INCIDENT_KINDS, props.iconCategory)
        ? INCIDENT_KINDS[props.iconCategory] : null;
      if (!def) continue; // drop jams / lane-closed / road-works / unknown
      const pt = incidentPoint(inc.geometry);
      if (!pt) continue;
      const ev = props.events && props.events[0] && props.events[0].description;
      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pt[0], pt[1]] },
        properties: { kind: def.kind, label: ev || def.label, color: def.color, incident: true, tomtom: true }
      });
    }
    cb(null, 200, { type: 'FeatureCollection', features: feats });
  } catch (e) { cb(e); }
}

module.exports = { hasKey, isLngLat, route, tile, incidents, TOMTOM_KEY };
