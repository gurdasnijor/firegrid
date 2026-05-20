#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'USAGE'
Usage:
  bash scripts/phase1-workflow-core-paths-gate.sh
  bash scripts/phase1-workflow-core-paths-gate.sh <existing-run-id>

With no run id, runs the live workflow-core-paths simulation and then gates the
latest trace. With a run id, gates that existing trace without starting a live
agent. The live path requires ANTHROPIC_API_KEY.
USAGE
  exit 0
fi

RUN_ID="${1:-}"

if [ -z "$RUN_ID" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "ANTHROPIC_API_KEY is required to run workflow-core-paths live." >&2
    exit 2
  fi
  TIMEOUT_MS="${FIREGRID_WORKFLOW_CORE_PATHS_TIMEOUT_MS:-300000}"
  SIM_OUTPUT="$(pnpm --filter @firegrid/tiny-firegrid simulate:run -- workflow-core-paths --timeout-ms "$TIMEOUT_MS")"
  printf '%s\n' "$SIM_OUTPUT"
  RUN_ID="$(printf '%s\n' "$SIM_OUTPUT" | awk '/^run: / { print $2; exit }')"
  if [ -z "$RUN_ID" ]; then
    echo "workflow-core-paths run id was not found in simulate:run output." >&2
    exit 3
  fi
fi

pnpm --filter @firegrid/tiny-firegrid simulate:gate -- workflow-core-paths ${RUN_ID:+"$RUN_ID"}
