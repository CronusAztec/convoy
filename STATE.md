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
| A | Front-end (cycles 0-4, closing in cycle 50) | **current** | `setShellInert` nesting fix + shell-restore invariant test + `#toasts` scoping landed; stamp bumped to `cy117`; review not BROKEN; push stage reports `cy117` served and `/api/ota` current = 1.0.117; livetest green |
| B | Backend / server (`server/*.js`) | next | BUGS.md server+runtime truth pass (33 entries re-verified against current code, statuses updated, `bugstats` green); every open critical/high server bug fixed **with a regression test**; stamped assets cached `immutable`; shipped via Lane B/A |
| C | Smoothness (delivery + client runtime) | after B | request count ≤ 30 on first load; reduced-motion/idle-CPU audit (plan v1 M10); reconnect UX (frontend-012/013); measured with the headless Chromium recipe below; shipped |
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
| M-B open BUGS.md UI/UX bugs | 13 listed, ui-003/011/013 confirmed open | **21 listed**, **11 fixed** (ui-001, ui-003, ui-004, ui-006, ui-013, ui-014, ui-015, ui-016, ui-017, ui-018, ui-019) — ui-003/ui-013 fixed this stage | all closed | read `BUGS.md` §UI/UX |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; `no-cache`; 45 requests | unchanged (M4 not started) | ≤ 300 KB compressed; `immutable`; ≤ 30 requests | `node test/frontend-delivery.test.js` (not yet built) |

All of the above (except M-C) are gated by `npm run test:frontend` against `test/frontend-baseline.json`
— **ratchet-down only, and this is now enforced, not just documented**: `testBaselineRatchet()` compares
the working-tree baseline file against `git show HEAD:test/frontend-baseline.json` and fails the suite
if any shared key's value has been raised. New keys (e.g. this stage's `axeViolations_authWelcome`/
`axeViolations_authLogin` replacing `axeViolations_auth`) are exempt on the stage that introduces them.

## Current milestone
**Cycle 3 stage 14 (IMPLEMENT, executing the cycle-3-stage-13 IMPROVE directive's tasks 1-5) —
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
(`~/.cache/ms-playwright`), do not redownload. Guardrail from the stage-13 directive still applies:
do not add `playwright` to `/opt/data/convoy/package.json` or wire it into `test/run.js`; keep using
a scratch directory outside the repo for one-off checks until a future cycle deliberately decides to
make this a permanent, CI-wired capability.

**Next (per the stage-13 IMPROVE directive):** `ui-003`/`ui-013` are done — the standing
four-deferral item is closed. `htmlValidateErrors` (13) and the `.htmlvalidate.json` rule-class
split (plan amendment §5(b)) remain deliberately untouched for a third cycle running — 13 markup
nits are still worth less than what just got fixed. With M2 now working, a natural next step is
using it to *resolve* (not just re-measure) ui-020/ui-021 with real in-app screenshots at real GPU
fidelity, and to finally look at what 14 stages of CSS/a11y work actually look like end-to-end —
but per the stage-13 directive's explicit scope, wiring a permanent screenshot capability into the
test suite is its own decision for a future cycle, not implied by this stage's one-off success.

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
1. **`node release.js --ota` to ship web changes (needs VPS_KEY/VPS_HOST) — now the single largest
   gap between work done and value delivered.** Production still serves the line-15 orphan-markup
   defect (BUGS.md ui-014), the 59 previously-unnamed controls (ui-015..019), the entire typography
   floor (76 declarations), the 5-site progress-bar performance fix, and — as of this stage — the
   keyboard-accessibility focus trap (ui-003) and the 133-phantom-tab-stop fix (ui-013). **14
   stages, nothing shipped.**
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

## Operating contract (cycle 50+, plan v2) — every role reads this; it is the tail of this file on purpose
1. **One aspect at a time.** Implement works only on the current aspect's next milestone from plan v2
   (`stages/0017-c050-plan.md` §6) as ordered by the latest IMPROVE directive. Moving to the next
   aspect requires the current one's "Closes when" row above to be true **and** a shipped release.
2. **Stamp rule (implementer, last code edit of the stage).** If the stage changed `index.html`,
   `css/`, `js/` or `legal/`, bump **all 45** stamps by exactly one:
   `sed -i 's/?v=cy116/?v=cy117/g' index.html && grep -oc '?v=cy117' index.html` (must print 45),
   then `node scripts/pack-ota.js --offline 2>&1 | tail -6` (must print `version 1.0.117`).
   Server-only stages do not bump. Never leave a mixed page. The bumped stamp is what the push stage
   uses to decide Lane A (web + OTA) vs Lane B (site only).
3. **Push gates** (`deploy/PUSH-RUNBOOK.md`): review verdict BROKEN or any BLOCKER → nothing moves;
   ACCEPTABLE with a HIGH → GitHub only; otherwise GitHub + `deploy/live-deploy.sh release -- --ota`
   (or `--no-apk`), then `/api/health`, `/api/ota`, served stamp, `livetest` — one request each.
4. **Only the push stage deploys.** Implement/review/improve never run `update`/`release`; review may
   run `deploy/live-deploy.sh diag` once (read-only). `www/` and `ota-out/` are generated, gitignored.
5. **Every stage:** `graphify query` before editing, `graphify update .` after; `npm test` and
   `npm run test:frontend` green before ending; suite count (23), per-suite check counts and the 7
   `test/frontend-baseline.json` keys never go the wrong way; a consistent tree at the end.
6. **Never:** build or upload an APK (no JDK/SDK/keystore here or on the VPS — verified 2026-09-03);
   `--force` an OTA; edit `/var/lib/convoy/*` by hand; touch CSP allowlists, auth or the two CDN pins
   without the milestone saying so and `test/serverpolicy.test.js` passing; add a bundler/framework;
   rename the product; loop health checks against production (shared IP with live riders).

## Human-only actions (v2 — surface in every review and every push report)
1. **Android signing keystore** (`android/key.properties` + `convoy-release.keystore`) or running
   `node release.js` from the PC that has them — the only way a native (`android/`) change ships.
2. Production `convoy.env` hardening seen in the boot log on 2026-09-03: `ADMIN_TOKEN` is under 24
   characters, and `SUPABASE_DB_CA` is unset (Postgres TLS verification disabled). Agents must not
   edit that file; the human should set both.
3. Product name (Slipstream in UI vs Convoy in repo) — still not an agent's call.
4. A 60-second look at the live app in a real browser after the first cycle-50 release (ui-021).
5. Supabase keys in `server/.env` only if live-mode local testing is ever wanted.
