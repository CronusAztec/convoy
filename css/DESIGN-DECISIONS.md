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

## Blur budget (mission 20260903-173653-75d3, aspect P-C, T2.4a, cycle 20)

`backdrop-filter` is the single most expensive rendering feature this app draws: it is recomputed
every frame over whatever is behind it, and the driving screen's backdrop is a continuously
repainting WebGL map. `css/styles.css`'s 23 `backdrop-filter` selectors (`.glass`, `.brand`,
`#search-input`, `.chip`, `.ctl`, `#dock`, `.panel`, `.eta-card`, `.toast`, `.pop-card`, `.wt-btn`,
`.wt-meta`, `.rider-arrow`, the radar-HUD surfaces, and a few smaller ones) sit permanently over that
map. `js/state.js`'s `glassOn()`/`applyGlass()` set `<html data-glass="on"|"off">` from the `glass`
setting (`auto` | `on` | `off`); `auto` drops the blur on `prefers-reduced-transparency: reduce` or a
low-memory device (`navigator.deviceMemory <= 4`) and otherwise keeps it. `test/frontend.test.js`'s
`testGlassBudget()` (`ungatedBlurSurfaces` in `test/frontend-baseline.json`, pinned at **0**) parses
every `backdrop-filter` declaration in the file and fails if a selector has no matching
`:root[data-glass="off"]` neutralizer — a future `backdrop-filter` added to the file without a
neutralizer is caught, not silently shipped.

**Two groups**, both immediately below the `.glass` rule at `css/styles.css:325-331`:

- **Group A — opaque replacement** (`backdrop-filter: none` + `background: var(--surface-solid)`):
  every selector whose translucency is pure decoration — `.glass`, `.brand`, `#search-input`,
  `.search-results`, `.avatar-btn`, `.chip`, `.ctl`, `#dock`, `.panel`, `.eta-card`, `.toast`,
  `.verify-banner`, `.pop-card`, `.wt-btn`, `.wt-meta`, `.ralert-foot`, `.rstat`, `#radar-dock`,
  `.hot-legend`, `.rider-arrow`, `.rlabel`, `.modal-card`, `.speedo`. `--surface-solid` is defined by
  every theme (`css/styles.css:112`/`:149`, and every entry in `js/themes.js`, including the derived
  value for user custom themes), so this never invents a colour outside the active theme.
  `.search-results` / `.toast` / `.pop-card` already use `var(--surface-solid)` as their normal
  background — the override is a harmless no-op for those three. `.verify-banner`'s normal background
  is a warn-tinted `color-mix(... var(--surface-solid))`; the glass-off override loses that tint in
  favour of a flat `--surface-solid` — a small, deliberate simplification for a rare, 8px-blur banner,
  not an oversight. `.rider-arrow`/`.rlabel` are small map-overlay labels on `var(--surface)` (0.72
  alpha); making them opaque under `data-glass="off"` makes their text *more* legible over the map,
  not less. `.modal-card`/`.speedo` (cycle 21) don't declare a `backdrop-filter` of their own in
  `css/styles.css` — they only need this override because the frost theme blurs them (see "Theme CSS
  is a second stylesheet" below); both are no-op adds visually (`.modal-card`'s base rule already sets
  `background: var(--surface-solid)`, and `.speedo` carries the `.glass` class this list already
  neutralizes).
- **Group B — blur removed only**, background untouched: `.modal-backdrop` (a full-screen scrim over
  the app behind every modal — forcing `--surface-solid` on it would black out that app instead of
  dimming it) and `.maplibregl-ctrl-attrib` (a legal map-attribution surface with its own
  `!important` background; not a decorative surface to restyle).

**Why `:root[data-glass="off"] <selector>`, never a bare `[data-glass="off"] <selector>`:**
`js/themes.js` injects each theme's CSS into a `<style>` tag *after* `styles.css` loads. The frost
theme (`js/themes.js:581-586`) sets a heavy `backdrop-filter` on `.glass, .panel, #dock` at
specificity `(0,2,0)` — the same specificity a bare `[data-glass="off"] .glass` would have. Because
frost's rule loads later in the cascade, an equal-specificity override loses to it and the blur
would silently return for any rider on frost. `:root[data-glass="off"] .glass` is `(0,3,0)` and wins
regardless of theme or load order. `testGlassBudget()` asserts every neutralizer selector carries the
`:root` prefix.

**Why `prefers-reduced-transparency: reduce`, not `prefers-reduced-motion: reduce`:** the app already
seeds `anim` (`js/state.js:29-31`, unchanged by this cycle) from `prefers-reduced-motion` — that is
correct and stays as-is (guardrail 6). Blur is not motion: a rider who asks for less motion has not
asked for less translucency, and conflating the two would strip the glass look from someone who only
wanted animations to stop. `prefers-reduced-transparency` (Chrome 118+) is the standards-correct
signal for "this user does not want translucent surfaces," so `[data-anim="off"]` is deliberately
**not** a trigger for `data-glass="off"` — proven by `test/glassbudget.test.js`'s dedicated check.

**In-repo precedent:** the `toon` theme (`js/themes.js:512-518`) has shipped `backdrop-filter: none`
across `.glass, .chip, .ctl, .panel, #dock, .eta-card, .toast, .btn, .modal-card, .speedo,
#search-input` since before this mission. A no-blur Slipstream is a look this codebase has already
built and kept — this cycle generalises the same idea into a quality *mode* available under every
theme, rather than a theme-specific override.

**Theme CSS is a second stylesheet (cycle 21):** `js/themes.js`'s `ensureCss()` injects each theme's
`css:` string into its own `<style>` tag at runtime — a real, separate stylesheet that
`testGlassBudget()` originally never read, so a theme could add a `backdrop-filter` outside
`css/styles.css` and reopen this exact budget invisibly. That happened once already: the frost theme
(`js/themes.js:581-586`) blurs `.glass, .panel, #dock, .eta-card, .chip, .ctl, .toast, .modal-card,
.speedo`, and the last two had no `:root[data-glass="off"]` neutralizer in `css/styles.css` — every
modal and the speedometer stayed blurred under `data-glass="off"` for any frost-theme rider. Fixed by
adding both to the Group-A list, and closed for good by widening the gate itself: `testGlassBudget()`
now also loads the real `js/themes.js` module (the same `buildWindow()`/`loadModules()` fixture
`testThemes()` already builds) and analyzes every registered theme's injected CSS as a second corpus,
normalizing each theme-prefixed selector (`[data-theme="id"] .foo` → `.foo`) before checking it
against the same `css/styles.css` neutralizer map (`ungatedThemeBlurSurfaces` in
`test/frontend-baseline.json`, pinned at **0**). **Rule for the next theme:** any `backdrop-filter`
a theme's `css:` adds must either target a selector already in the Group-A/B list above, or add its
own `:root[data-glass="off"]` override — the gate now fails loudly on either, so this cannot reopen
silently a second time.

**Real-device measurement (STATE.md §8):** this box cannot measure GPU cost — the only true
before/after is `adb shell dumpsys gfxinfo <pkg>` jank % on a mid-range Android phone, HUD rail /
chips / dock visible, Settings → Glass blur On vs Off. **Eyeball check with glass off:** every
panel/card must still read as a solid surface with legible text, and the modal scrim must still show
the app dimmed behind it, not blacked out.

## Containment (mission 20260903-173653-75d3, aspect P-C, T2.4b, cycle 22)

`contain: layout style paint` on `.panel` (`:696`) and `.modal-card` (`:1499`); `contain: layout style`
(no `paint`) on `.hud-card` (`:3461`). `.panel` is `position: fixed` with explicit
`top`/`right`/`bottom`/`width`, so its own box geometry comes from positioning, not content — layout
containment can't move it, and its existing `clip-path` already clips it, so `paint` adds no new visible
clip. `.modal-card` is already `overflow-y: auto` + `clip-path` — already a clip+scroll container, so
`paint` is a no-op on what's visible. `.hud-card` gets **no** `paint`: its text is rewritten every tick
(the app's hottest style/layout invalidation source) and it carries glow `box-shadow`s that paint
containment would clip. `.hud-rail` was deliberately left out for the same glow-clip reason.

**Verified geometry-neutral, not just claimed**: `test/perf-bench.js --geometry` (new this cycle) took
a rect+`overflow`/`zIndex`/`position` snapshot of a 13-selector allowlist before this CSS landed,
confirmed `geoDiffs: 0` after, and was mutation-tested (a deliberate CSS change on `.panel-head`
reliably produces `geoDiffs > 0`, naming the selector) before being trusted.

**Measured, not assumed**: `test/perf-bench.js --idle` now reads `Performance.getMetrics` deltas
(`layoutCount`/`recalcStyleCount`/…) straddling the idle window. Pre-CSS noise floor at n=3:
`layoutCount` {1,3,1} (median 1, spread 2). Post-CSS: {2,1,1} (median 1) — **no effect clearing the
noise floor on this box**. The CSS was kept anyway (geometry-neutral, correct invalidation hygiene) but
**T2.4b's containment half is closed as no-measurable-win, not as a win** — no `containedSurfaces`
ratchet was added. A real read needs `adb shell dumpsys gfxinfo <pkg>` with a side panel open
(STATE.md §8 item 4), which this box cannot run.
