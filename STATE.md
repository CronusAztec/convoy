# STATE.md — Convoy mission workspace

> Maintained by the implementer after every stage. Read this first.

## Mission
"work on convoy app, make it better and app store ready by adding features, making the main focus on the app the nearby voice function, and all voice functions." (Forge mission 20260902-201910-6806; plan: `/opt/data/forge/missions/20260902-201910-6806/stages/0001-c000-plan.md`)

## What this workspace is
The full history of `https://github.com/CronusAztec/convoy` (`main` = `b9fe23a`, "Sync versionName to the shipped cy116 stamp") merged into the Forge workspace repo (import commit `9cf3ed9`). A read-only reference clone lives at `/opt/data/convoy` — never edit it. The app is live at https://odoreeci.tech (production; this container shares its public IP — at most one `GET /api/health` per stage).

Stack: vanilla JS client (`index.html`, `js/*.js`, `css/styles.css`) + Node/WebSocket server (`server/`) + Capacitor 8 Android shell (`android/`, package `tech.odoreeci.convoy`, versionName 1.0.116, versionCode 4, targetSdk 36). Voice: `js/voice.js`, `server/server.js` (`voice:*` handlers, `voiceTargets()`), `android/app/src/main/java/tech/odoreeci/convoy/VoicePlugin.java`.

## Chosen direction
Make **Nearby Voice** (the existing proximity voice mode, today hidden in Settings as "Auto voice chat") the hero feature on the main screen, make it reliable on Android with the screen off (microphone foreground service, audio focus, Bluetooth), make the relay fallback cheap, then voice commands + spoken alerts, and in parallel a Google Play production-readiness pass. Deliver as PR branch `forge/nearby-voice` on the upstream repo. No transport rewrite, no VPS deploys, no pushes to `main`.

## Metrics
- M1: two-client automated voice test passes over a local dev server (`node scripts/smoke.js`, later `npm run test:voice-e2e`).
- M2: `npm run store:check` passes; human reports "Available on Google Play" (production).
- M3: voice checks in `npm test` grow from 127 to ≥300; voice items in `BUGS.md` closed.

## Current milestone
**Milestone 1 — DONE** (Workspace runnable end-to-end without Supabase: dev auth mode `CONVOY_DEV_AUTH=1`, tests independent of a pre-built `www/`, Playwright two-page smoke). See the plan §5. **Next up: Milestone 2 — Nearby Voice on the main screen.**

Backlog order: ~~1 runnable~~ → 2 Nearby Voice main-screen UI → 3 relay/reliability → 4 Android background mic → 5 Play readiness → 6 voice commands → 7 spoken alerts → 8 e2e in CI → 9 headless Android build → 10 PR.

## How to run
```
npm install && (cd server && npm install)
npm run copy-web                          # generates www/ (gitignored) — tests and Capacitor need it
CONVOY_DEV_AUTH=1 BOTS=0 PORT=5173 node server/server.js   # guest-only, no Supabase project needed
# real backend instead: BOTS=0 PORT=5173 node server/server.js  (needs SUPABASE_URL/SUPABASE_SECRET_KEY/SUPABASE_DB_URL in server/.env)
# solo/web mode without a server: python3 -m http.server 5173  (then open index.html)
```
`CONVOY_DEV_AUTH=1` is implemented in `server/server.js` (see the `DEV_AUTH` const near the top and the `boot()` function): it skips the Supabase Auth / Postgres / JWKS fatal checks and boots guest-only (no accounts, sign-in, friends, stats or reports — the realtime layer never touches `store`/`sb` for a guest, see `handlers.hello`). It refuses to start when `NODE_ENV=production` or `APP_URL=https://odoreeci.tech`, so it can never turn the real service into a sandbox.

## How to test
```
npm test                              # runs `pretest` (copy-web) then node test/run.js — 21 suites / 184 checks
node test/voice.test.js               # voice module alone (127 checks)
node scripts/smoke.js  /  npm run smoke   # two-client Nearby Voice smoke test (see below)
```
Last verified 2026-09-02 ~21:10 UTC in this workspace: `All 184 checks passed. All 21 suites passed.` and `SMOKE OK`, both from a clean `rm -rf www`.

`test/run.js` now self-heals `www/` if missing (so `node test/run.js` works standalone), and `npm test` also has an explicit `pretest` hook that runs `scripts/copy-web.js` first — belt and braces, either alone is enough.

### `scripts/smoke.js` (Playwright two-client Nearby Voice test)
Boots `CONVOY_DEV_AUTH=1 BOTS=0` server on a scratch port, launches headless Chromium (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`), opens two browser contexts with fake geolocation ~300 m apart, drives each through the real guest-onboarding UI (click "Continue as guest" → check the 3 consent boxes → "Start riding →"), calls `A.sim.ensureWatch()` to start the GPS watch (on real devices this normally starts from a "locate me" tap or routing — see `js/sim.js:554,775` — the smoke test triggers it directly since there's no such control to click yet), waits for a real GPS fix + a live websocket, turns on `A.voice.setProxMode('radius')` on both pages, and asserts each side's `A.sim.proximityIds('radius')` contains the other (the same set `js/voice.js`'s `computeProxIds()` uses to decide who to link voice to). Exits 0 and prints `SMOKE OK` on success.

**First run needs Chromium downloaded once**: this box's global `PLAYWRIGHT_BROWSERS_PATH` (`/opt/hermes/.playwright`) is root-owned/read-only and only has `chrome-headless-shell` (no fake-media flag support), so `scripts/smoke.js` forces `PLAYWRIGHT_BROWSERS_PATH=0` (Playwright's own per-project cache). Run once: `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium` (~185 MB download, one-time; already done in this workspace — the browser lives in `node_modules/playwright-core/.local-browsers/`, gitignored via `node_modules/`).

**Does not prove real voice audio/WebRTC yet** — it proves the proximity *matching* pipeline (GPS → server rider broadcast → client NPC list → `proximityIds`) works end-to-end with two independent browser sessions, which is the prerequisite for Milestone 2's UI and Milestone 8's full e2e (ICE/mic-graph assertions, per the plan). `js/voice.js`'s `startParty()`/`acquireMic()` should fire automatically once `computeProxIds()` is non-empty (that's what `reconcile()` does), but this smoke test doesn't yet assert `A.voice.peerIds()` — left for Milestone 2 when the same script's checks get extended (per the plan: "toggling it links two smoke clients").

## Human-only actions (surface in every review)
1. Merge the PR and run `node release.js` (Windows + Android Studio JBR) / `node release.js --ota` for JS-only changes.
2. Play Console: FGS declarations (location + microphone) with demo videos, background-location prominent-disclosure declaration, Data safety form, listing assets, closed test (12 testers × 14 days if personal account created after Nov 2023), production rollout.
3. Decide the store name: `strings.xml` says "Slipstream", everything else says "Convoy".
4. Two-phone real-device test of Nearby Voice (screen off, Bluetooth headset, mobile data).
5. Optional: Supabase dev creds in `server/.env`; a TURN server; Apple account + Mac for iOS.

## Guardrails
Never push to upstream `main`, never deploy/SSH to the VPS, never load-test odoreeci.tech, never commit secrets or change `applicationId`/signing, never enable Nearby Voice by default, never record audio, never spend money, never edit `/opt/data/convoy`.

## Log
- 2026-09-02 stage 1 (plan): imported upstream history, installed deps, verified tests, wrote plan + this file.
- 2026-09-02 stage 2 (implement, Milestone 1): added `CONVOY_DEV_AUTH=1` to `server/server.js` (guest-only boot, no Supabase needed, refused in production); made `npm test`/`node test/run.js` regenerate `www/` automatically (`pretest` script + self-heal in `test/run.js`); added `scripts/smoke.js` (Playwright two-client Nearby Voice proximity smoke test) + `npm run smoke`; added `playwright` devDependency + downloaded Chromium locally (`PLAYWRIGHT_BROWSERS_PATH=0`, see above); added the new `playwright` dependency to `SDK-INVENTORY.md` (test-only, never shipped) to keep `sdk-inventory.test.js` green. All 21/21 suites + smoke verified from a clean `www/`.
