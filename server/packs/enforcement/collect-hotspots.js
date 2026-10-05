#!/usr/bin/env node
/* Convoy — enforcement pack: the Waze hotspot collector.

   Builds the police-probability hotspot model around the clock, independent
   of whether anyone is using the app. It sweeps a list of regions (see
   collect-regions.json) and asks the licensed Waze feed (./waze, key from
   the environment) for live police sightings in each, then hands them to a
   SINK as hotspot observations.

   The pre-cut version POSTed each bbox to the server's /api/waze so the
   server stayed the one writer of hotspots.json. Both halves of that reason
   are gone: the pack's routes are gated on a rider's account, and the model
   persists through the database (migration 007) rather than a file. So:

     · in-process: server/packs/enforcement.js starts this with
       ENFORCEMENT_COLLECTOR=waze|all and the sink is agent.ingest();
     · standalone (its own process / systemd unit, convoy-collector.service
       beside it): the sink drops a JSON file per sweep into
       ENFORCEMENT_INBOX_DIR for the server half to pick up.

   police-finder.js supersedes this for a server that wants every source; this
   one is the gentle, Waze-only option.

   Config (env):
     OPENWEBNINJA_KEY           the Waze key; unset ⇒ nothing to collect
     ENFORCEMENT_INBOX_DIR      standalone only (default <DATA_DIR>/enforcement-inbox)
     COLLECT_INTERVAL_MS        gap between full sweeps     (default 900000 = 15 min)
     COLLECT_STEP_MS            gap between region requests (default 4000 = 4s)
     COLLECT_REGIONS            path to a regions JSON      (default ./collect-regions.json)
     COLLECT_REGIONS_PER_SWEEP  regions polled per cycle    (default 20, rotating)

   NOTE on quota: each polled region = one OpenWeb Ninja request. With the
   default 20 regions/cycle at a 15-min interval that's ~1,900/day. The model
   dedups repeat sightings within 15 min, so sweeping FASTER mostly wastes it. */
'use strict';

const fs = require('fs');
const path = require('path');
const waze = require('./waze');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envInt(name, def, min, fatal) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min) {
    const msg = '[collector] invalid ' + name + '="' + raw + '" — expected integer milliseconds >= ' + min;
    if (fatal) { console.error(msg + '. Aborting.'); process.exit(1); }
    console.error(msg + '; using ' + def);
    return def;
  }
  return v;
}
function readConfig(fatal) {
  return {
    intervalMs: envInt('COLLECT_INTERVAL_MS', 900000, 60000, fatal),
    stepMs: envInt('COLLECT_STEP_MS', 4000, 500, fatal),
    regionsPerSweep: envInt('COLLECT_REGIONS_PER_SWEEP', 20, 1, fatal),
    regionsFile: process.env.COLLECT_REGIONS || path.join(__dirname, 'collect-regions.json')
  };
}

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

// Rotating slice of the region list for one cycle (wraps around).
function regionsForCycle(regions, cycle, perSweep) {
  const k = Math.min(perSweep, regions.length);
  if (k >= regions.length) return regions;
  const start = (cycle * k) % regions.length;
  const slice = regions.slice(start, start + k);
  if (slice.length < k) slice.push(...regions.slice(0, k - slice.length));
  return slice;
}

// Poll one region. Resolves { police, items } or { police: -1, rateLimited | keyMissing }.
function pollRegion(region) {
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

async function sweep(st, regions) {
  const t0 = Date.now();
  let totalPolice = 0, ok = 0, failed = 0, limited = false;
  const batch = [];
  for (let i = 0; i < regions.length; i++) {
    if (st.stopping) break;
    const result = await pollRegion(regions[i]);
    if (result.rateLimited) {
      // The key is shared and rate-limits the WHOLE account — stop now and let
      // waze.js's cooldown + the next interval recover.
      limited = true;
      console.warn('[collector] rate limited — pausing this sweep until the next cycle');
      break;
    }
    if (result.keyMissing) {
      failed++;
      console.warn('[collector] OPENWEBNINJA_KEY unset — skipping the rest of this sweep');
      break;
    }
    if (result.police >= 0) { ok++; totalPolice += result.police; for (const it of result.items) batch.push(it); }
    else failed++;
    if (!st.stopping && i < regions.length - 1) await sleep(st.cfg.stepMs);
  }
  if (batch.length) {
    try { await st.sink(batch); } catch (e) { console.warn('[collector] delivery failed: ' + e.message); }
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('[collector] sweep ' + (limited ? 'paused (rate limited)' : 'done') + ' in ' + secs + 's — ' +
    ok + '/' + regions.length + ' regions ok, ' + totalPolice + ' live police sightings recorded' +
    (failed ? (', ' + failed + ' failed') : ''));
}

// opts.sink(items) → may be async. Returns { stop, config, name }.
function start(opts) {
  const st = { sink: (opts && opts.sink) || (() => {}), stopping: false, cfg: readConfig(!!(opts && opts.fatalConfig)) };
  const cfg = st.cfg;
  (async function main() {
    const regions = loadRegions(cfg.regionsFile);
    console.log('[collector] starting — ' + regions.length + ' regions (' +
      Math.min(cfg.regionsPerSweep, regions.length) + '/cycle, full pass every ' +
      Math.ceil(regions.length / cfg.regionsPerSweep) + ' cycles), sweep every ' +
      Math.round(cfg.intervalMs / 60000) + ' min, ' + cfg.stepMs + 'ms between calls');
    if (!waze.hasKey()) console.warn('[collector] WARNING: OPENWEBNINJA_KEY unset — sightings will be empty until it is.');
    let cycle = 0;
    while (!st.stopping) {
      const startAt = Date.now();
      try { await sweep(st, regionsForCycle(regions, cycle, cfg.regionsPerSweep)); }
      catch (e) { console.error('[collector] sweep failed:', e.message); }
      cycle++;
      if (st.stopping) break;
      const wait = Math.max(0, cfg.intervalMs - (Date.now() - startAt));
      if (wait > 0) {
        console.log('[collector] next sweep in ' + Math.round(wait / 1000) + 's');
        for (let w = 0; w < wait && !st.stopping; w += 1000) await sleep(Math.min(1000, wait - w));
      }
    }
    console.log('[collector] stopped.');
  })().catch((e) => { console.error('[collector] fatal:', e.message); st.stopping = true; });
  return { name: 'waze', config: cfg, stop: () => { st.stopping = true; } };
}

if (require.main === module) {
  if (typeof fetch !== 'function') { console.error('[collector] global fetch unavailable — needs Node 18+. Aborting.'); process.exit(1); }
  const agent = require('./agent');
  const dir = process.env.ENFORCEMENT_INBOX_DIR ||
    path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'enforcement-inbox');
  console.log('[collector] standalone — batches go to ' + dir + ' (set ENFORCEMENT_INBOX_DIR on the server too)');
  const h = start({ fatalConfig: true, sink: (items) => { agent.writeInbox(dir, items); } });
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
    console.log('\n[collector] ' + sig + ' — finishing current step…');
    h.stop();
  }));
}

module.exports = { start, regionsForCycle };
