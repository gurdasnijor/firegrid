#!/usr/bin/env bash
#
# state-watch.sh — edge-triggered push detector. Prevents "sticking": lanes
# blocked on the coordinator while the coordinator's attention is tunneled
# and its next *pull* (lane-sweep) is far off.
#
# Pull (lane-sweep / signoff-queue / dispatch-gap) is level-triggered: it
# only helps when the coordinator runs it. This is EDGE-triggered: it
# snapshots structured state, diffs against the previous snapshot, and emits
# ONLY the changes since last check — so a delivery layer can ping the
# coordinator the moment state moves, not on a timer it learns to ignore.
#
# Sources are all structured (no markdown parsed):
#   - .beads/issues.jsonl   (the SoT: status / signoff:pending / ready edges)
#   - dispatch-gap.sh --json (idle capacity × unassigned ready)
#   - lane-sweep.sh --json   (lane running true→false = just went idle)
#
# It NEVER mutates or auto-acts. It detects and (optionally) notifies.
# Snapshot lives OUTSIDE the repo (per-machine watcher memory):
#   ${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch/
#
# Exit: 0 = no notable delta (or first run = baseline). 3 = notable delta.
#
# Usage:
#   bash scripts/state-watch.sh --once                       # detect + print deltas
#   bash scripts/state-watch.sh --once --json
#   bash scripts/state-watch.sh --once --notify surface:153  # also cmux-ping on delta
#   bash scripts/state-watch.sh --once --workspace workspace:2
#
set -u
RR="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "state-watch: not a git repo" >&2; exit 1; }
JSONL="$RR/.beads/issues.jsonl"
for b in jq git; do command -v "$b" >/dev/null 2>&1 || { echo "state-watch: $b not on PATH" >&2; exit 1; }; done

FORMAT=text; NOTIFY=""; WS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --once) shift ;;                                  # the only mode for now
    --json) FORMAT=json; shift ;;
    --notify) NOTIFY="${2:?}"; shift 2 ;;
    --notify=*) NOTIFY="${1#*=}"; shift ;;
    --workspace) WS="${2:?}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    *) echo "state-watch: unknown arg $1" >&2; exit 1 ;;
  esac
done

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch"
mkdir -p "$STATE_DIR"
PREV="$STATE_DIR/snapshot.json"

# --- take a structured snapshot (small, comparable) -----------------------
beads_snap="$(jq -sc '[ .[]
  | { id,
      st: .status,
      sp: (any(.labels[]?; . == "signoff:pending")),
      bl: ((.dependencies // []) | map(.depends_on_id) ),
      asg: (.assignee // null) } ]
  | sort_by(.id)' "$JSONL" 2>/dev/null || echo '[]')"

gap_snap="$(bash "$RR/scripts/dispatch-gap.sh" ${WS:+--workspace "$WS"} --json 2>/dev/null \
  | jq -c '{gap, idle:.idle_lanes}' 2>/dev/null || echo '{"gap":0,"idle":[]}')"

lanes_snap="$(bash "$RR/scripts/lane-sweep.sh" ${WS:+--workspace "$WS"} --json --lines 1 2>/dev/null \
  | jq -c '[ .lanes[]? | select(.label|test("^(oca|cca)[0-9]+$"))
             | {label, running, beads:((.beads//[])|map(.id)|sort)} ]
           | sort_by(.label)' 2>/dev/null || echo '[]')"

SNAP="$(jq -nc --argjson beads "$beads_snap" --argjson gap "$gap_snap" --argjson lanes "$lanes_snap" \
  '{beads:$beads, gap:$gap, lanes:$lanes}')"

# --- first run: record baseline, no deltas --------------------------------
if [ ! -f "$PREV" ]; then
  printf '%s' "$SNAP" > "$PREV"
  [ "$FORMAT" = json ] && echo '{"baseline":true,"deltas":[]}' || echo "state-watch: baseline recorded (no prior snapshot)"
  exit 0
fi

OLD="$(cat "$PREV" 2>/dev/null || echo '{}')"

# --- classify edge events (old → new), structured only --------------------
DELTAS="$(jq -nc --argjson old "$OLD" --argjson new "$SNAP" '
  ($old.beads // []) as $ob | ($new.beads // []) as $nb
  | ($ob | map({key:.id, value:.}) | from_entries) as $obi
  | [
      # bead newly awaiting signoff (decision demand appeared)
      ( $nb[] | select(.sp == true and (($obi[.id].sp) != true))
        | {kind:"signoff_new", id, msg:("decision needed: " + .id)} ),
      # bead newly closed (work/decision landed → may unblock downstream)
      ( $nb[] | select(.st == "closed" and (($obi[.id].st) != "closed") and ($obi[.id] != null))
        | {kind:"closed", id, msg:(.id + " closed → check unblocks")} ),
      # bead newly unblocked (had open deps, now none) = freshly dispatchable
      ( $nb[] | select((.bl|length)==0 and (($obi[.id].bl // [])|length) > 0 and .st != "closed")
        | {kind:"unblocked", id, msg:(.id + " is now ready")} ),
      # a lane just went idle (running true → false): possible stick/done
      ( $new.lanes[] as $l
        | ($old.lanes[] | select(.label==$l.label)) as $o
        | select($o.running == true and $l.running == false)
        | {kind:"lane_idle", id:$l.label,
           msg:($l.label + " went idle" + (if ($l.beads|length)==0 then " (no bead — likely stuck/done)" else "" end)) } ),
      # dispatch gap opened (was 0, now > 0)
      ( select(($new.gap.gap // 0) > 0 and ($old.gap.gap // 0) == 0)
        | {kind:"gap_open", id:"-",
           msg:("dispatch gap opened: idle " + (($new.gap.idle//[])|join(",")) ) } )
    ]' 2>/dev/null || echo '[]')"

printf '%s' "$SNAP" > "$PREV"          # advance the baseline regardless

n="$(printf '%s' "$DELTAS" | jq 'length' 2>/dev/null || echo 0)"

if [ "$FORMAT" = json ]; then
  printf '%s\n' "$DELTAS" | jq -c '{deltas:., n:length}'
else
  if [ "$n" -eq 0 ]; then
    echo "state-watch: no state change since last check"
  else
    echo "════ STATE CHANGED ($n) · $(date '+%H:%M:%S') ════"
    printf '%s' "$DELTAS" | jq -r '.[] | "  [\(.kind)] \(.msg)"'
  fi
fi

# --- optional push: cmux-ping the coordinator ONLY on a delta -------------
if [ "$n" -gt 0 ] && [ -n "$NOTIFY" ] && command -v cmux >/dev/null 2>&1; then
  body="$(printf '%s' "$DELTAS" | jq -r '"STATE CHANGE — act/route then re-sweep: " + ([.[]|"["+.kind+"] "+.msg]|join(" ; "))')"
  cmux send ${WS:+--workspace "$WS"} --surface "$NOTIFY" "$body" >/dev/null 2>&1 \
    && cmux send-key ${WS:+--workspace "$WS"} --surface "$NOTIFY" Return >/dev/null 2>&1 \
    && echo "state-watch: pinged $NOTIFY"
fi

[ "$n" -gt 0 ] && exit 3 || exit 0
