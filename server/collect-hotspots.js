#!/usr/bin/env node
/* Convoy — continuous hotspot collector.

   Builds the police-probability hotspot model around the clock, independent of
   whether anyone is using the app. It sweeps a list of regions (see
   collect-regions.json) and POSTs each bbox to the running server's /api/waze
   endpoint — which fetches live Waze police sightings and records the 'police'
   ones into server/hotspots.js. The SERVER stays the single owner of
   hotspots.json, so there is no two-process file fight: this script never writes
   the data file itself, it only drives the server's existing record path.

   Why route through the server instead of recording directly?
     - hotspots.js keeps observations in memory + flushes hotspots.json. A second
       process calling record() would have its own array and clobber the file on
       flush. Going through HTTP keeps one writer.
     - /api/waze already injects the API key, classifies alerts, and records police
       sightings (with 15-min per-cell dedup) — exactly what we want, for free.

   Run continuously (pick one):
     node server/collect-hotspots.js                 # foreground
     pm2 start server/collect-hotspots.js --name convoy-collector
     systemd: see deploy/convoy-collector.service

   Config (env):
     COLLECT_URL          base URL of the API        (default http://localhost:5173)
     COLLECT_INTERVAL_MS  gap between full sweeps     (default 900000 = 15 min)
     COLLECT_STEP_MS      gap between region requests (default 4000 = 4s, ~15/min,
                          under the server's 30/min-per-IP /api/waze rate limit)
     COLLECT_REGIONS      path to a regions JSON      (default ./collect-regions.json)
     COLLECT_REGIONS_PER_SWEEP  regions polled per cycle (default 20) — the region
                          list is nationwide (~120 metros); each cycle sweeps the
                          next rotating slice so quota stays flat regardless of
                          list size, and the whole USA is covered every
                          ceil(N/20) cycles

   NOTE on API quota: each polled region = one OpenWeb Ninja request. With the
   default 20 regions/cycle at a 15-min interval that's ~1,900/day ≈ 58k/month.
   The server dedups repeat sightings within 15 min, so sweeping FASTER than the
   interval mostly wastes quota. Lower COLLECT_REGIONS_PER_SWEEP or raise
   COLLECT_INTERVAL_MS to fit your plan. */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = (process.env.COLLECT_URL || 'http://localhost:5173').replace(/\/+$/, '');
// Fail LOUDLY on a malformed value ("30m", typos): a NaN interval would make the
// wait computation NaN and the collector would sweep back-to-back with no pause.
function envInt(name, def, min) {
  const raw = process.env[name];
  const v = parseInt(raw || String(def), 10);
  if (!Number.isFinite(v) || v < min) {
    console.error('[collector] invalid ' + name + '="' + raw + '" — expected integer milliseconds >= ' + min + '. Aborting.');
    process.exit(1);
  }
  return v;
}
const INTERVAL_MS = envInt('COLLECT_INTERVAL_MS', 900000, 60000); // 15 min between sweeps
const STEP_MS = envInt('COLLECT_STEP_MS', 4000, 500);             // 4s between calls
const REGIONS_PER_SWEEP = envInt('COLLECT_REGIONS_PER_SWEEP', 20, 1); // rotating slice per cycle
const REGIONS_FILE = process.env.COLLECT_REGIONS || path.join(__dirname, 'collect-regions.json');

if (typeof fetch !== 'function') {
  console.error('[collector] global fetch unavailable — needs Node 18+. Aborting.');
  process.exit(1);
}

function loadRegions() {
  let raw;
  try { raw = fs.readFileSync(REGIONS_FILE, 'utf8'); }
  catch (e) { console.error('[collector] cannot read regions file ' + REGIONS_FILE + ': ' + e.message); process.exit(1); }
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { console.error('[collector] regions file is not valid JSON: ' + e.message); process.exit(1); }
  const list = (j && Array.isArray(j.regions) ? j.regions : []).filter((r) =>
    r && Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => typeof n === 'number' && isFinite(n)));
  if (!list.length) { console.error('[collector] no valid regions in ' + REGIONS_FILE); process.exit(1); }
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;

// Poll one region. Returns the police-feature count, or -1 on a hard error.
// Honors a 429 by signalling the caller to back off.
async function pollRegion(region) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const body = JSON.stringify({ bottomLeft: [minLng, minLat], topRight: [maxLng, maxLat] });
  let res;
  try {
    res = await fetch(BASE + '/api/waze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  } catch (e) {
    console.warn('[collector] ' + region.name + ': network error — ' + e.message);
    return { police: -1, rateLimited: false };
  }
  if (res.status === 429) return { police: -1, rateLimited: true };
  if (res.status === 503) return { police: -1, rateLimited: false, keyMissing: true };
  if (!res.ok) { console.warn('[collector] ' + region.name + ': HTTP ' + res.status); return { police: -1, rateLimited: false }; }
  let fc;
  try { fc = await res.json(); } catch (e) { return { police: -1, rateLimited: false }; }
  const feats = (fc && fc.features) || [];
  const police = feats.filter((f) => f.properties && f.properties.kind === 'police').length;
  return { police: police, rateLimited: false };
}

async function sweep(regions) {
  const t0 = Date.now();
  let totalPolice = 0, ok = 0, failed = 0, limited = false;
  for (let i = 0; i < regions.length; i++) {
    if (stopping) break;
    const result = await pollRegion(regions[i]);
    if (result.rateLimited) {
      // The free-tier key is shared and rate-limits the WHOLE account, not one region
      // — so a 429 means every remaining region would 429 too. Stop now and let the
      // server's cooldown + the next interval recover, instead of burning more calls.
      limited = true;
      console.warn('[collector] rate limited — pausing this sweep until the next cycle');
      break;
    }
    if (result.keyMissing) {
      // No Waze key on the server → every region 503s identically. Skip the rest
      // of this sweep (one warn line, not one per region) and re-check next
      // interval so the collector self-recovers once a key is configured.
      failed++;
      console.warn('[collector] server has no Waze key (503) — skipping the rest of this sweep');
      break;
    }
    if (result.police >= 0) { ok++; totalPolice += result.police; }
    else failed++;
    if (!stopping && i < regions.length - 1) await sleep(STEP_MS);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('[collector] sweep ' + (limited ? 'paused (rate limited)' : 'done') + ' in ' + secs + 's — ' +
    ok + '/' + regions.length + ' regions ok, ' + totalPolice + ' live police sightings recorded' +
    (failed ? (', ' + failed + ' failed') : ''));
}

// Rotating slice of the region list for one cycle (wraps around) — nationwide
// coverage without multiplying per-cycle API quota.
function regionsForCycle(regions, cycle) {
  const k = Math.min(REGIONS_PER_SWEEP, regions.length);
  if (k >= regions.length) return regions;
  const start = (cycle * k) % regions.length;
  const slice = regions.slice(start, start + k);
  if (slice.length < k) slice.push(...regions.slice(0, k - slice.length)); // wrap
  return slice;
}

async function main() {
  const regions = loadRegions();
  console.log('[collector] starting — ' + regions.length + ' regions (' +
    Math.min(REGIONS_PER_SWEEP, regions.length) + '/cycle, full pass every ' +
    Math.ceil(regions.length / REGIONS_PER_SWEEP) + ' cycles), sweep every ' +
    Math.round(INTERVAL_MS / 60000) + ' min, ' + STEP_MS + 'ms between calls, target ' + BASE);
  // Confirm the server is reachable and Waze is enabled before the first sweep.
  try {
    const caps = await fetch(BASE + '/api/route/caps').then((r) => r.json());
    if (!caps.waze) console.warn('[collector] WARNING: server reports waze:false — set OPENWEBNINJA_KEY or police sightings will be empty.');
  } catch (e) {
    console.warn('[collector] WARNING: could not reach ' + BASE + '/api/route/caps (' + e.message + ') — is the server running?');
  }

  let cycle = 0;
  while (!stopping) {
    const start = Date.now();
    await sweep(regionsForCycle(regions, cycle));
    cycle++;
    if (stopping) break;
    // Pace to a fixed cadence measured from the sweep START, so a slow sweep
    // doesn't compound the gap. If a sweep already ran past the interval, go again now.
    const wait = Math.max(0, INTERVAL_MS - (Date.now() - start));
    if (wait > 0) {
      console.log('[collector] next sweep in ' + Math.round(wait / 1000) + 's');
      // Sleep in short slices so SIGINT is responsive.
      for (let w = 0; w < wait && !stopping; w += 1000) await sleep(Math.min(1000, wait - w));
    }
  }
  console.log('[collector] stopped.');
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
  if (stopping) process.exit(0);     // second signal → exit immediately
  console.log('\n[collector] ' + sig + ' — finishing current step, press again to force quit…');
  stopping = true;
}));

main().catch((e) => { console.error('[collector] fatal:', e); process.exit(1); });
