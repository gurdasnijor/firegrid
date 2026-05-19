#!/usr/bin/env bash
# scripts/tiny-config-prod-coverage.sh
#
# Targeted coverage analysis: production surface vs a specific tiny-firegrid
# configuration (or all configurations).
#
# Usage:
#   ./scripts/tiny-config-prod-coverage.sh                              # all configurations
#   ./scripts/tiny-config-prod-coverage.sh dispatcher-driven-pipeline   # one configuration
#   ./scripts/tiny-config-prod-coverage.sh wait-for-output              # .ts suffix optional
#   ./scripts/tiny-config-prod-coverage.sh --check                      # CI gate
#
# Output:
#   - tmp/toy-coverage/<target>/host_surface_modules.json
#   - tmp/toy-coverage/<target>/host_surface_unmodeled.json
#   - tmp/toy-coverage/<target>/host_surface_unmodeled_by_category.txt
#   - tmp/toy-coverage/<target>/end_to_end_modules.json
#   - tmp/toy-coverage/<target>/end_to_end_unmodeled.json
#   - tmp/toy-coverage/<target>/end_to_end_unmodeled_by_category.txt
#   - tmp/toy-coverage/<target>/host_surface_direct_touchpoints.json
#   - tmp/toy-coverage/<target>/host_surface_shared_touchpoint_spine.json
#   - tmp/toy-coverage/<target>/host_surface_outside_spine_touchpoint_denominator.json
#   - tmp/toy-coverage/<target>/host_surface_touchpoint_delta_modules.json
#   - tmp/toy-coverage/<target>/host_surface_touchpoint_delta_unmodeled.json
#   - tmp/toy-coverage/<target>/host_surface_touchpoint_delta_unmodeled_by_category.txt
#   - tmp/toy-coverage/<target>/end_to_end_direct_touchpoints.json
#   - tmp/toy-coverage/<target>/end_to_end_shared_touchpoint_spine.json
#   - tmp/toy-coverage/<target>/end_to_end_outside_spine_touchpoint_denominator.json
#   - tmp/toy-coverage/<target>/end_to_end_touchpoint_delta_modules.json
#   - tmp/toy-coverage/<target>/end_to_end_touchpoint_delta_unmodeled.json
#   - tmp/toy-coverage/<target>/end_to_end_touchpoint_delta_unmodeled_by_category.txt
#   - tmp/toy-coverage/<target>/prod-modules.json
#   - tmp/toy-coverage/<target>/summary.md
#
# Read-only. Writes to tmp/ only.

set -euo pipefail

# ---- args ----
CHECK=false
TARGET="all"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "${1:-}" == "--check" ]]; then
  CHECK=true
  TARGET="${2:-all}"
else
  TARGET="${1:-all}"
fi
TARGET="${TARGET%.ts}"  # strip optional .ts suffix

# ---- paths ----
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

OUT_DIR="tmp/toy-coverage/${TARGET}"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.json "$OUT_DIR"/*.txt "$OUT_DIR"/summary.md

# ---- helpers ----
cruise_modules() {
  local output="$1"
  shift
  pnpm exec depcruise \
    --ts-pre-compilation-deps \
    --include-only "^packages/" \
    --exclude "node_modules" \
    --output-type json \
    "$@" \
    | jq '[.modules[].source] | sort | unique' \
    > "$output"
}

modeled_modules() {
  local closure="$1"
  local output="$2"
  jq -n \
    --slurpfile prod "$OUT_DIR/prod-modules.json" \
    --slurpfile closure "$closure" \
    '[ $prod[0][] as $module | select($closure[0] | index($module)) | $module ]' \
    > "$output"
}

unmodeled_modules() {
  local closure="$1"
  local output="$2"
  jq -n \
    --slurpfile prod "$OUT_DIR/prod-modules.json" \
    --slurpfile closure "$closure" \
    '$prod[0] - $closure[0]' \
    > "$output"
}

coverage_pct() {
  local modeled_count="$1"
  local prod_count="$2"
  awk -v modeled="$modeled_count" -v total="$prod_count" 'BEGIN {
    if (total == "" || total == 0) {
      printf "0.0"
    } else {
      printf "%.1f", (modeled / total) * 100
    }
  }'
}

coverage_ge() {
  local actual="$1"
  local minimum="$2"
  awk -v actual="$actual" -v minimum="$minimum" 'BEGIN { exit !(actual >= minimum) }'
}

categorize_unmodeled() {
  local input="$1"
  local output="$2"
  jq -r '.[]' "$input" \
    | awk '
      function category(path) {
        if (path ~ /^packages\/effect-durable-operators\/src\/react\.ts$/ ||
            path ~ /^packages\/runtime\/src\/verified-webhook-ingest\//) {
          return "orthogonal_production_surfaces"
        }
        if (path ~ /^packages\/[^\/]+\/src\/index\.ts$/ ||
            path ~ /^packages\/protocol\/src\/operations\/index\.ts$/ ||
            path ~ /^packages\/protocol\/src\/session-facade\/index\.ts$/ ||
            path ~ /^packages\/runtime\/src\/agent-adapters\/index\.ts$/ ||
            path ~ /^packages\/host-sdk\/src\/host\/types\.ts$/ ||
            path ~ /^packages\/runtime\/src\/agent-event-pipeline\/sources\/byte-stream\.ts$/) {
          return "coverage_tool_artifacts"
        }
        if (path ~ /^packages\/runtime\/src\/agent-adapters\// ||
            path ~ /^packages\/client-sdk\/src\// ||
            path ~ /^packages\/protocol\/src\/session-facade\//) {
          return "future_config_targets"
        }
        if (path ~ /^packages\/runtime\/src\/workflow-engine\/internal\/codec\.ts$/) {
          return "production_cleanup"
        }
        if (path ~ /^packages\/runtime\/src\/agent-event-pipeline\/codecs\/acp\/mapping\.ts$/) {
          return "tooling_correctness"
        }
        return "genuinely_uncategorized"
      }
      {
        print category($0) "\t" $0
      }
    ' \
    | sort \
    > "$output"
}

category_summary() {
  local input="$1"
  awk -F'\t' '{ counts[$1]++ } END { for (category in counts) print counts[category], category }' "$input" \
    | sort -rn
}

directory_summary() {
  local input="$1"
  jq -r '.[]' "$input" \
    | awk -F'/' '{
        pkg=$2
        if ($3 == "src") {
          if (NF >= 5) { print pkg "/" $4 }
          else         { print pkg "/<root>" }
        } else {
          print pkg "/" $3
        }
      }' \
    | sort \
    | uniq -c \
    | sort -rn
}

json_intersection() {
  local left="$1"
  local right="$2"
  local output="$3"
  jq -n \
    --slurpfile left "$left" \
    --slurpfile right "$right" \
    '[ $left[0][] as $module | select($right[0] | index($module)) | $module ]' \
    > "$output"
}

json_subtract() {
  local left="$1"
  local right="$2"
  local output="$3"
  jq -n \
    --slurpfile left "$left" \
    --slurpfile right "$right" \
    '$left[0] - $right[0]' \
    > "$output"
}

json_union() {
  local left="$1"
  local right="$2"
  local output="$3"
  jq -n \
    --slurpfile left "$left" \
    --slurpfile right "$right" \
    '($left[0] + $right[0]) | sort | unique' \
    > "$output"
}

direct_touchpoints() {
  local output="$1"
  shift
  pnpm exec depcruise \
    --ts-pre-compilation-deps \
    --include-only "^packages/" \
    --exclude "node_modules" \
    --output-type json \
    "$@" \
    | jq '[.modules[]
      | select(.source | startswith("packages/tiny-firegrid/"))
      | .dependencies[]?.resolved
      | select(test("^packages/(protocol|runtime|host-sdk|client-sdk|effect-durable-operators)/"))
    ] | sort | unique' \
    > "$output"
}

production_config_files() {
  for candidate in packages/tiny-firegrid/src/configurations/*.ts; do
    if grep -q "FiregridRuntimeHostLive" "$candidate"; then
      printf '%s\n' "$candidate"
    fi
  done | sort
}

end_to_end_entries_for_config() {
  local candidate="$1"
  printf '%s\n' "$candidate"
}

compute_production_consuming_touchpoint_sets() {
  local output="$1"
  local mode="$2"
  local operation="$3"
  local scratch_dir="$OUT_DIR/_touchpoint_${mode}_${operation}"
  rm -rf "$scratch_dir"
  mkdir -p "$scratch_dir"

  local initialized=false
  local work="$scratch_dir/work.json"

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    local name
    name="$(basename "$candidate" .ts)"
    local touchpoints="$scratch_dir/${name}.json"

    if [[ "$mode" == "host_surface" ]]; then
      direct_touchpoints "$touchpoints" "$candidate"
    else
      local entries=()
      while IFS= read -r entry; do
        entries+=("$entry")
      done < <(end_to_end_entries_for_config "$candidate")
      direct_touchpoints "$touchpoints" "${entries[@]}"
    fi

    if [[ "$initialized" == false ]]; then
      cp "$touchpoints" "$work"
      initialized=true
    elif [[ "$operation" == "intersection" ]]; then
      json_intersection "$work" "$touchpoints" "$scratch_dir/next.json"
      mv "$scratch_dir/next.json" "$work"
    else
      json_union "$work" "$touchpoints" "$scratch_dir/next.json"
      mv "$scratch_dir/next.json" "$work"
    fi
  done < <(production_config_files)

  if [[ "$initialized" == false ]]; then
    printf '[]\n' > "$output"
  else
    cp "$work" "$output"
  fi
  rm -rf "$scratch_dir"
}

# ---- check all canonical configurations ----
if [[ "$CHECK" == true && "$TARGET" == "all" ]]; then
  MIN_HOST_SURFACE="${TOY_COVERAGE_MIN_HOST_SURFACE:-20.0}"
  MIN_END_TO_END="${TOY_COVERAGE_MIN_END_TO_END:-20.0}"
  MIN_PRODUCTION_HOST_SURFACE="${TOY_COVERAGE_MIN_PRODUCTION_HOST_SURFACE:-75.0}"
  MIN_PRODUCTION_END_TO_END="${TOY_COVERAGE_MIN_PRODUCTION_END_TO_END:-80.0}"
  failed=false
  echo "==> checking tiny-firegrid canonical configuration coverage"
  echo "    base thresholds:       host_surface >= ${MIN_HOST_SURFACE}%, end_to_end >= ${MIN_END_TO_END}%"
  echo "    production thresholds: host_surface >= ${MIN_PRODUCTION_HOST_SURFACE}%, end_to_end >= ${MIN_PRODUCTION_END_TO_END}%"
  echo "    scanned: packages/tiny-firegrid/src/configurations/*.ts"
  echo "    scratch/experimental configurations should live outside src/configurations/"
  echo ""
  for candidate in packages/tiny-firegrid/src/configurations/*.ts; do
    name="$(basename "$candidate" .ts)"
    output="$(bash "$0" "$name")"
    echo "$output" | tail -n 4
    host_surface="$(jq -r '.host_surface.coverage' "tmp/toy-coverage/${name}/coverage.json")"
    end_to_end="$(jq -r '.end_to_end.coverage' "tmp/toy-coverage/${name}/coverage.json")"
    host_min="$MIN_HOST_SURFACE"
    end_min="$MIN_END_TO_END"
    tier="base"
    if grep -q "FiregridRuntimeHostLive" "$candidate"; then
      host_min="$MIN_PRODUCTION_HOST_SURFACE"
      end_min="$MIN_PRODUCTION_END_TO_END"
      tier="production"
    fi
    if ! coverage_ge "$host_surface" "$host_min" || ! coverage_ge "$end_to_end" "$end_min"; then
      echo "FAIL ${name}: ${tier} coverage host_surface=${host_surface}% (min ${host_min}%), end_to_end=${end_to_end}% (min ${end_min}%)"
      failed=true
    else
      echo "PASS ${name}: ${tier} coverage host_surface=${host_surface}%, end_to_end=${end_to_end}%"
    fi
    echo ""
  done
  if [[ "$failed" == true ]]; then
    echo "tiny-firegrid coverage check failed" >&2
    exit 1
  fi
  echo "tiny-firegrid coverage check passed"
  exit 0
fi

# ---- resolve entry points ----
if [[ "$TARGET" == "all" ]]; then
  HOST_SURFACE_ENTRY="packages/tiny-firegrid/src"
  END_TO_END_ENTRY=("packages/tiny-firegrid/src")
  TOY_LABEL="all configurations"
else
  CANDIDATE="packages/tiny-firegrid/src/configurations/${TARGET}.ts"
  if [[ ! -f "$CANDIDATE" ]]; then
    echo "error: configuration not found at $CANDIDATE" >&2
    echo "" >&2
    echo "available configurations:" >&2
    ls packages/tiny-firegrid/src/configurations/*.ts \
      | xargs -n1 basename \
      | sed 's/\.ts$//' \
      | sed 's/^/  /' >&2
    exit 1
  fi
  HOST_SURFACE_ENTRY="$CANDIDATE"
  END_TO_END_ENTRY=("$CANDIDATE")
  TOY_LABEL="$TARGET"
fi

echo "==> analyzing: $TOY_LABEL"
echo "==> host surface entry: ${HOST_SURFACE_ENTRY}"
echo "==> end-to-end entry:   ${END_TO_END_ENTRY[*]}"
echo "==> output:    $OUT_DIR/"
echo ""

# ---- production surface ----
echo "==> computing production surface..."
pnpm exec depcruise \
  --ts-pre-compilation-deps \
  --include-only "^packages/(protocol|runtime|host-sdk|client-sdk|effect-durable-operators)/" \
  --exclude "test|__tests__|node_modules" \
  --output-type json \
  packages/protocol/src \
  packages/runtime/src \
  packages/host-sdk/src \
  packages/client-sdk/src \
  packages/effect-durable-operators/src \
  | jq '[.modules[].source] | sort | unique' \
  > "$OUT_DIR/prod-modules.json"

PROD_COUNT=$(jq 'length' "$OUT_DIR/prod-modules.json")
echo "    $PROD_COUNT modules in production surface"

# ---- closures ----
echo "==> computing host_surface_closure..."
cruise_modules "$OUT_DIR/host_surface_modules.json" "$HOST_SURFACE_ENTRY"
modeled_modules "$OUT_DIR/host_surface_modules.json" "$OUT_DIR/host_surface_modeled.json"
unmodeled_modules "$OUT_DIR/host_surface_modules.json" "$OUT_DIR/host_surface_unmodeled.json"
categorize_unmodeled "$OUT_DIR/host_surface_unmodeled.json" "$OUT_DIR/host_surface_unmodeled_by_category.txt"

HOST_SURFACE_TOTAL=$(jq 'length' "$OUT_DIR/host_surface_modules.json")
HOST_SURFACE_MODELED=$(jq 'length' "$OUT_DIR/host_surface_modeled.json")
HOST_SURFACE_UNMODELED=$(jq 'length' "$OUT_DIR/host_surface_unmodeled.json")
HOST_SURFACE_COVERAGE=$(coverage_pct "$HOST_SURFACE_MODELED" "$PROD_COUNT")
echo "    $HOST_SURFACE_TOTAL modules in closure"
echo "    $HOST_SURFACE_MODELED production modules modeled"
echo "    $HOST_SURFACE_UNMODELED production modules unmodeled"

echo "==> computing end_to_end_closure..."
cruise_modules "$OUT_DIR/end_to_end_modules.json" "${END_TO_END_ENTRY[@]}"
modeled_modules "$OUT_DIR/end_to_end_modules.json" "$OUT_DIR/end_to_end_modeled.json"
unmodeled_modules "$OUT_DIR/end_to_end_modules.json" "$OUT_DIR/end_to_end_unmodeled.json"
categorize_unmodeled "$OUT_DIR/end_to_end_unmodeled.json" "$OUT_DIR/end_to_end_unmodeled_by_category.txt"

END_TO_END_TOTAL=$(jq 'length' "$OUT_DIR/end_to_end_modules.json")
END_TO_END_MODELED=$(jq 'length' "$OUT_DIR/end_to_end_modeled.json")
END_TO_END_UNMODELED=$(jq 'length' "$OUT_DIR/end_to_end_unmodeled.json")
END_TO_END_COVERAGE=$(coverage_pct "$END_TO_END_MODELED" "$PROD_COUNT")
echo "    $END_TO_END_TOTAL modules in closure"
echo "    $END_TO_END_MODELED production modules modeled"
echo "    $END_TO_END_UNMODELED production modules unmodeled"
echo ""

echo "==> host_surface_closure unmodeled by category..."
category_summary "$OUT_DIR/host_surface_unmodeled_by_category.txt"
echo ""
echo "==> end_to_end_closure unmodeled by category..."
category_summary "$OUT_DIR/end_to_end_unmodeled_by_category.txt"
echo ""

echo "==> computing direct production touchpoint delta..."
direct_touchpoints "$OUT_DIR/host_surface_direct_touchpoints.json" "$HOST_SURFACE_ENTRY"
direct_touchpoints "$OUT_DIR/end_to_end_direct_touchpoints.json" "${END_TO_END_ENTRY[@]}"

compute_production_consuming_touchpoint_sets \
  "$OUT_DIR/host_surface_shared_touchpoint_spine.json" \
  "host_surface" \
  "intersection"
compute_production_consuming_touchpoint_sets \
  "$OUT_DIR/host_surface_touchpoint_denominator.json" \
  "host_surface" \
  "union"
compute_production_consuming_touchpoint_sets \
  "$OUT_DIR/end_to_end_shared_touchpoint_spine.json" \
  "end_to_end" \
  "intersection"
compute_production_consuming_touchpoint_sets \
  "$OUT_DIR/end_to_end_touchpoint_denominator.json" \
  "end_to_end" \
  "union"

json_subtract "$OUT_DIR/host_surface_touchpoint_denominator.json" \
  "$OUT_DIR/host_surface_shared_touchpoint_spine.json" \
  "$OUT_DIR/host_surface_outside_spine_touchpoint_denominator.json"
json_subtract "$OUT_DIR/host_surface_direct_touchpoints.json" \
  "$OUT_DIR/host_surface_shared_touchpoint_spine.json" \
  "$OUT_DIR/host_surface_touchpoint_delta_modules.json"
json_subtract "$OUT_DIR/host_surface_outside_spine_touchpoint_denominator.json" \
  "$OUT_DIR/host_surface_touchpoint_delta_modules.json" \
  "$OUT_DIR/host_surface_touchpoint_delta_unmodeled.json"
categorize_unmodeled \
  "$OUT_DIR/host_surface_touchpoint_delta_unmodeled.json" \
  "$OUT_DIR/host_surface_touchpoint_delta_unmodeled_by_category.txt"

json_subtract "$OUT_DIR/end_to_end_touchpoint_denominator.json" \
  "$OUT_DIR/end_to_end_shared_touchpoint_spine.json" \
  "$OUT_DIR/end_to_end_outside_spine_touchpoint_denominator.json"
json_subtract "$OUT_DIR/end_to_end_direct_touchpoints.json" \
  "$OUT_DIR/end_to_end_shared_touchpoint_spine.json" \
  "$OUT_DIR/end_to_end_touchpoint_delta_modules.json"
json_subtract "$OUT_DIR/end_to_end_outside_spine_touchpoint_denominator.json" \
  "$OUT_DIR/end_to_end_touchpoint_delta_modules.json" \
  "$OUT_DIR/end_to_end_touchpoint_delta_unmodeled.json"
categorize_unmodeled \
  "$OUT_DIR/end_to_end_touchpoint_delta_unmodeled.json" \
  "$OUT_DIR/end_to_end_touchpoint_delta_unmodeled_by_category.txt"

HOST_SURFACE_SPINE_COUNT=$(jq 'length' "$OUT_DIR/host_surface_shared_touchpoint_spine.json")
HOST_SURFACE_TOUCHPOINT_DENOMINATOR=$(jq 'length' "$OUT_DIR/host_surface_outside_spine_touchpoint_denominator.json")
HOST_SURFACE_SCENARIO_DELTA=$(jq 'length' "$OUT_DIR/host_surface_touchpoint_delta_modules.json")
HOST_SURFACE_TOUCHPOINT_UNMODELED=$(jq 'length' "$OUT_DIR/host_surface_touchpoint_delta_unmodeled.json")
HOST_SURFACE_TOUCHPOINT_COVERAGE=$(coverage_pct "$HOST_SURFACE_SCENARIO_DELTA" "$HOST_SURFACE_TOUCHPOINT_DENOMINATOR")

END_TO_END_SPINE_COUNT=$(jq 'length' "$OUT_DIR/end_to_end_shared_touchpoint_spine.json")
END_TO_END_TOUCHPOINT_DENOMINATOR=$(jq 'length' "$OUT_DIR/end_to_end_outside_spine_touchpoint_denominator.json")
END_TO_END_SCENARIO_DELTA=$(jq 'length' "$OUT_DIR/end_to_end_touchpoint_delta_modules.json")
END_TO_END_TOUCHPOINT_UNMODELED=$(jq 'length' "$OUT_DIR/end_to_end_touchpoint_delta_unmodeled.json")
END_TO_END_TOUCHPOINT_COVERAGE=$(coverage_pct "$END_TO_END_SCENARIO_DELTA" "$END_TO_END_TOUCHPOINT_DENOMINATOR")

echo "    host_surface shared touchpoint spine: $HOST_SURFACE_SPINE_COUNT modules"
echo "    host_surface touchpoint delta: $HOST_SURFACE_SCENARIO_DELTA modeled / $HOST_SURFACE_TOUCHPOINT_UNMODELED unmodeled (${HOST_SURFACE_TOUCHPOINT_COVERAGE}%)"
echo "    end_to_end shared touchpoint spine: $END_TO_END_SPINE_COUNT modules"
echo "    end_to_end touchpoint delta: $END_TO_END_SCENARIO_DELTA modeled / $END_TO_END_TOUCHPOINT_UNMODELED unmodeled (${END_TO_END_TOUCHPOINT_COVERAGE}%)"
echo ""

cat > "$OUT_DIR/coverage.json" <<EOF
{
  "target": "$TOY_LABEL",
  "productionSurfaceCount": $PROD_COUNT,
  "host_surface": {
    "totalClosureModules": $HOST_SURFACE_TOTAL,
    "productionModulesModeled": $HOST_SURFACE_MODELED,
    "productionModulesUnmodeled": $HOST_SURFACE_UNMODELED,
    "coverage": $HOST_SURFACE_COVERAGE,
    "sharedTouchpointSpineModules": $HOST_SURFACE_SPINE_COUNT,
    "outsideSpineTouchpointDenominator": $HOST_SURFACE_TOUCHPOINT_DENOMINATOR,
    "touchpointDeltaModules": $HOST_SURFACE_SCENARIO_DELTA,
    "touchpointDeltaUnmodeledModules": $HOST_SURFACE_TOUCHPOINT_UNMODELED,
    "touchpointDeltaCoverage": $HOST_SURFACE_TOUCHPOINT_COVERAGE
  },
  "end_to_end": {
    "totalClosureModules": $END_TO_END_TOTAL,
    "productionModulesModeled": $END_TO_END_MODELED,
    "productionModulesUnmodeled": $END_TO_END_UNMODELED,
    "coverage": $END_TO_END_COVERAGE,
    "sharedTouchpointSpineModules": $END_TO_END_SPINE_COUNT,
    "outsideSpineTouchpointDenominator": $END_TO_END_TOUCHPOINT_DENOMINATOR,
    "touchpointDeltaModules": $END_TO_END_SCENARIO_DELTA,
    "touchpointDeltaUnmodeledModules": $END_TO_END_TOUCHPOINT_UNMODELED,
    "touchpointDeltaCoverage": $END_TO_END_TOUCHPOINT_COVERAGE
  }
}
EOF

# ---- summary ----
DATE=$(date +%Y-%m-%d)
cat > "$OUT_DIR/summary.md" <<EOF
# Coverage analysis: $TOY_LABEL

Date: $DATE
Target: \`$TOY_LABEL\`
Host surface entry: \`${HOST_SURFACE_ENTRY}\`
End-to-end entry: \`${END_TO_END_ENTRY[*]}\`

## Counts

The denominator is the production surface under \`packages/protocol\`,
\`packages/runtime\`, \`packages/host-sdk\`, \`packages/client-sdk\`, and
\`packages/effect-durable-operators\`.

| closure | total closure modules | production modules modeled | production modules unmodeled | coverage |
|---|---:|---:|---:|---:|
| production surface | n/a | $PROD_COUNT | n/a | n/a |
| host_surface_closure | $HOST_SURFACE_TOTAL | $HOST_SURFACE_MODELED | $HOST_SURFACE_UNMODELED | ${HOST_SURFACE_COVERAGE}% |
| end_to_end_closure | $END_TO_END_TOTAL | $END_TO_END_MODELED | $END_TO_END_UNMODELED | ${END_TO_END_COVERAGE}% |

## Direct Touchpoint Delta

The gross production-surface denominator above is intentionally retained as a
coarse guardrail. Production-consuming configs also import a large shared
host/client spine, so this report computes a scenario-specific direct
touchpoint denominator:

1. find every configuration under \`src/configurations/\` that imports
   \`FiregridRuntimeHostLive\`;
2. compute the first-order production modules imported directly by each
   configuration from \`packages/tiny-firegrid\`;
3. intersect those direct touchpoint sets to get the shared host/client spine;
4. union those direct touchpoint sets to get the known production-consuming
   touchpoint denominator;
5. subtract the shared spine from both the target touchpoints and the
   denominator.

\`touchpoint_delta_modules\` is therefore "what this configuration names beyond
the shared production-consuming spine." \`touchpoint_delta_coverage\` is that
delta over all currently-known production-consuming touchpoints after removing
the shared spine. This metric is not a replacement for runtime assertions; it
is a sharper static signal than the transitive closure when the transitive
closure has collapsed to the shared host/client graph.

| closure | shared touchpoint spine | touchpoint denominator | touchpoint delta modules | touchpoint delta unmodeled | touchpoint delta coverage |
|---|---:|---:|---:|---:|---:|
| host_surface_closure | $HOST_SURFACE_SPINE_COUNT | $HOST_SURFACE_TOUCHPOINT_DENOMINATOR | $HOST_SURFACE_SCENARIO_DELTA | $HOST_SURFACE_TOUCHPOINT_UNMODELED | ${HOST_SURFACE_TOUCHPOINT_COVERAGE}% |
| end_to_end_closure | $END_TO_END_SPINE_COUNT | $END_TO_END_TOUCHPOINT_DENOMINATOR | $END_TO_END_SCENARIO_DELTA | $END_TO_END_TOUCHPOINT_UNMODELED | ${END_TO_END_TOUCHPOINT_COVERAGE}% |

## Closure Semantics

- \`host_surface_closure\`: what production composition this configuration
  provides. Entry point is the configuration file only.
- \`end_to_end_closure\`: what production surface this configuration exercises.
  Entry point is the configuration file only.

## Tooling Correctness

This script uses \`dependency-cruiser --ts-pre-compilation-deps\`. Without that
flag, dependency-cruiser misses some real TypeScript value imports after
compilation, including \`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts\`
→ \`./mapping.ts\`. Coverage numbers without pre-compilation deps are not
reliable for this repository.

## host_surface_closure Unmodeled By Category

\`\`\`
$(category_summary "$OUT_DIR/host_surface_unmodeled_by_category.txt")
\`\`\`

## host_surface_closure Touchpoint Delta Unmodeled By Category

\`\`\`
$(category_summary "$OUT_DIR/host_surface_touchpoint_delta_unmodeled_by_category.txt")
\`\`\`

### host_surface_closure Unmodeled By Directory

\`\`\`
$(directory_summary "$OUT_DIR/host_surface_unmodeled.json")
\`\`\`

## end_to_end_closure Unmodeled By Category

\`\`\`
$(category_summary "$OUT_DIR/end_to_end_unmodeled_by_category.txt")
\`\`\`

## end_to_end_closure Touchpoint Delta Unmodeled By Category

\`\`\`
$(category_summary "$OUT_DIR/end_to_end_touchpoint_delta_unmodeled_by_category.txt")
\`\`\`

### end_to_end_closure Unmodeled By Directory

\`\`\`
$(directory_summary "$OUT_DIR/end_to_end_unmodeled.json")
\`\`\`

## Unmodeled Module Lists

- \`host_surface_unmodeled.json\`
- \`host_surface_unmodeled_by_category.txt\`
- \`host_surface_direct_touchpoints.json\`
- \`host_surface_shared_touchpoint_spine.json\`
- \`host_surface_outside_spine_touchpoint_denominator.json\`
- \`host_surface_touchpoint_delta_modules.json\`
- \`host_surface_touchpoint_delta_unmodeled.json\`
- \`host_surface_touchpoint_delta_unmodeled_by_category.txt\`
- \`end_to_end_unmodeled.json\`
- \`end_to_end_unmodeled_by_category.txt\`
- \`end_to_end_direct_touchpoints.json\`
- \`end_to_end_shared_touchpoint_spine.json\`
- \`end_to_end_outside_spine_touchpoint_denominator.json\`
- \`end_to_end_touchpoint_delta_modules.json\`
- \`end_to_end_touchpoint_delta_unmodeled.json\`
- \`end_to_end_touchpoint_delta_unmodeled_by_category.txt\`

## Framing for the write-up

Treat category buckets differently:

- \`coverage_tool_artifacts\`: barrels and type-only boundaries. Not gaps.
- \`orthogonal_production_surfaces\`: production surfaces outside the runtime
  spine for this config. Exclude per config or through a future outside-spine
  denominator.
- \`future_config_targets\`: good candidates for later configurations, not
  failures of this one.
- \`production_cleanup\`: known or likely dead/vestigial production code.
- \`tooling_correctness\`: report-generation issues to fix before trusting the
  number.
- \`genuinely_uncategorized\`: inspect manually.

## Output

Write the full analysis to \`docs/research/tiny-firegrid-coverage-${TARGET}-${DATE}.md\`.
EOF

# ---- final report ----
echo "================================================================"
echo "  target:                 $TOY_LABEL"
echo "  prod:                   $PROD_COUNT modules"
echo "  host_surface_closure:   $HOST_SURFACE_MODELED modeled / $HOST_SURFACE_UNMODELED unmodeled (${HOST_SURFACE_COVERAGE}%)"
echo "  end_to_end_closure:     $END_TO_END_MODELED modeled / $END_TO_END_UNMODELED unmodeled (${END_TO_END_COVERAGE}%)"
echo "  host_surface_delta:     $HOST_SURFACE_SCENARIO_DELTA direct touchpoints outside shared spine / $HOST_SURFACE_TOUCHPOINT_DENOMINATOR touchpoint denominator (${HOST_SURFACE_TOUCHPOINT_COVERAGE}%)"
echo "  end_to_end_delta:       $END_TO_END_SCENARIO_DELTA direct touchpoints outside shared spine / $END_TO_END_TOUCHPOINT_DENOMINATOR touchpoint denominator (${END_TO_END_TOUCHPOINT_COVERAGE}%)"
echo "================================================================"
echo ""
echo "artifacts:"
echo "  $OUT_DIR/prod-modules.json"
echo "  $OUT_DIR/host_surface_modules.json"
echo "  $OUT_DIR/host_surface_unmodeled.json"
echo "  $OUT_DIR/host_surface_unmodeled_by_category.txt"
echo "  $OUT_DIR/host_surface_direct_touchpoints.json"
echo "  $OUT_DIR/host_surface_shared_touchpoint_spine.json"
echo "  $OUT_DIR/host_surface_outside_spine_touchpoint_denominator.json"
echo "  $OUT_DIR/host_surface_touchpoint_delta_modules.json"
echo "  $OUT_DIR/host_surface_touchpoint_delta_unmodeled.json"
echo "  $OUT_DIR/host_surface_touchpoint_delta_unmodeled_by_category.txt"
echo "  $OUT_DIR/end_to_end_modules.json"
echo "  $OUT_DIR/end_to_end_unmodeled.json"
echo "  $OUT_DIR/end_to_end_unmodeled_by_category.txt"
echo "  $OUT_DIR/end_to_end_direct_touchpoints.json"
echo "  $OUT_DIR/end_to_end_shared_touchpoint_spine.json"
echo "  $OUT_DIR/end_to_end_outside_spine_touchpoint_denominator.json"
echo "  $OUT_DIR/end_to_end_touchpoint_delta_modules.json"
echo "  $OUT_DIR/end_to_end_touchpoint_delta_unmodeled.json"
echo "  $OUT_DIR/end_to_end_touchpoint_delta_unmodeled_by_category.txt"
echo "  $OUT_DIR/coverage.json"
echo "  $OUT_DIR/summary.md"
