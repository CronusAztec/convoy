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
# Run as your current user. DATA_DIR outside the repo so accounts/secrets never
# live in /opt/convoy (the data dir is created on first run if missing).
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
| `DATA_DIR` | `server/data` (in-repo) | Where accounts, the token secret, and `users.json` live. **Point this outside the app tree** (e.g. `/var/lib/convoy`) so a deploy/copy mistake can never leak user password hashes. |
| `TOKEN_TTL_DAYS` | `30` | Auth token lifetime before clients must re-auth |
| `TOMTOM_KEY` | _(empty)_ | TomTom Web key. Set it to enable **traffic-aware routing** (`/api/route`) and the **live traffic heatmap** (`/api/traffic/*`). Empty → the client falls back to keyless OSRM routing and hides the traffic layer. **Never put this in client JS** — it's a server secret. Free tier (~2,500 routes/day) at https://developer.tomtom.com. |
| `TTS_DIR` / `TTS_BIN` / `TTS_MODEL` | `../tts/...` | Self-hosted Piper neural TTS for spoken turn-by-turn nav. Absent → text nav cues only. Install via `node deploy/setup-tts.js`. |

> **`DATA_DIR` recommendation:** on the VPS, keep accounts **out of the repo** — e.g.
> `Environment=DATA_DIR=/var/lib/convoy` in the service file (create + chown the dir first).
> That way `scp`/`cp` of a new build can never overwrite or ship `users.json` or the
> `.secret` token-signing key.

## 7. Updating the app later

```powershell
scp -r "C:\Users\Cronu\OneDrive\Desktop\New folder\js" "C:\Users\Cronu\OneDrive\Desktop\New folder\css" "C:\Users\Cronu\OneDrive\Desktop\New folder\index.html" "C:\Users\Cronu\OneDrive\Desktop\New folder\server" user@YOUR_VPS_IP:/tmp/convoy-update/
```
```bash
sudo cp -r /tmp/convoy-update/* /opt/convoy/ && sudo chown -R convoy:convoy /opt/convoy
sudo systemctl restart convoy
```

## Heads-up (current limitations)

- **Accounts exist, guests are open** — register/login/recovery are server-side (scrypt
  hashing, stateless revocable tokens). Guests (no account) can still ride/route/convoy;
  for a private group, add basic auth in the Caddyfile (`basic_auth`) or keep the URL quiet.
  Anyone with the URL can join as a guest with any name.
- **Positions are live by design** — users in the same 30 km bubble see each other's
  reported location in realtime, and the global feed shows everyone delayed ~5 min.
  Share the URL accordingly.
- **Back up `DATA_DIR`** — it holds every account's password hash, the token-signing
  secret (`.secret`), and friends/social state. Lose it and no one can sign in (and old
  tokens stop validating). It's also the one directory that must never be committed or
  bundled into a deploy tarball — which is why it should live outside the app tree.
- Chat/invites/auth are rate-limited and inputs sanitized server-side, but this is a
  friends-scale server, not hardened SaaS.

## Windows VPS instead?

```powershell
cd C:\convoy\server; npm install; node server.js
```
Use Task Scheduler ("At startup", run `node C:\convoy\server\server.js`) or
[NSSM](https://nssm.cc) to keep it running, and Caddy for Windows for HTTPS.
