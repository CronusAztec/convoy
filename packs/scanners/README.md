# Police scanners (pack id `scanners`)

Live police and sheriff scanner audio near you, streamed in-app from
[OpenMHz](https://openmhz.com). This is the pre-cut `js/scanners.js` feature
(commit `a1de6fd`) re-homed as a feature pack: served by the Convoy server
only to an account that redeemed a code for it, never part of the store
binary (see `packs/README.md` for the contract and the compliance argument).

## What it does

* Reverse-geocodes the rider's position (Nominatim, the same service the route
  search uses) to a US state, pulls the OpenMHz system directory and ranks
  what is nearby: law enforcement first, then the rider's own city, then the
  most-listened systems. US coverage; outside the US the list is empty and
  says so.
* Tapping a system plays it **in-app**: one `<audio>` element streams the
  system's recent calls (m4a) back-to-back, a 6 s poller appends every call
  newer than the last one queued, talkgroup names are resolved so the bar reads
  "LAPD DISPATCH", not "TG 101". Pause / volume / stop live in the bar.
* Autoplay refusal (no user gesture survived the fetch) is surfaced as
  "Tap ▶ to start audio". A bad clip is skipped. An OpenMHz hiccup self-heals
  on the next poll and only shows "Reconnecting…" after two misses.

## Regulated — off by default

Receiving public-safety radio in a moving vehicle is restricted or illegal in
several US states and licensed in some countries, so:

* `scannersEnabled` defaults to **false**. The chip is hidden until the rider
  switches the pack on in **Settings → Police scanners**.
* That switch, the chip tap and the first play go through
  `A.ui.legalGate('scanners', …)` with the notice the core used to carry as
  `FEATURE_NOTICES.scanner` ("Before you listen in" — the six states, the
  licence note, the misuse line). Once per Terms version; a Terms bump voids
  the acknowledgement and a row tap re-opens the notice instead of playing.
* The moment the account stops holding the pack (`A.store` `packs` event with
  `A.packs.has('scanners')` false) the audio stops, the directory closes and
  the chip hides. Switching the setting off does the same.

## Files

```
packs/scanners/pack.json     manifest: legal key "scanners", order 30
packs/scanners/scanners.js   the module (settings, notice, settings section, chip, directory, player)
packs/scanners/scanners.css  the POLICE SCANNERS section of the old css/styles.css + chip dot + settings note
packs/scanners/chip.html     the SCANNERS chip, mounted into #chips (append), hidden
test/packs-scanners.test.js  the suite (node test/packs-scanners.test.js)
```

No server half: `server/packs/scanners.js` does not exist. OpenMHz is keyless
and the old build called it straight from the client too (there was never a
proxy); `media-src`/`connect-src https:` in the CSP already allow
`api.openmhz.com`, `media.openmhz.com` and `nominatim.openstreetmap.org`.

## Environment

None. No API key, no server env, no collector, no migration.

## Settings it registers

| key | default | meaning |
|---|---|---|
| `scannersEnabled` | `false` | the regulated switch; shows the chip and allows playback |
| `scannerVol` | `0.9` (or the old `convoy.scanner.vol` localStorage value, if present) | player volume 0..1 |

## What changed against the old build

| old | now |
|---|---|
| `#chip-scan` in `index.html`, always visible | `chip.html` fragment, appended to `#chips`, hidden until the setting is on |
| `js/ui.js` init() shimmed the chip and lazy-loaded `js/scanners.js` (`A.lazy.scanners`) | the pack loads eagerly with the manifest; `init()` from `A.packs.register('scanners', …)` wires the chip |
| `FEATURE_NOTICES.scanner` in `js/ui.js`, `legalGate('scanner', …)` | `A.ui.registerFeatureNotice('scanners', …)` — the key is `scanners` (matches `pack.json` `legal`) |
| no settings section; no setting key | Settings → "Police scanners" section through `A.ui.addHook('settings')`; `scannersEnabled`, `scannerVol` via `A.store.registerSettings` |
| volume in localStorage `convoy.scanner.vol` | `scannerVol` setting (the old value seeds the default once) |
| the scanner CSS inside `css/styles.css` | `scanners.css`, linked by the loader |
| a failed `/systems` fetch rendered as "No live scanner feeds found" | rendered as "Couldn't reach the scanner directory" (it was unreachable, not empty) |
| `open()` repainted an older `find()` over a newer one; a close-then-open inside 200 ms re-hid the modal | sequenced; the hide timer is cancelled on open |
| the 6 s poller could stack requests on a stalled upstream; a paused player queued without bound | one in-flight poll at a time; the queue is capped at 40 calls |

Nothing was renamed on the wire: the pack has no HTTP routes and no socket
messages. `A.scanners` keeps its old surface (`open`, `close`, `find`,
`isPolice`, `stop`) plus `isOpen`, `setEnabled`.

## Known gaps

* The calls poller is a plain `setInterval`, not `U.poll`: it feeds audio and
  must keep running with the screen off. `U.poll` would pause it on a hidden
  page, which is right for pixels and wrong for a scanner.
* OpenMHz covers the US only; elsewhere the directory is honestly empty.
* Talkgroup names are best-effort (a system without a public talkgroup list
  shows "TG <n>").
* The directory overlay is built in JS on first open (as before) rather than
  as a fragment, so there is nothing of it in the page until the rider taps
  the chip.
