# 🚀 Deploying Convoy to your VPS

One Node process serves everything: the app, the WebSocket realtime layer, bots, convoys,
chat, and the delayed global feed. No database, one dependency (`ws`).

> ### ✅ Live over HTTPS → https://odoreeci.tech/
> Deployed on `2.25.184.90` (Ubuntu 24.04). **Caddy** reverse-proxies `https://odoreeci.tech`
> (auto Let's Encrypt cert, auto-renew) to the Convoy service, which runs as a systemd unit
> (`convoy`) on internal port **5173** as the unprivileged `convoy` user. `www`→apex and
> `http`→`https` redirect automatically; only 80/443 are open externally. Verified end-to-end
> (https 200, wss welcome, two-client convoy/chat).
>
> - **Update the app:** `node deploy.js update` (passwordless via `deploy/convoy_deploy_key`)
> - **Enable HTTPS on a new domain/box:** `DOMAIN=… node setup-https.js` (see [HTTPS](#5-https-strongly-recommended))
> - **Diagnose:** `node deploy/diag.js` · **Prove realtime:** `WSURL=wss://odoreeci.tech/ws node deploy/livetest.js`
>
> The manual steps below are the equivalent by hand / for a fresh box.

## Automated deploy (what was actually used)

From the `deploy/` folder on your PC:

```powershell
cd deploy
npm install
# first time (installs Node, service, firewall) — uses your password once:
$env:VPS_HOST='2.25.184.90'; $env:VPS_USER='root'; $env:VPS_PASS='<password>'
$env:VPS_PUBKEY="$PWD\convoy_deploy_key.pub"; $env:TARBALL="$env:TEMP\convoy.tgz"
# (build the bundle first — see note) then:
node deploy.js
```

After the first run a dedicated SSH key (`deploy/convoy_deploy_key`) is installed on the
box, so **every later update is passwordless** — rotate your VPS password freely:

```powershell
$env:VPS_HOST='2.25.184.90'; $env:VPS_USER='root'
$env:VPS_KEY="$PWD\convoy_deploy_key"; $env:TARBALL="$env:TEMP\convoy.tgz"
node deploy.js update     # push files + restart, ~5 seconds
```

Build the bundle (run in the project root before deploying) with:
```powershell
tar -czf "$env:TEMP\convoy.tgz" --exclude=node_modules --exclude=.git --exclude=.claude index.html css js legal server fonts landing README.md DEPLOY.md LICENSE THIRD-PARTY-NOTICES.md
```

Helpers: `node deploy/diag.js` prints service status + logs; `node deploy/livetest.js`
runs two real clients against the public server to prove realtime works.

> ⚠️ **Gotcha this box hit:** it shipped Node only at `/usr/local/bin/node` →
> `/root/.hermes/...`, which an unprivileged user can't reach (that caused a
> `203/EXEC` crash-loop). The deployer now guarantees a world-accessible
> `/usr/bin/node` (NodeSource apt) and auto-falls back to running as root if a usable
> node still isn't reachable. Keep this in mind if you ever switch boxes.

---

## Manual steps (fresh box, by hand)

This section assumes a typical **Ubuntu 22.04/24.04** VPS. (Debian is identical;
for a Windows VPS see the note at the bottom.)

---

## 1. Install Node.js 22 on the VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v22.x
```

## 2. Copy the app to the VPS

From this folder on your PC (PowerShell — replace `user` and `YOUR_VPS_IP`):

```powershell
scp -r "C:\Users\Cronu\OneDrive\Desktop\New folder" user@YOUR_VPS_IP:/tmp/convoy
```

Then on the VPS:

```bash
sudo mv /tmp/convoy /opt/convoy
cd /opt/convoy/server
npm install --omit=dev
```

> Don't copy `server/node_modules` from Windows — run `npm install` on the VPS instead.

## 3. Smoke test

```bash
# Needs the Supabase config (see §6) — the server exits at boot without it.
# DATA_DIR holds runtime state (flags, OTA manifests, telemetry rollup) and is created on first run if missing.
PORT=5173 DATA_DIR=/var/lib/convoy node /opt/convoy/server/server.js
# → Convoy server → http://localhost:5173 (ws: /ws, bots: 12, nearby: 30km)
```

Open `http://YOUR_VPS_IP:5173` in a browser (open the port first if needed:
`sudo ufw allow 5173/tcp`). You should see the map and the chip reading
**"LIVE · 12 riders online"**. Ctrl-C to stop, then set it up as a service:

## 4. Run it as a service (auto-start, auto-restart)

```bash
sudo useradd -r -s /usr/sbin/nologin convoy
# Persistent account/token data OUTSIDE the app tree — survives deploys, never
# gets scp'd or tar'd into a bundle, owned by the service user.
sudo mkdir -p /var/lib/convoy && sudo chown convoy:convoy /var/lib/convoy
sudo chown -R convoy:convoy /opt/convoy
sudo cp /opt/convoy/deploy/convoy.service /etc/systemd/system/
# The shipped unit already sets DATA_DIR=/var/lib/convoy. Edit the [Service]
# Environment= lines only if you want to add optional keys, e.g.:
#   Environment=TOMTOM_KEY=your_key_here
sudo systemctl daemon-reload
sudo systemctl enable --now convoy
systemctl status convoy        # should be active (running)
journalctl -u convoy -f        # live logs (joins, parties)
```

## 5. HTTPS (strongly recommended)

Real GPS in the browser **requires HTTPS** — without it everyone spawns at the demo
location. Easiest path is [Caddy](https://caddyserver.com), which gets and renews
Let's Encrypt certificates automatically. You need a domain (or free subdomain, e.g.
DuckDNS) with an A record pointing at your VPS IP.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

echo 'convoy.yourdomain.com {
    reverse_proxy localhost:5173
}' | sudo tee /etc/caddy/Caddyfile

sudo systemctl restart caddy
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

Done — `https://convoy.yourdomain.com` now serves the app with working GPS and `wss://`
websockets (the client picks ws/wss automatically). You can close port 5173 to the
outside (`sudo ufw deny 5173/tcp`) since Caddy proxies internally.

**No domain?** The app still works over `http://YOUR_VPS_IP:5173` — riders, convoys and
chat are all fine; only browser geolocation is blocked, so users ride from the demo spawn
or tap the map to move.

## 6. Configuration

Set in `/etc/systemd/system/convoy.service` (then `sudo systemctl daemon-reload && sudo systemctl restart convoy`):

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `5173` | HTTP + WebSocket port |
| `BOTS` | `12` | Server bots that keep the map alive (0 disables) |
| `NEARBY_KM` | `30` | Radius within which riders see each other |
| `NEAR_FAST` | `6` | Nearest riders refreshed at the fast-lane cadence |
| `GLOBAL_DELAY_MS` | `300000` | Delay of the global feed (5 min) |
| `MAX_CLIENTS` | `200` | Total connection cap |
| `MAX_PER_IP` | `10` | Per-IP socket ceiling (one source can't exhaust `MAX_CLIENTS`) |
| `SUPABASE_URL` | _(required)_ | Supabase project URL. Accounts and identity live here. |
| `SUPABASE_SECRET_KEY` | _(required)_ | Supabase secret key (`sb_secret_…`) or a legacy `service_role` JWT. **Full admin over Auth and the database — server-side only, never in client JS or the APK.** |
| `SUPABASE_DB_URL` | _(required)_ | Postgres connection string (embeds the DB password). Session pooler or direct. |
| `SUPABASE_JWT_SECRET` | _(empty)_ | Only for legacy projects that still sign JWTs with HS256. Projects on asymmetric keys need nothing here. |
| `SUPABASE_DB_CA` | _(empty)_ | The Supabase CA cert, as a **path or inline PEM**. Set it to verify the database TLS chain; without it the connection is encrypted but its certificate is **not verified**, and the server warns at every boot. |
| `SUPABASE_DB_STRICT_TLS` | _(empty)_ | Set to `1` in production once `SUPABASE_DB_CA` is in place. Turns "no CA configured" from a warning into a refusal to boot. |
| `SUPABASE_FORWARD_IP` | _(auto)_ | Set to `0` to stop sending `Sb-Forwarded-For` to Supabase Auth. On by default whenever `SUPABASE_SECRET_KEY` is a modern `sb_secret_…` key — see the note below. |
| `AUTH_EMAIL_DOMAIN` | `users.convoy.local` | Accounts registered **without** an email get a synthetic `<username>@<domain>` address to satisfy Supabase Auth. It never receives mail — don't point it at a real domain. |
| `RESEND_API_KEY` | _(empty)_ | Resend API key. **Empty is a supported configuration**: Convoy stays username + password + recovery code, and every mail-dependent route answers 503. Set it to unlock email sign-up, verification, reset-by-email, passwordless sign-in and email change. Server secret. |
| `MAIL_FROM` | `Convoy <no-reply@odoreeci.tech>` | Sender address. Must be on a domain **verified in Resend** (Domains → Add), or every send is rejected with a 403. |
| `MAIL_REPLY_TO` | _(empty)_ | Optional reply-to. Unset means replies bounce off the no-reply box. |
| `APP_URL` | `https://odoreeci.tech` | Origin every emailed link and OAuth redirect points back at. **Required** whenever `RESEND_API_KEY` or `OAUTH_PROVIDERS` is set. Deliberately not derived from the `Host` header — otherwise anyone who can set `Host` chooses where a password-reset link lands. No trailing slash. |
| `OAUTH_PROVIDERS` | `google` | Comma list of social sign-in providers: `google, apple, github, discord, facebook, azure, twitter, twitch, spotify, gitlab, linkedin_oidc`. **Set-but-empty means none.** Unknown names are dropped. Each still needs dashboard setup — see below. |
| `OAUTH_NATIVE_REDIRECT` | `tech.odoreeci.convoy://auth` | Where the **mobile apps'** sign-in comes back to. The Capacitor WebView's origin is not a valid redirect target, so the apps claim a scheme instead. Changing it means changing `AndroidManifest.xml` + `AuthPlugin.java` (Android) and `ios/App/App/Info.plist` + `js/native.js` (iOS) too. A running server reports the value in use at `GET /api/auth/config`. |
| `ANDROID_CERT_SHA256` | _(release keystore)_ | Comma list of APK signing-certificate SHA-256 fingerprints published at `/.well-known/assetlinks.json`. This is what lets the app claim the `/l/…` links Convoy emails. **Public values, not secrets.** Set to empty to stop publishing the file (App Links off; mailed links open in the browser). **With Play App Signing you must add Play's fingerprint** — see below. |
| `ANDROID_PACKAGE` | `tech.odoreeci.convoy` | Package name in the same file. Only change it alongside `applicationId` in `android/app/build.gradle`. |
| `APPLE_APP_IDS` | _(empty)_ | Comma list of `<TEAMID>.<bundle id>` published at `/.well-known/apple-app-site-association` so the iPhone app can claim the same `/l/…` links (Universal Links; the entitlement is in `ios/App/App/App.entitlements`). Empty → the file 404s and mailed links open in Safari, which still works. **Public values, not secrets.** |
| `DATA_DIR` | `server/data` (in-repo) | Runtime state only (flags, OTA manifests, telemetry rollup, audit log) now that accounts live in Supabase. Still worth pointing outside the app tree (e.g. `/var/lib/convoy`) so a deploy can't clobber it. |
| `TOMTOM_KEY` | _(empty)_ | TomTom Web key. Set it to enable **traffic-aware routing** (`/api/route`). Empty → the client falls back to keyless OSRM routing. **Never put this in client JS** — it's a server secret. Free tier (~2,500 routes/day) at https://developer.tomtom.com. |
| `TTS_DIR` / `TTS_BIN` / `TTS_MODEL` | `../tts/...` | Self-hosted Piper neural TTS for spoken turn-by-turn nav. Absent → text nav cues only. Install via `node deploy/setup-tts.js`. |

> **Two Supabase dashboard settings are part of this deployment**, and neither
> has a code equivalent:
>
> 1. **Authentication → Rate Limits → IP Address Forwarding: ON.** Supabase Auth
>    rate-limits `/token` *by IP address*, and every call it sees comes from this
>    server. Without forwarding, every rider shares one bucket (capacity 30) —
>    a few dozen sign-ins or hourly session refreshes and everyone gets 429s. The
>    server already sends `Sb-Forwarded-For`; this toggle is what makes GoTrue
>    honour it. Check the boot log: it says which mode it is in.
> 2. **Authentication → Providers → Email → "Prevent use of leaked passwords": ON**
>    (Pro plan and above). Rejects passwords found in known breaches. The server
>    reports GoTrue's `weak_password` as a 400 the rider can act on, so this is
>    safe to enable. The same page sets the minimum password length — keep it at
>    6 or raise `validPassword` in server.js to match, or registrations fail the
>    app's own check only after a round-trip.
>
> Convoy sends its own mail through Resend and does **not** use Supabase's SMTP,
> so nothing under **Authentication → Emails** needs configuring.
>
> **The three `SUPABASE_*` values are required — the server exits at boot without
> them**, rather than starting up and failing every sign-in. Keep them out of any
> tracked file: use a systemd `EnvironmentFile=/etc/convoy/convoy.env` (mode 0600,
> owned by the `convoy` user) instead of `Environment=` lines in `convoy.service`.
> `SUPABASE_SECRET_KEY` is admin over both Auth and the database, and
> `SUPABASE_DB_URL` embeds the database password.

### Email (Resend) — optional

Skip this whole section to keep the original behaviour: username + password,
with a one-shot recovery code as the only way back into a locked-out account.

1. **Verify a domain** in the Resend dashboard (Domains → Add), and add the DKIM
   and SPF records it gives you to your DNS. An unverified domain means every
   send comes back 403.
2. Create an API key and set `RESEND_API_KEY`, plus `MAIL_FROM` on that domain
   and `APP_URL` for the deployment's own origin.
3. Restart. `GET /api/auth/config` now reports `"email": true`, which is what
   makes the app draw the email fields at all.

Existing accounts are untouched — they keep `email: null` and their recovery
code, and can add an address later from Profile → Settings → Account.

**Setting `RESEND_API_KEY` changes two behaviours**, so it is not a purely
additive switch:

1. **Registration requires an email.** Without a mailer it stays optional, since
   an address that can never be confirmed would be a dead end.
2. **Unconfirmed accounts see an anonymised map** — other riders show as
   "Rider" with no name, handle, username, photo or stats. Cars, pins and
   movement are unaffected. Opening the confirmation link lifts it live, over the
   websocket, on whatever device has the map open. Not gated: guests, accounts
   with `email: null` (everyone from before email support), and — because nobody
   could confirm — every account when there is no mailer.

### Social sign-in (Google and friends) — optional

Per provider, three things have to line up, and a miss in any of them shows up
as a button that dead-ends:

1. **Supabase → Authentication → Providers → _provider_**: enable it and paste
   the client ID and secret from that provider's own console.
2. **In the provider's console**, the authorised redirect URI is *Supabase's*,
   not yours: `https://<project-ref>.supabase.co/auth/v1/callback`
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add
   **both** targets — `https://your-domain/**` for the website (the wildcard
   matters; the callback comes back with a query string) and
   `tech.odoreeci.convoy://auth*` for the APK. A provider that works on the web
   and fails in the app is almost always this line.

Then list the provider in `OAUTH_PROVIDERS` and restart. The flow is PKCE with
the verifier held server-side (`server/oauth.js`), so the app never handles a
Supabase key and an intercepted redirect is useless on its own.

**The boot log tells you whether steps 1–3 actually landed.** The server reads
the project's provider settings at startup, and a provider listed in
`OAUTH_PROVIDERS` but switched off in the dashboard is named, with the exact
callback URI to paste into the provider's console:

```
[boot] OAUTH_PROVIDERS lists google, but Supabase Auth does
[boot]   NOT have it enabled. Those buttons are hidden.
[boot]   Fix: Dashboard → Authentication → Providers → enable + add the client
[boot]   ID/secret, and set the redirect URI in the provider's own console to
[boot]   https://<project-ref>.supabase.co/auth/v1/callback
[boot] social sign-in: none available
```

Such a provider is **hidden rather than offered** — `/api/auth/config` leaves it
out and `/api/oauth/start` answers 503. Without that check the button would
navigate the browser to GoTrue and land the rider on a raw JSON error page
reading `{"code":400,"error_code":"validation_failed","msg":"Unsupported
provider: provider is not enabled"}`. Seeing that string means step 1 was
skipped. The settings are re-read every 10 minutes, so enabling a provider in
the dashboard takes effect without a restart.

Two things worth knowing:

- **Account linking** happens on Supabase's side, by matching a *confirmed*
  email. Signing in with Google using the same confirmed address as an existing
  Convoy account links the two rather than creating a second one. Convoy shows
  what is linked under Profile → Settings → Account → Sign-in methods, and can
  unlink; GoTrue itself refuses to remove the last method on an account.
- **The Android build** takes a different route through the same flow, and it
  needs no extra configuration beyond the redirect URL above. Two constraints
  force it: Google refuses OAuth inside an embedded WebView (`disallowed_useragent`),
  and the WebView's `https://localhost` origin is not somewhere a provider can
  redirect back to. So the APK opens the provider in a **Chrome Custom Tab** —
  the real browser, with the user's real session — and the round-trip returns as
  a deep link on `tech.odoreeci.convoy://auth`, which Android hands to
  `MainActivity` and `AuthPlugin` forwards into the same JS handler the web build
  uses. Steps 1, 3 and 4 of the flow are identical on both.

  The custom scheme is not treated as a secret: another installed app could in
  principle claim it, which is exactly why the verifier stays on the server. An
  intercepted redirect carries a code that cannot be redeemed without it.

  Rebuilding the APK after a change here needs `npm run android:sync` first —
  `www/` is generated, not tracked.

### Mailed links opening the app (Android App Links)

Password resets, email confirmations, sign-in links and email-change
confirmations are ordinary `https://your-domain/l/<kind>?token=…` links. On a
phone with the app installed, Android hands them to Convoy instead of a browser.
Everywhere else — desktop, or a phone without the app — the same URL opens the
site, which redirects into the in-page flow. Nothing breaks if this is not set
up; the links just always open in a browser.

**Why the `/l/` path**, rather than the root with a query: App Links match on
**path only** — query strings are ignored — so claiming `/?cv=reset&token=…`
would have meant claiming `/`, i.e. handing the app every link to the site, the
APK download page included. The prefix keeps the claim to exactly those links.

What has to be true:

1. **`https://your-domain/.well-known/assetlinks.json` must be reachable** over
   real HTTPS, no redirect. The server publishes it; the Caddy config above
   proxies everything, so it works as-is. Check it with
   `curl https://your-domain/.well-known/assetlinks.json`.
2. **The fingerprint in it must match the certificate the installed APK is
   signed with.** The default is the release keystore in `android/`. If you ship
   through Play with Play App Signing, Play re-signs your upload and installs
   carry *Play's* certificate — get it from Play Console → Setup → App
   integrity → App signing key certificate and put **both** in
   `ANDROID_CERT_SHA256`, comma separated. Symptom of getting this wrong: links
   work from a sideloaded APK and open the browser for every Play install.
3. Android verifies at install time. After changing the file, re-check on a
   device with:

   ```
   adb shell pm verify-app-links --re-verify tech.odoreeci.convoy
   adb shell pm get-app-links tech.odoreeci.convoy
   ```

   You want `verified` next to the domain. A user can also turn it on manually
   under Settings → Apps → Convoy → Open by default.

### Crash reporting and analytics

Shipping a beta without a crash reporter means the review section *is* the crash
reporter: you hear about launch-day crashes days late, from angry strangers, with
no stack traces. Convoy wires its own, and it is **on by default with nothing to
configure** — there is no account to create and no SDK bundle to load.

**What it does.** `js/telemetry.js` installs global `error` and
`unhandledrejection` handlers before any other module runs, and posts to
`POST /api/telemetry`. Alongside crashes it records a fixed core-loop funnel —
app opened, map loaded, GPS fix, went live, route set, trip started, trip
arrived, convoy — plus the screen each session ended on. The server keeps a
30-day rollup in `DATA_DIR/telemetry.json` and the raw stacks in
`DATA_DIR/telemetry-errors.jsonl` (append-only, rotated at 8MB). The server's own
`uncaughtException` / `unhandledRejection` handlers feed the same rollup.

**Reading it.** Set a token and query the dashboard:

```bash
# systemd: Environment=TELEMETRY_TOKEN=...   (openssl rand -hex 32)
curl -s -H "Authorization: Bearer $TELEMETRY_TOKEN" \
  https://odoreeci.tech/api/telemetry/stats?days=7 | jq
```

```jsonc
{
  "sessions": 412,
  "crashedSessions": 3,
  "crashFreePct": 99.27,      // the number to hold yourself to
  "meetsBar": true,           // crashFreePct >= 99
  "funnel": [ { "step": "map_ready", "sessions": 401, "pct": 97.3 }, ... ],
  "quitScreens": [ { "name": "profile", "count": 88 }, ... ],
  "topErrors": [ { "count": 14, "type": "TypeError", "msg": "...", "release": "cy108" } ]
}
```

`crashFreePct` is `null`, not 100, when no sessions have been recorded — an empty
window is unknown, not healthy. Without `TELEMETRY_TOKEN` the endpoint 404s;
leave it unset until you have somewhere to put the secret.

**Hold the line at 99%.** Check it every morning of the beta and after every
release. `byDay` and the `release` on each error group are what tell you a bad
build apart from a bad week — a release whose crash-free rate drops below 99 is a
release to roll back, not to explain away.

**Adding Sentry (optional).** For grouping, alerting and release tracking, put
the DSN in `js/config.js`:

```js
sentryDsn: 'https://<publicKey>@<host>/<projectId>',
```

Errors then go to Sentry *as well as* to `/api/telemetry`, posted as a plain
envelope request with no third-party script on the page — so `script-src` stays
as tight as it is. A DSN is a public, write-only credential; it is meant to ship
in client JS. Crash-free % is always computed from our own ingest, so Sentry can
be added or dropped later without losing the metric. **If you enable it, delete
the marked Sentry row from the processor table in `legal/privacy.html` only if
you are NOT using it** — the row is there because a processor that receives
diagnostics has to be named.

**Turning it off.** `TELEMETRY=0` on the server refuses every report. Riders have
their own per-device switch at Profile → Settings → Legal & data → Crash reports,
which stops all sending immediately and drops anything already queued.

**Privacy.** No location, no destination, no chat, no voice, no username, no
email — ever, in any field. Reports carry a random session id created at launch
and thrown away when the app closes, so nothing links two sessions to one person.
Messages, stack traces and URLs are scrubbed for tokens, emails and data URLs
before they leave the device. All of this is disclosed in §2.4 of the privacy
policy and retained for 30 days.

### Account deletion, and the half of it that can fail

Both stores reject an app that has sign-up but no in-app delete — Apple guideline
5.1.1(v), and Google's account-deletion policy, which additionally wants a public
web link that works *without* installing the app. Convoy has all three:

| Surface | Where |
|---|---|
| In-app | Profile → Settings → **Legal & data** → Delete account |
| Deep link | `/?cv=delete` — opens the app straight onto that screen; if you are signed out it signs you in first, then opens it |
| Public web | `/delete-account` (and `/account-deletion`), plain HTML, **no JavaScript**, no install |

The in-app flow asks three times over: it lists exactly what goes, it
re-authenticates (password, or for a social account the username typed out), and
it wants the word `DELETE`. All three are re-checked server-side — the screen is
the explanation, not the enforcement.

**The cascade.** `delete from public.profiles` cascades to `user_stats`,
`dragy_pbs`, `friendships`, `friend_requests`, `blocks`, `recovery_codes` and
`email_tokens`. `reports` is deliberately `ON DELETE SET NULL` with the usernames
denormalised beside it — otherwise deleting your account would erase every abuse
report ever filed against you, and the reports that matter most would be exactly
the ones that vanish. Then the GoTrue user goes, which revokes every session and
takes the email address, password hash and linked social identities with it.

**The half that can fail.** Those are two systems, and the second can fail alone.
When it does the profile and everything cascading from it is already gone, but
`auth.users` still holds the address — which is both an incomplete erasure and a
unique-index collision that tells the same person their email is "already taken"
by an account that no longer exists.

`server/authresidue.js` records every failed auth deletion to
`DATA_DIR/auth-residue.json` and retries it on a backoff (5s → 30s → 2m → 10m →
hourly), across restarts, until GoTrue confirms. A 404 counts as done. Only ids
this server actually tried to delete are ever retried — "delete every auth user
with no profile row" would be a one-liner and it would delete real people in the
middle of an OAuth sign-up, which has exactly that shape.

Watch it on the same dashboard as the crash numbers:

```bash
curl -s -H "Authorization: Bearer $TELEMETRY_TOKEN" \
  https://odoreeci.tech/api/telemetry/stats | jq .pendingAuthDeletions
```

Anything but `0` means someone has been told their account is gone while part of
it is not. It is being retried, but it is worth knowing why — check the log for
`[authresidue] AUTH USER NOT DELETED`, and confirm your `SUPABASE_SECRET_KEY` has
not expired.

## 7. Updating the app later

```powershell
scp -r "C:\Users\Cronu\OneDrive\Desktop\New folder\js" "C:\Users\Cronu\OneDrive\Desktop\New folder\css" "C:\Users\Cronu\OneDrive\Desktop\New folder\index.html" "C:\Users\Cronu\OneDrive\Desktop\New folder\server" user@YOUR_VPS_IP:/tmp/convoy-update/
```
```bash
sudo cp -r /tmp/convoy-update/* /opt/convoy/ && sudo chown -R convoy:convoy /opt/convoy
sudo systemctl restart convoy
```

## 8. OTA hotfix path (updates without the store)

The web app updates on reload — the server serves `index.html` `no-cache` and
every asset URL carries a `?v=` stamp. The APK was the frozen half: its web
layer was zipped in at build time, so any JS fix meant a new APK, a Play
upload, and days of review. The OTA channel closes that gap.

**What can ship OTA:** HTML, CSS, JS — the entire `www/` tree.  **What
cannot:** anything under `android/` (native code, plugins, permissions,
versionCode). Native changes still take the full `release.js` path above.

### How it works

- The APK carries a house Capacitor plugin (`LiveUpdatePlugin.java`) and a
  client half (`js/ota.js`, no-op on the web).
- Once per app open, the plugin POSTs `{platform, version_build, version_code,
  version_name}` — **no device identifier**, so the Data Safety answer
  "Device or other IDs: No" stays true — to `POST /api/ota`. The server alone
  decides whether an update is offered (`server/ota.js decide()`).
- An offered bundle is downloaded, sha256-checked against the manifest, and
  unzipped with a strict no-escape guard. It is **staged, not swapped**: the
  current ride keeps running, and the new bundle is served on the *next* app
  launch.
- **Rollback is automatic.** A staged bundle only becomes permanent after the
  app built from it calls `notifyReady()` at the end of a clean boot. If it
  crashes, white-screens, or never checks in within 15 s — including across
  process death — the plugin reverts to the previous bundle (or the APK's
  builtin assets) and blocks that version from ever staging again.
- Versions derive from the cache-buster stamp: `?v=cy109` → OTA `1.0.109` →
  Android `versionName "1.0.109"` (release.js syncs the latter from the stamp
  at every APK build). A fresh APK therefore never re-downloads assets it
  already contains.

### The commands

```bash
# Hotfix a JS/CSS/HTML bug — no APK, no store review, no service restart:
#   bumps ?v= in index.html first (see "shipping a fix" below), then:
node release.js --ota          # pack www/ → zip+sha256, deploy the site (web
                               # riders get the same fix on reload), upload the
                               # bundle + manifest to /var/lib/convoy/ota.
                               # Devices pick it up on their next app open.

# Emergency stop — a pushed bundle turned out bad:
node release.js --rollback     # repoint the channel at the previous bundle
                               # (force-flagged, so devices that already took
                               # the bad one are moved back DOWN). The bad
                               # bundle drops out of history and its zip stops
                               # being served.

# Local drill without touching the live channel:
node scripts/pack-ota.js --reuse-www --offline   # add --out DIR to pack elsewhere
```

The manifest (`/var/lib/convoy/ota/manifest.json`) is re-read on mtime change
per request, which is why an OTA push needs no `systemctl restart`. Inspect
the live channel any time: `curl https://odoreeci.tech/api/ota`.

### Shipping a fix through it

1. Fix the bug, then bump the stamp in `index.html`: every `?v=cyNNN` becomes
   `?v=cyNNN+1` (all of them — `pack-ota` refuses a mixed page). This is the
   same bump the web client already needs to bust caches, and it is now also
   the OTA version.
2. `node release.js --ota`. It refuses to push a version that is not newer
   than the channel's current one unless you pass `--force`.
3. Watch uptake in the telemetry dashboard — the release stamp
   (`convoy@cyNNN`) on every batch is the OTA uptake number.

### Before launch: prove the channel once, on purpose

The drill takes ten minutes and is the difference between "we have an update
channel" and "we have an update channel that works". Run it once, before you
need it:

1. Build and install the plugin-carrying APK (`node release.js`, versionCode 4+).
2. Bump the stamp (`cy108` → `cy109`) plus one visible marker (e.g. a settings
   row that says the build number). Push: `node release.js --ota`.
3. Reopen the app on the device: you should see the marker, and
   `App.ota.info()` in remote debugging (`chrome://inspect`) reports
   `active: "1.0.109"`, `builtin: false`.
4. **Prove the rollback**: stage a poison bundle (add `throw new Error('x')`
   as the first line of `js/app.js`, bump to `cy110`, push with `--force`
   after a normal `--ota` complains it isn't newer). Reopen: within ~15 s the
   app recovers to the previous good bundle by itself, and the device
   telemetry reports `ota_reverted`.
5. `node release.js --rollback` and confirm the channel is back at the good
   version; push the clean `cy110` (remove the throw) to end green.

If a revert storm ever correlates with a CDN outage (the map library loads
from jsDelivr, and a bundle whose map never initialises fails its handshake
by design), push the next stamp with `--force` once the CDN is back — the
affected devices have blocked the stamp they blamed, and a new stamp is the
clean slate.

**Play policy note:** downloading interpreted code into a WebView is
explicitly permitted (the prohibition targets native/executable code). The
channel only ever ships the same HTML/CSS/JS the APK already contains — never
native code, never a new permission.

## 9. The control panel (`/admin`)

Everything an operator can do to a running Convoy without SSH: change any
parameter of any account, work the moderation queue, flip every kill switch,
move the OTA channel, and publish to Google Play.

It is server-rendered with **zero client-side JavaScript** — every page is a
plain HTML form that POSTs and redirects. Nothing in it ships in the web bundle
or the APK.

### Turning it on

Secrets go in **`/var/lib/convoy/convoy.env`** — the file the unit already loads
via `EnvironmentFile=-/var/lib/convoy/convoy.env`. Never in the unit itself:
`/etc/systemd/system/convoy.service` is mode 0644, so an `Environment=SOMEKEY=…`
line there is readable by every user and every process on the box, and
`systemctl show convoy` prints it for anyone who asks.

```bash
ssh root@<vps> 'echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> /var/lib/convoy/convoy.env && chown root:convoy /var/lib/convoy/convoy.env && chmod 640 /var/lib/convoy/convoy.env && systemctl restart convoy'
```

`chmod 640` with group `convoy` is the point: root writes it, the service reads
it, nobody else can. Read the value back with
`grep ^ADMIN_TOKEN= /var/lib/convoy/convoy.env`.

That is the whole requirement. **Unset means the entire `/admin` tree 404s and
does not exist** — the correct default for a public server.

Optionally, `ADMIN_UIDS=<uuid>,<uuid>` lets named rider accounts sign in with
their own password instead of the shared secret, so the audit log records a
person rather than "admin". Deputy sign-in deliberately bypasses the `login`
kill switch — the panel is how you get back in while sign-in is frozen.

Sessions are stateless HMAC-signed cookies scoped to `/admin` (HttpOnly,
SameSite=Strict, 8h, Secure on https). Rotating `ADMIN_TOKEN` invalidates every
outstanding session — that is the only revocation a stateless cookie has.

### The live map (`/admin/map`)

Everyone connected, plotted on a basemap, colour-coded by what they are doing,
plus a roster of who is registered but *not* connected.

| Colour | State |
| --- | --- |
| green | cruising |
| blue | parked |
| amber | connected, no GPS fix yet |
| grey | stale — no position update in 60s |
| violet dashed ring | **ghost mode** |
| hollow dot | simulated rider (`BOTS=N`) |

Ghost is drawn as a *ring around* the status dot, not as its own colour, because
a ghosted rider is still cruising or parked and you need both facts at once.

The map is a **server-rendered SVG** — no MapLibre, no JavaScript at all. The
panel's CSP forbids inline script, and the page with the most sensitive data on
it is the last place to make an exception. Web Mercator is thirty lines of
arithmetic and a raster tile is an `<image>`. It live-updates with
`<meta http-equiv="refresh">` (5s / 15s / 60s / off), which needs no socket and
no client code.

Basemap tiles come from CARTO — the same vendor the app's own map already uses,
so no new third party and no new privacy disclosure. **Tiles are fetched by
coordinate: no rider position is ever sent to the tile host.** Positions are
drawn by the server, over the tiles, from data that never leaves the process.
CARTO/OSM attribution is rendered under the map because their licences require
it.

Pan and zoom are plain links that rewrite the query string (`?z=&lat=&lng=`) —
the no-script equivalent of a gesture. "Fit everyone" re-frames on the whole
fleet; "centre" next to any rider's coordinates jumps to them at street zoom.

**On ghosted riders:** the map shows them. Ghost mode hides a rider from other
*riders* — it was never a promise that the operator of the service cannot see
them, and a report about a ghosted rider would be unactionable otherwise. The
page says this out loud rather than burying it. These are precise live positions
of real people; open the page when you have a reason to.

### The three kill switches are different tools

Reaching for the wrong one during an incident costs hours:

| Switch | Where | What it actually stops |
| --- | --- | --- |
| `app` | Flags → Master switch | **This server.** Every `/api/*` answers 503, new WebSockets are refused. Instant, total, reversible. |
| `ota` | Flags → ota | Handing out web-layer hotfixes. |
| Halt rollout | Play → Halt | Google handing the APK to anyone **new**. Does nothing to existing installs. |

Nothing stops an app that is already installed and running except the flags and
the OTA channel. Plan around that.

### Killing the app

Flags → Master switch → type `KILL`. One atomic write forces `app` and every
feature flag off; riders' next call gets a 503 with `Retry-After: 120`.

Two things stay up **on purpose**:

- **`/api/health`** — answers `{ok:true, maintenance:true}` so a monitor can
  tell "off deliberately" from "the box is dead".
- **`/api/ota`** — the OTA channel is the recovery path. Cutting it during a
  kill would switch off the one way to ship the fix that ends the outage.

`/admin` is never gated. Locking the operator out of the switch they just
flipped is not an option.

**Restore:** Flags → Restore service. This *clears* every override rather than
forcing everything on — a feature that is off because its API key is missing
stays off, since forcing it on just produces a rider-visible feature that 500s.

**If the panel itself is unreachable while the app is killed**, the state is one
file:

```bash
rm /var/lib/convoy/flags.json && systemctl restart convoy
```

Deleting the file clears every override at once. No restart is needed for a
panel-driven change (the file is re-read on mtime change), only for this manual
path if you want to be certain.

### Publishing to Google Play

The store-side checklist for both stores — signing, the Data Safety and App
Privacy forms, Sign in with Apple, the Xcode archive — is
[STORE-RELEASE.md](STORE-RELEASE.md). This section is the panel's part of it.

The panel can ship a build, promote it between tracks, turn the staged-rollout
knob, and halt a rollout — without opening the Play Console.

Setup (the third step is the one people miss):

1. Google Cloud, in the project behind your Play account: create a **service
   account** and download its JSON key.
2. Grant it the **Android Publisher** role.
3. Play Console → Users and permissions → **invite that service account's email
   address**, with "Release apps to testing tracks" and "Release to production".

A key that is valid in Cloud but never invited to the Console fails with a flat
`unauthorized_client`. The panel says so when it happens.

```
PLAY_SERVICE_ACCOUNT_JSON=/etc/convoy/play-service-account.json
PLAY_PACKAGE=tech.odoreeci.convoy          # default
PLAY_ARTIFACT_DIR=/var/lib/convoy/releases # default: DATA_DIR/releases
```

**The panel does not accept file uploads through the browser.** Build with
`node release.js`, put the `.aab` in `PLAY_ARTIFACT_DIR` (it lands on this disk
exactly like the OTA bundle), and the panel's picker offers it newest-first.
The panel's job is deciding *which build goes live and to how many people*, not
being a file transfer.

Publishing (upload, promote) requires typing `SHIP`. Halting does not — halting
is the safe direction, and every second spent typing during a bad rollout is
another cohort taking the bad build.

Play assigns the version code from the artifact itself, so you never type one.
It refuses a code it has already seen: bump `versionCode` in
`android/app/build.gradle` and rebuild if that happens.

A rollout that has reached 100% (*live*) has nothing left to halt — Play's own
answer there is to roll forward with a fixed build, and the panel says so rather
than pretending a button exists.

### The audit log

Every panel action is appended to `DATA_DIR/admin-audit.jsonl` with actor, IP,
action, target and detail, capped at 2000 entries. The dashboard renders the
tail. Panics and rollout halts also print to the service log, so
`journalctl -u convoy` shows them next to whatever caused them.

## Pre-launch legal checklist

The app ships with a full legal set — Terms of Service + EULA, Privacy Policy, an
account-deletion page, and third-party notices — served from `legal/` at
`/terms`, `/privacy`, `/delete-account` and `/notices`. They are complete and
accurate about what Convoy actually does, **except for the operator details,
which only you can supply.** Every one of those is rendered in a red highlight on
the page so it cannot ship unnoticed.

**Fill these in before any public launch or store submission:**

| Placeholder | Where | Why it matters |
|---|---|---|
| `[LEGAL ENTITY NAME]` | terms, privacy, delete-account | A privacy policy naming no data controller is not a valid GDPR Art. 13 notice, and Play review rejects it |
| `[REGISTERED ADDRESS]` / `[POSTAL ADDRESS]` | terms, privacy | Required of a controller; also the Play Console developer address |
| `[JURISDICTION]` | terms §17 | Terms with no governing law are largely unenforceable |
| `[REGION]` | privacy §6 | Where your server and Supabase project actually live — needed for the transfer disclosure |
| `[APPOINT, OR STATE "not required"]` | privacy §1 | GDPR Art. 27 representative, if you serve the UK/EEA from outside it |

Then check off:

- [ ] Mailboxes live and monitored: `privacy@`, `abuse@`, `security@`, `legal@`
      at your domain. They are published in the documents; a bounce is a
      compliance failure.
- [ ] `/privacy` and `/delete-account` reachable over HTTPS, and pasted into
      **Play Console → App content → Privacy policy** and **Data deletion**.
      Play requires the deletion URL to work *without* installing the app — it
      does, but confirm it after your TLS is up.
- [ ] **Data safety form** filled from [SDK-INVENTORY.md](SDK-INVENTORY.md) §7,
      which lists every SDK in the app and the answer each one implies. Both
      stores make you declare what your SDKs collect, not just what reaches your
      servers, and Google scans the upload for undeclared device identifiers.
      `npm test` fails if a dependency or a remotely-loaded script appears that
      is not on that page — when it does, update the page **and** re-check the
      form. The answers, in short: precise location,
      background location, email, user IDs, in-app messages, audio (transmitted
      not recorded), **crashes and app diagnostics** (see §2.4). Declare "data is
      not sold" and "data is not shared with third parties for advertising".
      Diagnostics are collected and the form has categories for exactly this —
      *Crash logs* and *Diagnostics*, under **App info and performance** — with
      "optional" ticked, because riders can turn them off in Settings.
- [ ] **Sentry row in `legal/privacy.html` §4** — the processor table lists Sentry
      behind a red placeholder. **Delete that row if you have not set a
      `sentryDsn`**, and remove the placeholder if you have. A named processor
      you do not use is as wrong as an unnamed one you do.
- [ ] **Account deletion**: in-app path, `/delete-account` URL, and the deletion
      URL pasted into Play Console → App content → **Data deletion**. All three
      exist (see §6) — this is a check that the public URL resolves on your real
      domain, because Play tests it without the app installed. The same in-app
      path satisfies **Apple 5.1.1(v)** for the iOS build, which has been
      enforced since 2022 and is still a top rejection reason.
- [ ] Bump `LEGAL_VERSION` in `js/state.js` whenever you change either document
      materially. That single constant re-opens the consent gate for every rider
      and invalidates the feature legality acknowledgements. Keep it in step with
      the version printed at the top of `legal/terms.html`.
- [ ] Review the **third-party usage policies** in
      [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) against your expected
      traffic. Nominatim and the OSRM demo server are development
      infrastructure — running a launched app against them breaches their
      terms. Self-host or buy capacity first.
- [ ] Confirm the age rating you declare matches the Terms: **16+**, with live
      location, open chat and voice.
- [ ] **Apple App Privacy** filled from [SDK-INVENTORY.md](SDK-INVENTORY.md) §9,
      matching `ios/App/App/PrivacyInfo.xcprivacy`; `APPLE_APP_IDS` set so the
      mailed links open in the iPhone app; `OAUTH_PROVIDERS` includes `apple`
      whenever it includes any other social provider (guideline 4.8).
- [ ] If you have a lawyer, have them read `legal/terms.html` §§3–5 and §12.
      Those sections are what stand between you and a claim after a collision,
      and they are drafted to be read, not to be decorative.

> Nothing here is legal advice. These documents are a thorough, accurate starting
> point drafted against what the code actually does — they are not a substitute
> for a lawyer in your jurisdiction.

## Heads-up (current limitations)

- **Accounts exist, guests are open** — register/login/recovery run through Supabase
  Auth; the server proxies it so the secret key never ships to a client. Guests (no
  account) can still ride/route/convoy; for a private group, add basic auth in the
  Caddyfile (`basic_auth`) or keep the URL quiet. Anyone with the URL can join as a
  guest with any name.
- **A password change can lag by up to one token lifetime** — Supabase access tokens
  stay cryptographically valid until they expire (1h by default). Convoy revokes every
  session on a password change or recovery reset, which stops refresh tokens dead, but
  an access token already in flight keeps working until it ages out. Shorten the JWT
  expiry in the Supabase dashboard if that window matters.
- **Positions are live by design** — users in the same 30 km bubble see each other's
  reported location in realtime, and the global feed shows everyone delayed ~5 min.
  Share the URL accordingly.
- **Back up Supabase, not `DATA_DIR`** — every account, password, friendship and
  block now lives in the Supabase project. Enable Point-in-Time Recovery (or take
  regular `pg_dump`s) there. `DATA_DIR` holds the flag overrides, the telemetry
  rollup, the audit log and the OTA bundles (§8) — all reproducible or operational,
  none of it account data: losing it means re-pushing the last OTA bundle, nothing more.
- Chat/invites/auth are rate-limited and inputs sanitized server-side, but this is a
  friends-scale server, not hardened SaaS.

## Windows VPS instead?

```powershell
cd C:\convoy\server; npm install; node server.js
```
Use Task Scheduler ("At startup", run `node C:\convoy\server\server.js`) or
[NSSM](https://nssm.cc) to keep it running, and Caddy for Windows for HTTPS.
