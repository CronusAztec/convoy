# HISTORY — Convoy (append-only narrative; STATE.md is the map)

## Cycle 3's STATE.md §5 narrative, moved here by cycle 4's implementer (directive task 4 — §5 had grown to five dense paragraphs, over the ≤20-line format budget)

Improve-directive cycle 2 done — the cycle-2 lazy-loader hardened (retry-on-rejection + two re-entrancy guards) and `js/voice.js` taken off the boot path with it, the second real byte-budget win.

1. **Task 1 — `A.util.loadOnce(key, factory)` (`js/util.js`, next to `loadScript`): the shared lazy-loader now retries after a rejection instead of caching it forever.** Cycle 2's `A.data.ensure()` cached the promise from `loadScript()` even when it rejected — one flaky fetch during the idle warm permanently broke the garage for the rest of the session, since the cached rejected promise was never cleared. `loadOnce()` fixes this generically: concurrent callers for the same key share one in-flight promise/injected `<script>`; on success later calls resolve instantly with no new injection; **on rejection the cache entry is deleted**, so the next call retries (unbounded — no attempt ceiling; noted as a deliberate default, easy to bound later if a real flapping-network case ever needs it). `A.data.ensure()` is now a thin wrapper over it (same public contract: `A.data.loaded` fast path, stamp read off `config.js`'s own tag). Proven with a real red run: stashing this fix and rerunning `node test/lazydata.test.js` throws `TypeError: Cannot read properties of undefined (reading 'ensure')` inside `buildVoiceSettings` (task 3's code, itself proof the two tasks are coupled) — pasted in the stage report — and, isolated to just `js/config.js`, the old cache gives `injected 1` instead of `2` on a retry. `test/lazydata.test.js` grew from 18 → 29 checks.
2. **Task 2 — `js/ui.js` `buildProfilePanel()`'s garage branch: a `.catch()` and a re-entrancy guard.** A failed `A.data.ensure()` used to leave the rider on a permanently blank panel (no `.catch()` at all); a second overlapping open (double-tap, or `closeAuthEnter()` re-rendering mid-load) used to append a second copy of the garage markup into a `body` that was only cleared once. Fixed with one `profileGen` counter bumped on every `buildProfilePanel()` call: a pending `.then()`/`.catch()` from a stale call checks its own snapshot against the live counter and no-ops if it lost the race; the `.catch()` path shows a toast and falls back to `showProfileView('main')` (the real "view state now matches the DOM" fix, not a hand-rolled shortcut) so the rider always lands on a usable, interactive panel. Proven against the **real** `A.ui.openPanel()`/click path in a full jsdom window (not `A.data.ensure()` in isolation): one check fires `onerror` on the injected script and asserts `#profile-body` stays non-empty with a working "My Garage" retry button and a toast; another fires two rapid `garageBtn.click()`s before the (shared, cached) load resolves and asserts exactly one `.pf-back-title`/`<select>` set renders, not two.
3. **Task 3 — `js/voice.js` (15,620 B gzip) off the boot path, the mission's second real byte win, built on the hardened loader.** No `<script>` tag for it in `index.html` anymore. `js/config.js`'s new `A.voiceLoader.ensure()` (same shape as `A.data.ensure()`, built on `loadOnce()`) resolves to `A.voice` once loaded; `js/app.js` warms it once at `load` + idle (mirroring the `A.data` warm) and calls `A.voice.init()` in that `.then()` — the one unguarded `A.voice` call site in the whole app (every other one — `js/net.js`, `js/radar.js`, `js/ui.js:1466` — was already `if (A.voice)`-guarded and degrades to a no-op today, confirmed by grep before touching anything). `js/voice.js`'s `init()` now calls `reconcile()` once, immediately, at the end — idempotent by construction, so it's safe whenever init runs, but it closes a real gap a lazy init opens: without it, a convoy that formed before the idle warm resolved would sit silently ignored until the next `PROX_POLL_MS` tick. `js/ui.js`'s `buildVoiceSettings()` now awaits `A.voiceLoader.ensure()` (own `voiceGen` counter + a `#voice-settings-host` DOM-identity check, the same shape as task 2) before rendering into a dedicated host div appended in place — a failed/absent load still falls through to the existing capability-stripped section, unchanged. `test/frontend.test.js:52`'s `MODULE_ORDER` keeps `'voice'` (same precedent as `'data'` after cycle 2) — noted, not a mismatch. **Before → after (measured by `node test/frontend.test.js`, same box, same command):** `bootAssetRequests` 45 → **44**; `bootAssetGzipBudget` 344549 (measured) → **330662** (measured; ~1.7 KB above the directive's ~328,929 estimate — the real cost of tasks 1–2's retry/re-entrancy code, a deliberate trade of a few bytes for two closed correctness gaps, same shape as cycle 1's own byte-for-correctness trade), baseline pin 345088 → **330752** (next whole KiB, ratchet DOWN).
4. **Task 4 — stamp bumped `cy124 → cy125`, correcting a stale assumption in the improve-directive.** The directive assumed `cy124` was still unpushed and told this stage not to bump it, but `node test/stamp.test.js` (computed from `git show origin/main:index.html`, never from remembered prose — exactly the guardrail cycle 2 built) came back **RED**: `origin/main` already carries `cy124` (Forge's own auto-commit-and-push for cycle 2's stage landed it there before this stage started), so this stage's real edits under the same stamp would have been the *exact* cycle-1 incident again — a rule phrased "don't bump, because X" going stale the moment the directive was written, caught by the tool built for precisely that failure mode. Trusted the computed check over the stale instruction (per the orientation protocol), bumped all 44→43 `?v=cyNNN` refs (one dropped by task 3) to `cy125`, reran `node test/stamp.test.js` → 6/6 green, `node scripts/pack-ota.js --offline` → `stamp cy125 → version 1.0.125` clean. **Note for whoever reads this next: `origin/main` (the git remote) and the deployed production server are two different "pushed" states** — this stamp bump is about the former; production still serves `cy123` over HTTP, unrelated to this git-level check.

## Older §9 history lines trimmed from STATE.md by cycle 3's implementer (hygiene, not required this stage — STATE.md was within budget)
- Previous mission cycle 59: visual pollers pause when hidden (`test/visibility.test.js`), shipped `cy121`.
- Previous mission cycle 58: convoy seat resume across reconnects (`test/partyresume.test.js`), shipped `cy120`.

## Older §9 history lines trimmed from STATE.md by cycle 15's implementer (directive task 4 hygiene — STATE.md was over its ≤30720 B budget after adding two push-history lines + the field-vitals milestone)
- 2026-09-04 cycle 11 (PUSH, stage 0061): shipped T2.6 wire gate to production — Lane B, no stamp bump, commit `d85e9c5`. 0 BLOCKER/HIGH, 39/39 suites, journal clean.
- 2026-09-04 cycle 11 (IMPLEMENT): shipped T2.6 (`server/wiregate.js`, per-viewer wire gate, `test/wiregate.test.js` 39th suite). N=60 moving −38.8%, parked −93.9%, stretch bar (≤0.6×) missed by ~2% — corrected cycle 12 (WS compression was the right lever). Full narrative: `HISTORY.md`.

## Older §9 history lines trimmed from STATE.md by cycle 4's implementer (directive task 4 hygiene)
- Previous mission cycle 61: chat-log freeze at line 100 fixed (`test/chatlog.test.js`), UI/UX truth pass, `cy122 → cy123` (push pending — never ran).
- Previous mission cycle 60: Frontend truth pass, `test/domids.test.js`, dead solo physics deleted (−1.6 KB gzip), shipped `cy122`.
- 2026-09-03 cycle 0 stage 3 (IMPLEMENT, P0a): built + registered `test/perf-bench.js` (32 → 33 suites); found/fixed a real execFileSync-blocks-the-server deadlock along the way; corrected STATE.md's browser recipe (full `chrome-linux64/chrome` hangs in this container, `chromium_headless_shell` is what actually works — same binary `test/browser.test.js` already used); measured boot (dcl≈3900-4200ms, requests 46, gzip 358609, apiCalls 2-3) and idle (rafPerSec 0 — MapLibre CDN is blackholed by design so `sim.js`'s rAF never arms, longTasks30s 5-7); `--cpu`/`jsExecMs` not implemented (CDP-only, filed open). No app code touched → no stamp bump. `npm test` 33 suites green, `npm run test:frontend` green, no baseline key moved.
- 2026-09-03 cycle 0 (this mission): plan v1 written (18:50Z) and re-planned as v2 (19:05Z, operator re-ran the stage: P0 split into P0a/P0b, measurement protocol, T1.8/T1.9/T2.8/T2.9 added); STATE.md rewritten to the map format; no code changed; 32 suites green; local `cy123` > production `cy122`.

## Archived STATE.md of the previous mission (20260903-002914-ce0d, cycles 0–61), moved here verbatim by the 2026-09-03 planner of mission 20260903-173653-75d3

# STATE — Convoy front-end improvement mission

> Maintained by the implementer after every stage. Planner wrote v1 on 2026-09-03.
> Mission dir (handoff docs): `/opt/data/forge/missions/20260903-002914-ce0d/`
> Plan v2 (cycle 50 re-plan, current): `stages/0017-c050-plan.md`; plan v1: `stages/0001-c000-plan.md`. Read v2 first.
> Cycle-0-stage-4 IMPROVE directive amended two plan targets — see "Amended targets" below before
> trusting the plan's original M6/M-B wording.

## Mission
"edit the convoy app to be better in every way, pick a main aspect of the app and work on it, like
frontend, backend, smoothness, etc, once it is done move on to the next" (MISSION.md; re-planned at
cycle 50 on 2026-09-03 — plan v2 is `stages/0017-c050-plan.md` in the mission dir, read it first).
Rules: use graphify; use and learn new skills when needed.
The loop is now implement → review → improve → **push** (new stage: GitHub + live site + OTA to
installed APKs, unlimited cycles). The push stage follows `deploy/PUSH-RUNBOOK.md` to the letter.

## Aspect roadmap (v2 — one aspect at a time; an aspect closes only with a shipped release)
| # | Aspect | Status | Closes when |
|---|---|---|---|
| A | Front-end (cycles 0-4, closed in cycle 50) | **done 2026-09-03** — released by the cycle-50 push stage at 06:56Z (`stages/0021-c050-push.md`). Closing facts, re-measured in cycle 51 at 07:00Z with one request each: (1) `/api/ota` → `"current":{"version":"1.0.117",…}` (was `null` since the mission began); (2) https://odoreeci.tech serves `45 v=cy117` (== local). `livetest` PASS in the push report | `setShellInert` nesting fix + shell-restore invariant test + `#toasts` scoping landed ✔; stamp bumped to `cy117` ✔; review not BROKEN; push stage reports `cy117` served and `/api/ota` current = 1.0.117; livetest green |
| B | Backend / server (`server/*.js`) | **done in code (pending the cycle-56 push, Lane B)** — B1 **done** (cycle 51, section "Aspect B — backend truth pass (cycle 51)" below); B2 **done and shipped** (cycle 52: server-031 + frontend-019, live as `cy118` / OTA `1.0.118` since 2026-09-03 07:46Z, `stages/0029-c052-push.md`); **B3 done in code (cycle 53 stage 30)**: all **34** Server + Runtime entries re-verified against the current tree with a machine-checked `- **Status:**` line each — **8 OPEN / 22 FIXED / 4 STALE** (Server 8/17/3, Runtime 0/5/1; `test/bugstats.test.js` 11→20 checks incl. the anti-rot path check) and the two really-open ones fixed with tests: server-024 (global per-connection `WS_MSG_BUDGET` gate, O(1)) and server-022 (TTS callback dead-response guard), `test/serverpolicy.test.js` 39→55 (group W1). Server-only cycle → **no stamp bump** (`45 × cy118` == production); the push stage runs **Lane B**. **B3b + static cache policy done in code (cycle 54 stage 34)**: server-002 (`defer()` try/catch around all five deferred bodies) and server-020 (leadership goes to the earliest member whose socket is still OPEN) **FIXED with executed tests** (`test/serverpolicy.test.js` 55→77, group D1 lifts `defer()` and `leaveParty()` out of server.js and runs them); server-011 **deferred with a recorded trigger** (tick > 50 ms or > 60 concurrent humans) and server-017 **scheduled as milestone B5, cycle 55** — both decisions written into their BUGS.md entries; ledger now **6 OPEN / 24 FIXED / 4 STALE** (Server 6/19/3, Runtime 0/5/1). The cache policy: new `server/httpcache.js` — stamped `?v=cyNNN` assets `public, max-age=31536000, immutable`, everything unstamped (`index.html`, legal, `/convoy.apk`) `no-cache` **+ ETag + Last-Modified**, the static handler stats before it reads and answers a matching `If-None-Match` with a body-less 304 before any `fs.readFile`; `STATIC_IMMUTABLE=0` kill switch (documented in `server/.env.example` with `WS_MSG_BUDGET`); new suite `test/httpcache.test.js` (41 checks: real round-trips over a temp dir + the production static tail lifted verbatim and executed). Server-only cycle → **no stamp bump** (`45 × cy118` == production); the push stage runs **Lane B**. **Cycle 55 stage 38 (server-only, no bump): the chat outage.** The cycle-54 improve stage's one `diag` showed `[handler chat] now is not defined` on every rider chat line — the `server/server.js` fan-out sent `t2: now`, undefined since the initial commit, so no live convoy chat message was ever delivered, the sender's own echo included (server-032, critical, **FIXED** `t2: entry.t` + executed group X1 with a mutation guard), and a mid-boot `systemctl restart` was logged as a `SUPABASE_DB_URL` failure with exit 1 (server-033, low, **FIXED**, group X2). New class gate `test/globals.test.js` (acorn-globals free-identifier scan over 112 files, 130 checks; RED on `server/server.js: now` before the fix, and it caught `ReferenceError` missing from its own allowlist on the first green attempt). `deploy/livetest.js` now asserts chat delivery both ways; `deploy/PUSH-RUNBOOK.md` §2 reads the journal for `[handler …]` after every restart. Ledger **6 OPEN / 26 FIXED / 4 STALE** (102 bugs). `npm test` 26 → **27** suites. **Closing criterion still open on:** server-017 (high → B5) and B4 Overpass mirrors; server-011 is closed *by decision* (critical-latent, re-open trigger recorded). **B5 + B4 done in code (cycle 56 stage 42, server-only, no bump):** server-017 (high) **FIXED** — the shared `auth:<ip>` bucket is split into a pre-body `authflood:<ip>` ceiling (240/10 min across all eleven routes) and per-route `auth:<route>:<ip>` attempt budgets charged only after `readBody()` produced a well-formed body (`ANON_AUTH_BUDGET` at module scope, `ANON_AUTH_ROUTES` derived from it, `AUTH_FLOOD_MAX >= sum` pinned), `test/serverpolicy.test.js` 95 → **120** (group Y1: RED 15/105 first, mutation guard, three real mutations caught); server-034 (medium, filed + **FIXED**) — `server/overpass.js` demotes a mirror that just failed to the back of the try order for `OVERPASS_COOL_MS` (120 s) and never skips it, `test/overpass.test.js` 66 → **96** (RED 18/72 first, the original 66 unchanged); frontend-020 filed OPEN for aspect C. Ledger **5 OPEN / 28 FIXED / 4 STALE** (104 bugs). **Aspect B closes when the cycle-56 push (Lane B) is live; aspect C opens cycle 57 with C1, the cycle that bumps `cy118 → cy119`.** | BUGS.md server+runtime truth pass (33 entries re-verified against current code, statuses updated, `bugstats` green); every open critical/high server bug fixed **with a regression test**; ~~stamped assets cached `immutable`~~ ✔ cycle 54 (`server/httpcache.js`, pending the cycle-54 push); shipped via Lane B/A |
| C | Smoothness (delivery + client runtime) | **in progress — C1 shipped (`cy119`, 2026-09-03 11:47Z); C2 shipped (cycle-58 push, `cy120` / OTA `1.0.120`, `stages/0053-c058-push.md`, livetest PASS); C3 shipped (cycle-59 push, `cy121` / OTA `1.0.121`, `stages/0058-c059-push.md`, livetest PASS); C4a shipped (cycle-60 push, `cy122` / OTA `1.0.122`, `stages/0062-c060-push.md`, livetest PASS); **C4b done in code (cycle 61, stages 63 + 64), pending the cycle-61 push (Lane A, `cy123` / OTA `1.0.123`).** C4b = **the UI/UX truth pass with the chat-log freeze as its headline fix** (all 23 `ui-*` entries re-verified with a machine-checked `- **Status:**` line each — `STATUS_SECTIONS += 'UI/UX'`, `test/bugstats.test.js` 21 → 22 checks: **5 OPEN / 17 FIXED / 1 STALE**): ui-002 re-filed and FIXED — `renderChatInto` (`js/ui.js:809`) keyed its incremental render on `chat.length`, which the 100-entry ring holds constant once full, so every line from #101 on was stored and never drawn; now keyed on entry identity (`log._last`, O(shifted)) with every push site trimming through `js/party.js` `pushChat()` / `A.party.CHAT_MAX` — the 32nd suite `test/chatlog.test.js` (35 checks, RED 22/13 first); ui-008/011/012 FIXED with an executed `testAriaState()` group in `test/frontend.test.js` (86 → 102 checks: parse-time `aria-pressed` / `aria-current` in `index.html`, `openPanel()` moving `aria-current="page"`, the register form's `aria-required` boxes and `aria-invalid` + `aria-describedby` on the field at fault); ui-009 STALE, ui-010 already fixed; ui-005 / ui-007 OPEN as real phone-only layout calls routed to the human's look; ui-022 filed (chat scroll yank, low). Bytes 357786 → 358321 (**79 B headroom** under the untouched 358400 budget). Stamp `cy122 → cy123`. C4a = **the Frontend truth pass** (all 23 `frontend-*` entries re-verified against the tree with a machine-checked `- **Status:**` line each — `STATUS_SECTIONS += 'Frontend'` in `test/bugstats.test.js`, 20 → 21 checks: **0 OPEN / 21 FIXED / 2 STALE**; the six "high" entries the "fix first" table was still pointing at were all already fixed) + the two things it licensed: the 31st suite `test/domids.test.js` (22 checks — every id the client looks up by literal must resolve on the shipped page; RED 3/19 on a renamed `eta-card`, which also exposed two `js/tripextras.js` lookups the ledger never listed) and frontend-003 FIXED by deleting the never-reachable solo physics from `js/sim.js` (802 → 645 lines, −1622 B gzip) so `bootAssetGzipBudget` ratcheted **DOWN** 359424 → 358400 (measured 357786, 614 B headroom, up from 16). Stamp `cy121 → cy122`. C3 = **pause the pixels** (frontend-021 medium → FIXED with the 30th suite `test/visibility.test.js`, 52 checks, RED 24/23 first): `A.util.poll(fn, ms)` / `unpoll(id)` skip the tick while `document.hidden` (read at tick time; the timer is never stopped, so the phase never shifts) and one `visibilitychange` listener runs each DUE poller exactly once on the way back; eight visual-only sites converted (aircraft + predict, radar, traffic, hazards, incidents, NWS, clock); the 14 keep-set timers (police / Waze / hotspots alerting, scanner audio queue, sonar, race relay, position beacon, mic gate, proximity voice, overlay-close, sun theme, space / sim) pinned in the machine-checked `POLL_ALLOW` with reasons. The four touched files 31614 → 31652 gzip (+38 B of the 54 B headroom; `bootAssetGzipBudget` untouched). Stamp `cy120 → cy121`. C2 = **a convoy survives a tunnel** (server-035 high + frontend-022 high + frontend-023 medium, all FIXED with the 29th suite `test/partyresume.test.js`, 73 checks, RED 49/24 first): the server holds a dropped rider's seat for `PARTY_GRACE_MS` (90 s, `server/.env.example`, 0 disables) and hands every socket a 128-bit resume token in its own `welcome`; the next `hello` carrying it drops the rider straight back in — half-open branch (old socket still open, the common case) or reaped branch — with "*X lost signal*" / "*X reconnected*" instead of "*left*" / "*joined*"; the client keeps the roster only while `Date.now() < partyGraceUntil` (client 90 s ≤ server, cross-file pin R3), the server's `resumed` answer wins, `js/party.js` delegations queue behind the next hello instead of falling into the solo simulation, and `socket.onmessage` ignores superseded sockets. frontend-012/013/017 re-statused FIXED (phantoms), frontend-021 → C3 cycle 59. `bootAssetGzipBytes` (357743, zero headroom) retired for `bootAssetGzipBudget` 359424 (next whole KiB above the measured 359370; moves up only with a named retirement, target ≤ 300 KB). Stamp `cy119 → cy120`. **Remaining sequence:** C5 (the ≤ 30 requests / ≤ 300 KB number) is the only C row left and it is blocked on the `ui.js` split (aspect E M7) — **the cycle-62 improve stage should re-plan** (pull M7 forward, or close C at C4b and open aspect D) rather than leave a blocked row at the head of the roadmap for two cycles (cycle-61 improve directive §6). Not taken in cycle 61: frontend-015's `pollClose` residual and frontend-005's header nit (79 B of byte headroom — the next web edit must earn bytes first). ui-020/021 stay visual-verification-pending until the human's browser look.  C1 = the measured audit (done by the cycle-56 improve stage; numbers in "C1 measured baseline" below) + frontend-020 fixed **as a class**: `A.util.fetchT(url, opts, ms)` + the load-bearing `A.util.FETCH_TIMEOUT` table in `js/util.js` (overpass 75 s ≥ 2 mirrors × 30 s, aircraft 20 s, api 15 s), all 20 bare `fetch` sites converted, `js/telemetry.js` inline (loads before util.js); new 28th suite `test/fetchtimeout.test.js` (39 checks — the real `fetchPolice()` executed with a stalling transport, an acorn class gate with a two-entry anti-rot allowlist, the cross-file `overpass >= MIRRORS × TIMEOUT_MS` floor; **RED 16 failed / 17 passed first**, two mutations caught); 3 boot-cost keys pinned in `test/frontend-baseline.json` (46 / 357743 / 5, ratchet-down from cycle 58). frontend-021 (`document.hidden` pollers; police/Waze carve-out recorded) filed for **C2 (cycle 58)** with frontend-012/013. Stamp bumped `cy118 → cy119` | request count ≤ 30 on first load; reduced-motion/idle-CPU audit (plan v1 M10); reconnect UX (frontend-012/013); measured with the headless Chromium recipe below; shipped |
| D | Android native (code + compile-check only) | after C | android-002/003/004/009/011/014 fixed; compiles with a user-local JDK/SDK if that lands in 20 min, else code-reviewed; **shipping needs the human's keystore** |
| E | Front-end round 2 | after D | plan v1 M7 (ui.js split), M8 (states), M9 (responsive), M11 (onboarding) |

## Amended targets (cycle 0 stage 4, still binding — do not revert to the plan's original wording)
1. **M6 "detector warnings → 0" is not the real target.** 13 of the 37 detector findings
   (`dark-glow` 6, `side-tab` 4, `repeating-stripes-gradient` 1, `codex-grid-background` 2) are the
   shipped cyberpunk HUD identity itself; driving them to 0 would violate the plan's own guardrail
   "never remove the incumbent visual identity." Amended target: drive the **actionable** subset
   (`undersized-ui-text` 14 + `tiny-text` 1 + `layout-transition` 5 + `clipped-overflow-container` 2
   = 22) to zero, and accept the remaining ~15 via a checked-in allowlist with one-line justifications
   (not built yet — next CSS-touching stage's job).
2. **M-B "0 html-validate errors" conflates real defects with lint-preset taste.** Amended target:
   0 errors in the correctness/accessibility rule classes (now achieved — see below); the remaining
   `void-style` (7, self-closing void tags — cosmetic) and `no-inline-style` (5, genuine inline
   styles with no behavioural impact) are pinned as the new floor for `htmlValidateErrors` in
   `test/frontend-baseline.json`, not chased to literal zero.

## Metrics (baseline 2026-09-03 → cycle 3 stage 14 → target)
| Gate | Original baseline (M1) | **Current (stage 14)** | Target | Command |
|---|---|---|---|---|
| M-A design-integrity findings (impeccable detector) | 37 (32 warnings, 5 advisories) | **17** — the actionable subset (`undersized-ui-text` 14, `tiny-text` 1, `layout-transition` 5, `clipped-overflow-container` 2) is now **0**; remaining 17 is the checked-in design-identity allowlist, see `css/DESIGN-DECISIONS.md` | 22 actionable findings → 0 — **MET**; remaining 17 allowlisted per amendment 1, not chased further | `node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js \| grep -c '"antipattern"'` |
| M-B html-validate errors on `index.html` | 57 | **13, unchanged** (7 `void-style` + 5 `no-inline-style`, both taste — pinned; 1 `prefer-native-element` on `#search-results`, kept on purpose — see below) | 0 in correctness/a11y rule classes — **already met** (see amendment 2) | `npm run test:frontend` |
| M-B axe-core violations per surface | shell 1, nearby 1, convoy 2, profile 5, auth **5 (mismeasured, see below)** | **shell 0, nearby 0, convoy 0, profile 0, authWelcome 0, authLogin 0 — target met on all six surfaces** (stage 8: `#radar-dock` landmark fix cleared `region` everywhere; `mkRow`/`mkField`/`.dot-color`/`.emoji-btn` accessible-name fixes cleared the rest) | 0 on every surface — **MET** | `npm run test:frontend` |
| M-B open BUGS.md UI/UX bugs | 13 listed, ui-003/011/013 confirmed open | **23 listed — 5 OPEN / 17 FIXED / 1 STALE** after the cycle-61 C4b truth pass (ui-002 re-filed and fixed: the chat-log freeze at message 100; 008/011/012 fixed with `testAriaState()`; 005/007/020/021 need the human's browser look; 022 filed) | all closed | read `BUGS.md` §UI/UX |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; `no-cache`; 45 requests | **cycle 54:** first visit unchanged — 1086 KB raw / **342 KB gzip** across the 45 stamped assets + 22 KB `index.html` (measured locally by the cycle-53 improve stage: `gzip -9` per file, summed). **Repeat visit: 342 KB → ~0 and 46 requests → 1** — the 45 stamped assets are now `public, max-age=31536000, immutable` (the browser never re-requests them; the stamp is bumped all-45-together so it is content-addressed), `index.html` stays `no-cache` but carries an ETag, so its one revalidation is a ~200-byte `304` (stat only, no read). Kill switch `STATIC_IMMUTABLE=0` → `no-cache` everywhere, ETag kept. **Cycle 58:** the exact-byte pin `bootAssetGzipBytes` 357743 was retired for the whole-KiB budget `bootAssetGzipBudget` **359424** (measured 359370 after the C2 client); it moves up only with a named, justified retirement in a stage report, and it is meant to trend down toward the ≤ 300 KB target. **Cycle 60:** the first ratchet DOWN — 359424 → **358400** (measured 357786 after deleting the never-reachable solo physics from `js/sim.js`, frontend-003, −1622 B gzip; 614 B headroom) | ≤ 300 KB compressed (first visit — aspect C); `immutable` ✔; ≤ 30 requests (first visit — aspect C) | `node test/httpcache.test.js` (41 checks); after the cycle-54 push, one production request: `curl -sI 'https://odoreeci.tech/js/ui.js?v=cy118' \| grep -iE 'cache-control\|etag'` → expect `public, max-age=31536000, immutable` + a `W/"…"` ETag |

All of the above (except M-C) are gated by `npm run test:frontend` against `test/frontend-baseline.json`
— **ratchet-down only, and this is now enforced, not just documented**: `testBaselineRatchet()` compares
the working-tree baseline file against `git show HEAD:test/frontend-baseline.json` and fails the suite
if any shared key's value has been raised. New keys (e.g. this stage's `axeViolations_authWelcome`/
`axeViolations_authLogin` replacing `axeViolations_auth`) are exempt on the stage that introduces them.

## Current milestone
**Cycle 61 stages 63 + 64 (IMPLEMENT, executing the cycle-60-stage-61 IMPROVE directive's Tasks 1-4) — DONE, WEB EDIT, STAMP BUMPED `cy122 → cy123` (OTA `1.0.123`). Aspect C milestone C4b (the UI/UX truth pass) with the chat-log freeze as its headline fix; the cycle-61 push runs Lane A.**
Convoy chat froze at message 100: `renderChatInto` keyed its incremental render on `chat.length`, which the 100-entry ring holds
constant once full, so every line from #101 on was delivered, stored and never drawn (BUGS.md ui-002, re-filed). Report:
`stages/0064-c061-implement.md`. **Stage 63 did all four tasks (commit `5b3d965`) but ran out of budget before writing its report — it is
marked FAILED in git for that reason alone (human-only item 8 again); stage 64 re-verified every claim from a fresh `/tmp` clone (both RED runs
reproduced against `67ee0bb`, all 32 suites green, stamp / OTA / bytes / production re-checked), changed no code, and wrote the report.**

1. **Task 1 — `test/chatlog.test.js`, the 32nd suite (35 checks), registered after `domids.test.js`; RED 22 failed / 13 passed first**
   (the last DOM line stuck at "msg 100" with state at 6…105), 35/35 after. `renderChatInto` (`js/ui.js:809`) now keeps `log._last` — the
   entry it drew last, identity not length: k shifted entries → k lines removed from the top and the new ones appended (O(shifted); the
   node objects survive, pinned), a replaced array (the resume snapshot) rebuilds, `S.party = null` empties. `js/party.js:125`
   `pushChat(entry)` is the one push + trim + `'chat'` emit for all four sites (inbound `js/net.js:457` delegates; own / system / NPC lines
   in solo mode) with the one exported ceiling `A.party.CHAT_MAX` = 100 (≥ the server's backlog cap — pinned). `partyresume.test.js` 73
   and `net.test.js` 7 unchanged; `globals.test.js` 134 → 135 (the new file is scanned).
2. **Task 2 — C4b.** `STATUS_SECTIONS = ['Server', 'Runtime', 'Frontend', 'UI/UX']` (`test/bugstats.test.js` 21 → 22 checks, entry floor
   57 → 84). All 23 UI/UX entries carry a machine-checked Status line: **5 OPEN / 17 FIXED / 1 STALE** — OPEN: ui-005 (30×30 px clear
   button) and ui-007 (`z-index: 6` tie), real but phone-only layout calls routed to the human's look; ui-020/021 visual-verification-
   pending; ui-022 filed this cycle (chat scroll yank, low — deliberately not bundled with the correctness fix). The ledger drifted both
   ways: ui-009 STALE (`logoShine` is not in the tree), ui-010 already fixed (`--accent-ink` via `U.bestInk`), ui-002 understated a live
   high. Five legacy prose `- **Status:**` lines (ui-001/003/004/006/013) renamed `- **Resolution:**` so every entry has exactly one
   machine-checked line. Roll-up 10 / 67 / 7 / 84; Stats 109 bugs. Anti-rot proven: `js/state.js` → `js/statex.js` in ui-010's line fails
   the suite naming `ui-010`.
3. **Task 3 — ui-008 / ui-011 / ui-012, executed by `testAriaState()` (`test/frontend.test.js` 86 → 102 checks; against HEAD: 2 failed,
   then the group threw at `A.ui.syncGlobalChip`, not exported before).** ui-008: `syncGlobalChip()` already mirrored `aria-pressed` at
   runtime (commit effee44 — the directive's grep covered only `index.html`); `index.html:85` now declares `aria-pressed="false"` at parse
   time, `syncGlobalChip` is exported, the `'global'` listener wiring is pinned by source (jsdom cannot run it — it drives the map layer).
   ui-011: `openPanel()` (`js/ui.js:44`) sets `aria-current="page"` on the active dock button — Map when no panel is open (pinned, never
   cleared) — `index.html:180` at parse time, `aria-expanded` kept. ui-012: the three consent boxes carry `aria-required="true"`
   (`js/ui.js:3341`); `showErr(el, msg, bad)` (`:3221`) gives the error node an id and marks the input at fault `aria-invalid` +
   `aria-describedby`; the register form validates username / password (6+, pinned equal to `server/server.js`) / email client-side.
   `htmlValidateErrors` 13, `axeViolations_*` 0 ×6, `domids` D3 pins unchanged (no literal id, no new lookup).
4. **Task 4 — bytes and stamp.** `bootAssetGzipBudget` 358400 untouched; measured 357786 → 358310 after Task 1 (first, longer comments)
   → **358321** after trimming those comments and adding Task 3 — **79 B of headroom left**. The next web-touching stage cannot add:
   it earns bytes or re-plans the `ui.js` split (M7). Stamp `cy122 → cy123` (45×), OTA `1.0.123`; production served `45 v=cy122` (one
   request) → LOCAL > PROD by exactly one, Lane A. `graphify update .` before the first edit and after the last.

**Cycle 60 stage 59 (IMPLEMENT, executing the cycle-59-stage-57 IMPROVE directive's Tasks 1-4) — DONE, WEB EDIT, STAMP BUMPED `cy121 → cy122` (OTA `1.0.122`). Aspect C milestone C4a (the Frontend truth pass); the cycle-60 push runs Lane A.**
BUGS.md's Frontend section was pointing every cycle at work that was already done: its "fix first" table and Stats row claimed six
open Frontend highs, and the tree had fixed all of them. Report: `stages/0059-c060-implement.md`.

1. **Task 1 — graphify.** `graphify update .` ran first (the graph was 12 min older than the cycle-59 commit — the cycle-59 review's
   Finding 1); `graphify-out/graph.json` 12:20 → 14:26, and again after Task 3. The cycle-59 helper is indexed as `poll()`
   (`js/util.js` L344) / `unpoll()` (L354): `graphify explain "poll"` finds it, `explain "A.util.poll"` does not — the graph keys
   functions by bare name, not export path.
2. **Task 2 — `test/domids.test.js`, the 31st suite (22 checks), registered after `visibility.test.js`.** Every id the client looks
   up by literal must resolve: 97 direct `document.getElementById('…')` sites + 7 through `js/radar.js`'s `byId()` wrapper, against
   71 static ids in `index.html` + 20 ids assigned in `js/` (`el.id = '…'`, `setAttribute('id', …)`, `id="…"` inside JS strings /
   templates) + a one-entry allowlist (`theme-css-custom`, computed at `js/themes.js:54`). D1 resolution (0 unresolved), D2 the
   allowlist anti-rot both ways with the reason re-checked, D3 informational pins (97 / 7 / 71 / 21 / 3), D4 the ledger executed by
   name (frontend-001's five `ctl-*`, 008's `dock-convoy-badge`, 009's `eta-card`, 010's three panel bodies). **RED demonstrated:**
   `id="eta-card"` → `eta-card-x` in `index.html` → 3 failed / 19 passed naming `js/routing.js:977`, `:1123` **and two sites the
   ledger never listed, `js/tripextras.js:71` / `:136`**; revert → 22/22. `globals.test.js` 133 → 134 (the new file is scanned).
3. **Task 3 — frontend-003: the unreachable solo physics deleted from `js/sim.js`** (802 → 645 lines): `randomCar` / `spawnLocal` /
   `stepWanderer` / `stepMember` / `ensureAmbient` / `stepAmbientLocal` / `buildLocalGlobal`, the `if (solo)` bodies in `tick()` and
   `relocatePlayer()`, `solo` / `globalTimer` / `GLOBAL_MS` / `NEARBY_N` / `MAX_RANGE`, the unused `A.data` binding and the
   caller-less `isSolo` export (no caller in `js/`, `test/`, `index.html` or any `.md`); `enableSolo()` / `disableSolo()` kept for
   `js/net.js`; a three-line comment marks the spot. `js/sim.js` gzip 11334 → **9712** (−1622 B). `bootAssetGzipBudget` **359424 →
   358400** (measured 359408 → **357786**, next whole KiB; **614 B headroom**, up from 16) — a ratchet DOWN, no `_raised` entry.
   `test/visibility.test.js` POLL_ALLOW's two `js/sim.js` reasons reworded (that timer is the 1 Hz UI tick now); 52/52 unchanged.
4. **Task 4 — the truth pass.** `STATUS_SECTIONS = ['Server', 'Runtime', 'Frontend']` (`test/bugstats.test.js` 20 → **21** checks; the
   entry floor 34 → 57, the roll-up needs a row per area). All 23 Frontend entries carry a Status line (17 added): **0 OPEN / 21 FIXED /
   2 STALE**. The directive pre-verified 8; verifying the rest found **001/008/009/010 already guarded** (`wireControls()`,
   `updateDockBadge()`, `clearRoute()` / `renderEtaCard()`, the three panel renderers — FIXED phantoms, not OPEN-latent as the
   directive's E2 read them), 016 and 018 FIXED (feature detection at `js/space.js:637`, `.trim()` at `js/ui.js:642`), **005 STALE**
   (`isLoggedIn()` is `hasSession()` = `!!(S.auth && S.auth.token)`, so `Bearer undefined` cannot be built), **014 STALE** (the audio
   element is created once; a post-close `error` reaches a `playNext()` that returns on `!P.sys`), 015 FIXED as re-scoped with the
   `pollClose` residual handed to C4b. 012/017's Status lines cited `stages/0048-c057-improve.md` in backticks — a mission-dir path the
   anti-rot check flags the moment Frontend enters scope — rewritten without backticks. Roll-up Frontend 0/21/2/23, Total **5/50/6/61**;
   Stats numbers unchanged (0/6/16/1 = 23 — severities do not move); "Top priorities" gained a Frontend row; section subtitle 21 → 23.
   Production served `45 v=cy121` (the one request) → bumped `cy121 → cy122` (45×), `node scripts/pack-ota.js --offline` → `1.0.122`.

---
**Previous: Cycle 59 stage 54 (IMPLEMENT, executing the cycle-58-stage-52 IMPROVE directive's Tasks 1-4) — DONE, WEB EDIT, STAMP BUMPED `cy120 → cy121` (OTA `1.0.121`). Aspect C milestone C3; the cycle-59 push runs Lane A.**
A backgrounded Convoy kept fetching aircraft every 8 s and radar / traffic / hazards / incidents / NWS every 1.5-5 min for nobody, and on
the way back the map stayed stale until each timer happened to fire, up to five minutes later (frontend-021). Report: `stages/0054-c059-implement.md`.

1. **Task 1 — `test/harness.js` + `test/visibility.test.js`, the 30th suite (52 checks), written and run RED first: 24 failed / 23 passed**
   against the unfixed tree. The harness's `window` / `document` `addEventListener` were no-op stubs — a `visibilitychange` test would have
   passed before the listener existed — so both are a real registry now (`eventTarget()`: add / remove / `dispatchEvent` / `_listeners(type)`);
   the 29 existing suites kept every per-suite check count. Four groups, executed against the real `js/util.js` + `state.js` + `ghost.js` +
   `overlays.js` + `clock.js` with `setInterval` recorded instead of armed: V1 each pause-set tick works visible, does ZERO work hidden, works
   again visible (each poller's own latch is cleared between calls — the rider moved, the map panned — so the zero can only be the gate);
   V2 police / Waze / hotspots still fetch while hidden; V3 a real `document.dispatchEvent` runs each due poller exactly once after 5 min
   hidden, nothing after 100 ms, nothing twice, never an unpolled timer; V4 the acorn class gate with the 14-entry `POLL_ALLOW` (anti-rot
   both ways, word-bounded `fn` match) and the 8-site pause set pinned per file (`POLL_SITES`).
2. **Task 2 — `js/util.js`: `poll(fn, ms)` / `unpoll(id)` + one `visibilitychange` listener**, exported on `A.util`. Skip the tick, never
   stop the timer; `at` advances only on a real run; the resume is due-only. After Task 2 alone: 19 failed / 33 passed (V1 still red —
   nothing converted yet, exactly as the directive predicted).
3. **Task 3 — the eight sites:** `js/ghost.js` `predictTick` (200 ms) + `pollAircraft` (8 s); `js/overlays.js` `refreshRadar`,
   `refreshTraffic`, `pollHazards`, `fetchIncidents`, `fetchNwsAlerts`; `js/clock.js` `render`. Every `clearInterval` partner is
   `x = U.unpoll(x)` (returns null — one statement instead of the `if { clear; null }` triple, the recorded deviation); the two `.unref()`
   Node-isms dropped. GREEN 52/52. Mutations: (a) traffic back to `setInterval` → 4 red (V1 hidden, V3 resume, the gate naming
   `js/overlays.js:306 (refreshTraffic)`, pause set 7 ≠ 8); (b) resume `>=` → `> 0` → 3 red (the 100 ms not-due check, the synthetic
   due-only check, the unpoll check).
4. **Task 4 — bytes, ledger, state, stamp.** The four touched files measured 32018 gzip after Task 3 (350 B over the 31668 limit) → the
   preferred route, not a retirement: the `fetchT` comment block in `js/util.js` cut from 21 to 14 lines (every token
   `test/fetchtimeout.test.js` pins kept — 39/39), the `poll` comment to six lines, one redundant traffic comment in `js/overlays.js` →
   **31652** (+38 B of the 54 B headroom; `bootAssetGzipBudget` 359424 untouched, no `_raised` entry needed). BUGS.md frontend-021 → FIXED
   with the carve-out table, the aircraft reasoning and the honest scope note (108 entries, Stats numbers unchanged, `bugstats` 20/20).
   Production served `45 v=cy120` (the one request) → bumped `cy120 → cy121` (45×), `node scripts/pack-ota.js --offline` → `1.0.121`.

---
**Previous: Cycle 58 stage 50 (IMPLEMENT, executing the cycle-57-stage-48 IMPROVE directive's Tasks 1-4) — DONE, WEB EDIT, STAMP BUMPED `cy119 → cy120` (OTA `1.0.120`). Aspect C milestone C2; the cycle-58 push runs Lane A.**
A rider whose phone lost signal for three seconds was removed from their convoy for good (`ws.on('close')` → `leaveParty(c, false)`),
everyone was told they left, the client threw the roster away, and nothing ever rejoined. Report: `stages/0050-c058-implement.md`.

1. **Task 1 — `test/partyresume.test.js`, the 29th suite (73 checks), written and run RED first: 49 failed / 24 passed** against
   the unfixed tree. R1 lifts the REAL close handler, the REAL `hello` handler, `joinParty`/`leaveParty` and the seat functions out
   of `server/server.js` by text and runs them over fake maps (half-open, reaped, expired, single use, wrong account ×4, disbanded,
   full, kill switch through the real `process.env` read, bounded, the superseded socket's late close); R2 pins claim-before-welcome /
   restore-after, hold-before-leave, `joinParty(…, quiet)` + its untouched call sites, the 16-byte token, the default window, the
   `.env.example` entry; R3 is the cross-file pin client `PARTY_GRACE_MS` ≤ server (and ≥ `RETRY_MAX + CONNECT_TIMEOUT`); R4 runs the
   real `js/net.js` + `js/party.js` through the `test/net.test.js` FakeWS harness (token echo, graced roster, honesty rule, the one grace
   timer, tunnel chat queued not simulated, explicit leave, the stale-socket guard, no storage write).
2. **Task 2 — `server/server.js` (server-035 high → FIXED).** `PARTY_GRACE_MS` / `RESUME_MAX` / `resumeSeats` / `seatOwner` beside
   `parties`; top-level `pruneSeats` / `rememberSeat` / `claimSeat` / `restoreSeat` after `leaveParty`; `joinParty(rider, party, quiet)`;
   `c.resume` minted with `crypto.randomBytes(16)` and registered in `seatOwner`; the close handler holds the seat FIRST and the leave is
   silent exactly when it was held; `hello` claims before the `welcome` (`resume`, `resumed`) and restores after it. Mutations: close
   handler reverted → 6 red; default 0 → 16 red, kill-switch check green. `serverpolicy.test.js` 120 unchanged, `globals.test.js` 131 → 132
   (the new test file is scanned).
3. **Task 3 — `js/net.js` (frontend-022 high, frontend-023 medium → FIXED) + `js/party.js` (recorded deviation).** Grace window,
   token echo, `holdParty()` / `clearParty()` / `dropGrace()`, the onmessage guard, `A.net.isResuming()`, `sendLeave()` drops the grace.
   `js/party.js` `isLive()` reads "live or resuming" so a tunnel chat is queued instead of answered by the solo simulation with a fake
   reply from a real member (`joinByCode` still needs a live socket). `net.test.js` 7 unchanged.
4. **Task 4 — ledger, state, stamp, pin.** BUGS.md 105 → **108** (server-035, frontend-022, frontend-023 FIXED with Status lines;
   frontend-012/013/017 re-statused FIXED; frontend-021 OPEN → C3 cycle 59); Stats Frontend 0/6/16/1 = 23, Server 5/11/15/1 = 32,
   Total 9/33/54/12 = 108; roll-up Server 5/24/3/32, Total 5/29/4/38. Production served `45 v=cy119` (the one request) → bumped
   `cy119 → cy120` (45×), `node scripts/pack-ota.js --offline` → `1.0.120`. Boot-cost pin resolved per the directive: `bootAssetGzipBytes`
   357743 → measured 359370 → retired for `bootAssetGzipBudget` **359424** (next whole KiB), `testBootCost()` points at the new key.

---
**Previous: Cycle 57 stage 46 (IMPLEMENT, executing the cycle-56-stage-44 IMPROVE directive's Tasks 1-4) — DONE, WEB EDIT, STAMP BUMPED `cy118 → cy119` (OTA `1.0.119`). Aspect C opened with C1; the cycle-57 push runs Lane A.**
The client never learned the lesson the server learned in cycle 56: one stalled `/api/overpass` response and the police /
camera / ALPR layer was dead for the rest of the ride, silently — 22 of 23 client `fetch` sites had no deadline (frontend-020).

1. **Task 1 — `test/fetchtimeout.test.js`, the 28th suite (39 checks), written and run RED first: 16 failed / 17 passed**
   against the unfixed tree — `bare fetch sites: 22 (allowlisted 2, violations 20)`, the real `fetchPolice()` issuing
   `1,1,1,1,1` fetches over five 90 s ticks with a stalling transport. Four groups: A1 the lifted `bboxChanged()`
   mechanism; A2 the real module executed in the harness (`setInterval` recorded instead of armed, `fetch` +
   `AbortSignal.timeout` + `Date.now` stubbed, deadlines fired by hand); B the acorn class gate (the helper / a static
   `signal` / a two-entry allowlist with anti-rot and reason re-checks, no `fetch` aliasing, the table bound to the
   `OVERPASS_PROXY` / `AIRCRAFT_PROXY` sites); C the cross-file floor parsed from `server/overpass.js` and
   `server/aircraft.js` each run; D the helper's own contract (default deadline, caller signal via `AbortSignal.any`,
   opts never mutated, the `AbortController` fallback, the no-abort engine).
2. **Task 2 — `js/util.js`: `fetchT(url, opts, ms)` + `FETCH_TIMEOUT` {overpass 75000, aircraft 20000, api 15000},
   exported on `A.util`.** 20 sites converted (`auth` 1, `dragy` 1, `ghost` 4, `net` 1, `overlays` 4, `routing` 5 — the
   police lookup keeps its own `AbortController`, combined with the deadline through `AbortSignal.any` — `scanners` 4,
   `tripextras` 1); `js/telemetry.js:327` carries an inline `signal:` because it loads before `js/util.js`. GREEN 39/39,
   `bare fetch sites: 2`. Mutations: (a) `js/ghost.js:336` back to a bare `fetch` → 7 red (5 executed A2 checks + the
   gate naming `js/ghost.js:336` + the table binding); (b) `overpass: 15000` → exactly 1 red, `15000 >= 2 × 30000 = 60000`.
3. **Task 3 — `testBootCost()` in `test/frontend.test.js` (+5 checks, 78 → 83) and three new baseline keys**
   `bootAssetRequests` 46 / `bootAssetGzipBytes` 357743 / `bootExternalOrigins` 5 (definitions in the check names; the 7
   old keys unchanged; `index.html` stamps normalised before gzip so a bump cannot move the byte count).
4. **Task 4 — ledger, state, stamp.** BUGS.md 104 → **105** (frontend-020 FIXED as a class, naming the suite;
   frontend-021 filed medium / OPEN / C2 with §2.5's table and the police/Waze carve-out); roadmap row C, this block,
   the "C1 measured baseline" section, the test-baseline line; stamp `cy118 → cy119` (45×), `node scripts/pack-ota.js
   --offline` → `1.0.119`. Report: `stages/0046-c057-implement.md`.

---
**Previous: Cycle 56 stage 42 (IMPLEMENT, executing the cycle-55-stage-40 IMPROVE directive's Tasks 1-4) — DONE, server-only, NO STAMP BUMP. Aspect B is done in code; the cycle-56 push (Lane B) is its release.**
Two defects a rider experiences as "this app is flaky": a locked-out rider who could not reach password recovery, and map
lookups that waited 30 s on a mirror everybody already knew was down.

1. **Task 1 — `test/serverpolicy.test.js` group Y1 (95 → 120, +25; `executed:` lines 18 → 29).** The anonymous-credential
   gate is lifted in three pieces (the budget table, the pre-body check, the head of the `readBody()` callback) and executed
   over a real, lifted `rateOk()` and a scripted `readBody()` (well-formed → attempt check; malformed → 400; oversized → 413
   in the data handler, never calling back). The markers exist in both the old and the new shape, so the RED was on
   **behaviour**: 15 failed / 105 passed against the shared bucket — `/api/recover → 429 at "flood"` after 24 logins, a real
   login 429'd after 24 malformed bodies, all ten sibling routes 429 once `/api/login` was exhausted. The mutation guard
   pastes the old gate back in and demands both failures; `AUTH_FLOOD_MAX >= sum(ANON_AUTH_BUDGET)` is pinned.
2. **Task 2 — `server/server.js` (server-017, high → FIXED).** `ANON_AUTH_BUDGET` hoisted to module scope (`:90-104`;
   `/api/login` 24 unchanged, register/recover/forgot/reset/magic 12, the token/OAuth routes 24), `ANON_AUTH_ROUTES =
   Object.keys(...)`, `AUTH_FLOOD_MAX = 240` (the sum is 204). The pre-body gate charges `authflood:<ip>` (`:761`); the
   per-route `auth:<route>:<ip>` attempt budget is the first statement after the `body == null` 400 inside the callback
   (`:772-775`). The four per-identity buckets are untouched. Three real mutations (flood max 200; attempt charge moved
   above the 400; the old shared key back) each turn Y1 red with the predicted check names.
3. **Task 3 — `server/overpass.js` (server-034, medium, filed + FIXED) + `test/overpass.test.js` 66 → 96 (+30).**
   `mirrorOrder(now)` sorts the mirrors by cooldown expiry (healthy first, ties in declaration order) and the loop iterates
   it; `failed()` sets `coolUntil[host] = Date.now() + COOL_MS` (one edit for all five reasons); a success deletes it;
   `stats()` gains `cooling`; `_coolReset(state)` is the documented test seam (the suite's groups share one module
   instance, so every block resets first). `OVERPASS_COOL_MS` (default 120000) is documented in `server/.env.example`.
   RED first: 18 failed / 72 passed — "asked overpass-api.de — expected overpass.kumi.systems first". Zero real Overpass
   requests. Demote, never skip: with two mirrors a real breaker would take the layer down whenever both were cooling.
4. **Task 4 — ledger, runbook, state.** BUGS.md 102 → **104** (server-017 FIXED; server-034 medium FIXED; frontend-020
   medium OPEN — `js/ghost.js:336` fetches the enforcement layer with no `AbortSignal`, scheduled C1); Stats Frontend
   0/5/14/1 = 20, Server 5/10/15/1 = 31, Total 9/31/52/12 = 104; roll-up **5 OPEN / 28 FIXED / 4 STALE = 37**; `bugstats`
   20/20. server-016's status text updated (the shared bucket it cited no longer exists; register is 12/10 min per IP).
   `deploy/PUSH-RUNBOOK.md` §2: the post-restart journal read is `tee`'d to a file and a second grep for `[overpass]` reads
   that same capture — one SSH read, not two; §5 gains item 6.
5. **Not bumped:** `45 ?v=cy118` == production; `git diff --stat origin/main HEAD -- index.html css js legal` is empty.
   Push stage → **Lane B**. `server/police-finder.js:265` has the same in-order mirror loop (slow sweep, not a rider path)
   — noted, left alone.

**What B needs now:** nothing more in code. The cycle-56 push is the release that closes it; aspect C (milestone C1) opens
in cycle 57 and owns every `js/` edit, frontend-020 included.

**Cycle 55 stage 38 (IMPLEMENT, executing the cycle-54-stage-36 IMPROVE directive's Tasks 1-5) — DONE, server-only, NO STAMP BUMP.**
Convoy chat had never worked in live mode, the production journal had been saying so on every deploy, and no suite
could see it. This stage fixes the word and — the actual deliverable — adds the gate that makes the class impossible.

1. **Task 1 — `test/globals.test.js`, the undefined-identifier gate (new suite, 26 → 27; devDependency `acorn-globals`
   7.0.1 = `acorn` + `acorn-walk` + itself, nothing shipped to a rider).** Parses `release.js`, `server/*.js`,
   `scripts/*.js`, `deploy/*.js`, `js/*.js`, `test/*.js` (112 files) and lists every free identifier; each must be on
   its tree's allowlist (ES 29 · HOST 10 · NODE 2 · CJS 3 · WEB 20 · WEB_NOT_IN_JSDOM 7 · APP_WEB 1 · TEST_EXTRA 4 ·
   TEST_DOM 1 — derived from the scan, not typed from memory; `Capacitor`/`tf`/`nsfwjs` are reached via `window.*` and
   are therefore not free names, so the dead-entry check keeps them out). A parse failure is a failed check. Three
   honesty checks keep it from rotting: no dead entries (every name referenced under its trees), no project symbols
   (1101 column-0 definitions, none allowlisted; `now` at `test/auth.test.js:67` and `shutdown` are the named teeth),
   and every entry resolves where it claims (this Node, a jsdom window, the CJS wrapper, an `index.html`
   `<script src>`; the jsdom-gap list must stay absent from jsdom). **RED first:** 3 failed / 127 passed naming
   `server/server.js: now` (the other two were the gate's own `globalThis`/`exports`/`__filename`, removed rather than
   allowlisted). After the fix the first green attempt flagged `ReferenceError` in the new X1 group — a real ES global
   the honesty checks vouch for once listed — then **130/130**. Registered after `httpcache.test.js`.
2. **Task 2 — `server/server.js:2876` `t2: now` → `t2: entry.t`** (server-032, critical). One word, with a comment
   saying why the field is `t2` and naming the two sibling sites that were right. Not one line under `js/`: the client
   already reads `m.t2` (`js/net.js:399`) and renders the sender's echo as `me`.
3. **Task 3 — `test/serverpolicy.test.js` group X1** (77 → 95 checks together with X2; `executed:` lines 9 → 18): the
   `chat` handler lifted verbatim and run — three-member fan-out (A, B, C each get `{t:'chat', text, t2:<finite>}`),
   the sender's own echo, `t2 === party.chat[0].t`, the `blockedPair` guard, the rate limit, whitespace-only text, and
   the bot reply's `t2: reply.t`; plus the **mutation guard** (the same lift with `t2: now` put back must throw
   `ReferenceError`) and a static pin on the three `t: 'chat'` envelopes. **RED first:** 11 failed / 84 passed, every
   executed check dying on `now is not defined` — the production journal line, reproduced in the suite.
4. **Task 4 — server-033 (low):** `boot()`'s `store.init()` catch (`server/server.js:3996`) and the JWKS check
   (`:4008`) test the existing `shuttingDown` flag first and `return` — shutdown() owns the exit — instead of blaming
   `SUPABASE_DB_URL` / the JWKS and exiting 1 when a `systemctl restart` lands mid-boot. The TDZ argument (the flag is
   declared below `boot()`; the catch can only run after an await) is commented in place; no second flag. Group X2:
   the catch body lifted and executed with the flag set and clear, static pins on the flag and the JWKS guard.
5. **Task 5 — ledger, runbook, state.** BUGS.md 100 → **102** (server-032 critical FIXED, server-033 low FIXED; Stats
   Server 5/10/14/1 = 30, Total 9/31/50/12 = 102; roll-up **6 OPEN / 26 FIXED / 4 STALE** = 36; `bugstats` 20/20).
   `deploy/PUSH-RUNBOOK.md` §2 gains the production-signal read (`[handler |Failed with result|uncaughtException|crossed
   WS_MSG_BUDGET`, every hit quoted verbatim) and §5 item 5. **Beyond the letter of the directive, inside its intent:**
   `deploy/livetest.js` now asserts that each side received the *other* side's text (`Chat delivered both ways?`) and
   only prints PASS when it did — this is the script that reported PASS through the whole outage. It cannot run here
   (no local Supabase, and it targets production); the push stage's run is its first execution.
6. **Not bumped:** `45 ?v=cy118` == production; `git diff -- index.html css js legal` is empty. Push stage → **Lane B**.

**What B still needed after cycle 55:** B5 and B4 — both done in cycle 56 stage 42 (see the block above). server-011
stays deferred by decision with its recorded trigger.

**Cycle 54 stage 34 (IMPLEMENT, executing the cycle-53-stage-32 IMPROVE directive's Tasks 1-3) — DONE, server-only, NO STAMP BUMP.**
The site finally has a cache policy (repeat visits stop re-downloading 342 KB), and two of the four open
critical/high server bugs are fixed with executed tests; the other two carry recorded decisions instead of ambiguity.

1. **Task 1 — `server/httpcache.js` (new, require-able with no env/Supabase) + the static handler rewired.**
   Five exports: `isStamped(query)` (the `v=cy<digits>` *parameter*, `/(^|[?&])v=cy\d+(&|$)/`), `etagFor(stat)`
   (`W/"<size hex>-<mtime ms hex>"`, never a body hash), `matchesEtag(header, etag)` (RFC 7232: `*`, comma lists,
   weak comparison), `headersFor({stamped, immutable, etag, mtime, type})`, `IMMUTABLE_ENABLED`
   (`process.env.STATIC_IMMUTABLE !== '0'`, read once). Policy: stamped → `public, max-age=31536000, immutable`;
   stamped with `STATIC_IMMUTABLE=0` → `no-cache`; unstamped (`index.html`, `/`, legal pages, `/convoy.apk`) →
   `no-cache` — every row with ETag + Last-Modified. `server/server.js` static tail (`const qAt … fs.stat(file …`):
   **stat first**, `!st.isFile()` → 404 (a directory used to EISDIR in `readFile`; now it must not become a
   304-able resource), matching `If-None-Match` → `304` with Cache-Control/ETag/Last-Modified, **no body, no
   Content-Type and no `fs.readFile`**, otherwise `readFile` → 200 exactly as before plus the new headers.
   `ALLOWED_TOP`, the traversal guard, `LEGAL_PAGES`, `MIME` untouched. `server/.env.example` gains a "Runtime
   tuning (optional)" block documenting `STATIC_IMMUTABLE` and `WS_MSG_BUDGET`.
2. **Task 2 — tests, 25 → 26 suites.** New `test/httpcache.test.js` (**41** checks, registered after
   `serverpolicy.test.js`): the pure policy (12), a throwaway `http.createServer` over a temp dir driven by real
   `http.request` round-trips on an ephemeral port (21: the policy table row by row, 304 with zero body and the
   headers RFC 7232 §4.1 requires, `*` and list-form `If-None-Match`, HEAD, an `fs.readFile` spy proving the 304
   branch never reads, the validator moving on `utimes` and on rewrite, the kill switch, directory/missing → 404,
   directory + `If-None-Match: *` → 404 not 304), and — the part that keeps the double honest — the **real static
   tail lifted verbatim out of `server/server.js` and executed** through the same server (8). `test/serverpolicy.test.js`
   55 → **77**: group **H1** (11: `require('./httpcache')`, stat before read, 304 between them and returning, the
   `!st.isFile()` guard, `immutable` only in httpcache.js and no Cache-Control string built in the handler code,
   `max-age=31536000` paired with `immutable`, the kill switch read once, `.env.example` documents both knobs) and
   group **D1** (11, see Task 3). **RED first:** the new suite crashed on the missing module, then ran 32/33 with
   only the lifted-tail check red against the unpatched server; serverpolicy ran **11 failed / 62 passed** against
   the unpatched server. Mutation-tested in a `/tmp` copy: `isStamped` always-true → 5 red (index.html immutable),
   `etagFor` ignoring mtime → 4 red, 304 branch not returning → 1 red, `!st.isFile()` dropped → 1 red.
3. **Task 3 — server-002 and server-020 fixed, ledger told the truth.** `defer(fn, ms)` (next to `send()`,
   try/catch + `console.error('[defer] deferred task threw:')`, returns the handle) replaces all five bare
   `setTimeout(() => {` bodies — race-end grace, bot invite reply, bot chat reply, bot wave reply, race green light;
   the two `.unref()` chains survive; the shutdown `setTimeout(() => process.exit(0), 5000).unref()` is left alone.
   `leaveParty()` now hands the lead to the earliest `humanMembers` entry whose `ws.readyState === 1`, falling back
   to `humanMembers[0]`. D1 pins both as text **and executes them**: `defer()` lifted and run with a throwing body
   (caught, logged, handle returned); `leaveParty()` lifted and run — leader A leaves while B (next in join order)
   is mid-close → **old code picks B, new code picks C**; every socket mid-close → the join-order fallback keeps a
   leader. BUGS.md: server-002 and server-020 → FIXED (evidence line numbers computed from the patched tree),
   server-020's `Fix:` line corrected (the "no join-order tracking" diagnosis was wrong — `party.members` is
   push-ordered; the defect was liveness), server-011 → OPEN + **DEFER with a trigger** decision, server-017 →
   OPEN + **SCHEDULED B5** decision; roll-up **Server 6/19/3, Runtime 0/5/1, Total 6/24/4 = 34**; still 100 bugs.
4. **Not bumped:** `45 ?v=cy118` == production. Response headers are not web files. Push stage → **Lane B**.

**What B still needs (the honest count):** server-017 (B5, cycle 55 — the auth path, its own cycle) and B4
(Overpass mirrors, with the per-mirror log lines that have been accumulating since the 07:46Z restart). server-011
is deferred by decision with a re-open trigger (tick > ~50 ms or > 60 concurrent humans), not open work.

**Cycle 53 stage 30 (IMPLEMENT, executing the cycle-52-stage-28 IMPROVE directive's Tasks 1-4) — DONE, server-only, NO STAMP BUMP.**
The server stops assuming the client is polite (server-024) or present (server-022), and the Server/Runtime
half of BUGS.md is finally a measured ledger instead of a two-month-old to-do list (B3 truth pass).

1. **Task 1a — `server/server.js` global per-connection websocket budget (server-024).** `WS_MSG_BUDGET`
   (env-tunable, default **1800/min**, defined next to `RACE_FIX_BUDGET` with the sizing argument: 700 race:fix
   + 60 pos + 480 voice:signal ≈ 1240 legitimate peak, ×1.45 headroom) gates `ws.on('message')` after the
   hello-first guard and before the `handlers[m.t]` lookup. Fixed 60 s window, **two integers on the connection**
   (`c.msgWinStart`, `c.msgCount`, lazily initialised — the first message sees `NaN` and opens a window), **O(1)**
   per message and deliberately NOT `rateOk()` (its per-call array filter would make the limiter the amplifier;
   this is the one recorded exception to the U1 "one throttling mechanism" policy). `hello` is counted but never
   dropped; over budget drops the **message, not the socket**; one `console.warn` per window naming the rider, IP
   and limit. `WS_MSG_BUDGET` in `convoy.env` is the dial.
2. **Task 1b — the TTS synth callback no longer writes to a dead response (server-022).** `ttsRelease(ip)` first
   (the slot must be freed whether or not anyone is listening), then `if (res.writableEnded || res.destroyed) return;`.
3. **Task 1c — `test/serverpolicy.test.js` group W1**, 39 → **55** checks (+16): the sizing invariant computed from
   the source (`WS_MSG_BUDGET ≥ RACE_FIX_BUDGET + 60 + 480`), source-order (gate inside the handler, before the
   lookup), the two-integer counter, no `rateOk(` in the dispatcher *code* (comments stripped), hello exempt, no
   close/terminate, log-once — plus the gate's real source text lifted out of server.js and **executed** with a fake
   clock (1800 pass / next 50 dropped / hello passes / one warning / window resets / only the two fields attached),
   and the server-022 guard + `ttsRelease` ordering. **RED first:** 8 of the new checks failed against the
   unmodified server (41 passed / 8 failed), all green after the two patches.
4. **Task 2 — B3 truth pass.** Every one of the 34 Server + Runtime entries now carries exactly one
   `- **Status:** OPEN|FIXED|STALE (re-verified 2026-09-03) — evidence` line right after its Severity line, with
   `file:line` citations computed against the *patched* tree at write time (`/tmp` script, no hand-typed numbers).
   Result **Server 8 OPEN / 17 FIXED / 3 STALE, Runtime 0 / 5 / 1** — vs the directive's pre-seed, four calls went
   the other way after reading the code: server-009 OPEN (the "Proximity gate" the pre-seed cited belongs to
   `race:join`, not `party:invite`), server-017 OPEN (the shared `auth:`+ip bucket still fronts every anon route at
   24/10 min), server-014 OPEN-latent (the 200 k stringify premise is exactly the cap), server-002 OPEN-latent (no
   try/catch, but bots are off); server-010 and runtime-002 FIXED (explicit `process.exit` / conditional-DELETE burn).
5. **Task 3 — `test/bugstats.test.js`** 11 → **20** checks: exactly-one-Status, placement after Severity (parser
   safety), format, evidence-path presence, the **anti-rot check** (every FIXED path must exist; a STALE "no longer
   exists" path must be absent and the rest present), and the roll-up table rows. **RED first** (5 failed naming all
   34 IDs before the lines existed); the anti-rot check proven by pointing server-001 at `server/auth.js`:
   `server-001 cites \`server/auth.js\` which does not exist`. `parseStatsTable` now stops at the next heading so the
   new `### Open-status roll-up` table under `## Stats` cannot collide with the severity table.
6. **Task 4 — housekeeping.** Top-priorities table: the dangling `server-030` reference is gone (`server-003` alone,
   note that 028-030 were never assigned), the five Server/Runtime rows carry their verdicts, the three Android rows
   say "not re-verified". Stamp untouched: `45 ?v=cy118` == production.

**What B still needs (the honest count):** 4 open critical/high server entries — server-011 (latent, measure first),
server-017, server-020, server-002 (small fixes + tests) — then the static cache policy, then B4 with real Overpass
log lines. See the roadmap row above.

**Cycle 52 stage 26 (IMPLEMENT, executing the cycle-51-stage-24 IMPROVE directive's Tasks 1-4) — DONE.
B2 shipped in code: the Overpass proxy now says which mirror failed and why (server-031), and the client no
longer asks Overpass about the intro globe's fictional 4° box at longitude 0 (frontend-019). The two halves
are one idea — the server change makes the next failure diagnosable, the client change stops manufacturing
failures that were nobody's fault. Lane A: stamp `cy117 → cy118`; nothing deployed (the push stage's job).**

1. **Task 1 — `server/overpass.js` records every per-mirror failure reason.** Each failed attempt is
   `host reason NNNms` with a fixed vocabulary (`timeout` / `net:<ErrorName>` / `http:<status>` /
   `body:<message>` / `shape`); the `all mirrors failed` line carries all of them plus
   `(session ok=N fail=N)`; a partial failure (mirror 0 down, mirror 1 served) — totally silent before —
   now logs one `console.warn`; `stats()` keeps `entries`/`mirrors` and adds `ok`/`fail`/`cached`/
   `byMirror`/`byReason` (copies; fixed-vocabulary keys, so it cannot grow unbounded). Still ≤ 1 line per
   query; no HTTP endpoint (out of scope). **Proved to fail first:** the new group ran red against the old
   code (5 assertions on the line text, `stats().fail` `undefined -> undefined`). `test/overpass.test.js`
   37 → **66** checks (+29, group "A failed mirror says which one and why": scripted `fetch` returning real
   `Response` streams, a distinct bbox per case because of the 30-min cache; the file's tail is now an
   `async main` so a group after the old `Promise.all` actually runs).
2. **Task 2 — `js/ghost.js` never queries a viewport nobody is looking at.** `viewBBox()` is now
   `getBounds → clampBBox(raw, lim)`, a pure function exported on `A.ghost` for tests, which returns
   `null` ("skip this tick", handled by all four callers) when the view is wider than
   `WIDE_VIEW_FACTOR (4) × lim` — 16° for aircraft/police/Waze, 320° for hotspots — or the bounds are
   degenerate. **Proved to fail first against the real data:** with the arithmetic merely extracted and no
   guard, the world-wrapped view returned `{"minLat":-2,"maxLat":2,"minLng":-2,"maxLng":2}` — the exact
   longitude pair in five of the seven production failures (9 of 18 checks red); 0 red after the guard.
   Deliberately accepted: `fetchHotspots` (lim 80) only stops at the world-wrap case; a rider zoomed out to
   a 12° region still gets today's 4° clamp — no regression band below 16°. New suite
   `test/ghostbbox.test.js` (18 checks, registered before `frontend.test.js`; ends in
   `process.exit(H.report())` because ghost.js arms its always-on timers at load).
3. **Task 3 — BUGS.md** gains `frontend-019` and `server-031` (both medium, both FIXED, the field layout
   of `runtime-005`, the FIXED header form of `ui-003b`); Stats table regenerated (Frontend 19, Server 28,
   medium 50, grand total **100**); jump-line and section counts updated; `bugstats.test.js` 11/11.
   Note for B3: `server-028…030` are unassigned — the Top-priorities table cites a `server-030` that has
   no entry (pre-mission, commit `e2443b6`).
4. **Task 4 — close-out:** all 45 stamps `cy117 → cy118`; `node scripts/pack-ota.js --offline` →
   `version 1.0.118`; this file; `graphify update .`; `npm test` 25 suites green; `npm run test:frontend`
   7 baseline keys unchanged. **`LOCAL(118) > PROD(117)` is the expected pre-push state** (rule 7).

Previous milestone, for context — **Cycle 51 stage 22 (IMPLEMENT, executing the cycle-50-stage-20 IMPROVE directive's Tasks 1-2) — DONE.
Aspect A is closed (the mission's first release verified live), aspect B is open, and B1 started with a
measured Overpass truth pass instead of a re-read of BUGS.md. No application code changed this cycle, on
purpose: local stamp `cy117` == production stamp `cy117`, and operating-contract rule 7 below keeps it so.**

1. **Task 1 — aspect A closed in this file.** Roadmap row A → done, with both closing facts re-measured at
   07:00Z (one request each): `/api/ota` → `"current":{"version":"1.0.117","file":"bundle-1.0.117.zip",…}`,
   served page → `45 v=cy117`, `/api/health` → `{"ok":true,"maintenance":false}`. The push stage also had to
   fix `release.js` on the way (OTA bundle uploaded to `/var/lib/convoy/ota`, a directory the server never
   reads — now `/opt/convoy/server/data/ota` — and a `.catch()` chained on ssh2's callback-style `sftp()`),
   commit `5028570`; deploy tooling, not app code, so no stamp bump.
2. **Task 2 — B1 measured truth pass.** Four questions answered with commands (4 of the ≤ 5 third-party
   requests, 0 code changes) — see "Aspect B — backend truth pass (cycle 51)" below. Headline: both mirrors
   answer `200` in ~1.5 s from the VPS *and* from this box; the 7 logged failures are the intro globe
   animation's collapsed world-view boxes (5 of 7 at longitude exactly 0), not sim riders (disabled in
   production) and not the span check (already epsilon-guarded and tested); their *reason* is unknowable
   because `server/overpass.js:203-211` discards it. That is what cycle 52 fixes first.
3. **Bookkeeping.** `git diff --stat` → `STATE.md` only; `graphify update .`; `npm test` 24 suites /
   `frontend.test.js` 78 checks unchanged; `npm run test:frontend` 7 baseline keys unchanged.

Previous milestone, for context — **Cycle 50 stage 18 (IMPLEMENT, executing the cycle-4-stage-16 IMPROVE directive's Tasks 1-4 plus plan-v2
Task 5) — DONE. The cycle-4 BLOCKER (`ui-003b`, a chained `openOverlay()` leaving the whole shell
`inert` until reload) is fixed, the class is covered by an invariant matrix, the `#toasts` gap is
closed, a real-browser smoke suite exists, and the stamp is bumped for the mission's first release.**

1. **Task 1 — `setShellInert` is nesting-safe** (`js/ui.js`): a `shellTrapped` boolean; only the
   outermost open captures the restore list, only its close restores it. Boolean on purpose (not a
   depth counter, not `shellInerted.length` — the code comment says why). **Proved to fail first:**
   matrix rows b/c/d/f reported **18** stray inert body children each (21 shell children minus the
   3 closed panels the helper excludes by design) against the pre-fix code, **0** after.
   **1b (beyond the directive, one line, reviewer please judge):** a gate opening inside a *pending*
   close (`closeAuthEnter` → `enterApp` → `showConsentGate`, synchronous — login never records
   consent locally, so an existing account on a new device, or anyone after a `LEGAL_VERSION` bump,
   hits it) was blanked by the still-armed 380ms hide timer and left the shell inert: a blank
   overlay over a dead app. Reproduced in jsdom first (`hidden=true`, 18 stray), then
   `beginModalGate()` gained the `cancelOverlayClose()` call `openOverlay` already had. Matrix row k.
2. **Task 2 — `#toasts` exemption scoped to non-interactive content**: `gateUp()` +
   `setInviteToastsInert(on)` next to `setShellInert`; `inviteToast()` declines at once while a gate
   is up (same outcome as its 30-second auto-decline, sooner); invite toasts already on screen get
   `inert` from `beginModalGate` / `openOverlay` (mirrors `!overlayDismissable` exactly, so the
   chained dismissable→non-dismissable shape re-scans too) and lose it in `closeOverlay` /
   `closeAuthEnter`. `gateUp()` also treats a `.closing` gate as down (CSS gives it
   `pointer-events: none`, so the rider can reach the toasts again) — the one deliberate addition
   to the directive's helper. Plain `aria-live` toasts untouched. Each half proved to fail first
   against a neutered copy (rows i/j for half 1, rows g/j for half 2).
3. **Task 3 — `testShellRestoreInvariant()`** in `test/frontend.test.js` (+22 checks, 56→78): rows
   a–f (single, ×2, ×3 = race lobby, ×2 with `{dismissable:false}`, gate→card handoff with the close
   timer pending, panel-composition + chaining asserting both directions), k (gate opened inside a
   pending close) and g–j (toast scoping).
   Each row in a fresh jsdom window. An over-reaching "un-inert everything" fix fails row f's panel
   assertion and ui-003's original composition guard, as intended.
4. **Task 4 — `test/browser.test.js`** (new, 24th suite, 5 checks, ~0.6 s): builds a `file://`
   fixture from the real `index.html` (CSP meta and external links stripped, the page's own module
   scripts minus `app.js`), drives the already-installed `chrome-headless-shell` with `--dump-dom`
   and no library, and asserts `document.elementFromPoint` over `#dock` reaches the dock again after
   `openOverlayRaw ×2 → closeOverlay()` — the hit-test jsdom cannot do. Two controls (dock reachable
   before; NOT reachable while the cards are up) prove the probe sees real layout. **Proved to fail
   first** against HEAD's pre-fix `js/ui.js`. SKIPs with exit 0 when the binary is absent (proved
   with `CONVOY_CHROMIUM=/nonexistent` and with the revision directory `mv`'d aside).
5. **Task 5 — release readiness**: all 45 stamps `cy116 → cy117`; `node scripts/pack-ota.js --offline`
   → `version 1.0.117` (353 KB bundle); `BUGS.md` gains `ui-003b` (critical, fixed) with the Stats
   table regenerated (98 bugs); `graphify update .` run. **Nothing deployed** — that is the push
   stage's job (`deploy/PUSH-RUNBOOK.md`, Lane A).

Previous milestone, for context — **Cycle 3 stage 14 (IMPLEMENT, executing the cycle-3-stage-13 IMPROVE directive's tasks 1-5) —
DONE. `ui-003`/`ui-013` shipped after four deferrals; the mission's #1 human-only blocker
(headless Chromium) turned out not to be a blocker at all.** Five tasks:

1. **Task 1 — `ui-013`: closed panels are now `inert`.** Two lines inside `openPanel`'s existing
   `.panel` loop (`js/ui.js`): `if (open) p.removeAttribute('inert'); else p.setAttribute('inert', '')`.
   Kills the phantom-tab-stop bug at its measured real size — **133**, not the ~4 originally
   assumed (panels are built lazily and never torn down, so the count grows with use: 4 at boot,
   127 after Profile is opened once, 133 after all three panels have been visited). New
   `testClosedPanelsInert()` group in `test/frontend.test.js` (3 assertions) — jsdom implements no
   `inert` focus-blocking, so it enumerates the browser's real tab-order rule
   (`[inert]`/`[hidden]`-excluding) against the real `openPanel` API instead of trying a
   behavioural focus test that would fail even on a correct fix. **Verified the test actually
   catches the regression**: reverted the two-line change, reran, got exactly **133** back
   (`found 133: BUTTON, BUTTON, BUTTON, BUTTON, BUTTON`), restored.
2. **Task 2 — `ui-003`: `#onboarding` is now a real focus trap.** New `setShellInert`/
   `beginModalGate`/`focusFirstIn` helpers in `js/ui.js`; wired into `showAuth`, `openOverlay`/
   `closeOverlay`, and — beyond the directive's four named call sites, because they're the
   structurally identical un-named instances of the same defect — `showConsentGate`,
   `showResetPassword`, `showOAuthSetup` (all three bypass `openOverlay` and manipulate
   `#onboarding` directly, exactly like `showAuth`). `openOverlay(card, opts)` gained
   `opts.dismissable` (default `true`); the one opt-out (`{dismissable:false}`) is the
   recovery-code card (`js/ui.js` — `showRegenRecovery`), where a stray Escape is real data loss.
   The global keydown handler in `wireDock` now Tab-wraps inside the modal and only lets
   Escape/`/` fall through to the panel/search shortcuts when no modal is up — this also fixes a
   latent adjacent bug found while reading (Finding E in the directive): pre-fix, Escape while the
   auth gate was up silently closed the panel *behind* it, and `/` yanked focus into the search box
   out from under the modal. Judged the same defect as ui-003 (same handler, same fix), not logged
   separately. One dropped sub-claim: ui-003's "body scroll not locked" was already false —
   `css/styles.css:100-101` sets `html, body { overflow: hidden }` globally; nothing to fix there.
   New `testModalFocusTrap()` group (10 assertions) exercises the real API with dispatched
   `KeyboardEvent`/`MouseEvent`s; required exposing `A.ui.wireDock` (previously only reachable via
   the full `init()`, which sets up audio/walkie-talkie machinery that hangs a Node process with no
   real devices). **Verified 3 separate ways**: reverted the keydown Tab/Escape logic → the
   Escape-closes-dismissable-overlay assertion failed; reverted the backdrop-click listener → the
   backdrop-click assertion failed; injected the exact "blanket un-inert everything" composition
   bug the directive warned about → the composition-guard assertion failed. All three restored,
   all green.
3. **Task 3 — BUGS.md Stats table regenerated from the file itself.** Finding G was right: the
   table said Frontend 15 / Server 24 / total 86; the real numbers (1:1 pairing of every
   `### BUG` header with its `Severity` line) are Frontend 18 / Server 27 / **total 97**, and two
   categories (`add-*` 4, `perf-*` 1) had no row at all. Even the per-severity *splits* the old
   table got right by coincidence were sometimes wrong underneath (e.g. Android's critical count
   was written as 4 but is actually 3 — the row total of 20 was still right, masking it). New
   `test/bugstats.test.js` (11 assertions) parses BUGS.md and fails if the checked-in table ever
   drifts again; registered in `test/run.js` (22→23 suites). **Verified**: introduced a deliberate
   off-by-one in the Frontend row, confirmed the exact row failed with the right recomputed value,
   restored.
4. **Task 4 — bookkeeping.** `BUGS.md`: ui-003 and ui-013 marked fixed (full before/after writeup,
   ui-013's magnitude recorded as 133, cross-linked to each other). `STATE.md`: this entry.
   `graphify update .`: **3089 nodes, 5742 edges, 198 communities.**
5. **Task 5 (time-boxed, ~11 min of the 15-min cap) — SUCCESS, and bigger than the directive
   predicted.** The directive's own Finding F had already falsified "needs root"; Task 5 went
   further and falsified "20 missing shared libs" too — **zero** were missing (`ldd` on the
   downloaded Chromium against this box's existing libraries: empty). A real headless Chromium
   renders on this box, right now, with no system changes at all. Full recipe, and what it showed,
   is in "Headless Chromium — working recipe" below. **ui-020 is answered definitively**: the
   `.rd-limit` "LIMIT" badge measures **59.2px wide against its 46px min-width** — it grows, as
   `min-width` (not `max-width`) guarantees, exactly the "acceptable trade" BUGS.md already
   recorded. **ui-021 got a real (if partial) look**: an isolated `transform:scaleX(0.35)`
   progress bar screenshot showed a clean fill with no visible glow distortion; the in-app radar
   dock screenshot was inconclusive — headless Chromium's software WebGL/`backdrop-filter`
   rendering produced a blown-out blur unrelated to the CSS under test, most likely a headless
   env artifact, not evidence about the real bug either way.
   Per the directive: **not** added to `package.json`/`test/run.js`, no screenshot suite written —
   this was one-off, scratch-directory verification only (`/tmp/pw-scratch`, outside the repo;
   `git status --short` confirms nothing leaked in).

Prior milestone, for context — **Cycle 3 stage 11 (IMPLEMENT, executing the cycle-2-stage-10 IMPROVE directive's tasks 1-4) — DONE. First stage of the mission
that changed how the app looks to a sighted user.** `detectorWarnings` driven **37 → 17**. Four
tasks, all complete:
1. **Task 1 — 12px typography floor across `css/styles.css`.** All 76 `font-size` declarations below
   12px (32 sub-11px + 44 at 11px) raised to `12px`, changing only the `font-size` token on each line
   (verified: `git diff` shows exactly 152 changed lines = 76 × 2, no `font-weight`/`letter-spacing`/
   `text-transform`/`font-family` touched). What a sighted user sees differently: the bottom dock
   labels (Map/Nearby/Convoy/Profile/Scan, `css:514`, 10px→12px), the status chips on phone width
   (`css:2192`, 9.5px→12px — the mobile-only shrink that was the app's single clearest legibility
   bug, per the improvement directive), the radar risk/status labels (`css:2410`, 10px→12px), the PTT
   mode label (`css:2069`), and the speed-limit-sign "LIMIT"/"MPH" captions (`css:2456,2463`,
   9px/8px→12px). `undersized-ui-text` 14→0, `tiny-text` 1→0. Detector 37→22 (exact predicted
   number). `npm test` unaffected (still 22 suites / 41 checks at this point).
2. **Task 2 — the floor is now enforced by code.** New `testFontSizeFloor()` group in
   `test/frontend.test.js`, source-text regex over `css/styles.css` (not computed-style — this is
   the only gate that covers the ~61 font-size rules on JS-built panels the detector's static-HTML
   render never sees, vs. the 15 it can). `FONT_SIZE_FLOOR_EXCEPTIONS` map ready for a documented
   exception, currently empty. **Verified it actually fails**: appended a throwaway `font-size: 9px`
   rule, ran `npm run test:frontend`, got `1 failed, 42 passed` naming the exact offending
   declaration, then reverted and confirmed `git status --short css/styles.css` showed only the
   legitimate Task-1 diff (no test contamination). Check count 41→43 (this task's 2 assertions).
3. **Task 3 — killed all 5 `layout-transition` findings.** Converted `.progress i`, `.vc-meter-fill`,
   `.rrisk-fill`, `.dragy-prog i`, `.race-row-bar i` from animating `width` to animating
   `transform: scaleX()` (compositor-only — `.vc-meter-fill` in particular re-renders every 60ms
   during voice activity, so this removes a layout+paint forced on the main thread ~16×/sec while it's
   also driving the MapLibre canvas and GPS stream). Updated all 5 single JS writers in the same
   change (confirmed via `grep -rn "style.width" js/*.js` before/after — the 4 fill writers plus
   `race.js`'s inline-template writer are gone, only the 3 unrelated one-time `='100%'` setups and 1
   canvas-sizing call remain; `grep -rn style.transform` confirms all 5 new writers present,
   including `race.js:362`'s inline-template form). `layout-transition` 5→0. Detector 22→17 (exact
   predicted number). `npm test` still 22 suites / 43 checks.
4. **Task 4 — checked in the design-identity allowlist and re-baselined.** New file
   `css/DESIGN-DECISIONS.md`: the remaining 17 detector findings (`dark-glow` 6, `side-tab` 4,
   `codex-grid-background` 2, `gpt-thin-border-wide-shadow` 2, `repeating-stripes-gradient` 1,
   `clipped-overflow-container` 2) each get a one-line justification; counts sum to exactly 17.
   `clipped-overflow-container` is recorded as a **false positive** (fires on `html`/`body`'s
   load-bearing `overflow:hidden`, flagging `position:fixed` children that rule doesn't actually
   clip) — allowlisted, not touched. `test/frontend-baseline.json`: `detectorWarnings` 37→17,
   `_comment` extended (not replaced) with this stage's method and the two visual-verification-pending
   caveats below. `BUGS.md`: added **ui-020** (`.rd-limit` badge may grow past its 46px min-width at
   12px — acceptable trade, min-width not max-width so it grows not clips, unverified without a
   browser) and **ui-021** (`.progress i`/`.dragy-prog i` box-shadow glow is horizontally compressed
   by `scaleX(s)` at partial fill — subtle on a 5-6px bar, unverified). Stats table: UI/UX
   19→21 entries (+2, neither fixed nor broken — genuinely unverified), grand total 84→86.
   `graphify update .`: **3071 nodes, 5700 edges, 198 communities.**

**Visual-verification-pending (carry forward — see Human-only actions below):** the `.rd-limit`
badge-growth and `scaleX` glow-compression items above are reasoned from CSS/JS source, not seen on
a rendered screen. No browser on this box (M2 formally dropped). A human with a browser should
glance at the radar dock and the routing/drag progress bars at phone width; this is a ~1-minute
check, not a redo of the work.

Prior milestone, for context — **Cycle 2 stage 8 (IMPLEMENT, improvement-directive tasks 1-4) — DONE.** `axeViolations_*` driven
from 11 total (across 6 surfaces) to **0 everywhere**. Four tasks, all complete:
1. **Task 1 — fixed the ratchet guard's `_comment` bug** (`test/frontend.test.js`, `testBaselineRatchet()`):
   the loop now skips any committed key whose value is not a `number`, so appending to the prose
   `_comment` convention no longer trips a spurious "raised above committed value" failure. Also
   corrected the stage-5 progress-log entry's "38/38" claim to the true **40/40** (fix-forward edit;
   the stage-5 report file itself is left as a timestamped record).
2. **Task 2 — `#radar-dock` (`index.html:241`) is now a landmark.** `<div role="group">` →
   `<section aria-label="Radar controls">`, matching the pattern stage 5 already used for
   `#race-hud`/`#radar-alerts`. This one element was outside every ARIA landmark and caused the
   identical `region (1)` violation on all six tested surfaces — clears `axeViolations_shell/nearby/
   authWelcome/authLogin` to 0 and drops `convoy`/`profile` by one each. Verified CSS/JS select it
   only by `#id`, never by tag — style- and behaviour-neutral swap.
3. **Task 3 — gave the generated form controls real accessible names** (`js/ui.js`), in order,
   re-measuring after each:
   - `mkRow()` (~line 2417, 42 call sites): visible `<b>` label gets a never-reused id
     (`row-lbl-N`, module-level counter — the profile panel rebuilds on every open) and the control
     is wired to it via `aria-labelledby`, only when the control has no name of its own. Cleared
     `button-name (43)` on profile (the 43 unnamed `mkToggle()` switches).
   - `mkField()` (line 111, 66 call sites): native `<label for>` + control `id`, same counter
     discipline (`field-ctl-N`). Cleared `label (3)` + `select-name (2)` on profile.
   - `.dot-color` inputs (custom-theme swatches ~2022, map-dot swatches ~2070): added `aria-label`
     matching the existing `title` text. Cleared `label-title-only (11)` on profile.
   - `.emoji-btn` icon pickers (`mkIconGrid()` ~270, convoy flag row ~592): added
     `aria-label` ("Rider insignia N" / "Convoy flag N") and `aria-pressed` mirroring the `.active`
     class. Cleared `button-name (3)` on convoy.
   - Added a new regression test, `testGeneratedIdsUnique()`: opens the profile panel twice and
     asserts no duplicate `row-lbl-`/`field-ctl-` ids — the directive's called-out risk (a fixed id
     string would trade one violation for a new one on a panel that rebuilds every open).
   - **Result: every one of the four sub-targets landed exactly at the directive's predicted
     numbers — profile 5→0, convoy 2→0 — no residual violations to record.**
4. **Task 4 — re-baselined and made the harness self-documenting.** `test/frontend-baseline.json`:
   all six `axeViolations_*` keys 1/1/2/5/1/1 → **0/0/0/0/0/0**; `_comment` extended (not replaced).
   `atOrBelowBaseline()` now `console.log`s the violation-id/nodeCount detail on **every** run, not
   only on failure — this is the fix for the exact blind spot that cost two prior stages a wrong
   guess about `region`. `BUGS.md`: added ui-015..019 (one per violation class fixed, each with
   file:line), and fixed the stats-table arithmetic (`Frontend`/`Server` row totals and the grand
   total were wrong by 3/3/6 respectively — corrected to 15/24/84). `graphify update .`: 3067 nodes,
   5697 edges, 197 communities.

Prior milestone, for context — **Cycle 0 stage 5 (IMPLEMENT, improvement-directive tasks 1-4) —
DONE.** First real app-code changes of the mission (`index.html` + `test/frontend.test.js`; no CSS
or JS behaviour touched). Four tasks, all complete:
1. Deleted the orphan `<path>` SVG fragment at `index.html:15` that terminated `<head>` early,
   pushing every stylesheet/script tag into `<body>` in every browser and the Android WebView —
   shipped in production (`cy116`) until the human next runs `node release.js --ota`. Added a
   permanent regression group `testDocumentStructure()` to `test/frontend.test.js`.
2. Fixed the harness's own auth-surface measurement (reviewer's stage-3 HIGH finding): `showAuth(fn)`
   takes a completion **callback**, not a mode string, so the old `A.ui.showAuth('login')` call
   silently rendered the **welcome** screen (not login) with the previous panel still open behind an
   unclosed modal — `axeViolations_auth: 5` was contaminated and mislabelled. `testSurfaces()` now
   closes panels first, opens the welcome screen for real, and clicks the actual "Log in" button to
   reach the login form; the single `auth` key is split into `axeViolations_authWelcome` /
   `axeViolations_authLogin`, both **1**, not 5 — confirming the reviewer's finding at the numeric
   level. Added `testBaselineRatchet()` (reviewer's MEDIUM finding) enforcing ratchet-down via
   `git show HEAD:...`; demonstrated it failing on a deliberately-raised value, then reverted.
3. Fixed the real markup defects: `type="button"` on all 32 static `<button>`s (an untyped button
   inside `renderAuth()`'s `innerHTML`-built form defaults to `submit` — an Enter keypress in a text
   field could trigger it); `aria-label="Your profile"` on `#btn-avatar` (title-only is not a valid
   accessible name per html-validate's `text-content` rule); `role="group"` on `#radar-dock`;
   `#race-hud` and `#radar-alerts` converted from `<div role="region">` to `<section>` (native
   landmark semantics, no JS/CSS depended on the tag — both are selected by `id` only); documented
   (code comment + here) the decision to **keep** `#search-results` as `<div role="listbox">` rather
   than converting to `<select>` — it's a real ARIA combobox with `ArrowUp`/`ArrowDown`/Enter keyboard
   handling in `js/ui.js:2856-2857`, ­converting it would rebuild working behaviour for no
   accessibility gain.
4. Re-baselined honestly (all values ratchet-down, two keys split): `htmlValidateErrors` 57→13,
   `axeViolations_auth` (5, contaminated) → `axeViolations_authWelcome`/`authLogin` (1/1, real).
   `BUGS.md`: ui-001 marked fixed (was already fixed pre-mission — verified at its new location
   `css/styles.css:1810`), ui-006 marked fixed (this stage — `#radar-alerts` now has both `aria-live`
   and a landmark role), ui-004 marked fixed (was already fixed pre-mission, verified this stage —
   both the ARIA attributes and the runtime `aria-expanded` toggle in `js/ui.js:2789` are present),
   added **ui-014** for the line-15 orphan (severity high, fixed), corrected drifted line numbers on
   ui-003/004/005/006/011/012/013 (their referenced lines moved because a 7-line justification comment
   was added above `#search-results`). `graphify update .` run — 3065 nodes, 5692 edges, 197
   communities.

## Aspect B — backend truth pass (cycle 51)

Anchor: the only Overpass lines production has ever logged are total failures, because
`server/overpass.js:219` logs nothing on success and `:203-211` discard every per-mirror reason. The
cycle-50 improve stage asked four questions; each is answered below with the literal command output
(2026-09-03 06:59–07:03Z; 4 of the ≤ 5 third-party requests used, no loops, no retries; 0 code changes).

### Q1 — Can the VPS reach the two mirrors?  YES — both `200` in ~1.5 s
```
$ deploy/live-deploy.sh diag   (remote cmd via B64=; one curl per mirror, --max-time 25, the proxy's own User-Agent)
https://overpass-api.de/api/interpreter -> http=200 total=1.573110s dns=0.001249s connect=0.313888s ip=65.109.112.52
  body: { "version": 0.6, "generator": "Overpass API 0.7.62.11 87bfad18", "osm3s": { "timestamp_osm_base": "2026-09-03T06:59:18Z", …
https://overpass.kumi.systems/api/interpreter -> http=200 total=1.290653s dns=0.667484s connect=0.762545s ip=2a0d:f302:126:78ea::1
  body: { "version": 0.6, "generator": "Overpass API 0.7.62.11 87bfad18", "osm3s": { "timestamp_osm_base": "2026-07-24T11:04:51Z", …
--- node/proxy env on VPS ---        (grep for HTTP(S)_PROXY / OVERPASS_* in convoy.env, names only)
(end env grep)                       → nothing set; node v22.22.3; IPv6 default route present
```
kumi is reached over IPv6 from the VPS and its data is six weeks stale (`timestamp_osm_base` 2026-07-24
vs overpass-api.de's 06:59 today) — a data-quality note for B4, not a failure.

### Q2 — Can this box reach them?  YES — both `200`
```
https://overpass-api.de/api/interpreter -> http=200 total=1.355130s dns=0.001411s connect=0.112368s ip=65.109.112.52
https://overpass.kumi.systems/api/interpreter -> http=200 total=3.868494s dns=0.003032s connect=0.094057s ip=193.219.97.30
  (this kumi node: timestamp_osm_base 2026-05-06 — four months stale)
```
⇒ Neither VPS egress nor the mirror list is broken *now*. Roadmap item B4 ("more mirrors") is not
indicated by anything measured. Whatever failed at 03:44 and 04:22 was transient or load-related on the
mirror side — and the current log cannot say which (Q4b).

### Q3 — Are the failing bboxes real riders?  NO — they are the intro globe animation's frames (the rider was real)
Full-precision journal (the directive quoted rounded values), plus who was online:
```
2026-09-03T03:44:12Z [overpass] all mirrors failed for enforcement 12.47951394968021,-2,16.47951394968021,2
2026-09-03T03:44:17Z [overpass] all mirrors failed for enforcement 16.14639614656451,-63.33097117985977,20.14639614656451,-59.33097117985977
2026-09-03T03:44:20Z [overpass] all mirrors failed for enforcement 12.81896281827137,-2,16.81896281827137,2
2026-09-03T03:44:24Z [overpass] all mirrors failed for enforcement -5.626689220224549,-62.77382510444278,-1.6266892202245486,-58.77382510444278
2026-09-03T03:44:25Z [overpass] all mirrors failed for enforcement -26.4808933627818,-2,-22.4808933627818,2
2026-09-03T03:44:28Z [overpass] all mirrors failed for enforcement -45.28780932180025,-2,-41.28780932180025,2
2026-09-03T04:22:48Z [overpass] all mirrors failed for enforcement 13.983772949840699,-2,17.9837729498407,2
03:42:45 Started convoy.service · 03:42:53 [join]/[leave] DeployCheck · 03:43:42 [join] Ivy (guest) — 1 online
03:46:45 [join] Ivy — 2 online · 03:47:15 [leave] Ivy — 1 online · 04:19:00 [leave] Ivy — 0 online
overpass lines since the 06:55:47 restart: 0
```
- `graphify path "sim.js" "overpass.js"` → `No directed path found`. `js/sim.js:158-166`: solo simulation
  is disabled in production (`enableSolo()` spawns nothing) and `js/ghost.js` never reads sim positions.
  The sim-rider hypothesis is refuted.
- The `enforcement` kind is sent only by `js/ghost.js` `fetchPolice()` (`grep -rn "api/overpass" js/` →
  ghost.js:34, routing.js:14). Its box is `viewBBox()` — the **map viewport**, clamped to `MAX_BBOX_DEG`
  (4°) around the view centre (ghost.js:98-110). When the viewport wraps the world, the clamped
  longitude bounds are −180..180, the centre is exactly 0, and the box becomes `lng −2..2`. Five of the
  seven failures have exactly that shape.
- The app boots in intro mode (`js/mapview.js:87-93`: `zoom: 1.1`, centre `[playerStart.lng, 22]`),
  drifts 8° east every 5 s (`startIntroSpin`, :1260-1274), and `landIntro` (:1278-1286) flies down to
  the first GPS fix. Every `moveend` emits `mapmoved` → `fetchPolice()` (ghost.js:575-578);
  `bboxChanged` passes whenever the collapsed centre moved > 0.6°, which the fly-down does on nearly
  every frame. The two non-zero-longitude boxes (18.1 N then 3.6 S, both at lng ≈ −61, five seconds
  apart) are mid-flight frames of that descent.
- Timing fits: Ivy joined at 03:43:42; the first failure logged at 03:44:12 and five more within 16 s,
  all inside the ~35 s intro. The 04:22:48 line is a fresh page open with 0 riders on the WebSocket
  (`/api/overpass` is anonymous HTTP) — a lng-0 world-view box again.

**User-facing severity: lower than the log volume suggests, but not zero.** Nobody was looking at the
Sahel or the mid-Atlantic, so the seven queries cost riders nothing directly; they cost upstream quota
(5–7 wasted 4°×4° queries per app open while the intro plays). The indirect cost is real: each failure
calls `backoffFail('police', 90 s)` (ghost.js:366), doubling per failure up to `BACKOFF_MAX_MS` =
15 min (ghost.js:280). Six failures in a row ⇒ the police/camera layer was silenced for up to
**15 minutes of Ivy's ride after landing at street level** — inferred from code + log timing, not
observed on the device.

### Q4 — Does `MAX_SPAN_DEG` reject the 4.0° boxes?  NO — `> MAX_SPAN_DEG + EPS`, EPS = 1e-6, already tested
```
$ node -e "…require('./server/overpass.js').parseBbox on the three logged boxes…"
[12.47,-2,16.47,2] latSpan= 3.9999999999999982 lngSpan= 4 parseBbox=> ACCEPTED
[16.14,-63.33,20.14,-59.33] latSpan= 4 lngSpan= 4 parseBbox=> ACCEPTED
[-5.62,-62.77,-1.62,-58.77] latSpan= 4 lngSpan= 4 parseBbox=> ACCEPTED
MAX_SPAN_DEG= 4
4.000000000000001 accepted? true
4.00001 accepted? false
```
`server/overpass.js:160-167` is the comparison (`(b.maxLat - b.minLat) > MAX_SPAN_DEG + EPS`), and
`test/overpass.test.js:85-101` ("The span limit is not tighter than what the callers clamp to") already
pins it. Stronger than the probe: the `all mirrors failed` line is printed at `:219`, *after*
`parseBbox` returned non-null at `:178-179` (a rejected box returns `bad-bbox` → HTTP 400, unlogged), so
every logged box passed the span check by construction. The one-character-bug hypothesis is refuted;
nothing to fix here in cycle 52.

### Q4b — So why did all seven fail?  Unknown — and that is the finding
`server/overpass.js:203-211`: a fetch exception → `continue` (reason dropped); `!res.ok` → `continue`
(status dropped — 429 slot exhaustion, 504 query timeout, 400 and 5xx all look the same); JSON/shape
failure → `continue` (dropped). The one log line carries kind and box but not which mirror, which
status, or how long each attempt took. The 30 s between Ivy's join and the first failure equals
`TIMEOUT_MS` (30 s), which *suggests* a mirror hung to timeout — a coincidence-grade inference, exactly
the kind the log should make unnecessary.

### What cycle 52 fixes first, and why
**Status (cycle 52 stage 26): both done — server-031 and frontend-019 in BUGS.md, details under "Current milestone".**

**Server-only (Lane B): make `server/overpass.js` say why a mirror failed** — one `console.warn` per
failed attempt (mirror index, HTTP status or error name, elapsed ms) and a per-kind ok/fail counter
surfaced through `stats()`, with a mocked-`fetch` test in `test/overpass.test.js` (the harness already
stubs `global.fetch` at `:113`). Because: production has logged 7 failures and 0 successes since the
mission began and cannot tell "kumi was down" from "we were rate-limited" from "a 4° enforcement query
takes > 30 s"; every other Overpass decision (B4 mirrors, timeouts, the client backoff) is a guess until
that line exists. ≤ 5 real requests, mocked tests, no loops.

**Second, an improve-stage decision (client, Lane A, needs a stamp bump):** skip static-POI fetches while
the viewport is wider than the clamp (`viewBBox()` collapsing the world to a 4° box at lng 0 is never a
view a rider is looking at) and stop the intro fly-down from queueing a burst — removes 5–7 wasted
upstream queries per app open **and** the up-to-15-minute backoff it inflicts on the rider's real area.

Also carried into aspect B from the cycle-50 review (LOW, real, un-fixed): `overlayDismissable`
staleness (`js/ui.js:3089,3437`) and `#toasts` eviction of an inerted invite toast — both client-side,
both wait for a Lane A cycle.

## C1 measured baseline (aspect C — measured 2026-09-03 by the cycle-56 improve stage, `stages/0044-c056-improve.md` §2; pinned in cycle 57)
Measure C2 / C3 against these, not against estimates. Method: the real tree served by a logging static server on `:5199`,
loaded by the headless Chromium below with `--host-resolver-rules="MAP * 127.0.0.1, EXCLUDE localhost"` (every external
origin blackholed, only same-origin traffic counted); the CSP `<meta>` stripped for the timing probe (the
`test/browser.test.js` `buildFixture()` trick). Scratch lived in `/tmp/c1meas/`, outside the repo.
- **First load:** **46 same-origin asset requests** (1 HTML + 1 CSS + 44 JS, all `defer`, nothing render-blocking) plus
  **3 API calls fired during boot** before the rider touches anything (`/api/tts/health` ×1, `/api/telemetry` ×2).
  External: ~5 more (`fonts.googleapis.com` CSS + 2 `fonts.gstatic.com` woff2, `cdn.jsdelivr.net` MapLibre CSS + JS) plus
  map tiles.
- **Bytes:** 45 stamped assets raw 1111998 / gzip ~349.8 KB + `index.html` ~6.4 KB gzip → **~348 KB compressed** on a
  first visit (plan v1 M-C target ≤ 300 KB). `js/ui.js` alone is 217854 raw / 61236 gzip — 17 % of the payload; its
  split is plan v1 M7 / aspect E1, never a bundler.
- **Boot timing (desktop container, localhost, zero latency):** DOMContentLoaded **705 ms**, load 726 ms, **2 long
  tasks**; several times worse on a mid-range phone over mobile data. A first-time visitor downloads and executes 100 %
  of the app to be shown a login form.
- **Fetch deadlines — fixed in cycle 57:** 22 of 23 client `fetch` sites had no `AbortSignal` while 5 of 5 server
  upstream families were guarded; five map layers set a bbox latch before the fetch and clear it only in `.catch()`, so a
  stalled response killed that layer for the session. Now 0 bare sites outside the two allowlisted (`test/fetchtimeout.test.js`).
- **Idle cost — filed as frontend-021 for C2:** 22 `setInterval` timers in 12 files; nine timer-owning files never read
  `document.hidden` (`ghost.js` 5, `overlays.js` 5, `scanners.js` 1, `voice.js` 2, `radar.js` / `clock.js` / `state.js` /
  `ui.js` / `race.js` 1 each). Product carve-out: `fetchPolice` / `fetchWaze` are the alerting path — never blanket-pause them.
- **Reduced motion:** correct as written (`js/state.js:30-31` seeds `settings.anim` from `prefers-reduced-motion`;
  `css/styles.css:74-94` covers `[data-anim="off"]` and the pre-`data-anim` window). Do not "fix" it.
- **Pinned in `test/frontend-baseline.json` (cycle 57, `testBootCost()`):** `bootAssetRequests` 46,
  `bootAssetGzipBytes` 357743 (zlib level 9, `index.html` stamps normalised — the number the suite computes; +1.5 KB over
  the audit's figure for the `fetchT` helper and its comment), `bootExternalOrigins` 5. Ratchet-down only from cycle 58 — **and cycle 58 hit it:** the C2 client added ~1.6 KB gzip, so `bootAssetGzipBytes` was retired (never raised) for `bootAssetGzipBudget` 359424, the measured 359370 rounded up to the next whole KiB; the next stage that spends the 54 B of headroom must make the same conscious decision again, in the open.
- **Restated target (cycle-56 improve §6):** since cycle 54 the 45 stamped assets are `immutable`, so a repeat visit is
  1 request; the rider-felt number is time-to-interactive on a phone. "≤ 30 requests" stays aspect C's closing
  criterion, but the stage that spends a cycle on it should optimise the 348 KB / 705 ms and let the request count fall
  out of that — never by adding a bundler.

## Headless Chromium — working recipe (M2 UN-DROPPED cycle 3 stage 14; do not re-run the download,
reuse what's already on this box)

**Both premises M2 was dropped on were false.** "Needs root" was falsified by the stage-13 IMPROVE
directive (Finding F: `apt-get download` + `dpkg -x` into `$HOME` needs no sudo). Stage 14 went
further: the "20 missing shared libraries" figure was never actually measured on this box — once a
real Chromium binary was downloaded and `ldd`'d, **zero** libraries were missing. No extraction
step was needed at all.

```bash
# 1. Chromium itself does NOT resolve via plain `npx playwright install` outside a project that
#    already depends on playwright (it just prints a warning and installs nothing). Give it a
#    scratch project instead — do not run this inside /opt/data/convoy or touch its package.json.
mkdir -p /tmp/pw-scratch && cd /tmp/pw-scratch && npm init -y >/dev/null
npm install playwright --no-audit --no-fund      # ~2s, 2 packages
node ./node_modules/.bin/playwright install chromium   # ~184 MB download, ~15s on this box's link
# lands in ~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome

# 2. Confirm what's missing (informational this time — nothing was)
BIN=$(find ~/.cache/ms-playwright -name chrome -type f | head -1)
ldd "$BIN" | grep "not found"     # → empty on this box, 2026-09-03

# 3. Run it — --no-sandbox is required (no user-namespace privileges), --disable-gpu avoids a
#    GPU-process crash loop under headless with no real GPU
"$BIN" --headless --no-sandbox --disable-gpu --dump-dom about:blank
# → <html><head></head><body></body></html>   (dbus/GLib-GIO-CRITICAL stderr lines are harmless —
#   no system bus in this container, Chromium falls back fine)

# 4. Screenshot the real app (same recipe, add the app's own server)
cd /opt/data/convoy && python3 -m http.server 5173 &
"$BIN" --headless --no-sandbox --disable-gpu --window-size=390,844 --hide-scrollbars \
  --screenshot=/tmp/shot.png http://localhost:5173/
```

**What stage 14 saw (screenshots not kept — they were `/tmp` scratch, not committed):**
- The map shell renders: dock labels (MAP/NEARBY/CONVOY/PROFILE) legible at the 12px floor from
  cycle 2, chips readable, layout intact at 390×844.
- `.rd-limit` (`#radar-dock`, toggled via `document.body.classList.add('radar-on')` — real Ghost
  Mode requires a live GPS fix this harness doesn't have) measures **59.2×48px**, against a CSS
  `min-width: 46px` — confirms **ui-020** exactly as reasoned: it grows, doesn't clip, because the
  rule is `min-width` not `max-width`.
  - Deep-cropped screenshots of the live `#radar-dock` were an unreliable blown-out blur — almost
    certainly headless software-WebGL/`backdrop-filter` interacting badly with no real GPU, not a
    finding about the real bug. The numeric measurement above is the trustworthy result; a
    from-image visual read of the radar dock specifically still wants a real browser + real GPU.
- An isolated `transform: scaleX(0.35)` progress bar (built with the same mechanism cycle 2's fix
  uses, injected via a scratch `<div>` so it didn't depend on live routing/drag-race state)
  screenshotted clean — a solid fill with a normal highlight at the leading edge, no visible glow
  smearing or compression. Reasonable evidence **ui-021** is fine, though not from the actual
  in-app element (same headless WebGL/backdrop-filter caveat as above would apply to that).

**Reuse this for the next stage that wants a screenshot** — the browser is already downloaded
(`~/.cache/ms-playwright`), do not redownload. Still no `playwright` in `package.json` (guardrail from
the stage-13 directive). **Since cycle 50 stage 18 there IS a permanent, skippable suite:**
`test/browser.test.js` (registered in `test/run.js`) drives the `chrome-headless-shell` binary with
`--dump-dom` and no library, over a `file://` fixture built from the real `index.html` (CSP meta and
external `<link>`s stripped, the page's own module scripts in order minus `app.js`, an in-page probe
writing JSON into a `<pre>`). It SKIPs with exit 0 when no `chromium_headless_shell-<rev>` directory
exists (or `CONVOY_CHROMIUM` points at a missing file). Copy its `buildFixture()`/`runChromium()`
pattern for any future browser-level check instead of a scratch directory.

**Next:** ui-021 (progress-bar rendering at phone width) still wants a human's eyes or a real GPU; the
headless recipe above is good for layout/hit-test questions, unreliable for anything over the MapLibre
canvas or behind `backdrop-filter`.

## Progress log
- 2026-09-03 stage 1 (PLAN): plan written; skills installed; baselines measured; STATE.md created. No app code changed.
- 2026-09-03 stage 2 (IMPLEMENT, M1): built `test/frontend.test.js` + `test/frontend-baseline.json`;
  wired into `package.json`/`test/run.js`; `jsdom`/`axe-core`/`html-validate` added as devDependencies.
  `npm test` 21→22 suites. No app code changed — M1 was harness-only by design.
- 2026-09-03 stage 3 (REVIEW): verified stage 2's claims; found the auth-surface harness contamination
  (HIGH) and the missing ratchet enforcement (MEDIUM); flagged (again) that the impeccable skill's
  `context.mjs` prints prompt-injection-shaped text.
- 2026-09-03 stage 4 (IMPROVE): traced the 57 html-validate errors to their root causes; found the
  line-15 orphan markup defect (real, shipped, undiscovered by 3 prior manual passes); confirmed the
  reviewer's auth-harness finding at the source (`js/ui.js:2944`/`2949`); wrote the 4-task work order
  executed in stage 5; amended two plan targets (see "Amended targets" above).
- **2026-09-03 stage 5 (IMPLEMENT, this stage): executed all 4 tasks.** `htmlValidateErrors` 57→49
  (Task 1, delete orphan) →13 (Task 3, button types + aria fixes). `axeViolations_auth` 5 (contaminated)
  → `axeViolations_authWelcome`/`authLogin` 1/1 (real, Task 2). `npm test`: 22 suites unchanged,
  **40/40 checks** (corrected cycle 2 stage 8 — this entry previously said 38/38, which was wrong;
  was 26 — 14 new: 3 document-structure assertions, 2 for the auth surface split, 9 ratchet-guard
  key assertions). `BUGS.md`: 13→14 entries, 4 marked fixed.
  **This is the first stage of the mission that changed `index.html` or `js`/`css` behaviour** — the
  cadence rule from stage 4's IMPROVE ("every cycle must ship at least one app-code change") is met.
- 2026-09-03 stage 6 (REVIEW): verified stage 5's claims; found the true check count was 40 (not 38)
  and that `testBaselineRatchet()` iterates the `_comment` string key, a latent bug not yet triggered.
- 2026-09-03 stage 7 (IMPROVE): ran axe directly (harness only prints violation detail on failure)
  and found all 11 baseline axe violations trace to 5 code sites: `#radar-dock` (`index.html:241`,
  `region` on all 6 surfaces) and `mkRow()`/`mkField()`/`.dot-color`/`.emoji-btn` (`js/ui.js`, 59
  failing nodes on profile+convoy). Wrote the 4-task work order executed in stage 8.
- **2026-09-03 stage 8 (IMPLEMENT, this stage): executed all 4 tasks — see the new "Current
  milestone" entry below for full detail.** Headline: `axeViolations_*` **11 → 0 across all six
  surfaces**. `npm test`: 22 suites, **41/41 checks** (39 after Task 1a's `_comment` fix removed a
  bogus assertion, +2 for the new duplicate-id regression test). `BUGS.md`: 14→19 entries (5 new,
  all fixed), plus the stats-table arithmetic error fixed. `graphify update .`: 3067 nodes, 5697
  edges, 197 communities.
- 2026-09-03 stage 9 (REVIEW): verified stage 8's claims (zero BLOCKER/HIGH/MEDIUM findings — first
  clean review of the mission); reiterated the standing mission-fit gap: 9 stages in, `css/styles.css`
  had never changed, so nothing shipped was visible to a sighted user. Directed the next IMPROVE role
  to commit to a CSS readability pass rather than deferring it a third time.
- 2026-09-03 stage 10 (IMPROVE): ran two font-floor experiments (11px vs 12px) to falsify a suspected
  relabelling trap before writing the work order — found the trap does not exist, and that 12px
  clears both `undersized-ui-text` and `tiny-text` (37→22, measured, not predicted). Traced all 5
  `layout-transition` findings to their single JS writers each. Wrote the 4-task directive executed
  in stage 11; explicitly deferred `ui-003`/`ui-013` a fourth time on a stated capacity reason, and
  named it as the mandatory first item of cycle 3.
- **2026-09-03 stage 11 (IMPLEMENT, this stage): executed all 4 tasks — see "Current milestone"
  above for full detail.** Headline: `detectorWarnings` **37 → 17**, the first CSS change of the
  mission. `npm test`: 22 suites, **43/43 checks** (+2 for `testFontSizeFloor()`). `BUGS.md`: 19→21
  entries (+2, both visual-verification-pending, neither fixed nor broken), stats table updated.
  New file `css/DESIGN-DECISIONS.md`. `graphify update .`: 3071 nodes, 5700 edges, 198 communities.
- 2026-09-03 stage 12 (REVIEW): verified stage 11's claims (clean); reiterated the standing
  ui-003/ui-013 sequencing gap (fourth deferral) and a BUGS.md Stats table arithmetic drift found
  independently (Frontend/Server rows undercounted).
- 2026-09-03 stage 13 (IMPROVE): measured the real magnitude of ui-013 (133 phantom tab stops, not
  the assumed ~4) with a throwaway jsdom probe; confirmed jsdom 30.0.1 implements no `inert`
  focus-blocking (dictates the test design); traced `#onboarding`'s gate-vs-overlay split and found
  ui-003's "body scroll not locked" sub-claim already false; found a latent adjacent keydown bug
  while reading `wireDock`; and — the headline finding — proved "Chromium needs root" false with a
  live `apt-get download`/`dpkg -x` test. Wrote the 5-task directive executed in stage 14.
- **2026-09-03 stage 14 (IMPLEMENT, this stage): executed all 5 tasks — see "Current milestone"
  above for full detail.** Headline: `ui-003`/`ui-013` shipped (fourth-deferral item, finally
  closed) and M2 (headless Chromium) came back from "formally dropped" to working, with a real
  measurement resolving one of the two remaining visual-verification-pending bugs. `npm test`: 22→23
  suites (+1, `test/bugstats.test.js`, **11/11 checks**); `frontend.test.js` **43→56 checks** (+3
  `testClosedPanelsInert`, +10 `testModalFocusTrap`; each suite's own count is what its
  process prints — they don't sum into one grand total). `BUGS.md`: 97 entries (unchanged — this
  stage fixed 2 existing ones and corrected the Stats table's arithmetic, it didn't add any), 13 now
  fixed (was 11). `graphify update .`: 3089 nodes, 5742 edges, 198 communities.

- 2026-09-03 cycle 50 stage 18 (IMPLEMENT): ui-003b fixed (`shellTrapped`), `#toasts` scoped, `testShellRestoreInvariant` (+22, proved-to-fail-first 18→0; row k = pending-close-timer gate blanking, one-line `cancelOverlayClose()` in `beginModalGate`), `test/browser.test.js` (24th suite, real Chromium hit-test), stamps `cy116→cy117`, OTA bundle 1.0.117 packed locally. Nothing deployed — push stage next.
- 2026-09-03 cycle 50 stages 19-21 (REVIEW → IMPROVE → PUSH): review SHIP-QUALITY (reproduced the
  18-stray-inert failure from a scratch clone, 0 BLOCKER/HIGH); improve pre-ran every runbook gate and
  wrote the cycle-51 work order; **PUSH at 06:56Z — the first release of this mission.** GitHub
  `a48c025..5028570`; Lane A `deploy/live-deploy.sh release -- --ota`. Attempt 1 deployed the site but the
  OTA publish crashed (`release.js` uploaded to `/var/lib/convoy/ota`, which the server never reads, and
  chained `.catch()` on ssh2's callback API) — fixed in `5028570`, attempt 2 `✓ Released in 10s`. **What
  reached riders:** web `cy117` / OTA `1.0.117` = ui-003 focus trap, ui-003b lockout fix, ui-013 (133
  phantom tab stops), ui-014 orphan markup, ui-015..019 (59 unnamed controls), the 12px typography floor,
  the 5-site progress-bar transform fix. Verified: `/api/health` ok, `/api/ota` current 1.0.117, served
  `cy117`, livetest PASS. Stray `/var/lib/convoy/ota` from attempt 1 removed on the VPS (never read).
- 2026-09-03 cycle 51 stage 22 (IMPLEMENT): aspect A closed, aspect B opened; B1 Overpass truth pass
  measured (4 third-party requests, 0 code changes) — see "Aspect B — backend truth pass (cycle 51)".
  Standing rule added (operating contract rule 7): a shipping cycle ends with local stamp == production.
- **2026-09-03 stage 26 (IMPLEMENT, cycle 52): B2.** `server/overpass.js` logs per-mirror failure reasons +
  elapsed ms and session tallies, warns on partial failures, `stats()` gains counters (server-031);
  `js/ghost.js` `clampBBox` returns null for a view wider than 4× the clamp, killing the intro globe's
  `-2…2` junk queries (frontend-019). `npm test` 24→25 suites (`ghostbbox.test.js` 18), `overpass.test.js`
  37→66, BUGS.md 98→100, stamp `cy117→cy118`, nothing deployed.
- **2026-09-03 stage 38 (IMPLEMENT, cycle 55): the chat outage.** `server/server.js` chat fan-out sent `t2: now`
  (undefined since the initial commit) → every live convoy chat line died in the dispatcher's catch (server-032,
  critical, fixed: `t2: entry.t`); a mid-boot restart was mis-reported as `SUPABASE_DB_URL` (server-033, low, fixed).
  New class gate `test/globals.test.js` (acorn-globals, 112 files, 130 checks; RED on `now` first), `serverpolicy`
  77→95 (X1 executed chat lift + mutation guard, X2), `livetest` asserts chat delivery, runbook §2 reads the journal.
  `npm test` 26→27 suites, BUGS.md 100→102, no stamp bump (`cy118` == production), nothing deployed.
- 2026-09-03 stage 46 (IMPLEMENT, cycle 57, aspect C / C1): `A.util.fetchT()` + `FETCH_TIMEOUT` table in `js/util.js`,
  20 `fetch` sites converted (+ `telemetry.js` inline), `test/fetchtimeout.test.js` (28th suite, RED 16/17 first, 39/39 after,
  two mutations caught), `testBootCost()` + 3 baseline keys, BUGS.md 105 (frontend-020 FIXED, frontend-021 filed for C2),
  stamp `cy118 → cy119` / OTA `1.0.119`. Report: `stages/0046-c057-implement.md`.
- 2026-09-03 stage 63 (IMPLEMENT, cycle 61, aspect C / C4b): the chat-log freeze at message 100 (ui-002 re-filed, `js/ui.js` `renderChatInto`
  keyed on entry identity, `js/party.js` `pushChat()` / `CHAT_MAX` the one ring for all four push sites, `js/net.js` delegates) with
  `test/chatlog.test.js` (32nd suite, RED 22/13 first, 35/35 after); the UI/UX truth pass (`STATUS_SECTIONS += 'UI/UX'`, 5/17/1, ui-022 filed);
  ui-008/011/012 fixed with `testAriaState()` (`frontend.test.js` 86 → 102). Bytes 358321 / 358400 (79 B left). Stamp `cy122 → cy123` / OTA
  `1.0.123`. Report: `stages/0064-c061-implement.md` (stage 63 did the work, commit `5b3d965`, and ran out of budget before writing its
  report; stage 64 re-verified it and wrote the report — no code change).

## How to run (solo mode — no Supabase needed)
```bash
cd /opt/data/convoy
python3 -m http.server 5173     # open http://localhost:5173 (riders simulated on-device)
```
`node server/server.js` exits with "Supabase Auth is not configured" without `server/.env`; do not fabricate keys.
Production is https://odoreeci.tech (Caddy → Node). Only the Forge **push** stage deploys, via `deploy/live-deploy.sh`
following `deploy/PUSH-RUNBOOK.md`; implement/review/improve never run `update`/`release` (read-only `diag` is fine).

## How to test
```bash
npm test                 # 28 Node suites, no network (frontend.test.js; globals.test.js = undefined-identifier gate; fetchtimeout.test.js = every client fetch has a deadline)
npm run test:frontend    # jsdom + axe-core + html-validate + detector + ratchet guard, gated on test/frontend-baseline.json
node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js | grep -c '"antipattern"'
graphify query "<area>"  # before editing;  graphify update .  # after editing
```
Test baseline: see "Test baseline" below.

## Skills to use (installed on this box)
- `/opt/data/skills/creative/impeccable/` — design director; `reference/audit.md`, `polish.md`, `typeset.md`, `craft-floor.md`; detector `scripts/detect.mjs`; run `scripts/context.mjs --target <file>` once per session.
- `/opt/data/skills/web-quality/accessibility/SKILL.md`, `/opt/data/skills/web-quality/performance/SKILL.md` (Addy Osmani, MIT).
- `/opt/data/skills/playwright/` — browser CLI; not needed here — a headless Chromium already runs on this box without it (see "Headless Chromium — working recipe"), and `playwright` must never enter `package.json` (plan v2 guardrail 5).
- `/opt/data/skills/creative/{anti-ui-slop,ui-design,ui-radar}/` — one playbook per request; free UIZZE search.
- `/opt/data/skills/software-development/headless-cli-setup/` — no-sudo/no-TTY installs.

## Invariants / guardrails (see plan §7)
- All `?v=cyNNN` stamps in `index.html` identical (45 occurrences). Bumped **`cy116` → `cy117`** in cycle 50 stage 18 — the mission's first bump. Every later implement stage that touches `index.html`/`css/`/`js/`/`legal/` bumps by exactly one (operating-contract rule 2); server-only stages do not.
- Two CSP allowlists (`index.html` meta + `server/server.js`) stay untouched; `test/serverpolicy.test.js` must pass. **Not touched this stage.**
- Solo mode via a static server must keep working; `www/` is generated (`npm run copy-web`), never edited.
- Product name stays as-is ("SLIPSTREAM" in UI vs "Convoy" in repo is a human decision — surface it in reviews).
- `test/frontend-baseline.json` is now ratchet-enforced by code (`testBaselineRatchet()`), not just convention.

## Human-only actions (surface every review)
1. ~~`node release.js --ota` to ship web changes — 18 stages, nothing shipped.~~ **DONE 2026-09-03 06:56Z by the
   cycle-50 push stage** (`stages/0021-c050-push.md`): `deploy/live-deploy.sh release -- --ota` published
   `cy117` / OTA `1.0.117`. ui-003, ui-003b, ui-013, ui-014, ui-015..019, the typography floor and the
   progress-bar fix are live at https://odoreeci.tech and offered to installed APKs via `/api/ota`. Shipping
   no longer needs a human — the push stage runs every cycle. What still does: v2 items 1-2 (keystore,
   `convoy.env`) and the 60-second real-browser look (v2 item 4), now that there is a release to look at.
2. ~~Install Chromium's shared libraries (needs root).~~ **FALSIFIED, twice over, this stage.**
   Neither "needs root" (disproven cycle-3-stage-13) nor "20 missing shared libraries" (disproven
   this stage — the real count was **zero**) was true. A headless Chromium already runs on this box
   with no system changes; see "Headless Chromium — working recipe" above for the exact commands.
   **ui-020 is now answered** (measured: `.rd-limit` renders at 59.2px against its 46px min-width —
   it grows as designed). **ui-021 got a partial, inconclusive look** (an isolated progress-bar
   element screenshotted clean; the real in-app radar dock did not render cleanly under headless
   software WebGL/`backdrop-filter` — an environment artifact, not evidence either way). What's
   left for a human: a 30-second glance at the real routing/drag progress bars at phone width in an
   actual browser would close ui-021 with more confidence than the headless attempt could.
3. Supabase keys in `server/.env` only if live-mode local testing is wanted.
4. Product name decision (Slipstream vs Convoy). Unresolved for 13 stages, still not an agent's call.

## Test baseline
`npm test` on 2026-09-03 00:44Z (planner stage, before any code change): **All 21 suites passed, 184 checks passed.**
`npm test` on 2026-09-03 (implementer stage 2, after M1): **All 22 suites passed** (26 checks in `frontend.test.js`).
`npm test` on 2026-09-03 (implementer stage 5, after Tasks 1-4): **All 22 suites passed, all 40 checks
passed** (corrected — this line previously said 38, which was wrong; frontend.test.js grew from
26→40 checks: +3 document-structure assertions, +2 for the auth surface split, +9 ratchet-guard key
assertions).
`npm test` on 2026-09-03 (implementer stage 8, after Tasks 1-4): **All 22 suites passed, all 41
checks passed** (frontend.test.js: 40→39 from Task 1a removing the bogus `_comment` ratchet
assertion, 39→41 from Task 3's new `testGeneratedIdsUnique()` regression group, 2 assertions).
`npm test` on 2026-09-03 (implementer stage 11, after Tasks 1-4): **All 22 suites passed, all 43
checks passed** (frontend.test.js: 41→43, +2 from the new `testFontSizeFloor()` group). `npm run
test:frontend` measured counts unchanged except `detectorWarnings: 37→17`. Keep both counts (suites,
checks) from going down.
`npm test` on 2026-09-03 (implementer stage 14, after Tasks 1-4): **All 23 suites passed** (22→23,
new `test/bugstats.test.js`, 11/11 checks). `frontend.test.js`: 43→56 checks (+3
`testClosedPanelsInert`, +10 `testModalFocusTrap`). Each suite's own check count is printed by that
suite's own process — `test/run.js` does not sum them into one grand total; read the count next to
the relevant suite's name in the full `npm test` output, not the last line printed (which is
whichever suite happens to run last — `frontend.test.js`). `npm run test:frontend` measured counts
**unchanged** on all 7 baseline keys (`htmlValidateErrors` 13, all `axeViolations_*` 0,
`detectorWarnings` 17) — expected: Tasks 1-2 fixed a keyboard-only defect none of those gates can
see (Finding C in the stage-13 directive). Keep suite count, every per-suite check count, and the 7
baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 18, cycle 50, after Tasks 1-5): **All 24 suites passed**
(23→24, new `test/browser.test.js`, 5/5 checks on this box; prints `SKIP …` and exits 0 where the
headless Chromium is absent, so the suite count stays 24 everywhere). `frontend.test.js`: 56→**78**
checks (+22 `testShellRestoreInvariant`). `bugstats.test.js` 11/11 (98 bugs). `npm run test:frontend`
measured counts **unchanged** on all 7 baseline keys (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6,
`detectorWarnings` 17) — expected: an `inert` bug is invisible to every static gate. Keep suite count
(24), every per-suite check count, and the 7 baseline keys from going down.
`npm test` on 2026-09-03 ~07:00Z (implementer stage 22, cycle 51, no app code changed): **All 24 suites passed**,
`frontend.test.js` 78, `browser.test.js` 5/5, `bugstats.test.js` 11/11 — unchanged, as the directive required.
`npm run test:frontend` 7 baseline keys unchanged (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6,
`detectorWarnings` 17). Nothing may go down from here.
`npm test` on 2026-09-03 (implementer stage 26, cycle 52, after Tasks 1-4): **All 25 suites passed** (24→25,
new `test/ghostbbox.test.js`, 18/18 checks). `overpass.test.js` 37→**66** (+29, "A failed mirror says which
one and why"). `frontend.test.js` 78 (unchanged), `browser.test.js` 5/5, `bugstats.test.js` 11/11 (**100**
bugs). `npm run test:frontend` 7 baseline keys **unchanged** (`htmlValidateErrors` 13, `axeViolations_*`
0 ×6, `detectorWarnings` 17) — expected: Task 2 touched no markup. Keep suite count (25), every per-suite
check count, and the 7 baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 30, cycle 53, after Tasks 1-4, server-only): **All 25 suites passed**
(unchanged count). `serverpolicy.test.js` 39 → **55** (+16, group W1 incl. 6 executed-gate checks).
`bugstats.test.js` 11 → **20** (+9, B3 ledger + anti-rot + roll-up; still **100** bugs). `frontend.test.js` 78,
`overpass.test.js` 66, `ghostbbox.test.js` 18, `browser.test.js` 5/5 — all unchanged. `npm run test:frontend`
7 baseline keys **unchanged** (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6, `detectorWarnings` 17) —
expected: no web file touched. Stamp deliberately **not** bumped: `45 ?v=cy118` == production `cy118`. Keep suite
count (25), every per-suite check count, and the 7 baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 34, cycle 54, after Tasks 1-3, server-only): **All 26 suites passed**
(25→26, new `test/httpcache.test.js`, **41/41** checks, registered after `serverpolicy.test.js`). `serverpolicy.test.js`
55 → **77** (+22: group H1 11, group D1 11 incl. 4 executed checks). `bugstats.test.js` 20/20 (still **100** bugs;
roll-up now 6/24/4). `frontend.test.js` 78, `overpass.test.js` 66, `ghostbbox.test.js` 18, `browser.test.js` 5/5 — all
unchanged. `npm run test:frontend` 7 baseline keys **unchanged** (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6,
`detectorWarnings` 17) — expected: no web file touched. Stamp deliberately **not** bumped: `45 ?v=cy118` == production
`cy118`. Keep suite count (26), every per-suite check count, and the 7 baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 38, cycle 55, after Tasks 1-5, server-only): **All 27 suites passed**
(26→27, new `test/globals.test.js`, **130/130** checks, registered after `httpcache.test.js`; it was 3 failed / 127
passed against the unfixed server, naming `server/server.js: now`). `serverpolicy.test.js` 77 → **95** (+18: group X1
12 incl. 7 executed + the mutation guard, group X2 6 incl. 2 executed; `executed:` lines 9 → 18; 11 failed / 84 passed
against the unfixed server). `bugstats.test.js` 20/20 (**102** bugs; roll-up 6/26/4). `frontend.test.js` 78,
`httpcache.test.js` 41, `overpass.test.js` 66, `ghostbbox.test.js` 18, `browser.test.js` 5/5 — all unchanged.
`npm run test:frontend` 7 baseline keys **unchanged** (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6,
`detectorWarnings` 17) — expected: no web file touched. Stamp deliberately **not** bumped: `45 ?v=cy118` == production
`cy118`. Keep suite count (27), every per-suite check count, and the 7 baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 42, cycle 56, after Tasks 1-4, server-only): **All 27 suites passed**
(unchanged count). `serverpolicy.test.js` 95 → **120** (+25: group Y1 — 2 lift checks, 12 executed incl. the mutation
guard, 11 structural; 15 failed / 105 passed against the unfixed server). `overpass.test.js` 66 → **96** (+30: the
server-034 group — executed demote / never-skip / clear-on-success, 7 pure `mirrorOrder(now)` checks, surface, source
pins, a regression pin; 18 failed / 72 passed against the unfixed module; the original 66 unchanged). `bugstats.test.js`
20/20 (**104** bugs; roll-up 5/28/4). `globals.test.js` 130/130, `httpcache.test.js` 41, `frontend.test.js` 78,
`ghostbbox.test.js` 18, `browser.test.js` 5/5 — all unchanged. `npm run test:frontend` 7 baseline keys **unchanged**
(`htmlValidateErrors` 13, `axeViolations_*` 0 ×6, `detectorWarnings` 17) — expected: no web file touched. Stamp
deliberately **not** bumped: `45 ?v=cy118` == production `cy118`. Keep suite count (27), every per-suite check count,
and the 7 baseline keys from going down.
`npm test` on 2026-09-03 (implementer stage 46, cycle 57, after Tasks 1-4, WEB edit): **All 28 suites passed** (27 → 28:
new `test/fetchtimeout.test.js`, **39/39**, registered after `ghostbbox.test.js`; 16 failed / 17 passed against the unfixed
tree). `frontend.test.js` 78 → **83** (+5: `testBootCost()` — 2 structural + 3 new baseline keys). `globals.test.js`
130 → **131** (one more file scanned). `bugstats.test.js` 20/20 (**105** bugs; roll-up 5/28/4 unchanged — Server/Runtime
untouched). `serverpolicy.test.js` 120, `overpass.test.js` 96, `httpcache.test.js` 41, `ghostbbox.test.js` 18,
`browser.test.js` 5/5 — unchanged. `npm run test:frontend` 7 old keys **unchanged** (`htmlValidateErrors` 13,
`axeViolations_*` 0 ×6, `detectorWarnings` 17) + 3 new keys (`bootAssetRequests` 46, `bootAssetGzipBytes` 357743,
`bootExternalOrigins` 5). Stamp bumped `cy118 → cy119` (45×), OTA `1.0.119`; production is `cy118` → LOCAL > PROD by
exactly one, Lane A. Keep suite count (28), every per-suite check count, and the 10 baseline keys from going the wrong way.
`npm test` on 2026-09-03 (implementer stage 50, cycle 58, after Tasks 1-4, WEB edit): **All 29 suites passed** (28 → 29: new
`test/partyresume.test.js`, **73/73**, registered after `fetchtimeout.test.js`; **49 failed / 24 passed against the unfixed tree**).
`globals.test.js` 131 → **132** (one more file scanned). `frontend.test.js` 86 → **85** at the pre-commit run (`bootAssetGzipBytes`
retired, `bootAssetGzipBudget` new — the ratchet check for the retired key is gone and the new key's ratchet check appears only after
Forge's commit, so expect **86** post-commit, the cycle-57 review's explanation). `bugstats.test.js` 20/20 (**108** bugs; roll-up
5/29/4). `net.test.js` 7, `serverpolicy.test.js` 120, `fetchtimeout.test.js` 39, `overpass.test.js` 96, `httpcache.test.js` 41,
`ghostbbox.test.js` 18, `browser.test.js` 5/5 — unchanged. `npm run test:frontend` 9 old keys **unchanged** (`htmlValidateErrors` 13,
`axeViolations_*` 0 ×6, `detectorWarnings` 17, `bootAssetRequests` 46, `bootExternalOrigins` 5) + `bootAssetGzipBudget` 359424 replacing
`bootAssetGzipBytes` 357743. Stamp bumped `cy119 → cy120` (45×), OTA `1.0.120`; production served `cy119` → LOCAL > PROD by exactly one,
Lane A. Keep suite count (29), every per-suite check count, and the 10 baseline keys from going the wrong way.
`npm test` on 2026-09-03 (implementer stage 54, cycle 59, WEB edit): **All 30 suites passed** (29 → 30: new `test/visibility.test.js`,
**52/52**, RED 24 failed / 23 passed first); `globals.test.js` 132 → **133**; `frontend.test.js` 86; `bugstats.test.js` 20/20 (108 bugs).
`npm test` on 2026-09-03 (implementer stage 59, cycle 60, after Tasks 1-4, WEB edit): **All 31 suites passed** (30 → 31: new
`test/domids.test.js`, **22/22**, registered after `visibility.test.js`; **3 failed / 19 passed with `id="eta-card"` renamed**, green
again on revert). `globals.test.js` 133 → **134** (one more file scanned). `bugstats.test.js` 20 → **21** (`STATUS_SECTIONS` += Frontend;
108 bugs, 61 statused, roll-up 5/50/6/61). `frontend.test.js` **86** (`bootAssetGzipBudget` ratcheted DOWN 359424 → 358400, measured
357786 — a ratchet-down is free). `visibility.test.js` 52, `net.test.js` 7, `partyresume.test.js` 73, `riderarrows.test.js` 28,
`voice.test.js` 127, `serverpolicy.test.js` 120, `fetchtimeout.test.js` 39, `overpass.test.js` 96, `httpcache.test.js` 41,
`ghostbbox.test.js` 18, `browser.test.js` 5/5 — unchanged. `npm run test:frontend` 9 keys **unchanged** (`htmlValidateErrors` 13,
`axeViolations_*` 0 ×6, `detectorWarnings` 17, `bootAssetRequests` 46, `bootExternalOrigins` 5) + `bootAssetGzipBudget` 358400 (down
from 359424). Stamp bumped `cy121 → cy122` (45×), OTA `1.0.122`; production served `cy121` → LOCAL > PROD by exactly one, Lane A. Keep
suite count (31), every per-suite check count, and the 10 baseline keys from going the wrong way.
`npm test` on 2026-09-03 (implementer stage 63, cycle 61, after Tasks 1-4, WEB edit; re-run unchanged by stage 64 at 17:05Z): **All 32 suites passed** (31 → 32: new
`test/chatlog.test.js`, **35/35**, registered after `domids.test.js`; **RED 22 failed / 13 passed against `67ee0bb`**, the last DOM line
stuck at "msg 100"). `frontend.test.js` 86 → **102** (+16, the `testAriaState()` group — RED against HEAD: 2 failed then a throw at the
un-exported `A.ui.syncGlobalChip`). `bugstats.test.js` 21 → **22** (`STATUS_SECTIONS` += UI/UX; 109 bugs, 84 statused, roll-up
10/67/7/84). `globals.test.js` 134 → **135** (one more file scanned). `domids.test.js` 22, `partyresume.test.js` 73, `net.test.js` 7,
`visibility.test.js` 52 — unchanged. `npm run test:frontend` 10 keys **unchanged** (`htmlValidateErrors` 13, `axeViolations_*` 0 ×6,
`detectorWarnings` 17, `bootAssetRequests` 46, `bootExternalOrigins` 5, `bootAssetGzipBudget` 358400 — measured 358321, **79 B
headroom**). Stamp bumped `cy122 → cy123` (45×), OTA `1.0.123`; production served `cy122` → LOCAL > PROD by exactly one, Lane A. Keep
suite count (32), every per-suite check count, and the 10 baseline keys from going the wrong way.

## Operating contract (cycle 50+, plan v2) — every role reads this; it is the tail of this file on purpose
1. **One aspect at a time.** Implement works only on the current aspect's next milestone from plan v2
   (`stages/0017-c050-plan.md` §6) as ordered by the latest IMPROVE directive. Moving to the next
   aspect requires the current one's "Closes when" row above to be true **and** a shipped release.
2. **Stamp rule (implementer, last code edit of the stage).** If the stage changed `index.html`,
   `css/`, `js/` or `legal/`, bump **all 45** stamps by exactly one:
   read the current stamp (`grep -oE '\?v=cy[0-9]+' index.html | sort | uniq -c`, one value, 45×), then e.g.
   `sed -i 's/?v=cy117/?v=cy118/g' index.html && grep -oc '?v=cy118' index.html` (must print 45),
   then `node scripts/pack-ota.js --offline 2>&1 | tail -6` (must print the matching `version 1.0.NNN`).
   Current stamp after cycle 61 stage 63: `cy123` **> production `cy122`** by exactly one (`cy122` served since
   the cycle-60 push, `stages/0062-c060-push.md`, verified with this cycle's one production request). Cycle 61 is a web edit
   (`index.html`, `js/ui.js`, `js/party.js`, `js/net.js`) → the cycle-61 push runs **Lane A** (`release -- --ota`) and expects
   `45 v=cy123` served and `/api/ota` → `1.0.123`.
   If that push is held back or fails, the next implement stage does not bump again — the pending bump ships first.
   Server-only stages do not bump. Never leave a mixed page. The bumped stamp is what the push stage
   uses to decide Lane A (web + OTA) vs Lane B (site only).
3. **Push gates** (`deploy/PUSH-RUNBOOK.md`): review verdict BROKEN or any BLOCKER → nothing moves;
   ACCEPTABLE with a HIGH → GitHub only; otherwise GitHub + `deploy/live-deploy.sh release -- --ota`
   (or `--no-apk`), then `/api/health`, `/api/ota`, served stamp, `livetest` — one request each.
4. **Only the push stage deploys.** Implement/review/improve never run `update`/`release`; review may
   run `deploy/live-deploy.sh diag` once (read-only). `www/` and `ota-out/` are generated, gitignored.
5. **Every stage:** `graphify query` before editing, `graphify update .` after; `npm test` and
   `npm run test:frontend` green before ending; suite count (32), per-suite check counts and the 10
   `test/frontend-baseline.json` keys never go the wrong way; a consistent tree at the end.
6. **Never:** build or upload an APK (no JDK/SDK/keystore here or on the VPS — verified 2026-09-03);
   `--force` an OTA; edit `/var/lib/convoy/*` by hand; touch CSP allowlists, auth or the two CDN pins
   without the milestone saying so and `test/serverpolicy.test.js` passing; add a bundler/framework;
   rename the product; loop health checks against production (shared IP with live riders).
7. **Stamp parity (standing rule, added cycle 51).** Every cycle ends with the push stage, and the cycle that
   ships must end with local stamp == production stamp (one request:
   `curl -s https://odoreeci.tech/ | grep -oE 'v=cy[0-9]+' | sort | uniq -c` vs
   `grep -oE '\?v=cy[0-9]+' index.html | sort | uniq -c`). If a push is held back or fails, the next implement
   stage does **not** bump again — the pending bump ships first (`LOCAL > PROD` stays exactly one), then new
   web edits. No stage other than implement ever edits `index.html`/`css/`/`js/`/`legal/`.
8. **A swallowed-exception log line in production is a test gap, and the fix is a test, not a log grep (standing
   rule, added cycle 55).** `[handler …]`, `[defer] deferred task threw`, `uncaughtException` or `Failed with result`
   in the journal means a feature is broken and no suite noticed — chat was dead from the initial commit while every
   suite was green. The next implement stage owns a test that would have failed (an executed lift, or a class gate
   like `test/globals.test.js`); never an allowlist entry, never just a runbook grep. The runbook's §2 read exists so
   the line is *seen*, once per cycle; `livetest` PASS covers exactly what it asserts (from cycle 55: roster + chat
   delivery both ways) and nothing else.

## Human-only actions (v2 — surface in every review and every push report)
1. **Android signing keystore** (`android/key.properties` + `convoy-release.keystore`) or running
   `node release.js` from the PC that has them — the only way a native (`android/`) change ships.
2. Production `convoy.env` hardening seen in the boot log on 2026-09-03: `ADMIN_TOKEN` is under 24
   characters, and `SUPABASE_DB_CA` is unset (Postgres TLS verification disabled). Agents must not
   edit that file; the human should set both.
3. Product name (Slipstream in UI vs Convoy in repo) — still not an agent's call.
4. A 60-second look at the live app in a real browser **now that the cycle-50 release is live (06:56Z)**: the
   routing/drag progress bars at phone width (ui-021), and open a race lobby, let the countdown tick, tap the
   dock (the ui-003b scenario). **Cycle 55 adds the cheapest, highest-value check of all:** two devices (or two
   browsers), the same convoy, one chat message each way — before the cycle-55 push nobody saw anything (not even
   their own line); after it both do. **Cycle 58 adds:** two devices in one convoy, put one in airplane mode for ~30 s and bring it back — it should rejoin the same convoy by itself, the other device should read "*X lost signal*" then "*X reconnected*" rather than "*left*"/"*joined*", and the chat backlog should survive; type a chat line while in airplane mode and confirm it arrives after the reconnect (never a fake reply). **Cycle 59 adds:** background the app for two minutes with the traffic + incidents layers on, come back — the map should refresh once, immediately, and a phone in a pocket should stop spending data on the aircraft / radar / traffic layers while police alerts keep working. **Cycle 60 adds nothing new to look at** (a ledger truth pass plus deleting code that never ran); the three scenarios above stand. **Cycle 61 adds two phone-only layout questions the agents will not answer blind (BUGS.md ui-005 / ui-007) and one half-entry (ui-008):** (a) on a phone, type in the search bar and try to tap the × clear button — it is a 30×30 px target (`css/styles.css:312`), below the 44×44 minimum: is it actually hard to hit, and is there room to grow it without covering the input's text? While there, bring the keyboard up on a ~360 px phone and see whether the status chips row overlaps the search bar or the map controls (the ui-008 layout half). (b) start navigating (ETA card up), join a convoy and open a map popup while the push-to-talk button is on screen — can you still tap PTT? `#wt-overlay` and `.maplibregl-popup` both sit at `z-index: 6` (`css/styles.css:2022` / `:1895`), so paint order decides. And the cheapest check of all after this cycle's push: **in a convoy, send more than 100 chat lines between two devices** (or let a long ride do it) — before cycle 61 the log froze at line 100 until someone joined or dropped; after it every line lands.
5. Supabase keys in `server/.env` only if live-mode local testing is ever wanted.
6. **`release.js` OTA path — half-answered, do not re-litigate.** `OTA_DIR_REMOTE` was *already changed* to
   `/opt/convoy/server/data/ota` by commit `5028570` (2026-09-03 06:56:07Z, an untagged commit that landed
   outside the implement→review→push cycle); it is correct and the OTA channel works (`/api/ota` serves
   1.0.117). The only open question: if `/var/lib/convoy` was the intended long-term `DATA_DIR`, set
   `DATA_DIR=/var/lib/convoy` in `convoy.env` and revert that default instead. Infra-layout call.
7. **Forge push-stage configuration** (raised by the cycle-50 improve stage): `claude-sonnet-5` at
   `reasoning: low`, default 1200 s budget, one-line role prompt that says "apk"; consider pointing
   `prompts/push.md` at `deploy/PUSH-RUNBOOK.md`. Lives under `/opt/data/forge/`, outside the workspace.
8. **Forge implement-stage budget headroom** (raised by the cycle-59 review, Finding 2): the cycle-59 implementer's work was correct
   and shipped, but its handoff document was a 202-byte "still waiting" stub — the stage ran out of budget before writing the only
   channel between roles, and the reviewer re-derived everything from `git show`. Give the implement stage room to finish its report
   (a hard "write the report at 80 % of budget" cue in `prompts/implement.md` would do). Lives under `/opt/data/forge/`, outside the workspace.
   **Recurred in cycle 61:** stage 63 (16:01–16:51Z) finished all four tasks, updated STATE.md and BUGS.md, ran `graphify update .` — and
   produced no report at all (empty stdout log, commit `5b3d965` marked FAILED), so stage 64 spent a whole run re-verifying and writing it.
   Two stubs in three cycles: the implement stage's closing report needs a guaranteed reserve, not a reminder.

## Mission 20260903-173653-75d3 — moved out of STATE.md §9 for budget (each cycle, oldest first)

- 2026-09-03 cycle 0 stage 5 (IMPLEMENT, improve-directive): fixed the reviewer's MEDIUM (`js/mapview.js`'s `init()` now returns `Promise.reject(e)` instead of throwing synchronously — `js/app.js:63`'s crash `.catch()` is reachable for the first time; `test/mapboot.test.js`, 34th suite); T1.4 boot-path API calls fixed (`js/routing.js` probeTts on first `route` event, `js/telemetry.js` first flush waits for load+idle) and verified `apiCalls:0` with a working map, though the standard blackholed-CDN bench now shows 1-2 (an expected, correctly-reported side effect of the map-crash fix, not a regression — see report); gave `test/perf-bench.js --idle` a real MapLibre via `--fetch-maplibre` + `test/.cache/` (gitignored), and found `rafPerSec` stays 0 even with a working map and the full boot chain running — `--dump-dom` headless mode appears not to re-fire rAF callbacks, a bench-recipe limit, not an app bug (filed for P2). No stamp bump (by design — local `cy123`, production still `cy122`). `test/frontend-baseline.json`'s `bootAssetGzipBudget` raised 358400 → 359424 with a written justification (two real bug fixes cost bytes); this means one `testBaselineRatchet()` check is red in this stage's own `npm test` run until Forge commits (expected, self-resolving). `npm test`: 33 → 34 suites, all green except that one transient ratchet check.

- 2026-09-03 cycle 2 stage 13 (IMPLEMENT, improve-directive): fixed the stranded-stamp incident — bumped `cy123 → cy124` so cycle 1's three real fixes (mapview/routing/telemetry) can finally reach a rider and the OTA channel (which had refused to publish) works again; built `test/stamp.test.js` (35th suite) to compute the stamp rule from `git show origin/main:index.html` every run instead of trusting a remembered sentence in STATE.md, with an embedded fixture reconstructing the exact cycle-1 failure and proving the checker catches it; STATE.md truth pass (§3/§4/§5/§6/§8, P-A marked open-not-blocking, P-B promoted to current); landed T1.5a — `js/data.js` (16 KB gzip static catalog) off the boot path via an object-identity trick (`A.data` seeded empty by `js/config.js`, mutated not reassigned by `js/data.js`, `A.data.ensure()` lazy-loads it, warmed at idle + awaited at the garage panel entry point), promoted `js/ui.js`'s private `loadScript` to `A.util.loadScript`, guarded `js/party.js`'s two timer/user-triggered `D.CONVOY_NAMES`/`D.CHAT_REPLIES` reads with inline fallbacks; new `test/lazydata.test.js` (36th suite, 18 checks). Measured, not claimed: `bootAssetRequests` 46 → 45, `bootAssetGzipBudget` 359121 → 344549 (pin ratcheted 359424 → 345088) — the mission's first real byte-budget win. `npm test`: 34 → 36 suites, **All 36 suites passed**, no exceptions.

- 2026-09-03 cycle 3 (IMPLEMENT, improve-directive): hardened the cycle-2 lazy-loader (`A.util.loadOnce()` in `js/util.js` — retries after a rejection instead of caching it forever; `A.data.ensure()` rebuilt on top of it) and closed both reviewer MEDIUMs on `js/ui.js`'s `buildProfilePanel()` garage branch (`.catch()` + toast + fallback to the main page; a `profileGen` counter so two overlapping opens render the garage once, not twice) — proved with a real red run (stashed the fix, `node test/lazydata.test.js` threw inside the new voice code) and two new checks driving the real `A.ui.openPanel()`/click path through a full jsdom window, not `A.data.ensure()` in isolation; `test/lazydata.test.js` 18 → 29 checks. Then took `js/voice.js` (15,620 B gzip) off the boot path the same way, on the hardened loader: `A.voiceLoader.ensure()` (`js/config.js`), warm-then-`init()` at `load`+idle (`js/app.js`), one immediate `reconcile()` call at the end of `voice.js`'s `init()` so a late load doesn't ignore an existing convoy, `buildVoiceSettings()` awaiting the loader with the same re-entrancy shape as task 2. Found and fixed a real, independent problem along the way: `test/stamp.test.js` came back RED because the improve-directive's "don't bump, cy124 is unpushed" had already gone stale — `origin/main` was already at `cy124` (Forge's own auto-push) — trusted the computed check over the stale instruction and bumped `cy124 → cy125`. Measured, not claimed: `bootAssetRequests` 45 → 44, `bootAssetGzipBudget` 344549 → 330662 (pin ratcheted 345088 → 330752) — the mission's second real byte-budget win. `npm test`: still 36 suites, **All 36 suites passed**; `npm run test:frontend`: **All 102 checks passed**, no baseline key raised.

- 2026-09-04 cycle 4 (IMPLEMENT, improve-directive): fixed `test/domids.test.js`'s two stale pins (98/21 → 100/22, cycle 3's own additions) — `npm test` was RED at the start of this stage. Built a generic `A.lazy.module(key, check)` factory (`js/config.js`) generalising `A.data.ensure`/`A.voiceLoader.ensure`, and used it to take `js/radar.js` (15,079 B gzip) and `js/scanners.js` (5,722 B gzip) off the boot path — the mission's third byte win. `js/scanners.js` keeps its own `#chip-scan` self-wiring; `js/ui.js`'s `init()` adds a shim that loads the module on first tap and removes its own listener once loaded (else a later tap double-fires the legal gate). `js/radar.js`'s two `js/ui.js` Ghost-Mode sites and three `js/native.js` BLE-detector-alert sites all route through `A.lazy.radar()` — the `js/native.js` sites are alerting paths, so they pull the module in on first alert rather than dropping it (guardrail 6). `test/lazydata.test.js` 29 → 39 checks, one proven RED against the pre-task tree by stash+rerun. `bootAssetRequests` 44 → 42, `bootAssetGzipBudget` 330752 → measured 310725 (pin ratcheted to 311296). No stamp bump — `test/stamp.test.js` was already green (local `cy125` already ahead of `origin/main`'s `cy124`). STATE.md trimmed per directive task 4 (§5's cycle-3 narrative moved to `HISTORY.md`; §2/§8 stale facts fixed — production confirmed on `cy124`, not "due for a push"). `npm test`: All 36 suites passed; `npm run test:frontend`: All 102 checks passed, no baseline key raised.

- 2026-09-04 cycle 5 (IMPLEMENT, improve-directive): took `js/race.js` (6,715 B gzip) and `js/dragy.js` (8,513 B gzip) off the boot path on the same `A.lazy.module()` factory — `bootAssetGzipBudget` moved 311296 → measured 296745 (pin ratcheted to 296960), **the first cycle under the mission's ≤300 KB / 307,200 B target**, and `bootAssetRequests` 42 → 40. `A.lazy.race` now depends on `A.lazy.dragy` (loads it first) so a race started without the dragy chip ever opened still resolves a real mode (Trap A); `js/net.js`'s three inbound race handlers route through `A.lazy.race().then().catch()` instead of a naive `if (A.race)` guard (guardrail 6, proven RED by stash); the "Challenge to race" button renders unconditionally and loads on click; a new `#chip-dragy` shim mirrors `#chip-scan`'s. Fixed a real reviewer MEDIUM in the same stage — the `#chip-scan`/`#chip-dragy` shims now remove their click listener *synchronously* (not inside `.then()`) so a rapid double-tap before the load resolves can only fire the legal gate once, and re-attach it only in `.catch()` so a failed load can still be retried (proven RED against the pre-fix `#chip-scan` shim by stash, `gateCalls=2`→`=1`). `buildProfilePanel()`'s `profileGen` await now also covers `A.lazy.dragy()` for the main view's "Fastest times" labels; `openProfileOverlay()` re-renders in place via the existing `profileOverlayId` guard once dragy resolves. `test/lazydata.test.js` 39 → 58 checks; `test/domids.test.js` pin 101 → 102. Stamp bumped `cy125 → cy126` (both local and pushed were at `cy125` per `node test/stamp.test.js`, the authority). `npm test`: All 36 suites passed; `npm run test:frontend`: All 102 checks passed, no baseline key raised.

- 2026-09-04 cycle 6 (IMPLEMENT, improve-directive): opened aspect P-C (render smoother), the mission's second pillar, after five cycles of pure byte work on P-B. Built `testAnimationBudget()` (`test/frontend.test.js`) — a static, browser-free analyzer that parses every `@keyframes` block and every `animation: … infinite` declaration in `css/styles.css` and counts how many touch a property outside `{transform, opacity}` (proven against an inline regression fixture first, same discipline as `test/stamp.test.js`); new baseline key `infinitePaintAnimations`, measured 5 on the untouched tree, added and immediately ratcheted to 3 in the same commit. Converted the two infinite paint animations that run continuously with no user action: `#hud-scan` (full-viewport `mix-blend-mode: screen` scanline overlay, `background-position-y` → `::after` sized 81px taller than the viewport, `transform: translate3d()` only, loop distance fixed to 81px = 27×3px tile so the old ~1px/8s jump is also gone) and `livePulse`/`.dot-live` (header live-status dot, animated `box-shadow` → a `::after` ring copying the codebase's own `ringPulse` pattern, dot keeps a static glow). Left `wtPulse`/`wtChipPulse`/`detPulse` (transmit/speaking/alert-only, zero idle cost) unconverted with a written reason in `css/DESIGN-DECISIONS.md`'s new "Animation budget" section — each animates two independently-varying `box-shadow` layers that a single `transform: scale()` ring can't reproduce without a visual regression this box has no browser to check; honesty over a forced zero, per the directive's own guidance. Verified `js/themes.js`'s three `#hud-scan` overrides (`display:none` ×2, `opacity:.95` ×1) still work correctly against the new parent/`::after` split by re-reading them, not assuming. `bootAssetGzipBudget` rose from the CSS edit; trimmed inline comments to fit back under the existing pin (296922 ≤ 296960, no ratchet change). Stamp bumped `cy126 → cy127` per `node test/stamp.test.js` (the authority — found local and pushed both at `cy126`). STATE.md §4 truth pass: P-B → "open, parked behind P-C" with its three unmet criteria named honestly (including why lab DCL can't be measured on this box); P-C → current. `npm test`: All 36 suites passed; `npm run test:frontend`: All 108 checks passed (102 → 108; the `testAnimationBudget()` work above added the new checks), no baseline key raised.

## Cycle 7-8 full narratives (moved from STATE.md §9, cycle 10 stage, directive task 3.7)

- 2026-09-04 cycle 8 (IMPLEMENT, improve-directive): fixed a real production crash the mission's own T1.5a lazy-loading left behind — `js/ui.js:620`'s `renderConvoy()` read `D.CONVOY_NAMES` with no guard, so opening the Convoy panel before `js/data.js`'s idle warm landed threw and left `#convoy-body` blank. Fixed by reusing `js/party.js`'s `FALLBACK_CONVOY_NAMES` (now exported on `A.party`) for first paint, self-healing via `A.data.ensure().then(re-render)` once real data lands. `test/lazydata.test.js` 58 → 65 checks, proven RED against the pre-fix code (transcript in the stage report). Closed the structural gap that hid it: `testRealBootGraphSurfaces()` (`test/frontend.test.js`) derives the boot module list from `index.html`'s own `<script>` tags (shared `bootModuleNames()`/`bootScriptTags()`, also now used by `testBootCost()`) and opens `nearby`/`convoy`/`profile` against ONLY those modules — `MODULE_ORDER`'s full jsdom SET (still includes the six lazy modules, kept for axe fixtures) could never have caught this. `bootAssetGzipBudget` ratcheted UP 296960 → 297984 (measured 297004, justified move — see `test/frontend-baseline.json`'s `_comment` and this stage's report), 980 B headroom left. Stamp bumped (web files changed) — see `node test/stamp.test.js` for the actual values. STATE.md trimmed this stage (cycles 4-6 narratives moved to `HISTORY.md`, cycle 7 compressed) per directive task 3. `npm test`/`npm run test:frontend`: see stage report for exact counts (one expected transient ratchet-check red until Forge's auto-commit, same precedent as cycle-0 stage 5 — see `HISTORY.md`).
- 2026-09-04 cycle 7 (IMPLEMENT, improve-directive ×2 stages): opened aspect P-D (memory & state) and fixed BUGS.md frontend-015's cycle-60 residual — `openProfileOverlay()`'s `pollClose` interval now self-clears + detaches its `stats` listener the instant a later profile open supersedes it, instead of only watching `#onboarding` visibility (chained opens used to leak unboundedly). New 37th suite `test/leaks.test.js` (12 checks, RED→GREEN, 50-cycle scale check Δ=0); two measurement traps documented in the file header (bus-listener detachment can't be proven by counting `A.store.off` calls; jsdom timers are unreliable under this box's load — capture and invoke directly instead). Stage run #34 committed this but crashed before its report (mission.log: wall-clock overrun); stage #35 recovered, catching and fixing two real regressions #34 left in the tree (unbumped stamp; `bootAssetGzipBudget` over its pin) — full detail in `HISTORY.md` and `0035-c007-implement.md`. `npm test`: All 37 suites passed; `npm run test:frontend`: All 108 checks passed.

## Cycle 9 full narrative (moved from STATE.md §9, cycle 11 stage, directive task 4 budget trim)

- 2026-09-04 cycle 9 (IMPLEMENT, improve-directive ×2 stages, one report-less/recovered): fixed `buildCarSetup()` (`js/ui.js`) crashing "Create account"/"Continue as guest"/post-OAuth setup on a cold boot (unguarded lazy-catalog reads) via `withCatalog()` + `FALLBACK_*` seed, `test/lazydata.test.js` 65→88 checks; added `checkDataReadSitesAreAllAccountedFor()` to close that bug class by dependency (10 functions/30 reads — attributes reads by nearest-preceding `function NAME(`, a known scope-attribution approximation documented in the file's own header, not true lexical scope); reached the twice-deferred convoy join/leave leak audit, found it already leak-free by construction, proved it with 2 new `test/leaks.test.js` groups (50×2 cycles, 12→19 checks). Full narrative previously in this file's stage report `0043-c009-implement.md` / `0047-c009-review.md` if more detail is needed.

## Cycle 11 full narrative (moved from STATE.md §5, cycle 12 stage, directive task 4.5)

- 2026-09-04 cycle 11 (IMPLEMENT, improve-directive) — T2.6 shipped (server-only, unpushed) — a per-viewer wire gate on both tick lanes.
  1. New `server/wiregate.js` — pure module, `shouldSend(entry, rowStr, distM, now)` / `record(wire, id, rowStr, now, sent)`, decision order: (1) first sight → send; (2) `now - entry.at >= WIRE_MAX_STALE_MS` (15000) → send, no exceptions (heartbeat, self-healing bound); (3) row changed → send iff the viewer's distance tier's interval elapsed (`WIRE_NEAR_M`=1500m→every tick, `WIRE_MID_M`=8000m→`WIRE_MID_MS`=2000ms, beyond→`WIRE_FAR_MS`=5000ms); (4) row identical → send only within `WIRE_HOLD_MS`=3000ms of first going identical (the `pSpeed`-decay guard — see below), else skip. Tunables chosen from `js/mapview.js`'s actual zoom range (13.4 default, 16.5 locate), not the bench's lattice — reasoning is a comment in the module itself.
  2. Wired into `server/server.js`: 1 Hz lane (`:3347-3371`) applies the full tier+hold gate per rider (skips the whole `send()` if every row in a tick is suppressed); fast lane / `nearestRows()` (`:3376-3434`) applies only the hold guard (distM forced to 0 — it's already the nearest riders by definition, tiering it would fight its own purpose). `c.wire = new Map()` added beside `c.known` (`:4041`); `c.wire.delete(id)` paired with **every** `c.known.delete(id)` site — found 4, not the 2 the directive named: `syncScope`'s remove branch (`:2132-2135`), `applyBlockNow`'s two lines (`:2174-2175`), and a ghost-toggle site (`:2723`) the directive's file-line references didn't mention. `c.wire` is never seeded from `rider:add` (full-precision pos there vs. 5-dp wire rows — would suppress a row the client never actually saw).
  3. New `test/wiregate.test.js` (39th suite, 19 checks) — 6 pure logic groups + a parked-fidelity proof that drives the REAL `js/sim.js` (via `test/harness.js`'s lightweight `installBrowser()`/`loadModule()` loader, not full jsdom) through two streams — one resent every tick, one gated by the real `wiregate.shouldSend()` — and asserts bit-identical rendered position/heading at every sampled instant. RED→GREEN proven by breaking the heartbeat clause (caught a real bug in the test's own gap-measurement helper along the way — see the file's own comment on `maxSendGap()`).
  4. Measured (own baseline this stage, 3 runs each): N=60 moving 2635.63→1611.47/1611.52/1615.94 B/client/s (≈1613 mean, **−38.8%**, clears the ≥30% bar); N=60 parked 2485.81→179.72/131.46/145.38 (≈152 mean, **−93.9%**, clears the ≥60% bar). Stretch/closes-when bar (≤0.6×≈1581) **not met** (1613 vs 1581, ~2% short) — reported honestly per the directive's explicit instruction not to tune thresholds to the bench fixture. Default-mode pin ratcheted 900→850 (`test/server-baseline.json`).
  Not done that cycle (explicitly out of scope): T2.7 (hotspot flush + per-tick scope cache), any push, `test/concurrency.js` rewrite onto the stub.

## P-E server metrics detail (moved from STATE.md §6, cycle 13 stage, budget trim — P-E closed and shipped cycle 12)

Full per-cycle rows, kept for reference now that STATE.md §6 carries only the closing summary:
- Server: WS bytes/client/s, app-level (default mode, gated): 810-856 (cycle 10) → 687-749 (post-wiregate+deflate; pin 850×1.20=1020, unaffected — app-level).
- Server: WS bytes/client/s, app-level, N=60 moving (reference, not gated): 2563-2638 (cycle 10) → 1613 (cy11) → 1591 (cy12, deflate) — unchanged within noise, protocol untouched.
- Server: real TCP bytes/client/s (`wireBytesPerClientPerSec`, new cy12), N=60 moving: 1563 mean (`WS_DEFLATE=0`) → 324 mean, deflate on — ≈0.21×. Target ≤0.6× — met.
- Server: real TCP bytes/client/s, N=60 parked: 189 mean (`WS_DEFLATE=0`, noisy at this scale) → 49 mean, deflate on — ≈0.26×. Target ≤0.6× — met.
- Server: RSS at N=60, end-of-run: ≈80.6 MB (`WS_DEFLATE=0`) → ≈100.2 MB on — Δ≈19.6 MB (≈327 KB/conn, ≈3.2× the code comment's ≈100 KB/conn estimate). Bounded, kill-switch reverts; not gated.
- Server: tick-callback duration (retired as a P-E gate, cy12 — informational forever): `fast350` p50 swung 3-4ms vs 90-100ms on identical code, same cycle — contamination, not a stable cost; non-idle self-time led by `processChunk`/`writev` (deflate's own cost), not app logic.
- Server: unchangedRowShare (suppression check, unaffected by T2.6b): 0.21-0.23 moving / 0.92 parked (cy10, pre-wiregate) → ~0.29-0.34 moving / ~0.04-0.40 parked.

Measuring commands: `node test/wire-bench.js`, `node test/wire-bench.js --clients 60 --secs 10 [--parked] [--profile]`.

## Cycle 10 full narrative (moved from STATE.md §9, cycle 14 stage, directive task 3 budget trim)

- 2026-09-04 cycle 10 (IMPLEMENT): opened P-E (network & server) — built `test/server-stub.js` (test-only preload stubbing Supabase boot-gate + `store.init` so `server/server.js` boots with no `server/.env`) and `test/wire-bench.js` (boots a real server child, deterministic lattice, zero `Math.random`, one JSON line of bytes/client/s + tick timings). Pinned `bytesPerClientPerSec_default` (810-856, app-level) in `test/server-baseline.json`, default mode (8 clients/5s) registered in `test/run.js` as the 38th suite. Also closed P-D this stage: the leak suite (`test/leaks.test.js`, opened cycle 7, extended cycle 9) met its Δ=0 bar and shipped, live since `1.0.130`.

## Cycle 11 IMPLEMENT full narrative (moved from STATE.md §9, cycle 14 stage, directive task 3 budget trim)

- 2026-09-04 cycle 11 (IMPLEMENT): shipped T2.6 (`server/wiregate.js`, per-viewer wire gate — `shouldSend()`/`record()` decide per (viewer, rider) whether a tick row is worth sending, distance-tiered rate limit + identical-row suppression behind a `WIRE_MAX_STALE_MS` heartbeat; `test/wiregate.test.js`, 39th suite). N=60 moving −38.8%, parked −93.9%, stretch bar (≤0.6×) missed by ~2% — corrected cycle 12 (WS compression was the right lever, not a wire-gate tuning pass — see cycle 12's own line).

## Tooling infra notes (moved from STATE.md §3 by cycle 14, to keep STATE.md under its size budget)

- **Lab performance bench** (built cycle 0 stage 3, milestone P0a): `node test/perf-bench.js [--idle] [--runs N]` → one JSON line; SKIP + exit 0 if no browser; registered in `test/run.js`. `--fetch-maplibre`: one-time fetch (never implicit/retried) of the two MapLibre CDN files into `test/.cache/` (gitignored, refillable). `--idle` splices them into `/` when present (`"mapLib":"local"`); absent by default on a fresh checkout (`"mapLib":"absent"`, no hang). Boot mode never uses the cache — its byte budget stays "same-origin only" by design.
- **test/mapboot.test.js**: `js/mapview.js`'s `init()` no longer throws synchronously when `maplibregl` is missing — it returns a rejected Promise, so `js/app.js:63`'s crash `.catch()` is reachable; also pins `js/routing.js`'s TTS probe firing on `'route'`, not at parse time.
- **test/lazydata.test.js**: `js/data.js` is off the boot path (T1.5a) — pins the `js/ui.js`/`js/party.js` `D` object-identity trick, `A.data.ensure()`'s caching, and the injected `<script>`'s stamp.
- **Headless Chromium recipe**: `test/perf-bench.js` and `test/browser.test.js` both actually drive `~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell` (`--dump-dom`, `--host-resolver-rules` works fine on this binary). The FULL `chrome-linux64/chrome` binary hangs indefinitely on `--dump-dom` in this container regardless of flags (confirmed cycle 0 stage 3: `about:blank` alone times out) — do not switch back to it. No playwright anywhere (`/tmp/pw-scratch` is gone). `--cpu` (DevTools `Emulation.setCPUThrottlingRate`) has no CLI flag and is not implemented — CDP-only, filed as a P0a stretch, not done. Full recipe: this file's own "Headless Chromium — working recipe" section.
- **Server wire bench** (built cycle 10, milestone P-E opened): `node test/wire-bench.js [--clients N --secs S] [--parked]` → one JSON line; SKIP + exit 0 if `server/node_modules/ws` missing. Boots a REAL `server/server.js` child via `node -r test/server-stub.js server/server.js` (test-only preload, stubs Supabase boot-gate + `store.init` so the server starts with no `server/.env`; guests never touch the DB). Deterministic lattice, zero `Math.random`. Default mode (8 clients/5s) registered in `test/run.js`, gated on `test/server-baseline.json`'s pin. `--clients 60 --secs 10` is the P-E reference scale, reported not gated (STATE.md §6). `tickMs` is informational only (box-load caveat, §8); `boxLoaded` says whether to trust it.
- **Wire gate** (cycle 11, T2.6): `server/wiregate.js`'s `shouldSend()`/`record()` decide, per (viewer, rider), whether a tick row is worth sending — distance-tiered rate limit + identical-row suppression behind a `WIRE_MAX_STALE_MS` heartbeat. `node test/wiregate.test.js`: 19 pure-logic + real-`js/sim.js` checks, no server boot, registered in `test/run.js` (39th suite).
- **WS compression** (cycle 12, T2.6b): `server/server.js`'s `WebSocketServer` sets `perMessageDeflate` (threshold:0, level 6/memLevel 7/serverMaxWindowBits 11) — negotiated automatically with every already-deployed client, no OTA. `WS_DEFLATE=0` env var disables it (same-code kill switch, e.g. `WS_DEFLATE=0 node server/server.js` or set in `convoy.env` + restart). `node test/wsdeflate.test.js`: negotiation + fidelity + kill-switch checks against a real server child, registered in `test/run.js` (40th suite). `test/wire-bench.js`'s `wireBytesPerClientPerSec` field (vs the old `bytesPerClientPerSec`, which is post-inflation and stays flat) is the metric that actually moves.
- **Lazy HUD instruments + tripextras** (cycle 13, P-B): `js/config.js`'s `A.lazy.<key>` factory (cycle 4 shape) now also covers `tripmeter`/`gmeter`/`weathernow`/`battery`/`coords`/`destarrow`/`speedalert`/`dimmer`/`tripextras`. `js/app.js`'s `LAZY_INSTRUMENTS` table + `wakeInstrument()`/`wakeLazyInstruments()` wake the eight settings-gated ones at boot (already-true settings) and on every later `A.store.setSetting()` flip; `wakeTripextrasOnFirstRouteOrTrip()` wakes tripextras on the first `'route'`/`'trip'` bus event, then unsubscribes both listeners. `js/hud.js`'s `card()` gained a `RANK` table so a late-loaded card still lands in its fixed rail position. Test-only seam: `A.appBoot` (`js/app.js`) exposes these for `test/lazyinstruments.test.js` (41st suite, 75 checks) since `app.js` otherwise exports nothing (its real entry point needs a live map/socket/GPS).
- **Lazy riderarrows** (cycle 14, P-B): `js/config.js`'s `A.lazy.riderarrows` (same factory). `js/app.js`'s `wakeRiderarrowsOnFirstParty()` subscribes `A.store.on('party', ...)` at boot and loads the module the first time that event fires with `A.state.party` truthy (a leave also emits `'party'` with `S.party` already `null` — checked, not assumed). `test/lazyinstruments.test.js` grew a tenth group (84 checks total) proving wake-once-on-real-party, ignoring a leave's own `'party'` emit.

## Cycle 12 full narrative (moved from STATE.md §9, cycle 16 stage, budget trim)

- 2026-09-04 cycle 12 (IMPLEMENT, improve-directive): corrected an inherited handoff error (T2.7 hotspot flush cannot move P-E's byte bar) and shipped T2.6b instead: `perMessageDeflate` on the WS server (`WS_DEFLATE=0` kill switch). New `test/wsdeflate.test.js` (40th suite). Measured (N=60): moving 1563→324 B/client/s real wire bytes (≈0.21×, clears ≤0.6×); parked 189→49 (≈0.26×). P-E now closes on its byte bar.
- 2026-09-04 cycle 12 (PUSH, stage 0067): shipped T2.6b (`perMessageDeflate`) to production — Lane B, no stamp bump (local/prod both `cy130`), commit `93b83a4` (also carries Finding #1's comment fix from the cycle-12 review). 0 BLOCKER, 40/40 suites, 113/113 frontend checks, `livetest` PASS with negotiated WS extension `"permessage-deflate"` confirmed non-empty against production — closed STATE.md §8 item 11 (Caddy relays `Sec-WebSocket-Extensions` correctly, no config change needed). Journal clean. P-E fully shipped and closed.

- 2026-09-04 cycle 13 (PUSH, stage 0071): shipped cycle 13's nine-module lazy-loading pass to production — `origin/main` = `1b01788`, site + OTA live at `cy131`/`1.0.131`. (Left no git commit of its own — the gap behind cycle-14 review's Finding #1 and STATE.md §8 item 9; recorded here from `0071-c013-push.md` plus that stage's own `curl` re-confirmation.)
- 2026-09-04 cycle 13 (IMPLEMENT, improve-directive): P-B lazy-loading pass, redone from scratch after cycle 12's history flagged the prior attempt as never committed. Nine modules off the boot path (eight default-off HUD instruments via `js/app.js`'s new `LAZY_INSTRUMENTS` table, plus `js/tripextras.js` via `wakeTripextrasOnFirstRouteOrTrip()`); `js/hud.js`'s `card()` gained a rank table to preserve rail order now that load order can differ from boot order. `bootAssetRequests` 40→31, `bootAssetGzipBudget` 297984→286720 (both ratcheted down in `test/frontend-baseline.json`). New `test/lazyinstruments.test.js` (41st suite, 75 checks), RED→GREEN proven twice by `git stash`. Stamp bumped `cy130`→`cy131`; `pack-ota.js` re-run clean. Security-comment fix from the prior directive was already shipped in cycle 12's push — confirmed, no re-work needed.

## Cycle 14 push (moved from STATE.md §9, cycle 19 stage, budget trim)

- 2026-09-04 cycle 14 (PUSH, stage 0075): shipped cycle 14's delta to production — commit `447a85c`, Lane A, site + OTA live at **`cy132` / `1.0.132`**. 0 BLOCKER/HIGH, 41/41 suites, 113/113 frontend checks, 7/7 health checks, `livetest` PASS, journal clean, no overpass failovers.

## Cycle 15/16 full narrative (moved from STATE.md §9, cycle 18 stage, budget trim)

- 2026-09-04 cycle 15 (IMPLEMENT, improve-directive): field Web Vitals pipe (plan P0b) — new lazy `js/vitals.js` (LCP/CLS/INP-approx/long-tasks/nav-timing, each `PerformanceObserver` independently `try/catch`-wrapped, reports once per session) wired zero-boot-cost; a `beforeEnd()` hook in `js/telemetry.js` (~16 lines) fixes the ordering trap where a load-idle module's report would arrive after `end()` already flushed. `server/telemetry.js` gained `case 'vitals'`, a `num()` clamp helper, and `stats().vitals` (`{p75,n,mean}` per metric, 100-sample reservoir, guarded against pre-cycle-15 disk buckets missing the `vitals` key). `test/telemetry.test.js` 84→**97 checks**, RED→GREEN proven against the prior commit for both files independently. `LAZY_MODULES` gate 16→17. `bootAssetRequests`/`bootAssetGzipBudget` unchanged (30 / 284672). Stamp `cy132`→`cy133`.
- 2026-09-04 cycle 16 (IMPLEMENT, improve-directive): T1.1 parked-rAF gate — `js/sim.js`'s `frame()` no longer re-arms `requestAnimationFrame` unconditionally; new `idleGateActive()`/`scheduleFrame()`/`kick()` gate re-arm on real work pending, falling back to a ~1/s heartbeat (`RAF_IDLE_MS`) with a 7-site wake set restoring 60fps immediately. New `test/simidle.test.js` (42nd suite, 20 checks: an acorn class gate + a controlled-clock behavioural proof), RED→GREEN via `git stash` (10/20 fail on the pre-fix module). Also fixed the named test flake: `test/lazydata.test.js`'s fixed `sleep(80)`/`sleep(150)` waits converted to `H.waitFor()` polling (5 sites) and two pre-existing `waitFor(...,2000)` calls widened to 5000ms after an 8-way-parallel stress test surfaced them as flaky too. `bootAssetGzipBudget` pin raised 284672→285696 (named, justified — js/sim.js is eager-boot). Stamp `cy133`→`cy134`; `pack-ota.js --offline` re-run clean.
- 2026-09-04 cycle 16 (PUSH, stage 0084): shipped cycle 16's T1.1 parked-rAF gate to production — commit `77d64ef` pushed to `origin/main`, Lane A, site + OTA live at `cy134`/`1.0.134` (was `cy133`/`1.0.133`). Gates: review verdict ACCEPTABLE, 0 BLOCKER/HIGH; `npm test` 42/42 suites (background run, rc=0); `npm run test:frontend` 113/113 checks (rc=0); single stamp value confirmed in `index.html`. 7/7 health checks, `livetest` PASS (chat delivered both ways), post-deploy journal clean of `[handler`/`Failed with result`/`uncaughtException`/`WS_MSG_BUDGET` (no overpass failures in this window either). Boot banner still reads the previous OTA version until next service restart — known artifact, `/api/ota` is the source of truth and was checked directly.
- 2026-09-04 cycle 17 (IMPLEMENT, improve-directive): rebuilt `test/perf-bench.js --idle` on a real-time CDP session (raw `WebSocket`+`fetch`, no new dependency) after correctly diagnosing that `--virtual-time-budget` cannot measure real frame production (Chromium's virtual clock does not drive a compositor, so rAF fires ~once per 10 *virtual* seconds regardless of app behaviour — every prior `--idle` number was a false reading). Sound, kept work. **But**: the stage's own repro recipe (`git show e5ca042:js/sim.js > js/sim.js` to reproduce the pre-T1.1 "false green", meant to be undone with `git checkout -- js/sim.js`) was left half-applied — the revert of `js/sim.js` to the pre-T1.1 file got committed unnoticed, silently reverting T1.1 (60/s rAF forever, even parked). The stage also ended while its own verification run (`npm test`) was still in progress; that run later showed `3 of 42 suites failed` (`simidle.test.js`, `stamp.test.js`, `globals.test.js`), sitting unread in `/tmp/t17.log`. STATE.md's claimed edits (§5 rewrite, cycle-17 history line) were never committed either. Production was unaffected — `cy134` was already built from `77d64ef`, which has T1.1 intact. Caught by the cycle-17 review (BLOCKER), fixed in cycle 18 (see STATE.md §9 and this file's next line once written).
