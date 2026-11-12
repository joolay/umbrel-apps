#!/bin/sh
# ShutterWorth auto-update: checks GitHub and rebuilds the app when there's a new version.
#
#   sudo ./auto-update.sh --install     run it every night at 03:15
#   sudo ./auto-update.sh --uninstall   stop the nightly run
#   sudo ./auto-update.sh               check and update right now
#
# Your data folder (inventory and photos) is never touched. Output goes to auto-update.log.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
DIR=$(cd "$(dirname "$0")" && pwd)
LOG="$DIR/auto-update.log"
MARK="# shutterworth-auto-update"
cd "$DIR" || exit 1

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo $0 $*"; exit 1; fi

case "${1:-}" in
  --install)
    chmod +x "$DIR/auto-update.sh"
    ( crontab -l 2>/dev/null | grep -v "$MARK"; echo "15 3 * * * $DIR/auto-update.sh $MARK" ) | crontab -
    echo "Installed: ShutterWorth will check for updates every night at 03:15."
    echo "Log: $LOG"
    exit 0 ;;
  --uninstall)
    crontab -l 2>/dev/null | grep -v "$MARK" | crontab -
    echo "Removed the nightly update."
    exit 0 ;;
esac

# Run git as the folder's owner (not root) so their saved GitHub login is used
# and later manual "git pull" commands keep working.
OWNER=$(stat -c %U "$DIR")
g() { if [ "$OWNER" = root ]; then git "$@"; else runuser -u "$OWNER" -- git "$@"; fi; }

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# keep the log short
[ -f "$LOG" ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exec 9>"$DIR/.auto-update.lock"
flock -n 9 || { log "Another update is already running."; exit 0; }

if ! g fetch -q origin 2>>"$LOG"; then log "Couldn't reach GitHub (check the saved login)."; exit 1; fi
BRANCH=$(g rev-parse --abbrev-ref HEAD)
LOCAL=$(g rev-parse HEAD); REMOTE=$(g rev-parse "origin/$BRANCH")
if [ "$LOCAL" = "$REMOTE" ]; then log "Up to date."; exit 0; fi

log "New version found: ${LOCAL%"${LOCAL#???????}"} -> ${REMOTE%"${REMOTE#???????}"}"
if ! g pull -q --ff-only origin "$BRANCH" >>"$LOG" 2>&1; then
  log "Update stopped: files in $DIR were edited on this server. Run 'git status' there to see them."
  exit 1
fi
if docker compose up -d --build >>"$LOG" 2>&1; then
  docker image prune -f >/dev/null 2>&1
  log "Updated and restarted."
else
  log "Rebuild failed; the previous version may still be running. See the lines above."
  exit 1
fi
