#!/usr/bin/env bash
# task-enter — start a lane task in a dedicated worktree off origin/main.
# NEVER squats the primary checkout. Deterministic on the bead id (lanes get
# renamed mid-session; beads don't).
#
# Base branch (where fresh worktrees fork from): --base <ref> | $FIREGRID_TASK_BASE
# | DEFAULT_BASE (origin/main).
#
# Usage:
#   bash scripts/task-enter.sh <bead-id> <slug> [--class codex|sidecar]
#   bash scripts/task-enter.sh <bead-id> <slug> --base <ref>   # fork base override
#   bash scripts/task-enter.sh <bead-id> <slug> --resume   # attach EXISTING
#       branch (e.g. resume PR #326 — preserves its commits; does NOT fork
#       off the base). Default refuses if the branch already exists, so a
#       resume can never silently orphan committed work.
#
# Fork base precedence: --base <ref>  >  $FIREGRID_TASK_BASE  >  DEFAULT_BASE.
#
set -eu
# #765 (unified-kernel cutover) is merged to main; main is canonical.
DEFAULT_BASE="origin/main"
BEAD="${1:?usage: task-enter.sh <bead-id> <slug> [--class codex|sidecar] [--base ref] [--resume]}"
SLUG="${2:?need a short slug}"
CLASS="codex"
RESUME=0
BASE="${FIREGRID_TASK_BASE:-$DEFAULT_BASE}"
shift 2 || true
while [ $# -gt 0 ]; do case "$1" in
  --class) CLASS="${2:?}"; shift 2 ;;
  --class=*) CLASS="${1#*=}"; shift ;;
  --base) BASE="${2:?}"; shift 2 ;;
  --base=*) BASE="${1#*=}"; shift ;;
  --resume) RESUME=1; shift ;;
  *) echo "task-enter: unknown arg $1" >&2; exit 1 ;;
esac; done
case "$CLASS" in codex|sidecar) ;; *) echo "task-enter: --class must be codex|sidecar" >&2; exit 1 ;; esac

RR="$(git rev-parse --show-toplevel)"
PARENT="$(dirname "$RR")"
WT="$PARENT/firegrid-worktrees/${BEAD}-${SLUG}"
BR="${CLASS}/${BEAD}-${SLUG}"

# Fetch the fork base (strip a leading "origin/" to get the remote branch).
BASE_REMOTE_REF="${BASE#origin/}"
git -C "$RR" fetch -q origin "$BASE_REMOTE_REF" 2>/dev/null || true
git -C "$RR" fetch -q origin "$BR" 2>/dev/null || true

# Does the branch already exist (local ref or on origin)?
branch_exists=0
git -C "$RR" show-ref --verify --quiet "refs/heads/$BR" && branch_exists=1
git -C "$RR" show-ref --verify --quiet "refs/remotes/origin/$BR" && branch_exists=1

CREATED=0
if [ -d "$WT" ]; then
  echo "task-enter: worktree already exists → $WT  (cd there and continue)"
elif [ "$RESUME" = 1 ]; then
  [ "$branch_exists" = 1 ] || { echo "task-enter: --resume but no existing branch '$BR' (local or origin). Drop --resume for a fresh start." >&2; exit 1; }
  if git -C "$RR" show-ref --verify --quiet "refs/heads/$BR"; then
    git -C "$RR" worktree add -q "$WT" "$BR"                       # attach existing local branch as-is
  else
    git -C "$RR" worktree add -q "$WT" -b "$BR" --track "origin/$BR"  # local tracking branch from remote tip
  fi
  CREATED=1
  echo "✓ worktree: $WT  (RESUMED branch $BR — existing commits preserved, not forked off main)"
elif [ "$branch_exists" = 1 ]; then
  echo "✋ task-enter: branch '$BR' already exists (local or origin)." >&2
  echo "   A fresh start off $BASE would ORPHAN its commits. To continue that" >&2
  echo "   work pass --resume; to truly start over, delete the branch first." >&2
  exit 1
else
  git -C "$RR" worktree add -q "$WT" -b "$BR" "$BASE"
  CREATED=1
  echo "✓ worktree: $WT  (branch $BR, fresh off $BASE)"
fi

# Install deps into the fresh worktree. The fast `pnpm preflight` delegates to
# the `tooling` workspace package, so a worktree without node_modules fails the
# moment a lane runs gates — with a cryptic pnpm ELIFECYCLE + buried
# "node_modules missing" WARN (cost a lane a diagnosis cycle). Install once here
# so the lane is gate-ready. Best-effort: a hiccup warns and continues — never
# blocks starting the task (the lane can always `pnpm install` by hand).
if [ "$CREATED" = 1 ] && command -v pnpm >/dev/null 2>&1; then
  echo "→ installing dependencies (pnpm install)…"
  if (cd "$WT" && pnpm install); then
    echo "✓ dependencies installed — pnpm preflight is ready"
  else
    echo "⚠ pnpm install failed in $WT — run it manually before pnpm preflight" >&2
  fi
fi

# Claim the bead through the canonical store inherited from the shell
# environment. See firegrid-worktree-lifecycle.TASK_ENTER.1.
br update "$BEAD" --status in_progress >/dev/null 2>&1 \
  && echo "✓ $BEAD → in_progress" || echo "⚠ could not br-update $BEAD (do it manually)"

# firegrid-worktree-lifecycle.TASK_ENTER.2
cat <<EOF

NEXT:
  cd "$WT"
  # deps were installed above; \`pnpm preflight\` is ready (re-run \`pnpm install\`
  # only if the step above warned it failed).
  # tag your lane so lane-sweep can see you (your cmux tab label):
  br update $BEAD --assignee <your-lane-label> --add-label pr-<n>
  # …work, commit here (NEVER in the primary)…
  bash scripts/task-exit.sh $BEAD          # when done
EOF
