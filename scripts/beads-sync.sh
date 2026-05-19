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
# Canonical-owner enforcement (opt-in: only enforced once .beads/.beads-owner
# exists, so this is backward-compatible). Separation of duties — the
# coordinator/router must NOT also own the durable decision record.
OWNER_FILE="$RR/.beads/.beads-owner"
if [ -f "$OWNER_FILE" ]; then
  OWNER="$(tr -d ' \n' < "$OWNER_FILE" 2>/dev/null)"
  case "$OWNER" in
    cron)
      [ "${FG_BEADS_OWNER:-}" = "1" ] || {
        echo "✋ beads-sync: canonical owner is 'cron'. Only the beads-sync" >&2
        echo "   cron may run this (it sets FG_BEADS_OWNER=1). The coordinator" >&2
        echo "   and lanes must not. Deliberate br-owner op: FG_BEADS_OWNER=1" >&2
        echo "   (audited)." >&2
        exit 1; }
      [ "${FG_BEADS_OWNER:-}" = "1" ] && [ -z "${FG_BEADS_CRON:-}" ] \
        && printf '%s manual FG_BEADS_OWNER override by %s\n' "$(date -u +%FT%TZ)" "$(git config user.email 2>/dev/null || echo unknown)" \
        >> "$(git -C "$RR" rev-parse --absolute-git-dir)/firegrid-beads-owner-override.log" 2>/dev/null || true ;;
    *)
      [ "${FG_BEADS_OWNER_ID:-}" = "$OWNER" ] || {
        echo "✋ beads-sync: canonical owner is '$OWNER'. Set FG_BEADS_OWNER_ID=$OWNER to run (you are not it)." >&2
        exit 1; } ;;
  esac
fi
MSG="${1:-chore(beads): canonical sync $(date -u +%FT%TZ)}"

# Lock lives in the shared .git dir, NOT .beads/ — `br` itself creates
# .beads/.sync.lock and .beads/.write.lock as 0-byte FILES, which made our
# `mkdir .beads/.sync.lock` collide forever (the 6× "needs manual pre-clear"
# tax). .git/ is br-untouched and shared across worktrees (correct scope).
LOCK="$(cd "$(git -C "$RR" rev-parse --git-common-dir)" && pwd)/firegrid-beads-sync.lock"
# Self-heal a stale lock (crashed holder): if older than 120s, reap it —
# never require a manual pre-clear again.
if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  [ "$age" -gt 120 ] && { echo "beads-sync: reaping stale lock (${age}s old)"; rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"; }
fi
# mkdir is atomic — a portable, NFS-safe mutex (flock is absent on stock macOS).
tries=0
until mkdir "$LOCK" 2>/dev/null; do
  tries=$((tries+1))
  if [ "$tries" -gt 90 ]; then echo "beads-sync: lock held >90s ($LOCK) — another canonical sync running, aborting" >&2; exit 1; fi
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

BEADS_DIR="$RR/.beads" br sync --flush-only >/dev/null 2>&1 || true
git -C "$RR" fetch -q origin main

# Commit any working-tree beads change (if dirty).
if ! git -C "$RR" diff --quiet -- .beads/issues.jsonl || ! git -C "$RR" diff --cached --quiet -- .beads/issues.jsonl; then
  git -C "$RR" add .beads/issues.jsonl
  git -C "$RR" -c commit.gpgsign=false commit -q -m "$MSG"
fi

# "Nothing to do" means DURABLE, not just "working tree == HEAD". The old
# guard exited here after a failed push left the commit on local HEAD —
# stranding it forever (every later run saw a clean working tree). Correct
# test: working tree clean AND local HEAD already an ancestor of
# origin/main. If a prior sync's commit is stranded (local ahead), fall
# through and push it.
if git -C "$RR" diff --quiet -- .beads/issues.jsonl \
   && git -C "$RR" diff --cached --quiet -- .beads/issues.jsonl \
   && git -C "$RR" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "beads-sync: issues.jsonl durable on origin/main — nothing to do"
  exit 0
fi
# else: either a fresh commit above, or a stranded prior commit → push it.
# best-effort rebase; capture its real status (NOT a pipe's — pipelines
# return the last cmd's exit, which masked failures and produced the
# "false-success" the br-owner had to ground-truth every time).
if ! git -C "$RR" -c rebase.autoStash=true pull -q --rebase origin main >/dev/null 2>&1; then
  echo "beads-sync: rebase onto origin/main had issues — attempting push anyway, will verify" >&2
fi
# THE fix: test git push's own exit, not `tail`'s. No pipe.
if git -C "$RR" push origin HEAD:main >/dev/null 2>&1; then
  # ground-truth it: the commit must actually be on origin/main now.
  git -C "$RR" fetch -q origin main
  if git -C "$RR" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "✓ beads-sync: issues.jsonl pushed AND verified on origin/main"
  else
    echo "✋ beads-sync: push reported OK but HEAD is NOT an ancestor of" >&2
    echo "   origin/main — NOT durable. Re-run after resolving." >&2
    exit 1
  fi
else
  echo "✋ beads-sync: PUSH FAILED — issues.jsonl committed locally but NOT on" >&2
  echo "   origin/main. Resolve (fetch/rebase) and re-run; the lock is released." >&2
  exit 1
fi
