/* Convoy — live aircraft proxy (OpenSky Network).

   ── Why this module exists ────────────────────────────────────────────────
   The aircraft layer used to fetch its two sources straight from the browser.
   Both of those calls are now impossible, for two different reasons, and the
   feature was dead in every deployment:

     OpenSky          answers 200 with real data to a SERVER, but sends
                      `Access-Control-Allow-Origin: https://opensky-network.org`
                      — it explicitly refuses cross-origin browser reads, so the
                      client fetch always failed CORS. Nothing in the app was
                      broken; the request never completed.

     airplanes.live   (the keyless ADS-B Exchange mirror) now answers 403 to
                      everyone, server included, with a message asking you to
                      email them for access. That source is simply closed.

   So the fix is architectural, not a patch: the server fetches, the client asks
   the server. That also matches how every other upstream in this app already
   works (overpass, tomtom, waze) and keeps upstream traffic to one poller per
   deployment instead of one per rider, which is what OpenSky's anonymous budget
   actually expects.

   ── What was lost with ADS-B Exchange ─────────────────────────────────────
   ADSBx carried `dbFlags` — an authoritative database bit for "military" — plus
   registration and aircraft type. OpenSky carries none of that. Ownership
   classification below is therefore HEURISTIC, driven by callsign patterns, and
   it says so: an aircraft it cannot place is reported as `unknown` rather than
   quietly called civilian. If a keyed ADS-B Exchange feed is ever added, that is
   where the authoritative flag comes back.

   OpenSky state vector (array indices used here):
     0 icao24  1 callsign  2 origin_country  3 time_position  4 last_contact
     5 longitude  6 latitude  7 baro_altitude(m)  8 on_ground
     9 velocity(m/s)  10 true_track(deg)  11 vertical_rate(m/s)
     13 geo_altitude(m)  14 squawk */
'use strict';

const OPENSKY = 'https://opensky-network.org/api/states/all';

/* Upstream pacing. OpenSky's anonymous feed updates on roughly a 10s cadence and
   rate-limits hard, so there is nothing to gain from asking faster. Every rider
   in a deployment shares one cached answer per cell. */
const CACHE_MS = 8000;          // serve a cell from cache for this long
const CELL_DEG = 0.5;           // bbox snap grid — riders near each other share a fetch
const UPSTREAM_TIMEOUT_MS = 12000;
const COOLDOWN_MS = 60 * 1000;  // pause upstream after a 429/403, like waze.js
const MAX_SPAN_DEG = 12;        // refuse absurd bboxes rather than ask for the planet

let rateLimitedUntil = 0;
let lastError = '';
const cache = new Map();        // cellKey -> { at, rows }

/* ---------------- ownership classification ----------------
   Five buckets, matching the map legend: military | police | ems | civilian |
   unknown. The only signal OpenSky gives us is the callsign, so this is a
   heuristic — and the important design decision is what it does when it is not
   sure.

   It answers `unknown`. That is not a cop-out bucket, it is most of the honest
   answer. Checked against a live sample of 811 aircraft over the US southwest,
   a naive "anything unrecognised is civilian" rule labelled tactical military
   callsigns — LOST25, BULET47, SCRCH52, JANET86, RDSTRM16 — as civilian traffic.
   Confidently wrong is worse than openly unsure on a layer whose whole purpose
   is telling a rider what is above them, so the rule is inverted:

     no callsign                     -> unknown   (~1% of live contacts)
     a known operator prefix         -> that bucket
     an airline flight number        -> civilian  (3-letter ICAO code + digits)
     an aircraft registration        -> civilian  (N-number and foreign tails)
     anything else                   -> unknown   (and the popup shows the raw
                                                   callsign so a rider can judge)

   The authoritative military flag used to come from ADS-B Exchange's `dbFlags`.
   That source now answers 403 to everyone, so there is no database bit to check
   any more — which is exactly why this leans on structure rather than pretending
   to more certainty than it has. */

// Standard air-arm and mission prefixes. RCH=Reach (US airlift), PAT=Priority
// Air Transport, SAM=Special Air Mission, ASCOT=RAF transport, RRR=RAF tanker.
const MIL_CS = /^(RCH|REACH|PAT\d|SAM\d|SPAR|NAVY|ARMY|AF\d|CNV|CONVOY|EVAC|POLO|DOOM|GRIM|SHELL|TANKER|VENUS|JEDI|KNIFE|HOIST|ASCOT|RRR|NATO|AWACS|MAGIC|BAF|GAF|IAM|CTM|SLAM|VADER|RAIDR|BOXER|TITAN|MAKO|VIPER|JANET)/i;

// Civil law enforcement. Deliberately narrow: these are the operator prefixes
// that actually fly under an identifying callsign.
const POLICE_CS = /^(POLICE|PD\d|LAPD|NYPD|CHP|DPS|SHERIFF|TROOPER|CBP|BORDER|FBI|USMS|MARSHAL|DEA|ATF|HSI|CUSTOMS|NPAS)/i;

// Air ambulance / medevac / search and rescue.
const EMS_CS = /^(LIFE|MEDIC|MEDEVAC|MERCY|ANGEL|AIRMED|AIRAMB|AMBULANCE|SURVIVAL|RESCUE|COASTGUARD|USCG|CG\d|HEMS|AIRLIFT|CAREFL|NIGHTINGALE|STARFL)/i;

// An airline flight number: an operator code of exactly two (IATA) or three
// (ICAO) letters, then 1–4 digits and an optional letter. UAL212, SWA1899, BC743.
// The letter count matters — it is what separates an operator code from a
// tactical callsign, which is a WORD of four or more letters plus a number.
const AIRLINE_CS = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/;

// An aircraft registration flying under its own tail number: a US N-number
// (N963PM) or an unhyphenated foreign tail (XBMQK, CGABC, DABCD).
// Deliberately does NOT allow a trailing number on a letter prefix — that shape
// is LOST25 / BULET47 / SCRCH52, and letting it through here is precisely how
// tactical military traffic ends up painted as civilian.
const REG_CS = /^(N\d{1,5}[A-Z]{0,2}|[A-Z]{4,6})$/;

function classify(callsign) {
  const cs = String(callsign || '').trim().toUpperCase();
  if (!cs) return 'unknown';
  if (MIL_CS.test(cs)) return 'military';
  if (POLICE_CS.test(cs)) return 'police';
  if (EMS_CS.test(cs)) return 'ems';
  if (AIRLINE_CS.test(cs)) return 'civilian';
  if (REG_CS.test(cs)) return 'civilian';
  // Structured like neither an airline nor a registration — most often a
  // tactical callsign. Say so instead of guessing.
  return 'unknown';
}

/* ---------------- bbox handling ---------------- */
function validBbox(b) {
  if (!b) return null;
  const minLat = Number(b.minLat), maxLat = Number(b.maxLat);
  const minLng = Number(b.minLng), maxLng = Number(b.maxLng);
  const nums = [minLat, maxLat, minLng, maxLng];
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
  if (maxLat <= minLat || maxLng <= minLng) return null;
  if (maxLat - minLat > MAX_SPAN_DEG || maxLng - minLng > MAX_SPAN_DEG) return null;
  return { minLat, maxLat, minLng, maxLng };
}

// Snap outward to a shared grid so two riders a mile apart hit the same cache
// entry instead of each opening their own upstream poll.
function cellFor(b) {
  const f = (n) => Math.floor(n / CELL_DEG) * CELL_DEG;
  const c = (n) => Math.ceil(n / CELL_DEG) * CELL_DEG;
  return {
    minLat: Math.max(-90, f(b.minLat)), maxLat: Math.min(90, c(b.maxLat)),
    minLng: Math.max(-180, f(b.minLng)), maxLng: Math.min(180, c(b.maxLng))
  };
}
function cellKey(c) {
  return [c.minLat, c.minLng, c.maxLat, c.maxLng].map((n) => n.toFixed(2)).join(',');
}

/* ---------------- normalization ---------------- */
function rowToAircraft(s) {
  const lon = s[5], lat = s[6];
  if (lat == null || lon == null) return null;
  const callsign = String(s[1] || '').trim();
  const lastContact = s[4];
  return {
    hex: String(s[0] || '').toLowerCase().trim(),
    callsign,
    country: s[2] || '',
    lat, lon,
    alt: s[7] != null ? s[7] : (s[13] != null ? s[13] : null),  // metres
    ground: !!s[8],
    speed: s[9] != null ? s[9] : null,                          // m/s
    heading: s[10] != null ? s[10] : null,                      // degrees
    vertRate: s[11] != null ? s[11] : null,                     // m/s
    squawk: s[14] || '',
    owner: classify(callsign),
    // Predictions on the client age from the real fix time, so a row that is
    // already a few seconds stale still extrapolates from when it was true.
    at: lastContact ? lastContact * 1000 : Date.now(),
    src: 'opensky'
  };
}

/* ---------------- upstream ---------------- */
async function fetchUpstream(c) {
  const url = OPENSKY +
    '?lamin=' + c.minLat.toFixed(3) + '&lomin=' + c.minLng.toFixed(3) +
    '&lamax=' + c.maxLat.toFixed(3) + '&lomax=' + c.maxLng.toFixed(3);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json' }
  });
  if (r.status === 429 || r.status === 403) {
    // Hammering a rate limit only deepens it. Back off for everyone.
    rateLimitedUntil = Date.now() + COOLDOWN_MS;
    throw Object.assign(new Error('opensky ' + r.status), { status: r.status });
  }
  if (!r.ok) throw Object.assign(new Error('opensky ' + r.status), { status: 502 });
  const j = await r.json();
  const states = (j && j.states) || [];
  const out = [];
  for (let i = 0; i < states.length; i++) {
    const a = rowToAircraft(states[i]);
    if (a) out.push(a);
  }
  return out;
}

/* Aircraft inside `bbox`. Resolves { rows, cached, stale } or an { error } shape;
   never throws at the caller, because a dead sky layer must not be an app error. */
async function states(bbox) {
  const b = validBbox(bbox);
  if (!b) return { error: 'bad-bbox' };

  const cell = cellFor(b);
  const key = cellKey(cell);
  const hit = cache.get(key);
  const fresh = hit && (Date.now() - hit.at) < CACHE_MS;

  if (fresh) return { rows: clip(hit.rows, b), cached: true, stale: false };

  if (Date.now() < rateLimitedUntil) {
    // Upstream is in cooldown. A slightly old sky beats an empty one.
    if (hit) return { rows: clip(hit.rows, b), cached: true, stale: true };
    return { error: 'rate-limited' };
  }

  try {
    const rows = await fetchUpstream(cell);
    cache.set(key, { at: Date.now(), rows });
    pruneCache();
    lastError = '';
    return { rows: clip(rows, b), cached: false, stale: false };
  } catch (e) {
    lastError = String(e && e.message || e);
    // Keep showing the last known sky rather than blinking every dot out on a
    // single upstream hiccup — the client treats a failure as "skip this poll".
    if (hit) return { rows: clip(hit.rows, b), cached: true, stale: true };
    return { error: e && e.status === 429 ? 'rate-limited' : 'upstream' };
  }
}

// The cache holds a snapped cell, which is larger than what was asked for.
function clip(rows, b) {
  return rows.filter((a) =>
    a.lat >= b.minLat && a.lat <= b.maxLat && a.lon >= b.minLng && a.lon <= b.maxLng);
}

// Bounded: a busy server should not accumulate every cell anyone ever looked at.
function pruneCache() {
  if (cache.size <= 64) return;
  const dead = Date.now() - (CACHE_MS * 4);
  for (const [k, v] of cache) if (v.at < dead) cache.delete(k);
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < oldest.length - 64; i++) cache.delete(oldest[i][0]);
  }
}

function status() {
  return {
    source: 'opensky',
    cells: cache.size,
    cooldown: Math.max(0, rateLimitedUntil - Date.now()),
    lastError
  };
}

// Test seam — the cooldown and cache are module state and otherwise unreachable.
function _reset() { cache.clear(); rateLimitedUntil = 0; lastError = ''; }

module.exports = {
  states, classify, validBbox, cellFor, cellKey, rowToAircraft, status, _reset,
  OWNERS: ['military', 'police', 'ems', 'civilian', 'unknown'],
  CACHE_MS, CELL_DEG, MAX_SPAN_DEG
};
