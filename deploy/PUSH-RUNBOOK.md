# PUSH runbook — what the Forge "push" stage does, and never does

Written by the cycle-50 planner (2026-09-03). The push stage runs after implement → review → improve
in every cycle, with no human present. Its job: publish the tree the reviewer just reviewed to
**GitHub**, the **live site** (https://odoreeci.tech) and **installed APKs** (via the OTA channel).
Every command below is copy-paste. Do the gates in order and stop at the first one that fails.

Mission dir: `/opt/data/forge/missions/20260903-002914-ce0d/stages/`

## 0. Gates — decide first, act second

```bash
cd /opt/data/convoy
git status --porcelain | wc -l                 # G1: must print 0 (clean tree, on main)
git branch --show-current                      #     must print main
R=$(ls /opt/data/forge/missions/20260903-002914-ce0d/stages/*-review.md | tail -1); echo "$R"
grep -m1 -E "Verdict|verdict" "$R"             # G2: SHIP-QUALITY / ACCEPTABLE / BROKEN
grep -cE "^### BLOCKER|\*\*BLOCKER|BLOCKER —|BLOCKER-severity" "$R"   # G2b: count of BLOCKER findings
grep -cE "^### HIGH|\*\*HIGH\b|HIGH —" "$R"                           # G2c: count of HIGH findings
npm test 2>&1 | tail -3                        # G3: "All N suites passed." (N >= 23)
grep -oE '\?v=cy[0-9]+' index.html | sort | uniq -c   # G4: exactly ONE stamp value (45 occurrences)
```

| Gate result | GitHub push | Live deploy |
|---|---|---|
| G1 fails (dirty tree / not main) | no | no — report "held back: dirty tree" |
| G2 verdict BROKEN, or any BLOCKER finding | **no** | **no** — report the finding, next implement fixes it |
| G2 ACCEPTABLE with ≥1 HIGH finding | yes | **no** — report which HIGH held it |
| G2 SHIP-QUALITY, or ACCEPTABLE with no HIGH/BLOCKER | yes | yes |
| G3 test suite not all-green | no | no |
| G4 mixed stamps | no | no (pack-ota refuses mixed pages) |

Which lane, when deploying:
```bash
LOCAL=$(grep -oE '\?v=cy[0-9]+' index.html | head -1 | grep -oE '[0-9]+')
PROD=$(curl -s --max-time 15 https://odoreeci.tech/ | grep -oE 'v=cy[0-9]+' | head -1 | grep -oE '[0-9]+')
echo "local=$LOCAL prod=$PROD"
git fetch origin -q; git diff --stat origin/main HEAD -- server legal | tail -1   # server-side changes since last push
```
- `LOCAL > PROD` → **Lane A** (web changed; implement bumped the stamp) → `release -- --ota`.
- `LOCAL == PROD` and server/legal diff is non-empty → **Lane B** (site only) → `release -- --no-apk`.
- `LOCAL == PROD` and no diff → nothing to deploy; still push GitHub if ahead.
- `LOCAL == PROD` but `git diff origin/main HEAD -- index.html css js` is NON-empty → the implementer
  forgot the stamp bump. Do **not** deploy web changes unstamped (installed APKs would never get
  them). Report "held back: web files changed without a stamp bump" — next implement fixes it.

## 1. GitHub

```bash
PREV=$(git rev-parse origin/main)              # remember for rollback
git push origin main 2>&1 | tail -2
git fetch origin -q && [ "$(git rev-parse origin/main)" = "$(git rev-parse HEAD)" ] && echo GITHUB-OK
```
Auth is already wired (`gh auth status` → CronusAztec; `git push --dry-run` verified 2026-09-03).
No CI/CD exists on GitHub: a push deploys nothing.

## 2. Live site + installed APKs

```bash
deploy/live-deploy.sh diag 2>&1 | head -12                  # baseline: service active, recent log
# Lane A (web changed, stamp bumped): site tarball + restart + OTA bundle + manifest
deploy/live-deploy.sh release -- --ota 2>&1 | tail -40      # expect "✓ Released in Ns", 7 health ✓
# Lane B (server-only change):
deploy/live-deploy.sh release -- --no-apk 2>&1 | tail -30   # expect "✓ Released in Ns"
# Verify (ONE request each — shared IP with live riders, never loop):
curl -s --max-time 15 https://odoreeci.tech/api/health        # {"ok":true,"maintenance":false}
curl -s --max-time 15 https://odoreeci.tech/api/ota           # Lane A: "current":{"version":"1.0.NNN",...}
curl -s --max-time 15 https://odoreeci.tech/ | grep -oE 'v=cy[0-9]+' | head -1   # cyNNN == local
deploy/live-deploy.sh livetest 2>&1 | tail -8                 # two real WS clients: convoy + chat delivered both ways
# Production signal — ONE read-only SSH, right after the checks above. Any `[handler …]` line is a
# swallowed handler exception, i.e. a broken feature (cycle 55: chat had never worked, and only this
# line said so); any `Failed with result` is a failed (re)start. Quote every hit VERBATIM in the
# report as a finding for the next cycle — the deploy still counts as successful if the service is up.
deploy/live-deploy.sh diag 2>&1 | tee /tmp/diag-post.txt | grep -nE "\[handler |Failed with result|uncaughtException|crossed WS_MSG_BUDGET" | head
# Overpass mirror health, from the SAME read (cycle 56, server-034 — no second SSH call): a `served by X after Y …`
# warn means Y failed and X covered, and Y is now demoted for 2 min; quote any `all mirrors failed` line verbatim.
grep -n '\[overpass\]' /tmp/diag-post.txt | tail -5
```
What `--ota` does (release.js `pushOta`): packs `www/` → `ota-out/bundle-1.0.NNN.zip` + manifest,
uploads the site tarball and restarts the `convoy` systemd unit (~5 s, riders reconnect), then
uploads bundle + manifest to `/var/lib/convoy/ota` (zip before manifest — atomic by order).
Installed APKs (versionName 1.0.116) call `/api/ota` on app open; `server/ota.js decide()` offers
the bundle when its version is newer. That is how "the APK gets updated" from this box.
Supabase credentials are already on the VPS (`/var/lib/convoy/convoy.env`) — deploy.js detects
that and leaves them alone; no local `server/.env` is needed.

## 3. If the deploy goes wrong

- Health ✗ or site not serving the new stamp → roll the site back to the previous commit's files:
  ```bash
  git stash -u -q; git checkout "$PREV" -- index.html css js legal server
  deploy/live-deploy.sh update 2>&1 | tail -5
  git checkout HEAD -- index.html css js legal server; git stash pop -q; git status --porcelain | wc -l   # 0
  ```
- Bad OTA bundle in the wild and a previous bundle exists in `/api/ota` history →
  `deploy/live-deploy.sh release -- --rollback`. If there is no history (first publish), the OTA
  channel cannot be rolled back from here — write it up as a human-action item.
- Service down after restart → `deploy/live-deploy.sh diag` and paste the log tail into the report.

## 4. The APK binary — never built here

Verified 2026-09-03: no JDK, no Android SDK on this container or on the VPS, and no
`android/key.properties` / `*.keystore` anywhere reachable. An APK built without the release
keystore would not install over existing riders' installs (signature mismatch). So:
- The push stage never runs `gradlew`, never uploads a `.apk`, never edits `versionCode`.
- "APK updated" in the report means: OTA channel now serves 1.0.NNN, installed APKs pick it up.
- Human-only: run `node release.js` on the PC that holds the keystore when a **native** change
  (anything under `android/`) needs to ship.

## 5. The report (write it to the OUTPUT CONTRACT path)

1. What moved: `PREV..HEAD` commit range, file count, lane (A/B/none).
2. Verification: `git rev-parse origin/main HEAD` equal; `/api/health`; `/api/ota` version; stamp
   served; livetest result — paste the trimmed outputs.
3. What did NOT move and why (held-back gate, HIGH finding, no keystore).
4. Human-only items carried forward (see STATE.md "Human-only actions").
5. The production-signal read: every `[handler …]` / `Failed with result` line verbatim, or "none".
6. The `[overpass]` lines from that same read: any `all mirrors failed` verbatim; `served by … after …` lines counted (cycle 56).

## Never

- Never edit application code, tests, BUGS.md or STATE.md's milestone sections in this stage; never
  bump stamps (the implementer does that as its last code edit); never `--force` an OTA push.
- Never run `deploy/deploy.js` in full (non-`update`) mode, never `setup-https.js`, never
  `setup-tts.js`, never touch `/var/lib/convoy` by hand, never restart the service more than once
  per stage, never loop health checks.
- Never deploy when the review verdict is BROKEN or lists a BLOCKER — nothing is worse than
  shipping a known lockout to real riders (cycle 4's `setShellInert` bug would have done exactly that).
