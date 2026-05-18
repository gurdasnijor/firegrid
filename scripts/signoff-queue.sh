#!/usr/bin/env bash
#
# signoff-queue.sh — the decisioner's drain queue. Shows every bead awaiting
# a human decision, ranked so the load-bearing one is first, each with its
# one-line decision and where to read it, plus the exact sign-off command.
#
# This is the answer to "summarise the decision + where to read it" without a
# round-trip: it reads what the owning lane already encoded in the bead.
#
# Read-only. It never mutates beads — it prints the command for you to run.
#
# Ranking (NOT raw bv order — bv's marginal gain under-weights the keystone's
# transitive cascade):
#   1. `keystone` label   (the load-bearing gate)
#   2. in bv blockers_to_clear  (unblocks downstream)
#   3. priority            (P0 → P4)
#   4. age                 (oldest waiting first)
#
# Convention the owning lane must follow when it queues a decision:
#   br update <id> --add-label signoff:pending --add-label pr-<NNN>
#   # and append to the bead description:
#   #   === SIGNOFF ===
#   #   DECISION: <one line: what you are being asked to decide>
#   #   READ: PR#<n> <doc path> §<section>
#
# Usage:
#   bash scripts/signoff-queue.sh            # ranked digest
#   bash scripts/signoff-queue.sh --json     # structured
#
set -u

for b in jq git; do command -v "$b" >/dev/null 2>&1 || { echo "signoff-queue: $b not on PATH" >&2; exit 1; }; done
RR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "signoff-queue: not in a git repo" >&2; exit 1; }
JSONL="$RR/.beads/issues.jsonl"
[ -f "$JSONL" ] || { echo "signoff-queue: $JSONL not found" >&2; exit 1; }

FORMAT=text
[ "${1:-}" = "--json" ] && FORMAT=json

# bv blockers_to_clear membership (best-effort; empty if bv unavailable).
BLOCKERS='[]'
if command -v bv >/dev/null 2>&1; then
  BLOCKERS="$(BEADS_DIR="$RR/.beads" bv --robot-triage 2>/dev/null \
    | jq -c '[.triage.blockers_to_clear[]?.id] // []' 2>/dev/null)" || BLOCKERS='[]'
  [ -z "$BLOCKERS" ] && BLOCKERS='[]'
fi

read -r -d '' QUERY <<'JQ' || true
def field($k): (.description // "")
  | ([ split("\n")[] | select(startswith($k + ": ")) ][0] // "")
  | sub("^[A-Z]+: *"; "");
[ .[]
  | select(any(.labels[]?; . == "signoff:pending"))
  | { id, status, priority,
      pr:       ([.labels[]? | select(startswith("pr-"))][0] // null),
      tfind:    ([.labels[]? | select(startswith("tfind:"))][0] // null),
      keystone: (any(.labels[]?; . == "keystone")),
      blocking: ((.id) as $i | ($blockers | index($i)) != null),
      decision: (field("DECISION")),
      read:     (field("READ")),
      title, updated_at } ]
| sort_by([ (if .keystone then 0 else 1 end),
            (if .blocking then 0 else 1 end),
            .priority, .updated_at ])
JQ

RANKED="$(jq -s --argjson blockers "$BLOCKERS" "$QUERY" "$JSONL" 2>/dev/null)"
[ -z "$RANKED" ] && RANKED='[]'

if [ "$FORMAT" = json ]; then
  printf '%s\n' "$RANKED" | jq -c '{generated_at:(now|todate), queue:.}'
  exit 0
fi

n="$(printf '%s' "$RANKED" | jq 'length')"
printf '════ signoff queue · %s pending · %s ════\n' "$n" "$(date '+%H:%M:%S')"
[ "$n" = 0 ] && { echo "(nothing awaiting signoff)"; exit 0; }

printf '%s\n' "$RANKED" | jq -r '
  to_entries[]
  | .key as $i | .value as $v
  | "\n#\($i+1)  \($v.pr // "no-PR")  \($v.id)  \($v.tfind)  P\($v.priority)"
    + (if $v.keystone then "  ⟨KEYSTONE⟩" elif $v.blocking then "  ⟨unblocks⟩" else "" end)
    + "\n  decision: " + (if ($v.decision|length)>0 then $v.decision else "⚠ NONE RECORDED — owning lane must encode DECISION: in the bead" end)
    + "\n  read:     " + (if ($v.read|length)>0 then $v.read else "⚠ none — add READ: PR#/doc/§ to the bead" end)
    + "\n  sign off: br label remove \($v.id) -l signoff:pending   # then advance/close per the decision"
'
printf '\n════ drain top-down · keystone first ════\n'
