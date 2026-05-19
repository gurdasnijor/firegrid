#!/usr/bin/env bash
# task-exit — finish a lane task: local beads flush, commit, push branch,
# open/refresh PR. Refuses to run in the primary checkout. Does NOT push
# .beads/issues.jsonl — that is the canonical beads-sync's job (one
# lock-serialized owner; lanes never race the export).
#
# Usage:
#   bash scripts/task-exit.sh <bead-id> [--decision <PR-or-SDD-url>]
#
set -eu
BEAD="${1:?usage: task-exit.sh <bead-id> [--decision <url>]}"
DECISION=""
shift || true
while [ $# -gt 0 ]; do case "$1" in
  --decision) DECISION="${2:?}"; shift 2 ;;
  --decision=*) DECISION="${1#*=}"; shift ;;
  *) echo "task-exit: unknown arg $1" >&2; exit 1 ;;
esac; done

# Refuse in the primary. Symlink-immune: compare git's RAW outputs.
if [ "$(git rev-parse --git-dir 2>/dev/null)" = "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  echo "✋ task-exit: this is the PRIMARY checkout. Lane work/exit happens in its worktree." >&2
  exit 1
fi

RR="$(git rev-parse --show-toplevel)"
BR="$(git -C "$RR" rev-parse --abbrev-ref HEAD)"
COMMON="$(cd "$(git -C "$RR" rev-parse --git-common-dir)" && pwd)"
BEADS_DIR="$(dirname "$COMMON")/.beads"   # the shared .beads lives by the primary

# 1. local beads flush only (NO push of issues.jsonl from a lane)
BEADS_DIR="$BEADS_DIR" br sync --flush-only >/dev/null 2>&1 || true

# 2. optionally mark this bead as awaiting a decision (structured protocol)
if [ -n "$DECISION" ]; then
  BEADS_DIR="$BEADS_DIR" br update "$BEAD" --add-label signoff:pending --external-ref "$DECISION" >/dev/null 2>&1 \
    && echo "✓ $BEAD → signoff:pending (external_ref set). Add the gate: br dep add <gated-id> $BEAD"
fi

# 3. commit any remaining work in THIS worktree
if [ -n "$(git -C "$RR" status --porcelain)" ]; then
  git -C "$RR" add -A
  git -C "$RR" -c commit.gpgsign=false commit -q -m "wip($BEAD): task-exit checkpoint" \
    && echo "✓ committed remaining work on $BR"
fi

# 4. push the branch — FAIL LOUD. A swallowed push = stranded work, the
#    exact failure this lifecycle exists to prevent.
if git -C "$RR" push -u origin "$BR" 2>&1; then
  echo "✓ pushed $BR"
else
  echo "✋ PUSH FAILED for $BR — your work is NOT on the remote. This task is" >&2
  echo "   NOT done. Resolve (rebase on origin/main, retry) before exiting." >&2
  exit 1
fi
if command -v gh >/dev/null 2>&1; then
  if gh pr view "$BR" >/dev/null 2>&1; then
    echo "  PR exists for $BR"
  else
    gh pr create --head "$BR" --fill --draft 2>&1 | tail -1 || echo "  ⚠ open the PR manually"
  fi

  # CI-trigger guarantee. A task-exit DRAFT PR is the merge gate, so it
  # MUST have a CI run immediately. GitHub does not start Actions from a
  # `pull_request` event created by some automation tokens, which strands
  # the gate with 0 check-runs until a human nudge (#380/#381: 0 runs
  # ever, even after `gh pr ready`). Self-heal, cause-agnostically: if no
  # workflow run is associated with the pushed head SHA shortly after PR
  # open, dispatch CI explicitly on this branch ref (ci.yml exposes
  # `workflow_dispatch`). Conditional so we do NOT double-run CI (and
  # double the bill) when the pull_request event DID fire.
  HEAD_SHA="$(git -C "$RR" rev-parse HEAD)"
  ci_runs_for_head() {
    gh api "repos/{owner}/{repo}/actions/runs?head_sha=$HEAD_SHA&per_page=1" \
      --jq '.total_count' 2>/dev/null || echo 0
  }
  RUNS=0
  for _wait in 1 2; do
    sleep 8
    RUNS="$(ci_runs_for_head)"
    [ "${RUNS:-0}" != "0" ] && break
  done
  if [ "${RUNS:-0}" = "0" ]; then
    if gh workflow run "CI" --ref "$BR" >/dev/null 2>&1; then
      echo "  ↻ no CI run for $HEAD_SHA — dispatched CI on $BR (gate self-heal)"
    else
      echo "  ⚠ no CI run for $HEAD_SHA and 'gh workflow run CI' failed — trigger the gate manually" >&2
    fi
  else
    echo "  ✓ CI run present for $HEAD_SHA (gate triggered)"
  fi
fi

cat <<EOF

DONE on $BR (pushed). Lifecycle remainder:
  • durable beads: the canonical owner runs  bash scripts/beads-sync.sh
  • cleanup: when the PR merges, reap thoroughly with
      bash scripts/task-reap.sh            # all merged worktrees
      bash scripts/task-reap.sh $BR        # just this one
    (reap NEVER discards dirty/unmerged work; it surfaces it instead.)
EOF
