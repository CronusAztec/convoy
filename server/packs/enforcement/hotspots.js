/* Convoy — enforcement pack: police probability hotspots.
   Accumulates time-stamped police sightings (the live Waze proxy, the
   collectors, riders' 'enforcement:report' messages) and answers "where are
   police USUALLY seen at this hour?" as probability-weighted map pins.

   There is no free dataset of historical police-siting patterns, so this
   module builds one from real observations the server actually receives.
   Hotspots are empty on day 1 and become meaningful over days/weeks as
   sightings accrue — a cell needs ≥2 observations at the queried hour to
   surface at full strength, or ≥3 across any hour to surface dampened (the
   all-hours fallback), so a known spot never blinks out just because the
   clock moved on.

   Model:
     - Observations bucket into ~50m grid cells (cellId derived from lng/lat).
     - Each cell is scored per HOUR-OF-DAY (0..23), with the adjacent hour folded
       in (±1h) so "9am" sightings also nudge the 8am and 10am buckets.
     - prob ∈ [0,1] = min(1, count / SATURATION).
     - Observations older than HORIZON_DAYS are pruned.

   PERSISTENCE is Postgres through the query function the server half hands
   init() (ctx.db.query — migration 007_enforcement.sql), never a file: the
   pre-cut module owned server/data/hotspots.json, and a pack may only persist
   through the core's database. The hot path stays synchronous on the
   in-memory copy; inserts are batched and flushed off the request path, and
   a flush that fails is logged and dropped (an observation is not worth a
   retry storm against a database that is already struggling). With no query
   function (tests, a server without a database) the model lives in memory
   for the process. */
'use strict';

const fs = require('fs');

const TABLE = 'public.enforcement_sightings';
// ~50m grid. 1 degree of latitude ≈ 111km, so 0.0005° ≈ 55m. Rounded to a stable
// key so nearby sightings (±25m) collapse into the same cell.
const GRID = 0.0005;
// How many observations at one hour saturate the probability (prob → 1.0).
const SATURATION = 8;
// Drop observations older than this — enforcement patterns drift over time.
const HORIZON_DAYS = 30;
const HORIZON_MS = HORIZON_DAYS * 24 * 3600 * 1000;
// A cell needs this many observations (after ±1h folding) at the queried hour
// before it's worth showing. 1 sighting is noise.
const MIN_COUNT = 2;
// All-hours fallback: a cell with this many observations across ANY hour still
// shows (at a dampened probability) even when the queried hour has too few.
const ALLHOURS_MIN = 3;
const ALLHOURS_CAP = 0.5;
// Collapse repeat reports of the SAME spot within this window into one
// observation: a single persistent Waze alert is re-served on every poll.
const DEDUP_MS = 15 * 60 * 1000;
const RECENT_CELL_MAX = 300000; // hard cap on the dedup map (bounded memory)
const OBS_MAX = 200000;
const FLUSH_MS = 800;
const FLUSH_BATCH = 500;

let obs = [];                 // [{ lng, lat, ts }]
let recentCell = new Map();   // 'cellId@bucket' -> ts, insertion-ordered for O(1) eviction
let pending = [];             // rows not yet in the database: [lng, lat, ts, cell]
let flushTimer = null;
let flushInFlight = false;
let dbq = null;               // (text, params) => Promise — ctx.db.query, or null
let maint = null;
let lastError = '';
let loadedRows = 0;

/* ---------------- recording + querying ---------------- */

// Quantize a [lng,lat] to a stable ~50m cell id.
function cellId(lng, lat) {
  return Math.round(lng / GRID) + ',' + Math.round(lat / GRID);
}
function cellCenter(id) {
  const p = String(id).split(',');
  return [parseInt(p[0], 10) * GRID, parseInt(p[1], 10) * GRID];
}
function foldHour(h) { return ((h % 24) + 24) % 24; }

function remember(cell, ts) {
  // Bucket the timestamp into DEDUP_MS windows and key on cell+window, so the
  // dedup depends on WHEN the sighting happened, not the order it reached us
  // (a historical backfill arrives newest-first).
  const key = cell + '@' + Math.floor(ts / DEDUP_MS);
  if (recentCell.has(key)) return false;
  recentCell.set(key, ts);
  if (recentCell.size > RECENT_CELL_MAX) {
    // Drop ~6% extra so eviction amortizes instead of firing on every insert.
    let drop = recentCell.size - RECENT_CELL_MAX + (RECENT_CELL_MAX >> 4);
    for (const ek of recentCell.keys()) { recentCell.delete(ek); if (--drop <= 0) break; }
  }
  return true;
}

function record(lng, lat, ts) {
  if (typeof lng !== 'number' || typeof lat !== 'number' || typeof ts !== 'number') return false;
  if (!isFinite(lng) || !isFinite(lat) || !isFinite(ts)) return false;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
  const cell = cellId(lng, lat);
  if (!remember(cell, ts)) return false;
  obs.push({ lng: lng, lat: lat, ts: ts });
  // Hysteresis cap: trim a block once the buffer runs 5% over, not one per insert.
  if (obs.length > OBS_MAX * 1.05) obs.splice(0, obs.length - OBS_MAX);
  if (dbq) {
    pending.push([lng, lat, ts, cell]);
    scheduleFlush();
  }
  return true;
}

// Build the probability FeatureCollection for a bbox at a given hour (0..23,
// viewer-local). Returns { type:'FeatureCollection', features:[...] }.
function query(minLng, minLat, maxLng, maxLat, hour) {
  const now = Date.now();
  const h = foldHour(hour);
  const hPrev = foldHour(h - 1), hNext = foldHour(h + 1);
  const cells = {};
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (now - o.ts > HORIZON_MS) continue;
    if (o.lng < minLng || o.lng > maxLng || o.lat < minLat || o.lat > maxLat) continue;
    const id = cellId(o.lng, o.lat);
    if (!cells[id]) cells[id] = { count: 0, total: 0, latest: 0 };
    cells[id].total++;
    if (o.ts > cells[id].latest) cells[id].latest = o.ts;
    // Local hour AT THE SIGHTING, approximated from longitude (15°/hour) rather
    // than the server's clock — server-timezone-independent, good to within
    // the ±1h fold.
    const oh = foldHour(new Date(o.ts).getUTCHours() + Math.round(o.lng / 15));
    if (oh === h || oh === hPrev || oh === hNext) cells[id].count++;
  }
  const features = [];
  for (const id in cells) {
    if (!Object.prototype.hasOwnProperty.call(cells, id)) continue;
    const c = cells[id];
    let prob, count, allHours = false;
    if (c.count >= MIN_COUNT) {
      prob = Math.min(1, c.count / SATURATION);
      count = c.count;
    } else if (c.total >= ALLHOURS_MIN) {
      prob = Math.min(ALLHOURS_CAP, c.total / (SATURATION * 2));
      count = c.total;
      allHours = true;
    } else {
      continue;
    }
    const center = cellCenter(id);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: center },
      properties: { prob, count, hour: h, allHours, latest: c.latest, kind: 'hotspot' }
    });
  }
  return { type: 'FeatureCollection', features };
}

/* ---------------- persistence ---------------- */

function scheduleFlush() {
  if (flushTimer || !dbq) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

async function flush() {
  if (!dbq || flushInFlight) return;
  flushInFlight = true;
  try {
    while (pending.length) {
      const batch = pending.splice(0, FLUSH_BATCH);
      const params = [];
      const tuples = batch.map((row, i) => {
        params.push(row[0], row[1], row[2], row[3]);
        const b = i * 4;
        return '($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ')';
      });
      try {
        await dbq('insert into ' + TABLE + ' (lng, lat, ts, cell) values ' + tuples.join(','), params);
        lastError = '';
      } catch (e) {
        lastError = String((e && e.message) || e);
        console.error('[enforcement/hotspots] flush failed (' + batch.length + ' rows dropped):', lastError);
      }
    }
  } finally {
    flushInFlight = false;
  }
}

async function load() {
  if (!dbq) return 0;
  try {
    const r = await dbq('select lng, lat, ts from ' + TABLE + ' where ts > $1 order by ts asc', [Date.now() - HORIZON_MS]);
    const rows = (r && r.rows) || [];
    let n = 0;
    for (const row of rows) {
      const lng = Number(row.lng), lat = Number(row.lat), ts = Number(row.ts);
      if (!isFinite(lng) || !isFinite(lat) || !isFinite(ts)) continue;
      if (!remember(cellId(lng, lat), ts)) continue;
      obs.push({ lng, lat, ts });
      n++;
    }
    if (obs.length > OBS_MAX) obs.splice(0, obs.length - OBS_MAX);
    loadedRows = n;
    console.log('[enforcement/hotspots] loaded ' + n + ' observations');
    return n;
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('[enforcement/hotspots] load failed (is migration 007_enforcement.sql applied?):', lastError);
    return 0;
  }
}

// Periodic prune of out-of-horizon observations, in memory and in the table.
function prune() {
  const now = Date.now();
  const before = obs.length;
  obs = obs.filter((o) => now - o.ts <= HORIZON_MS);
  for (const k of recentCell.keys()) { if (now - recentCell.get(k) > HORIZON_MS) recentCell.delete(k); }
  if (dbq) dbq('delete from ' + TABLE + ' where ts < $1', [now - HORIZON_MS]).catch((e) => {
    lastError = String((e && e.message) || e);
  });
  return before - obs.length;
}

function startMaintenance() {
  if (maint) return;
  maint = setInterval(prune, 5 * 60 * 1000);
  if (typeof maint.unref === 'function') maint.unref();
}

/* One-off import of the pre-cut server/data/hotspots.json (an array of
   { lng, lat, ts }) into the model — and, when a database is wired, into the
   table. Run from a node -e with the server half's env, see the README. */
function importJson(file) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: e.message, imported: 0 }; }
  if (!Array.isArray(arr)) return { error: 'not an array', imported: 0 };
  let n = 0;
  for (const o of arr) if (o && record(Number(o.lng), Number(o.lat), Number(o.ts))) n++;
  return { imported: n, total: arr.length };
}

// opts.query: (text, params) => Promise<{ rows }> — ctx.db.query. Resolves once
// the horizon's rows are in memory; the server half does not wait for it.
function init(opts) {
  dbq = opts && typeof opts.query === 'function' ? opts.query : null;
  startMaintenance();
  return load();
}

function status() {
  return { observations: obs.length, dedup: recentCell.size, pending: pending.length, persisted: !!dbq, loaded: loadedRows, lastError };
}

// Test seam — module state is otherwise unreachable.
function _reset() {
  obs = []; recentCell = new Map(); pending = []; lastError = ''; loadedRows = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  dbq = null;
}

module.exports = {
  init, record, query, flush, prune, importJson, status,
  count: () => obs.length,
  dedupSize: () => recentCell.size,
  _reset, _pending: () => pending.length,
  GRID, HORIZON_MS, RECENT_CELL_MAX, DEDUP_MS, TABLE
};
