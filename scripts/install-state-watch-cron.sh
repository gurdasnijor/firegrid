#!/usr/bin/env bash
# install-state-watch-cron.sh — idempotently wire the external push runner
# into the user crontab. Re-running replaces the prior entry (never dupes).
#
# Usage:
#   bash scripts/install-state-watch-cron.sh [--every <min>] [--coord <label>]
#   bash scripts/install-state-watch-cron.sh --remove
#
# Defaults: every 3 min, notify the `coordinator` lane, workspace:2.
set -eu
REPO="$(git rev-parse --show-toplevel)"
RUNNER="$REPO/scripts/state-watch-cron.sh"
EVERY=3; COORD=coordinator; WS=workspace:2; REMOVE=0
while [ $# -gt 0 ]; do case "$1" in
  --every) EVERY="${2:?}"; shift 2 ;;
  --coord) COORD="${2:?}"; shift 2 ;;
  --workspace) WS="${2:?}"; shift 2 ;;
  --remove) REMOVE=1; shift ;;
  *) echo "unknown arg $1" >&2; exit 1 ;;
esac; done

TAG="# firegrid-state-watch (managed by install-state-watch-cron.sh)"
# strip any prior managed entry (idempotent)
current="$(crontab -l 2>/dev/null | grep -v -F "$TAG" | grep -v 'state-watch-cron.sh' || true)"

if [ "$REMOVE" = 1 ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
  echo "✓ removed firegrid-state-watch cron entry"
  exit 0
fi

chmod +x "$RUNNER"
LINE="*/$EVERY * * * * FG_REPO=$REPO FG_WS=$WS FG_COORD=$COORD /bin/bash $RUNNER  $TAG"
{ printf '%s\n' "$current" | sed '/^$/d'; printf '%s\n' "$LINE"; } | crontab -
echo "✓ installed: every $EVERY min → ping '$COORD' in $WS on any state delta"
echo "  crontab now:"; crontab -l | sed 's/^/    /'
echo
echo "  log:    ${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch/cron.log"
echo "  remove: bash scripts/install-state-watch-cron.sh --remove"
echo "  NOTE: with cron live, the coordinator must NOT also run"
echo "        state-watch.sh --once (two consumers race the snapshot)."
