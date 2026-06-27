/* Convoy — police probability hotspots.
   Accumulates time-stamped police sightings (from the live Waze proxy + crowd
   'police' reports) and answers "where are police USUALLY seen at this hour?"
   as probability-weighted map pins.

   There is no free dataset of historical police-siting patterns, so this module
   builds one from real observations the server actually receives. Hotspots are
   empty on day 1 and become meaningful over days/weeks as sightings accrue —
   a cell needs ≥2 historical observations at the queried hour before it surfaces.

   Model:
     - Observations bucket into ~50m grid cells (cellId derived from lng/lat).
     - Each cell is scored per HOUR-OF-DAY (0..23), with the adjacent hour folded
       in (±1h) so "9am" sightings also nudge the 8am and 10am buckets — a patrol
       starting at 8:50 shouldn't vanish from the 9am picture.
     - prob ∈ [0,1] = min(1, count / SATURATION). A cell that's seen SATURATION
       times at this hour is "always".
     - Observations older than HORIZON_DAYS are pruned (a cop who stopped sitting
       somewhere stops being a hotspot).

   Persistence mirrors store.js: atomic temp-file + rename + Windows-rename-retry,
   debounced 800ms flush, sync fallback on process 'exit'. File lives in DATA_DIR
   (honors the VPS DATA_DIR=/var/lib/convoy override via store.DATA_DIR). */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;
const FILE = path.join(DATA_DIR, 'hotspots.json');

// ~50m grid. 1 degree of latitude ≈ 111km, so 0.0005° ≈ 55m. Rounded to a stable
// key so nearby sightings (±25m) collapse into the same cell.
const GRID = 0.0005;
// How many observations at one hour saturate the probability (prob → 1.0).
// Tuned so a spot seen a few times a week at the same hour reads as "likely".
const SATURATION = 8;
// Drop observations older than this — enforcement patterns drift over time.
const HORIZON_DAYS = 30;
const HORIZON_MS = HORIZON_DAYS * 24 * 3600 * 1000;
// A cell needs this many observations (after ±1h folding) at the queried hour
// before it's worth showing. 1 sighting is noise.
const MIN_COUNT = 2;
// Collapse repeat reports of the SAME spot within this window into one observation.
// A single persistent Waze police alert is re-served on every client's bbox poll
// (every ~60s, ×N clients), so without this one real sighting would otherwise
// accumulate dozens of observations and falsely saturate the cell to prob 1.0.
const DEDUP_MS = 15 * 60 * 1000;

let obs = [];        // [{ lng, lat, ts }]
let recentCell = {}; // cellId -> last-recorded ts, for DEDUP_MS collapsing (pruned in maintenance)
let dirty = false;
let flushTimer = null;
let flushInFlight = false;

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ } }

function load() {
  ensureDir();
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return; } // fresh — no observations yet
  let arr;
  try { arr = JSON.parse(raw); }
  catch (e) {
    // Corrupt file — back it up (same safety pattern as store.js) and proceed
    // with an empty observation set rather than booting empty-and-overwriting.
    const backup = FILE + '.corrupt.' + Date.now();
    try { fs.copyFileSync(FILE, backup); console.error('[hotspots] hotspots.json corrupt — backed up to ' + backup); }
    catch (e2) { console.error('[hotspots] hotspots.json corrupt and could not back up:', e2.message); }
    return;
  }
  if (Array.isArray(arr)) {
    obs = arr.filter(function (o) { return o && typeof o.lng === 'number' && typeof o.lat === 'number' && typeof o.ts === 'number'; });
    console.log('[hotspots] loaded ' + obs.length + ' observations');
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  // Arm a timer even if a flush is in flight — that flush snapshotted at its
  // start, so a write landing during it must trigger a follow-up flush or be lost.
  flushTimer = setTimeout(flush, 800);
}

async function flush() {
  if (flushInFlight) return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  dirty = false;
  flushInFlight = true;
  ensureDir();
  const tmp = FILE + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(obs), 'utf8');
    await renameRetry(tmp, FILE);
  } catch (e) {
    console.error('[hotspots] flush failed:', e.message);
    dirty = true;
    try { await fsp.unlink(tmp); } catch (e2) { /* may not exist */ }
  } finally {
    flushInFlight = false;
  }
}

function flushSync() {
  if (!dirty) return;
  dirty = false;
  ensureDir();
  const tmp = FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obs), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[hotspots] flushSync failed:', e.message);
    dirty = true;
    try { fs.unlinkSync(tmp); } catch (e2) { /* may not exist */ }
  }
}

// Windows-safe rename with short backoff for transient EPERM/EACCES/EBUSY
// (antivirus/backup tools briefly holding the file). Identical to store.js.
function renameRetry(from, to, attempts) {
  attempts = attempts || 5;
  return new Promise(function (resolve, reject) {
    var i = 0;
    function attempt() {
      fsp.rename(from, to).then(resolve, function (e) {
        var transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
        if (!transient || i >= attempts - 1) return reject(e);
        i++;
        setTimeout(attempt, 40 * i);
      });
    }
    attempt();
  });
}

/* ---------------- recording + querying ---------------- */

// Quantize a [lng,lat] to a stable ~50m cell id. Both coords round the same way
// so a sighting at the cell edge still collapses with its neighbors.
function cellId(lng, lat) {
  return Math.round(lng / GRID) + ',' + Math.round(lat / GRID);
}
function cellCenter(id) {
  var p = String(id).split(',');
  return [parseInt(p[0], 10) * GRID, parseInt(p[1], 10) * GRID];
}

// Fold UTC hour ±1 into 0..23. The client passes the VIEWER's local hour (police
// patterns are local — "morning rush" means local morning, not UTC), so we trust
// the hour the client sends rather than deriving server-side.
function foldHour(h) { return ((h % 24) + 24) % 24; }

function record(lng, lat, ts) {
  if (typeof lng !== 'number' || typeof lat !== 'number' || typeof ts !== 'number') return;
  // Dedup the same persistent sighting (and multi-client polls of it): if this
  // cell was already recorded within DEDUP_MS, treat it as the same event.
  var cell = cellId(lng, lat);
  var prev = recentCell[cell];
  if (prev != null && ts - prev < DEDUP_MS) return;
  recentCell[cell] = ts;
  obs.push({ lng: lng, lat: lat, ts: ts });
  // Hard cap so a runaway recorder can't grow this unboundedly between prunes.
  if (obs.length > 200000) obs.splice(0, obs.length - 200000);
  scheduleFlush();
}

// Build the probability FeatureCollection for a bbox at a given hour.
// hour: 0..23 (viewer-local). Returns { type:'FeatureCollection', features:[...] }.
function query(minLng, minLat, maxLng, maxLat, hour) {
  var now = Date.now();
  var h = foldHour(hour);
  var hPrev = foldHour(h - 1), hNext = foldHour(h + 1);
  // Bucket within-bbox, in-horizon observations by cell, counting how many fell
  // in the queried hour (±1h folded). We don't persist buckets — recompute is
  // cheap (bounded array) and always reflects the latest observations.
  var cells = {};
  for (var i = 0; i < obs.length; i++) {
    var o = obs[i];
    if (now - o.ts > HORIZON_MS) continue;
    if (o.lng < minLng || o.lng > maxLng || o.lat < minLat || o.lat > maxLat) continue;
    // Local hour AT THE SIGHTING, approximated from longitude (15°/hour) rather
    // than the server's clock. The client queries with the viewer's local hour, so
    // bucketing observations by server-local time would skew the whole model by the
    // server↔viewer offset (e.g. a UTC VPS vs US riders never lines up). Longitude
    // gives a server-timezone-independent local hour, good to within the ±1h fold.
    var oh = foldHour(new Date(o.ts).getUTCHours() + Math.round(o.lng / 15));
    // Only count this observation if it landed in the queried hour window.
    if (oh !== h && oh !== hPrev && oh !== hNext) continue;
    var id = cellId(o.lng, o.lat);
    if (!cells[id]) cells[id] = { count: 0, latest: 0 };
    cells[id].count++;
    if (o.ts > cells[id].latest) cells[id].latest = o.ts;
  }
  var features = [];
  for (var id in cells) {
    if (!cells.hasOwnProperty(id)) continue;
    var c = cells[id];
    if (c.count < MIN_COUNT) continue; // single sighting = no signal
    var center = cellCenter(id);
    var prob = Math.min(1, c.count / SATURATION);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: center },
      properties: {
        prob: prob,
        count: c.count,
        hour: h,
        latest: c.latest,   // ms — lets the popup say "last seen X ago"
        kind: 'hotspot'     // marker so the client layer/popup can tell it apart
      }
    });
  }
  return { type: 'FeatureCollection', features: features };
}

// Periodic prune of out-of-horizon observations. .unref()'d so it never keeps
// the process alive (matches the server.js authHits-prune convention).
function startMaintenance() {
  setInterval(function () {
    var now = Date.now();
    var before = obs.length;
    obs = obs.filter(function (o) { return now - o.ts <= HORIZON_MS; });
    // Keep the dedup map from growing without bound — entries older than the
    // dedup window can never suppress a new record again.
    for (var k in recentCell) { if (now - recentCell[k] > DEDUP_MS) delete recentCell[k]; }
    if (obs.length !== before) scheduleFlush();
  }, 5 * 60 * 1000).unref();
}

load();
startMaintenance();
process.on('exit', flushSync);

module.exports = {
  record: record,
  query: query,
  flush: flush,
  flushSync: flushSync,
  count: function () { return obs.length; }
};
