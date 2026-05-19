#!/usr/bin/env bash
# install-beads-sync-cron.sh — idempotently wire the canonical beads-sync
# OWNER cron. Operator-run (not the coordinator — that's the whole point).
# Re-running replaces the prior entry (never dupes).
#
# Usage:
#   bash scripts/install-beads-sync-cron.sh [--every <min>]
#   bash scripts/install-beads-sync-cron.sh --remove
#
# Default: every 5 min. beads-sync.sh exits clean when nothing changed, so
# a tick with no delta is a sub-second no-op (one log line, no commit).
set -eu
REPO="$(git rev-parse --show-toplevel)"
RUNNER="$REPO/scripts/beads-sync-cron.sh"
EVERY=5; REMOVE=0
while [ $# -gt 0 ]; do case "$1" in
  --every) EVERY="${2:?}"; shift 2 ;;
  --remove) REMOVE=1; shift ;;
  *) echo "unknown arg $1" >&2; exit 1 ;;
esac; done

TAG="# firegrid-beads-sync (managed by install-beads-sync-cron.sh)"
current="$(crontab -l 2>/dev/null | grep -v -F "$TAG" | grep -v 'beads-sync-cron.sh' || true)"

if [ "$REMOVE" = 1 ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
  echo "✓ removed firegrid-beads-sync cron entry"
  exit 0
fi

chmod +x "$RUNNER"
LINE="*/$EVERY * * * * FG_REPO=$REPO /bin/bash $RUNNER  $TAG"
{ printf '%s\n' "$current" | sed '/^$/d'; printf '%s\n' "$LINE"; } | crontab -
echo "✓ installed: canonical beads-sync owner = cron, every $EVERY min"
echo "  crontab now:"; crontab -l | sed 's/^/    /'
echo "  log:    ${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch/beads-sync-cron.log"
echo "  remove: bash scripts/install-beads-sync-cron.sh --remove"
echo "  NOTE: .beads/.beads-owner=cron now BLOCKS manual beads-sync"
echo "        (coordinator/lanes). Deliberate br-owner op: FG_BEADS_OWNER=1 (audited)."
