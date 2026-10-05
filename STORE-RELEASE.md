# Store release — Google Play and the App Store

What the repo already does for a store build, and the hand-offs only a human
with the developer accounts can make. Work the two lists top to bottom; the
legal operator blanks in [DEPLOY.md](DEPLOY.md#pre-launch-legal-checklist) come
first on both.

The app's product surface was cut down for this on 2026-10-04: live riders near
you and across the world, proximity voice, convoys with chat and walkie-talkie,
routes, profiles, friends, block/report and account deletion. Nothing in the
build warns about enforcement, pairs with a radar detector, plays scanner audio
or times a run — the features that draw a "promotes dangerous driving" or
"unlawful in the territory" rejection are **not in the binary**. They exist as
**feature packs** the server sends to an account that has redeemed a code; see
[Feature packs and the stores](#feature-packs-and-the-stores) below before
writing either review note.

---

## What is already in the repo

| Requirement | Where |
|---|---|
| Android target SDK 36 / compile SDK 36, App Bundle build | `android/variables.gradle`, `release.js` (`bundleRelease` + `assembleRelease`) |
| Foreground location service with a visible notification, **no** `ACCESS_BACKGROUND_LOCATION` | `android/app/src/main/AndroidManifest.xml`, `LocationService.java` |
| Microphone asked for in context (when voice is first opened), not at launch | `VoicePlugin.java`, `js/voice.js` |
| No Bluetooth, no ad SDK, no device identifier | `SDK-INVENTORY.md` §1, §7; `test/sdk-inventory.test.js` |
| iOS project (Capacitor 8, Swift Package Manager, iOS 15+) | `ios/App` — `npm run ios:sync` then `npm run ios:open` |
| iOS purpose strings (location, microphone, camera, photos), background modes `location` + `audio`, URL scheme, export-compliance flag | `ios/App/App/Info.plist` |
| iOS background location ("When In Use" + background mode, system indicator shown) | `ios/App/App/BackgroundLocationPlugin.swift` |
| iOS privacy manifest (no tracking; collected types; `UserDefaults` CA92.1) | `ios/App/App/PrivacyInfo.xcprivacy` |
| Universal Links entitlement + the server's `apple-app-site-association` file | `ios/App/App/App.entitlements`, `APPLE_APP_IDS` in `server/.env.example` |
| Sign in with Apple beside any third-party sign-in on iOS (guideline 4.8) | `js/ui.js` hides social buttons on iOS unless `apple` is enabled; set `OAUTH_PROVIDERS=google,apple` |
| In-app account deletion + a public deletion URL (Play policy, Apple 5.1.1(v)) | Settings → Legal & data; `/delete-account` |
| Block and report on every rider and chat line, blocked list in Settings (UGC policy) | `js/ui.js`, `/api/report`, `/admin/reports` |
| Consent gate: passenger, 16+, Terms + Privacy (version-stamped, re-shown on bump) | `js/state.js` `LEGAL_VERSION`, `js/ui.js` |
| Privacy policy, Terms, third-party notices served over HTTPS | `/privacy`, `/terms`, `/notices` |
| Data Safety and App Privacy answers derived from the SDK list | `SDK-INVENTORY.md` §8, §9 |
| Crash reporting with a real opt-out, no third-party SDK | `js/telemetry.js`, Settings → Crash reports |
| OTA web-bundle updates (Android only; permitted — interpreted WebView code from our own host) | `LiveUpdatePlugin.java`, `js/ota.js`, DEPLOY.md §8 |
| Feature packs: withdrawn features served only to code-holding accounts, never bundled; visible redeem screen; legality notices; kill switch per pack | `packs/README.md`, `server/packs/index.js`, `js/packs.js`, `test/packs.test.js`, Settings → Feature packs, `/admin/packs` |

---

## Google Play — the human list

1. **Signing.** `android/key.properties` + the release keystore on the build
   machine (never in git). Enrol in Play App Signing on the first upload and add
   Play's certificate fingerprint to `ANDROID_CERT_SHA256` on the server, or the
   mailed links keep opening in the browser for Play installs (DEPLOY.md §6).
2. **Build.** `node release.js --no-site` produces `convoy.aab` (Play) and
   `convoy.apk` (the sideload link). Bump `versionCode` in
   `android/app/build.gradle` for every upload; `versionName` tracks the web
   stamp automatically.
3. **Store listing.** Title, short/long description, screenshots (phone, and
   7"/10" tablet if you tick tablets), feature graphic, icon — the landing page
   copy at `landing/index.html` is the source of truth for the description. Do
   not describe features the build no longer has.
4. **App content declarations.**
   - Privacy policy URL: `https://odoreeci.tech/privacy`.
   - Data deletion URL: `https://odoreeci.tech/delete-account`.
   - **Data safety**: copy `SDK-INVENTORY.md` §8 row by row.
   - **Location permissions**: the app uses precise location in the foreground;
     it does **not** request background location. Say so — the foreground
     service is declared with type `location`, which is the lighter review.
   - **Foreground service** declaration: type `location`; purpose "keeps the
     rider's live position flowing to their convoy with the screen off"; upload
     a short screen recording showing the persistent notification and the pin
     moving.
   - **Content rating** questionnaire: user interaction (chat, voice), shares
     location with other users, no violence, no gambling → expect Teen; the
     Terms set 16+.
   - **Target audience**: 16+ (not designed for children).
   - **Ads**: none. **Government app**: no. **News app**: no. **COVID**: no.
   - **Health**: no. **Financial features**: none.
5. **Reviewer access.** Play's reviewers get the guest path (no credentials
   needed). Add a note that the app is for passengers and that the consent gate
   is deliberate. Paste the feature-pack paragraph from
   [Feature packs and the stores](#feature-packs-and-the-stores) and the
   reviewer code; Play's "app access" form wants the credentials and the code
   together.
6. **Pre-launch report.** Check the crawler run for crashes; the consent gate
   stops it early, which is expected.
7. **Release.** Internal testing → closed → production, with the staged-rollout
   knob in the control panel (DEPLOY.md §9 "Publishing to Google Play").

## App Store — the human list

1. **Apple Developer Program** membership; note the **Team ID**.
2. **Bundle ID** `tech.odoreeci.convoy` registered in Certificates, Identifiers
   & Profiles with capabilities **Associated Domains** and, if you enable
   Apple as a provider, **Sign in with Apple** (the web OAuth flow Supabase
   runs does not need the entitlement, but the identifier must allow it).
3. **Server env.** `APPLE_APP_IDS=<TEAMID>.tech.odoreeci.convoy` so
   `/.well-known/apple-app-site-association` is served (it must answer
   `application/json` over HTTPS with no redirect — the server does this).
   `OAUTH_PROVIDERS` must include `apple` if it includes anything else;
   configure the Apple provider in Supabase (Services ID, key, team) per the
   Supabase docs.
4. **Open the project.** On a Mac with Xcode 16+: `npm run ios:sync`, then
   `npm run ios:open`. Set the signing team on the App target; Xcode resolves
   the Swift packages on first open (network needed).
5. **Icons and launch screen.** `ios/App/App/Assets.xcassets/AppIcon` holds the
   Capacitor placeholder icon — replace it with the app's icon (1024×1024, no
   alpha). The launch storyboard is the template's; adjust the background
   colour to the app's `#0e1116` if you want a seamless launch.
6. **Versions.** `MARKETING_VERSION` (shown in the store) and
   `CURRENT_PROJECT_VERSION` (build number, must increase per upload) in the
   App target's build settings.
7. **Archive and upload.** Product → Archive → Distribute → App Store Connect.
   The export-compliance question is pre-answered by
   `ITSAppUsesNonExemptEncryption = false` (HTTPS only).
8. **App Store Connect.**
   - **App Privacy**: `SDK-INVENTORY.md` §9 (it must agree with the bundled
     `PrivacyInfo.xcprivacy`; App Store Connect checks the upload against it).
   - **Age rating**: Unrestricted Web Access no; user-generated content yes
     (chat, voice, profiles) with the block/report tools noted → expect 17+
     under Apple's "Frequent/Intense" UGC answer or 12+ depending on the
     questionnaire; the Terms require 16+, so pick the stricter.
   - **Privacy policy URL** and **support URL**.
   - **Sign-in**: provide a reviewer account **and** point out the guest path;
     explain Sign in with Apple is present when Google is.
   - **Background location** (the `location` background mode): the review note
     should say the app keeps the rider's own pin live for their convoy while
     they background it, with the system indicator visible, and never after the
     app is closed.
   - **Review notes**: passenger-only product, consent gate on purpose, voice
     is live and never recorded, location sharing is the feature and is
     disclosed at first launch; the binary carries no enforcement, scanner or
     racing feature — then the feature-pack paragraph and the reviewer code
     from [Feature packs and the stores](#feature-packs-and-the-stores).
9. **TestFlight** a build to a real phone first: microphone prompt on first
   push-to-talk, location prompt on first launch, a mailed link opening in the
   app (Universal Links need the AASA file live before the app is installed),
   and a Google/Apple sign-in round-trip through Safari and back.

## Feature packs and the stores

The withdrawn features came back on 2026-10-05 as **feature packs**
(`packs/README.md`): each lives under `packs/<id>/` on the server and is sent to
an account only after that account redeems a code. The compliance position, in
the words a reviewer needs:

- **Nothing dormant is in the binary.** `scripts/copy-web.js` names what the
  app bundles (`index.html`, `js`, `css`, `fonts`); `packs/` is not in it, and
  `test/packs.test.js` fails the build if it ever is. A code does not switch on
  code that ships — there is none to switch on. That is the line Apple's
  guideline 2.3.1 (hidden features) draws.
- **What the app downloads is interpreted JavaScript from our own origin**,
  run in the WebView: permitted by Apple 2.5.2 and by Play's policy on
  downloaded code, which prohibits native code only. Packs extend the map the
  rider already has; they do not change the app's purpose.
- **It is disclosed, not hidden.** Settings → Feature packs is on every build,
  signed in or not: it lists the packs, says they are served by our server to
  accounts with a code, and holds the redeem field. Terms §5 covers the packs
  and the legal restrictions on each; Privacy §5 covers the extra requests.
- **Regulated packs warn in plain words before they switch on** (enforcement
  markers, scanner audio, timed runs), default off, and the server can kill any
  pack for everyone instantly (`/admin/flags`, `pack:<id>`).

### The reviewer code

1. On the live server open `/admin/packs`, label it `App Review <date>`, tick
   every pack, **max uses 2** (Apple and Google each redeem once), **expires in
   60 days**, mint. Copy the code — it is shown once.
2. Paste into both stores' review notes, with the reviewer account:

   > Some features (enforcement awareness, police scanners, performance timers,
   > map overlays, the instrument panel) are not part of the app binary. They
   > are feature packs our server sends to an account that has redeemed a code;
   > the app itself only contains the loader (Settings → Feature packs, visible
   > to everyone). To review them: sign in with the reviewer account, open
   > Settings → Feature packs, enter `CONVOY-XXXX-XXXX-XXXX-XXXX` and tap
   > Redeem. Each regulated pack shows a legality notice before it switches on;
   > all of them are off by default. No Bluetooth, no radar-detector pairing.

3. After the review, revoke the code on `/admin/packs` (the reviewer account
   keeps its packs; revoke those on `/admin/account/<id>` if you prefer).

If a store nonetheless objects to a specific pack, kill that pack (`pack:<id>`
off) — the build, the loader and the redeem screen are unchanged and the app
stays as submitted.

## After the first release

- Bump `LEGAL_VERSION` in `js/state.js` whenever `legal/terms.html` or
  `legal/privacy.html` changes materially; every rider re-accepts.
- Android web-layer fixes can go out through the OTA channel (DEPLOY.md §8);
  iOS fixes always go through App Store Connect, so plan iOS builds around
  the same `?v=cyNNN` stamp bump as the site.
- Any new dependency: add a row to `SDK-INVENTORY.md`, re-check both forms, and
  (iOS) make sure it ships a privacy manifest.
