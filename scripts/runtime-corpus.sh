#!/usr/bin/env bash
# runtime-corpus — regenerate the fixed runtime-shrink corpus and run the
# checkpoint (docs/architecture/runtime-shrink-loop.md, Phase 0).
#
# "Fixed corpus" = a fixed SCENARIO SET + run recipe + stable artifact path,
# NOT frozen raw traces. C is read from span attributes, so the corpus is
# REGENERATED from the same scenarios after source annotations land (then C
# rises). N is volume-independent, so short re-captures reproduce the same N.
#
# Usage:
#   bash scripts/runtime-corpus.sh regen      # (re)run scenarios -> stable trace paths
#   bash scripts/runtime-corpus.sh check      # regen (if needed) + check against baseline
#   bash scripts/runtime-corpus.sh baseline   # regen + REWRITE runtime-shape-baseline.json
#   bash scripts/runtime-corpus.sh measure    # regen + print N/C report (no gate)
#
# Env:
#   CORPUS_NO_REGEN=1   reuse existing stable traces, skip running scenarios
#   CORPUS_TIMEOUT_MS   per-scenario simulate timeout (default 180000)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
MANIFEST="docs/architecture/corpus/manifest.json"
RUNS_DIR="docs/architecture/corpus/.runs"
BASELINE="runtime-shape-baseline.json"
DC="$RUNS_DIR/depcruise.json"
TIMEOUT_MS="${CORPUS_TIMEOUT_MS:-180000}"
CMD="${1:-check}"

mkdir -p "$RUNS_DIR"

flowmap() { uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py "$@"; }

regen_depcruise() {
  echo "[corpus] depcruise static graph -> $DC" >&2
  node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type json packages/*/src > "$DC"
}

# Run one scenario and copy its freshest trace to the stable path.
regen_scenario() {
  local id="$1" kind="$2" secret="$3"
  if [[ "$kind" == "live-llm" && ( "$secret" == "null" || -z "${!secret:-}" ) ]]; then
    echo "[corpus] SKIP $id (live-llm; \$$secret unset — env-gated)" >&2
    return 0
  fi
  echo "[corpus] run $id ($kind)" >&2
  pnpm --filter @firegrid/tiny-firegrid simulate:run "$id" --timeout-ms "$TIMEOUT_MS" >&2
  local latest
  latest="$(ls -dt packages/tiny-firegrid/.simulate/runs/*__"$id" 2>/dev/null | head -1)"
  if [[ -z "$latest" || ! -f "$latest/trace.jsonl" ]]; then
    echo "[corpus] ERROR: no trace produced for $id" >&2; return 1
  fi
  cp "$latest/trace.jsonl" "$RUNS_DIR/$id.jsonl"
  echo "[corpus]   -> $RUNS_DIR/$id.jsonl ($(wc -c <"$RUNS_DIR/$id.jsonl") bytes)" >&2
}

regen() {
  regen_depcruise
  local n
  n="$(jq '.scenarios | length' "$MANIFEST")"
  for i in $(seq 0 $((n-1))); do
    regen_scenario \
      "$(jq -r ".scenarios[$i].id" "$MANIFEST")" \
      "$(jq -r ".scenarios[$i].kind" "$MANIFEST")" \
      "$(jq -r ".scenarios[$i].secret_env" "$MANIFEST")"
  done
}

# Populate the global TRACES array with stable paths for in_gate scenarios
# that actually have a regenerated file (bash 3.2: no mapfile).
TRACES=()
collect_gate_traces() {
  local id f
  while read -r id; do
    f="$RUNS_DIR/$id.jsonl"
    [[ -f "$f" ]] && TRACES+=("$f")
  done < <(jq -r '.scenarios[] | select(.in_gate) | .id' "$MANIFEST")
}

[[ "${CORPUS_NO_REGEN:-0}" == "1" ]] || { [[ "$CMD" == "regen" || "$CMD" == "check" || "$CMD" == "baseline" || "$CMD" == "measure" ]] && regen; }
[[ "$CMD" == "regen" ]] && { echo "[corpus] regenerated."; exit 0; }

collect_gate_traces
[[ -f "$DC" ]] || regen_depcruise
if [[ "${#TRACES[@]}" -eq 0 ]]; then
  echo "[corpus] no gate traces present — run 'regen' first (with keys for live scenarios)." >&2
  exit 2
fi
echo "[corpus] gate traces: ${TRACES[*]}" >&2

case "$CMD" in
  baseline) flowmap "${TRACES[@]}" --depcruise="$DC" --write-baseline="$BASELINE" ;;
  check)    flowmap "${TRACES[@]}" --depcruise="$DC" --check-baseline="$BASELINE" ;;
  measure)  flowmap "${TRACES[@]}" --depcruise="$DC" --contracts --skeleton ;;
  *) echo "unknown command: $CMD (regen|check|baseline|measure)" >&2; exit 2 ;;
esac
