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
tar -czf "$env:TEMP\convoy.tgz" --exclude=node_modules --exclude=.git --exclude=.claude index.html css js server README.md DEPLOY.md
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
# DATA_DIR holds the hotspot cache and is created on first run if missing.
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
| `OAUTH_NATIVE_REDIRECT` | `tech.odoreeci.convoy://auth` | Where the **APK's** sign-in comes back to. The Capacitor WebView's `https://localhost` origin is not a valid redirect target, so the app claims a scheme in its manifest instead. Changing it means changing `AndroidManifest.xml` and `AuthPlugin.java` too. A running server reports the value in use at `GET /api/auth/config`. |
| `ANDROID_CERT_SHA256` | _(release keystore)_ | Comma list of APK signing-certificate SHA-256 fingerprints published at `/.well-known/assetlinks.json`. This is what lets the app claim the `/l/…` links Convoy emails. **Public values, not secrets.** Set to empty to stop publishing the file (App Links off; mailed links open in the browser). **With Play App Signing you must add Play's fingerprint** — see below. |
| `ANDROID_PACKAGE` | `tech.odoreeci.convoy` | Package name in the same file. Only change it alongside `applicationId` in `android/app/build.gradle`. |
| `DATA_DIR` | `server/data` (in-repo) | Runtime cache only (`hotspots.json`) now that accounts live in Supabase. Still worth pointing outside the app tree (e.g. `/var/lib/convoy`) so a deploy can't clobber it. |
| `TOMTOM_KEY` | _(empty)_ | TomTom Web key. Set it to enable **traffic-aware routing** (`/api/route`) and the **live traffic heatmap** (`/api/traffic/*`). Empty → the client falls back to keyless OSRM routing and hides the traffic layer. **Never put this in client JS** — it's a server secret. Free tier (~2,500 routes/day) at https://developer.tomtom.com. |
| `OVERPASS_URLS` | _(2 mirrors)_ | Comma list of Overpass endpoints, tried in order. The client cannot call Overpass directly — it serves no `Access-Control-Allow-Origin` header — so the server proxies and caches it at `/api/overpass`. No key needed. |
| `OVERPASS_TTL_MS` | `1800000` | How long a cached Overpass answer serves everyone in that area (30 min). These are static POIs. |
| `OVERPASS_MAX_SPAN_DEG` | `4` | Largest bounding box the proxy will run. **Must not be below what the clients clamp to** (`js/ghost.js` uses 4°), or their normal wide view is refused and the layer silently goes dark. |
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

## 7. Updating the app later

```powershell
scp -r "C:\Users\Cronu\OneDrive\Desktop\New folder\js" "C:\Users\Cronu\OneDrive\Desktop\New folder\css" "C:\Users\Cronu\OneDrive\Desktop\New folder\index.html" "C:\Users\Cronu\OneDrive\Desktop\New folder\server" user@YOUR_VPS_IP:/tmp/convoy-update/
```
```bash
sudo cp -r /tmp/convoy-update/* /opt/convoy/ && sudo chown -R convoy:convoy /opt/convoy
sudo systemctl restart convoy
```

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
- [ ] **Data safety form** filled to match the Privacy Policy: precise location,
      background location, email, user IDs, in-app messages, audio (transmitted
      not recorded). Declare "data is not sold" and "data is not shared with
      third parties for advertising".
- [ ] Bump `LEGAL_VERSION` in `js/state.js` whenever you change either document
      materially. That single constant re-opens the consent gate for every rider
      and invalidates the feature legality acknowledgements. Keep it in step with
      the version printed at the top of `legal/terms.html`.
- [ ] Review the **third-party usage policies** in
      [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) against your expected
      traffic. Nominatim, the OSRM demo server and the public Overpass instances
      are development infrastructure — running a launched app against them
      breaches their terms. OpenSky and airplanes.live are non-commercial only.
      Self-host or buy capacity first.
- [ ] Confirm the age rating you declare matches the Terms: **16+**, with live
      location, open chat, voice and user-generated reports.
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
  personal best now lives in the Supabase project. Enable Point-in-Time Recovery (or
  take regular `pg_dump`s) there. `DATA_DIR` is just a hotspot cache and is disposable.
- Chat/invites/auth are rate-limited and inputs sanitized server-side, but this is a
  friends-scale server, not hardened SaaS.

## Windows VPS instead?

```powershell
cd C:\convoy\server; npm install; node server.js
```
Use Task Scheduler ("At startup", run `node C:\convoy\server\server.js`) or
[NSSM](https://nssm.cc) to keep it running, and Caddy for Windows for HTTPS.
