/* Convoy — Performance timers pack, server half (server/packs/perf.js).

   What server/server.js carried for the drag timer and side-by-side racing
   before the 2026-10-04 store cut (git show 61675ac -- server/server.js
   server/store.js server/db.js), re-homed as a feature-pack server half: every
   route and socket handler here is dispatched by server/packs/index.js ONLY
   for an account that holds the 'perf' pack, and the pack's data goes only to
   sockets that hold it too.

   WHAT MOVED, AND WHAT IT IS CALLED NOW
     server.js   RACE_* constants, the races map, raceLite / sendRaceState /
                 raceFinished / endRace / abandonRace / leaveRace / fanoutStat,
                 the ws handlers 'dragy:pb', 'race:create' … 'race:end' and
                 the close hook's leaveRace
                   → the same functions below; every socket type is prefixed:
                     'perf:dragy:pb', 'perf:race:create', 'perf:race:join',
                     'perf:race:ready', 'perf:race:start', 'perf:race:fix',
                     'perf:race:finish', 'perf:race:leave', 'perf:race:invite',
                     'perf:race:end', plus 'perf:stats:get'; what the server
                     sends is 'perf:race:state', 'perf:race:invite',
                     'perf:race:fix', 'perf:dragy:pb', 'perf:stats' and
                     'perf:err' (the core's 'err' is not a pack message);
                     the close hook is onClose()
                 POST /api/dragy/pb
                   → GET /api/perf/dragy/pb. A pack route is reached after the
                     core has already consumed the request body (handleApi
                     reads it before dispatching, and does not pass it on), so
                     the upload rides the socket as 'perf:dragy:pb' — the path
                     the old server accepted alongside the POST — and the route
                     answers the account's stats for the profile page.
     store.js    getStats / recordPB / recordRun / recordWin (and the admin
                 setStats / setPB, not restored)
     db.js       queuePB / queueRunIncrement / queueWinIncrement and loadAll's
                 user_stats / dragy_pbs reads
                   → the core no longer has these. Stats live HERE: an
                     in-memory Map loaded at init() from public.user_stats and
                     public.dragy_pbs through ctx.db.query, written through
                     with ctx.db.query (the SQL is the old db.js's, including
                     the "only if better" guard on a PB and the SQL-side
                     increments). Migration server/migrations/005_perf_stats.sql
                     creates both tables where no earlier schema did.

   The ctx handed in is packCtx in server/server.js: clients, send, rateOk,
   getRider, riderName, blockedPair, gated, validPos, num, defer, json,
   store, db, B (geo helpers), NEARBY_KM. Nothing here requires the core.

   ENV (read here, never sent to the client)
     RACE_FIX_BUDGET      per-connection race:fix frames per minute (700)
     RACE_FIX_IP_BUDGET   per-IP race:fix frames per minute (3600)
     RACE_COUNTDOWN_MS    lobby → green light (3000)
     RACE_TEARDOWN_MS     how long a finished race stays for the leaderboard (8000) */
'use strict';
const crypto = require('crypto');

const ID = 'perf';

/* ---------------- constants ---------------- */
const DRAGY_MODES = ['0-60', '0-100k', '0-30', '0-100', '60-130', '100-200k', 'eighth', 'quarter'];
const RACE_MAX = 8;        // racers per race (matches the parking-lot feel of a drag strip)
// race:fix budgets. The client relays at 10Hz for the WHOLE race (race.js
// fixSendTimer), so one racer needs 600/min — a 200/min PER-IP bucket starved
// every race 10–20s in (instantly so for two riders sharing a phone-hotspot
// NAT, which is this app's home turf). Budget per CONNECTION at the real
// cadence, and per IP at "a full NAT'd race group" headroom.
const RACE_FIX_BUDGET = envInt('RACE_FIX_BUDGET', 700);        // per connection /min
const RACE_FIX_IP_BUDGET = envInt('RACE_FIX_IP_BUDGET', 3600); // per IP /min (6 racers @10Hz)
const RACE_COUNTDOWN_MS = envInt('RACE_COUNTDOWN_MS', 3000);
const RACE_TEARDOWN_MS = envInt('RACE_TEARDOWN_MS', 8000);
const RACE_LOBBY_TTL_MS = 30 * 60 * 1000;   // a lobby nobody started is pruned after this
const RACE_RUN_TTL_MS = 10 * 60 * 1000;     // a run nobody finished is resolved after this
const SWEEP_MS = 60 * 1000;

function envInt(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const str = (v, max, dflt) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : (dflt || ''));

let ctx = null;

/* ================= stats (what server/store.js + server/db.js kept) =================
   userId -> { pb: { modeId: { time, trap, when } }, runs, wins }. Loaded once at
   boot; every write goes to memory first (so the hot path stays synchronous)
   and to Postgres through ctx.db.query, fire-and-forget with a logged failure
   — the SQL is idempotent and "only if better", so a retry can never regress
   a record. */
const stats = new Map();
let statsLoaded = false;

function blankStats() { return { pb: {}, runs: 0, wins: 0 }; }
function statsOf(id) {
  let s = stats.get(id);
  if (!s) { s = blankStats(); stats.set(id, s); }
  if (!s.pb || typeof s.pb !== 'object') s.pb = {};
  if (typeof s.runs !== 'number') s.runs = 0;
  if (typeof s.wins !== 'number') s.wins = 0;
  return s;
}
// Read-only view: never creates an entry (a guest, a deleted account).
function getStats(id) { return (id && stats.get(id)) || blankStats(); }

function write(sql, params, what) {
  if (!ctx || !ctx.db || typeof ctx.db.query !== 'function') return Promise.resolve();
  let p;
  try { p = Promise.resolve(ctx.db.query(sql, params)); } catch (e) { p = Promise.reject(e); }
  return p.catch((e) => { console.error('[perf] ' + what + ' write failed: ' + (e && e.message)); });
}

// Record a dragy personal best. Only persists when it beats the stored time for
// the same modeId (lower is better). Returns the updated stats object.
function recordPB(id, modeId, time, trap) {
  const s = statsOf(id);
  const prev = s.pb[modeId];
  if (!prev || time < prev.time) {
    const when = Date.now();
    s.pb[modeId] = { time, trap: trap != null ? trap : null, when };
    // Guarded by the same "only if better" rule applied in memory, so a
    // replayed or out-of-order write can't regress a personal best.
    write(
      `insert into public.dragy_pbs (user_id, mode_id, time_s, trap, achieved_at)
       values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
       on conflict (user_id, mode_id) do update
         set time_s = excluded.time_s, trap = excluded.trap, achieved_at = excluded.achieved_at
         where excluded.time_s < public.dragy_pbs.time_s`,
      [id, modeId, time, trap != null ? trap : null, when], 'pb');
  }
  return s;
}
// Race counters. Deliberately SEPARATE calls:
//   recordRun — exactly once per racer per race, on a finish OR a DNF.
//   recordWin — additionally, for the fastest legal finisher.
// Counters are incremented in SQL rather than written as absolute values, so
// the database stays correct even if the in-memory copy and the queue disagree.
function recordRun(id) {
  const s = statsOf(id);
  s.runs++;
  write(
    `insert into public.user_stats (user_id, runs) values ($1, 1)
     on conflict (user_id) do update set runs = public.user_stats.runs + 1, updated_at = now()`,
    [id], 'run');
  return s;
}
function recordWin(id) {
  const s = statsOf(id);
  s.wins++;
  write(
    `insert into public.user_stats (user_id, wins) values ($1, 1)
     on conflict (user_id) do update set wins = public.user_stats.wins + 1, updated_at = now()`,
    [id], 'win');
  return s;
}

async function loadStats() {
  if (!ctx || !ctx.db || typeof ctx.db.query !== 'function') return;
  try {
    const [rows, pbs] = await Promise.all([
      ctx.db.query('select user_id, runs, wins from public.user_stats'),
      ctx.db.query('select user_id, mode_id, time_s, trap, extract(epoch from achieved_at) * 1000 as when_ms from public.dragy_pbs')
    ]);
    ((rows && rows.rows) || []).forEach((r) => {
      const s = statsOf(r.user_id);
      s.runs = Number(r.runs) || 0; s.wins = Number(r.wins) || 0;
    });
    ((pbs && pbs.rows) || []).forEach((r) => {
      if (DRAGY_MODES.indexOf(r.mode_id) < 0) return;
      const s = statsOf(r.user_id);
      s.pb[r.mode_id] = { time: Number(r.time_s), trap: r.trap == null ? null : Number(r.trap), when: Number(r.when_ms) || 0 };
    });
    statsLoaded = true;
    console.log('[perf] stats loaded: ' + stats.size + ' riders');
  } catch (e) {
    // Degrade: the pack still runs, counters start from zero in memory and the
    // SQL increments keep the database right. Logged with the table names so
    // an unapplied migration 005 is obvious.
    console.error('[perf] could not load public.user_stats / public.dragy_pbs: ' + (e && e.message) + ' (is server/migrations/005_perf_stats.sql applied?)');
  }
}

/* ================= helpers over ctx ================= */
function holds(c) { return !!(c && c.packs && c.packs.has(ID)); }
function send(c, msg) { if (c && holds(c)) ctx.send(c, msg); }
function err(c, msg) { send(c, { t: 'perf:err', msg }); }
function riderName(c) {
  try { return ctx.riderName ? ctx.riderName(c) : ((c.profile && c.profile.name) || 'Rider'); }
  catch (e) { return 'Rider'; }
}
function blocked(a, b) { try { return !!(ctx.blockedPair && ctx.blockedPair(a, b)); } catch (e) { return false; } }
function gated(c) { try { return !!(ctx.gated && ctx.gated(c)); } catch (e) { return false; } }
function nearbyMetres() { return (Number(ctx.NEARBY_KM) > 0 ? Number(ctx.NEARBY_KM) : 30) * 1000; }
function dist(a, b) { return ctx.B && ctx.B.haversine ? ctx.B.haversine(a, b) : Infinity; }

// Fan a stats update (new dragy PB) to every client currently scoping this
// rider, so open profile views update live. Only to sockets holding the pack;
// built per recipient because a viewer who has not confirmed their email gets
// no stats at all (the same gate riderRecord() applies to names).
function fanoutStat(c, s) {
  const msg = { t: 'perf:dragy:pb', id: c.id, stats: s };
  const hidden = { t: 'perf:dragy:pb', id: c.id, stats: null };
  for (const other of ctx.clients.values()) {
    if (other === c || !holds(other)) continue;
    if (other.known && other.known.has(c.id)) send(other, gated(other) ? hidden : msg);
  }
}

/* ================= races =================
   Open ad-hoc drag-race lobby (NOT convoy-gated). Any nearby rider can create /
   join. A race is proximity-scoped at join (B.haversine ≤ NEARBY_KM) so two
   riders out of range can't race. Auto-cleans up on finish, abandon, or host
   disconnect. */
const races = new Map();     // raceId -> race
const raceOf = new Map();    // client id -> raceId (the old c.raceId, kept out of the core's record)

function raceLite(r, id) {
  const c = ctx.clients.get(id);
  if (!c) return null;
  const res = r.results[id];
  const p = c.profile || {};
  return {
    id: c.id, name: riderName(c),
    emoji: p.emoji, paint: p.car && p.car.paint,
    ready: !!r.ready[id],
    finished: !!res,
    time: res ? res.time : null,
    trap: res ? res.trap : null,
    dnf: res ? !!res.dnf : false
  };
}
function sendRaceState(race) {
  const members = race.members.map((id) => raceLite(race, id)).filter(Boolean);
  for (const id of race.members) {
    const c = ctx.clients.get(id);
    if (!c) continue;
    send(c, {
      t: 'perf:race:state',
      race: {
        id: race.id, modeId: race.modeId, host: race.host,
        status: race.status, startedAt: race.startedAt,
        isHost: race.host === c.id,
        members
      }
    });
  }
}
// True once every member has a result (a finish or a DNF).
function raceFinished(race) {
  for (const id of race.members) if (!race.results[id]) return false;
  return true;
}
function later(fn, ms) {
  const t = ctx.defer ? ctx.defer(fn, ms) : setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}
// Resolve a race: mark anyone without a finish as DNF, credit the winner, broadcast.
function endRace(race) {
  if (race.status === 'finished') return;
  /* A race that never reached the green light was never raced.

     There are three statuses — 'lobby', 'countdown', 'running' — and only the
     last one means anybody actually drove: clients arm their timer on 'running'.
     Ending before that used to do two wrong things at once. It DNF'd every
     member and counted the run, so creating a race and cancelling it (nobody
     stages, host changes their mind, host leaves during the 3s countdown) put a
     loss on everyone's record for something that never happened. And it flipped
     the race to 'finished', so the clients drew a results screen for a race with
     no results in it.

     Abandoning is the honest outcome for both: tear it down, record nothing,
     show nobody a leaderboard. Handled here rather than at each call site so
     every path into endRace gets it — the host leaving, the early-end button,
     and the last racer walking out. */
  if (race.status !== 'running') {
    abandonRace(race, 'Race cancelled before it started — nothing recorded');
    return;
  }
  race.status = 'finished';
  // Mark no-shows as DNF. A DNF is still a race entered, so it counts as a run —
  // otherwise the denominator behind the win rate only ever includes finishers.
  for (const id of race.members) {
    if (race.results[id]) continue;
    race.results[id] = { time: null, trap: null, dnf: true };
    const dc = ctx.clients.get(id);
    if (dc && dc.userId) fanoutStat(dc, recordRun(dc.userId));
  }
  // Fastest legal time wins. Tally a win on the winner's user record.
  let winnerId = null, bestTime = Infinity;
  for (const id of race.members) {
    const r = race.results[id];
    if (r && !r.dnf && r.time != null && r.time < bestTime) { bestTime = r.time; winnerId = id; }
  }
  if (winnerId) {
    const wc = ctx.clients.get(winnerId);
    if (wc && wc.userId) { const s = recordWin(wc.userId); fanoutStat(wc, s); send(wc, { t: 'perf:stats', id: 'self', stats: s }); }
  }
  // Everyone's own counters moved: tell each racer so their profile page agrees.
  for (const id of race.members) {
    const mc = ctx.clients.get(id);
    if (mc && mc.userId && mc.id !== winnerId) send(mc, { t: 'perf:stats', id: 'self', stats: getStats(mc.userId) });
  }
  sendRaceState(race);
  // Tear down after a short grace so clients can render the final leaderboard.
  const id = race.id;
  later(() => dropRace(id), RACE_TEARDOWN_MS);
}
function dropRace(id) {
  const r = races.get(id);
  if (!r) return;
  for (const mid of r.members) if (raceOf.get(mid) === id) raceOf.delete(mid);
  races.delete(id);
}
/* Tear a race down with no result for anyone.

   Distinct from endRace, which resolves a race: it DNFs whoever has not finished
   and counts the run, because they entered a race and it ran. Abandoning is for
   when the race stops being a race through nobody's fault — a cancel before the
   green light, or a lobby nobody ever started. Recording a loss against anyone
   for that would charge a rider for a decision that was not theirs. */
function abandonRace(race, reason) {
  if (!race) return;
  for (const id of race.members) {
    raceOf.delete(id);
    const mc = ctx.clients.get(id);
    if (!mc) continue;
    send(mc, { t: 'perf:race:state', race: null });
    if (reason) err(mc, reason);
  }
  race.members.length = 0;
  races.delete(race.id);
}

// A racer leaves (or disconnects). DNF them if the race is running; if the host
// leaves mid-race, the race ends. `silent` suppresses the re-broadcast (used
// when the rider is mid-join into another race).
function leaveRace(c, silent) {
  const rid = raceOf.get(c.id);
  raceOf.delete(c.id);
  const race = rid && races.get(rid);
  if (!race) return;
  const i = race.members.indexOf(c.id);
  if (i >= 0) race.members.splice(i, 1);
  delete race.ready[c.id];
  // If they finished already, keep their result; otherwise DNF them so the race
  // can still resolve (only meaningful while running).
  if (race.status === 'running' && !race.results[c.id]) {
    race.results[c.id] = { time: null, trap: null, dnf: true };
    // Bailing out mid-race is still a race entered — count the run so the win
    // rate isn't computed against finishers only.
    if (c.userId) { const s = recordRun(c.userId); fanoutStat(c, s); send(c, { t: 'perf:stats', id: 'self', stats: s }); }
  }
  const humanLeft = race.members.filter((id) => ctx.clients.has(id));
  if (!humanLeft.length) { dropRace(race.id); return; }
  // Host left mid-lobby → promote the next racer; mid-race → end the race.
  if (race.host === c.id) {
    if (race.status === 'lobby') { race.host = humanLeft[0]; }
    else { endRace(race); return; }
  }
  if (!silent) sendRaceState(race);
  if (raceFinished(race)) endRace(race);
}

// Nothing in memory outlives its use: lobbies nobody started, runs nobody
// finished, racers whose socket went without a close, stats of deleted accounts.
function sweep() {
  const now = Date.now();
  for (const race of [...races.values()]) {
    const alive = race.members.filter((id) => ctx.clients.has(id));
    if (!alive.length) { dropRace(race.id); continue; }
    if (race.status === 'lobby' && now - race.createdAt > RACE_LOBBY_TTL_MS) abandonRace(race, 'Race lobby expired');
    else if (race.status === 'running' && now - race.startedAt > RACE_RUN_TTL_MS) endRace(race);
    else if (race.status === 'finished' && now - race.startedAt > RACE_RUN_TTL_MS + RACE_TEARDOWN_MS) dropRace(race.id);
  }
  for (const [cid, rid] of raceOf) if (!races.has(rid) || !ctx.clients.has(cid)) raceOf.delete(cid);
  if (ctx.store && typeof ctx.store.getById === 'function') {
    for (const id of [...stats.keys()]) {
      let gone = false;
      try { gone = !ctx.store.getById(id); } catch (e) { gone = false; }
      if (gone) stats.delete(id);
    }
  }
}

/* ================= validation ================= */
function pbInput(m) {
  const modeId = str(m && m.modeId, 16, '');
  if (DRAGY_MODES.indexOf(modeId) < 0) return null;
  const time = Number(m && m.time);
  const trap = m && m.trap != null ? Number(m.trap) : null;
  if (!Number.isFinite(time) || time <= 0 || time > 600) return null;
  if (trap != null && (!Number.isFinite(trap) || trap < 0 || trap > 250)) return null;
  return { modeId, time, trap };
}

/* ================= the half ================= */
module.exports = {
  id: ID,

  init(c) {
    ctx = c;
    loadStats();
    const t = setInterval(() => { try { sweep(); } catch (e) { console.error('[perf] sweep', e && e.message); } }, SWEEP_MS);
    if (t && typeof t.unref === 'function') t.unref();
  },

  routes: [
    // The account's own dragy PBs + race counters, for the profile page. (The
    // old POST /api/dragy/pb upload is the 'perf:dragy:pb' socket message now:
    // a pack route cannot read a request body — see the header.)
    ['GET', /^\/api\/perf\/dragy\/pb$/, async (req, res, m, user, c) => {
      const ip = c.clientIp ? c.clientIp(req) : 'unknown';
      if (!c.rateOk('perf:pbget:' + ip, 60, 60 * 1000)) return c.json(res, 429, { error: 'Too many requests — slow down' });
      return c.json(res, 200, { ok: true, stats: getStats(user.id), loaded: statsLoaded });
    }]
  ],

  ws: {
    // A rider set a new dragy personal best. Auth'd riders only — guests have no
    // server-side stats. Echoes the authoritative stats to the sender and fans
    // the PB out to everyone scoping them.
    'perf:dragy:pb'(c, m) {
      if (!c.userId) return;
      // Every accepted update can queue a DB write + fan out to viewers, so it
      // must not be spinnable.
      if (!ctx.rateOk('perf:wspb:' + c.ip, 30, 60 * 1000)) return;
      const v = pbInput(m);
      if (!v) return;
      const s = recordPB(c.userId, v.modeId, v.time, v.trap);
      send(c, { t: 'perf:stats', id: 'self', stats: s });
      fanoutStat(c, s);
    },

    // A profile opened on a rider we have nothing for: answer their stats
    // (null for a guest, or for a viewer who has not confirmed their email).
    'perf:stats:get'(c, m) {
      if (!ctx.rateOk('perf:statsget:' + c.id, 60, 60 * 1000)) return;
      const id = str(m && m.id, 40, '');
      if (!id) return;
      const target = ctx.getRider(id);
      if (!target || target.bot) { send(c, { t: 'perf:stats', id, stats: null }); return; }
      if (blocked(c, target)) return;    // silently, like every other cross-block frame
      const s = target.userId && !gated(c) ? getStats(target.userId) : null;
      send(c, { t: 'perf:stats', id, stats: s });
    },

    /* ----- drag races (open lobby, any nearby rider) ----- */
    'perf:race:create'(c, m) {
      if (!ctx.rateOk('perf:racectl:' + c.id, 30, 60 * 1000)) return;
      if (!c.pos) return err(c, 'Set your location first');
      const modeId = str(m && m.modeId, 16, '');
      if (DRAGY_MODES.indexOf(modeId) < 0) return err(c, 'Pick a race type');
      if (raceOf.has(c.id)) leaveRace(c, true); // one race at a time
      const race = {
        id: 'r' + crypto.randomBytes(4).toString('hex'),
        modeId,
        host: c.id,
        status: 'lobby',           // lobby | countdown | running | finished
        startedAt: 0,
        members: [c.id],           // rider ids
        ready: {},                 // id -> bool
        results: {},               // id -> { time, trap, dnf }  (filled on finish)
        createdAt: Date.now()
      };
      races.set(race.id, race);
      raceOf.set(c.id, race.id);
      race.ready[c.id] = false;
      sendRaceState(race);
    },

    'perf:race:join'(c, m) {
      if (!ctx.rateOk('perf:racectl:' + c.id, 30, 60 * 1000)) return;
      if (!c.pos) return err(c, 'Set your location first');
      const race = races.get(str(m && m.id, 40));
      if (!race) return err(c, 'That race is gone');
      if (race.status !== 'lobby') return err(c, 'Race already started');
      if (race.members.indexOf(c.id) >= 0) { sendRaceState(race); return; }
      if (race.members.length >= RACE_MAX) return err(c, 'Race is full');
      // Proximity gate: only nearby riders can join.
      const host = ctx.getRider(race.host);
      if (!host || !host.pos || dist(c.pos, host.pos) > nearbyMetres()) {
        return err(c, 'Too far to race — move closer to the host');
      }
      // Refuse the pairing outright rather than letting them in and quietly
      // withholding the position stream: a race where one entrant is invisible to
      // another is a broken race, and neither of them would know why. Better to
      // never start it. The wording names no one, so it does not confirm who.
      for (const mid of race.members) {
        if (blocked(c, ctx.getRider(mid))) return err(c, 'You can\'t join this race');
      }
      if (raceOf.has(c.id)) leaveRace(c, true);
      race.members.push(c.id);
      race.ready[c.id] = false;
      raceOf.set(c.id, race.id);
      sendRaceState(race);
    },

    'perf:race:ready'(c, m) {
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.status !== 'lobby') return;
      // Each flip re-broadcasts state to every member; throttle to UI toggle
      // cadence so it can't be spun as an amplification flood.
      if (!ctx.rateOk('perf:ready:' + c.id, 1, 500)) return;
      race.ready[c.id] = !!(m && m.on);
      sendRaceState(race);
    },

    // Host starts the race. Server mints startedAt and broadcasts a countdown;
    // everyone arms their own RaceTimer from their real GPS. A 3s countdown gives
    // racers a fair synchronized launch (everyone goes green together).
    'perf:race:start'(c) {
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.host !== c.id) return;
      if (race.status !== 'lobby') return;
      if (race.members.length < 2) return err(c, 'Need at least 2 racers');
      race.status = 'countdown';
      race.startedAt = Date.now() + RACE_COUNTDOWN_MS; // green light
      sendRaceState(race);
      // Flip to running at green. Each racer's client arms on 'running'.
      const id = race.id;
      later(() => {
        const r = races.get(id);
        if (!r || r.status !== 'countdown') return;
        r.status = 'running';
        sendRaceState(r);
      }, RACE_COUNTDOWN_MS);
    },

    // Live GPS relay during a race (~10Hz, only while running). Bounded + rate-
    // limited so it can't be abused out of a race.
    'perf:race:fix'(c, m) {
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.status !== 'running') return;
      if (!ctx.rateOk('perf:fix:' + c.id, RACE_FIX_BUDGET, 60 * 1000) ||
          !ctx.rateOk('perf:fixip:' + c.ip, RACE_FIX_IP_BUDGET, 60 * 1000)) return;
      const pos = [m && m.lng, m && m.lat];
      if (!ctx.validPos(pos)) return;
      const payload = {
        t: 'perf:race:fix', from: c.id,
        lng: m.lng, lat: m.lat,
        speed: ctx.num(m && m.speed, 0, 250, null),   // m/s, may be null
        heading: ctx.num(m && m.heading, 0, 360, null),
        acc: ctx.num(m && m.acc, 0, 5000, null),
        // Coerce: m.ts arrives unvalidated and is relayed verbatim — a non-number
        // (object/array) would ride the 64KB frame out to every race peer.
        ts: Number.isFinite(Number(m && m.ts)) ? Number(m.ts) : Date.now()
      };
      for (const id of race.members) {
        if (id === c.id) continue;
        const tc = ctx.clients.get(id);
        if (!tc) continue;
        // race:fix is a continuous stream of live lat/lng/speed/heading — the most
        // sensitive frame the server sends. Joining a race must not become a way
        // around a block, and a block made MID-race has to stop the stream on the
        // very next fix rather than at the end of the race.
        if (blocked(c, tc)) continue;
        send(tc, payload);
      }
    },

    // A racer finished (their local RaceTimer crossed the target). Server records
    // the result; when everyone's in, the race ends and results are broadcast.
    'perf:race:finish'(c, m) {
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.status !== 'running') return;
      if (race.results[c.id]) return; // already finished
      const time = Number(m && m.time);
      const trap = m && m.trap != null ? Number(m.trap) : null;
      if (!Number.isFinite(time) || time <= 0 || time > 600) return;
      race.results[c.id] = { time, trap: trap != null && Number.isFinite(trap) && trap >= 0 && trap <= 250 ? trap : null, dnf: false };
      // Tally a race stat on the user record (auth'd riders only) + a win for the
      // fastest finisher once the race resolves.
      if (c.userId) fanoutStat(c, recordRun(c.userId));
      sendRaceState(race);
      if (raceFinished(race)) endRace(race);
    },

    'perf:race:leave'(c) {
      if (raceOf.has(c.id)) leaveRace(c, false);
    },

    // Host invited a specific rider to their race (from the profile "Challenge"
    // button). Relay an invite toast to that rider with the race id so they can
    // join. Validates the sender actually owns the race + the target is nearby,
    // and that the target holds the pack (an invite to someone who cannot race
    // is dropped — their app has nothing to show it with).
    'perf:race:invite'(c, m) {
      if (!ctx.rateOk('perf:invite:' + c.id, 20, 60 * 1000)) return;
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.host !== c.id) return;
      const target = ctx.getRider(str(m && m.to, 40));
      if (!target || target.bot || !target.pos || !c.pos || target.id === c.id) return;
      // Silently dropped, like party:invite — a distinct refusal would confirm the
      // block to the sender.
      if (blocked(c, target)) return;
      if (dist(c.pos, target.pos) > nearbyMetres()) {
        return err(c, 'Too far to challenge — move closer');
      }
      if (!holds(target)) return err(c, 'That rider can\'t race yet');
      send(target, {
        t: 'perf:race:invite',
        from: c.id, fromName: riderName(c),
        raceId: race.id, modeId: race.modeId
      });
    },

    'perf:race:end'(c) {
      // Host can end a not-yet-finished race early (e.g. someone won't stage).
      const race = raceOf.has(c.id) && races.get(raceOf.get(c.id));
      if (!race || race.host !== c.id) return;
      endRace(race);
    }
  },

  // The socket just said hello and holds the pack: hand the account its own
  // stats so the profile page is right without a round trip.
  onHello(c) {
    if (c && c.userId) send(c, { t: 'perf:stats', id: 'self', stats: getStats(c.userId) });
  },
  // It is gone (runs before the core drops it from `clients`, as the old
  // close hook's leaveRace did). A race is 10–20 s long and endRace /
  // abandonRace have ledger side effects, so a seat is never held.
  onClose(c) {
    if (c && raceOf.has(c.id)) leaveRace(c, false);
  },

  // test surface
  _state: () => ({ races, raceOf, stats }),
  _reset: () => { races.clear(); raceOf.clear(); stats.clear(); statsLoaded = false; },
  _sweep: sweep,
  _constants: { DRAGY_MODES, RACE_MAX, RACE_FIX_BUDGET, RACE_FIX_IP_BUDGET, RACE_COUNTDOWN_MS, RACE_TEARDOWN_MS }
};
