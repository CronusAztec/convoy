#!/usr/bin/env node
/* Convoy — enforcement pack: multi-source police finder (always-on collector).

   Sweeps every source we can reach and fuses the findings into the pack's
   live-police store and hotspot model (server/packs/enforcement/agent.js):

     1. Waze (OpenWeb Ninja)  — the LICENSED feed, called through ./waze with the
        key from the environment. Its sightings become hotspot OBSERVATIONS only:
        the live pins for a keyed server come from each rider's own poll of
        /api/enforcement/waze, so pushing them as live items too would double
        every pin. (No key ⇒ this source is a quiet no-op.)

     2. Citizen (citizen.com)  — keyless public incident feed. Trending incidents
        per bbox, keeping the police-relevant ones (category "Police Related" or
        a police-y title: pursuit, checkpoint, DUI, arrest…) as live `police` pins.

     3. OSM speed cameras (Overpass) — static automated-enforcement locations, fed
        into the hotspot model as observations on a slow cadence.

     4. Waze keyless live-map GeoRSS — best-effort. Waze bot-blocks datacenter
        IPs (403), so this self-disables after a couple of failures.

     5. PulsePoint (pulsepoint.org) — the nationwide Fire/EMS/police dispatch
        network; the police-relevant call types surface as live pins.

     6. Open municipal incident feeds — live, keyless city datasets (Socrata).

     7. Google Maps incidents — best-effort, like #4, via a configurable incident
        endpoint; a quiet no-op until GOOGLE_INCIDENTS_URL points at one.

   HOW FINDINGS REACH THE MAP. There is no HTTP ingest any more (the pre-cut
   agent-update route and its shared key are gone — every pack route is gated
   on a rider's account). The finder hands batches to a SINK:
     · in-process: server/packs/enforcement.js starts it with
       ENFORCEMENT_COLLECTOR=finder|all and the sink is agent.ingest() directly;
     · standalone (this file run as its own process / systemd unit, see
       convoy-police-finder.service beside it): the sink writes one JSON file
       per batch into ENFORCEMENT_INBOX_DIR, which the server half scans.
   Either way the shipped app never talks to these hosts; test/
   packs-enforcement.test.js pins that this file is the only one that knows them.

   Config (env):
     ENFORCEMENT_INBOX_DIR  standalone only: where batches are dropped
                        (default <DATA_DIR>/enforcement-inbox)
     OPENWEBNINJA_KEY   the Waze key (source #1); unset ⇒ that source is off
     FINDER_INTERVAL_MS gap between full sweeps       (default 900000 = 15 min)
     FINDER_STEP_MS     gap between region requests   (default 5000 = 5s)
     FINDER_REGIONS     path to a regions JSON        (default ./collect-regions.json)
     FINDER_REGIONS_PER_SWEEP  regions polled per cycle (default 20) — the region
                        list is nationwide (~120 metros); each cycle sweeps the
                        next slice, rotating so the whole USA is covered every
                        ~ceil(N/20) cycles at the SAME quota as a short list
     FINDER_CAMERAS     '1'/'0' — OSM speed cameras   (default 1)
     FINDER_CITIZEN     '1'/'0' — Citizen feed        (default 1)
     FINDER_WAZE        '1'/'0' — Waze (licensed)     (default 1)
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
const waze = require('./waze');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A malformed value ("15m", typos) must not spin the sweep loop with no pause.
// Standalone that is fatal; in-process it falls back to the default and says so.
function envInt(name, def, min, fatal) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min) {
    const msg = '[finder] invalid ' + name + '="' + raw + '" — expected integer >= ' + min;
    if (fatal) { console.error(msg + '. Aborting.'); process.exit(1); }
    console.error(msg + '; using ' + def);
    return def;
  }
  return v;
}
function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return !/^(0|false|no|off)$/i.test(raw);
}
function readConfig(fatal) {
  return {
    intervalMs: envInt('FINDER_INTERVAL_MS', 900000, 60000, fatal),
    stepMs: envInt('FINDER_STEP_MS', 5000, 500, fatal),
    regionsPerSweep: envInt('FINDER_REGIONS_PER_SWEEP', 20, 1, fatal),
    ppPerSweep: envInt('PP_PER_SWEEP', 40, 1, fatal),
    cameraEvery: envInt('CAMERA_EVERY', 24, 1, fatal),
    ppRediscoverEvery: envInt('PP_REDISCOVER_EVERY', 96, 1, fatal),
    regionsFile: process.env.FINDER_REGIONS || process.env.COLLECT_REGIONS || path.join(__dirname, 'collect-regions.json'),
    useCameras: envBool('FINDER_CAMERAS', true),
    useCitizen: envBool('FINDER_CITIZEN', true),
    useWaze: envBool('FINDER_WAZE', true),
    usePulsePoint: envBool('FINDER_PULSEPOINT', true),
    useOpenFeeds: envBool('FINDER_OPENFEEDS', true),
    useGoogle: envBool('FINDER_GOOGLE', true),
    googleUrl: (process.env.GOOGLE_INCIDENTS_URL || '').trim()
  };
}

// fetch with a hard client-side deadline. A hung upstream would otherwise
// freeze a whole sweep forever. Throws on the deadline so callers fall through
// to their try/catch.
function fetchT(url, opts, ms) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opts || {}));
}

/* ----------------------------- regions ----------------------------- */
function loadRegions(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('cannot read regions file ' + file + ': ' + e.message); }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { throw new Error('regions file is not valid JSON: ' + e.message); }
  const list = (j && Array.isArray(j.regions) ? j.regions : []).filter((r) =>
    r && Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => typeof n === 'number' && isFinite(n)));
  if (!list.length) throw new Error('no valid regions in ' + file);
  return list;
}

// Rotating slice of the region list for one cycle. Wraps around, so with a
// nationwide list of N regions and K per sweep, every region is visited once
// each ceil(N/K) cycles — same quota per cycle as a K-region list.
function regionsForCycle(regions, cycle, perSweep) {
  const k = Math.min(perSweep, regions.length);
  if (k >= regions.length) return regions;
  const start = (cycle * k) % regions.length;
  const slice = regions.slice(start, start + k);
  if (slice.length < k) slice.push(...regions.slice(0, k - slice.length)); // wrap
  return slice;
}

/* ----------------------------- delivery ----------------------------- */
// Hand a batch to the sink in chunks of 100 (the ingest cap). Never throws —
// a delivery failure just means those findings skip this sweep.
async function deliver(st, items) {
  if (!items.length) return { accepted: 0, sent: false };
  let accepted = 0;
  for (let i = 0; i < items.length; i += 100) {
    if (st.stopping) break;
    const chunk = items.slice(i, i + 100);
    try {
      const r = await st.sink(chunk);
      accepted += (r && typeof r.accepted === 'number') ? r.accepted : chunk.length;
    } catch (e) {
      console.warn('[finder] delivery failed: ' + e.message);
    }
  }
  return { accepted, sent: true };
}

/* ----------------------------- source 1: Waze (licensed) ----------------------------- */
// Observations only (see the header): { police, items:[hotspot…] } or -1 on error.
function pollWaze(region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  if (!waze.hasKey()) return Promise.resolve({ police: -1, keyMissing: true });
  return new Promise((resolve) => {
    waze.alerts([minLng, minLat], [maxLng, maxLat], (err, status, fc) => {
      if (err) return resolve({ police: -1, rateLimited: status === 429 });
      const now = Date.now();
      const items = [];
      for (const f of (fc && fc.features) || []) {
        if (!f.properties || f.properties.kind !== 'police' || !f.geometry) continue;
        items.push({ type: 'hotspot', lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], time: now });
      }
      resolve({ police: items.length, items });
    });
  });
}

/* ----------------------------- source 2: Citizen ----------------------------- */
// A police-y title even when Citizen miscategorizes the incident.
const POLICE_RE = /\b(police|pursuit|chase|checkpoint|dui|sobriety|patrol|swat|officer|detained|arrest|standoff|manhunt|barricad|traffic stop|highway patrol|sheriff|state trooper|speed trap)\b/i;

// Collapse near-identical Citizen pushes: re-push only after CITIZEN_REPUSH_MS.
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
    const ts = Number(r.ts || r.cs || 0);
    if (ts && now - ts > 3 * 3600 * 1000) continue;
    const key = r.key || (lat.toFixed(5) + ',' + lng.toFixed(5) + ':' + title);
    const last = citizenSeen.get(key);
    if (last != null && now - last < CITIZEN_REPUSH_MS) continue;
    citizenSeen.set(key, now);
    items.push({ type: 'police', lat, lng, label: (title || 'Police activity').slice(0, 60), ttl: 45 * 60, source: 'citizen' });
  }
  return { items };
}

/* ----------------------------- source 3: OSM speed cameras ----------------------------- */
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
      }, 30000);
    } catch (err) { continue; }
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
    // into the app the way the paid OpenWeb Ninja path in ./waze.js does.
    items.push({ type: 'police', lat, lng, label: 'Police reported', ttl: 30 * 60, source: 'feed' });
  }
  return { items };
}

/* ----------------------------- source 7: Google Maps incidents (keyless, best-effort) ----------------------------- */
const GOOGLE_REPUSH_MS = 20 * 60 * 1000;
const googleSeen = new Map();  // incident key -> last-pushed ts
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

// Pull police-relevant incidents out of whatever shape the endpoint returned.
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

async function pollGoogleIncidents(region, googleUrl) {
  if (googleDead || !googleUrl) return { items: [] };
  const url = fillBbox(googleUrl, region);
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
  text = text.replace(/^\)\]\}'[^\n]*\n?/, '').replace(/^while\(1\);/, '').trim();
  let j;
  try { j = JSON.parse(text); }
  catch (e) {
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
    items.push({ type: 'police', lat: inc.lat, lng: inc.lng, label: '🚔 ' + inc.label + ' (Google)', ttl: 30 * 60, source: 'google' });
  }
  return { items };
}

/* ----------------------------- source 5: PulsePoint (CAD, decrypted) ----------------------------- */
// PulsePoint's webapp API returns AES-encrypted JSON ({ct,iv,s}); the passphrase +
// OpenSSL-EVP(MD5) key derivation below are the long-known scheme its OWN web
// client uses to read it (the same public data the site shows).
const PP_BASE = 'https://api.pulsepoint.org/v1/webapp';
const PP_PASS = 'tombrady5rings';
const PP_TYPES = {
  TC: 'Collision', TCE: 'Collision', TCP: 'Collision (ped)', TCS: 'Collision',
  LE: 'Police activity', LEO: 'Police activity', AI: 'Investigation'
};
const PP_MAX_PER_REGION = 6;
const PP_REPUSH_MS = 20 * 60 * 1000;
const PP_STEP_MS = 700;
const ppSeen = new Map();
let ppAgencies = [];
let ppCursor = 0;

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
  out = out.substring(1);
  out = out.substring(0, out.lastIndexOf('"'));
  return JSON.parse(out.replace(/\\"/g, '"'));
}
async function ppGet(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } }, 15000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const o = await res.json();
  if (!o || !o.ct) throw new Error('unencrypted/err');
  return ppDecrypt(o);
}
function inBbox(lat, lng, bbox) {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
async function ppDiscover(st, regions) {
  const found = new Map();
  for (const region of regions) {
    if (st.stopping) break;
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
    if (!st.stopping) await sleep(600);
  }
  ppAgencies = Array.from(found.values());
  console.log('[finder] pulsepoint: ' + ppAgencies.length + ' agencies in-region');
}
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
    items.push({ type: 'police', lat: lat, lng: lng, label: '🚔 ' + label, ttl: 30 * 60, source: 'dispatch' });
  }
  return { items };
}

/* ----------------------------- source 6: open municipal incident feeds ----------------------------- */
const OPEN_FEEDS = [
  {
    name: 'Austin',
    url: "https://data.austintexas.gov/resource/dx9v-zd7x.json?$where=traffic_report_status=%27ACTIVE%27&$limit=200",
    lat: (r) => Number(r.latitude), lng: (r) => Number(r.longitude),
    id: (r) => r.traffic_report_id, type: (r) => r.issue_reported || 'Incident'
  }
];
const OPEN_POLICE_RE = /collision|crash|hazard|vehicle|\bped\b|pedestrian|stalled|block|impediment|debris|injury|police|hit and run|traffic viol/i;
const OPEN_REPUSH_MS = 20 * 60 * 1000;
const openSeen = new Map();

async function pollOpenFeeds(st) {
  const now = Date.now();
  const items = [];
  for (const f of OPEN_FEEDS) {
    if (st.stopping) break;
    let rows;
    try {
      const res = await fetchT(f.url, { headers: { 'User-Agent': UA } }, 12000);
      if (!res.ok) { if (!st.stopping) await sleep(400); continue; }
      rows = await res.json();
    } catch (e) { if (!st.stopping) await sleep(400); continue; }
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
        items.push({ type: 'police', lat: lat, lng: lng, label: '🚔 ' + label, ttl: 30 * 60, source: 'city' });
      }
    }
    if (!st.stopping) await sleep(400);
  }
  const cut = now - OPEN_REPUSH_MS;
  for (const [k, ts] of openSeen) if (ts < cut) openSeen.delete(k);
  return { items };
}

/* ----------------------------- sweep ----------------------------- */
async function sweep(st, regions, cycle) {
  const cfg = st.cfg;
  const t0 = Date.now();
  // Cameras are a heavy Overpass sweep. Keep them OFF the very first cycle so
  // the boot sweep is fast; run them on cycle 1, then every CAMERA_EVERY cycles.
  const camPhase = Math.min(1, cfg.cameraEvery - 1);
  const runCameras = cfg.useCameras && (cycle % cfg.cameraEvery === camPhase);
  let wazePolice = 0, wazeOk = 0, citizenItems = 0, cameraItems = 0, keylessItems = 0, ppItems = 0, openItems = 0, googleItems = 0;
  let wazeLimited = false, wazeKeyMissing = false;
  const batch = [];

  for (let i = 0; i < regions.length; i++) {
    if (st.stopping) break;
    const region = regions[i];

    if (cfg.useWaze && !wazeLimited && !wazeKeyMissing) {
      const w = await pollWaze(region);
      if (w.rateLimited) { wazeLimited = true; console.warn('[finder] Waze rate limited — pausing that source until next cycle'); }
      else if (w.keyMissing) { wazeKeyMissing = true; }
      else if (w.police >= 0) { wazeOk++; wazePolice += w.police; for (const it of w.items) batch.push(it); }
    }

    if (cfg.useCitizen) {
      const c = await pollCitizen(region);
      if (c.items && c.items.length) { citizenItems += c.items.length; for (const it of c.items) batch.push(it); }
    }

    if (!wazeKeylessDead) {
      const k = await pollWazeKeyless(region);
      if (k.items && k.items.length) { keylessItems += k.items.length; for (const it of k.items) batch.push(it); }
    }

    if (cfg.useGoogle && !googleDead && cfg.googleUrl) {
      const g = await pollGoogleIncidents(region, cfg.googleUrl);
      if (g.items && g.items.length) { googleItems += g.items.length; for (const it of g.items) batch.push(it); }
    }

    if (runCameras) {
      const cam = await pollCameras(region);
      if (cam.items && cam.items.length) { cameraItems += cam.items.length; for (const it of cam.items) batch.push(it); }
    }

    if (!st.stopping && i < regions.length - 1) await sleep(cfg.stepMs);
  }

  if (cfg.usePulsePoint && ppAgencies.length) {
    const ppCount = Math.min(cfg.ppPerSweep, ppAgencies.length);
    for (let a = 0; a < ppCount; a++) {
      if (st.stopping) break;
      const agency = ppAgencies[ppCursor % ppAgencies.length];
      ppCursor++;
      const r = await ppPollAgency(agency.id);
      if (r.items.length) { ppItems += r.items.length; for (const it of r.items) batch.push(it); }
      if (a < ppCount - 1) await sleep(PP_STEP_MS);
    }
  }

  if (cfg.useOpenFeeds) {
    const o = await pollOpenFeeds(st);
    if (o.items.length) { openItems += o.items.length; for (const it of o.items) batch.push(it); }
  }

  // Prune the dedup maps so they can't grow without bound.
  const cutoff = Date.now() - CITIZEN_REPUSH_MS;
  for (const [k, ts] of citizenSeen) if (ts < cutoff) citizenSeen.delete(k);
  const ppCut = Date.now() - PP_REPUSH_MS;
  for (const [k, ts] of ppSeen) if (ts < ppCut) ppSeen.delete(k);
  const gCut = Date.now() - GOOGLE_REPUSH_MS;
  for (const [k, ts] of googleSeen) if (ts < gCut) googleSeen.delete(k);

  const pushed = await deliver(st, batch);
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('[finder] sweep done in ' + secs + 's — waze:' + wazePolice + ' sightings (' + wazeOk + '/' + regions.length + ' regions)' +
    ', citizen:' + citizenItems + (keylessItems ? ', waze-keyless:' + keylessItems : '') +
    (googleItems ? ', google:' + googleItems : '') +
    (cfg.usePulsePoint ? ', pulsepoint:' + ppItems : '') +
    (cfg.useOpenFeeds ? ', openfeeds:' + openItems : '') +
    (runCameras ? ', cameras:' + cameraItems : '') +
    (pushed.sent ? ' → ' + pushed.accepted + ' items delivered' : ''));
}

/* ----------------------------- lifecycle ----------------------------- */
// opts.sink(items) → { accepted } (may be async). Returns { stop, config, name }.
function start(opts) {
  const st = { sink: (opts && opts.sink) || (() => ({ accepted: 0 })), stopping: false, cfg: readConfig(!!(opts && opts.fatalConfig)) };
  const cfg = st.cfg;
  (async function main() {
    const regions = loadRegions(cfg.regionsFile);
    const on = [];
    if (cfg.useWaze) on.push('waze');
    if (cfg.useCitizen) on.push('citizen');
    on.push('waze-keyless');
    if (cfg.usePulsePoint) on.push('pulsepoint');
    if (cfg.useOpenFeeds) on.push('openfeeds');
    if (cfg.useGoogle && cfg.googleUrl) on.push('google');
    if (cfg.useCameras) on.push('cameras');
    console.log('[finder] starting — ' + regions.length + ' regions (' +
      Math.min(cfg.regionsPerSweep, regions.length) + '/cycle, full pass every ' +
      Math.ceil(regions.length / cfg.regionsPerSweep) + ' cycles), sweep every ' +
      Math.round(cfg.intervalMs / 60000) + ' min, ' + cfg.stepMs + 'ms between calls, sources: ' + on.join('+'));
    if (cfg.useWaze && !waze.hasKey()) console.warn('[finder] OPENWEBNINJA_KEY unset — the licensed Waze source will be empty.');
    if (cfg.useGoogle && !cfg.googleUrl) console.warn('[finder] Google incidents source is ON but GOOGLE_INCIDENTS_URL is unset — it will stay idle.');

    if (cfg.usePulsePoint && !st.stopping) await ppDiscover(st, regions);

    let cycle = 0;
    while (!st.stopping) {
      const startAt = Date.now();
      if (cfg.usePulsePoint && cycle > 0 && cycle % cfg.ppRediscoverEvery === 0 && !st.stopping) await ppDiscover(st, regions);
      try { await sweep(st, regionsForCycle(regions, cycle, cfg.regionsPerSweep), cycle); }
      catch (e) { console.error('[finder] sweep failed:', e.message); }
      cycle++;
      if (st.stopping) break;
      const wait = Math.max(0, cfg.intervalMs - (Date.now() - startAt));
      if (wait > 0) {
        console.log('[finder] next sweep in ' + Math.round(wait / 1000) + 's');
        for (let w = 0; w < wait && !st.stopping; w += 1000) await sleep(Math.min(1000, wait - w));
      }
    }
    console.log('[finder] stopped.');
  })().catch((e) => { console.error('[finder] fatal:', e.message); st.stopping = true; });
  return { name: 'finder', config: cfg, stop: () => { st.stopping = true; } };
}

// Standalone: drop batches into the inbox the server half scans.
if (require.main === module) {
  if (typeof fetch !== 'function') { console.error('[finder] global fetch unavailable — needs Node 18+. Aborting.'); process.exit(1); }
  const agent = require('./agent');
  const dir = process.env.ENFORCEMENT_INBOX_DIR ||
    path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'enforcement-inbox');
  console.log('[finder] standalone — batches go to ' + dir + ' (set ENFORCEMENT_INBOX_DIR on the server too)');
  const h = start({ fatalConfig: true, sink: (items) => { agent.writeInbox(dir, items); return { accepted: items.length }; } });
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
    console.log('\n[finder] ' + sig + ' — finishing current step…');
    h.stop();
  }));
}

// Exposed for tests (pure, side-effect-free helpers) and the server half.
module.exports = { start, fillBbox, parseGoogleIncidents, regionsForCycle, POLICE_RE };
