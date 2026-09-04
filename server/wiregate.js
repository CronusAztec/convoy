'use strict';

/* Per-viewer wire gate: decides whether a rider's row needs to go out on this
   tick to this particular viewer, and remembers what was last actually SENT
   so identical rows can be suppressed and distant riders can be rate-limited
   — all without changing the deployed tick protocol. `js/sim.js:139`'s
   remoteTick() is a pure upsert (`if (npc) setNext(npc, ...)`); it never
   treats a rider's absence from a tick as removal — that only happens via a
   `rider:remove` message (server/server.js's syncScope). Omitting a row from
   a tick is therefore already legal on every deployed client: this module
   just decides when to do it.

   Tunables, chosen from the RENDERING argument, not the test fixture's
   lattice (a fixture-fitted threshold is fitted to the fixture, not to
   production — see the cycle-11 improvement directive). js/mapview.js opens
   the map at zoom 13.4 (:103) and lands a locate-flight at zoom 16.5 (:1320,
   LOCATE_ZOOM). Web Mercator gives ~156543 * cos(lat) / 2^zoom metres per
   pixel; at a mid-latitude city (cos ~0.77) that's ~11 m/px at 13.4 and
   ~1.3 m/px at 16.5. A phone viewport is roughly 400 px wide, so half the
   screen spans roughly 2200 m at the default zoom and roughly 260 m once a
   rider is focused at locate zoom. WIRE_NEAR_M sits above both of those, so
   a rider close enough to plausibly be on-screen — at ANY zoom the app
   actually uses — always gets full per-tick fidelity. WIRE_MID_M is well
   outside even the zoomed-out default viewport: a human cannot perceive a
   multi-second refresh on a rider they cannot see without panning away from
   their own position first, so a slower shared cadence costs nothing
   visible. */
const WIRE_NEAR_M = parseFloat(process.env.WIRE_NEAR_M || '1500');
const WIRE_MID_M = parseFloat(process.env.WIRE_MID_M || '8000');
const WIRE_MID_MS = parseInt(process.env.WIRE_MID_MS || '2000', 10);
const WIRE_FAR_MS = parseInt(process.env.WIRE_FAR_MS || '5000', 10);

/* An identical row must stay identical this long before it is suppressed.
   Short enough to still catch a genuine ~1 Hz GPS-driven update; long enough
   that by the time we start skipping, the client's own dead-reckoning
   (js/sim.js's frame(), gated on npc.pSpeed > 0.6) has already taken over the
   glide instead of sitting on a stale point waiting for the next tick. Real
   risk and its bound (from the directive): if a rider's rows go identical
   while pSpeed is still high (a hard stop / GPS glitch), the client can
   coast up to MAX_EXTRAP_S(1.6s) * pSpeed * 0.6 past the true point before
   freezing. WIRE_HOLD_MS keeps sending through ~3 identical 1 Hz samples
   first, which is exactly the window frame()'s smoothing (`pSpeed * 0.6 +
   raw * 0.4`) needs to decay pSpeed toward 0 on its own — so by the time
   suppression starts, the client already agrees the rider has stopped.
   Parked riders carry none of this risk: setNext() forces pSpeed = 0 the
   instant mode === 'parked' (js/sim.js:87-92), so frame()'s `else` branch
   (`pos = npc.next.pos`) renders a suppressed parked rider bit-identically
   to a re-sent one, forever — see test/wiregate.test.js's parked-fidelity
   proof. */
const WIRE_HOLD_MS = parseInt(process.env.WIRE_HOLD_MS || '3000', 10);

/* Heartbeat: whatever the tier/suppression logic decided, every known rider
   is re-sent at least this often. Bounds the worst case for any client (old
   or new) and makes every suppression self-healing — a client can never be
   left with a rider stuck on a stale point forever, even if this module has
   a bug. */
const WIRE_MAX_STALE_MS = parseInt(process.env.WIRE_MAX_STALE_MS || '15000', 10);

function tierIntervalMs(distM) {
  if (distM <= WIRE_NEAR_M) return 0;
  if (distM <= WIRE_MID_M) return WIRE_MID_MS;
  return WIRE_FAR_MS;
}

/* wire Map entry shape: { s: <serialized row string last SENT>,
                            at: <ms of last actual send>,
                            since: <ms since when the computed row has
                                    continuously equalled entry.s> } */

// Decision order matches the improvement directive's spec exactly — each
// clause is a distinct, independently-tested contract (test/wiregate.test.js).
function shouldSend(entry, rowStr, distM, now) {
  if (!entry) return true;                                // 1. first sight of this rider
  if (now - entry.at >= WIRE_MAX_STALE_MS) return true;    // 2. heartbeat, no exceptions
  if (rowStr !== entry.s) {
    // 3. a real change: rate-limited by the viewer's distance tier
    return now - entry.at >= tierIntervalMs(distM);
  }
  // 4. identical to what we last sent: send through the hold window, then skip
  return now - entry.since < WIRE_HOLD_MS;
}

// Must be called exactly once per (viewer, rider) per tick, right after
// shouldSend() decided `sent`, so the gate's memory always reflects what the
// client actually received (not merely what was computed this tick).
function record(wire, id, rowStr, now, sent) {
  const entry = wire.get(id);
  if (!entry) {
    // First sight is always sent (rule 1), so this row IS what the viewer
    // now has.
    wire.set(id, { s: rowStr, at: now, since: now });
    return;
  }
  if (rowStr !== entry.s) {
    if (sent) {
      // The viewer now has this new value — restart both clocks.
      entry.s = rowStr;
      entry.at = now;
      entry.since = now;
    }
    // Rate-limited (not sent): leave entry.s/at/since untouched. The viewer
    // still only has the OLD value, so the tier check keeps comparing
    // against the last real send until enough time has actually elapsed.
    return;
  }
  // rowStr === entry.s: the computed row still matches what was last sent.
  if (sent) entry.at = now; // a heartbeat re-send of an unchanged row still refreshes the stale clock.
  // `since` is left alone — it marks when the row FIRST became this value,
  // which is what the hold-window guard (rule 4) measures against.
}

module.exports = {
  shouldSend,
  record,
  tierIntervalMs,
  WIRE_NEAR_M,
  WIRE_MID_M,
  WIRE_MID_MS,
  WIRE_FAR_MS,
  WIRE_HOLD_MS,
  WIRE_MAX_STALE_MS,
};
