# SDK inventory — what ships, and what it collects

This is the list the store privacy labels are filled **from**. Both stores ask you
to declare data collected by the SDKs in your app, not just the data your own
servers receive — Crashlytics, analytics and ad SDKs included, even when nothing
reaches you. Google runs an automated scan of the uploaded artifact and flags
undeclared device identifiers; Apple has required privacy manifests from common
SDKs since May 2024, and the app-level manifest ships at
`ios/App/App/PrivacyInfo.xcprivacy`.

**The rule: add a dependency, add a row here, then re-check both store forms.**
`test/sdk-inventory.test.js` fails the build if a dependency, a gradle artifact or
a remotely-loaded script appears that is not on this page. It is not a
substitute for reading the SDK's own privacy documentation — it only catches the
moment something new arrives.

Last verified against the source tree at the store-readiness cut (2026-10-04),
which removed the radar / scanner / racing / overlay features and their native
plugins. Re-verify against the **built artifact's merged manifest** before an
upload, because a dependency can inject a permission the source never mentions.
The expected merged Android permission set is: INTERNET, ACCESS_COARSE/FINE_LOCATION,
FOREGROUND_SERVICE(+_LOCATION), POST_NOTIFICATIONS, RECORD_AUDIO,
MODIFY_AUDIO_SETTINGS, and ACCESS_NETWORK_STATE (added by a transitive dependency).

Three absences matter for the store forms and are asserted here rather than assumed:
**no `com.google.android.gms.permission.AD_ID`** — so the Data Safety form needs no
advertising-ID declaration — **no `ACCESS_BACKGROUND_LOCATION`**, so the app avoids
Play's background-location review entirely (the location service is a *foreground*
service with `foregroundServiceType="location"`), and **no Bluetooth permission at
all** since the radar-detector plugin was removed.

---

## 1. Native — inside the Android app

| Component | Source | Runs | Collects | Device ID? |
|---|---|---|---|---|
| Capacitor (`capacitor-android`, `capacitor-cordova-android-plugins`) | `@capacitor/android` + `@capacitor/core` 8.x | WebView host | Nothing. Bridge between the WebView and the plugins below. | No |
| `@capacitor/geolocation` 8.x (gradle project `capacitor-geolocation`) | npm | Location bridge | Passes GPS fixes to the web layer. Does not phone home. | No |
| `@capacitor/app` 8.x (gradle project `capacitor-app`) | npm | App lifecycle + deep links | Delivers the URL the app was opened with (sign-in redirect, mailed link) to JS. Nothing leaves the device. | No |
| `@capacitor/browser` 8.x (gradle project `capacitor-browser`) | npm | System browser for sign-in | Opens the OAuth provider in the user's browser (Custom Tab on Android, SFSafariViewController on iOS). The **browser** sees the provider URL; the app does not read anything out of it. | No |
| `io.ionic.libs:iongeolocation-android` 2.2.0 | transitive of `@capacitor/geolocation` | Location | Wrapper over the fused provider. | No |
| **`com.google.android.gms:play-services-location`** | **transitive of `@capacitor/geolocation`** | Location | Google Play Services' fused location provider — the platform component that produces the GPS fix. Pulls in `play-services-base`, `-basement`, `-tasks`, `auth-api-signin` and `common`. Subject to [Google's Play Services terms](https://developers.google.com/terms) and Google's own location handling on-device. | No — no `play-services-ads`, no `AdvertisingIdClient` |
| `com.google.code.gson:gson` 2.13.2 | transitive | JSON | Nothing. Parser. | No |
| `org.jetbrains.kotlinx:kotlinx-coroutines-play-services` | transitive | Async glue | Nothing. | No |
| `androidx.appcompat:appcompat`, `androidx.coordinatorlayout:coordinatorlayout`, `androidx.core:core-splashscreen` | Google, Apache-2.0 | UI | Nothing. | No |
| `androidx.browser:browser` (Chrome Custom Tabs) 1.9.0 | Google, Apache-2.0 | Social sign-in | Hands the OAuth round-trip to the user's browser (the first-party `AuthPlugin`). | No |
| First-party Java plugins — `AuthPlugin`, `BackgroundLocationPlugin`, `LocationService`, `VoicePlugin`, `LiveUpdatePlugin` | this repo | Various | Ours, not third-party. Location and microphone, surfaced through the app's own UI; the OTA plugin downloads our own web bundle. | No |
| `junit`, `androidx.test.ext:junit`, `androidx.test.espresso:espresso-core` | test-only | — | Not in the release build. | — |
| `jsdom`, `axe-core`, `html-validate` | npm devDependency | `npm run test:frontend` only, on this dev box | Nothing — a headless DOM + a WCAG/markup linter that run against local files. Not in the release build, not in `www/`, not fetched by the device. | — |
| `acorn-globals` (pulls `acorn`, `acorn-walk`; all MIT) | npm devDependency | `npm test` only (the undefined-identifier and class gates), on this dev box | Nothing — a JavaScript parser + scope walker that reads local source files. Not in the release build, not in `www/`, not fetched by the device. | — |
| `@capacitor/cli`, `com.android.tools.build:gradle`, `com.google.gms:google-services` | build tooling | Build machine | Never linked into the app. `google-services` is a classpath entry only — see the note below. | — |

**Not present, deliberately:** Firebase (any module), Crashlytics, Firebase
Analytics / GA4, Google Mobile Ads, AppsFlyer, Adjust, Branch, Segment,
Amplitude, Mixpanel, OneSignal, Facebook SDK, any Bluetooth library.

> `android/build.gradle` carries the `com.google.gms:google-services` **classpath**,
> and `android/app/build.gradle` applies that plugin **only if
> `android/app/google-services.json` exists**. That file is not in the repo, so no
> Firebase library is linked. Dropping one in is enough to pull Firebase into the
> build and change the label — which is why the guard test asserts it is absent.

## 2. Native — inside the iOS app

| Component | Source | Runs | Collects | Device ID? |
|---|---|---|---|---|
| Capacitor (`@capacitor/ios` 8.x via Swift Package Manager, `CapApp-SPM`) | npm | WKWebView host | Nothing. Bridge. Ships its own privacy manifest. | No |
| `@capacitor/geolocation`, `@capacitor/app`, `@capacitor/browser` | npm (SPM packages under `node_modules`) | As on Android | As on Android. `IONGeolocationLib` wraps CoreLocation. | No |
| First-party Swift — `BackgroundLocationPlugin.swift`, `ViewController.swift` | this repo | Location | Ours. CoreLocation "When In Use" authorisation plus the `location` background mode; fixes go to the web layer only. | No |
| `ios/App/App/PrivacyInfo.xcprivacy` | this repo | App Store Connect check | The app-level privacy manifest: no tracking, no tracking domains, the collected data types from §7 below, and the one required-reason API Capacitor hits (`UserDefaults`, reason CA92.1). | — |

No CocoaPods, no third-party SDK beyond Capacitor and its three official plugins.

## 3. Web — code the app loads at runtime

The UI is a plain web app inside the WebView, so "SDK" here means remotely loaded
JavaScript. Each of these hosts sees the device's **IP address** and a
`User-Agent` when it is fetched.

| Component | Host | When | Collects |
|---|---|---|---|
| MapLibre GL JS 5.24.0 (+ CSS) | `cdn.jsdelivr.net` | Every launch | Nothing. Renderer, runs locally. jsDelivr sees the request. |
| TensorFlow.js 4.22.0 | `cdn.jsdelivr.net` | **Lazy** — only when a rider picks a profile photo | Nothing. The photo is screened on-device and never uploaded for screening. |
| NSFWJS 4.2.1 (fallback 2.4.2) + MobileNet model | `cdn.jsdelivr.net` | Same | Same. |
| Chakra Petch, Share Tech Mono (default theme) | `odoreeci.tech` (self-hosted, `/fonts/*.woff2`) | Every launch | Nothing beyond the normal page request. |
| Nine alternate-theme fonts (Oswald, Rajdhani, Audiowide, Orbitron, Cinzel/Quicksand, Bangers/Comic Neue, Inter, Monoton) | `fonts.googleapis.com`, `fonts.gstatic.com` | **Lazy** — only if a rider picks an alternate theme | Google Fonts sees the IP and User-Agent. No cookies. Riders on the default theme contact Google Fonts never. |
| Basemap styles + tiles | `basemaps.cartocdn.com`, `tiles.openfreemap.org` | Every launch | The tile hosts see the IP and **which map area is being viewed**. Disclosed in privacy §5. |

**OTA hotfix channel** (house-built, no SDK, Android only): `LiveUpdatePlugin.java` +
`js/ota.js` download the app's own web bundle (HTML/CSS/JS, the same tree the app
ships) from **our own server** (`odoreeci.tech`, `/api/ota` + `/ota/*.zip`),
sha256-pinned to the manifest. It is interpreted WebView code — permitted by Play
policy, which prohibits only downloaded *native* code — and it sends **no
identifier at all** (platform + version numbers only), so it adds nothing to the
Data Safety form. On iOS `js/ota.js` finds no plugin and does nothing; iOS fixes
ship through App Store Connect, which keeps the build within guideline 2.5.2.

**Feature packs** (house-built, no SDK; `packs/README.md`): the features
withdrawn from the store build are served from **our own server**
(`odoreeci.tech`, `/packs/<id>/*` behind signed, per-account URLs) only to an
account that redeemed a code, and only after sign-in. Interpreted WebView code
from our own origin, like the OTA channel, so permitted on both platforms; it
sends the account's bearer token and nothing else. A pack may call further
services directly — listed in §5 as *pack-only* — and `packs/<id>/README.md`
names each pack's server-side keys.

## 4. First-party telemetry

| Component | Where | Collects |
|---|---|---|
| `js/telemetry.js` → our own `/api/telemetry` | this repo | Crash type, message, stack, breadcrumbs, screen name, app version, device model + OS (from `User-Agent`), a fixed core-loop funnel, and once-per-session Web Vitals (`js/vitals.js`). Keyed by a **random session id created at launch and discarded on close**. No location, no destination, no message content, no username, no email. Opt-out in Settings. Retained 30 days. |
| **Sentry** (optional) | `sentryDsn` in `js/config.js` — **currently empty** | If a DSN is set, the same error payload also goes to Sentry. Posted as a plain envelope request; **no Sentry SDK is loaded on the page**. If you enable it, keep the Sentry row in `legal/privacy.html` §4 and add it to both stores' "third parties" answers. |

## 5. Services the device calls directly (not SDKs)

Nominatim (destination search) and OSRM (keyless routing). These are HTTP APIs the
app calls; no vendor code runs in the app. They see the IP address and the query.
Listed in full, with terms, in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
and disclosed in privacy §5.

*Pack-only* (never contacted unless the account holds the pack and the feature
is switched on; disclosed in privacy §5): `api.openmhz.com` + `media.openmhz.com`
(scanner directory and audio clips; the directory query carries the US state the
rider is in), `nominatim.openstreetmap.org` (the scanner pack's reverse
geocode, the same host the core uses for search), `api.open-meteo.com` (weather
at the position and at a route's destination), `api.rainviewer.com` +
`tilecache.rainviewer.com` (radar frames and tiles for the map area),
`api.weather.gov` (NWS alerts for the map centre, US only), and — through our
server, so the device's IP never reaches them — OpenSky (aircraft), the
OpenStreetMap Overpass service (police stations and cameras), OpenWeb Ninja/Waze
(live police) and TomTom (traffic flow and incidents) for the area around the
rider. The core build makes none of these requests.

## 6. Server-side processors

Supabase (accounts), Resend (email), TomTom (routing, proxied so the rider's IP is
never exposed), the OAuth providers the operator enables. These receive data from
**our server**, not from the app, and are named in privacy §4.

The server's own npm dependencies are `pg` (Postgres client) and `ws` (WebSocket
server) — both first-party infrastructure that talks only to systems we run.
Neither reaches the device, but they are listed here because a new server
dependency can be a processor, and that is a label question too.

---

## 7. Device identifiers — the thing Play's scanner looks for

**Convoy collects no device or advertising identifier.** Evidence, all
re-runnable:

```bash
# No ads SDK, no advertising-ID client, no Firebase Analytics in the shipped APK
unzip -p convoy.apk classes.dex > /tmp/all.dex
grep -ac "gms/ads" /tmp/all.dex            # 0
grep -ac "AdvertisingIdClient" /tmp/all.dex # 0
grep -ac "gms/measurement" /tmp/all.dex     # 0  (Firebase Analytics)
grep -ac "com/crashlytics" /tmp/all.dex     # 0
```

- The manifest declares **no `com.google.android.gms.permission.AD_ID`**. Play
  correlates that permission with advertising-ID use; its absence is the
  declaration.
- The only `com.google.firebase` symbols in the build are three exception classes
  that ship inside `play-services-base`. No Firebase library is initialised.
- The telemetry session id is random per launch, held in memory, and never
  persisted — it is not a resettable device identifier and cannot link two
  sessions.
- No `ANDROID_ID`, `getDeviceId`, IMEI or MAC read anywhere in the native code; no
  `identifierForVendor` or `advertisingIdentifier` in the Swift.

If you add anything that reads an advertising ID, you must declare the AD_ID
permission **and** the "Device or other IDs" data type (Apple: "Device ID" and
tracking). There is no version of that which is optional.

---

## 8. Play Data Safety — the answers

Derived from everything above. Re-check on every dependency change.

**Does your app collect or share any of the required user data types?** Yes.
**Is all data encrypted in transit?** Yes (HTTPS/WSS; the app refuses cleartext).
**Do you provide a way for users to request data deletion?** Yes —
`https://odoreeci.tech/delete-account`, plus in-app.

| Data type | Collected | Shared | Optional? | Purpose |
|---|---|---|---|---|
| **Location** → Approximate location | Yes | Yes — shown to nearby riders | Required | App functionality |
| **Location** → Precise location | Yes | Yes — shown to nearby riders | Required | App functionality |
| **Personal info** → Name | Yes | Yes — display name is public to riders | Required | App functionality |
| **Personal info** → Email address | Yes | No | **Optional** — only if the rider registers with one | Account management |
| **Personal info** → User IDs | Yes | Yes — username is public to riders | Required | App functionality, Account management |
| **Photos** → Photos | Yes | Yes — avatar is visible to riders | **Optional** | App functionality |
| **Messages** → Other in-app messages | Yes | Yes — to the convoy | Required for chat | App functionality |
| **Audio** → Voice or sound recordings | Yes | Yes — to the convoy and riders in voice range | Required for voice | App functionality |
| **App activity** → App interactions | Yes | No | **Optional** — Settings → Crash reports | Analytics |
| **App info and performance** → Crash logs | Yes | Only if a Sentry DSN is set | **Optional** | Analytics |
| **App info and performance** → Diagnostics | Yes | Only if a Sentry DSN is set | **Optional** | Analytics |
| **Device or other IDs** | **No** | — | — | — |

Also declare: **data is not sold**, **not shared with third parties for
advertising**, **no data collected for advertising or marketing purposes**.

Notes worth getting right on the form:

- **Chat and voice are transmitted, never stored.** Play offers an exemption for
  data processed ephemerally in memory. Convoy's chat and voice do qualify on the
  face of it, but they are declared anyway — the exemption is narrow, the
  downside of over-declaring is nil, and the downside of under-declaring is a
  policy strike.
- **"Shared" covers rider-to-rider visibility.** A live map is the product; the
  location genuinely does leave the device and reach strangers. Saying otherwise
  because they are "users, not third parties" is the kind of reading that gets
  an app pulled.
- **Diagnostics are marked optional** because there is a real off switch in
  Settings that stops all sending. If that switch is ever removed, this row stops
  being optional.
- **Foreground service types** (`location`): Play Console asks for a declaration
  and a short video of the feature in use for each type. The location service
  starts when the app opens (the live pin is the product) and shows a persistent
  notification; the video should show the notification and the pin moving with
  the screen off.

## 9. Apple App Privacy and the privacy manifest

The App Privacy questionnaire maps from §8 almost one-to-one; the answers are also
declared in `ios/App/App/PrivacyInfo.xcprivacy` so the upload is checked against
them:

| Apple data type | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|
| Precise Location | Yes (signed-in riders are identified by username) | No | App Functionality |
| Name, Email Address, User ID | Yes | No | App Functionality |
| Photos or Videos (avatar) | Yes | No | App Functionality |
| Other User Content (chat), Audio Data (voice) | Yes | No | App Functionality |
| Crash Data, Performance Data, Product Interaction | No (random per-launch session id) | No | App Functionality / Analytics |

**Tracking: none.** No tracking domains, no advertising identifier. The required-
reason API declared is `UserDefaults` (CA92.1 — app-only access), which Capacitor
and the WebView use for app-local preferences. Capacitor and its plugins ship
their own manifests; `npx cap sync ios` keeps them current.

Account deletion is already in place and satisfies guideline 5.1.1(v); Sign in
with Apple is offered beside any third-party sign-in on iOS (guideline 4.8) —
`js/ui.js` hides the social buttons on iOS if the server enables Google without
Apple. See [STORE-RELEASE.md](STORE-RELEASE.md).
