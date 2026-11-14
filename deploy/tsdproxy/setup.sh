#!/bin/sh
# One-time setup for TSDProxy. Run on the Umbrel from this folder:  sudo ./setup.sh
# Asks for your Tailscale auth key (reusable, tagged tag:public), writes it into TSDProxy's config, and starts it.
set -e
cd "$(dirname "$0")"

if [ -z "$TS_AUTHKEY" ]; then
  printf 'Paste your Tailscale auth key (tskey-auth-...), then Enter: '
  stty -echo 2>/dev/null || true; read -r TS_AUTHKEY; stty echo 2>/dev/null || true; echo
fi
case "$TS_AUTHKEY" in tskey-*) ;; *) echo "That doesn't look like an auth key (it should start with tskey-)."; exit 1;; esac

docker compose up -d
echo "Waiting for TSDProxy to create its config..."
i=0; while [ ! -f config/tsdproxy.yaml ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
[ -f config/tsdproxy.yaml ] || { echo "config/tsdproxy.yaml was not created. Check: docker compose logs tsdproxy"; exit 1; }

sed -i "s|^\( *authKey:\).*|\1 \"$TS_AUTHKEY\"|" config/tsdproxy.yaml
sed -i "s|^\( *targetHostname:\).*|\1 host.docker.internal|" config/tsdproxy.yaml
chmod 600 config/tsdproxy.yaml

ok=1
grep -q "^ *authKey: \"tskey-" config/tsdproxy.yaml || ok=0
grep -q "^ *targetHostname: host.docker.internal" config/tsdproxy.yaml || ok=0
if [ $ok -eq 0 ]; then
  echo
  echo "I could not set one of the two values automatically. Open config/tsdproxy.yaml and make sure it contains:"
  echo "    docker: local: targetHostname: host.docker.internal"
  echo "    tailscale: providers: default: authKey: \"<your key>\""
  echo "Then run:  docker compose restart tsdproxy"
  exit 1
fi

docker compose restart tsdproxy
echo
echo "Done. Watch it come up with:  docker compose logs -f tsdproxy"
