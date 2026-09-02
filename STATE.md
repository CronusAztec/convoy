# STATE.md — Convoy v2 mission workspace

> Maintained by the implementer after every stage. Read this first, then `BUGS.md`, then the last 10 commits.

## Mission
Forge mission `20260902-214545-4532` ("convoyv2"): continuous improvement of Convoy in every area, one area per pass, evidence-driven. Full text: `/opt/data/forge/missions/20260902-214545-4532/MISSION.md`. Plan: `/opt/data/forge/missions/20260902-214545-4532/stages/0001-c000-plan.md`. Hard rule from the human: use graphify; look for and use skills (`hermes skills list`).

## What this workspace is
Full history of `https://github.com/CronusAztec/convoy` (upstream `main` = `b9fe23a`, "Sync versionName to the shipped cy116 stamp") imported at `9f1dfe1`, plus two cherry-picks:
- `29a8245` — owner's local `ponytail/stdlib-dedupe` commit (base64url + AbortSignal.timeout via stdlib; not on GitHub yet).
- `b2b5b9a` — prior mission 20260902-201910-6806's reviewed Milestone 1: `CONVOY_DEV_AUTH=1` guest-only boot without Supabase (refuses under `NODE_ENV=production` / `APP_URL=https://odoreeci.tech`), `www/` self-heal in `test/run.js` + `pretest`, `scripts/smoke.js` two-client Playwright proximity smoke, `playwright` devDependency.
Read-only reference clone: `/opt/data/convoy` (never edit). Production: https://odoreeci.tech (shares this box's public IP; at most one `GET /api/health` per stage; never deploy or load-test).

Stack: vanilla-JS client (`index.html`, `js/*.js` 44 modules / 20,994 lines, `css/styles.css` 3,445 lines) + Node/WebSocket server (`server/`, 12,814 lines, deps `ws` 8.21.0 + `pg` 8.23.0, Supabase Auth proxied) + Capacitor 8.4 Android shell (`android/`, `tech.odoreeci.convoy`, versionName 1.0.116, versionCode 4). Web stamp `?v=cy117` on 45 tags in `index.html` (bumped this stage — `js/net.js`/`js/dragy.js`/`js/sim.js` changed); next stamp is `cy118`.

## Chosen direction
Evidence-driven audit → fix → verify loop, rotating areas: **M1 Realtime/server (ledger truthing + `server-024` WS frame budget + perf baseline) → M2 client resilience/panel states → M3 auth/session → M4 upstream failure isolation → M5 HUD a11y/copy → M6 voice → M7 Android (static only) → M8 performance → M9 docs/release branch.** Details and definitions of done in the plan §6.

## Metrics
- M1 ledger accuracy: **DONE** — Server (27) + Runtime (6) = 33 entries, 16 FIXED / 13 OPEN / 4 OBSOLETE. See `BUGS.md` → "Server + Runtime ledger truthing (2026-09-02)".
- M2 ledger accuracy: **DONE** — Frontend (18) + UI/UX (13) = 31 entries, 20 FIXED / 10 OPEN / 1 OBSOLETE. See `BUGS.md` → "Frontend + UI/UX ledger truthing (2026-09-02, mission convoyv2 M2)". Combined with M1, **all 64 Server+Runtime+Frontend+UI/UX entries are now truthed**; only Android (static-review, M7) and the two 2026-07 audit addenda sections remain untruthed.
- M2 tests: `node test/run.js` green every stage; **check count strictly grows** each implement stage. IMPORTANT: the printed "All N checks passed" line at the very end of a full run is `admin.test.js`'s own count (184), not a sum — it happens to print last. The real cross-suite total (sum every suite's own count) is the metric that must grow: **1043 → 1049 (M1) → 1061 (M2)**. Compute it with: `node test/run.js 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -oE 'All [0-9]+ checks passed' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s}'` (the `sed` strips ANSI color codes — without it the grep silently collapses to one match).
  - **Correction (2026-09-02, M2 review follow-up):** the plan's M1 Definition of Done (`stages/0001-c000-plan.md`) said *"`node test/run.js` ≥ 195 checks green"* and *"`server-024` fixed with ≥ 6 new checks"*. Both numbers were derived from the same mistaken assumption that the printed headline count is a global sum — it isn't (see above). The real, meaningful metric is the cross-suite total shown here; `server-024` itself got 4 new checks (group `W1`), not 6 (the other 2 belong to `runtime-005`'s bonus fix, group `R2`). Future planners: don't hold an implementer to the plan's literal "≥195"/"≥6" wording, it was never a real target.
- M2 client fixes: ≥3 required, **3 shipped** (frontend-005 Bearer-token bug, frontend-013 party-drop flicker, frontend-003 dead solo-mode code), each with a pinning check; frontend-005 additionally revert-and-confirmed (reverted the guard, watched `test/netparty.test.js` fail with the exact pre-fix symptom, restored it, watched it pass).
- M2 fresh-defect finder: **DONE** — `scripts/ui-states.js` (new, models `scripts/smoke.js`'s bootstrap) drives 5 client states (geolocation denied, server unreachable at first connect, socket dropped mid-session, empty Nearby/Convoy panels, route-search failure copy) and screenshots each. All 5 passed clean on this run — 0 new client defects found this pass (screenshots + findings in the stage report). This is the renewable replacement for the now-exhausted 2026-07 BUGS.md client sections; run it every future client-touching pass instead of re-reading the ledger.
- M3 perf baseline — **DONE, measured in M1** via the new `scripts/bench.js`: client bundle 1094.7KB raw / 343.8KB gzip (44 scripts + index.html + css), `/api/health` p50=0.5ms/p95=1.5ms/p99=4.1ms, WS connect→welcome p50=50.5ms/p95=71.1ms @50 sockets, RSS 80.0MB→105.0MB (+31.2%) over 5min/25-client churn. Full numbers and the new `server-028` (unconfirmed RSS-growth) finding in `BUGS.md`. Not re-run this stage (no hot-path server change) — future stages should re-run `node scripts/bench.js --out <path>` and diff against these, not re-derive from scratch.
- M4 ship-readiness: each cycle ends with cache-buster bumped (`cy117` this stage — `js/net.js`/`js/dragy.js`/`js/sim.js` changed, so all 45 tags bumped uniformly per `scripts/pack-ota.js`'s mixed-stamp guard), `graphify update .`, `BUGS.md` + `STATE.md` updated, per-change commits, OTA bundle built, branch `forge/convoyv2` pushed (push only; merge is human).

## Current milestone
**M2 — DONE.** Client resilience and panel states: Frontend+UI/UX ledger truthed (31/31 entries, joining M1's 33 for 64/64 total), 3 real client bugs fixed and pinned (Bearer-token bug, convoy-drop flicker/toast-spam, dead solo-mode branch), `scripts/ui-states.js` written and run clean (0 new findings), `test/ota.test.js` cleanup made exception-safe, `server-024`'s burst-tolerance design decision documented, M1's plan DoD wording corrected. OTA bundle built (`ota-out/bundle-1.0.117.zip`) and pushed to `forge/convoyv2`. **Next milestone: M3 — auth/session edge cases** (plan §M3). Start at the Handoff below.

## How to run
```
cd /opt/data/forge/missions/20260902-214545-4532/workspace
(cd server && npm ci)                                   # done this stage
# node_modules/ (playwright + Chromium) copied from the prior workspace; if missing: npm ci && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
CONVOY_DEV_AUTH=1 BOTS=0 PORT=5173 node server/server.js  # guest-only local server, no Supabase
# real backend: needs SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_DB_URL in server/.env (absent on this box)
```

## How to test
```
rm -rf www && node test/run.js        # 22 unit suites; harness fakes in test/harness.js; no network
node scripts/smoke.js                 # Playwright two-client proximity smoke (dev-auth server on a scratch port) → "SMOKE OK"
FORGE_MISSION_DIR=/opt/data/forge/missions/20260902-214545-4532 node scripts/ui-states.js
                                       # drives 5 client failure/empty states, screenshots to <mission dir>/.forge-tmp/ui-states/ → "UI-STATES OK"
node scripts/bench.js                 # perf baseline: bundle size, /api/health + WS latency, 5min RSS churn (~6 min wall time)
#   BENCH_CHURN_MS=30000 node scripts/bench.js   # shorter run for quick iteration
# Live suites need a running server WITH Supabase — blocked on this box, say so in every report:
#   npm run test:blocking · npm run test:race · npm run test:fuzz · npm run test:concurrent
graphify query "<question>" --graph /opt/data/convoy/graphify-out/graph.json   # or `graphify update .` here (graphify-out/ is gitignored)
```

## Blocked (needs a human)
Supabase/TomTom/Resend/Piper credentials (`server/.env`); Android toolchain (no adb/java/gradle → APK cannot be built or run); merging `forge/convoyv2`; Play Console tasks; store name decision ("Slipstream" in `strings.xml` vs "Convoy").

## Guardrails
Never push to upstream `main`; never deploy/SSH/load-test odoreeci.tech; never edit `/opt/data/convoy`; never commit secrets; never change `applicationId`/signing/versionCode/versionName; Nearby Voice stays OFF by default; never record audio; never mark a bug FIXED without a code pointer (+ test where testable); never skip/weaken tests; never add runtime deps without a measured win; never hammer third-party APIs (`BOTS=0`, collectors faked); no rewrites.

## Log
- 2026-09-02 stage 1 (plan): imported upstream history + 2 cherry-picks; `cd server && npm ci`; `node test/run.js` → All 184 checks passed / 21 suites (19.7 s); copied Playwright toolchain; wrote plan + this file.
- 2026-09-02 stage 1 (plan): `node scripts/smoke.js` in this workspace → SMOKE OK rc=0 (log: /opt/data/forge/missions/20260902-214545-4532/.forge-tmp/smoke.log)
- 2026-09-02 stage 2 (implement, M1): truthed all 33 Server+Runtime `BUGS.md` entries (16 FIXED / 13 OPEN / 4 OBSOLETE, each with a current file:line). Closed `server-024` (global per-connection WS message budget, `WS_MSG_BUDGET` env-tunable, default 60/s, drop-not-close) and `runtime-005` (tomtom.js wasn't passing a 400 status on bad coords, so server.js's 400-branch was dead code and every bad `/api/route` body still 502'd) — both pinned with new tests in `test/serverpolicy.test.js` (groups W1, R2) and `runtime-005`'s fix additionally verified by reverting it locally and confirming the pinning test fails with the exact pre-fix symptom. Fixed 3 test suites (`admin.test.js`, `hotspots.test.js`, `ota.test.js`) that never cleaned up their `mkdtempSync` temp dirs — 101 stale `/tmp/convoy-*` dirs → 0 after a full run. Wrote `scripts/bench.js` and recorded the M1 perf baseline (see Metrics above); found (did not fix — left as `server-028` for M8) a 31% RSS growth over a 5-min synthetic churn window, unconfirmed whether real leak or normal V8 behavior. `node test/run.js` → All 184 checks passed / 21 suites (19.66s); true cross-suite total 1043→1049. `graphify update .` run. No client asset changed → no cache-buster bump this stage.
- 2026-09-02 stage 5 (implement, M2): truthed all 31 Frontend+UI/UX `BUGS.md` entries (20 FIXED / 10 OPEN / 1 OBSOLETE) — most of the July ledger turned out already fixed by earlier passes; wrote `scripts/ui-states.js` (5 client states driven end-to-end against a real dev-auth server, screenshots to the mission `.forge-tmp/ui-states/`, ran clean — 0 new defects found). Fixed 3 real client bugs found genuinely OPEN: `js/dragy.js` uploadPB sent a literal `Bearer false`/`Bearer undefined` header when the auth token was missing (frontend-005, now short-circuits); `js/net.js` teardownLive nulled the whole convoy + retoasted on every socket drop including sub-second blips (frontend-013, now coalesces a drop burst into one grace-delayed transition via `PARTY_DROP_GRACE_MS`, with the toast suppressed until the link actually holds); `js/sim.js`'s `solo` flag and its unreachable `if (solo)` physics branches deleted (frontend-003 — solo simulation is deliberately disabled in production, the dead code was a maintenance hazard, not a live bug). All three pinned in new `test/netparty.test.js` (9 checks) + a `test/behaviour.test.js` block (3 checks); frontend-005 additionally revert-and-confirmed. Also: `test/ota.test.js` cleanup moved to `process.on('exit', …)` (exception-safe, matches `hotspots.test.js`); `server-024`'s burst-tolerance non-token-bucket design documented in `server/server.js:73-87` + `BUGS.md`; M1's plan DoD wording (`≥195`/`≥6`) corrected in `STATE.md`. `rm -rf www && node test/run.js` → All 184 checks passed / 22 suites; true cross-suite total 1049→1061. Bumped all 45 `?v=cy116`→`?v=cy117` tags (uniform, client JS changed); built OTA bundle `ota-out/bundle-1.0.117.zip` (348 KB, sha256 `d0d4e3f4…c7c1c3f`) via `node scripts/copy-web.js && node scripts/pack-ota.js --offline --force --reuse-www`. `graphify update .` run. Pushed `forge/convoyv2` to `https://github.com/CronusAztec/convoy.git` and opened/refreshed the PR (see stage report for URL) — APK/AAB build and the odoreeci.tech deploy remain human-only actions (no JDK/gradle/adb, no VPS credentials on this box).
