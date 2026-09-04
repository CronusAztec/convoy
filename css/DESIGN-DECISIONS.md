# Design-identity allowlist (plan amendment §5(a))

`node /opt/data/skills/creative/impeccable/scripts/detect.mjs --json index.html css/styles.css js/ui.js`
reports **17** findings after cycle 2 stage 10's typography floor + progress-bar-transform work
(down from 37; see `STATE.md`). None of the 17 are defects — this file is the checked-in record of
why, so no future stage either "fixes" the app's visual identity away or quietly lowers the
`detectorWarnings` baseline in `test/frontend-baseline.json` without a real reduction backing it.

Counts below must always sum to the detector's current total. If a future stage changes one of
these, update both this table and `test/frontend-baseline.json` in the same commit.

| Finding | n | Justification |
|---|---|---|
| `dark-glow` | 6 | Deliberate: neon-on-dark HUD identity, legible at night. Guardrail #8 (plan) forbids removing the incumbent visual identity. |
| `side-tab` | 4 | Deliberate: the edge-docked panel affordance (Nearby/Convoy/Profile/Scan tabs) is the app's core navigation metaphor, not a stray border. |
| `codex-grid-background` | 2 | Deliberate: the map-grid motif is the product's visual signature (HUD scanlines / grid overlay). |
| `gpt-thin-border-wide-shadow` | 2 | Deliberate: the cut-corner panel treatment (`clip-path` + hairline border + depth shadow) that defines every panel in the app. |
| `repeating-stripes-gradient` | 1 | Deliberate: hazard-stripe motif on warning/alert states — semantically meaningful, not decorative noise. |
| `clipped-overflow-container` | 2 | **False positive.** Fires on `html`/`body`, which carry `overflow: hidden` (`css/styles.css:101-109`) while containing `position: fixed` children. This is backwards twice over: (a) `overflow:hidden` on `html,body` is load-bearing — it is what prevents rubber-band/overscroll on the app's primary platform (mobile WebView); removing it to chase this finding would break scrolling behavior app-wide. (b) The flagged children are `position: fixed`, which is not clipped by an ancestor's `overflow` at all (no `transform`/`filter` establishing a containing block here). Re-litigating this needs a real browser and a real overscroll repro — this box has neither (see STATE.md, M2 formally dropped). |
| **Total** | **17** | |

## Why this file exists instead of chasing the detector to 0

`STATE.md`'s "Amended targets" (cycle 0 stage 4) already drew this line for the *pre-readability-pass*
version of the detector output (13 identity findings out of the original 37). This file supersedes
that inline note now that the actionable subset (`undersized-ui-text`, `tiny-text`,
`layout-transition`) has actually been driven to zero (cycle 2 stage 10) and the remaining count is
stable at 17. `test/frontend-baseline.json`'s `detectorWarnings` is pinned at 17; `testBaselineRatchet()`
fails the suite if it is ever raised without a corresponding real fix.

## Animation budget (mission 20260903-173653-75d3, aspect P-C)

Infinite (`animation: … infinite`) declarations in this stylesheet may only animate `transform`
and/or `opacity`. Any other animated property (`background-position`, `box-shadow`, `width`, …)
forces Chrome to repaint the element every frame for as long as the animation runs, forever, on
every rider's screen — the compositor thread can only take over transform/opacity. If you add an
infinite animation that touches anything else, `test/frontend.test.js`'s `testAnimationBudget()`
(`infinitePaintAnimations` in `test/frontend-baseline.json`) will catch it and fail the suite.

The established pattern for a "pulsing ring" effect (`ringPulse` at `css/styles.css:1831`, and the
cycle-6 conversions of `hudScan` and `livePulse` below) is: keep any *static* shadow/border/
background on the element or a pseudo-element as a fixed value, and animate only `transform: scale()`
/`opacity` on top of it. `width`-based progress bars use the same idea (cycle 2 stage 10: `transform:
scaleX()` instead of animating `width`).

Cycle 6 converted the two infinite paint animations that run continuously with no user action —
`hudScan` (`#hud-scan`, the full-viewport scanline overlay, was animating `background-position-y`)
and `livePulse` (`.dot-live`, the header's live-status dot, was animating `box-shadow`) — to
transform/opacity via the pseudo-element pattern above. Three remain and are a deliberate,
documented exception rather than a forced conversion: `wtPulse` (`.wt-btn.wt-live`), `wtChipPulse`
(`.member-chip.wt-speaking .u-ava`) and `detPulse` (`[data-anim="on"] .ralert-detector`) each
animate **two** independently-varying `box-shadow` layers (inset + outer glow, or two glows with
different alpha *and* spread on each keyframe) — geometry a single `transform: scale()` ring cannot
reproduce pixel-for-pixel without a visual regression, and this box has no browser to verify one
against. All three only run while transmitting/speaking/alerting (zero idle cost — they are never
on screen on a default, quiet screen), so the honest trade is to pin `infinitePaintAnimations` at
**3** rather than force a lossy conversion. Converting them is still open work for a future stage
with a way to actually look at the result (STATE.md §8 human item 4).
