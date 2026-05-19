#!/usr/bin/env bash
#
# signoff-queue.sh — the decisioner's drain queue, STRUCTURED.
#
# A decision is not parsed out of prose. It is structured beads state:
#   - awaiting a ruling : label `signoff:pending` + status open/in_progress
#   - where to read     : the bead's `external_ref` (one URL — the PR/SDD)
#   - what it gates      : real `blocks` dependency edges (the graph)
#   - the verdict        : `br close <id> --reason "<verdict>"`  ← the ONLY
#                          close. It records the verdict structurally AND the
#                          dependency graph auto-unblocks every dependent.
#                          There is no "remove a label" step that fails to
#                          propagate — the gate IS the edge.
#
# This tool only READS structured fields (labels, status, external_ref,
# dependencies, priority) + `bv` rank. No markdown is parsed. It never
# mutates beads — it prints the exact `br close` for you to run.
#
# Usage:
#   bash scripts/signoff-queue.sh            # ranked digest
#   bash scripts/signoff-queue.sh --json     # structured
#   bash scripts/signoff-queue.sh show <tf-id|TFIND-NNN|#PR>   # one item, full
#
# Ranking (NOT raw bv order — bv marginal under-weights a transitive keystone):
#   keystone label → in bv blockers_to_clear → priority → age
#
set -u

for b in jq git; do command -v "$b" >/dev/null 2>&1 || { echo "signoff-queue: $b not on PATH" >&2; exit 1; }; done
RR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "signoff-queue: not in a git repo" >&2; exit 1; }
JSONL="$RR/.beads/issues.jsonl"
[ -f "$JSONL" ] || { echo "signoff-queue: $JSONL not found" >&2; exit 1; }

MODE=digest; FORMAT=text; SEL=""
case "${1:-}" in
  --json) FORMAT=json ;;
  show)   MODE=show; SEL="${2:-}"; [ -n "$SEL" ] || { echo "usage: signoff-queue.sh show <tf-id|TFIND-NNN|#PR>" >&2; exit 1; } ;;
esac

# bv blockers_to_clear membership (best-effort; empty if bv unavailable).
BLOCKERS='[]'
if command -v bv >/dev/null 2>&1; then
  BLOCKERS="$(BEADS_DIR="$RR/.beads" bv --robot-triage 2>/dev/null | jq -c '[.triage.blockers_to_clear[]?.id] // []' 2>/dev/null)" || BLOCKERS='[]'
  [ -z "$BLOCKERS" ] && BLOCKERS='[]'
fi

# Pure structured selection — no description/markdown parsing anywhere.
ALL="$(jq -s -c '.' "$JSONL" 2>/dev/null)"
RANKED="$(printf '%s' "$ALL" | jq -c --argjson blockers "$BLOCKERS" '
  . as $all
  | [ .[]
      | . as $b | $b.id as $outer
      | select(any(.labels[]?; . == "signoff:pending"))
      | { id, status, priority, title,
          pr:       ([.labels[]? | select(startswith("pr-"))][0] // null),
          tfind:    ([.labels[]? | select(startswith("tfind:"))][0] // null),
          keystone: (any(.labels[]?; . == "keystone")),
          blocking: (($blockers | index($b.id)) != null),
          ref:      (.external_ref // null),
          gates:    [ $all[] | select(any(.dependencies[]?; .depends_on_id == $outer)) | .id ],
          updated_at } ]
  | sort_by([ (if .keystone then 0 else 1 end),
              (if .blocking then 0 else 1 end),
              .priority, .updated_at ])' 2>/dev/null)"
[ -z "$RANKED" ] && RANKED='[]'

# The one true close: record verdict + auto-unblock via the graph.
close_cmd() { # $1=id  $2=gates-json
  local id="$1" gates="$2" g
  printf '  br close %s --reason "DECIDED: <your one-line verdict>"\n' "$id"
  g="$(printf '%s' "$gates" | jq -r 'join(" ")')"
  if [ -n "$g" ]; then
    printf '  # ↑ this auto-unblocks: %s  (verify: br blocked | grep -E "%s")\n' "$g" "$(printf '%s' "$g" | tr ' ' '|')"
  else
    printf '  # (no downstream beads gated by %s)\n' "$id"
  fi
  printf '  # if the decision must NOT close the bead (impl still owed on it),\n'
  printf '  # instead: br dep remove <gated-id> %s   (decouple just this gate)\n' "$id"
}

if [ "$MODE" = show ]; then
  digits="$(printf '%s' "$SEL" | tr -dc 0-9)"
  pr=""; tf=""
  if [ -n "$digits" ]; then pr="pr-$digits"; tf="tfind:$(printf '%03d' "$((10#$digits))")"; fi
  ITEM="$(printf '%s' "$RANKED" | jq -c --arg id "$SEL" --arg pr "$pr" --arg tf "$tf" \
    'first(.[] | select(.id==$id or (.pr!=null and .pr==$pr) or (.tfind!=null and .tfind==$tf))) // empty')"
  [ -z "$ITEM" ] && { echo "signoff-queue: '$SEL' is not in the signoff queue"; exit 1; }
  id="$(printf '%s' "$ITEM" | jq -r .id)"
  prn="$(printf '%s' "$ITEM" | jq -r '.pr // ""' | tr -dc 0-9)"
  ref="$(printf '%s' "$ITEM" | jq -r '.ref // ""')"
  printf '════ %s  %s  %s  P%s%s ════\n' "$id" \
    "$(printf '%s' "$ITEM" | jq -r '.pr // "no-PR"')" \
    "$(printf '%s' "$ITEM" | jq -r '.tfind // "-"')" \
    "$(printf '%s' "$ITEM" | jq -r .priority)" \
    "$(printf '%s' "$ITEM" | jq -r 'if .keystone then "  ⟨KEYSTONE⟩" elif .blocking then "  ⟨unblocks⟩" else "" end')"
  printf '\ntopic:  %s\n' "$(printf '%s' "$ITEM" | jq -r .title)"
  printf 'gates:  %s\n' "$(printf '%s' "$ITEM" | jq -r 'if (.gates|length)>0 then (.gates|join(", ")) else "(nothing downstream)" end')"
  if [ -n "$ref" ] && [ "$ref" != "null" ]; then
    printf 'read:   %s\n' "$ref"
  else
    printf 'read:   ⚠ no external_ref — owning lane must: br update %s --external-ref <PR/SDD url>\n' "$id"
  fi
  if [ -n "$prn" ]; then
    printf '\nPR #%s (verbatim; mergeable is eventually-consistent):\n' "$prn"
    gh pr view "$prn" --json isDraft,state,mergeStateStatus,statusCheckRollup 2>/dev/null \
      | jq -r '"  draft=\(.isDraft) state=\(.state) mergeable=\(.mergeStateStatus) ci=\(((.statusCheckRollup//[])|map(.conclusion//.state//.status|if .==null or .=="" then "?" else . end)|group_by(.)|map("\(.[0]):\(length)")|join(" "))|if .==""then"none"else . end)"' 2>/dev/null \
      || echo "  (gh unavailable — open the ref above)"
  fi
  printf '\nDECIDE (one structured transition — records verdict AND unblocks the graph):\n'
  close_cmd "$id" "$(printf '%s' "$ITEM" | jq -c .gates)"
  exit 0
fi

if [ "$FORMAT" = json ]; then
  printf '%s\n' "$RANKED" | jq -c '{generated_at:(now|todate), queue:.}'
  exit 0
fi

n="$(printf '%s' "$RANKED" | jq 'length')"
printf '════ signoff queue · %s pending · %s ════\n' "$n" "$(date '+%H:%M:%S')"
[ "$n" = 0 ] && { echo "(nothing awaiting signoff)"; exit 0; }
printf '%s\n' "$RANKED" | jq -r '
  to_entries[] | .key as $i | .value as $v
  | "\n#\($i+1)  \($v.pr // "no-PR")  \($v.id)  \($v.tfind // "-")  P\($v.priority)"
    + (if $v.keystone then "  ⟨KEYSTONE⟩" elif $v.blocking then "  ⟨unblocks⟩" else "" end)
    + "\n  topic: \($v.title)"
    + "\n  gates: " + (if ($v.gates|length)>0 then ($v.gates|join(", ")) else "(nothing downstream)" end)
    + "\n  read:  " + (if ($v.ref != null and ($v.ref|length)>0) then $v.ref else "⚠ no external_ref — owning lane must set one" end)
    + "\n  decide: br close \($v.id) --reason \"DECIDED: <verdict>\"   (records verdict + auto-unblocks the graph)"
'
printf '\n%s\n' '════ drain keystone-first · `show <id>` for full context ════'
