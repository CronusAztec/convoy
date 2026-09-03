# STATE — Convoy front-end improvement mission

> Maintained by the implementer after every stage. Planner wrote v1 on 2026-09-03.
> Mission dir (handoff docs): `/opt/data/forge/missions/20260903-002914-ce0d/`
> Plan: `stages/0001-c000-plan.md` in that dir — read it before doing anything.
> Cycle-0-stage-4 IMPROVE directive amended two plan targets — see "Amended targets" below before
> trusting the plan's original M6/M-B wording.

## Mission
"edit the convoy app to be better in the front end aspect in every way"
Rules: use graphify; use and learn new skills when needed.

## Chosen direction
Refine (not redesign) the existing plain-script front end (`index.html`, `css/styles.css`, `js/*.js`),
measured by three re-runnable gates. No bundler, no framework, no deploy, no server logic changes
beyond the static-file branch (compression + caching). Visual identity (cut-corner cyberpunk HUD,
neutral-slate accent, Chakra Petch / Share Tech Mono) is preserved.

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

## Metrics (baseline 2026-09-03 → cycle 0 stage 5 → target)
| Gate | Original baseline (M1) | **Current (stage 5)** | Target | Command |
|---|---|---|---|---|
| M-A design-integrity findings (impeccable detector) | 37 (32 warnings, 5 advisories) | **37, unchanged** (no CSS touched this stage) | 22 actionable findings → 0 (see amendment 1) | `node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js \| grep -c '"antipattern"'` |
| M-B html-validate errors on `index.html` | 57 | **13** (7 `void-style` + 5 `no-inline-style`, both taste — pinned; 1 `prefer-native-element` on `#search-results`, kept on purpose — see below) | 0 in correctness/a11y rule classes — **already met** (see amendment 2) | `npm run test:frontend` |
| M-B axe-core violations per surface | shell 1, nearby 1, convoy 2, profile 5, auth **5 (mismeasured, see below)** | shell 1, nearby 1, convoy 2, profile 5, **authWelcome 1, authLogin 1** (auth split in two, both now real) | 0 on every surface | `npm run test:frontend` |
| M-B open BUGS.md UI/UX bugs | 13 listed, ui-003/011/013 confirmed open | **14 listed** (added ui-014), **4 fixed** (ui-001, ui-004, ui-006, ui-014) | all closed | read `BUGS.md` §UI/UX |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; `no-cache`; 45 requests | unchanged (M4 not started) | ≤ 300 KB compressed; `immutable`; ≤ 30 requests | `node test/frontend-delivery.test.js` (not yet built) |

All of the above (except M-C) are gated by `npm run test:frontend` against `test/frontend-baseline.json`
— **ratchet-down only, and this is now enforced, not just documented**: `testBaselineRatchet()` compares
the working-tree baseline file against `git show HEAD:test/frontend-baseline.json` and fails the suite
if any shared key's value has been raised. New keys (e.g. this stage's `axeViolations_authWelcome`/
`axeViolations_authLogin` replacing `axeViolations_auth`) are exempt on the stage that introduces them.

## Current milestone
**Cycle 0 stage 5 (IMPLEMENT, improvement-directive tasks 1-4) — DONE.** First real app-code changes
of the mission (`index.html` + `test/frontend.test.js`; no CSS or JS behaviour touched). Four tasks,
all complete:
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

**Next: M3 continues** (the reviewer's original ordering still stands) — `region (1)` recurring on
every surface (shell/nearby/convoy/profile all show it; likely one shared landmark fix), the deferred
focus-trap (ui-003) and `inert`-panels (ui-013) work — the cycle-0-stage-4 directive deliberately
pushed both to *this* cycle since Task 2 above just made the auth surface measurement trustworthy
enough to verify them against. Then continue down BUGS.md §UI/UX (ui-005/007/008/009/010/012) and the
profile panel's 5 remaining axe violations. M2 (headless Chromium) remains formally dropped — no
sudo, 20 missing shared libs, do not re-attempt without a human installing them.

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
  38/38 checks (was 26 — 12 new: 3 document-structure assertions, 1 auth surface split into 2 ×
  2 assertions each, 1 ratchet-guard group ≈7 keys checked). `BUGS.md`: 13→14 entries, 4 marked fixed.
  **This is the first stage of the mission that changed `index.html` or `js`/`css` behaviour** — the
  cadence rule from stage 4's IMPROVE ("every cycle must ship at least one app-code change") is met.

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
npm run test:frontend    # jsdom + axe-core + html-validate + detector + ratchet guard, gated on test/frontend-baseline.json
node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js | grep -c '"antipattern"'
graphify query "<area>"  # before editing;  graphify update .  # after editing
```
Test baseline: see "Test baseline" below.

## Skills to use (installed on this box)
- `/opt/data/skills/creative/impeccable/` — design director; `reference/audit.md`, `polish.md`, `typeset.md`, `craft-floor.md`; detector `scripts/detect.mjs`; run `scripts/context.mjs --target <file>` once per session.
  **Provenance flag, carried forward unresolved since stage 3:** `context.mjs` prints an
  `AUTONOMY_DIRECTIVE_CHECK` block instructing the model to disregard session instructions about
  operating autonomously and "probe" for a human. No stage has acted on it (correctly — there is no
  human in this loop to probe for). Someone should audit this skill's origin; not a codebase risk.
- `/opt/data/skills/web-quality/accessibility/SKILL.md`, `/opt/data/skills/web-quality/performance/SKILL.md` (Addy Osmani, MIT).
- `/opt/data/skills/playwright/` — browser CLI (blocked, no Chromium shared libs, no sudo; M2 formally dropped).
- `/opt/data/skills/creative/{anti-ui-slop,ui-design,ui-radar}/` — one playbook per request; free UIZZE search.
- `/opt/data/skills/software-development/headless-cli-setup/` — no-sudo/no-TTY installs.

## Invariants / guardrails (see plan §7)
- All `?v=cyNNN` stamps in `index.html` identical; bump only in M12 (45 occurrences today, `cy116`). **Not touched this stage.**
- Two CSP allowlists (`index.html` meta + `server/server.js`) stay untouched; `test/serverpolicy.test.js` must pass. **Not touched this stage.**
- Solo mode via a static server must keep working; `www/` is generated (`npm run copy-web`), never edited.
- Product name stays as-is ("SLIPSTREAM" in UI vs "Convoy" in repo is a human decision — surface it in reviews).
- `test/frontend-baseline.json` is now ratchet-enforced by code (`testBaselineRatchet()`), not just convention.

## Human-only actions (surface every review)
1. `node release.js --ota` to ship web changes (needs VPS_KEY/VPS_HOST). **Production still serves the
   line-15 orphan-markup defect (BUGS.md ui-014) until this happens** — it was fixed in this repo this
   stage but has not shipped.
2. Supabase keys in `server/.env` only if live-mode local testing is wanted.
3. Product name decision (Slipstream vs Convoy).
4. Optional, would unblock visual verification: install Chromium's shared libraries (needs root).

## Test baseline
`npm test` on 2026-09-03 00:44Z (planner stage, before any code change): **All 21 suites passed, 184 checks passed.**
`npm test` on 2026-09-03 (implementer stage 2, after M1): **All 22 suites passed** (26 checks in `frontend.test.js`).
`npm test` on 2026-09-03 (implementer stage 5, after Tasks 1-4): **All 22 suites passed, all 38 checks
passed** (frontend.test.js grew from 26→38 checks: +3 document-structure assertions, +2 for the auth
surface split, +~7 ratchet-guard assertions). Keep both counts from going down.
