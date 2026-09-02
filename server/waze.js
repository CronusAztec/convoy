/* Convoy — Waze (via OpenWeb Ninja) proxy.
   The OpenWeb Ninja key is a server secret: it lives in the OPENWEBNINJA_KEY env
   var, never in client JS. Clients hit our /api/waze endpoint with a bounding box;
   this module forwards to OpenWeb Ninja's direct Waze API with the key injected,
   filters to the alert types we surface, and returns normalized GeoJSON the
   client's police/hazard layers can consume directly.

   (The same product is also resold on RapidAPI as waze.p.rapidapi.com; we use the
   vendor-direct endpoint, which takes an `ak_…` key via the x-api-key header.)

   Upstream: GET https://api.openwebninja.com/waze/alerts-and-jams
     ?bottom_left=lat,lon&top_right=lat,lon
     headers: x-api-key
   Alert shape (normalized): {type:'POLICE'|'HAZARD'|'ACCIDENT'|..., subtype,
     latitude, longitude, street, city, num_thumbs_up, alert_reliability, ...} */
'use strict';

// OpenWeb Ninja key — a billable secret. Server-side only, but still keep it out of
// source control: supply it via the environment (e.g. systemd
// Environment=OPENWEBNINJA_KEY=… or a gitignored .env). Empty = the live Waze layer
// is disabled; hasKey() makes the server fall back to keyless sources cleanly.
// (Falls back to the legacy RAPIDAPI_KEY name so an older deploy keeps working.)
const WAZE_KEY = process.env.OPENWEBNINJA_KEY || process.env.RAPIDAPI_KEY || '';
// Per-call read: hasKey() is the gate the admin panel's kill switches layer
// over (flags.js), so it must reflect the live env, not a require-time copy.
function currentKey() { return process.env.OPENWEBNINJA_KEY || process.env.RAPIDAPI_KEY || ''; }
const URL = 'https://api.openwebninja.com/waze/alerts-and-jams';

function hasKey() { return !!currentKey(); }

// Which Waze alert types we surface. POLICE is the headline feature; the road
// hazards complement our own crowd-reporting and the OSM hazard pins.
var WANTED = { POLICE: true, ACCIDENT: true, HAZARD: true, ROAD_CLOSED: true };

// Map a Waze alert to the {kind,label,color} the client hazard layer reads.
// kind 'police' renders blue (and feeds the Ghost radar); others reuse hazard kinds.
function classify(a) {
  if (a.type === 'POLICE') return { kind: 'police', label: 'Police (Waze)', color: '#3b82f6' };
  if (a.type === 'ACCIDENT') return { kind: 'accident', label: a.street ? 'Accident · ' + a.street : 'Accident', color: '#ff3b3b' };
  if (a.type === 'ROAD_CLOSED') return { kind: 'hazard', label: a.street ? 'Road closed · ' + a.street : 'Road closed', color: '#ff5a3c' };
  // HAZARD + anything else
  return { kind: 'hazard', label: a.subtype ? a.subtype.replace(/_/g, ' ').toLowerCase() : 'Hazard', color: '#ff5a3c' };
}

// Circuit breaker: the free tier is small and SHARED by the live map layer and the
// hotspot collector. Once OpenWeb Ninja rate-limits us (429), hammering it only
// deepens the limit and burns quota — so after a 429 we stop calling upstream for a
// cooldown and answer 429 locally, letting the window recover. cb gets status 429 so
// callers (server → client/collector) can back off instead of retry-storming.
const COOLDOWN_MS = 10 * 60 * 1000; // 10 min upstream pause after a rate-limit
let rateLimitedUntil = 0;

// Upstream body cap. A normal alerts-and-jams reply for one bbox is a few hundred
// KB at most; an upstream contract change (or a compromised/misbehaving endpoint)
// returning something enormous would otherwise be buffered whole into memory.
const MAX_BODY_CHARS = 5 * 1024 * 1024;

// Fetch Waze alerts for a bbox. cb(err, status, geojson).
// bottomLeft/topRight are [lng,lat] pairs (MapLibre convention); we convert to
// the upstream "lat,lon" strings.
async function alerts(bottomLeft, topRight, cb) {
  // Per-call key read, same as hasKey(): the admin panel's kill switch swaps the
  // env at runtime, and gating on the require-time copy kept a cleared key
  // fetching (billable) while hasKey() told the caps probe it was off.
  var key = currentKey();
  if (!key) return cb(new Error('no key'));
  if (Date.now() < rateLimitedUntil) return cb(new Error('rate limited (cooldown)'), 429);
  var bl = bottomLeft[1] + ',' + bottomLeft[0]; // lat,lon
  var tr = topRight[1] + ',' + topRight[0];
  var u = URL + '?bottom_left=' + encodeURIComponent(bl) + '&top_right=' + encodeURIComponent(tr) + '&max_alerts=80&max_jams=0';
  try {
    // Bounded: Node's fetch never times out on its own, and a hung OpenWeb Ninja
    // would otherwise pin one of our request slots forever.
    var timeoutMs = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
    var sig = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    var r = await fetch(u, { headers: { 'x-api-key': key }, signal: sig });
    // 429 can arrive as the HTTP status OR in the JSON body ({status:'ERROR',error:{code:429}}).
    if (r.status === 429) { rateLimitedUntil = Date.now() + COOLDOWN_MS; return cb(new Error('upstream rate limited'), 429); }
    var clen = parseInt(r.headers.get('content-length') || '0', 10);
    if (clen > MAX_BODY_CHARS) return cb(new Error('upstream response too large'), r.status);
    var text = await r.text();
    if (text.length > MAX_BODY_CHARS) return cb(new Error('upstream response too large'), r.status);
    var j;
    try { j = JSON.parse(text); } catch (e) { return cb(new Error('bad upstream'), r.status); }
    if (j && j.error && j.error.code === 429) { rateLimitedUntil = Date.now() + COOLDOWN_MS; return cb(new Error('upstream rate limited'), 429); }
    if (!j || j.status !== 'OK' || !j.data) return cb(new Error('upstream error'), r.status);
    var list = (j.data.alerts || []).filter(function (a) { return WANTED[a.type] && typeof a.latitude === 'number'; });
    var feats = list.map(function (a) {
      var c = classify(a);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.longitude, a.latitude] },
        properties: {
          kind: c.kind, label: c.label, color: c.color,
          street: a.street || '', city: a.city || '',
          waze: true,               // source marker so popups can credit Waze
          thumbs: a.num_thumbs_up || 0,
          reliability: a.alert_reliability || 0,
          when: a.publish_datetime_utc || ''
        }
      };
    });
    cb(null, 200, { type: 'FeatureCollection', features: feats });
  } catch (e) { cb(e); }
}

module.exports = { hasKey, alerts, WANTED };
