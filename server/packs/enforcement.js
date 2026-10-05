/* Convoy — enforcement pack: the server half.

   Everything the pre-cut server did for the enforcement feature, reachable
   only for an account that holds the pack (server/packs/index.js gates every
   route on a bearer + grant and every socket handler on c.packs):

     POST /api/enforcement/caps          what this server can serve the pack
     POST /api/enforcement/aircraft      live aircraft (OpenSky, cached per cell)
     POST /api/enforcement/overpass      OpenStreetMap lookups by KIND (never a query)
     POST /api/enforcement/waze          live police: Waze if keyed + the collector's
                                         findings + riders' reports, recorded into
                                         the hotspot model
     POST /api/enforcement/hotspots      "usually here" probability pins per hour
     POST /api/enforcement/agent/status  live counts, for an operator debugging a feed

     ws 'enforcement:report'             a rider reports police at their position:
                                         validated, proximity-gated, rate-limited,
                                         fed into the model and the live store,
                                         fanned out to nearby holders of the pack

   WHAT MOVED. The old routes were /api/aircraft, /api/overpass, /api/waze,
   /api/hotspots, /api/agent/status and /api/agent/update; the old socket
   message was the police branch of 'crowd:report' (hazard reports belong to
   the overlays pack). /api/agent/update is GONE — see enforcement/agent.js:
   the collectors feed the model in-process (ENFORCEMENT_COLLECTOR) or through
   a local inbox directory (ENFORCEMENT_INBOX_DIR), never over HTTP.

   PARAMETERS RIDE THE QUERY STRING. Pack routes are dispatched inside the
   core's POST handler, after the core's readBody has consumed the request
   body, and the route signature carries no body — so every route here reads
   ?minLat=…&minLng=…&maxLat=…&maxLng=… (and kind=, hour=) off req.url. The
   client helper (packs/enforcement/ghost.js api()) does the same on its side.

   Rate limits ride ctx.rateOk (the shared per-IP buckets); persistence rides
   ctx.db.query (migration 007_enforcement.sql); nothing here requires the
   core server or the store's internals. */
'use strict';

const path = require('path');
const aircraft = require('./enforcement/aircraft');
const overpass = require('./enforcement/overpass');
const waze = require('./enforcement/waze');
const hotspots = require('./enforcement/hotspots');
const agent = require('./enforcement/agent');

const ID = 'enforcement';
// How far from your own position you may report police. Generous enough for
// "police a couple of exits up", tight enough that the hotspot model can't be
// seeded from the other side of the planet.
const REPORT_MAX_M = parseInt(process.env.REPORT_MAX_M || '8000', 10);
const INBOX_SCAN_MS = parseInt(process.env.ENFORCEMENT_INBOX_SCAN_MS || '30000', 10);
const MAX_SPAN_DEG = 12;   // the live-police and hotspot routes refuse absurd boxes

let collectors = [];
let inboxDir = null;

/* ---------------- request parsing ---------------- */
// The query string of req.url as a plain object (first value wins). A
// malformed percent-escape is a bad request, not a crash: it yields {}.
function qs(req) {
  const u = String((req && req.url) || '');
  const i = u.indexOf('?');
  const out = {};
  if (i < 0) return out;
  try {
    for (const kv of u.slice(i + 1).split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = decodeURIComponent(eq < 0 ? kv : kv.slice(0, eq));
      const v = eq < 0 ? '' : decodeURIComponent(kv.slice(eq + 1));
      if (k && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    }
  } catch (e) { return {}; }
  return out;
}
// Numeric STRINGS only — '' and non-numbers are NaN, never coerced to 0.
function num(v) {
  if (typeof v !== 'string' || !v.trim()) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
// The four corners, or null. Range and span checks are the modules' own
// (aircraft.validBbox, overpass.parseBbox) or inRange() below.
function bboxOf(q) {
  const b = { minLat: num(q.minLat), minLng: num(q.minLng), maxLat: num(q.maxLat), maxLng: num(q.maxLng) };
  for (const k in b) if (!Number.isFinite(b[k])) return null;
  return b;
}
function inRange(b) {
  return !!b && b.minLat >= -90 && b.maxLat <= 90 && b.minLng >= -180 && b.maxLng <= 180 &&
    b.minLat < b.maxLat && b.minLng < b.maxLng &&
    (b.maxLat - b.minLat) <= MAX_SPAN_DEG && (b.maxLng - b.minLng) <= MAX_SPAN_DEG;
}
function ipOf(req, ctx) {
  try { return ctx && ctx.clientIp ? ctx.clientIp(req) : ((req.socket && req.socket.remoteAddress) || '?'); }
  catch (e) { return '?'; }
}
// A kill switch per upstream on the control panel's Flags board, like the
// pre-cut caps probe had: env/key state is the default, the panel can force it.
function pick(ctx, name, dflt) {
  try { return ctx && ctx.flags && typeof ctx.flags.pick === 'function' ? !!ctx.flags.pick(name, dflt) : dflt; }
  catch (e) { return dflt; }
}
function fc(features, extra) { return Object.assign({ type: 'FeatureCollection', features: features }, extra || {}); }

/* ---------------- routes ---------------- */
const routes = [
  // What this server can serve the pack. `waze` here means "a live-police
  // feed exists" — the licensed upstream, the collectors or riders' reports —
  // so the client knows whether polling /waze has a point; `wazeKey` says
  // whether the licensed upstream itself is configured.
  ['POST', /^\/api\/enforcement\/caps$/, async (req, res, m, user, ctx) => {
    return ctx.json(res, 200, {
      waze: pick(ctx, 'waze', true),
      wazeKey: waze.hasKey(),
      hotspots: pick(ctx, 'hotspots', true),
      aircraft: pick(ctx, 'aircraft', true),
      overpass: pick(ctx, 'overpass', true)
    });
  }],

  // Live aircraft. A proxy because it HAS to be: OpenSky refuses cross-origin
  // browser reads, and one upstream poll per deployment is what its anonymous
  // budget expects. The client treats any failure as "skip this poll".
  ['POST', /^\/api\/enforcement\/aircraft$/, async (req, res, m, user, ctx) => {
    if (!ctx.rateOk('enf-aircraft:' + ipOf(req, ctx), 40, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
    if (!pick(ctx, 'aircraft', true)) return ctx.json(res, 503, { error: 'Aircraft feed is switched off' });
    const r = await aircraft.states(bboxOf(qs(req)));
    if (r.error === 'bad-bbox') return ctx.json(res, 400, { error: 'Bad bounding box' });
    if (r.error === 'rate-limited') return ctx.json(res, 429, { error: 'Aircraft feed is busy' });
    if (r.error) return ctx.json(res, 502, { error: 'Aircraft data is unavailable right now' });
    return ctx.json(res, 200, { aircraft: r.rows, cached: !!r.cached, stale: !!r.stale });
  }],

  // OpenStreetMap lookups (police stations, speed cameras, ALPR, stops,
  // signals). The caller picks a KIND, never a query — see enforcement/overpass.js.
  ['POST', /^\/api\/enforcement\/overpass$/, async (req, res, m, user, ctx) => {
    if (!ctx.rateOk('enf-overpass:' + ipOf(req, ctx), 30, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
    if (!pick(ctx, 'overpass', true)) return ctx.json(res, 503, { error: 'Map data lookups are switched off' });
    const q = qs(req);
    const kind = String(q.kind || '');
    if (!overpass.hasKind(kind)) return ctx.json(res, 400, { error: 'Unknown lookup' });
    const r = await overpass.query(kind, bboxOf(q));
    if (r.error === 'bad-bbox') return ctx.json(res, 400, { error: 'Bad bounding box' });
    // 502, not 500: upstream is down or busy, and the client already treats a
    // failure here as "skip this layer" rather than as an error to show.
    if (r.error) return ctx.json(res, 502, { error: 'Map data is unavailable right now' });
    return ctx.json(res, 200, r.body);
  }],

  // Live police sightings: the licensed Waze feed (if keyed) merged with the
  // in-memory live store (collector findings, riders' reports). Every Waze
  // police alert becomes a hotspot observation on the way through.
  ['POST', /^\/api\/enforcement\/waze$/, async (req, res, m, user, ctx) => {
    if (!ctx.rateOk('enf-waze:' + ipOf(req, ctx), 30, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
    const b = bboxOf(qs(req));
    if (!inRange(b)) return ctx.json(res, 400, { error: 'Bad bounding box' });
    const bl = [b.minLng, b.minLat], tr = [b.maxLng, b.maxLat];
    const local = agent.policeFeatures(bl, tr);
    // Killed on the Flags board, or no key: the quota-free local store alone.
    if (!pick(ctx, 'waze', true) || !waze.hasKey()) return ctx.json(res, 200, fc(local, { upstream: false }));
    const r = await new Promise((resolve) => {
      try { waze.alerts(bl, tr, (err, status, body) => resolve({ err, status, body })); }
      catch (e) { resolve({ err: e }); }
    });
    if (r.err) {
      // Surface upstream rate-limiting as 429 so the client backs off — unless
      // the local store has sightings for this view: those are quota-free, so
      // serving them beats an empty error.
      if (local.length) return ctx.json(res, 200, fc(local, { upstream: false }));
      return ctx.json(res, r.status === 429 ? 429 : 502,
        { error: r.status === 429 ? 'Live feed rate limited — backing off' : 'Live feed unavailable' });
    }
    const body = r.body && Array.isArray(r.body.features) ? r.body : fc([]);
    const now = Date.now();
    for (const f of body.features) {
      if (f.properties && f.properties.kind === 'police' && f.geometry && f.geometry.coordinates) {
        hotspots.record(f.geometry.coordinates[0], f.geometry.coordinates[1], now);
      }
    }
    if (local.length) body.features = body.features.concat(local);
    return ctx.json(res, 200, body);
  }],

  // Police probability hotspots for a bbox + hour. The client passes its LOCAL
  // hour (police patterns are local); a missing or bad hour means "now".
  ['POST', /^\/api\/enforcement\/hotspots$/, async (req, res, m, user, ctx) => {
    if (!ctx.rateOk('enf-hotspots:' + ipOf(req, ctx), 30, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
    const q = qs(req);
    const b = bboxOf(q);
    if (!b || b.minLat < -90 || b.maxLat > 90 || b.minLng < -180 || b.maxLng > 180 || b.minLat >= b.maxLat || b.minLng >= b.maxLng) {
      return ctx.json(res, 400, { error: 'Bad bounding box' });
    }
    if (!pick(ctx, 'hotspots', true)) return ctx.json(res, 200, fc([]));
    let hour = Number(q.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = new Date().getHours();
    return ctx.json(res, 200, hotspots.query(b.minLng, b.minLat, b.maxLng, b.maxLat, hour));
  }],

  // Live item counts, for an operator debugging a collector. Holder-gated like
  // everything else here (the old X-Agent-Key probe is gone with the ingest).
  ['POST', /^\/api\/enforcement\/agent\/status$/, async (req, res, m, user, ctx) => {
    if (!ctx.rateOk('enf-status:' + ipOf(req, ctx), 20, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
    return ctx.json(res, 200, {
      ok: true,
      live: agent.counts(),
      hotspots: hotspots.status(),
      aircraft: aircraft.status(),
      overpass: overpass.stats(),
      wazeKey: waze.hasKey(),
      collectors: collectors.map((c) => c.name),
      inbox: inboxDir
    });
  }]
];

/* ---------------- socket ---------------- */
// A rider reports police at (or near) their own position. The live pin is
// ephemeral; the sighting is recorded into the probability model so recurring
// spots become hotspots. Coords are validated, the label sanitized, and the
// fan-out is SCOPED: riders within NEARBY_KM who hold this pack, minus anyone
// in a block pair with the reporter. The reporter's lite is attached so a
// client can drop its own echo (it drew the pin locally at report time).
function onReport(c, m, ctx) {
  if (!m || !c) return;
  const pos = [m.lng, m.lat];
  if (!ctx.validPos(pos)) return;
  // Proximity gate: you can only report what you can see, so the pin has to
  // be near where you actually are — otherwise one client could walk the
  // globe writing permanent observations into everyone's model.
  if (!c.pos || ctx.B.haversine(c.pos, pos) > REPORT_MAX_M) {
    return ctx.send(c, { t: 'err', msg: 'You can only report what’s near you' });
  }
  if (!ctx.rateOk('enf-report:' + c.ip, 20, 60 * 1000)) return ctx.send(c, { t: 'err', msg: 'Too many reports — slow down' });
  const label = ctx.cleanText(m.label, 48, 'Police sighting');
  hotspots.record(m.lng, m.lat, Date.now());
  agent.addReport(m.lng, m.lat, label, 30 * 60);
  const payload = { t: 'enforcement:report', from: ctx.liteOf(c), lat: m.lat, lng: m.lng, label };
  const radius = (ctx.NEARBY_KM || 30) * 1000;
  for (const other of ctx.clients.values()) {
    if (!other.pos || other.id === c.id) continue;
    if (!other.packs || typeof other.packs.has !== 'function' || !other.packs.has(ID)) continue;
    // The pin carries the reporter's identity (liteOf), so it is content from
    // them and a block applies to it like any other.
    if (typeof ctx.blockedPair === 'function' && ctx.blockedPair(c, other)) continue;
    if (ctx.B.haversine(pos, other.pos) <= radius) ctx.send(other, payload);
  }
}

/* ---------------- boot ---------------- */
function init(ctx) {
  // Persistence through the core's database, when there is one. The load is
  // awaited by nobody: the model answers from memory as rows arrive.
  let q = null;
  try {
    if (ctx && ctx.db && typeof ctx.db.query === 'function' && (typeof ctx.db.configured !== 'function' || ctx.db.configured())) {
      q = (text, params) => ctx.db.query(text, params);
    }
  } catch (e) { q = null; }
  hotspots.init({ query: q }).catch(() => {});

  // In-process collectors. '1' / 'all' runs both; 'finder' or 'waze' picks one.
  const mode = String(process.env.ENFORCEMENT_COLLECTOR || '0').trim().toLowerCase();
  if (mode && !/^(0|off|false|no)$/.test(mode)) {
    const sink = (items) => agent.ingest(items);
    try {
      if (/^(1|all|finder)$/.test(mode)) collectors.push(require('./enforcement/police-finder').start({ sink }));
      if (/^(1|all|waze)$/.test(mode)) collectors.push(require('./enforcement/collect-hotspots').start({ sink }));
      if (!collectors.length) console.warn('[enforcement] ENFORCEMENT_COLLECTOR=' + mode + ' is not one of 0|finder|waze|all');
    } catch (e) {
      console.error('[enforcement] collector failed to start:', e.message);
    }
  }
  // Standalone collectors drop batches here; opt-in so a server never grows a
  // directory it was not asked for.
  if (process.env.ENFORCEMENT_INBOX_DIR) {
    inboxDir = path.resolve(process.env.ENFORCEMENT_INBOX_DIR);
    agent.startInbox(inboxDir, INBOX_SCAN_MS);
  }
  console.log('[enforcement] ready — waze key: ' + (waze.hasKey() ? 'yes' : 'no') +
    ', collectors: ' + (collectors.length ? collectors.map((c) => c.name).join('+') : 'none') +
    ', inbox: ' + (inboxDir || 'off') + ', hotspots: ' + (q ? 'database' : 'memory only'));
}

module.exports = {
  id: ID,
  init,
  routes,
  ws: { 'enforcement:report': onReport },
  // test surface
  _qs: qs, _bboxOf: bboxOf, _inRange: inRange, _collectors: () => collectors,
  _stop: () => { collectors.forEach((c) => { try { c.stop(); } catch (e) { /* already */ } }); collectors = []; agent.stopInbox(); inboxDir = null; },
  REPORT_MAX_M
};
