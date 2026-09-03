# STATE — Convoy front-end improvement mission

> Maintained by the implementer after every stage. Planner wrote v1 on 2026-09-03.
> Mission dir (handoff docs): `/opt/data/forge/missions/20260903-002914-ce0d/`
> Plan: `stages/0001-c000-plan.md` in that dir — read it before doing anything.

## Mission
"edit the convoy app to be better in the front end aspect in every way"
Rules: use graphify; use and learn new skills when needed.

## Chosen direction
Refine (not redesign) the existing plain-script front end (`index.html`, `css/styles.css`, `js/*.js`),
measured by three re-runnable gates. No bundler, no framework, no deploy, no server logic changes
beyond the static-file branch (compression + caching). Visual identity (cut-corner cyberpunk HUD,
neutral-slate accent, Chakra Petch / Share Tech Mono) is preserved.

## Metrics (baseline 2026-09-03 → target)
| Gate | Baseline (measured M1) | Target | Command |
|---|---|---|---|
| M-A design-integrity findings (impeccable detector) | 37 (32 warnings, 5 advisories) | 0 warnings | `node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js \| grep -c '"antipattern"'` (also gated in `npm run test:frontend`) |
| M-B axe-core WCAG 2.2 AA violations in jsdom + open BUGS.md UI/UX bugs | **now measurable.** html-validate errors on `index.html`: **57**. axe violations (tags wcag2a/2aa/21aa/22aa/best-practice): shell **1**, nearby panel **1**, convoy panel **2**, profile panel **5**, auth screen **5**. 13 UI/UX bugs listed in BUGS.md, ui-003/011/013 confirmed open | 0 html-validate errors, 0 axe violations on every surface, all 13 bugs closed | `npm run test:frontend` |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; all `Cache-Control: no-cache`; 45 stamped requests | ≤ 300 KB compressed; `immutable` for `?v=` assets; ≤ 30 requests | `node test/frontend-delivery.test.js` (Milestone 4, not yet built) |

All of the above (except M-C, still M4's job) are now gated by `npm run test:frontend` against
`test/frontend-baseline.json` — **ratchet-down only**: a stage may lower a number by fixing a real
issue, never raise one to make a red run green.

## Current milestone
**M1 — Front-end quality harness — DONE this stage.** `test/frontend.test.js` (jsdom loads the real
`index.html` + evals the real `js/*.js` module chain into that same jsdom window in index.html's own
`<script>` order, minus the MapLibre CDN script and `app.js`'s DOMContentLoaded wiring; axe-core runs
on the closed shell and on the nearby/convoy/profile panels + auth screen opened through the real
`A.ui.openPanel()`/`A.ui.showAuth()`; html-validate checks `index.html`; the impeccable detector is
shelled out to). `npm run test:frontend` added to `package.json`; `frontend.test.js` added to the
`npm test` suite list in `test/run.js`. Baseline captured in `test/frontend-baseline.json`.
**Next: M2** headless Chromium attempt (time-boxed 20 min) → **M3** accessibility fixes (drive the
57 html-validate errors and 14 axe violations to 0, close BUGS.md ui-003/011/013/etc.) → M4 delivery
perf → M5 tokens/type scale → M6 detector to zero → M7 ui.js split → M8 states → M9 responsive →
M10 motion → M11 onboarding → M12 stamp bump + OTA dry run.

## Progress log
- 2026-09-03 stage 1 (PLAN): plan written; skills installed (`impeccable` + detector deps, `playwright`, `web-quality/accessibility`, `web-quality/performance`); baselines measured; STATE.md created. No app code changed.
- 2026-09-03 stage 2 (IMPLEMENT, M1): built `test/frontend.test.js` + `test/frontend-baseline.json`;
  wired into `package.json` (`test:frontend`) and `test/run.js`; added `jsdom`/`axe-core`/`html-validate`
  as devDependencies (`npm audit fix` cleared 3 transitive vulns, 0 remain) and a row for them in
  `SDK-INVENTORY.md` (test-only, not shipped) so `test/sdk-inventory.test.js` stays green. `npm test`
  now runs **22 suites** (was 21). No app code (`index.html`/`css/*`/`js/*`) changed this stage —
  M1 is harness-only by design, per the plan's M1 scope.

## How to run (solo mode — no Supabase needed)
```bash
cd /opt/data/convoy
python3 -m http.server 5173     # open http://localhost:5173 (riders simulated on-device)
```
`node server/server.js` exits with "Supabase Auth is not configured" without `server/.env`; do not fabricate keys.
Production is https://odoreeci.tech (Caddy → Node). Never deploy from this box (human runs `node release.js --ota`).

## How to test
```bash
npm test                 # 22 Node suites, no network (includes frontend.test.js)
npm run test:frontend    # jsdom + axe-core + html-validate + detector, gated on test/frontend-baseline.json
node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js | grep -c '"antipattern"'
graphify query "<area>"  # before editing;  graphify update .  # after editing
```
Test baseline (`npm test` on 2026-09-03, planner stage): see "Test baseline" below.

## Skills to use (installed on this box)
- `/opt/data/skills/creative/impeccable/` — design director; `reference/audit.md`, `polish.md`, `typeset.md`, `craft-floor.md`; detector `scripts/detect.mjs`; run `scripts/context.mjs --target <file>` once per session.
- `/opt/data/skills/web-quality/accessibility/SKILL.md`, `/opt/data/skills/web-quality/performance/SKILL.md` (Addy Osmani, MIT).
- `/opt/data/skills/playwright/` — browser CLI (blocked until M2 gets Chromium libs without sudo).
- `/opt/data/skills/creative/{anti-ui-slop,ui-design,ui-radar}/` — one playbook per request; free UIZZE search.
- `/opt/data/skills/software-development/headless-cli-setup/` — no-sudo/no-TTY installs.

## Invariants / guardrails (see plan §7)
- All `?v=cyNNN` stamps in `index.html` identical; bump only in M12 (45 occurrences today, `cy116`).
- Two CSP allowlists (`index.html` meta + `server/server.js`) stay untouched; `test/serverpolicy.test.js` must pass.
- Solo mode via a static server must keep working; `www/` is generated (`npm run copy-web`), never edited.
- Product name stays as-is ("SLIPSTREAM" in UI vs "Convoy" in repo is a human decision — surface it in reviews).

## Human-only actions (surface every review)
1. `node release.js --ota` to ship web changes (needs VPS_KEY/VPS_HOST).
2. Supabase keys in `server/.env` only if live-mode local testing is wanted.
3. Product name decision (Slipstream vs Convoy).

## Test baseline
`npm test` on 2026-09-03 00:44Z (planner stage, before any code change): **All 21 suites passed, 184 checks passed.**
`npm test` on 2026-09-03 (implementer stage 2, after M1): **All 22 suites passed** (21 pre-existing + `frontend.test.js`,
26 checks). Keep both counts from going down; the frontend-specific quality numbers (html-validate errors, axe
violations, detector warnings) are tracked separately in `test/frontend-baseline.json`, not in this pass/fail count.
