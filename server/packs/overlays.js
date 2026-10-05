/* Convoy — overlays pack, server half.
   Restored from server/server.js + server/tomtom.js (pre-cut tree a1de6fd):
     GET  /api/overlays/caps                      what this server can serve
     POST /api/overlays/incidents {bottomLeft, topRight}  TomTom incidents → pins
     GET  /api/overlays/traffic/<z>/<x>/<y>.png   TomTom flow tile (binary; the
          URL carries the pack's signed file token — a raster tile cannot carry
          a bearer — checked against the grant on every tile)
     ws   overlays:report {lat, lng, kind, label} → 'overlays:hazard' to riders
          within NEARBY_KM who hold the pack and are not in a block pair with
          the reporter. Reports are live-only (nothing is persisted): a hazard
          pin is a thing you saw, not a record.
   Every route is reached only by an account holding the pack (the registry
   enforces that); the limits below are the old ones, on the shared rateOk
   buckets. */
'use strict';
const extras = require('./overlays/tomtom-extras');

const ID = 'overlays';
const REPORT_MAX_M = parseInt(process.env.REPORT_MAX_M || '8000', 10);
// What a rider may report. 'police' is the enforcement pack's ('enforcement:report').
const REPORT_KINDS = ['accident', 'stopped', 'debris', 'hazard', 'ice', 'snow', 'fog', 'rain', 'wind', 'flood', 'closure'];

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function isLngLat(p) {
  return Array.isArray(p) && p.length === 2 && num(p[0]) !== null && num(p[1]) !== null &&
    Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

async function capsRoute(req, res, m, user, ctx) {
  const key = extras.hasKey();
  ctx.json(res, 200, { traffic: key, incidents: key });
}

async function incidentsRoute(req, res, m, user, ctx, body) {
  const ip = ctx.clientIp(req);
  if (!ctx.rateOk('ovl-inc:' + ip, 30, 60 * 1000)) return ctx.json(res, 429, { error: 'Too many requests — slow down' });
  const bl = body && body.bottomLeft, tr = body && body.topRight;
  if (!isLngLat(bl) || !isLngLat(tr) || bl[0] > tr[0] || bl[1] > tr[1]) return ctx.json(res, 400, { error: 'bad bbox' });
  if (!extras.hasKey()) return ctx.json(res, 503, { error: 'Incidents key not configured' });
  await new Promise((resolve) => {
    extras.incidents(bl[0], bl[1], tr[0], tr[1], (err, status, fc) => {
      if (err) ctx.json(res, 502, { error: 'Incidents service unavailable' });
      else ctx.json(res, 200, fc);
      resolve();
    });
  });
}

async function tileRoute(req, res, m, user, ctx) {
  // Bounds-check BEFORE spending quota: x,y must be < 2^z; z > 22 does not exist.
  const tz = +m[1], tx = +m[2], ty = +m[3];
  if (tz > 22 || tx >= (1 << tz) || ty >= (1 << tz)) { res.writeHead(400); res.end('bad tile'); return; }
  const ip = ctx.clientIp(req);
  if (!extras.hasKey()) { res.writeHead(503); res.end('traffic unavailable'); return; }
  if (!ctx.rateOk('ovl-tile:' + ip, 300, 60 * 1000)) { res.writeHead(429); res.end('rate limited'); return; }
  await new Promise((resolve) => {
    extras.tile(m[1], m[2], m[3], (err, status, headers, buf) => {
      if (res.writableEnded || res.destroyed) return resolve();
      if (err || !buf || status !== 200) { res.writeHead(502); res.end('upstream'); return resolve(); }
      res.writeHead(200, Object.assign({
        'Content-Type': headers['Content-Type'] || 'image/png',
        // Matches the client's 90 s refresh so a cache-busted URL reaches TomTom fresh.
        'Cache-Control': 'private, max-age=90'
      }, ctx.CORS_HEADERS));
      res.end(req.method === 'HEAD' ? undefined : buf);
      resolve();
    });
  });
}

function report(c, m, ctx) {
  const lat = num(m && m.lat), lng = num(m && m.lng);
  if (lat === null || lng === null) return;
  const pos = [lng, lat];
  if (!ctx.validPos(pos)) return;
  // You can only report what you can see: the pin has to be near where you are.
  if (!c.pos || ctx.B.haversine(c.pos, pos) > REPORT_MAX_M) {
    return ctx.send(c, { t: 'err', msg: 'You can only report what’s near you' });
  }
  if (!ctx.rateOk('ovl-report:' + c.ip, 20, 60 * 1000)) return ctx.send(c, { t: 'err', msg: 'Too many reports — slow down' });
  const kind = typeof m.kind === 'string' && REPORT_KINDS.indexOf(m.kind) >= 0 ? m.kind : 'hazard';
  const label = ctx.cleanText(typeof m.label === 'string' ? m.label : '', 48, '');
  const payload = { t: 'overlays:hazard', from: ctx.liteOf(c), by: c.id, lat, lng, kind, label };
  const radius = ctx.NEARBY_KM * 1000;
  for (const other of ctx.clients.values()) {
    if (!other.pos || other.id === c.id || !other.packs || !other.packs.has(ID)) continue;
    if (ctx.blockedPair(c, other)) continue;   // the pin carries the reporter's identity
    if (ctx.B.haversine(pos, other.pos) <= radius) ctx.send(other, payload);
  }
}

module.exports = {
  id: ID,
  routes: [
    ['GET', /^\/api\/overlays\/caps$/, capsRoute],
    ['POST', /^\/api\/overlays\/incidents$/, incidentsRoute],
    ['GET', /^\/api\/overlays\/traffic\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/, tileRoute, { auth: 'token' }]
  ],
  ws: { 'overlays:report': report },
  REPORT_MAX_M, REPORT_KINDS
};
