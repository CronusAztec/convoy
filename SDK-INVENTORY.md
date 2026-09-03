# SDK inventory — what ships, and what it collects

This is the list the store privacy labels are filled **from**. Both stores ask you
to declare data collected by the SDKs in your app, not just the data your own
servers receive — Crashlytics, analytics and ad SDKs included, even when nothing
reaches you. Google runs an automated scan of the uploaded artifact and flags
undeclared device identifiers; Apple has required privacy manifests from common
SDKs since May 2024.

**The rule: add a dependency, add a row here, then re-check the Data Safety form.**
`test/sdk-inventory.test.js` fails the build if a dependency, a gradle artifact or
a remotely-loaded script appears that is not on this page. It is not a
substitute for reading the SDK's own privacy documentation — it only catches the
moment something new arrives.

Last verified against `convoy.aab` (versionCode 4, versionName 1.0.114) and
`main` @ this commit — checked against the **built artifact's merged manifest**,
not just the source manifest, because a dependency can inject a permission the
source never mentions. The merged permission set is: INTERNET, ACCESS_COARSE/FINE_LOCATION,
FOREGROUND_SERVICE(+_LOCATION), POST_NOTIFICATIONS, RECORD_AUDIO,
MODIFY_AUDIO_SETTINGS, BLUETOOTH_SCAN/CONNECT (+ the legacy pair capped at API 30),
and ACCESS_NETWORK_STATE (added by a transitive dependency).

Two absences matter for the store forms and are asserted here rather than assumed:
**no `com.google.android.gms.permission.AD_ID`** — so the Data Safety form needs no
advertising-ID declaration — and **no `ACCESS_BACKGROUND_LOCATION`**, so the app
avoids Play's background-location review entirely. The location service is a
*foreground* service (`foregroundServiceType="location"`), which is a different,
much lighter declaration.

---

## 1. Native — inside the Android APK

| Component | Source | Runs | Collects | Device ID? |
|---|---|---|---|---|
| Capacitor (`capacitor-android`, `capacitor-cordova-android-plugins`) | `@capacitor/android` + `@capacitor/core` 8.x | WebView host | Nothing. Bridge between the WebView and the Java plugins below. | No |
| `@capacitor/geolocation` 8.x (gradle project `capacitor-geolocation`) | npm | Location bridge | Passes GPS fixes to the web layer. Does not phone home. | No |
| `io.ionic.libs:iongeolocation-android` 2.2.0 | transitive of the above | Location | Wrapper over the fused provider. | No |
| **`com.google.android.gms:play-services-location`** | **transitive of `@capacitor/geolocation`** | Location | Google Play Services' fused location provider — the platform component that produces the GPS fix. Pulls in `play-services-base`, `-basement`, `-tasks`, `auth-api-signin` and `common` (≈1,090 classes in the APK). Subject to [Google's Play Services terms](https://developers.google.com/terms) and Google's own location handling on-device. | No — no `play-services-ads`, no `AdvertisingIdClient` |
| `com.google.code.gson:gson` 2.13.2 | transitive | JSON | Nothing. Parser. | No |
| `org.jetbrains.kotlinx:kotlinx-coroutines-play-services` | transitive | Async glue | Nothing. | No |
| `androidx.appcompat:appcompat`, `androidx.coordinatorlayout:coordinatorlayout`, `androidx.core:core-splashscreen` | Google, Apache-2.0 | UI | Nothing. | No |
| `androidx.browser:browser` (Chrome Custom Tabs) 1.9.0 | Google, Apache-2.0 | Social sign-in | Hands the OAuth round-trip to the user's browser. The **browser** sees the provider URL; the app does not read anything out of it. | No |
| First-party Java plugins — `AuthPlugin`, `BackgroundLocationPlugin`, `LocationService`, `RadarDetectorPlugin`, `SabrePlugin`, `VoicePlugin` | this repo | Various | Ours, not third-party. Location, microphone and BLE, all surfaced through the app's own UI. | No |
| `junit`, `androidx.test.*`, `espresso-core` | test-only | — | Not in the release APK. | — |
| `jsdom`, `axe-core`, `html-validate` | npm devDependency | `npm run test:frontend` only, on this dev box | Nothing — a headless DOM + a WCAG/markup linter that run against local files. Not in the release APK, not in `www/`, not fetched by the device. | — |
| `@capacitor/cli`, `com.android.tools.build:gradle`, `com.google.gms:google-services` | build tooling | Build machine | Never linked into the app. `google-services` is a classpath entry only — see the note below. | — |

**Not present, deliberately:** Firebase (any module), Crashlytics, Firebase
Analytics / GA4, Google Mobile Ads, AppsFlyer, Adjust, Branch, Segment,
Amplitude, Mixpanel, OneSignal, Facebook SDK.

> `android/build.gradle` carries the `com.google.gms:google-services` **classpath**,
> and `android/app/build.gradle` applies that plugin **only if
> `android/app/google-services.json` exists**. That file is not in the repo, so no
> Firebase library is linked. Dropping one in is enough to pull Firebase into the
> APK and change the label — which is why the guard test asserts it is absent.

## 2. Web — code the app loads at runtime

The UI is a plain web app inside the WebView, so "SDK" here means remotely loaded
JavaScript. Each of these hosts sees the device's **IP address** and a
`User-Agent` when it is fetched.

| Component | Host | When | Collects |
|---|---|---|---|
| MapLibre GL JS 5.24.0 (+ CSS) | `cdn.jsdelivr.net` | Every launch | Nothing. Renderer, runs locally. jsDelivr sees the request. |
| TensorFlow.js 4.22.0 | `cdn.jsdelivr.net` | **Lazy** — only when a rider picks a profile photo | Nothing. The photo is screened on-device and never uploaded for screening. |
| NSFWJS 4.2.1 (fallback 2.4.2) + MobileNet model | `cdn.jsdelivr.net` | Same | Same. |
| Chakra Petch, Share Tech Mono | `fonts.googleapis.com`, `fonts.gstatic.com` | Every launch | Google Fonts sees the IP and User-Agent. No cookies. |
| Basemap styles + tiles | `basemaps.cartocdn.com`, `tiles.openfreemap.org` | Every launch | The tile hosts see the IP and **which map area is being viewed**. Disclosed in privacy §5. |

**OTA hotfix channel** (house-built, no SDK): `LiveUpdatePlugin.java` + `js/ota.js`
download the app's own web bundle (HTML/CSS/JS, the same tree the APK ships)
from **our own server** (`odoreeci.tech`, `/api/ota` + `/ota/*.zip`), sha256-pinned
to the manifest. It is interpreted WebView code — permitted by Play policy, which
prohibits only downloaded *native* code — and it sends **no identifier at all**
(platform + version numbers only), so it adds nothing to the Data Safety form.
First-party host, first-party code: a row here for the reviewer, not a new SDK.

## 3. First-party telemetry

| Component | Where | Collects |
|---|---|---|
| `js/telemetry.js` → our own `/api/telemetry` | this repo | Crash type, message, stack, breadcrumbs, screen name, app version, device model + OS (from `User-Agent`), and a fixed core-loop funnel. Keyed by a **random session id created at launch and discarded on close**. No location, no destination, no message content, no username, no email. Opt-out in Settings. Retained 30 days. |
| **Sentry** (optional) | `sentryDsn` in `js/config.js` — **currently empty** | If a DSN is set, the same error payload also goes to Sentry. Posted as a plain envelope request; **no Sentry SDK is loaded on the page**. If you enable it, keep the Sentry row in `legal/privacy.html` §4 and add it to the Data Safety "third parties" answer. |

## 4. Services the device calls directly (not SDKs)

Nominatim, OSRM, RainViewer, OpenMHz, Open-Meteo, NWS. These are HTTP APIs the
app calls; no vendor code runs in the app. They see the IP address and the query.
Listed in full, with terms, in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
and disclosed in privacy §5.

**Aircraft moved server-side.** OpenSky and airplanes.live used to be on this
list. They are not any more: OpenSky refuses cross-origin browser reads outright
(`Access-Control-Allow-Origin: https://opensky-network.org`) and airplanes.live
now answers 403 to everyone, so the layer was dead in every build. It is served
through our own `/api/aircraft` (see `server/aircraft.js`), which means the
device no longer contacts either host and **airplanes.live is no longer contacted
at all**. OpenSky is now a server-side processor — see §5 — and privacy §4 says
so. This is strictly less exposure than the page claimed before, but the page has
to be true either way.

## 5. Server-side processors

Supabase (accounts), Resend (email), TomTom (routing/traffic, proxied so the
rider's IP is never exposed), OpenSky (live aircraft, proxied for the same
reason), the OAuth providers the operator enables. These
receive data from **our server**, not from the app, and are named in privacy §4.

The server's own npm dependencies are `pg` (Postgres client) and `ws` (WebSocket
server) — both first-party infrastructure that talks only to systems we run.
Neither reaches the device, but they are listed here because a new server
dependency can be a processor, and that is a label question too.

---

## 6. Device identifiers — the thing Play's scanner looks for

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
- The only `com.google.firebase` symbols in the APK are three exception classes
  that ship inside `play-services-base`. No Firebase library is initialised.
- The telemetry session id is random per launch, held in memory, and never
  persisted — it is not a resettable device identifier and cannot link two
  sessions.
- No `ANDROID_ID`, `getDeviceId`, IMEI or MAC read anywhere in the native code.

If you add anything that reads an advertising ID, you must declare the AD_ID
permission **and** the "Device or other IDs" data type. There is no version of
that which is optional.

---

## 7. Play Data Safety — the answers

Derived from everything above. Re-check on every dependency change.

**Does your app collect or share any of the required user data types?** Yes.
**Is all data encrypted in transit?** Yes (HTTPS/WSS; the APK refuses cleartext).
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
| **Audio** → Voice or sound recordings | Yes | Yes — to the convoy | Required for voice | App functionality |
| **App activity** → App interactions | Yes | No | **Optional** — Settings → Crash reports | Analytics |
| **App activity** → Other user-generated content | Yes | Yes — hazard reports are public | Required | App functionality |
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

## 8. Apple App Privacy and privacy manifests

**There is no iOS target in this repo today** — `capacitor.config.json` builds
Android only. Nothing here needs a `PrivacyInfo.xcprivacy` yet.

If an iOS build is added, the work is:

1. Fill the App Privacy questionnaire from §7 — it maps almost one-to-one.
2. Ship an app-level `PrivacyInfo.xcprivacy` declaring the collected types and
   any [required-reason APIs](https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_use_of_required_reason_api) used —
   `UserDefaults` is the one Capacitor apps hit.
3. Check every third-party SDK ships its own signed privacy manifest. Capacitor
   and its plugins are the ones to verify; SDKs on Apple's commonly-used list
   must have one, and a missing manifest is an upload-time rejection, not a
   review note.
4. Account deletion is already in place and satisfies guideline 5.1.1(v) — see
   DEPLOY.md.
