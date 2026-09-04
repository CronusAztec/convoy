/* Convoy — crash + core-loop telemetry sink.

   The client half (js/telemetry.js) posts batches to /api/telemetry; this is
   what receives them. It exists so that "99% crash-free sessions" is a number
   the operator can read on day one, without an account anywhere, and so the
   funnel — the screen where riders quit — is visible from the same place.

   Two stores, deliberately:

     · A DAILY ROLLUP (telemetry.json), which is small, bounded and the thing
       /api/telemetry/stats reads. Counters only: sessions, crashed sessions,
       funnel steps, quit screens, and per-fingerprint error counts.

     · An ERROR LOG (telemetry-errors.jsonl), append-only and size-rotated, for
       the times a counter is not enough and you need the actual stack. Rotated
       at 8MB with exactly one generation kept, so a crash loop from one bad
       release can never fill the disk the database is on.

   The server's own uncaughtException / unhandledRejection handlers feed the same
   rollup through serverError(). A server that dies is a worse day for riders
   than a WebView that dies, and it would be strange to instrument only the
   client.

   Persistence mirrors hotspots.js exactly: atomic temp-file + rename with the
   Windows retry, an 800ms debounce, and a synchronous flush on process exit. */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;
const FILE = path.join(DATA_DIR, 'telemetry.json');
const ERR_FILE = path.join(DATA_DIR, 'telemetry-errors.jsonl');

// How long a day bucket is kept. The privacy policy commits to 30 days for
// diagnostics; this is the code that makes that true rather than aspirational.
const KEEP_DAYS = 30;
// Distinct error groups held per day. Past this the smallest group is evicted —
// a scripted flood of unique messages must not grow the rollup without bound.
const MAX_FP_PER_DAY = 500;
// Live sessions being tracked for "have we already counted this one?".
const MAX_LIVE_SESSIONS = 50000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const ERR_ROTATE_BYTES = 8 * 1024 * 1024;

/* The funnel, in order. Steps outside this list are ignored: the client is the
   only thing that names them, and an unbounded step namespace is an unbounded
   rollup. Add a step here when you add one to the client. */
const STEPS = ['boot', 'map_ready', 'gps_fix', 'signed_in', 'live', 'route_set',
  'trip_start', 'trip_arrive', 'convoy', 'race'];

let days = {};        // 'YYYY-MM-DD' -> bucket
let sessions = new Map(); // sid -> { day, at, crashed, counted }
let dirty = false;
let flushTimer = null;
let flushInFlight = false;
let writeGen = 0;
let errBytes = 0;

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ } }

function dayKey(ts) { return new Date(ts || Date.now()).toISOString().slice(0, 10); }

function bucket(day) {
  let b = days[day];
  if (!b) {
    b = days[day] = {
      sessions: 0,      // sessions that reported anything at all
      crashed: 0,       // ...of which at least one had an error
      errors: 0,        // total error events received
      serverErrors: 0,  // uncaught exceptions / rejections in this process
      steps: {},        // step name -> sessions that reached it
      quit: {},         // last screen -> sessions that ended there
      events: {},       // analytics event name -> count
      releases: {},     // release tag -> sessions
      fp: {},           // fingerprint -> { n, type, msg, at, release }
      vitals: {}        // release -> metric -> { n, sum, s: [] } (see recordVitals)
    };
  }
  return b;
}

/* Field Web Vitals (cycle 15). Per metric, a cap on the raw value a client is
   allowed to claim — generous enough for a genuinely slow device, tight
   enough that a corrupted client can't skew the pool. CLS/INP travel from the
   client already ×1000/as whole ms respectively (js/vitals.js), so their caps
   are in that same scaled unit. */
const VITALS_CAPS = { lcp: 120000, dcl: 120000, load: 120000, ttfb: 120000, cls: 10000, inp: 60000, lt: 10000 };
const VITALS_METRICS = Object.keys(VITALS_CAPS);
// Distinct raw samples kept per (day, release, metric) for the p75 sort.
// Beyond this, later samples in the same day are simply dropped rather than
// reservoir-sampled — this is a diagnostic percentile, not a billing figure,
// and "drop" keeps the number exactly reproducible from a fixture in a test,
// which reservoir sampling's randomness would not.
const VITALS_RESERVOIR = 100;

function recordVitals(b, release, v) {
  if (!v || typeof v !== 'object') return;
  const store = b.vitals || (b.vitals = {});   // restored-from-disk buckets predate this key (see load())
  const rel = store[release] || (store[release] = {});
  for (const m of VITALS_METRICS) {
    const n = num(v[m], VITALS_CAPS[m]);
    if (n == null) continue;
    const e = rel[m] || (rel[m] = { n: 0, sum: 0, s: [] });
    e.n++;
    e.sum += n;
    if (e.s.length < VITALS_RESERVOIR) e.s.push(n);
  }
}

/* ---------------- ingest ----------------
   `batch` is whatever the client posted, so nothing in it is trusted: every
   field is re-clamped here. The route has already checked the size and the rate
   limit; this checks the shape. */
function ingest(batch, meta) {
  if (!batch || typeof batch !== 'object') return { ok: false, error: 'bad batch' };
  const events = Array.isArray(batch.events) ? batch.events.slice(0, 40) : [];
  if (!events.length) return { ok: false, error: 'no events' };

  const sid = str(batch.sid, 40);
  if (!sid) return { ok: false, error: 'no session' };
  const release = str(batch.release, 32) || 'unknown';
  const native = !!batch.native;
  const now = Date.now();
  const day = dayKey(now);
  const b = bucket(day);

  // First sight of this session on this server: count it once, here. Doing it
  // per-batch would count a chatty session several times and quietly inflate the
  // crash-free denominator — the one number this whole file exists to produce.
  let s = sessions.get(sid);
  if (!s) {
    if (sessions.size >= MAX_LIVE_SESSIONS) evictSessions();
    s = { day: day, at: now, crashed: false };
    sessions.set(sid, s);
    b.sessions++;
    b.releases[release] = (b.releases[release] || 0) + 1;
  } else {
    s.at = now;
  }
  // A session that spans UTC midnight keeps being counted against the day it
  // started, so its start, its errors and its summary never end up in different
  // buckets (which would show as a crash with no session behind it).
  const own = bucket(s.day);

  let accepted = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    accepted++;
    switch (ev.k) {
      case 'error':
        own.errors++;
        if (!s.crashed) { s.crashed = true; own.crashed++; }
        recordFingerprint(own, ev, release, native, sid);
        break;
      case 'event': {
        const name = str(ev.name, 48);
        if (!name) break;
        own.events[name] = (own.events[name] || 0) + 1;
        // 'step:x' is the funnel; count the session once per step it reached.
        if (name.indexOf('step:') === 0) {
          const st = name.slice(5);
          if (STEPS.indexOf(st) >= 0) own.steps[st] = (own.steps[st] || 0) + 1;
        }
        break;
      }
      case 'end': {
        const screen = str(ev.lastScreen, 32) || 'unknown';
        own.quit[screen] = (own.quit[screen] || 0) + 1;
        break;
      }
      case 'session':
        break; // the counters above already happened on first sight
      case 'vitals':
        recordVitals(own, release, ev.v);
        break;
      default:
        accepted--; // unknown kind — ignore rather than store
    }
  }

  scheduleFlush();
  return { ok: true, accepted: accepted };
}

function recordFingerprint(b, ev, release, native, sid) {
  const fp = str(ev.fp, 200) || (str(ev.type, 80) + '|' + str(ev.msg, 120));
  let e = b.fp[fp];
  if (!e) {
    if (Object.keys(b.fp).length >= MAX_FP_PER_DAY) evictSmallest(b.fp);
    e = b.fp[fp] = { n: 0, type: str(ev.type, 80), msg: str(ev.msg, 300), at: Date.now(), release: release };
  }
  e.n++;
  e.at = Date.now();
  e.release = release;
  appendError({
    ts: Date.now(),
    sid: sid,
    release: release,
    native: native,
    type: str(ev.type, 80),
    msg: str(ev.msg, 500),
    fp: fp,
    screen: str(ev.screen, 32),
    handled: !!ev.handled,
    // Just the top frames — the rest is rarely read and this file is the one
    // that grows fastest.
    frames: Array.isArray(ev.frames) ? ev.frames.slice(0, 5).map(function (f) {
      return { fn: str(f && f.fn, 120), file: str(f && f.file, 200), line: +(f && f.line) || 0 };
    }) : [],
    crumbs: Array.isArray(ev.crumbs) ? ev.crumbs.slice(-10).map(function (c) {
      return { t: +(c && c.t) || 0, c: str(c && c.c, 16), m: str(c && c.m, 120) };
    }) : []
  });
}

/* A crash in THIS process. Folded into the same rollup so one stats call
   answers "is anything on fire?" for both halves of the app. */
function serverError(kind, err) {
  const b = bucket(dayKey());
  b.serverErrors++;
  const type = str(kind, 40) || 'ServerError';
  const msg = str(err && (err.message || err), 300);
  const fp = 'server|' + type + '|' + msg.replace(/\d+/g, 'N').slice(0, 120);
  let e = b.fp[fp];
  if (!e) {
    if (Object.keys(b.fp).length >= MAX_FP_PER_DAY) evictSmallest(b.fp);
    e = b.fp[fp] = { n: 0, type: type, msg: msg, at: Date.now(), release: 'server' };
  }
  e.n++;
  e.at = Date.now();
  appendError({
    ts: Date.now(), sid: 'server', release: 'server', native: false,
    type: type, msg: msg, fp: fp, screen: 'server', handled: false,
    frames: [], crumbs: [],
    stack: str(err && err.stack, 4000)
  });
  scheduleFlush();
}

/* ---------------- stats ----------------
   What you actually want to look at every morning of a beta: are we above the
   crash-free bar, where do riders stop, and what is breaking most. */
function stats(daysBack) {
  const n = Math.max(1, Math.min(KEEP_DAYS, +daysBack || 7));
  const keys = Object.keys(days).sort().slice(-n);
  const totals = { sessions: 0, crashed: 0, errors: 0, serverErrors: 0 };
  const steps = {}, quit = {}, events = {}, fp = {}, releases = {};
  const vitalsPool = {};   // metric -> { n, sum, s: [] }, pooled across days AND releases

  for (const k of keys) {
    const b = days[k];
    totals.sessions += b.sessions;
    totals.crashed += b.crashed;
    totals.errors += b.errors;
    totals.serverErrors += b.serverErrors;
    merge(steps, b.steps); merge(quit, b.quit); merge(events, b.events); merge(releases, b.releases);
    for (const f in b.fp) {
      if (!Object.prototype.hasOwnProperty.call(b.fp, f)) continue;
      const e = b.fp[f];
      const cur = fp[f] || (fp[f] = { n: 0, type: e.type, msg: e.msg, at: 0, release: e.release });
      cur.n += e.n;
      if (e.at > cur.at) { cur.at = e.at; cur.release = e.release; }
    }
    const bv = b.vitals || {};   // absent on a day bucket restored from pre-cycle-15 disk state
    for (const rel in bv) {
      if (!Object.prototype.hasOwnProperty.call(bv, rel)) continue;
      for (const m in bv[rel]) {
        if (!Object.prototype.hasOwnProperty.call(bv[rel], m)) continue;
        const e = bv[rel][m];
        const cur = vitalsPool[m] || (vitalsPool[m] = { n: 0, sum: 0, s: [] });
        cur.n += e.n;
        cur.sum += e.sum;
        cur.s = cur.s.concat(e.s);
      }
    }
  }

  // p75 of the pooled reservoir, index Math.ceil(0.75*len)-1. cls travels
  // scaled ×1000 from the client (see js/vitals.js); scale both p75 and mean
  // back down here so the payload carries a real 0.0x figure throughout.
  const vitals = {};
  for (const m of VITALS_METRICS) {
    const e = vitalsPool[m];
    if (!e || !e.n) { vitals[m] = { p75: null, n: 0, mean: null }; continue; }
    const sorted = e.s.slice().sort(function (a, b) { return a - b; });
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.75 * sorted.length) - 1));
    let p75 = sorted.length ? sorted[idx] : null;
    let mean = Math.round(e.sum / e.n);
    if (m === 'cls') { if (p75 != null) p75 = p75 / 1000; mean = mean / 1000; }
    vitals[m] = { p75: p75, n: e.n, mean: mean };
  }

  // The headline. An empty window is not 100% crash-free, it is unknown — say
  // null rather than printing a reassuring number nobody measured.
  const crashFree = totals.sessions
    ? Math.round((1 - totals.crashed / totals.sessions) * 10000) / 100
    : null;

  return {
    window: { days: keys.length, from: keys[0] || null, to: keys[keys.length - 1] || null },
    sessions: totals.sessions,
    crashedSessions: totals.crashed,
    crashFreePct: crashFree,
    // The bar from the launch checklist, so the answer is in the payload rather
    // than in someone's head.
    meetsBar: crashFree == null ? null : crashFree >= 99,
    errors: totals.errors,
    serverErrors: totals.serverErrors,
    releases: releases,
    vitals: vitals,
    // Funnel as reached-counts plus the share of sessions that got there.
    funnel: STEPS.map(function (s) {
      const c = steps[s] || 0;
      return { step: s, sessions: c, pct: totals.sessions ? Math.round(c / totals.sessions * 1000) / 10 : 0 };
    }),
    quitScreens: top(quit, 10),
    events: top(events, 20),
    topErrors: Object.keys(fp).map(function (f) {
      return { fp: f, count: fp[f].n, type: fp[f].type, msg: fp[f].msg, release: fp[f].release, lastAt: fp[f].at };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 20),
    byDay: keys.map(function (k) {
      const b = days[k];
      return {
        day: k, sessions: b.sessions, crashed: b.crashed, errors: b.errors,
        crashFreePct: b.sessions ? Math.round((1 - b.crashed / b.sessions) * 10000) / 100 : null
      };
    })
  };
}

/* ---------------- helpers ---------------- */
function str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}
// A `null` return means "not recorded" — never coerced to 0, which would
// silently drag a p75 down and lie in the flattering direction.
function num(v, max) {
  const n = Math.round(+v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}
function merge(into, from) {
  for (const k in from) {
    if (Object.prototype.hasOwnProperty.call(from, k)) into[k] = (into[k] || 0) + from[k];
  }
}
function top(obj, n) {
  return Object.keys(obj).map(function (k) { return { name: k, count: obj[k] }; })
    .sort(function (a, b) { return b.count - a.count; }).slice(0, n);
}
function evictSmallest(map) {
  let worst = null, worstN = Infinity;
  for (const k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (map[k].n < worstN) { worstN = map[k].n; worst = k; }
  }
  if (worst) delete map[worst];
}
function evictSessions() {
  // Map iterates in insertion order, so the front is the oldest. Drop a tenth at
  // a time rather than one per insert, which would thrash on every request.
  const drop = Math.ceil(MAX_LIVE_SESSIONS / 10);
  let i = 0;
  for (const k of sessions.keys()) { sessions.delete(k); if (++i >= drop) break; }
}

/* ---------------- error log ---------------- */
function appendError(rec) {
  ensureDir();
  let line;
  try { line = JSON.stringify(rec) + '\n'; } catch (e) { return; }
  try {
    if (errBytes + line.length > ERR_ROTATE_BYTES) rotateErrors();
    fs.appendFileSync(ERR_FILE, line, 'utf8');
    errBytes += line.length;
  } catch (e) { /* disk full / read-only — telemetry never breaks the server */ }
}

function rotateErrors() {
  try {
    fs.renameSync(ERR_FILE, ERR_FILE + '.1');   // exactly one generation kept
    errBytes = 0;
  } catch (e) { errBytes = 0; }
}

/* ---------------- persistence (mirrors hotspots.js) ---------------- */
function load() {
  ensureDir();
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return; } // fresh install — nothing recorded yet
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) {
    const backup = FILE + '.corrupt.' + Date.now();
    try { fs.copyFileSync(FILE, backup); console.error('[telemetry] telemetry.json corrupt — backed up to ' + backup); }
    catch (e2) { console.error('[telemetry] telemetry.json corrupt and could not back up:', e2.message); }
    return;
  }
  if (obj && obj.days && typeof obj.days === 'object') {
    days = obj.days;
    prune();
    const n = Object.keys(days).length;
    if (n) console.log('[telemetry] loaded ' + n + ' day(s) of rollup');
  }
  try { errBytes = fs.statSync(ERR_FILE).size; } catch (e) { errBytes = 0; }
}

function scheduleFlush() {
  dirty = true;
  writeGen++;
  if (flushTimer) return;
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
    await fsp.writeFile(tmp, JSON.stringify({ days: days }), 'utf8');
    await renameRetry(tmp, FILE);
    if (writeGen === gen) dirty = false;
  } catch (e) {
    console.error('[telemetry] flush failed:', e.message);
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
    fs.writeFileSync(tmp, JSON.stringify({ days: days }), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[telemetry] flushSync failed:', e.message);
    dirty = true;
    try { fs.unlinkSync(tmp); } catch (e2) { /* may not exist */ }
  }
}

// Windows-safe rename with short backoff for transient EPERM/EACCES/EBUSY
// (antivirus/backup tools briefly holding the file). Identical to store.js.
function renameRetry(from, to, attempts) {
  attempts = attempts || 5;
  return new Promise(function (resolve, reject) {
    let i = 0;
    function attempt() {
      fsp.rename(from, to).then(resolve, function (e) {
        const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
        if (!transient || ++i >= attempts) return reject(e);
        setTimeout(attempt, 20 * i);
      });
    }
    attempt();
  });
}

/* Drop day buckets past the retention window, and sessions we have not heard
   from in hours. Both are the code behind a promise in the privacy policy, so
   they run on a timer rather than only at boot. */
function prune() {
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);
  let removed = 0;
  for (const k in days) {
    if (!Object.prototype.hasOwnProperty.call(days, k)) continue;
    if (k < cutoff) { delete days[k]; removed++; }
  }
  const old = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) { if (v.at < old) sessions.delete(k); }
  if (removed) scheduleFlush();
  return removed;
}

function startMaintenance() {
  setInterval(prune, 60 * 60 * 1000).unref();
}

load();
startMaintenance();
process.on('exit', flushSync);

module.exports = {
  ingest: ingest,
  serverError: serverError,
  stats: stats,
  prune: prune,
  flush: flush,
  flushSync: flushSync,
  STEPS: STEPS,
  // Test/ops probes.
  liveSessions: function () { return sessions.size; },
  // Test hook. The optional seed exists so retention can be exercised against
  // real day buckets — a KEEP_DAYS that is only a constant, and never actually
  // deletes anything, is a promise in the privacy policy that the code does not
  // keep.
  _reset: function (seedDays) { days = seedDays || {}; sessions = new Map(); dirty = false; }
};
