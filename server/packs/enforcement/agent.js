/* Convoy — enforcement pack: the live-sightings store and the collector inbox.

   WHAT CHANGED FROM THE PRE-CUT server/agent.js. That module was an HTTP
   ingest (POST /api/agent/update, authenticated with X-Agent-Key) that any
   script could push police / hazard / traffic / weather items into. Two
   things make that shape wrong for a pack:

     · every pack route is reached only with a bearer for an account that
       holds the pack (server/packs/index.js) — a shared agent key has no
       place in that registry, and a route that also accepted one would be
       an unauthenticated door into a gated feature;
     · hazards, traffic and weather are the overlays pack's business, not
       this one's.

   So /api/agent/update is GONE. This module keeps the two things the
   enforcement feature needs from it:

     1. A bounded, in-memory store of LIVE POLICE sightings with a TTL, merged
        into every /api/enforcement/waze answer (so collector findings and
        riders' reports reach every holder through the poll they already
        make) and fed into the hotspot model as observations.
     2. A way for the collectors to feed it. In-process (ENFORCEMENT_COLLECTOR
        on the server) they call ingest() directly. Standalone (their own
        systemd unit, the sample files beside this one) they drop
        { items: [...] } JSON files into ENFORCEMENT_INBOX_DIR; the server
        half scans that directory, ingests each file and deletes it. One
        file per batch, written to a .tmp name and renamed, so a half-written
        file is never read.

   Item shapes (the only two kinds accepted):
     { type:'police',  lat, lng, label?, ttl?, waze?, source? }   live pin + observation
     { type:'hotspot', lat, lng, time? }                           observation only */
'use strict';

const fs = require('fs');
const path = require('path');
const hotspots = require('./hotspots');

const MAX_ITEMS = 500;              // oldest evicted beyond this
const DEFAULT_TTL_S = 30 * 60;      // items live 30 min unless the caller says otherwise
const MAX_TTL_S = 24 * 3600;
const INBOX_MAX_FILES = 200;        // per scan; a runaway writer cannot stall the server

const police = [];  // { lng, lat, label, when, until, waze, source }

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
function prune() {
  const now = Date.now();
  for (let i = police.length - 1; i >= 0; i--) if (police[i].until <= now) police.splice(i, 1);
}
function push(item) {
  police.push(item);
  if (police.length > MAX_ITEMS) police.shift();
}

// Validate + store a batch. Returns { accepted, rejected:[{index, reason}] }.
function ingest(items) {
  const rejected = [];
  let accepted = 0;
  if (!Array.isArray(items)) return { accepted: 0, rejected: [{ index: -1, reason: 'items must be an array' }] };
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
      push({
        lng, lat,
        label: cleanLabel(it.label, 'Police reported'),
        when: new Date(now).toISOString(),
        until: now + ttlMs(it.ttl),
        waze: it.waze === true,                      // the licensed Waze path may credit Waze
        source: typeof it.source === 'string' ? it.source.slice(0, 24) : 'feed'
      });
      // A live sighting is also an observation — same as the Waze path.
      hotspots.record(lng, lat, now);
      accepted++;
      return;
    }
    rejected.push({ index: i, reason: 'unknown type "' + String(it.type).slice(0, 24) + '" (hazards belong to the overlays pack)' });
  });
  return { accepted, rejected };
}

// A rider's own report ('enforcement:report'), already validated by the
// server half. Lives in the same store so every other holder's next poll
// carries it, credited as a rider report.
function addReport(lng, lat, label, ttlS) {
  if (!isLngLat(lng, lat)) return false;
  const now = Date.now();
  push({ lng, lat, label: cleanLabel(label, 'Police sighting'), when: new Date(now).toISOString(),
    until: now + ttlMs(ttlS), waze: false, source: 'rider' });
  return true;
}

function inBox(o, bl, tr) {
  return o.lng >= bl[0] && o.lng <= tr[0] && o.lat >= bl[1] && o.lat <= tr[1];
}

// Live police as features shaped like waze.js's — the client police layer
// (ghost.js filters kind==='police') consumes them with no changes.
function policeFeatures(bl, tr) {
  prune();
  return police.filter((p) => inBox(p, bl, tr)).map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: {
      kind: 'police', label: p.label, color: '#3b82f6',
      street: '', city: '',
      waze: p.waze, agent: !p.waze && p.source !== 'rider', crowd: p.source === 'rider',
      thumbs: 0, reliability: 0, when: p.when
    }
  }));
}

function counts() {
  prune();
  return { police: police.length, hotspotObservations: hotspots.count() };
}
function hasLive() { prune(); return police.length > 0; }

/* ---------------- the inbox ---------------- */
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists or unwritable */ } }

// Standalone collectors call this: one atomic file per batch.
function writeInbox(dir, items) {
  if (!Array.isArray(items) || !items.length) return null;
  ensureDir(dir);
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
  const tmp = path.join(dir, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ items }), 'utf8');
  fs.renameSync(tmp, path.join(dir, name));
  return name;
}

// The server half calls this on a timer: ingest every complete file, delete
// it, and set a malformed one aside (renamed .bad) rather than re-reading it
// forever. Returns { files, accepted, rejected }.
function scanInbox(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { files: 0, accepted: 0, rejected: 0 }; }
  names = names.filter((n) => /\.json$/.test(n)).sort().slice(0, INBOX_MAX_FILES);
  let accepted = 0, rejected = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    let body = null;
    try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { body = null; }
    const items = body && Array.isArray(body.items) ? body.items : null;
    if (!items) {
      try { fs.renameSync(file, file + '.bad'); } catch (e) { /* leave it */ }
      rejected++;
      continue;
    }
    const r = ingest(items.slice(0, 1000));
    accepted += r.accepted; rejected += r.rejected.length;
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
  }
  return { files: names.length, accepted, rejected };
}

let inboxTimer = null;
function startInbox(dir, intervalMs) {
  if (inboxTimer) return inboxTimer;
  ensureDir(dir);
  const tick = () => {
    try {
      const r = scanInbox(dir);
      if (r.files) console.log('[enforcement/inbox] ' + r.files + ' file(s): ' + r.accepted + ' accepted, ' + r.rejected + ' rejected');
    } catch (e) { console.error('[enforcement/inbox]', e.message); }
  };
  tick();
  inboxTimer = setInterval(tick, intervalMs || 30000);
  if (typeof inboxTimer.unref === 'function') inboxTimer.unref();
  return inboxTimer;
}
function stopInbox() { if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; } }

function _reset() { police.length = 0; stopInbox(); }

module.exports = {
  ingest, addReport, policeFeatures, counts, hasLive,
  writeInbox, scanInbox, startInbox, stopInbox,
  MAX_ITEMS, DEFAULT_TTL_S, MAX_TTL_S, _reset
};
