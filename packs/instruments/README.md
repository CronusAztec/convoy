# Instrument panel — feature pack `instruments`

The windscreen instruments withdrawn from the store build, restored from the
pre-cut tree (`js/hud.js`, `speedo.js`, `compass.js`, `clock.js`,
`tripmeter.js`, `gmeter.js`, `weathernow.js`, `battery.js`, `coords.js`,
`destarrow.js`, `speedalert.js`, `dimmer.js`, `triplog.js`, `places.js`,
`tripextras.js`, the "Instruments" / "Drive log" / parking-pin sections of
`js/ui.js` and the `#ctl-park` control) as a pack served only to accounts that
redeemed a code. Nothing here is regulated; there is no legality notice.

## What it does

- **HUD rail** (top right): compass, clock + next sunrise/sunset, tripmeter,
  g-meter, weather now (Open-Meteo, keyless), battery (where the Battery API
  exists — not on iOS), coordinates (tap to copy), destination arrow. Each has
  a switch under Settings → Instruments; speedometer, compass and clock default
  on, the rest off, exactly as before.
- **Speedometer** (bottom left): GPS Doppler speed, else deltas, else the route
  preview pace; session top and average; tap to reset.
- **Overspeed alert**: a red banner and one beep per crossing of the chosen
  limit (off by default). **Night dimmer**: a scrim over the map (0 = off).
- **Drive log**: every navigation trip recorded locally (distance, duration,
  average/top speed, a thinned breadcrumb) with a lifetime odometer, on the
  profile page; any entry replays as a trail on the map. Nothing leaves the
  device.
- **Saved places**: star the destination on the route card; the list is on the
  profile page with one-tap routing. **Parking pin**: dropped automatically
  when a trip arrives (Settings → Auto parking pin) or from the Ⓟ map control,
  which otherwise flies back to the car; the pin offers "Walk back" / "Clear".
- **Route card extras**: share your ETA, save the place, weather at the
  destination for the arrival hour.

## Renamed / changed vs the old build

| Old | Now |
|---|---|
| `A.lazy.<instrument>` + `js/app.js` LAZY_INSTRUMENTS | eager: every module loads with the pack; `A.instruments.init()` starts them in rail order |
| Saved places in the search dropdown ("Saved" rows) | a "Saved places" section on the profile page (the search dropdown is core code; no hook yet) |
| `weathernow.js` raw `fetch` + hand-rolled 8 s abort | `U.fetchT(url, undefined, 8000)` |
| `#ctl-park` in the left control column of index.html | `packs/instruments/controls.html`, after `#ctl-global`, hidden until held |
| all settings in `js/state.js` DEFAULT_SETTINGS | same keys, registered by the pack (`hud.js`) |
| rail card labels at 9–10.5px | 12px (the typography floor) |

Visibility is one switch: `body.pack-instruments` is set while the account
holds the pack and removed on the `packs` event otherwise; the stylesheet hides
every instrument without it, pollers stop, and the parking marker is lifted.

## Left out

- The quest card (`hud-quest`) belongs to the performance timers pack.
- Saved places in the search dropdown (see above).

## Env

None. Everything is on-device except Open-Meteo (weather now, arrival weather),
which sees the position being asked about and nothing else.

## Files

`packs/instruments/{pack.json, controls.html, instruments.css, hud.js, speedo.js,
compass.js, clock.js, tripmeter.js, gmeter.js, weathernow.js, battery.js,
coords.js, destarrow.js, speedalert.js, dimmer.js, triplog.js, places.js,
tripextras.js, ui.js}`, `test/packs-instruments.test.js`. No server half.
