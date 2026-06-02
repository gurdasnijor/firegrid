#!/usr/bin/env bash
#
# CI freshness gate for the generated architecture dependency graphs (tf-0awo.22).
#
# The checked-in `docs/dependency-graph*.mmd` files went stale (May 16–20) because
# nothing regenerated and diffed them. This gate regenerates the deterministic
# dependency-cruiser Mermaid graphs and FAILS if any drifted from what is
# committed — i.e. a graph whose source import structure changed but that was
# never regenerated.
#
# Scope: the six graphs `pnpm run arch:graphs` (arch:deps + arch:deps:detail)
# emits. These are a pure function of the import graph (dependency-cruiser), so
# the check is fast and deterministic. The trace-derived architecture SVGs
# (docs/architecture/runtime-flow.svg / runtime-timeline.svg) are intentionally
# NOT covered: they are produced by scripts/runtime-flow-map.py from OTel traces,
# not by `arch:deps`, and are non-deterministic — they cannot belong in a fast,
# deterministic freshness gate.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Exactly the artifacts `arch:graphs` regenerates.
GRAPHS=(
  docs/dependency-graph.mmd
  docs/dependency-graph-detail.mmd
  docs/dependency-graph-runtime.mmd
  docs/dependency-graph-runtime-detail.mmd
  docs/dependency-graph-client.mmd
  docs/dependency-graph-protocol.mmd
)

pnpm run arch:graphs

if ! git diff --exit-code -- "${GRAPHS[@]}"; then
  echo ""
  echo "✗ Architecture dependency graphs are stale: the import graph changed but the"
  echo "  checked-in Mermaid graphs were not regenerated (diff above). Run:"
  echo ""
  echo "      pnpm run arch:graphs"
  echo ""
  echo "  and commit the updated docs/dependency-graph*.mmd."
  exit 1
fi

echo "✓ Architecture dependency graphs are fresh."
