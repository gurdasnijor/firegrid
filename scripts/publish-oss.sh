#!/usr/bin/env bash
#
# publish-oss.sh — refresh the open-core mirror (smithery-ai/firegrid) from
# the current origin/main as a curated, squashed snapshot.
#
# The mirror is a SNAPSHOT, not a fork: it shares no history with this repo.
# Each run rebuilds the open-core subset from origin/main (tracked files
# only), runs a fail-loud safety guard, and FORCE-PUSHES a single snapshot
# commit. Force-push is intentional — the mirror is always a clean snapshot
# of one upstream commit, never an accumulating history.
#
# The ALLOWLIST below is the firewall: only these paths are published.
# Anything not listed (apps/, docs/handoffs, docs/research, .beads, scripts/,
# features/, repos/, etc.) never leaves this repo.
#
# Usage:
#   pnpm run publish:oss               # publish origin/main → smithery main
#   pnpm run publish:oss -- --dry-run  # build + guard + show contents, no push
#
set -euo pipefail

MIRROR_REMOTE="https://github.com/smithery-ai/firegrid.git"
MIRROR_BRANCH="main"
REPO_ROOT="$(git rev-parse --show-toplevel)"
OSS_TPL="$REPO_ROOT/scripts/oss"

# ── THE FIREWALL ──────────────────────────────────────────────────────────
# Only these tracked paths from origin/main are published. Edit deliberately.
ALLOWLIST=(
  packages
  docs/cannon
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  README.md
  eslint.config.js
  tsconfig.eslint.json
  turbo.json
)

# Top-level entries permitted in the published tree (allowlist basenames +
# the mirror-only files this script stamps + git internals).
ALLOWED_TOP=(packages docs package.json pnpm-lock.yaml pnpm-workspace.yaml \
  README.md eslint.config.js tsconfig.eslint.json turbo.json LICENSE .gitignore .git)

DRY_RUN=false
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY_RUN=true; done

fail() { echo "✗ GUARD FAILED: $1" >&2; exit 1; }

echo "→ fetching origin/main…"
git -C "$REPO_ROOT" fetch origin main --quiet
SHA="$(git -C "$REPO_ROOT" rev-parse --short origin/main)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "→ building open-core snapshot of $SHA"
git -C "$REPO_ROOT" archive origin/main "${ALLOWLIST[@]}" | tar -x -C "$WORK"

# Stamp mirror-only files (Apache-2.0 LICENSE + the published .gitignore).
cp "$OSS_TPL/LICENSE" "$WORK/LICENSE"
cp "$OSS_TPL/gitignore" "$WORK/.gitignore"

echo "→ running safety guard…"

# 1. No credential / env / key material.
creds="$(find "$WORK" -type f \( \
  -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name 'credentials.json' \
  -o -name '*.p12' -o -name '.env' -o -name '.env.*' \) ! -name '.env.example' || true)"
[ -n "$creds" ] && { printf '%s\n' "$creds" >&2; fail "credential/env file in published tree"; }

# 2. No hardcoded secrets (specific patterns; a hit means: a human looks).
secret_hits="$(grep -rIlE \
  'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  "$WORK" 2>/dev/null || true)"
[ -n "$secret_hits" ] && { printf '%s\n' "$secret_hits" >&2; fail "possible hardcoded secret in published tree"; }

# 3a. .beads must never appear anywhere in the published tree.
beads_leak="$(find "$WORK" \( -path '*/.beads/*' -o -name '*.beads' \) || true)"
[ -n "$beads_leak" ] && { printf '%s\n' "$beads_leak" >&2; fail ".beads path in published tree"; }

# 3b. Internal handoff/research dirs — but NOT inside docs/cannon, which is the
#     explicitly curated canon (allowlisted whole) and legitimately carries its
#     own research/ and handoffs/ sections. Prune the canon subtree first.
internal="$(find "$WORK" -path "$WORK/docs/cannon" -prune -o \
  \( -path '*/handoffs/*' -o -path '*/research/*' -o -name 'HANDOFF*' \) -print || true)"
[ -n "$internal" ] && { printf '%s\n' "$internal" >&2; fail "internal-only handoffs/research path outside docs/cannon"; }

# 4. docs/ publishes only cannon.
if [ -d "$WORK/docs" ]; then
  for d in "$WORK"/docs/*/; do
    [ -e "$d" ] || continue
    [ "$(basename "$d")" = cannon ] || fail "unexpected docs/ subdir: $(basename "$d") (only docs/cannon is published)"
  done
fi

# 5. Top-level is only the intended entries.
shopt -s dotglob nullglob
for entry in "$WORK"/*; do
  base="$(basename "$entry")"
  ok=false
  for a in "${ALLOWED_TOP[@]}"; do [ "$base" = "$a" ] && ok=true && break; done
  $ok || fail "unexpected top-level entry: $base"
done
shopt -u dotglob nullglob

echo "✓ guard passed"

# ── Build the snapshot repo and (force-)publish ─────────────────────────────
cd "$WORK"
git init -q
git checkout -q -b "$MIRROR_BRANCH"
git add -A
git -c user.name="firegrid-oss" -c user.email="oss@firegrid.dev" \
  commit -q -m "Open-core snapshot of $SHA"

FILE_COUNT="$(git ls-files | wc -l | tr -d ' ')"
echo "→ snapshot of $SHA built: $FILE_COUNT files"

if $DRY_RUN; then
  echo "✓ DRY RUN — snapshot built + guard passed; NOT pushing."
  exit 0
fi

git remote add smithery "$MIRROR_REMOTE"
echo "→ force-pushing to $MIRROR_REMOTE ($MIRROR_BRANCH)…"
git push --force smithery "$MIRROR_BRANCH:$MIRROR_BRANCH"
echo "✓ published open-core snapshot of $SHA to smithery-ai/firegrid"
