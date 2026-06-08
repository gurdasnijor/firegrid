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
# Lane hardening: prompts can't hang the (stdin-less) lane; preflight is
# timeout-capped. (TASK_DEBUG=1 step-traces where a lane wedges.)
. "$(dirname "$0")/_lane-common.sh"
lane_output_advisory
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
# Use the SAME store task-enter claimed against (inherited br-owner store if set,
# else the repo .beads) so enter/exit never disagree — and HARD-STOP if the bead
# is missing there. Continuing to commit/push/open a PR for a bead that isn't in
# the store the br-owner syncs is the exact durable-state bug this lifecycle
# prevents. Explicit escape only: TASK_ALLOW_MISSING_BEAD=1.
BEADS_DIR="$(resolve_beads_dir || true)"
export BEADS_DIR
if [ -z "${BEADS_DIR:-}" ]; then
  echo "✋ task-exit: could not resolve a beads store; refusing to push untracked work." >&2
  [ "${TASK_ALLOW_MISSING_BEAD:-}" = "1" ] || exit 1
elif ! lane_beads_status "$BEAD" "$BEADS_DIR"; then
  if [ "${TASK_ALLOW_MISSING_BEAD:-}" = "1" ]; then
    echo "⚠ task-exit: TASK_ALLOW_MISSING_BEAD=1 — pushing with UNTRACKED bead $BEAD." >&2
  else
    echo "✋ task-exit: bead $BEAD missing from $BEADS_DIR — refusing to push/PR untracked work." >&2
    echo "   Your work is committed locally (nothing stranded remotely). Fix bead state" >&2
    echo "   (create/import it in that store) or set TASK_ALLOW_MISSING_BEAD=1, then re-run." >&2
    exit 1
  fi
fi

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

# 3a. No-diff guard — refuse to proceed when the branch has NO commits ahead of
#     its base. Pushing that opens a BLANK PR (the other blank-PR source besides
#     --fill). Fail loud instead of stranding an empty draft.
BASE_REF="${FIREGRID_TASK_BASE:-origin/main}"
case "$BASE_REF" in origin/*) ;; *) BASE_REF="origin/$BASE_REF" ;; esac
git -C "$RR" fetch -q origin "${BASE_REF#origin/}" 2>/dev/null || true
AHEAD="$(git -C "$RR" rev-list --count "$BASE_REF..HEAD" 2>/dev/null || echo 1)"
if [ "${AHEAD:-1}" = "0" ]; then
  echo "✋ task-exit: $BR has NO commits ahead of $BASE_REF — nothing to PR." >&2
  echo "   The lane produced no diff. Make + commit the work first, then re-run." >&2
  echo "   (task-exit only commits LEFTOVER changes; it never invents a diff.)" >&2
  exit 1
fi

# 3b. EXIT GATE — keep task-exit lightweight. It must catch obvious patch
#     corruption before push, but it must not unconditionally run the heavy
#     build/test matrix. Lanes are still prompted to run the canonical gate
#     themselves before asking for merge:
#         pnpm preflight
#     Explicit opt-in remains available for lanes that want task-exit to run it:
#         TASK_EXIT_RUN_PREFLIGHT=1 bash scripts/task-exit.sh <bead-id>
echo "▶ task-exit: lightweight exit gate (git diff --check)."
if ! git -C "$RR" diff --check "$BASE_REF...HEAD"; then
  echo "✋ task-exit: lightweight gate FAILED — whitespace errors / conflict markers above." >&2
  echo "   Fix them (or remove the offending lines), then re-run task-exit." >&2
  exit 1
fi
echo "✓ task-exit: lightweight gate passed."

if [ "${TASK_EXIT_RUN_PREFLIGHT:-}" = "1" ]; then
  echo "▶ task-exit: TASK_EXIT_RUN_PREFLIGHT=1 — running pnpm preflight before push (≤${TASK_EXIT_PREFLIGHT_TIMEOUT:-1200}s)…"
  if ! with_timeout "${TASK_EXIT_PREFLIGHT_TIMEOUT:-1200}" sh -c "cd '$RR' && pnpm preflight"; then
    echo "" >&2
    echo "✋ task-exit: pnpm preflight FAILED or TIMED OUT — REFUSING to push $BR or open a PR." >&2
    echo "   Your work is committed locally on $BR but NOT pushed. Fix the failing" >&2
    echo "   gate(s) above, then re-run task-exit, or omit TASK_EXIT_RUN_PREFLIGHT" >&2
    echo "   to use the lightweight default." >&2
    exit 1
  fi
  echo "✓ task-exit: pnpm preflight green — proceeding to push."
else
  echo "⚠ task-exit: pnpm preflight was NOT run automatically." >&2
  echo "   Prompt for lane: run \`pnpm preflight\` before requesting merge/signoff." >&2
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
  # PR base = origin/main (canonical post-#765). FIREGRID_TASK_BASE overrides
  # for the rare lane that forks off a non-main integration branch.
  PR_BASE="${FIREGRID_TASK_BASE:-main}"; PR_BASE="${PR_BASE#origin/}"

  # Title: first non-wip commit subject; fallback to "<bead>: <slug>" (NEVER a
  # raw "wip(...)" subject, which --fill would have produced).
  PR_TITLE="$(git -C "$RR" log "$BASE_REF..HEAD" --format='%s' | grep -vi '^wip(' | head -1)"
  if [ -z "$PR_TITLE" ]; then
    _slug="${BR#*/}"; _slug="${_slug#"$BEAD"-}"; _slug="$(printf '%s' "$_slug" | tr '-' ' ')"
    PR_TITLE="${BEAD:+$BEAD: }${_slug:-lane work}"
  fi

  # Durable review scaffold — AUTOMATED so authors cannot silently omit the
  # sections reviewers need. Bead comes from `br show`; specs/evidence come from
  # lane-provided inputs (TASK_EXIT_SPECS_FILE/TASK_EXIT_SPECS,
  # TASK_EXIT_EVIDENCE_FILE/TASK_EXIT_EVIDENCE) and render a clear placeholder
  # when absent — we never invent specs or evidence. Changed files use three-dot
  # (merge-base) so an out-of-date branch doesn't pollute the list with main-side
  # churn (the "stale body lists deleted files" symptom).
  _emit_section() {  # <file> <inline> <placeholder>
    if [ -n "${1:-}" ] && [ -f "$1" ]; then cat "$1"
    elif [ -n "${2:-}" ]; then printf '%s\n' "$2"
    else printf '%s\n' "$3"; fi
  }
  BEAD_TEXT="$(BEADS_DIR="$BEADS_DIR" br show "$BEAD" 2>/dev/null || true)"
  [ -n "$BEAD_TEXT" ] || BEAD_TEXT="$BEAD — not found in ${BEADS_DIR:-<unresolved>} (TASK_ALLOW_MISSING_BEAD override)"

  PR_BODY_FILE="$(mktemp)"
  {
    echo "## Lane \`$BR\`"
    echo
    echo "### Bead"
    echo '```'
    printf '%s\n' "$BEAD_TEXT"
    echo '```'
    echo
    echo "### Gherkin / specs satisfied"
    _emit_section "${TASK_EXIT_SPECS_FILE:-}" "${TASK_EXIT_SPECS:-}" \
      "_None provided. Set \`TASK_EXIT_SPECS_FILE\` or \`TASK_EXIT_SPECS\` to the satisfied \`.feature\` scenarios, or \"N/A — tooling-only\". Specs are not auto-claimed._"
    echo
    echo "### Evidence"
    _emit_section "${TASK_EXIT_EVIDENCE_FILE:-}" "${TASK_EXIT_EVIDENCE:-}" \
      "_None provided. Set \`TASK_EXIT_EVIDENCE_FILE\` or \`TASK_EXIT_EVIDENCE\` with commands run + results. Firelab sims: exact \`pnpm --filter firelab simulate <sim>\` command, run id/path, verdict, key gates, trace path. Evidence is not invented._"
    echo
    echo "### Acceptance classification"
    echo "<!-- Required for any PR citing a Gherkin/product scenario."
    echo "     See packages/firelab/docs/methodology.md \"Acceptance vs workbench\". -->"
    echo "- [ ] **Kind:** acceptance (driver drives public ingress) · OR · workbench/package-integration (does NOT claim Gherkin satisfaction)"
    echo "- [ ] **Public/external ingress used:** <which \`@firegrid/client-sdk\` / external entrypoint the driver called>"
    echo "- [ ] **Driver action:** <what the driver stimulated through that ingress — drove, not observed>"
    echo "- [ ] **Host role:** serves/composes the production surface only; does NOT self-drive the target behavior"
    echo "- [ ] **Gates → causal path:** external ingress → production substrate behavior (not just that substrate spans fired)"
    echo
    echo "### Changed files"
    echo '```'
    git -C "$RR" diff --stat "$BASE_REF...HEAD"
    echo '```'
  } > "$PR_BODY_FILE"

  # Create the PR, or REFRESH an existing one's title+body (so a rerun
  # regenerates stale metadata instead of leaving the first body forever).
  if gh pr view "$BR" >/dev/null 2>&1; then
    gh pr edit "$BR" --title "$PR_TITLE" --body-file "$PR_BODY_FILE" >/dev/null 2>&1 \
      && echo "  ✓ refreshed PR title/body for $BR" \
      || echo "  ⚠ could not refresh PR body for $BR — edit manually" >&2
  else
    gh pr create --head "$BR" --base "$PR_BASE" --title "$PR_TITLE" --body-file "$PR_BODY_FILE" --draft 2>&1 | tail -1 \
      || echo "  ⚠ open the PR manually"
  fi
  rm -f "$PR_BODY_FILE"

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
  • durable beads: the canonical owner flushes/syncs beads (see docs/contributing/beads-operating-guide.md)
  • cleanup: when the PR merges, reap thoroughly with
      bash scripts/task-reap.sh            # all merged worktrees
      bash scripts/task-reap.sh $BR        # just this one
    (reap NEVER discards dirty/unmerged work; it surfaces it instead.)
EOF

# Single bounded terminal line — an agent reads THIS instead of piping to tail.
PR_URL=""
if command -v gh >/dev/null 2>&1; then
  PR_URL="$(gh pr view "$BR" --json url -q .url 2>/dev/null || true)"
fi
echo "LANE STATUS: $BEAD pushed on $BR${PR_URL:+ — PR $PR_URL}. Run wrappers directly (no | tail, no &)."
