/* Convoy — agent ingest: lets an external AI (or any script) push live map data.

   POST /api/agent/update with X-Agent-Key: <AGENT_KEY> and items like
     { type:'police',  lat, lng, label?, ttl? }          → live police layer + hotspot model
     { type:'hazard',  lat, lng, kind?, label?, ttl? }   → hazard pins
     { type:'traffic', lat, lng, label?, ttl? }          → hazard pins ("Heavy traffic")
     { type:'weather', lat, lng, kind?, label?, ttl? }   → hazard pins (weather kinds)
     { type:'hotspot', lat, lng, time? }                 → police-probability observation only

   Design: pushed items are held in bounded in-memory stores with a TTL and are
   MERGED into the responses of the endpoints the app already polls (/api/waze
   for the police layer, /api/incidents for hazard pins) — so agent data reaches
   every connected rider through the existing refresh loops, with zero client
   changes and zero extra client requests. Nothing is persisted; a restart
   clears the live items (hotspot observations persist via hotspots.js).

   Auth: the AGENT_KEY env var (systemd Environment= or gitignored server/.env).
   Unset ⇒ the whole feature is off and the routes 503. See AGENT-API.md. */
'use strict';

const crypto = require('crypto');
const hotspots = require('./hotspots');

const AGENT_KEY = process.env.AGENT_KEY || '';
const MAX_ITEMS = 500;              // per store; oldest evicted beyond this
const DEFAULT_TTL_S = 30 * 60;      // items live 30 min unless the caller says otherwise
const MAX_TTL_S = 24 * 3600;

// Hazard-pin kinds the client can actually render (keys of overlays.js
// HAZARD_ICONS). Anything else would draw an invisible pin — reject/replace it.
const HAZARD_KINDS = new Set([
  'accident', 'stopped', 'police', 'debris', 'hazard', 'ice', 'snow',
  'fog', 'rain', 'wind', 'flood', 'closure', 'alert'
]);
// Per-type defaults when the caller doesn't pass a kind/label.
const TYPE_DEFAULTS = {
  hazard:  { kind: 'hazard', label: 'Hazard reported', color: '#ff5a3c' },
  traffic: { kind: 'hazard', label: 'Heavy traffic',   color: '#ff9f43' },
  weather: { kind: 'alert',  label: 'Weather alert',   color: '#ffd23f' }
};

const police = [];  // { lng, lat, label, when, until }
const hazards = []; // { lng, lat, kind, label, color, until }

function enabled() { return !!AGENT_KEY; }

// Timing-safe key check. Accepts X-Agent-Key or Authorization: Bearer.
function authed(req) {
  if (!AGENT_KEY) return false;
  const h = req.headers['x-agent-key'] ||
    ((req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  const a = Buffer.from(String(h)), b = Buffer.from(AGENT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLngLat(lng, lat) {
  return Number.isFinite(lng) && Number.isFinite(lat) &&
    lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function ttlMs(v) {
  const s = Number(v);
  return (Number.isFinite(s) && s > 0 ? Math.min(s, MAX_TTL_S) : DEFAULT_TTL_S) * 1000;
}

// Labels end up inside popup HTML client-side (escaped there too — belt and braces).
function cleanLabel(v, dflt) {
  if (typeof v !== 'string') return dflt;
  const t = v.replace(/[<>]/g, '').trim().slice(0, 60);
  return t || dflt;
}

function prune(list) {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].until <= now) list.splice(i, 1);
}

function push(list, item) {
  list.push(item);
  if (list.length > MAX_ITEMS) list.shift();
}

// Validate + store a batch. Returns { accepted, rejected:[{index, reason}] }.
function ingest(items) {
  const rejected = [];
  let accepted = 0;
  const now = Date.now();
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') return rejected.push({ index: i, reason: 'not an object' });
    const lng = Number(it.lng), lat = Number(it.lat);
    if (!isLngLat(lng, lat)) return rejected.push({ index: i, reason: 'bad lat/lng' });

    if (it.type === 'hotspot') {
      // A (possibly historical) police observation for the probability model.
      // Future timestamps make no sense; anything beyond now+60s falls back to now.
      let ts = Number(it.time);
      if (!Number.isFinite(ts) || ts <= 0 || ts > now + 60000) ts = now;
      hotspots.record(lng, lat, ts);
      accepted++;
      return;
    }
    if (it.type === 'police') {
      push(police, {
        lng, lat,
        label: cleanLabel(it.label, 'Police reported'),
        when: new Date(now).toISOString(),
        until: now + ttlMs(it.ttl)
      });
      // A live sighting is also an observation — same as the Waze/crowd paths.
      hotspots.record(lng, lat, now);
      accepted++;
      return;
    }
    const def = TYPE_DEFAULTS[it.type];
    if (!def) return rejected.push({ index: i, reason: 'unknown type "' + String(it.type).slice(0, 24) + '"' });
    const kind = (typeof it.kind === 'string' && HAZARD_KINDS.has(it.kind)) ? it.kind : def.kind;
    push(hazards, {
      lng, lat, kind,
      label: cleanLabel(it.label, def.label),
      color: def.color,
      until: now + ttlMs(it.ttl)
    });
    accepted++;
  });
  return { accepted, rejected };
}

function inBox(o, bl, tr) {
  return o.lng >= bl[0] && o.lng <= tr[0] && o.lat >= bl[1] && o.lat <= tr[1];
}

// Live agent police as features shaped like waze.js's — the client police layer
// (ghost.js filters kind==='police') consumes them with no changes.
function policeFeatures(bl, tr) {
  prune(police);
  return police.filter((p) => inBox(p, bl, tr)).map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: {
      kind: 'police', label: p.label, color: '#3b82f6',
      street: '', city: '', agent: true,
      thumbs: 0, reliability: 0, when: p.when
    }
  }));
}

// Live agent hazards as features shaped like tomtom.js incidents — the client
// hazard layer keys the icon off `kind` and shows `label` in the popup.
function hazardFeatures(bl, tr) {
  prune(hazards);
  return hazards.filter((h) => inBox(h, bl, tr)).map((h) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
    properties: { kind: h.kind, label: h.label, color: h.color, agent: true }
  }));
}

function counts() {
  prune(police); prune(hazards);
  return { police: police.length, hazards: hazards.length, hotspotObservations: hotspots.count() };
}

module.exports = { enabled, authed, ingest, policeFeatures, hazardFeatures, counts };
