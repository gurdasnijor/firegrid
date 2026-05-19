#!/usr/bin/env bash
# Phase 1 — leaf-level findings inventory (ast-grep, syntactic smells only).
# Reproducible: same tree in → same JSON/MD out. Findings are INFORMATION.
#
#   pnpm analysis:leaf            # or: bash tooling/analysis/run-leaf-inventory.sh
#
# Emits the brief's finding-object JSON + a grouped Markdown summary into
# tooling/analysis/baseline/ (the committed baseline).
set -eu
RR="$(git rev-parse --show-toplevel)"
cd "$RR"
SG_CFG="tooling/ast-grep/sgconfig.yml"
OUT="tooling/analysis/baseline"
mkdir -p "$OUT"
SCOPE=(packages/host-sdk/src packages/runtime/src packages/client-sdk/src \
       packages/protocol/src packages/tiny-firegrid/src apps/factory/src)

RAW="$(pnpm -s exec ast-grep scan -c "$SG_CFG" "${SCOPE[@]}" --json 2>/dev/null || echo '[]')"
[ -n "$RAW" ] || RAW='[]'

# → the brief's finding-object shape. ast-grep ranges are 0-based; +1 for
# human 1-based lines. captures = single metavars (T/S/M/F/...).
printf '%s' "$RAW" | jq '
  [ .[] | {
      rule_id: .ruleId,
      severity: (.severity // "info"),
      path: .file,
      line_range: [ (.range.start.line + 1), (.range.end.line + 1) ],
      captures: ( (.metaVariables.single // {}) | with_entries(.value |= .text) ),
      snippet: ( (.lines // .text) | gsub("^\\s+|\\s+$";"") ),
      notes: (.note // "")
    } ]
  | sort_by(.rule_id, .path, .line_range[0])
' > "$OUT/leaf-findings.json"

N=$(jq 'length' "$OUT/leaf-findings.json")

# Markdown: per rule → totals, per-file counts, neutral prose (the rule note).
{
  echo "# Architecture Archaeology — Leaf Findings (Phase 1, ast-grep)"
  echo
  echo "_Generated $(date -u +%FT%TZ) · $N findings · syntactic inventory only._"
  echo "_Findings are **information, not defects**. No grading: the footprint is the point._"
  echo
  echo "## Totals by rule"
  echo
  echo "| rule | count | files |"
  echo "|---|--:|--:|"
  jq -r 'group_by(.rule_id)[] | "| \(.[0].rule_id) | \(length) | \([.[].path]|unique|length) |"' "$OUT/leaf-findings.json"
  echo
  jq -r '
    group_by(.rule_id)[]
    | "## " + .[0].rule_id + " (" + (length|tostring) + ")\n"
      + "\n> " + (.[0].notes | gsub("\n";" ") | gsub("  +";" ") | gsub("\\s+$";"")) + "\n"
      + "\n| file | n | lines |\n|---|--:|---|\n"
      + ( group_by(.path) | map( "| `" + .[0].path + "` | " + (length|tostring) + " | "
            + ([.[].line_range[0]|tostring] | join(", ")) + " |" ) | join("\n") )
      + "\n"
  ' "$OUT/leaf-findings.json"
} > "$OUT/leaf-findings.md"

echo "✓ $N findings → $OUT/leaf-findings.json + .md"
jq -r 'group_by(.rule_id)[] | "  \(.[0].rule_id): \(length)"' "$OUT/leaf-findings.json"
