#!/usr/bin/env bash
#
# dispatch-gap.sh — the enforceable primitive against idle-by-neglect.
#
# Computes:   capacity (idle worker lanes)  ×  demand (ready, UNASSIGNED beads)
# Both inputs are already structured — `lane-sweep --json` and `br ready`.
# `br ready` only returns unblocked work, so "ready" already means
# keystone-independent / dispatchable; no fragile heuristic.
#
# ENFORCEMENT CONTRACT: this script's EXIT CODE is the primitive.
#   exit 0  → no gap (no idle lane, or no unassigned ready work). OK to report.
#   exit 3  → DISPATCH GAP: idle lane(s) AND unassigned ready work coexist.
# A coordinator status that claims "lanes correctly idle / parked" while this
# exits 3 is invalid by construction. Gate the status routine on `exit 0`,
# or record an explicit per-lane justification (override below) — never
# silently ignore. It never auto-assigns: wrong-lane/wrong-work is worse than
# the gap; a human/coordinator dispatches, this only refuses to let it hide.
#
# Usage:
#   bash scripts/dispatch-gap.sh                 # human report + exit code
#   bash scripts/dispatch-gap.sh --json          # structured
#   bash scripts/dispatch-gap.sh --workspace workspace:2
#   DISPATCH_GAP_PARKED="oca1:forensics cca1:reserved" bash scripts/dispatch-gap.sh
#     # ↑ explicit, audited override: lanes deliberately idle, with a reason.
#
set -u
. "$(dirname "$0")/_lane-common.sh"   # no-hang guards (git/gh/pnpm never prompt)
RR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "dispatch-gap: not a git repo" >&2; exit 1; }
export BEADS_DIR="$RR/.beads"
for b in jq br; do command -v "$b" >/dev/null 2>&1 || { echo "dispatch-gap: $b not on PATH" >&2; exit 1; }; done

FORMAT=text; WS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) FORMAT=json; shift ;;
    --workspace) WS="${2:?}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    *) echo "dispatch-gap: unknown arg $1" >&2; exit 1 ;;
  esac
done

PARKED="${DISPATCH_GAP_PARKED:-}"            # "lane:reason lane:reason"
is_parked() { case " $PARKED " in *" $1:"*) return 0 ;; *) return 1 ;; esac; }

# --- capacity: idle worker lanes (running=false, no active bead) ----------
SWEEP="$(bash "$RR/scripts/lane-sweep.sh" ${WS:+--workspace "$WS"} --json --lines 1 2>/dev/null || echo '{}')"
IDLE="$(printf '%s' "$SWEEP" | jq -c '
  [ .lanes[]? | select((.label|test("^(oca|cca)[0-9]+$"))
      and .running==false and ((.beads//[])|length==0)) | .label ] // []' 2>/dev/null || echo '[]')"
[ -z "$IDLE" ] && IDLE='[]'

# filter out explicitly-parked lanes (audited override)
IDLE_ACTIVE='[]'
for lane in $(printf '%s' "$IDLE" | jq -r '.[]' 2>/dev/null); do
  if is_parked "$lane"; then continue; fi
  IDLE_ACTIVE="$(printf '%s' "$IDLE_ACTIVE" | jq -c --arg l "$lane" '. + [$l]')"
done

# --- demand: ready + UNASSIGNED beads (br ready = already unblocked) ------
READY="$(br ready --json 2>/dev/null | jq -c '
  [ (if type=="array" then .[] else (.issues // .ready // [])[] end)
    | select((.assignee // null) == null)
    | {id, priority, title:(.title[0:60])} ]
  | sort_by(.priority) // []' 2>/dev/null || echo '[]')"
[ -z "$READY" ] && READY='[]'

idle_n="$(printf '%s' "$IDLE_ACTIVE" | jq 'length')"
ready_n="$(printf '%s' "$READY" | jq 'length')"
gap=$(( idle_n < ready_n ? idle_n : ready_n ))

if [ "$FORMAT" = json ]; then
  jq -nc --argjson idle "$IDLE_ACTIVE" --argjson parked "$(printf '%s' "$IDLE" | jq -c --arg p "$PARKED" '[.[]|select(($p|split(" ")|map(split(":")[0]))|index(.))]')" \
        --argjson ready "$READY" --argjson gap "$gap" \
    '{gap:$gap, idle_lanes:$idle, parked_lanes:$parked, unassigned_ready:$ready}'
  [ "$gap" -gt 0 ] && exit 3 || exit 0
fi

echo "════ dispatch gap · $(date '+%H:%M:%S') ════"
echo "idle worker lanes (free capacity): $(printf '%s' "$IDLE_ACTIVE" | jq -r 'join(", ") | if .=="" then "none" else . end')"
[ -n "$PARKED" ] && echo "parked (audited override):        $PARKED"
echo "ready + UNASSIGNED beads:          $ready_n"
if [ "$gap" -gt 0 ]; then
  echo
  echo "⛔ DISPATCH GAP = $gap  (idle capacity sitting on unassigned ready work)"
  echo "   assign before reporting status. Top candidates (by priority):"
  printf '%s' "$READY" | jq -r '.[:6][] | "     \(.id)  P\(.priority)  \(.title)"'
  echo
  echo "   dispatch: cmux send --workspace <ws> --surface <lane> '<bead + brief>'"
  echo "   then:     br update <id> --assignee <lane> --status in_progress"
  exit 3
fi
echo
echo "✓ no dispatch gap (no idle lane, or no unassigned ready work)"
exit 0
