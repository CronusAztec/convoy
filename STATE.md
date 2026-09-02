# STATE.md — Convoy v2 mission workspace

> Maintained by the implementer after every stage. Read this first, then `BUGS.md`, then the last 10 commits.

## Mission
Forge mission `20260902-214545-4532` ("convoyv2"): continuous improvement of Convoy in every area, one area per pass, evidence-driven. Full text: `/opt/data/forge/missions/20260902-214545-4532/MISSION.md`. Plan: `/opt/data/forge/missions/20260902-214545-4532/stages/0001-c000-plan.md`. Hard rule from the human: use graphify; look for and use skills (`hermes skills list`).

## What this workspace is
Full history of `https://github.com/CronusAztec/convoy` (upstream `main` = `b9fe23a`, "Sync versionName to the shipped cy116 stamp") imported at `9f1dfe1`, plus two cherry-picks:
- `29a8245` — owner's local `ponytail/stdlib-dedupe` commit (base64url + AbortSignal.timeout via stdlib; not on GitHub yet).
- `b2b5b9a` — prior mission 20260902-201910-6806's reviewed Milestone 1: `CONVOY_DEV_AUTH=1` guest-only boot without Supabase (refuses under `NODE_ENV=production` / `APP_URL=https://odoreeci.tech`), `www/` self-heal in `test/run.js` + `pretest`, `scripts/smoke.js` two-client Playwright proximity smoke, `playwright` devDependency.
Read-only reference clone: `/opt/data/convoy` (never edit). Production: https://odoreeci.tech (shares this box's public IP; at most one `GET /api/health` per stage; never deploy or load-test).

Stack: vanilla-JS client (`index.html`, `js/*.js` 44 modules / 20,994 lines, `css/styles.css` 3,445 lines) + Node/WebSocket server (`server/`, 12,814 lines, deps `ws` 8.21.0 + `pg` 8.23.0, Supabase Auth proxied) + Capacitor 8.4 Android shell (`android/`, `tech.odoreeci.convoy`, versionName 1.0.116, versionCode 4). Web stamp `?v=cy116` on 45 tags in `index.html`; next stamp is `cy117`.

## Chosen direction
Evidence-driven audit → fix → verify loop, rotating areas: **M1 Realtime/server (ledger truthing + `server-024` WS frame budget + perf baseline) → M2 client resilience/panel states → M3 auth/session → M4 upstream failure isolation → M5 HUD a11y/copy → M6 voice → M7 Android (static only) → M8 performance → M9 docs/release branch.** Details and definitions of done in the plan §6.

## Metrics
- M1 ledger accuracy: every `BUGS.md` Server+Runtime entry now status-tagged FIXED (code pointer, +test where testable) / OPEN (current repro re-verified) / OBSOLETE (reason) — **DONE for Server (27) + Runtime (6) = 33 entries**: 16 FIXED, 13 OPEN, 4 OBSOLETE. See `BUGS.md` → "Server + Runtime ledger truthing (2026-09-02)" for the full table and per-ID status lines. Frontend/Android/UI-UX/Runtime-extras sections are still untruthed — Frontend is next in the M2 plan.
- M2 tests: `node test/run.js` green every stage; **check count strictly grows** each implement stage. IMPORTANT: the printed "All N checks passed" line at the very end of a full run is `admin.test.js`'s own count (184), not a sum — it happens to print last. The real cross-suite total (sum every suite's own count) is the metric that must grow: **1043 → 1049 this stage** (+6: 4 new checks pinning `server-024`'s fix, 2 pinning `runtime-005`'s fix). Compute it with: `node test/run.js 2>&1 | grep -oE 'All [0-9]+ checks passed' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s}'`.
- M3 perf baseline — **DONE, measured in M1** via the new `scripts/bench.js`: client bundle 1094.7KB raw / 343.8KB gzip (44 scripts + index.html + css), `/api/health` p50=0.5ms/p95=1.5ms/p99=4.1ms, WS connect→welcome p50=50.5ms/p95=71.1ms @50 sockets, RSS 80.0MB→105.0MB (+31.2%) over 5min/25-client churn. Full numbers and the new `server-028` (unconfirmed RSS-growth) finding in `BUGS.md`. Future stages should re-run `node scripts/bench.js --out <path>` and diff against these, not re-derive from scratch.
- M4 ship-readiness: each cycle ends with cache-buster bumped **(only if a client asset changed — none did this stage, server-only)**, `graphify update .`, `BUGS.md` + `STATE.md` updated, per-change commits, branch `forge/convoyv2` pushable (push to a branch only; merge is human).

## Current milestone
**M1 — DONE.** Realtime/server: Server+Runtime ledger truthed (33/33 entries), `server-024` closed (global per-connection WS message budget), `runtime-005` closed as a bonus (found while truthing: looked fixed, wasn't — one-line real bug), perf baseline recorded, 3 test suites' stale `/tmp/convoy-*` leak fixed. **Next milestone: M2 — client resilience and panel states** (plan §M2). Start at the Handoff below.

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
rm -rf www && node test/run.js        # 21 unit suites; harness fakes in test/harness.js; no network
node scripts/smoke.js                 # Playwright two-client proximity smoke (dev-auth server on a scratch port) → "SMOKE OK"
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
