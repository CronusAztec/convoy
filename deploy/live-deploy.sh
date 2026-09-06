#!/usr/bin/env bash
# Convoy — passwordless VPS access for THIS container, any session.
#
# The private key deploy/convoy_deploy_key is local to this container only
# (gitignored, generated once — see DEPLOY.md "Automated deploy"). It is
# already trusted by the VPS. This wrapper just points the existing deploy
# scripts at it so no session has to remember VPS_HOST/VPS_USER/VPS_KEY.
#
# Usage (from anywhere; cds itself):
#   deploy/live-deploy.sh diag [remote-cmd]     # read-only status + logs (safe, default)
#   deploy/live-deploy.sh livetest              # two real WS clients prove realtime works
#   deploy/live-deploy.sh update                # build the site tarball + deploy.js update
#                                                # (site files only, restarts convoy service)
#   deploy/live-deploy.sh release -- [args...]  # node release.js [args] (full pipeline incl. APK)
#
# Nothing here is destructive except `update`/`release`, which restart the live service —
# same as DEPLOY.md's documented flow, just without needing the VPS password.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
KEY="$HERE/convoy_deploy_key"

if [ ! -f "$KEY" ]; then
  echo "No deploy key at $KEY on this machine — this wrapper only works inside the container" \
       "that generated it. Use the normal VPS_PASS flow from DEPLOY.md instead." >&2
  exit 1
fi

export VPS_HOST="${VPS_HOST:-2.25.184.90}"
export VPS_USER="${VPS_USER:-root}"
export VPS_KEY="$KEY"

action="${1:-diag}"; shift || true

case "$action" in
  diag)
    node "$HERE/diag.js" "$@"
    ;;
  livetest)
    WSURL="${WSURL:-wss://odoreeci.tech/ws}" node "$HERE/livetest.js" "$@"
    ;;
  update)
    TARBALL="${TARBALL:-/tmp/convoy-site.tgz}"
    ( cd "$ROOT" && tar -czf "$TARBALL" --exclude=node_modules --exclude=.git --exclude=.claude \
        index.html css js legal server fonts landing README.md DEPLOY.md LICENSE THIRD-PARTY-NOTICES.md )
    export TARBALL
    node "$HERE/deploy.js" update
    ;;
  release)
    ( cd "$ROOT" && node release.js "$@" )
    ;;
  *)
    echo "unknown action '$action' (expected: diag | livetest | update | release)" >&2
    exit 1
    ;;
esac
