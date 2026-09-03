/* Convoy — Overpass (OpenStreetMap) proxy + cache.

   WHY THIS EXISTS. The client used to POST to overpass-api.de directly from the
   browser. That stopped working: the endpoint serves no Access-Control-Allow-Origin
   header, so every one of those calls is blocked by CORS before the app ever sees
   a response. Because all three call sites end in `.catch(() => null)`, nothing
   looked broken — the features just quietly did nothing:

     · police / speed-camera avoidance when picking a route
     · Ghost Mode's enforcement POIs (stations, cameras, ALPR)
     · stop signs + traffic signals for the road-feature lookup

   Routing through the server fixes that permanently (same-origin, no CORS at
   all) and matches how every other third-party API here is already handled —
   see tomtom.js and waze.js.

   NOT AN OPEN PROXY. The client sends a KIND and a bounding box, never a query.
   Overpass QL is a programming language with a server-side cost model; forwarding
   arbitrary queries would let anyone spend our IP's budget on whatever they liked
   and get it banned for everybody. The three query shapes below are the three the
   app actually uses, and the only variable in them is the box.

   CACHED because these are static infrastructure — a police station does not move
   between page loads — and because every rider in the same area otherwise asks the
   same question. One upstream call now serves everyone in that tile for the TTL,
   which is the difference between being a good Overpass citizen and being a
   rate-limited one. */
'use strict';

// Same mirrors police-finder.js uses, tried in order. Overpass instances go down
// or get busy independently, so a second one is the difference between a feature
// that works and a feature that doesn't.
const MIRRORS = (process.env.OVERPASS_URLS ||
  'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Short label for logs. A full URL in every line is noise, and MIRRORS is
// env-configurable, so a malformed entry must not throw at require time.
const MIRROR_HOSTS = MIRRORS.map((u) => { try { return new URL(u).host; } catch (e) { return u; } });

/* ---------------- what happened, and where ----------------
   Cycle 51 (2026-09-03) read seven `all mirrors failed` lines out of
   production and could not say why a single one failed: every branch of the
   mirror loop `continue`d past its own reason (BUGS.md server-031). The
   per-attempt strings in the log line and these counters are the fix.

   Reasons are a small fixed vocabulary — `timeout`, `net:<ErrorName>`,
   `http:<status>`, `body`, `shape` — so `byReason` cannot grow past a few
   dozen keys however long the process lives; the free-text part of a body
   failure (a JSON parse message quoting the upstream page) goes in the log
   line only. Surfaced through stats() and the `(session ok= fail=)` suffix
   of the failure line; deliberately no HTTP endpoint for them. */
const counters = { ok: 0, fail: 0, cached: 0 };
const byMirror = {};              // host -> { ok, fail }
const byReason = {};              // reason -> count
function mirrorTally(host) { return byMirror[host] || (byMirror[host] = { ok: 0, fail: 0 }); }
function oneLine(e) { return String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 80); }

const TIMEOUT_MS = parseInt(process.env.OVERPASS_TIMEOUT_MS || '30000', 10);
// Static POIs. Half an hour is short enough that a newly mapped camera shows up
// the same day and long enough that a busy area costs one upstream call.
const TTL_MS = parseInt(process.env.OVERPASS_TTL_MS || '1800000', 10);
const MAX_ENTRIES = 400;          // ~a few MB; evicted oldest-first
// Overpass cost scales with area, so there has to be a ceiling — but it must
// not be BELOW what the callers already clamp themselves to, or their widest
// legitimate view is rejected and the layer silently goes dark. The widest is
// ghost.js's MAX_BBOX_DEG (4°); routing.js clamps tighter still, at 3° and 2°.
// Raise this only alongside those.
const MAX_SPAN_DEG = parseFloat(process.env.OVERPASS_MAX_SPAN_DEG || '4');

/* ---------------- the queries we are willing to run ----------------
   Each returns Overpass QL for a bbox string "minLat,minLng,maxLat,maxLng".
   Kept verbatim from the client so behaviour is unchanged by the move. */
const KINDS = {
  // Routing: places worth steering around. Small result cap — this runs per
  // route request and only feeds a proximity test.
  police: (box) => '[out:json][timeout:20];(' +
    'node["amenity"="police"](' + box + ');' +
    'way["amenity"="police"](' + box + ');' +
    'node["highway"="speed_camera"](' + box + ');' +
    ');out center 400;',

  // Ghost Mode: everything the enforcement layer draws, including the ALPR /
  // surveillance cameras that DeFlock contributes as man_made=surveillance.
  enforcement: (box) => '[out:json][timeout:25];(' +
    'node["amenity"="police"](' + box + ');' +
    'way["amenity"="police"](' + box + ');' +
    'node["highway"="speed_camera"](' + box + ');' +
    'node["man_made"="surveillance"](' + box + ');' +
    'way["man_made"="surveillance"](' + box + ');' +
    ');out center 200;',

  // Road furniture for the drag/quest logic — a much larger cap because stops
  // and signals are dense.
  road: (box) => '[out:json][timeout:20];(' +
    'node["amenity"="police"](' + box + ');' +
    'way["amenity"="police"](' + box + ');' +
    'node["highway"="speed_camera"](' + box + ');' +
    'node["highway"="stop"](' + box + ');' +
    'node["highway"="traffic_signals"](' + box + ');' +
    ');out center 4000;'
};

function hasKind(kind) { return Object.prototype.hasOwnProperty.call(KINDS, kind); }

/* ---------------- cache ---------------- */

const cache = new Map();          // key -> { at, body }

// Rounded to ~1km so riders moving around the same area share entries instead of
// each minting their own. Without this the cache would hit almost never: two
// bboxes differing in the sixth decimal are the same question.
function keyFor(kind, b) {
  const r = (n) => Math.round(n * 100) / 100;
  return kind + ':' + [r(b.minLat), r(b.minLng), r(b.maxLat), r(b.maxLng)].join(',');
}

function fromCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  return hit.body;
}

function toCache(key, body) {
  // Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body: body });
}

// The first two keys predate the counters; the rest are copies so a caller
// cannot mutate the live tallies through what it was handed.
function stats() {
  return {
    entries: cache.size, mirrors: MIRRORS.length,
    ok: counters.ok, fail: counters.fail, cached: counters.cached,
    byMirror: JSON.parse(JSON.stringify(byMirror)),
    byReason: Object.assign({}, byReason)
  };
}

/* ---------------- fetch ---------------- */

// Cap on a single upstream body. Node happily buffers whatever arrives, and
// MIRRORS is env-configurable — a compromised/misconfigured mirror streaming a
// multi-GB "JSON" response would OOM the MAIN server process. 64MB is far past
// anything a real Overpass answer for our capped 4° boxes produces.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Read a JSON body with a hard size cap. Aborts (throws) once the accumulated
// bytes pass the cap instead of trusting Content-Length, which lies.
async function jsonCapped(res) {
  const len = +(res.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new Error('upstream body too large (' + len + ' bytes)');
  if (!res.body) return res.json();              // Node <16 shim path / no stream
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch (e) { /* already gone */ }
      throw new Error('upstream body exceeded ' + MAX_BODY_BYTES + ' bytes');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fetchT(url, opts, ms) {
  return fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opts || {}));
}

// Normalise a bbox from the request. Returns null for anything that isn't four
// finite, correctly ordered, in-range numbers spanning a sane area.
function parseBbox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);
  const b = {
    minLat: n(raw.minLat), minLng: n(raw.minLng),
    maxLat: n(raw.maxLat), maxLng: n(raw.maxLng)
  };
  for (const k in b) if (!isFinite(b[k])) return null;
  if (b.minLat < -90 || b.maxLat > 90 || b.minLng < -180 || b.maxLng > 180) return null;
  if (b.minLat >= b.maxLat || b.minLng >= b.maxLng) return null;
  // EPSILON, because the callers clamp to EXACTLY this limit. ghost.js builds a
  // 4° box as `centre ± 2`, and in binary that lands on 4.000000000000001 often
  // enough to matter — a bare `> MAX_SPAN_DEG` then rejects the layer's normal
  // wide view and it silently goes dark. The tolerance is a rounding error's
  // worth, not a loophole.
  const EPS = 1e-6;
  if ((b.maxLat - b.minLat) > MAX_SPAN_DEG + EPS) return null;
  if ((b.maxLng - b.minLng) > MAX_SPAN_DEG + EPS) return null;
  return b;
}

// Collapses concurrent identical requests. Ten riders in one city opening the
// map at once should cost Overpass one query, not ten.
const inFlight = new Map();       // key -> Promise

// Returns { body, cached } | { error }. Never throws.
async function query(kind, bbox) {
  if (!hasKind(kind)) return { error: 'unknown-kind' };
  const b = parseBbox(bbox);
  if (!b) return { error: 'bad-bbox' };

  const key = keyFor(kind, b);
  const hit = fromCache(key);
  if (hit) { counters.cached++; return { body: hit, cached: true }; }
  if (inFlight.has(key)) return inFlight.get(key);

  const box = b.minLat + ',' + b.minLng + ',' + b.maxLat + ',' + b.maxLng;
  const ql = KINDS[kind](box);

  const job = (async () => {
    const tried = [];             // 'host reason NNNms' per failed attempt, in order
    const failed = (i, reason, detail, t0) => {
      mirrorTally(MIRROR_HOSTS[i]).fail++;
      byReason[reason] = (byReason[reason] || 0) + 1;
      tried.push(MIRROR_HOSTS[i] + ' ' + reason + (detail ? ':' + detail : '') + ' ' + (Date.now() - t0) + 'ms');
    };
    for (let i = 0; i < MIRRORS.length; i++) {
      const t0 = Date.now();
      let res;
      try {
        res = await fetchT(MIRRORS[i], {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // Overpass asks that clients identify themselves so an
            // over-eager one can be contacted rather than simply blocked.
            'User-Agent': 'convoy/1.0 (+https://odoreeci.tech)'
          },
          body: 'data=' + encodeURIComponent(ql)
        }, TIMEOUT_MS);
      } catch (e) {
        // AbortSignal.timeout rejects with a TimeoutError; anything else is
        // the network (DNS, refused, reset — fetch wraps them in a TypeError).
        failed(i, e && e.name === 'TimeoutError' ? 'timeout' : 'net:' + ((e && e.name) || 'Error'), '', t0);
        continue;                 // → next mirror
      }
      // 429 (slot exhausted) and 504 (query timed out) are the two Overpass
      // answers worth retrying elsewhere; both are per-instance load, not a
      // problem with the query. The status IS the diagnosis, so it is kept.
      if (!res.ok) { failed(i, 'http:' + res.status, '', t0); continue; }
      let body;
      try { body = await jsonCapped(res); }
      catch (e) { failed(i, 'body', oneLine(e), t0); continue; }
      if (!body || !Array.isArray(body.elements)) { failed(i, 'shape', '', t0); continue; }
      toCache(key, body);
      counters.ok++;
      mirrorTally(MIRROR_HOSTS[i]).ok++;
      // A mirror that is down 100% of the time while the other covers for it
      // used to be invisible. Still at most one line per query.
      if (tried.length) {
        console.warn('[overpass] ' + kind + ' ' + box + ' served by ' + MIRROR_HOSTS[i] +
          ' after ' + tried.join('; '));
      }
      return { body: body, cached: false };
    }
    // Deliberately not cached: a failure must not lock the area out for the
    // whole TTL, and the client treats this exactly as it treated a CORS
    // failure before — feature off, nothing broken. The line says which
    // mirror failed, why, and how long each attempt took.
    counters.fail++;
    console.error('[overpass] all mirrors failed for ' + kind + ' ' + box + ' — ' + tried.join('; ') +
      ' (session ok=' + counters.ok + ' fail=' + counters.fail + ')');
    return { error: 'upstream' };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

module.exports = { query, hasKind, stats, KINDS, parseBbox, MAX_SPAN_DEG };
