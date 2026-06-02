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

# 3. commit any remaining work in THIS worktree.
#    EXCLUDE .beads/ from the add: a lane's local `br update` operations mutate
#    .beads/issues.jsonl in the worktree's working tree, and `git add -A` would
#    otherwise sweep those into the lane commit. The cron is the canonical
#    pusher of .beads/issues.jsonl (see step 1's "local beads flush only"
#    comment + the script header). Without this exclude, the lane commit ends
#    up containing .beads/ changes that then collide non-patch-equivalently
#    with cron-pushed origin/main .beads/ updates on rebase — the failure that
#    forced PR #531 (tf-482w) to be closed-as-superseded. Pathspec ':!.beads/'
#    is git's "exclude" magic syntax; the lane's real work commits as before.
if [ -n "$(git -C "$RR" status --porcelain -- ':!.beads/')" ]; then
  git -C "$RR" add -A -- ':!.beads/'
  git -C "$RR" -c commit.gpgsign=false commit -q -m "wip($BEAD): task-exit checkpoint" \
    && echo "✓ committed remaining work on $BR"
fi

# 3b. PREFLIGHT GATE — run the full local gate set on the committed state and
#     REFUSE to push / open a PR on failure. The DRAFT PR is the merge gate, so
#     pushing a red branch just burns a CI round-trip and strands a failing PR;
#     fail loud LOCALLY instead. This is the discipline made structural: lanes
#     were skipping `pnpm preflight` by hand, so every open PR failed the same
#     checks. `pnpm preflight` runs all gates in parallel (weighted semaphore),
#     so it stays fast. Runs against HEAD (the just-committed work). Escape only
#     with explicit intent (prints a loud warning):
#         TASK_EXIT_SKIP_PREFLIGHT=1 bash scripts/task-exit.sh <bead-id>
#     — for the rare case of knowingly pushing WIP (cannot be set by accident).
if [ "${TASK_EXIT_SKIP_PREFLIGHT:-}" = "1" ]; then
  echo "⚠ task-exit: TASK_EXIT_SKIP_PREFLIGHT=1 — SKIPPING pnpm preflight." >&2
  echo "   The push/PR is NOT locally verified; CI may fail. Use sparingly." >&2
else
  echo "▶ task-exit: running pnpm preflight before push (override: TASK_EXIT_SKIP_PREFLIGHT=1)…"
  if ! ( cd "$RR" && pnpm preflight ); then
    echo "" >&2
    echo "✋ task-exit: pnpm preflight FAILED — REFUSING to push $BR or open a PR." >&2
    echo "   Your work is committed locally on $BR but NOT pushed (nothing stranded" >&2
    echo "   remotely). Fix the failing gate(s) above, then re-run task-exit." >&2
    echo "   (Override with TASK_EXIT_SKIP_PREFLIGHT=1 only when knowingly pushing WIP.)" >&2
    exit 1
  fi
  echo "✓ task-exit: pnpm preflight green — proceeding to push."
fi

# 4. push the branch — FAIL LOUD. A swallowed push = stranded work, the
#    exact failure this lifecycle exists to prevent.
#
#    Recurring fallout class: a lane rebases its branch onto origin/main
#    (required before merge), which rewrites history so the local branch
#    and origin/<BR> DIVERGE. A plain `git push` then fails non-fast-
#    forward; the old "rebase on origin/main, retry" hint does NOT help
#    (the branch is already rebased) so the lane loops and the work
#    strands with no PR. Handle it explicitly:
#      • clean rebase of our OWN remote branch (every origin/<BR> commit
#        has a patch-equivalent in local HEAD, i.e. no remote-only work)
#        → recover with --force-with-lease (race-safe; NEVER plain --force)
#      • remote has commits NOT represented locally → DIVERGENCE, hard
#        stop + surface (refuse to clobber; another lane may share it)
#      • any other push failure → loud, actionable, non-zero
push_lane_branch() {
  if git -C "$RR" push -u origin "$BR" 2>&1; then
    echo "✓ pushed $BR"
    return 0
  fi
  if ! git -C "$RR" ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1; then
    echo "✋ PUSH FAILED for $BR and no remote branch exists — NOT a rebase/" >&2
    echo "   non-ff case (auth, network, or a rejecting hook). Work is NOT" >&2
    echo "   pushed; task NOT done. Resolve and re-run task-exit." >&2
    return 1
  fi
  # refresh the remote-tracking ref so the lease + divergence check are
  # against the true current remote, not a stale local view.
  git -C "$RR" fetch -q origin "+refs/heads/$BR:refs/remotes/origin/$BR" 2>/dev/null || true
  # `git cherry HEAD origin/$BR`: lists each origin/$BR commit; '+' = NO
  # patch-equivalent in local HEAD (remote-only work we'd destroy), '-' =
  # already represented locally (the rebased commits). Any '+' ⇒ divergence.
  foreign="$(git -C "$RR" cherry HEAD "origin/$BR" 2>/dev/null | grep -c '^+' || true)"
  if [ "${foreign:-1}" != "0" ]; then
    echo "✋ PUSH FAILED for $BR — origin/$BR has ${foreign} commit(s) with no" >&2
    echo "   equivalent in your local branch. This is a DIVERGENCE, not a" >&2
    echo "   clean rebase — REFUSING to force (would clobber work; another" >&2
    echo "   lane may share this branch). Investigate, do NOT blind-force:" >&2
    echo "     git -C \"$RR\" log --oneline HEAD..origin/$BR" >&2
    echo "   Work is NOT pushed; task NOT done." >&2
    return 1
  fi
  local remote_sha
  remote_sha="$(git -C "$RR" rev-parse "origin/$BR" 2>/dev/null)"
  echo "  ↻ $BR was rebased (local is a clean rebase of origin/$BR; no" >&2
  echo "    remote-only commits) — recovering with --force-with-lease." >&2
  if git -C "$RR" push --force-with-lease="$BR:$remote_sha" -u origin "$BR" 2>&1; then
    echo "✓ pushed $BR (force-with-lease, post-rebase safe path)"
    return 0
  fi
  echo "✋ PUSH FAILED for $BR even with --force-with-lease — the remote ref" >&2
  echo "   moved since fetch (lease broke / concurrent push) or a hook" >&2
  echo "   rejected it. Work is NOT pushed; task NOT done. Re-fetch, verify" >&2
  echo "   no foreign commits, retry task-exit." >&2
  return 1
}
if ! push_lane_branch; then
  exit 1
fi
if command -v gh >/dev/null 2>&1; then
  if gh pr view "$BR" >/dev/null 2>&1; then
    echo "  PR exists for $BR"
  else
    # PR base = origin/main (canonical post-#765). FIREGRID_TASK_BASE overrides
    # for the rare lane that forks off a non-main integration branch.
    PR_BASE="${FIREGRID_TASK_BASE:-main}"; PR_BASE="${PR_BASE#origin/}"
    gh pr create --head "$BR" --base "$PR_BASE" --fill --draft 2>&1 | tail -1 || echo "  ⚠ open the PR manually"
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
