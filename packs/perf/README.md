# Performance timers (pack id `perf`)

GPS drag timer (0–60, 0–100 km/h, ⅛ and ¼ mile, 60–130…), side-by-side
racing with nearby riders, the top-speed quest, and best times on your
profile. These are the pre-cut `js/racetimer.js`, `js/dragy.js`, `js/race.js`
and `js/quest.js` modules (commit `a1de6fd`) and the server's race / PB
handlers, re-homed as a feature pack: served by the Convoy server only to an
account that redeemed a code for it, never part of the store binary (see
`packs/README.md` for the contract and the compliance argument).

## What it does

* **Dragy meter** (`dragy.js`, the 0–60 chip): times acceleration runs from
  the phone's GPS through the single `gpsfix` stream sim.js already emits.
  Speed is GPS Doppler when the device reports it, else derived from position
  deltas; distance is the time-integral of speed and every crossing is solved
  inside its bracketing segment under a constant-acceleration model (speed
  targets linear in time, distance targets by the quadratic), with the
  standing-start launch back-dated to the first creep above 0.3 m/s. Splits
  (60 ft, 0–30, 0–60, ⅛ mile with trap, …) on every standing start. History
  in `localStorage` (`convoy.dragy.v1`, 60 runs); a personal best is uploaded
  to the server for signed-in riders.
* **Side-by-side racing** (`race.js`): an open lobby any rider within
  `NEARBY_KM` of the host can join — not convoy-gated. Host picks the preset,
  everyone readies, a server-minted 3-2-1-GO lands at the same instant for
  all, each racer's phone times its own run with a `racetimer.js` instance
  (one per racer, the remote ones fed by the ~10 Hz `perf:race:fix` relay) and
  reports the finish; the server DNFs the rest, credits the win and tears
  down. Live HUD (`#race-hud`) during the run, leaderboard after.
  **Only a race that reached the green light records anything** — a cancel
  from the lobby or a host leaving during the countdown abandons the race and
  charges nobody (the old race-lifecycle suite's cases A/B/C, now in
  `test/packs-perf.test.js` group F).
* **Top Speed Quest** (`quest.js`, the `#hud-quest` card): all-time top speed
  (plausibility-filtered: two consistent fixes within 4 s, ≤ 1.5 g between
  them, < 335 mph) and the fastest 60–100 mph pull from a permanently
  re-arming rolling-start timer. Records in `localStorage` (`convoy.quest.v1`).
* **Profile**: "Fastest times" (with a runs / wins tally) on the rider's own
  profile page, and a bests / races / wins strip plus "Best dragy times" on
  every public-profile overlay, plus the "Challenge to race" button on another
  rider's overlay. Guests see their local history; signed-in riders see the
  server's view, refreshed live when a PB lands (`perf:stats` event).

## Regulated — off by default

A timed run on a public road is street racing, so:

* `perfEnabled` defaults to **false**. The 0–60 chip is hidden, no race can be
  created or joined, the Challenge button is absent from profiles and the
  quest is idle until the rider switches the pack on in **Settings →
  Performance timers**.
* That switch, the chip tap, a Challenge and accepting a race invite all go
  through `A.ui.legalGate('race', …)` with the notice the core used to carry as
  `FEATURE_NOTICES.perf` — "Track and private land only" — once per Terms
  version.
* The moment the account stops holding the pack (`A.store` `packs` event with
  `A.packs.has('perf')` false) the meter closes, any race is left, the HUD and
  the quest card hide and the chip hides. Switching the setting off does the
  same.

## Files

```
packs/perf/pack.json          manifest: legal key "race", order 20
packs/perf/racetimer.js       FIRST: settings, the notice, A.perf (shared helpers + the per-rider stats map), the timing core
packs/perf/dragy.js           the meter, the chip, the settings section, the profile hooks, the stats socket handlers
packs/perf/race.js            lobby / HUD / results, the Challenge button, the race socket handlers
packs/perf/quest.js           LAST: the quest card + A.packs.register('perf', { init })
packs/perf/perf.css           dragy + racing + bests + quest sections of the old css/styles.css
packs/perf/chip.html          the 0–60 chip, appended to #chips, hidden
packs/perf/hud.html           #race-hud and #hud-quest, appended to <body>
server/packs/perf.js          the server half (routes, socket handlers, the stats store, the races)
server/migrations/005_perf_stats.sql   creates public.user_stats and public.dragy_pbs
test/packs-perf.test.js       the suite (node test/packs-perf.test.js)
```

## Environment

All optional, read by `server/packs/perf.js` from `server/.env`, never sent
to the client:

| key | default | meaning |
|---|---|---|
| `RACE_FIX_BUDGET` | `700` | `perf:race:fix` frames per connection per minute (the client relays at 10 Hz) |
| `RACE_FIX_IP_BUDGET` | `3600` | the same per IP (a NAT'd group of racers) |
| `RACE_COUNTDOWN_MS` | `3000` | lobby → green light |
| `RACE_TEARDOWN_MS` | `8000` | how long a finished race stays for the leaderboard |

No API key, no collector. **Migration:** apply
`server/migrations/005_perf_stats.sql` (idempotent — a database that already
has the two tables from the first schema is untouched). Without it the pack
boots, logs one line, keeps counters in memory for the process and every write
fails loudly in the log.

## Settings it registers

| key | default | meaning |
|---|---|---|
| `perfEnabled` | `false` | the regulated switch: chip, races, Challenge button, quest |
| `showQuest` | `true` | show the Top Speed Quest card (only while `perfEnabled`) |

## Wire protocol (all renamed — see below)

Client → server (socket, holders only): `perf:dragy:pb {modeId,time,trap}`,
`perf:stats:get {id}`, `perf:race:create {modeId}`, `perf:race:join {id}`,
`perf:race:ready {on}`, `perf:race:start`, `perf:race:fix {lng,lat,speed,heading,acc,ts}`,
`perf:race:finish {time,trap}`, `perf:race:leave`, `perf:race:invite {to}`,
`perf:race:end`.

Server → client (only to sockets holding the pack): `perf:stats {id:'self'|riderId, stats}`,
`perf:dragy:pb {id, stats}` (a scoped rider's PB landed; `stats: null` to a
viewer who has not confirmed their email, as the name gate does),
`perf:race:state {race|null}`, `perf:race:invite {from,fromName,raceId,modeId}`,
`perf:race:fix {from,…}`, `perf:err {msg}`.

HTTP: `GET /api/perf/dragy/pb` → `{ ok, stats }` for the bearer's account.

## What changed against the old build

| old | now |
|---|---|
| `#chip-dragy` in `index.html`, always visible, dot as an inline style | `chip.html` fragment, appended to `#chips`, hidden until `perfEnabled`; dot is `.dot-dragy` |
| `#race-hud` in `index.html` | `hud.html` fragment, appended to `<body>` |
| the quest card was `A.hud.card('hud-quest')` on the instrument HUD rail | the rail is not in the core: `#hud-quest` is in `hud.html` and positions itself (top-right, where the rail's first slot was); labels at the 12px floor (were 9px) |
| `js/ui.js` init() shimmed the chip and lazy-loaded `js/dragy.js` / `js/race.js` (`A.lazy.*`); `js/config.js` / `js/app.js` loaders | eager: the pack loads with the manifest; `init()` from `A.packs.register('perf', …)` (in `quest.js`) wires the chip and seeds the stats |
| `FEATURE_NOTICES.perf`, `legalGate('perf', …)` | `A.ui.registerFeatureNotice('race', …)` — the key is `race` (matches `pack.json` `legal`); the text is the old one verbatim |
| no master setting (the chip was always there); `showQuest` in `js/state.js` | `perfEnabled` (off) and `showQuest` via `A.store.registerSettings`; Settings → "Performance timers" section through `A.ui.addHook('settings')` |
| `A.sim.remoteStats / getStats / adoptStats`, `stats` on NPC records and `riderRecord()` | `A.perf.getStats / remoteStats / adoptStats` — a map inside the pack, fed by `perf:stats` / `perf:dragy:pb` and `perf:stats:get`; `A.store` emits `perf:stats` (was `stats`) |
| `js/ui.js` bestsFromStats / pbRowsHtml / renderTimes, the "Fastest times" section, the overlay strip + "Best dragy times", the Challenge button, the `stats` listener | the same code, through `A.ui.addHook('profile')` and `('profile-overlay')`; `A.dragy.bestsFromStats / pbRowsHtml / renderTimes` |
| `A.net.sendRace()` with `race:*`, handlers `dragy:pb`, `race:state/invite/fix`, server `err` | `A.net.send()` with `perf:race:*`; `A.net.on('perf:dragy:pb' / 'perf:stats' / 'perf:race:state' / 'perf:race:invite' / 'perf:race:fix' / 'perf:err')` |
| control frames queued behind a reconnect (`sendQueued`) | the core does not expose its queue: a frame sent while the socket is down is dropped and the rider is toasted |
| `POST /api/dragy/pb` | `GET /api/perf/dragy/pb` (own stats). A pack route cannot read a request body — the core consumes it before dispatching — so the upload is the `perf:dragy:pb` socket message (which the old server accepted too) |
| ws `dragy:pb`, `race:create` … `race:end`; `c.raceId`; the close hook's `leaveRace` | `perf:dragy:pb`, `perf:race:create` … `perf:race:end`, `perf:stats:get`; `raceOf` map inside the pack; `onClose()` |
| `store.getStats / recordPB / recordRun / recordWin`, `db.queuePB / queueRunIncrement / queueWinIncrement`, `loadAll`'s two reads | an in-memory `Map` in `server/packs/perf.js`, loaded at `init()` and written through with `ctx.db.query` (the old SQL verbatim) |
| `RACE_*` constants in `server.js` | the same, plus `RACE_COUNTDOWN_MS` / `RACE_TEARDOWN_MS`, read from env by the pack |
| the race fan-out went to every member | to members whose socket holds the pack (always true by construction, checked anyway); a `perf:race:invite` to a rider without the pack is refused with a toast |
| an abandoned race said "nothing recorded" via the core `err` | via `perf:err` |
| `test/race-lifecycle.js` (needed a running server and a real database) | ported to `test/packs-perf.test.js` group F against a fake ctx — same three cases plus the join / block / fix / invite paths |

Element ids, setting keys and CSS classes keep their old names.

## Known gaps

* **Awards and the profile header counters.** The old profile page counted
  dragy runs / race wins in the header (`pf-ig-stats`) and had seven
  timing-related awards (First Launch, Track Rat, Race Winner, …) in
  `computeAwards()`. Both are private to `js/ui.js` with no hook; the "Fastest
  times" section carries a runs / wins tally instead and the awards are not
  restored.
* **Admin stats page** (`setStats` / `setPB` corrections) is not restored.
* **Block mid-race.** The core's `applyBlockNow` used to abandon a race the
  two riders shared. There is no block hook for packs; `perf:race:fix` still
  refuses to cross a block on the very next frame and `perf:race:join` /
  `perf:race:invite` refuse a blocked pair, so the stream stops — the race
  itself is simply left to finish or time out.
* **Outbound queue.** See the table: race control frames are not queued
  across a reconnect.
* The `perf:race:fix` relay interval is a plain `setInterval` on purpose: it
  transmits, and `U.poll` would pause it on a hidden page and freeze every
  peer's view of that racer.
* Phone GPS is ~1 Hz and Doppler-less on some hardware; every time is ballpark
  and the meter says so.
