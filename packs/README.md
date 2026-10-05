# Feature packs

Convoy's store builds carry only the core product: live riders near you and
across the world, proximity voice, convoys with chat and walkie-talkie, routes,
profiles, friends, block/report. Everything else the app used to do — the
enforcement awareness, scanner audio, performance timers, map overlays, the
instrument HUD — was withdrawn from the binary on 2026-10-04 so the app can
pass Google Play and App Store review, and lives here instead, as **packs**.

A pack is served by the Convoy server to an **account that has redeemed a
code** for it (Settings → Feature packs). Nothing under `packs/` is ever copied
into `www/`, the APK, the IPA or an OTA bundle (`scripts/copy-web.js` names
what ships; `test/packs.test.js` pins that this directory is not in it). That
is the whole compliance argument, so it is worth stating plainly:

* A feature **inside the binary** that a code switches on is a hidden feature
  (Apple guideline 2.3.1) / undisclosed functionality (Play). Rejected.
* Interpreted code the app **downloads from its own origin** and runs in the
  WebView is allowed by both stores (Apple 2.5.2; Play's WebView rule), as long
  as it does not change the app's core purpose. Packs extend the map the rider
  already has. The redeem screen is visible to everyone, signed in or not, and
  the App Review notes carry a reviewer code (STORE-RELEASE.md).

## Layout

```
packs/<id>/pack.json        manifest (below)
packs/<id>/*.js             client modules — the same vanilla ES5 App modules
packs/<id>/*.css            stylesheets, loaded beside the scripts
packs/<id>/*.html           fragments, mounted into the page before the scripts run
packs/<id>/README.md        what the pack does, env it needs, how to run its collectors
server/packs/<id>.js        OPTIONAL server half: HTTP routes + socket handlers,
                            every one dispatched only for an account holding <id>
server/packs/<id>/          OPTIONAL helpers for the server half (feeds, collectors)
test/packs-<id>.test.js     the pack's own suite; test/run.js picks it up by name
```

`<id>` is `^[a-z][a-z0-9-]{1,31}$` and must match `pack.json`'s `id`.

### pack.json

```json
{
  "id": "example",
  "title": "Example pack",
  "blurb": "One line a rider sees on the redeem screen.",
  "legal": "example",
  "order": 50,
  "scripts": ["a.js", "b.js"],
  "styles": ["example.css"],
  "fragments": [{ "file": "hud.html", "mount": "#dock", "position": "before" }]
}
```

* `scripts` run **in order**, after the fragments are mounted and the styles
  linked. A pack must have at least one.
* `fragments[].mount` is a CSS selector on the live page (default `body`);
  `position` is `append` (default), `prepend`, `before` or `after`. The server
  inlines the markup into the manifest, so the page never fetches it.
* `legal` names the legality notice key the pack registers (see below);
  `null` for a pack with nothing regulated in it.
* `order` sorts the catalogue (lower first).
* File names are bare — no paths, no `..`. Every listed file must exist.
  `pack.json` itself is never served.

## How a pack reaches the app

1. `js/packs.js` (shipped, a loader only) calls `GET /api/packs` with the
   account's bearer. The answer lists the packs the account holds, each script
   and style as `/packs/<id>/<file>?t=<signed token>`, and the fragments inline.
2. The static handler refuses anything under `/packs/` without a token that
   verifies, is unexpired, names **that** pack, and whose account **still**
   holds it — so a revoke or a kill switch (`pack:<id>` on the admin Flags
   board) lands on the next load, not when the token runs out.
3. Fragments → styles → scripts, in order; then `A.packs.register(id, {init})`
   callbacks run; then `A.store` emits `pack:loaded` and `packs`.

Signed out, `A.packs.has(id)` answers `false`. Loaded code cannot be unloaded
in-page; a pack that listens for the `packs` event should stand its UI down
when `A.packs.has(id)` turns false, and the server stops serving its data the
moment the grant is gone.

## The core's extension points

Packs never edit core files. Everything they need is reachable through these:

| Surface | What it gives you |
|---|---|
| `A.packs.register(id, { init })` | `init()` runs once, after the whole pack has loaded. |
| `A.packs.has(id)` / `holds(id)` / `state()` | Is it loaded / granted / the full picture. |
| `A.store.registerSettings({ key: default, … })` | Adds settings keys. `setSetting()` then accepts them; a value the rider saved earlier wins over the default. |
| `A.store.on(evt, fn)` / `emit` | The event bus (`setting`, `gpsfix`, `route`, `party`, `packs`, `pack:loaded`, …). |
| `A.store.featureAcked(key)` / `ackFeature(key)` | Legality-notice state, scoped to the Terms version. |
| `A.ui.addHook('settings', fn(body, kit))` | Add a settings section. `kit` = `{ row, toggle, field, segmented, select, swatches }`, the core's own builders. Runs after Units, before the Feature packs section. |
| `A.ui.addHook('profile', fn(body))` | Add to the profile page, after Awards. |
| `A.ui.addHook('profile-overlay', fn(actions, subject, card))` | Add a button to a rider's public-profile action row. |
| `A.ui.addHook('init', fn)` | Runs once the UI is up (immediately if it already is). |
| `A.ui.registerFeatureNotice(key, { title, lede, points })` + `A.ui.legalGate(key, proceed, cancel)` | Show the plain-words legality notice **before** a regulated feature switches on; once per Terms version. |
| `A.ui.toast`, `openOverlay(card)`, `closeOverlay`, `openPanel`, `closePanels`, `openProfileOverlay` | The core's chrome. |
| `A.mapview.onStyle(fn(map))` | Add sources/layers after the core's, on every `style.load` (and at once if the style is up). |
| `A.mapview.onClick(fn(e, map))` | Run before the core's click handling; return `true` to consume the tap. |
| `A.mapview.map()` | The MapLibre instance. |
| `A.net.on(type, fn)` / `off` / `send(obj)` | Socket messages your server half sends / receives. A core type cannot be claimed. |
| `A.routing.hook('request', fn(req))` | Add fields to the route request (an avoid list, …) before it is sent. |
| `A.routing.hook('routes', fn(routes, req))` | Filter / re-rank the routes; the first is drawn. |
| `A.routing.fetchRoutes`, `applyRoute`, `setDestination`, `say`, … | The routing surface. |
| `A.sim.playerPos()`, `getNpc`, `proximityIds`, `externalFix`, … | Live positions. |
| `A.util.fetchT(url, opts, ms)` | **Every** fetch goes through this (a deadline is mandatory). `U.poll`/`unpoll` for visual-only pollers that must pause on a hidden page. |

Need something not on this list? Add it to the core in a separate change and
document it here — a pack must never reach into a module's private scope.

## The server half

```js
module.exports = {
  id: 'example',
  init(ctx) {},                               // optional, once at boot
  routes: [                                   // fn(req, res, match, user, ctx)
    ['GET', /^\/api\/example\/thing$/, async (req, res, m, user, ctx) => ctx.json(res, 200, {})]
  ],
  ws: { 'example:ping'(c, m, ctx) {} },       // only for a socket whose c.packs has 'example'
  onHello(c, ctx) {},                         // optional: the socket just said hello and holds this pack
  onClose(c, ctx) {}                          // optional: it is gone
};
```

* Every route is reached only with a bearer for an account holding the pack
  (401 / 403 otherwise); a killed pack's routes 404.
* `ws` handler names must not collide with the core's or another pack's —
  boot refuses the pack if they do.
* `ctx` is `packCtx` in `server/server.js`: the live `clients`/`parties`/
  `online` maps, `send`, `rateOk`, `getRider`, `riderRecord`, `defer`,
  `validPos`, `num`, `cleanText`, `json`, `readBody`, `bearer`,
  `userFromToken`, `store`, `db`, `flags`, `tomtom`, `B` (the geo helpers),
  the tick constants, and `packs` (the registry). Add a line there if a pack
  needs more; never `require('./server')`.
* Rate-limit anything a rider can trigger with `ctx.rateOk(key, n, windowMs)`
  — the shared buckets, not a private array.
* Persist with `ctx.db.query` (awaited) and keep your own in-memory cache if
  the hot path needs synchronous reads; the core's `store` is for accounts.
* Env keys stay in `server/.env` and are read by the server half, never sent
  to the client.

## Rules every pack follows

* Nothing in a pack ships: do not reference `packs/` from `index.html`, `js/`,
  `css/`, `scripts/copy-web.js` or the OTA packer.
* Regulated features (enforcement markers, scanner audio, timed runs) call
  `A.ui.legalGate(key, …)` before switching on, and their settings default
  **off**.
* A pack degrades silently when its upstream is down (empty layer, a toast at
  most) and never throws out of a hook, an event handler or a socket message.
* Same discipline as the core: no new globals, `U.fetchT` for every fetch,
  `U.poll` for visual-only pollers, every `getElementById` resolves on the
  page as mounted, no font below 12px, no `backdrop-filter` beyond the glass
  budget, infinite animations on transform/opacity only.
* Its suite (`test/packs-<id>.test.js`) loads the pack's scripts in the
  harness against the real core chain and exercises the server half against
  fakes. `npm test` runs it.

## Operating

* Mint codes on `/admin/packs` (label, packs, max uses, expiry); the plaintext
  is shown once. Grant or revoke per account on `/admin/account/<id>`.
* Kill a pack for everyone from `/admin/flags` (`pack:<id>`); grants survive.
* Migration `server/migrations/004_feature_packs.sql` must be applied before
  the first redeem.
