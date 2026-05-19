#!/usr/bin/env bash
# beads-sync — THE canonical, lock-serialized path to durable beads state.
#
# Exactly one context runs this: br sync --flush-only → commit → push
# .beads/issues.jsonl to origin/main, holding a sync lock so concurrent
# exports from lanes/worktrees cannot race (that race produced the recurring
# "chore(beads): sync concurrent lane bead state" commits and stranded
# decision state). Lanes only mutate their local beads.db; they NEVER push
# issues.jsonl — task-exit defers to this.
#
# Run from the primary on `main` (the guardrail allows main), or set
# FIREGRID_ALLOW_PRIMARY=1 for a deliberate br-owner op on a non-main primary.
#
# Usage:  bash scripts/beads-sync.sh ["commit message"]
set -eu
RR="$(git rev-parse --show-toplevel)"
# Symlink-immune: raw git outputs, no cd/pwd.
[ "$(git rev-parse --git-dir 2>/dev/null)" = "$(git rev-parse --git-common-dir 2>/dev/null)" ] \
  || { echo "✋ beads-sync runs from the PRIMARY checkout, not a worktree." >&2; exit 1; }
BR="$(git -C "$RR" rev-parse --abbrev-ref HEAD)"
if [ "$BR" != "main" ] && [ "${FIREGRID_ALLOW_PRIMARY:-}" != "1" ]; then
  echo "✋ beads-sync: primary is on '$BR', not main. Get it to main first (or FIREGRID_ALLOW_PRIMARY=1)." >&2
  exit 1
fi
MSG="${1:-chore(beads): canonical sync $(date -u +%FT%TZ)}"

LOCK="$RR/.beads/.sync.lock"
# mkdir is atomic — a portable, NFS-safe mutex (flock is absent on stock macOS).
tries=0
until mkdir "$LOCK" 2>/dev/null; do
  tries=$((tries+1)); [ "$tries" -gt 60 ] && { echo "beads-sync: lock held >60s ($LOCK) — aborting" >&2; exit 1; }
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

BEADS_DIR="$RR/.beads" br sync --flush-only >/dev/null 2>&1 || true

if git -C "$RR" diff --quiet -- .beads/issues.jsonl && git -C "$RR" diff --cached --quiet -- .beads/issues.jsonl; then
  echo "beads-sync: issues.jsonl already in sync — nothing to push"
  exit 0
fi

# Commit the beads change FIRST, then rebase — a dirty issues.jsonl makes
# `pull --rebase` no-op silently and a moved origin/main then rejects the
# push (the recurring failure). Commit → fetch → rebase (now clean) → push.
git -C "$RR" add .beads/issues.jsonl
git -C "$RR" -c commit.gpgsign=false commit -q -m "$MSG"
git -C "$RR" fetch -q origin main
git -C "$RR" -c rebase.autoStash=true pull -q --rebase origin main 2>&1 | tail -1 || true
if git -C "$RR" push origin HEAD:main 2>&1 | tail -1; then
  echo "✓ beads-sync: issues.jsonl pushed to origin/main"
else
  echo "✋ beads-sync: PUSH FAILED — issues.jsonl committed locally but NOT on" >&2
  echo "   origin/main. Resolve (fetch/rebase) and re-run; the lock is released." >&2
  exit 1
fi
