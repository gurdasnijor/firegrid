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
  awk "BEGIN { printf \"%.1f\", ($modeled_count / $prod_count) * 100 }"
}

coverage_ge() {
  local actual="$1"
  local minimum="$2"
  awk "BEGIN { exit !($actual >= $minimum) }"
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
    if rg -q "FiregridRuntimeHostLive" "$candidate"; then
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
  END_TO_END_ENTRY=("packages/tiny-firegrid/src" "packages/tiny-firegrid/test")
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
  TEST_CANDIDATE="packages/tiny-firegrid/test/${TARGET}.test.ts"
  if [[ -f "$TEST_CANDIDATE" ]]; then
    END_TO_END_ENTRY=("$CANDIDATE" "$TEST_CANDIDATE")
  else
    END_TO_END_ENTRY=("$CANDIDATE")
  fi
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

cat > "$OUT_DIR/coverage.json" <<EOF
{
  "target": "$TOY_LABEL",
  "productionSurfaceCount": $PROD_COUNT,
  "host_surface": {
    "totalClosureModules": $HOST_SURFACE_TOTAL,
    "productionModulesModeled": $HOST_SURFACE_MODELED,
    "productionModulesUnmodeled": $HOST_SURFACE_UNMODELED,
    "coverage": $HOST_SURFACE_COVERAGE
  },
  "end_to_end": {
    "totalClosureModules": $END_TO_END_TOTAL,
    "productionModulesModeled": $END_TO_END_MODELED,
    "productionModulesUnmodeled": $END_TO_END_UNMODELED,
    "coverage": $END_TO_END_COVERAGE
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

## Closure Semantics

- \`host_surface_closure\`: what production composition this configuration
  provides. Entry point is the configuration file only.
- \`end_to_end_closure\`: what production surface this configuration plus its
  companion scenario test exercises. Entry points are the configuration and the
  companion test when present.

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

### host_surface_closure Unmodeled By Directory

\`\`\`
$(directory_summary "$OUT_DIR/host_surface_unmodeled.json")
\`\`\`

## end_to_end_closure Unmodeled By Category

\`\`\`
$(category_summary "$OUT_DIR/end_to_end_unmodeled_by_category.txt")
\`\`\`

### end_to_end_closure Unmodeled By Directory

\`\`\`
$(directory_summary "$OUT_DIR/end_to_end_unmodeled.json")
\`\`\`

## Unmodeled Module Lists

- \`host_surface_unmodeled.json\`
- \`host_surface_unmodeled_by_category.txt\`
- \`end_to_end_unmodeled.json\`
- \`end_to_end_unmodeled_by_category.txt\`

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
echo "================================================================"
echo ""
echo "artifacts:"
echo "  $OUT_DIR/prod-modules.json"
echo "  $OUT_DIR/host_surface_modules.json"
echo "  $OUT_DIR/host_surface_unmodeled.json"
echo "  $OUT_DIR/host_surface_unmodeled_by_category.txt"
echo "  $OUT_DIR/end_to_end_modules.json"
echo "  $OUT_DIR/end_to_end_unmodeled.json"
echo "  $OUT_DIR/end_to_end_unmodeled_by_category.txt"
echo "  $OUT_DIR/coverage.json"
echo "  $OUT_DIR/summary.md"
