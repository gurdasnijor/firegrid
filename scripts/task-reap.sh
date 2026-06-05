#!/usr/bin/env bash
# task-reap — thorough, SAFE end-of-life cleanup for lane worktrees.
#
# Reaps only worktrees that are BOTH clean AND landed (PR squash-merged, or
# 0 commits ahead of origin/main). For each reaped branch it removes the
# worktree, deletes the branch, and prunes. It then reconciles beads: if the
# reaped branch's bead is still open/in_progress it SURFACES it (never
# auto-closes — work-vs-decision + br-owner own closes).
#
# It NEVER discards dirty or unmerged work — those are reported and kept.
# Run from the primary on main (it does primary-level git ops; not a commit,
# so the guardrail does not block it).
#
# Usage:
#   bash scripts/task-reap.sh            # every merged+clean lane worktree
#   bash scripts/task-reap.sh <branch>   # just that one
set -u
. "$(dirname "$0")/_lane-common.sh"   # no-hang guards (git/gh never prompt)
RR="$(git rev-parse --show-toplevel)"
[ "$(git rev-parse --git-dir 2>/dev/null)" = "$(git rev-parse --git-common-dir 2>/dev/null)" ] \
  || { echo "✋ task-reap runs from the PRIMARY checkout." >&2; exit 1; }
ONLY="${1:-}"
git -C "$RR" fetch -q origin main 2>/dev/null || true
# firegrid-worktree-lifecycle.STORE_BOUNDARY.1
CANONICAL_BEADS_DIR="${BEADS_DIR:-"$(dirname "$RR")/.beads"}"
JSONL="$CANONICAL_BEADS_DIR/issues.jsonl"

reaped=0; kept=0; loose=""

# iterate worktree (path, branch) pairs, sibling lane worktrees only
while IFS=$'\t' read -r wt br; do
  case "$wt" in *"/firegrid-worktrees/"*) ;; *) continue ;; esac
  [ -n "$ONLY" ] && [ "$br" != "$ONLY" ] && continue

  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "KEEP  $br  — dirty (uncommitted work; not reaped)"; kept=$((kept+1)); continue
  fi
  merged=""
  if command -v gh >/dev/null 2>&1; then
    merged="$(gh pr list --head "$br" --state merged --json number --jq '.[0].number' 2>/dev/null || true)"
  fi
  if [ -z "$merged" ]; then
    ahead="$(git -C "$RR" rev-list --count "origin/main..$br" 2>/dev/null || echo 1)"
    [ "$ahead" = "0" ] || { echo "KEEP  $br  — unmerged ($ahead commit(s) not on origin/main; not reaped)"; kept=$((kept+1)); continue; }
  fi

  # merged + clean → reap thoroughly
  if git -C "$RR" worktree remove "$wt" 2>/dev/null; then
    git -C "$RR" branch -D "$br" >/dev/null 2>&1 || true
    echo "REAP  $br  — worktree removed, branch deleted${merged:+ (PR #$merged)}"
    reaped=$((reaped+1))
    # beads reconciliation: branch <class>/<bead>-<slug> → bead id
    bead="$(printf '%s' "$br" | sed 's|^[^/]*/||' | grep -oE '^tf-[a-z0-9]+' || true)"
    if [ -n "$bead" ] && [ -f "$JSONL" ]; then
      # firegrid-worktree-lifecycle.TASK_REAP.1
      st="$(jq -r --arg b "$bead" 'select(.id==$b)|.status' "$JSONL" 2>/dev/null | head -1)"
      if [ -n "$st" ] && [ "$st" != "closed" ]; then
        loose="$loose  • $bead ($st) — branch $br merged+reaped but bead still open;\n    resolve via the structured path (br close --reason / signoff) — NOT auto-closed.\n"
      fi
    fi
  else
    echo "KEEP  $br  — worktree remove failed (in use? cd out and retry)"; kept=$((kept+1))
  fi
done < <(git -C "$RR" worktree list --porcelain | awk '
  /^worktree /{w=$2} /^branch /{sub("refs/heads/","",$2); b=$2}
  /^$/{ if (w!="" ) { print w "\t" b; w=""; b="" } }
  END{ if (w!="") print w "\t" b }')

git -C "$RR" worktree prune -v 2>/dev/null || true

echo
echo "════ reap summary: $reaped reaped · $kept kept (dirty/unmerged, preserved) ════"
if [ -n "$loose" ]; then
  echo "⚠ BEADS LOOSE ENDS (merged+reaped but bead still open — reconcile, don't ignore):"
  printf "$loose"
else
  echo "✓ no beads loose ends"
fi
