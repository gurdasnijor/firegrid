#!/usr/bin/env bash
# One-time: point git at the tracked hooks (applies to the primary AND every
# worktree — the hooks self-target the primary, no-op elsewhere).
set -eu
RR="$(git rev-parse --show-toplevel)"
chmod +x "$RR"/scripts/git-hooks/* 2>/dev/null || true
git -C "$RR" config core.hooksPath scripts/git-hooks
echo "✓ core.hooksPath = scripts/git-hooks (primary-stays-on-main guardrail active)"
echo "  verify: git -C '$RR' config core.hooksPath"
