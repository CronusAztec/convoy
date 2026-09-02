#!/usr/bin/env node
/* Convoy — multi-source police finder (always-on collector).

   Supersedes collect-hotspots.js. Where the old collector only drove the server's
   Waze proxy, this sweeps EVERY source we can reach and fuses them onto the map:

     1. Waze (OpenWeb Ninja)  — POSTs each region bbox to the LOCAL server's
        /api/waze. The server injects the key, classifies alerts, records live
        'police' sightings into the hotspot model, and merges agent pins. This is
        the SAME single-writer path the old collector used, so hotspots.json stays
        owned by one process. (No key on the server ⇒ this source is a quiet no-op.)

     2. Citizen (citizen.com)  — keyless public incident feed. We pull trending
        incidents per bbox and keep the police-relevant ones (category
        "Police Related" or a police-y title: pursuit, checkpoint, DUI, arrest…),
        then push them as live `police` pins via /api/agent/update.

     3. OSM speed cameras (Overpass) — static automated-enforcement locations. Fed
        into the hotspot PROBABILITY model as observations (a camera is "police
        usually here"), refreshed on a slow cadence so we're gentle on Overpass.

     4. Waze keyless live-map GeoRSS — best-effort. Waze bot-blocks datacenter IPs
        (403), so this self-disables after a couple of failures and never blocks a
        sweep; if a box happens to have access, its police alerts ride source #2's
        agent-push path.

     5. PulsePoint (pulsepoint.org) — the nationwide Fire/EMS/police dispatch (CAD)
        network. Its webapp API returns AES-encrypted JSON; we decrypt it with the
        same public scheme its own web client uses, auto-discover the dispatch
        agencies sitting inside our regions, and surface the police-relevant call
        types (traffic collisions + law-enforcement) as live police pins.

     6. Open municipal incident feeds — live, keyless city datasets (Socrata). Seeded
        with Austin's Real-Time Traffic Incident Reports; each active collision/hazard
        becomes a police-on-scene pin. Config-driven (OPEN_FEEDS) so more cities can be
        added as they're verified live-with-coordinates.

     7. Google Maps incidents — best-effort, like #4. Google's live crowd-reported
        police sightings live inside the Google Maps app's incident layer; there is
        NO official public API for them and the app's own feed is bot-protected and
        not a stable contract. So this reads a configurable incident endpoint per
        region, keeps the police-relevant entries, and self-disables after a couple
        of blocks/errors. It stays a quiet no-op until GOOGLE_INCIDENTS_URL points at
        a reachable feed (your own Maps-incident proxy/mirror).

   Sources 2–7 reach the map through POST /api/agent/update, which MERGES pushed
   items into the very feeds every client already polls (/api/waze for police pins,
   the hotspot model for the probability heatmap) — zero client changes, zero extra
   client requests. That endpoint needs AGENT_KEY set on the server (see AGENT-API.md);
   without it, only source #1 runs and the finder says so at startup.

   Run continuously (pick one):
     node server/police-finder.js
     pm2 start server/police-finder.js --name convoy-police-finder
     systemd: see deploy/convoy-police-finder.service

   Config (env):
     FINDER_URL         base URL of the API          (default http://localhost:5173)
     AGENT_KEY          shared secret for agent push (same value as the server's)
     FINDER_INTERVAL_MS gap between full sweeps       (default 900000 = 15 min)
     FINDER_STEP_MS     gap between region requests   (default 5000 = 5s)
     FINDER_REGIONS     path to a regions JSON        (default ./collect-regions.json)
     FINDER_REGIONS_PER_SWEEP  regions polled per cycle (default 20) — the region
                        list is nationwide (~120 metros); each cycle sweeps the
                        next slice, rotating so the whole USA is covered every
                        ~ceil(N/20) cycles at the SAME API quota as a short list
     FINDER_CAMERAS     '1'/'0' — OSM speed cameras   (default 1)
     FINDER_CITIZEN     '1'/'0' — Citizen feed        (default 1)
     FINDER_WAZE        '1'/'0' — Waze via server     (default 1)
     FINDER_PULSEPOINT  '1'/'0' — PulsePoint CAD feed (default 1)
     PP_PER_SWEEP       PulsePoint agencies polled per cycle (default 40, rotating)
     FINDER_OPENFEEDS   '1'/'0' — municipal incident feeds (default 1)
     FINDER_GOOGLE      '1'/'0' — Google Maps incidents (default 1; a no-op until
                        GOOGLE_INCIDENTS_URL is set)
     GOOGLE_INCIDENTS_URL  URL template for a reachable Google Maps-incident feed,
                        with bbox placeholders substituted per region:
                        {minLat} {minLng} {maxLat} {maxLng} {cLat} {cLng}
     CAMERA_EVERY       run the camera sweep every N cycles (default 24 ≈ 6h at 15m) */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = (process.env.FINDER_URL || process.env.COLLECT_URL || 'http://localhost:5173').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';

// Fail LOUDLY on a malformed interval ("15m", typos): a NaN wait would spin the
// sweep loop with no pause. (Same guard the old collector used.)
function envInt(name, def, min) {
  const raw = process.env[name];
  const v = parseInt(raw || String(def), 10);
  if (!Number.isFinite(v) || v < min) {
    console.error('[finder] invalid ' + name + '="' + raw + '" — expected integer ms >= ' + min + '. Aborting.');
    process.exit(1);
  }
  return v;
}
function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return !/^(0|false|no|off)$/i.test(raw);
}

const INTERVAL_MS = envInt('FINDER_INTERVAL_MS', 900000, 60000); // 15 min between sweeps
const STEP_MS = envInt('FINDER_STEP_MS', 5000, 500);             // 5s between region requests
const REGIONS_PER_SWEEP = envInt('FINDER_REGIONS_PER_SWEEP', 20, 1); // rotating slice size per cycle
const PP_PER_SWEEP = envInt('PP_PER_SWEEP', 40, 1);              // PulsePoint agencies polled per cycle
const CAMERA_EVERY = envInt('CAMERA_EVERY', 24, 1);              // camera sweep cadence (in cycles)
const REGIONS_FILE = process.env.FINDER_REGIONS || process.env.COLLECT_REGIONS || path.join(__dirname, 'collect-regions.json');
const USE_CAMERAS = envBool('FINDER_CAMERAS', true);
const USE_CITIZEN = envBool('FINDER_CITIZEN', true);
const USE_WAZE = envBool('FINDER_WAZE', true);
const USE_PULSEPOINT = envBool('FINDER_PULSEPOINT', true);
const PP_REDISCOVER_EVERY = envInt('PP_REDISCOVER_EVERY', 96, 1); // re-scan agencies every N cycles (~24h at 15min)
const USE_OPENFEEDS = envBool('FINDER_OPENFEEDS', true);          // municipal real-time incident feeds (Socrata)
const USE_GOOGLE = envBool('FINDER_GOOGLE', true);               // Google Maps incidents (best-effort)
const GOOGLE_URL = (process.env.GOOGLE_INCIDENTS_URL || '').trim(); // URL template; empty ⇒ source disabled

if (typeof fetch !== 'function') {
  console.error('[finder] global fetch unavailable — needs Node 18+. Aborting.');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

// fetch with a hard client-side deadline. A hung upstream (Overpass/Citizen holding
// a socket open, no response) would otherwise freeze a whole sweep forever — the
// query-level [timeout:25] only bounds Overpass's OWN work, not a stuck connection.
// Throws 'timeout' on deadline so callers fall through to their try/catch.
function fetchT(url, opts, ms) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opts || {}));
}

/* ----------------------------- regions ----------------------------- */
function loadRegions() {
  let raw;
  try { raw = fs.readFileSync(REGIONS_FILE, 'utf8'); }
  catch (e) { console.error('[finder] cannot read regions file ' + REGIONS_FILE + ': ' + e.message); process.exit(1); }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { console.error('[finder] regions file is not valid JSON: ' + e.message); process.exit(1); }
  const list = (j && Array.isArray(j.regions) ? j.regions : []).filter((r) =>
    r && Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => typeof n === 'number' && isFinite(n)));
  if (!list.length) { console.error('[finder] no valid regions in ' + REGIONS_FILE); process.exit(1); }
  return list;
}

/* ----------------------------- agent push ----------------------------- */
// Push a batch of agent items to the local server. Chunks to the API's 100/call
// cap. Never throws — a push failure just means those pins skip this sweep.
async function pushAgent(items) {
  if (!AGENT_KEY || !items.length) return { accepted: 0, sent: false };
  let accepted = 0;
  for (let i = 0; i < items.length; i += 100) {
    if (stopping) break;
    const chunk = items.slice(i, i + 100);
    try {
      const res = await fetchT(BASE + '/api/agent/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_KEY },
        body: JSON.stringify({ items: chunk })
      }, 15000);
      if (res.status === 401) { console.warn('[finder] agent push unauthorized — AGENT_KEY mismatch with the server'); break; }
      if (res.status === 503) { console.warn('[finder] server has no AGENT_KEY — agent push disabled this run'); break; }
      if (!res.ok) { console.warn('[finder] agent push HTTP ' + res.status); continue; }
      const j = await res.json().catch(() => ({}));
      accepted += (j && j.accepted) || 0;
    } catch (e) {
      console.warn('[finder] agent push failed: ' + e.message);
    }
  }
  return { accepted, sent: true };
}

/* ----------------------------- source 1: Waze via server ----------------------------- */
// POST the bbox to the local /api/waze — the server records police sightings into
// the hotspot model and merges agent pins. Returns the police-feature count, or -1.
// Signals rate-limit / missing-key so the caller can back off like the old collector.
async function pollWaze(region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const body = JSON.stringify({ bottomLeft: [minLng, minLat], topRight: [maxLng, maxLat] });
  let res;
  try {
    res = await fetchT(BASE + '/api/waze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    }, 15000);
  } catch (e) {
    return { police: -1, rateLimited: false };
  }
  if (res.status === 429) return { police: -1, rateLimited: true };
  if (res.status === 503) return { police: -1, keyMissing: true };
  if (!res.ok) return { police: -1, rateLimited: false };
  let fc;
  try { fc = await res.json(); } catch (e) { return { police: -1 }; }
  const feats = (fc && fc.features) || [];
  return { police: feats.filter((f) => f.properties && f.properties.kind === 'police').length };
}

/* ----------------------------- source 2: Citizen ----------------------------- */
// A police-y title even when Citizen miscategorizes the incident (real feed has
// "Police Activity" filed under unrelated categories, so title-match is the anchor).
const POLICE_RE = /\b(police|pursuit|chase|checkpoint|dui|sobriety|patrol|swat|officer|detained|arrest|standoff|manhunt|barricad|traffic stop|highway patrol|sheriff|state trooper|speed trap)\b/i;

// Collapse near-identical Citizen pushes: one incident key is re-served on every
// sweep for its whole lifetime, so without this a single event would re-push (and
// keep resetting its TTL) forever. Re-push only after CITIZEN_REPUSH_MS.
const CITIZEN_REPUSH_MS = 20 * 60 * 1000;
const citizenSeen = new Map(); // key -> last-pushed ts

async function pollCitizen(region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const u = 'https://citizen.com/api/incident/trending?lowerLatitude=' + minLat +
    '&lowerLongitude=' + minLng + '&upperLatitude=' + maxLat + '&upperLongitude=' + maxLng +
    '&fullResponse=true&limit=60';
  let res;
  try {
    res = await fetchT(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, 12000);
  } catch (e) { return { items: [], error: e.message }; }
  if (!res.ok) return { items: [], error: 'HTTP ' + res.status };
  let j;
  try { j = await res.json(); } catch (e) { return { items: [], error: 'bad JSON' }; }
  const results = (j && j.results) || [];
  const now = Date.now();
  const items = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lat = Number(r.latitude != null ? r.latitude : (r.ll && r.ll[0]));
    const lng = Number(r.longitude != null ? r.longitude : (r.ll && r.ll[1]));
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const title = String(r.title || r.raw || '').trim();
    const cats = Array.isArray(r.categories) ? r.categories.join(' ') : '';
    const isPolice = /police related/i.test(cats) || POLICE_RE.test(title);
    if (!isPolice) continue;
    // Skip stale incidents (Citizen keeps closed events in "trending" a while).
    const ts = Number(r.ts || r.cs || 0);
    if (ts && now - ts > 3 * 3600 * 1000) continue;
    const key = r.key || (lat.toFixed(5) + ',' + lng.toFixed(5) + ':' + title);
    const last = citizenSeen.get(key);
    if (last != null && now - last < CITIZEN_REPUSH_MS) continue;
    citizenSeen.set(key, now);
    items.push({
      type: 'police', lat, lng,
      label: (title || 'Police activity').slice(0, 60),
      ttl: 45 * 60 // 45 min live
    });
  }
  return { items };
}

/* ----------------------------- source 3: OSM speed cameras ----------------------------- */
// Overpass is a shared community resource — hit it gently (own endpoint list, slow
// cadence). Cameras are static, so we feed them as hotspot OBSERVATIONS (they build
// the "police usually here" probability model) rather than churning live pins.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
async function pollCameras(region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const q = '[out:json][timeout:25];node["highway"="speed_camera"](' +
    minLat + ',' + minLng + ',' + maxLat + ',' + maxLng + ');out 400;';
  for (let e = 0; e < OVERPASS.length; e++) {
    let res;
    try {
      res = await fetchT(OVERPASS[e], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'convoy-police-finder/1.0' },
        body: 'data=' + encodeURIComponent(q)
      }, 30000); // Overpass is slow; its own [timeout:25] + connection overhead
    } catch (err) { continue; } // timeout or network error → try the next mirror
    if (!res.ok) continue;
    let j;
    try { j = await res.json(); } catch (err) { continue; }
    const els = (j && j.elements) || [];
    const now = Date.now();
    const items = els.filter((n) => isFinite(n.lat) && isFinite(n.lon)).map((n) => ({
      type: 'hotspot', lat: n.lat, lng: n.lon, time: now
    }));
    return { items };
  }
  return { items: [], error: 'all Overpass mirrors failed' };
}

/* ----------------------------- source 4: Waze keyless (best-effort) ----------------------------- */
// Waze bot-blocks datacenter IPs (403). Try twice; on repeated block, disable for
// the process so it never costs a sweep again.
let wazeKeylessDead = false, wazeKeylessFails = 0;
async function pollWazeKeyless(region) {
  if (wazeKeylessDead) return { items: [] };
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const u = 'https://www.waze.com/live-map/api/georss?top=' + maxLat + '&bottom=' + minLat +
    '&left=' + minLng + '&right=' + maxLng + '&env=na&types=alerts';
  let res;
  try {
    res = await fetchT(u, { headers: { 'User-Agent': UA, 'Referer': 'https://www.waze.com/live-map/', 'Accept': 'application/json' } }, 10000);
  } catch (e) { return { items: [] }; }
  if (res.status === 403 || res.status === 429) {
    if (++wazeKeylessFails >= 2) { wazeKeylessDead = true; console.warn('[finder] Waze keyless blocked (' + res.status + ') — disabling that source for this run'); }
    return { items: [] };
  }
  if (!res.ok) return { items: [] };
  let j;
  try { j = await res.json(); } catch (e) { return { items: [] }; }
  const alerts = (j && j.alerts) || [];
  const items = [];
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i];
    if (a.type !== 'POLICE' || !a.location) continue;
    const lat = Number(a.location.y), lng = Number(a.location.x);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    // Neutral label on purpose. This source is SCRAPED from Waze's private
    // live-map endpoint, not licensed — so the pin must not carry Waze's brand
    // into the app the way the paid OpenWeb Ninja path in server/waze.js does.
    // Riders see "Police reported", credited to the generic live data feed.
    items.push({ type: 'police', lat, lng, label: 'Police reported', ttl: 30 * 60 });
  }
  return { items };
}

/* ----------------------------- source 7: Google Maps incidents (keyless, best-effort) -----------------------------
   Google's live, crowd-reported police sightings live INSIDE the Google Maps app's
   incident layer — there is no official public API for them, and the app's own feed
   is bot-protected and not a stable contract. So, exactly like the keyless-Waze
   source (#4), this is BEST-EFFORT: it reads an incident feed for each region, keeps
   the police-relevant incidents, and self-disables after a couple of blocks/errors so
   it never costs a sweep. It is a quiet no-op until GOOGLE_INCIDENTS_URL points at a
   reachable endpoint (your own Maps-incident proxy, a mirror, etc.).

   GOOGLE_INCIDENTS_URL is a URL TEMPLATE; the per-region bbox is substituted for the
   placeholders {minLat} {minLng} {maxLat} {maxLng} {cLat} {cLng}. The response is
   parsed DEFENSIVELY as either (a) a GeoJSON FeatureCollection or (b) a flat array of
   incident objects ({lat|latitude|y, lng|lon|longitude|x, type|category|description|
   title}); a leading XSSI guard ()]}' or while(1);) is stripped first. Only police-
   relevant incidents (an explicit police/speed-trap type, or a police-y text via the
   shared POLICE_RE) survive, and ride the same /api/agent/update path as the others. */
const GOOGLE_REPUSH_MS = 20 * 60 * 1000;
const googleSeen = new Map();  // incident key -> last-pushed ts
// Incident type/category strings a Maps-style feed uses for enforcement.
const GOOGLE_POLICE_TYPE = /^(police|speed[_ -]?trap|speedtrap|checkpoint|law[_ -]?enforcement)$/i;
let googleDead = false, googleFails = 0;

// Substitute a region's bbox into a URL template's {placeholders}.
function fillBbox(tpl, region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
  return tpl
    .replace(/\{minLat\}/g, minLat).replace(/\{minLng\}/g, minLng)
    .replace(/\{maxLat\}/g, maxLat).replace(/\{maxLng\}/g, maxLng)
    .replace(/\{cLat\}/g, cLat).replace(/\{cLng\}/g, cLng);
}

// Pull police-relevant incidents out of whatever shape the endpoint returned
// (GeoJSON, or a flat array of objects under a few common keys). Returns
// [{lat, lng, label}] for the police entries only.
function parseGoogleIncidents(j) {
  const out = [];
  const add = (lat, lng, text) => {
    lat = Number(lat); lng = Number(lng);
    if (isFinite(lat) && isFinite(lng)) out.push({ lat, lng, label: String(text || 'Police activity').slice(0, 40) });
  };
  const isPolice = (type, text) =>
    (type != null && GOOGLE_POLICE_TYPE.test(String(type))) || (text != null && POLICE_RE.test(String(text)));

  if (j && Array.isArray(j.features)) {                        // (a) GeoJSON
    for (const f of j.features) {
      const g = f && f.geometry, p = (f && f.properties) || {};
      if (!g || !Array.isArray(g.coordinates)) continue;
      const type = p.type || p.category || p.incidentType;
      const text = p.description || p.title || p.name || '';
      if (!isPolice(type, text)) continue;
      add(g.coordinates[1], g.coordinates[0], text || 'Police');
    }
    return out;
  }
  const arr = Array.isArray(j) ? j : (j && (j.incidents || j.results || j.items));
  if (Array.isArray(arr)) {                                   // (b) flat array of objects
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      const lat = r.lat != null ? r.lat : (r.latitude != null ? r.latitude : r.y);
      const lng = r.lng != null ? r.lng : (r.lon != null ? r.lon : (r.longitude != null ? r.longitude : r.x));
      const type = r.type || r.category || r.incidentType;
      const text = r.description || r.title || r.name || '';
      if (!isPolice(type, text)) continue;
      add(lat, lng, text || 'Police');
    }
  }
  return out;
}

async function pollGoogleIncidents(region) {
  if (googleDead || !GOOGLE_URL) return { items: [] };
  const url = fillBbox(GOOGLE_URL, region);
  let res;
  try {
    res = await fetchT(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, 12000);
  } catch (e) { return { items: [] }; }
  if (res.status === 403 || res.status === 429) {
    if (++googleFails >= 2) { googleDead = true; console.warn('[finder] Google incidents blocked (' + res.status + ') — disabling that source for this run'); }
    return { items: [] };
  }
  if (!res.ok) return { items: [] };
  let text;
  try { text = await res.text(); } catch (e) { return { items: [] }; }
  // Strip a leading XSSI guard ()]}' or while(1);) that Google-style JSON endpoints prepend.
  text = text.replace(/^\)\]\}'[^\n]*\n?/, '').replace(/^while\(1\);/, '').trim();
  let j;
  try { j = JSON.parse(text); }
  catch (e) {
    // Not JSON (an HTML consent/redirect page, or protobuf) → treat as a soft block.
    if (++googleFails >= 3) { googleDead = true; console.warn('[finder] Google incidents returned non-JSON repeatedly — disabling that source for this run'); }
    return { items: [] };
  }
  const now = Date.now();
  const items = [];
  for (const inc of parseGoogleIncidents(j)) {
    const key = 'g:' + inc.lat.toFixed(5) + ',' + inc.lng.toFixed(5) + ':' + inc.label;
    const last = googleSeen.get(key);
    if (last != null && now - last < GOOGLE_REPUSH_MS) continue;
    googleSeen.set(key, now);
    items.push({ type: 'police', lat: inc.lat, lng: inc.lng, label: '🚔 ' + inc.label + ' (Google)', ttl: 30 * 60 });
  }
  return { items };
}

/* ----------------------------- source 5: PulsePoint (CAD, decrypted) ----------------------------- */
// PulsePoint is a nationwide Fire/EMS/police dispatch network. Its webapp API returns
// AES-encrypted JSON ({ct,iv,s}); the passphrase + OpenSSL-EVP(MD5) key derivation below
// are the long-known scheme its OWN web client uses to read it (not a break — same public
// data the site shows). We surface only the police-relevant call types — traffic collisions
// (police on scene) and law-enforcement dispatches — as live police pins.
const PP_BASE = 'https://api.pulsepoint.org/v1/webapp';
const PP_PASS = 'tombrady5rings';
// Call type code -> human label. TC* = traffic collision (police respond), LE*/AI =
// law-enforcement / investigation. Every other code (medical, fire, alarms) is skipped.
const PP_TYPES = {
  TC: 'Collision', TCE: 'Collision', TCP: 'Collision (ped)', TCS: 'Collision',
  LE: 'Police activity', LEO: 'Police activity', AI: 'Investigation'
};
const PP_MAX_PER_REGION = 6;                // cap agencies kept per region
const PP_REPUSH_MS = 20 * 60 * 1000;        // re-push the same incident at most this often
const PP_STEP_MS = 700;                     // gap between agency polls (gentle)
const ppSeen = new Map();                   // incident id -> last-pushed ts
let ppAgencies = [];                        // [{ id, lat, lng }] discovered agencies in-region
let ppCursor = 0;                           // rotating index into ppAgencies (PP_PER_SWEEP per cycle)

function ppEvpKey(salt) {
  let d = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (d.length < 32) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(PP_PASS, 'utf8'), salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  return d.slice(0, 32);
}
function ppDecrypt(obj) {
  const ct = Buffer.from(obj.ct, 'base64');
  const iv = Buffer.from(obj.iv, 'hex');
  const salt = Buffer.from(obj.s, 'hex');
  const dec = crypto.createDecipheriv('aes-256-cbc', ppEvpKey(salt), iv);
  let out = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  out = out.substring(1);                        // strip the leading wrapping quote
  out = out.substring(0, out.lastIndexOf('"'));  // ...and the trailing one
  return JSON.parse(out.replace(/\\"/g, '"'));   // un-escape the double-encoded JSON
}
async function ppGet(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } }, 15000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const o = await res.json();
  if (!o || !o.ct) throw new Error('unencrypted/err'); // e.g. {StatusCode:400}
  return ppDecrypt(o);
}
function inBbox(lat, lng, bbox) {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
// Find the dispatch agencies actually inside our regions: name-search each region and
// keep matches whose coordinates land in that region's bbox (drops same-name agencies
// elsewhere). Cached for the process; re-run every PP_REDISCOVER_EVERY cycles.
async function ppDiscover(regions) {
  const found = new Map();
  for (const region of regions) {
    if (stopping) break;
    try {
      const j = await ppGet(PP_BASE + '?resource=searchagencies&token=' + encodeURIComponent(region.name));
      const list = (j && j.searchagencies) || [];
      let kept = 0;
      for (const a of list) {
        const id = a.agencyid || a.id, lat = Number(a.lat), lng = Number(a.lng);
        if (!id || !isFinite(lat) || !isFinite(lng) || !inBbox(lat, lng, region.bbox)) continue;
        if (!found.has(id)) found.set(id, { id: id, lat: lat, lng: lng });
        if (++kept >= PP_MAX_PER_REGION) break;
      }
    } catch (e) { /* no PulsePoint coverage for this region — fine */ }
    if (!stopping) await sleep(600);
  }
  ppAgencies = Array.from(found.values());
  console.log('[finder] pulsepoint: ' + ppAgencies.length + ' agencies in-region');
}
// Poll one agency's ACTIVE incidents → police-relevant agent items (deduped by id).
async function ppPollAgency(agencyId) {
  let j;
  try { j = await ppGet(PP_BASE + '?resource=incidents&agencyid=' + encodeURIComponent(agencyId)); }
  catch (e) { return { items: [] }; }
  const active = (j && j.incidents && j.incidents.active) || [];
  const now = Date.now();
  const items = [];
  for (const inc of active) {
    const label = PP_TYPES[inc.PulsePointIncidentCallType];
    if (!label) continue;
    const lat = Number(inc.Latitude), lng = Number(inc.Longitude);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const id = 'pp:' + (inc.ID || (lat.toFixed(5) + ',' + lng.toFixed(5)));
    const last = ppSeen.get(id);
    if (last != null && now - last < PP_REPUSH_MS) continue;
    ppSeen.set(id, now);
    items.push({ type: 'police', lat: lat, lng: lng, label: '🚔 ' + label, ttl: 30 * 60 });
  }
  return { items };
}

/* ----------------------------- source 6: open municipal incident feeds ----------------------------- */
// Live city traffic-incident feeds (keyless Socrata JSON). Each entry maps a dataset
// to how its rows expose lat/lng/type. Active collisions/hazards ⇒ police-on-scene
// pins. Add a feed here once it's verified live-with-coordinates for a covered region.
const OPEN_FEEDS = [
  {
    name: 'Austin',
    // Austin publishes ACTIVE traffic incidents in real time (agency = APD / Travis SO).
    url: "https://data.austintexas.gov/resource/dx9v-zd7x.json?$where=traffic_report_status=%27ACTIVE%27&$limit=200",
    lat: (r) => Number(r.latitude), lng: (r) => Number(r.longitude),
    id: (r) => r.traffic_report_id, type: (r) => r.issue_reported || 'Incident'
  }
  // More live-with-coords Socrata feeds (add the region to collect-regions.json first):
  //   Honolulu: https://data.honolulu.gov/resource/ykb6-n5th.json
  //   Calgary:  https://data.calgary.ca/resource/4jah-h97u.json
];
// Which incident type strings mean police are on scene. Austin uses free-text like
// "COLLISION", "Crash Service", "Traffic Hazard", "AUTO/ PED", "Stalled Vehicle".
const OPEN_POLICE_RE = /collision|crash|hazard|vehicle|\bped\b|pedestrian|stalled|block|impediment|debris|injury|police|hit and run|traffic viol/i;
const OPEN_REPUSH_MS = 20 * 60 * 1000;
const openSeen = new Map();

async function pollOpenFeeds() {
  const now = Date.now();
  const items = [];
  for (const f of OPEN_FEEDS) {
    if (stopping) break;
    let rows;
    try {
      const res = await fetchT(f.url, { headers: { 'User-Agent': UA } }, 12000);
      if (!res.ok) { if (!stopping) await sleep(400); continue; }
      rows = await res.json();
    } catch (e) { if (!stopping) await sleep(400); continue; }
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const type = f.type(r);
        if (!OPEN_POLICE_RE.test(String(type))) continue;
        const lat = f.lat(r), lng = f.lng(r);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        const key = 'open:' + f.name + ':' + (f.id(r) || (lat.toFixed(5) + ',' + lng.toFixed(5)));
        const last = openSeen.get(key);
        if (last != null && now - last < OPEN_REPUSH_MS) continue;
        openSeen.set(key, now);
        const label = String(type).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 48);
        items.push({ type: 'police', lat: lat, lng: lng, label: '🚔 ' + label, ttl: 30 * 60 });
      }
    }
    if (!stopping) await sleep(400);
  }
  const cut = now - OPEN_REPUSH_MS;
  for (const [k, ts] of openSeen) if (ts < cut) openSeen.delete(k);
  return { items };
}

/* ----------------------------- sweep ----------------------------- */
async function sweep(regions, cycle) {
  const t0 = Date.now();
  // Cameras are a heavy Overpass sweep (18 slow calls). Keep them OFF the very first
  // cycle so the boot sweep is fast and live police (Citizen/Waze) show up quickly;
  // run them on cycle 1, then every CAMERA_EVERY cycles. (CAMERA_EVERY=1 ⇒ every cycle,
  // for local testing.)
  const camPhase = Math.min(1, CAMERA_EVERY - 1);
  const runCameras = USE_CAMERAS && (cycle % CAMERA_EVERY === camPhase);
  let wazePolice = 0, wazeOk = 0, citizenItems = 0, cameraItems = 0, keylessItems = 0, ppItems = 0, openItems = 0, googleItems = 0;
  let wazeLimited = false, wazeKeyMissing = false;
  const agentItems = [];

  for (let i = 0; i < regions.length; i++) {
    if (stopping) break;
    const region = regions[i];

    if (USE_WAZE && !wazeLimited && !wazeKeyMissing) {
      const w = await pollWaze(region);
      if (w.rateLimited) { wazeLimited = true; console.warn('[finder] Waze rate limited — pausing that source until next cycle'); }
      else if (w.keyMissing) { wazeKeyMissing = true; console.warn('[finder] server has no Waze key — skipping that source this run'); }
      else if (w.police >= 0) { wazeOk++; wazePolice += w.police; }
    }

    if (USE_CITIZEN) {
      const c = await pollCitizen(region);
      if (c.items && c.items.length) { citizenItems += c.items.length; for (const it of c.items) agentItems.push(it); }
    }

    // Keyless Waze rides the same agent path; skip once it's proven blocked.
    if (!wazeKeylessDead) {
      const k = await pollWazeKeyless(region);
      if (k.items && k.items.length) { keylessItems += k.items.length; for (const it of k.items) agentItems.push(it); }
    }

    // Google Maps incidents — same best-effort agent path; skip once blocked/unset.
    if (USE_GOOGLE && !googleDead && GOOGLE_URL) {
      const g = await pollGoogleIncidents(region);
      if (g.items && g.items.length) { googleItems += g.items.length; for (const it of g.items) agentItems.push(it); }
    }

    if (runCameras) {
      const cam = await pollCameras(region);
      if (cam.items && cam.items.length) { cameraItems += cam.items.length; for (const it of cam.items) agentItems.push(it); }
    }

    if (!stopping && i < regions.length - 1) await sleep(STEP_MS);
  }

  // PulsePoint: a rotating window over the discovered in-region agencies (not per
  // map-region). With nationwide discovery the agency list can run into the
  // hundreds — polling PP_PER_SWEEP per cycle keeps a sweep bounded while every
  // agency still gets visited every few cycles.
  if (USE_PULSEPOINT && ppAgencies.length) {
    const ppCount = Math.min(PP_PER_SWEEP, ppAgencies.length);
    for (let a = 0; a < ppCount; a++) {
      if (stopping) break;
      const agency = ppAgencies[ppCursor % ppAgencies.length];
      ppCursor++;
      const r = await ppPollAgency(agency.id);
      if (r.items.length) { ppItems += r.items.length; for (const it of r.items) agentItems.push(it); }
      if (a < ppCount - 1) await sleep(PP_STEP_MS);
    }
  }

  // Open municipal feeds (Austin, …) — one pass, not per map-region.
  if (USE_OPENFEEDS) {
    const o = await pollOpenFeeds();
    if (o.items.length) { openItems += o.items.length; for (const it of o.items) agentItems.push(it); }
  }

  // Prune the dedup maps so they can't grow without bound.
  const cutoff = Date.now() - CITIZEN_REPUSH_MS;
  for (const [k, ts] of citizenSeen) if (ts < cutoff) citizenSeen.delete(k);
  const ppCut = Date.now() - PP_REPUSH_MS;
  for (const [k, ts] of ppSeen) if (ts < ppCut) ppSeen.delete(k);
  const gCut = Date.now() - GOOGLE_REPUSH_MS;
  for (const [k, ts] of googleSeen) if (ts < gCut) googleSeen.delete(k);

  const pushed = await pushAgent(agentItems);
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('[finder] sweep done in ' + secs + 's — waze:' + wazePolice + ' police (' + wazeOk + '/' + regions.length + ' regions)' +
    ', citizen:' + citizenItems + (keylessItems ? ', waze-keyless:' + keylessItems : '') +
    (googleItems ? ', google:' + googleItems : '') +
    (USE_PULSEPOINT ? ', pulsepoint:' + ppItems : '') +
    (USE_OPENFEEDS ? ', openfeeds:' + openItems : '') +
    (runCameras ? ', cameras:' + cameraItems : '') +
    (pushed.sent ? ' → ' + pushed.accepted + ' agent items accepted' : (agentItems.length ? ' (no AGENT_KEY — ' + agentItems.length + ' items not pushed)' : '')));
}

// Rotating slice of the region list for one cycle. Wraps around, so with a
// nationwide list of N regions and K per sweep, every region is visited once
// each ceil(N/K) cycles — same API quota per cycle as a K-region list.
function regionsForCycle(regions, cycle) {
  const k = Math.min(REGIONS_PER_SWEEP, regions.length);
  if (k >= regions.length) return regions;
  const start = (cycle * k) % regions.length;
  const slice = regions.slice(start, start + k);
  if (slice.length < k) slice.push(...regions.slice(0, k - slice.length)); // wrap
  return slice;
}

/* ----------------------------- main ----------------------------- */
async function main() {
  const regions = loadRegions();
  const on = [];
  if (USE_WAZE) on.push('waze');
  if (USE_CITIZEN) on.push('citizen');
  if (!wazeKeylessDead) on.push('waze-keyless');
  if (USE_PULSEPOINT) on.push('pulsepoint');
  if (USE_OPENFEEDS) on.push('openfeeds');
  if (USE_GOOGLE && GOOGLE_URL) on.push('google');
  if (USE_CAMERAS) on.push('cameras');
  console.log('[finder] starting — ' + regions.length + ' regions (' +
    Math.min(REGIONS_PER_SWEEP, regions.length) + '/cycle, full USA pass every ' +
    Math.ceil(regions.length / REGIONS_PER_SWEEP) + ' cycles), sweep every ' +
    Math.round(INTERVAL_MS / 60000) + ' min, ' + STEP_MS + 'ms between calls, sources: ' + on.join('+') + ', target ' + BASE);
  if (!AGENT_KEY) console.warn('[finder] WARNING: AGENT_KEY unset — Citizen/camera/keyless-Waze findings can\'t be pushed. Set AGENT_KEY (same value as the server) to enable them.');
  if (USE_GOOGLE && !GOOGLE_URL) console.warn('[finder] Google incidents source is ON but GOOGLE_INCIDENTS_URL is unset — it will stay idle. Set it to a reachable Maps-incident feed (bbox placeholders {minLat}/{minLng}/{maxLat}/{maxLng}) to enable it.');

  // Confirm the server is reachable before the first sweep, and report which
  // upstream sources it can serve.
  try {
    const caps = await fetchT(BASE + '/api/route/caps', {}, 8000).then((r) => r.json());
    if (USE_WAZE && !caps.waze) console.warn('[finder] server reports waze:false — Waze source will be empty until OPENWEBNINJA_KEY (or AGENT_KEY) is set on the server.');
  } catch (e) {
    console.warn('[finder] WARNING: could not reach ' + BASE + '/api/route/caps (' + e.message + ') — is the server running?');
  }

  // Discover PulsePoint agencies once up front so the first sweep can already poll them.
  if (USE_PULSEPOINT && !stopping) await ppDiscover(regions);

  let cycle = 0;
  while (!stopping) {
    const start = Date.now();
    // Periodically re-scan agencies (new dispatch centers join / drop off PulsePoint).
    if (USE_PULSEPOINT && cycle > 0 && cycle % PP_REDISCOVER_EVERY === 0 && !stopping) await ppDiscover(regions);
    await sweep(regionsForCycle(regions, cycle), cycle);
    cycle++;
    if (stopping) break;
    // Pace from the sweep START so a slow sweep doesn't compound the gap.
    const wait = Math.max(0, INTERVAL_MS - (Date.now() - start));
    if (wait > 0) {
      console.log('[finder] next sweep in ' + Math.round(wait / 1000) + 's');
      for (let w = 0; w < wait && !stopping; w += 1000) await sleep(Math.min(1000, wait - w));
    }
  }
  console.log('[finder] stopped.');
}

// Run the collector only when invoked directly (node/pm2/systemd all do). When
// required as a module — e.g. a test importing the pure parse helpers — the sweep
// loop stays dormant so importing has no side effects.
if (require.main === module) {
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
    if (stopping) process.exit(0);
    console.log('\n[finder] ' + sig + ' — finishing current step, press again to force quit…');
    stopping = true;
  }));

  main().catch((e) => { console.error('[finder] fatal:', e); process.exit(1); });
}

// Exposed for tests (pure, side-effect-free helpers).
module.exports = { fillBbox, parseGoogleIncidents };
