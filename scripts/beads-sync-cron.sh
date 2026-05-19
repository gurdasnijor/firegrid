#!/usr/bin/env bash
# beads-sync-cron.sh — the canonical beads-sync OWNER (separation of duties:
# not the coordinator, not a lane — the machine, on a schedule).
#
# Persists .beads/issues.jsonl → origin/main. Unlike state-watch-cron this
# does NOT depend on cmux (it's br+git only), so it runs even when cmux is
# down — durability of the decision record must not hinge on the UI being
# up. beads-sync.sh self-locks (self-healing .git lock) and exits clean
# when nothing changed, so frequent ticks are near-zero-cost / low-noise.
#
# Sets FG_BEADS_OWNER=1 + FG_BEADS_CRON=1 so beads-sync.sh's owner gate
# (.beads/.beads-owner = cron) admits ONLY this path. Install via
# scripts/install-beads-sync-cron.sh (operator-run).
set -u
export HOME="${HOME:-/Users/gnijor}"
export PATH="/Applications/cmux.app/Contents/Resources/bin:/opt/homebrew/bin:/Users/gnijor/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FG_BEADS_OWNER=1 FG_BEADS_CRON=1
REPO="${FG_REPO:-/Users/gnijor/gurdasnijor/firegrid}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch"
LOG="$STATE_DIR/beads-sync-cron.log"
mkdir -p "$STATE_DIR"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

cd "$REPO" 2>/dev/null || { say "FATAL: repo $REPO not found"; exit 1; }

# Only run from the primary on main (beads-sync.sh enforces this too; check
# here to log a clean skip rather than spam an error every tick).
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ] \
   || [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "main" ]; then
  say "skip: not primary-on-main"; exit 0
fi

OUT="$(bash "$REPO/scripts/beads-sync.sh" "chore(beads): canonical cron sync $(date -u +%FT%TZ)" 2>&1)"; rc=$?
LAST="$(printf '%s' "$OUT" | tail -1)"
if [ "$rc" -eq 0 ]; then
  case "$LAST" in
    *"nothing to push"*) say "ok: nothing to push" ;;
    *"pushed AND verified"*) say "SYNCED: $LAST" ;;
    *) say "ok: $LAST" ;;
  esac
else
  say "FAIL rc=$rc: $LAST"
fi
exit 0
