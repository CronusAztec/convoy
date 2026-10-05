/* Convoy — overlays pack: the TomTom traffic halves the core no longer carries.
   Restored from server/tomtom.js (pre-cut tree a1de6fd): flow tiles and
   incident details. The key is the same TOMTOM_KEY the core's routing proxy
   reads; it never leaves this process. Every upstream call is bounded (a
   deadline, a body cap) — the tile route alone admits hundreds of requests a
   minute, and an unbounded upstream would hold sockets open indefinitely. */
'use strict';

const TRAFFIC_TILE = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/';
const INCIDENT_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const UPSTREAM_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function key() { return process.env.TOMTOM_KEY || ''; }
function hasKey() { return !!key(); }
function withTimeout(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms || UPSTREAM_MS);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || UPSTREAM_MS);
  if (t.unref) t.unref();
  return c.signal;
}
function oversize(r) {
  const n = parseInt(r.headers.get('content-length') || '0', 10);
  return n > MAX_BODY_BYTES;
}

// One flow tile. cb(err, status, headers, buffer).
async function tile(z, x, y, cb) {
  if (!hasKey()) return cb(new Error('no key'));
  const url = TRAFFIC_TILE + z + '/' + x + '/' + y + '.png?tileSize=256&key=' + key();
  try {
    const r = await fetch(url, { signal: withTimeout() });
    if (oversize(r)) return cb(new Error('upstream response too large'));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) return cb(new Error('upstream response too large'));
    cb(null, r.status, { 'Content-Type': r.headers.get('content-type') || 'image/png' }, buf);
  } catch (e) { cb(e); }
}

// TomTom's iconCategory → our hazard pins. Point hazards only: jams (6),
// lane-closed (7), road-works (9) and road-closed (8) are dropped on purpose —
// the flow heatmap already shows congestion, and a metro's hundreds of segment
// "closures" would bury the real hazards.
const INCIDENT_KINDS = {
  1:  { kind: 'accident', label: 'Accident',             color: '#ff3b3b' },
  3:  { kind: 'hazard',   label: 'Dangerous conditions', color: '#ff5a3c' },
  5:  { kind: 'ice',      label: 'Ice on road',          color: '#7fe3ff' },
  11: { kind: 'flood',    label: 'Flooding',             color: '#3aa0ff' },
  14: { kind: 'stopped',  label: 'Stopped vehicle',      color: '#ff9f43' }
};
const INCIDENT_CAP = 250;

function incidentPoint(geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return null;
  if (geom.type === 'Point') return geom.coordinates;
  if (geom.type === 'LineString' && geom.coordinates.length) {
    const p = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    return Array.isArray(p) ? p : null;
  }
  return null;
}

// Pure: upstream JSON → hazard-pin FeatureCollection (exported for the suite).
function toFeatures(j) {
  const feats = [];
  if (!j || !Array.isArray(j.incidents)) return null;
  for (let i = 0; i < j.incidents.length && feats.length < INCIDENT_CAP; i++) {
    const inc = j.incidents[i] || {}, props = inc.properties || {};
    const def = Object.prototype.hasOwnProperty.call(INCIDENT_KINDS, props.iconCategory) ? INCIDENT_KINDS[props.iconCategory] : null;
    if (!def) continue;
    const pt = incidentPoint(inc.geometry);
    if (!pt || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') continue;
    const ev = props.events && props.events[0] && props.events[0].description;
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt[0], pt[1]] },
      properties: { kind: def.kind, label: typeof ev === 'string' ? ev.slice(0, 80) : def.label, color: def.color, incident: true, tomtom: true }
    });
  }
  return { type: 'FeatureCollection', features: feats };
}

// Incidents for a bbox → hazard-pin GeoJSON. cb(err, status, featureCollection).
async function incidents(minLng, minLat, maxLng, maxLat, cb) {
  if (!hasKey()) return cb(new Error('no key'));
  const bbox = minLng + ',' + minLat + ',' + maxLng + ',' + maxLat;
  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,iconCategory}}}}';
  const url = INCIDENT_URL + '?bbox=' + encodeURIComponent(bbox) +
    '&fields=' + encodeURIComponent(fields) + '&language=en-GB&timeValidityFilter=present&key=' + key();
  try {
    const r = await fetch(url, { signal: withTimeout() });
    if (oversize(r)) return cb(new Error('upstream response too large'), r.status);
    const text = await r.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return cb(new Error('upstream response too large'), r.status);
    let j;
    try { j = JSON.parse(text); } catch (e) { return cb(new Error('bad upstream'), r.status); }
    const fc = toFeatures(j);
    if (!fc) return cb(new Error('upstream error'), r.status);
    cb(null, 200, fc);
  } catch (e) { cb(e); }
}

module.exports = { hasKey, tile, incidents, toFeatures, INCIDENT_KINDS, INCIDENT_CAP };
