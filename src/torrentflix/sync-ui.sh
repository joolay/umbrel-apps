#!/bin/sh
# Mirrors the Torrentflix UI from github.com/joolay/homebrew (app-flix/) into public/.
# Usage: src/torrentflix/sync-ui.sh /path/to/homebrew   (then bump the version in joolay-torrentflix/)
set -e
SRC="${1:?path to a checkout of joolay/homebrew}/app-flix"
DST="$(dirname "$0")/public"
mkdir -p "$DST"
for f in index.html css js; do rm -rf "$DST/$f"; cp -r "$SRC/$f" "$DST/$f"; done
rm -f "$DST/config.js"    # served dynamically by server.js (Stremio server URL + profile-sync backend)
# PWA / iOS head tags required by CLAUDE.md
python3 - "$DST/index.html" <<'PY'
import sys
p=sys.argv[1]; h=open(p).read()
h=h.replace('<meta name="viewport" content="width=1920, initial-scale=1">',
 '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#000000">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="icon-180.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<meta name="apple-mobile-web-app-title" content="Torrentflix">\n<link rel="icon" href="icon.svg" type="image/svg+xml">')
open(p,'w').write(h)
PY
echo "UI mirrored from $SRC"
