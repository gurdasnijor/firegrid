#!/usr/bin/env bash
# task-enter — start a lane task in a dedicated worktree off origin/main.
# NEVER squats the primary checkout. Deterministic on the bead id (lanes get
# renamed mid-session; beads don't).
#
# Usage:
#   bash scripts/task-enter.sh <bead-id> <slug> [--class codex|sidecar]
#   e.g. bash scripts/task-enter.sh tf-80d mcp-url-lifecycle --class codex
#
set -eu
BEAD="${1:?usage: task-enter.sh <bead-id> <slug> [--class codex|sidecar]}"
SLUG="${2:?need a short slug}"
CLASS="codex"
shift 2 || true
while [ $# -gt 0 ]; do case "$1" in
  --class) CLASS="${2:?}"; shift 2 ;;
  --class=*) CLASS="${1#*=}"; shift ;;
  *) echo "task-enter: unknown arg $1" >&2; exit 1 ;;
esac; done
case "$CLASS" in codex|sidecar) ;; *) echo "task-enter: --class must be codex|sidecar" >&2; exit 1 ;; esac

RR="$(git rev-parse --show-toplevel)"
PARENT="$(dirname "$RR")"
WT="$PARENT/firegrid-worktrees/${BEAD}-${SLUG}"
BR="${CLASS}/${BEAD}-${SLUG}"

git -C "$RR" fetch -q origin main
if [ -d "$WT" ]; then
  echo "task-enter: worktree already exists → $WT"
else
  git -C "$RR" worktree add -q "$WT" -b "$BR" origin/main
  echo "✓ worktree: $WT  (branch $BR, fresh off origin/main)"
fi

# Claim the bead (local beads.db mutation only; the durable push is the
# canonical beads-sync's job — never from a lane).
BEADS_DIR="$RR/.beads" br update "$BEAD" --status in_progress >/dev/null 2>&1 \
  && echo "✓ $BEAD → in_progress" || echo "⚠ could not br-update $BEAD (do it manually)"

cat <<EOF

NEXT:
  cd "$WT"
  # tag your lane so lane-sweep can see you (your cmux tab label):
  BEADS_DIR="$RR/.beads" br update $BEAD --assignee <your-lane-label> --add-label pr-<n>
  # …work, commit here (NEVER in the primary)…
  bash scripts/task-exit.sh $BEAD          # when done
EOF
