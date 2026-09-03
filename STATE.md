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
| B | Backend / server (`server/*.js`) | **current** — B1 opened in cycle 51 with a *measured* Overpass truth pass (section "Aspect B — backend truth pass (cycle 51)" below); the 33-entry BUGS.md server re-verification is still ahead | BUGS.md server+runtime truth pass (33 entries re-verified against current code, statuses updated, `bugstats` green); every open critical/high server bug fixed **with a regression test**; stamped assets cached `immutable`; shipped via Lane B/A |
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
| M-B open BUGS.md UI/UX bugs | 13 listed, ui-003/011/013 confirmed open | **22 listed**, **12 fixed** (ui-001, ui-003, ui-003b, ui-004, ui-006, ui-013, ui-014, ui-015, ui-016, ui-017, ui-018, ui-019) — ui-003b (the ui-003 regression) fixed cycle 50 stage 18 | all closed | read `BUGS.md` §UI/UX |
| M-C compressed same-origin text bytes / cache policy / requests | 1,033 KB JS + 144 KB CSS + 21 KB HTML uncompressed; `no-cache`; 45 requests | unchanged (M4 not started) | ≤ 300 KB compressed; `immutable`; ≤ 30 requests | `node test/frontend-delivery.test.js` (not yet built) |

All of the above (except M-C) are gated by `npm run test:frontend` against `test/frontend-baseline.json`
— **ratchet-down only, and this is now enforced, not just documented**: `testBaselineRatchet()` compares
the working-tree baseline file against `git show HEAD:test/frontend-baseline.json` and fails the suite
if any shared key's value has been raised. New keys (e.g. this stage's `axeViolations_authWelcome`/
`axeViolations_authLogin` replacing `axeViolations_auth`) are exempt on the stage that introduces them.

## Current milestone
**Cycle 51 stage 22 (IMPLEMENT, executing the cycle-50-stage-20 IMPROVE directive's Tasks 1-2) — DONE.
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
npm test                 # 22 Node suites, no network (includes frontend.test.js)
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

## Operating contract (cycle 50+, plan v2) — every role reads this; it is the tail of this file on purpose
1. **One aspect at a time.** Implement works only on the current aspect's next milestone from plan v2
   (`stages/0017-c050-plan.md` §6) as ordered by the latest IMPROVE directive. Moving to the next
   aspect requires the current one's "Closes when" row above to be true **and** a shipped release.
2. **Stamp rule (implementer, last code edit of the stage).** If the stage changed `index.html`,
   `css/`, `js/` or `legal/`, bump **all 45** stamps by exactly one:
   read the current stamp (`grep -oE '\?v=cy[0-9]+' index.html | sort | uniq -c`, one value, 45×), then e.g.
   `sed -i 's/?v=cy117/?v=cy118/g' index.html && grep -oc '?v=cy118' index.html` (must print 45),
   then `node scripts/pack-ota.js --offline 2>&1 | tail -6` (must print the matching `version 1.0.NNN`).
   Current stamp after cycle 50 stage 18: `cy117` — **production has served `cy117` since 2026-09-03 06:56Z**
   (cycle-50 push); local == production at the end of cycle 51 (rule 7).
   Server-only stages do not bump. Never leave a mixed page. The bumped stamp is what the push stage
   uses to decide Lane A (web + OTA) vs Lane B (site only).
3. **Push gates** (`deploy/PUSH-RUNBOOK.md`): review verdict BROKEN or any BLOCKER → nothing moves;
   ACCEPTABLE with a HIGH → GitHub only; otherwise GitHub + `deploy/live-deploy.sh release -- --ota`
   (or `--no-apk`), then `/api/health`, `/api/ota`, served stamp, `livetest` — one request each.
4. **Only the push stage deploys.** Implement/review/improve never run `update`/`release`; review may
   run `deploy/live-deploy.sh diag` once (read-only). `www/` and `ota-out/` are generated, gitignored.
5. **Every stage:** `graphify query` before editing, `graphify update .` after; `npm test` and
   `npm run test:frontend` green before ending; suite count (24), per-suite check counts and the 7
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

## Human-only actions (v2 — surface in every review and every push report)
1. **Android signing keystore** (`android/key.properties` + `convoy-release.keystore`) or running
   `node release.js` from the PC that has them — the only way a native (`android/`) change ships.
2. Production `convoy.env` hardening seen in the boot log on 2026-09-03: `ADMIN_TOKEN` is under 24
   characters, and `SUPABASE_DB_CA` is unset (Postgres TLS verification disabled). Agents must not
   edit that file; the human should set both.
3. Product name (Slipstream in UI vs Convoy in repo) — still not an agent's call.
4. A 60-second look at the live app in a real browser **now that the cycle-50 release is live (06:56Z)**: the
   routing/drag progress bars at phone width (ui-021), and open a race lobby, let the countdown tick, tap the
   dock (the ui-003b scenario).
5. Supabase keys in `server/.env` only if live-mode local testing is ever wanted.
6. **`release.js` OTA path** (raised by the cycle-50 push stage): `OTA_DIR_REMOTE` now defaults to
   `/opt/convoy/server/data/ota` because that is what the running server reads (`DATA_DIR` is unset in
   `convoy.env`). If the long-term intent was `/var/lib/convoy` as `DATA_DIR`, the right fix is
   `DATA_DIR=/var/lib/convoy` in `convoy.env` plus reverting `OTA_DIR_REMOTE` — an infra-layout call.
7. **Forge push-stage configuration** (raised by the cycle-50 improve stage): `claude-sonnet-5` at
   `reasoning: low`, default 1200 s budget, one-line role prompt that says "apk"; consider pointing
   `prompts/push.md` at `deploy/PUSH-RUNBOOK.md`. Lives under `/opt/data/forge/`, outside the workspace.
