# STATE — Convoy (the map, not the diary)

> Rewritten 2026-09-03 18:45Z by the planner of mission **20260903-173653-75d3** ("make Convoy load faster, render smoother, use fewer resources").
> Plan: `/opt/data/forge/missions/20260903-173653-75d3/stages/0001-c000-plan.md` (§4 = the prioritized action plan, §6 = milestones).
> The previous mission's 136 KB STATE.md (cycles 0–61, aspects A–C) is archived verbatim in `HISTORY.md`. Owner of this file: the implementer; ≤ 400 lines / 30 KB.

## 1. What this app is
"Slipstream" (UI) / Convoy (repo): a passenger-side multiplayer map for riders — live nearby riders, convoys with chat and walkie-talkie voice (WebRTC mesh + WS relay), routing/ETA, police/radar/scanner/aircraft/traffic overlays, drag-timer and race modes, HUD instrument cards. Live at https://odoreeci.tech (Caddy → Node on VPS 2.25.184.90) and as a Capacitor Android APK with an OTA channel (`/api/ota`). Real riders use production — treat it gently (one request is a measurement, a loop is an attack).

## 2. Stack & layout
- **Frontend:** vanilla ES5-style JS, no bundler/framework. `index.html` (shell, CSP meta, 44 `defer` scripts + `css/styles.css`, all stamped `?v=cyNNN`), `js/*.js` (44 modules on `window.App`), `css/styles.css`, `legal/*.html`. Boot: `js/app.js` → `mapview.init()` → 20+ `*.init()` → `auth.boot()`. Global state + event bus: `js/state.js` (`A.state.on/off/emit`). WS client: `js/net.js`. Telemetry: `js/telemetry.js` (batched, `sendBeacon`).
- **Map:** MapLibre GL 5.24.0 (jsdelivr pin), vector tiles from `tiles.openfreemap.org` / `basemaps.cartocdn.com`; 14 layers in `js/mapview.js` (`setData()` at `:433` is the single fan-in).
- **Server:** `server/server.js` (HTTP + `ws`, 1 Hz tick, `scopeFor()` per viewer), `server/httpcache.js` (static cache policy), `server/telemetry.js`, `server/overpass.js`, `server/hotspots.js`, `server/store.js`/`db.js`/`supabase.js` (accounts in Supabase Postgres; realtime state in memory + JSON under `server/data`). Node ≥ 18 (box: v26.5.1).
- **Native:** `android/` (Capacitor 8; plugins for background location, BLE radar, voice, OTA) — code-only here; shipping needs the human's keystore.
- **Tooling:** `test/run.js` (32 suites), `test/frontend.test.js` (jsdom + axe-core + html-validate + impeccable detector + ratchet on `test/frontend-baseline.json`), `scripts/pack-ota.js`, `scripts/copy-web.js`, `release.js`, `deploy/live-deploy.sh` + `deploy/PUSH-RUNBOOK.md`. Knowledge graph: `graphify-out/graph.json` (3480 nodes).
- **Generated / never edited:** `www/`, `ota-out/`, `graphify-out/` (regenerate with `graphify update .`).

## 3. How to run / test / ship
```bash
cd /opt/data/convoy
python3 -m http.server 5173          # solo mode (riders simulated); node server/server.js needs server/.env (Supabase) — not on this box
npm test                             # green = "All 32 suites passed." (frontend.test.js 102 checks; bootAssetGzipBudget measured ≤ 358400)
npm run test:frontend                # the ratchet suite alone; prints the measured baseline keys
graphify query "<question>"          # before editing;   graphify update .   # after editing (AST-only, no key)
# lab performance bench (milestone P0 builds it): node test/perf-bench.js [--idle] → JSON; skips with exit 0 if no browser
# browser on this box: ~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome (--headless --no-sandbox --disable-gpu); scratch playwright in /tmp/pw-scratch — never in package.json. Full recipe: HISTORY.md "Headless Chromium — working recipe" (test/browser.test.js still names STATE.md for it)
deploy/live-deploy.sh diag           # read-only production status (any stage, once)
deploy/live-deploy.sh release -- --ota   # PUSH STAGE ONLY, per deploy/PUSH-RUNBOOK.md (Lane A = web + OTA; Lane B = site only)
```
Stamp rule: a stage that edits `index.html`/`css/`/`js/`/`legal/` bumps all 45 `?v=cyNNN` stamps by one (`sed -i 's/?v=cy123/?v=cy124/g' index.html && grep -oc '?v=cy124' index.html` → 45) and runs `node scripts/pack-ota.js --offline 2>&1 | tail -6`. Server-only stages do not bump. **Now:** local `cy123`, production `cy122` (the previous mission's last push never ran) → the first push of this mission runs Lane A and ships `cy123`; the next web edit bumps to `cy124` only after that push, or ships together with it — LOCAL − PROD stays exactly one.

## 4. Aspect roadmap (one at a time; an aspect closes only with a shipped release)
| # | Aspect | Status | Closes when |
|---|---|---|---|
| P-A | Measurement harness (plan T0.1–T0.3) | **current — milestone P0** | `node test/perf-bench.js` prints DCL / long tasks / JS exec / requests / bytes / idle rAF-per-s (1× and 4× CPU) and skips cleanly without the browser; `vitals` field event accepted by `/api/telemetry` with an executed test; one PSI mobile run in the push report |
| P-B | Load faster (T1.3 fonts/CSS non-blocking, T1.4 zero boot API calls, T1.5 `data.js`/themes on demand, T2.2 lazy feature modules, T2.3 `ui.js` split, T2.5 self-hosted fonts, T3.1 two-stage boot) | next (P1, P4, P5) | `bootCriticalGzipBytes` ≤ 150 KB, `bootCriticalRequests` ≤ 20, `bootAssetGzipBudget` ≤ 300 KB, lab DCL ≤ 350 ms with 0 long tasks; shipped; PSI mobile LCP ≤ 2.5 s |
| P-C | Render smoother / idle cost (T1.1 parked rAF, T1.2 `#hud-scan`, T1.7 throttles, T2.4 containment + blur budget, T3.4 map layer budget) | P2 pulls T1.1/T1.2 forward | idle rAF/s ≤ 1, 0 long tasks in 30 s idle, field dropped-frame p75 ≤ 5 %, INP p75 ≤ 200 ms; shipped |
| P-D | Memory & state (T1.6 unsubscribes, T2.1 `test/leaks.test.js`, T3.3 keyed reconciliation) | P2 (RED) → P3 (GREEN) | leak suite Δ = 0 after 50 open/close + 50 join/leave cycles; heap flat within 5 % after 5 min simulated driving; shipped |
| P-E | Network & server (T2.6 payload deltas, T2.7 hotspot flush + scope cache, T3.2 service worker [CSP milestone], T3.5 pagination) | P6 then P8 | bytes/client/s pinned and −40 %, tick p95 < 5 ms at 60 simulated humans; shipped |
| — | Previous mission's aspects A (front-end), B (backend), C (smoothness C1–C4b) | closed / archived in `HISTORY.md` | C5 (≤ 30 requests) is absorbed by P-B |

## 5. Current milestone
**P0 — Lab bench + field vitals (aspect P-A).** Build `test/perf-bench.js` (copy `test/browser.test.js`'s `buildFixture()/runChromium()` pattern; drive the full Chromium via CDP with the scratch playwright in `/tmp/pw-scratch`; logging static server with `--host-resolver-rules="MAP * 127.0.0.1, EXCLUDE localhost"` so only same-origin traffic counts; record DCL, load, long tasks, total JS execution, requests, bytes; `--idle` = 30 s on the map shell counting long tasks + rAF callbacks/s; run 1× and 4× CPU throttle; JSON to stdout; exit 0 + SKIP when the browser is absent). Add the `vitals` event to `js/telemetry.js` (LCP/CLS/INP-approx via `PerformanceObserver`, `boot_ms`, `map_ready_ms`, 10 s dropped-frame sample; one event per session; respects the opt-out) and accept it in `server/telemetry.js` with a test in `test/telemetry.test.js`. Record the baseline JSON in the report and in §6 below. Web edit → stamp bump (see §3). Write the stage report at 60 % of budget.
Then: P1 (fonts/CSS non-blocking, 0 boot API calls, `A.util.loadScript` + `data.js`/themes on demand, define `bootCriticalGzipBytes`/`bootCriticalRequests`) → P2 (parked rAF, `#hud-scan` compositor-only, `test/leaks.test.js` RED) → P3 (leaks GREEN) → P4 (lazy feature manifest) → P5 (`ui.js` split) → P6 (WS payload measurement + deltas) → P7 (containment + blur budget + throttles) → re-plan → P8 (Tier 3).

## 6. Metrics (baseline → current → target; ratchet-down keys live in `test/frontend-baseline.json`)
| Metric | Baseline 2026-09-03 | Current | Target | Command |
|---|---|---|---|---|
| Full-boot same-origin gzip bytes (`bootAssetGzipBudget`) | 350 KB (measured 358321 B against pin 358400) | 358321 | ≤ 300 KB | `npm run test:frontend` |
| Same-origin boot requests (`bootAssetRequests`) | 46 (1 html + 1 css + 44 js) | 46 | ≤ 30 | `npm run test:frontend` |
| External origins (`bootExternalOrigins`) | 5 | 5 | 4 (fonts self-hosted) | `npm run test:frontend` |
| Pre-login critical path bytes / requests | not yet measured (= everything) | — | ≤ 150 KB / ≤ 20 | P1 adds the keys |
| Lab boot DCL / long tasks / JS exec (localhost, externals blackholed) | 705 ms / 2 / — (cycle-56 recipe) | — | ≤ 350 ms / 0 / ≤ 250 ms | `node test/perf-bench.js` (P0) |
| Boot API calls before any interaction | 3 (`/api/tts/health`, `/api/telemetry` ×2) | 3 | 0 | bench request log |
| Idle: rAF callbacks/s, long tasks in 30 s, full-viewport animated layers | 60 (unconditional `js/sim.js:281`), unknown, 1 (`#hud-scan`) | — | ≤ 1 / 0 / 0 | `node test/perf-bench.js --idle` |
| Leak gate (bus subscribers, document/window listeners, map listeners after 50 cycles) | no test; 0 `removeEventListener` in 44 files | — | Δ = 0 | `node test/leaks.test.js` (P2/P3) |
| Field Web Vitals p75 (LCP / INP / CLS), dropped-frame % | none collected | — | 2.5 s / 200 ms / 0.1; ≤ 5 % | `vitals` telemetry event (P0) |
| PSI mobile (external benchmark, one run per push) | not available from this box (API keyless quota refused, 18:37Z) | — | performance ≥ 90 | human: https://pagespeed.web.dev/ |
| Server: WS bytes/client/s, tick p95 | unknown | — | pinned, −40 %; < 5 ms @ 60 humans | `node test/concurrency.js` (P6 extends) |
| Quality gates (unchanged): `htmlValidateErrors` 13, `axeViolations_*` 0 ×6, `detectorWarnings` 17 | — | same | never up | `npm run test:frontend` |

## 7. Invariants / guardrails
1. No bundler, framework, TypeScript, or runtime dependency; lazy loading = `<script>` insertion with the same `?v=` stamp. `playwright` never enters `package.json` (scratch install only).
2. CSP allowlists (`index.html` meta + `server/server.js`), auth, and the two CDN pins change only when the milestone says so and `test/serverpolicy.test.js` passes.
3. Only the push stage deploys (`deploy/live-deploy.sh update|release`); other stages may run `diag` once. Stamp rule + stamp parity (§3). `pack-ota.js` ships the whole `www/`.
4. `test/frontend-baseline.json` ratchets down only (`testBaselineRatchet()`); new keys start at their measured value; a retired key never silently reappears higher.
5. **No number, no claim:** a performance change lands with a before/after from `test/perf-bench.js` or the field `vitals`.
6. Keep the visual identity (17 allowlisted detector findings, `css/DESIGN-DECISIONS.md`); reduced-motion seeding in `js/state.js:30-31` is correct; `fetchPolice`/`fetchWaze` are alerting paths — never blanket-pause or lazy-gate them.
7. Every stage: `graphify query` before editing, `graphify update .` after; `npm test` + `npm run test:frontend` green at the end; suite count and per-suite check counts never go down.
8. A swallowed-exception line in the production journal (`[handler …]`, `[defer] …`, `uncaughtException`) is a test gap: the fix is an executed test, never an allowlist or a log grep.
9. Never: build/upload an APK, `--force` an OTA, edit `/var/lib/convoy/*`, rename the product, loop requests at production or third parties.

## 8. Human-only actions (surface in every review and push report)
1. Android signing keystore (`android/key.properties` + `convoy-release.keystore`) — native changes ship only from the human's PC.
2. Production `convoy.env`: `ADMIN_TOKEN` < 24 chars, `SUPABASE_DB_CA` unset (Postgres TLS verification off) — set both.
3. Product name: Slipstream (UI) vs Convoy (repo).
4. Real-phone measurement, before and after P2/P7: Chrome `chrome://inspect` → Performance panel on the app's WebView; `adb shell dumpsys gfxinfo tech.odoreeci.convoy` (jank %) and `dumpsys meminfo tech.odoreeci.convoy` (RSS). Plus one https://pagespeed.web.dev/ mobile run per release (the keyless API refused this box).
5. Phone-layout questions from the previous mission still open: ui-005 (30 px clear button), ui-007 (`z-index: 6` tie), ui-008 keyboard overlap, ui-020/021 visual checks; > 100 chat lines between two devices after the `cy123` push.
6. Supabase keys in `server/.env` only if live-mode local testing is wanted.
7. Forge configuration (outside the workspace, `/opt/data/forge/`): give the implement stage a guaranteed report reserve (two report-less stages in the previous mission); point the push prompt at `deploy/PUSH-RUNBOOK.md`.

## 9. Recent history (one line per cycle; older in `HISTORY.md`)
- 2026-09-03 cycle 0 (this mission): plan v1 written; STATE.md rewritten to the map format; no code changed; 32 suites green; local `cy123` > production `cy122`.
- Previous mission cycle 61: chat-log freeze at line 100 fixed (`test/chatlog.test.js`), UI/UX truth pass, `cy122 → cy123` (push pending — never ran).
- Previous mission cycle 60: Frontend truth pass, `test/domids.test.js`, dead solo physics deleted (−1.6 KB gzip), shipped `cy122`.
- Previous mission cycle 59: visual pollers pause when hidden (`test/visibility.test.js`), shipped `cy121`.
- Previous mission cycle 58: convoy seat resume across reconnects (`test/partyresume.test.js`), shipped `cy120`.
