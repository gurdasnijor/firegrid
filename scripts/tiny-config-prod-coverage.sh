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
#
# Output:
#   - tmp/toy-coverage/<target>/toy-modules.json       (toy closure)
#   - tmp/toy-coverage/<target>/prod-modules.json      (full prod surface)
#   - tmp/toy-coverage/<target>/unmodeled.json         (prod - toy)
#   - tmp/toy-coverage/<target>/grouped.txt            (unmodeled by directory)
#   - tmp/toy-coverage/<target>/summary.md             (counts + framing)
#
# Read-only. Writes to tmp/ only.

set -euo pipefail

# ---- args ----
TARGET="${1:-all}"
TARGET="${TARGET%.ts}"  # strip optional .ts suffix

# ---- paths ----
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

OUT_DIR="tmp/toy-coverage/${TARGET}"
mkdir -p "$OUT_DIR"

# ---- resolve toy entry point ----
if [[ "$TARGET" == "all" ]]; then
  TOY_ENTRY="packages/tiny-firegrid/src"
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
  TOY_ENTRY="$CANDIDATE"
  TOY_LABEL="$TARGET"
fi

echo "==> analyzing: $TOY_LABEL"
echo "==> entry:     $TOY_ENTRY"
echo "==> output:    $OUT_DIR/"
echo ""

# ---- toy closure ----
echo "==> computing toy closure..."
pnpm exec depcruise \
  --include-only "^packages/" \
  --exclude "test|__tests__|node_modules" \
  --output-type json \
  "$TOY_ENTRY" \
  | jq '[.modules[].source] | sort | unique' \
  > "$OUT_DIR/toy-modules.json"

TOY_COUNT=$(jq 'length' "$OUT_DIR/toy-modules.json")
echo "    $TOY_COUNT modules in toy closure"

# ---- production surface ----
echo "==> computing production surface..."
pnpm exec depcruise \
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

# ---- diff ----
echo "==> computing unmodeled set..."
jq -n \
  --slurpfile prod "$OUT_DIR/prod-modules.json" \
  --slurpfile toy "$OUT_DIR/toy-modules.json" \
  '$prod[0] - $toy[0]' \
  > "$OUT_DIR/unmodeled.json"

UNMODELED_COUNT=$(jq 'length' "$OUT_DIR/unmodeled.json")
COVERAGE_PCT=$(awk "BEGIN { printf \"%.1f\", ($TOY_COUNT / $PROD_COUNT) * 100 }")
echo "    $UNMODELED_COUNT modules unmodeled"
echo ""

# ---- grouped view ----
echo "==> grouping unmodeled by directory..."
jq -r '.[]' "$OUT_DIR/unmodeled.json" \
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
  | sort -rn \
  > "$OUT_DIR/grouped.txt"

cat "$OUT_DIR/grouped.txt"
echo ""

# ---- summary ----
DATE=$(date +%Y-%m-%d)
cat > "$OUT_DIR/summary.md" <<EOF
# Coverage analysis: $TOY_LABEL

Date: $DATE
Target: \`$TOY_LABEL\`
Entry: \`$TOY_ENTRY\`

## Counts

| | count |
|---|---|
| toy closure | $TOY_COUNT |
| production surface | $PROD_COUNT |
| unmodeled | $UNMODELED_COUNT |
| coverage | ${COVERAGE_PCT}% |

## Unmodeled, grouped by package/concern

\`\`\`
$(cat "$OUT_DIR/grouped.txt")
\`\`\`

## Unmodeled module list

See \`unmodeled.json\` in this directory for the full list.

## Framing for the write-up

For each group above:

1. **What it is.** Read the actual files. Don't guess from names.
2. **Why the toy doesn't reach it.** One of:
   - Toy reimplements minimally (toy has its own version of the boundary)
   - Toy uses a higher-level abstraction (boundary is hidden behind something the toy does reach)
   - Genuinely orthogonal (not part of the toy's current scope)
   - Internal machinery (toy's public-boundaries discipline forbids reaching it)
3. **Value of closing the gap.** High / Medium / Low, against current open questions:
   - A4 fix (wait-router context-awareness)
   - Cycle 1 (producer-side AEP)
   - Shape C step 2 (durable-tools convergence)
   - Codec-direct-deferred (where permission events live)
   - Agent-adapter integration (AI provider integration point)
   - Host-surface definition (FiregridHost union type)
4. **Recommendation.** Model next / model eventually / don't model / investigate further.

## Output

Write the full analysis to \`docs/research/tiny-firegrid-coverage-${TARGET}-${DATE}.md\`.
EOF

# ---- final report ----
echo "================================================================"
echo "  target:     $TOY_LABEL"
echo "  toy:        $TOY_COUNT modules"
echo "  prod:       $PROD_COUNT modules"
echo "  unmodeled:  $UNMODELED_COUNT modules"
echo "  coverage:   ${COVERAGE_PCT}%"
echo "================================================================"
echo ""
echo "artifacts:"
echo "  $OUT_DIR/toy-modules.json"
echo "  $OUT_DIR/prod-modules.json"
echo "  $OUT_DIR/unmodeled.json"
echo "  $OUT_DIR/grouped.txt"
echo "  $OUT_DIR/summary.md"
