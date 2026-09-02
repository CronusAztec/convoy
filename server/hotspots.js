/* Convoy — police probability hotspots.
   Accumulates time-stamped police sightings (from the live Waze proxy + crowd
   'police' reports) and answers "where are police USUALLY seen at this hour?"
   as probability-weighted map pins.

   There is no free dataset of historical police-siting patterns, so this module
   builds one from real observations the server actually receives. Hotspots are
   empty on day 1 and become meaningful over days/weeks as sightings accrue —
   a cell needs ≥2 observations at the queried hour to surface at full strength,
   or ≥3 across any hour to surface dampened (the all-hours fallback), so a known
   spot never blinks out of the map just because the clock moved on.

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
// All-hours fallback: a cell with this many observations across ANY hour still
// shows (at a dampened probability) even when the queried hour has too few.
// Without this, hotspots "disappear" for most of the day — a spot seen only at
// 9am used to vanish from the 3pm map entirely, which reads as flaky.
const ALLHOURS_MIN = 3;
// Fallback probability ceiling — hour-matched signal should always read stronger.
const ALLHOURS_CAP = 0.5;
// Collapse repeat reports of the SAME spot within this window into one observation.
// A single persistent Waze police alert is re-served on every client's bbox poll
// (every ~60s, ×N clients), so without this one real sighting would otherwise
// accumulate dozens of observations and falsely saturate the cell to prob 1.0.
const DEDUP_MS = 15 * 60 * 1000;

let obs = [];        // [{ lng, lat, ts }]
// 'cellId@bucket' -> ts, for DEDUP_MS collapsing. A Map (not a plain object):
// insertion order gives O(1) oldest-eviction below, and — critically — it is
// HARD-CAPPED. The old plain object had no size limit and its only cleanup was
// "older than HORIZON_MS", so anonymous /api/waze polls with rotating wide
// bboxes could insert fresh keys for 30 days straight and OOM the process
// (obs has a cap; this map didn't).
let recentCell = new Map();
const RECENT_CELL_MAX = 300000; // ~ tens of MB worst case, bounded
let dirty = false;
let flushTimer = null;
let flushInFlight = false;
let writeGen = 0;    // see store.js — `dirty` must not clear before the write lands

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
  writeGen++;
  if (flushTimer) return;
  // Arm a timer even if a flush is in flight — that flush snapshotted at its
  // start, so a write landing during it must trigger a follow-up flush or be lost.
  flushTimer = setTimeout(flush, 800);
}

async function flush() {
  if (flushInFlight) return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;
  flushInFlight = true;
  const gen = writeGen;
  ensureDir();
  const tmp = FILE + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(obs), 'utf8');
    await renameRetry(tmp, FILE);
    if (writeGen === gen) dirty = false; // only once it's actually on disk
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
  // Bucket the timestamp into DEDUP_MS windows and key on cell+window. The old
  // test was `ts - prev < DEDUP_MS`, which goes NEGATIVE for any observation
  // older than the last one recorded for this cell — so a historical backfill
  // arriving newest-first (agent 'hotspot' items, collect-hotspots.js) had every
  // entry after the first silently dropped, and the cell then fell below
  // MIN_COUNT and never rendered at all. Bucketing makes the dedup depend on
  // WHEN the sighting happened, not on the order it reached us.
  var key = cell + '@' + Math.floor(ts / DEDUP_MS);
  if (recentCell.has(key)) return;
  recentCell.set(key, ts);
  if (recentCell.size > RECENT_CELL_MAX) {
    // Drop ~6% extra so eviction amortizes instead of firing on every insert.
    let drop = recentCell.size - RECENT_CELL_MAX + (RECENT_CELL_MAX >> 4);
    for (var ek of recentCell.keys()) { recentCell.delete(ek); if (--drop <= 0) break; }
  }
  obs.push({ lng: lng, lat: lat, ts: ts });
  // Hysteresis cap: trimming ONE element per insert once at the cap was an
  // O(n) memmove per sighting (O(n²) under sustained pressure). Trim a 10k
  // block only once the buffer runs 5% over.
  if (obs.length > 210000) obs.splice(0, obs.length - 200000);
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
    var id = cellId(o.lng, o.lat);
    if (!cells[id]) cells[id] = { count: 0, total: 0, latest: 0 };
    cells[id].total++; // any-hour tally — feeds the all-hours fallback
    if (o.ts > cells[id].latest) cells[id].latest = o.ts;
    // Local hour AT THE SIGHTING, approximated from longitude (15°/hour) rather
    // than the server's clock. The client queries with the viewer's local hour, so
    // bucketing observations by server-local time would skew the whole model by the
    // server↔viewer offset (e.g. a UTC VPS vs US riders never lines up). Longitude
    // gives a server-timezone-independent local hour, good to within the ±1h fold.
    var oh = foldHour(new Date(o.ts).getUTCHours() + Math.round(o.lng / 15));
    // Count toward the hour-matched score only if it landed in the queried window.
    if (oh === h || oh === hPrev || oh === hNext) cells[id].count++;
  }
  var features = [];
  for (var id in cells) {
    if (!cells.hasOwnProperty(id)) continue;
    var c = cells[id];
    var prob, count, allHours = false;
    if (c.count >= MIN_COUNT) {
      // Hour-matched signal: police are USUALLY here around this hour.
      prob = Math.min(1, c.count / SATURATION);
      count = c.count;
    } else if (c.total >= ALLHOURS_MIN) {
      // All-hours fallback: a known spot, just not proven at this hour — show it
      // dampened so it never outshines an hour-matched hotspot. Keeps the layer
      // populated around the clock instead of blinking out between patrol hours.
      prob = Math.min(ALLHOURS_CAP, c.total / (SATURATION * 2));
      count = c.total;
      allHours = true;
    } else {
      continue; // too little signal either way
    }
    var center = cellCenter(id);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: center },
      properties: {
        prob: prob,
        count: count,
        hour: h,
        allHours: allHours, // true = not hour-specific (popup says so)
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
    // Keep the dedup map from growing without bound. Keys are cell@bucket, so an
    // entry is only still useful while a backfill for that window could arrive —
    // hold them for the observation horizon rather than one dedup window, since
    // historical ingest legitimately re-visits old buckets. (Map iteration with
    // in-loop delete is safe; for..in does NOT see Map keys.)
    for (var k of recentCell.keys()) { if (now - recentCell.get(k) > HORIZON_MS) recentCell.delete(k); }
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
  count: function () { return obs.length; },
  // Test/ops probe: current dedup-map size (bounded by RECENT_CELL_MAX).
  dedupSize: function () { return recentCell.size; }
};
