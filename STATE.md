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
- M1 ledger accuracy: every `BUGS.md` entry status-tagged FIXED (code pointer + test) / OPEN (repro re-verified) / OBSOLETE (reason). Baseline: 4 of 89 marked FIXED; spot-check found ≥ 7 more already fixed in code (server-003/008/012/021, runtime-003/006, server-026 partial). Verified open: `server-024` (no per-connection WS frame budget at `server/server.js` `ws.on('message')`).
- M2 tests: `node test/run.js` green every stage; check count strictly grows each implement stage. Baseline **184 checks / 21 suites, 19.7 s**.
- M3 perf baseline (to be measured in M1): client bytes, script count (45), `/api/health` p95, WS connect→welcome p95 @50 sockets, RSS after 5 min churn.
- M4 ship-readiness: each cycle ends with cache-buster bumped, `graphify update .`, `BUGS.md` + `STATE.md` updated, per-change commits, branch `forge/convoyv2` pushable (push to a branch only; merge is human).

## Current milestone
**M1 — Realtime/server: truth the Server+Runtime ledger, close `server-024`, record the perf baseline.** Not started. Start at plan §Handoff.

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
