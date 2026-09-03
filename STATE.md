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
| Gate | Baseline | Target | Command |
|---|---|---|---|
| M-A design-integrity findings (impeccable detector) | 37 (32 warnings, 5 advisories) | 0 warnings | `node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js \| grep -c '"antipattern"'` |
| M-B axe-core WCAG 2.2 AA violations in jsdom + open BUGS.md UI/UX bugs | not measurable yet; 13 UI/UX bugs listed, ui-003/011/013 confirmed open | 0 violations, all 13 closed | `npm run test:frontend` (created in Milestone 1) |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; all `Cache-Control: no-cache`; 45 stamped requests | ≤ 300 KB compressed; `immutable` for `?v=` assets; ≤ 30 requests | `node test/frontend-delivery.test.js` (Milestone 4) |

## Current milestone
**M1 — Front-end quality harness** (`test/frontend.test.js`: jsdom + axe-core + html-validate + detector gate;
`npm run test:frontend`; wired into `test/run.js`; baseline stored in `test/frontend-baseline.json`, ratchet down only).
Next: M2 headless Chromium attempt (time-boxed 20 min) → M3 accessibility fixes → M4 delivery perf → M5 tokens/type scale → M6 detector to zero → M7 ui.js split → M8 states → M9 responsive → M10 motion → M11 onboarding → M12 stamp bump + OTA dry run.

## Progress log
- 2026-09-03 stage 1 (PLAN): plan written; skills installed (`impeccable` + detector deps, `playwright`, `web-quality/accessibility`, `web-quality/performance`); baselines measured; STATE.md created. No app code changed.

## How to run (solo mode — no Supabase needed)
```bash
cd /opt/data/convoy
python3 -m http.server 5173     # open http://localhost:5173 (riders simulated on-device)
```
`node server/server.js` exits with "Supabase Auth is not configured" without `server/.env`; do not fabricate keys.
Production is https://odoreeci.tech (Caddy → Node). Never deploy from this box (human runs `node release.js --ota`).

## How to test
```bash
npm test                 # 21 Node suites, no network
npm run test:frontend    # after M1
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
`npm test` on 2026-09-03 00:44Z (planner stage, before any code change): **All 21 suites passed, 184 checks passed.** Keep it that way.
