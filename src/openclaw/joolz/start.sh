#!/bin/sh
# Container entrypoint. Root: make /data belong to `node` and drop to it. Node: write the Tailscale access settings, load the gateway token, start OpenClaw.
set -eu
STATE="${OPENCLAW_STATE_DIR:-/data/state}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$STATE"
  [ "$(stat -c %U "$STATE")" = node ] || chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node "$0" "$@"
fi
node /app/joolz/preset.mjs
TOKEN_FILE="$STATE/joolz-gateway-token"
[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] || OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
export OPENCLAW_GATEWAY_TOKEN
exec tini -s -- node /app/docker-entrypoint.mjs "$@"
