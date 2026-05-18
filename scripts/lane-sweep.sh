#!/usr/bin/env bash
#
# lane-sweep.sh — pull the current terminal tail of every engineer worklane
# in one shot, so the coordinator can SEE lane state instead of waiting for
# engineers to message back via cmux.
#
# It is deliberately heuristic-free: it just fans `cmux read-screen` across
# the agent surfaces and prints each tail under a header. You read it. No
# classification that could be confidently wrong.
#
# Runs relative to the current tab: the pane you invoke it from (resolved
# via `cmux identify`) is auto-excluded, so you sweep every OTHER lane.
#
# Usage:
#   bash scripts/lane-sweep.sh                 # all lanes except the current tab
#   bash scripts/lane-sweep.sh 153 155 161     # only these surface numbers
#   bash scripts/lane-sweep.sh --lines 25      # deeper tail (default 14)
#   bash scripts/lane-sweep.sh --json          # structured, agent-parseable
#
# --json emits {generated_at, lanes:[{surface,label,running,status,beads,
# tail[]}]}. `running` is a literal read of the TUI's own "esc to interrupt"
# indicator; `status` is the agent's own status line quoted verbatim — neither
# is a classification. `beads` is the in_progress issues whose `assignee` tags
# this lane, joined from .beads/issues.jsonl. For the join to populate, each
# engineer must tag its WIP bead with its lane (see AGENTS.md cmux section).
#
# Best-effort reporter: a grep no-match must not abort the sweep, so no -e /
# pipefail here. -u catches typos.
set -u

command -v cmux >/dev/null 2>&1 || { echo "lane-sweep: cmux not on PATH" >&2; exit 1; }

LINES=14
FORMAT=text
SURFACES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --lines) LINES="${2:?--lines needs a number}"; shift 2 ;;
    --lines=*) LINES="${1#*=}"; shift ;;
    --json) FORMAT=json; shift ;;
    -h|--help) awk 'NR>1{ if($0 !~ /^#/) exit; sub(/^# ?/,""); print }' "$0"; exit 0 ;;
    *) SURFACES+=("${1#surface:}"); shift ;;
  esac
done

# Repo root for the beads join (best-effort; skipped if unavailable).
BEADS_JSONL=""
if RR=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$RR/.beads/issues.jsonl" ]; then
  BEADS_JSONL="$RR/.beads/issues.jsonl"
fi

# Strip pure terminal chrome so the tail is parseable. Drops rule lines,
# empty prompt boxes, the permission footer, and known cmux/TUI chrome —
# never content lines.
denoise() {
  grep -vE \
    -e '^[[:space:]]*[─━–—-]{3,}[[:space:]]*$' \
    -e '^[[:space:]]*[❯›][[:space:]]*$' \
    -e 'bypass permissions on \(shift\+tab' \
    -e '(ctrl\+[a-z] to |/ps to view|/stop to close|background terminal running|← for agents|to hide tasks|to run in background)' \
    || true
}

# The agent's own status line, quoted verbatim (not classified): the last
# line carrying the TUI's activity marker.
status_line() {
  grep -aE 'Worked for [0-9]|Working \([0-9]|\([0-9]+m?[[:space:]]*[0-9]*s?[[:space:]]*·|^[[:space:]]*[✶✳✻✷✽✷⏺•◇] ' \
    | grep -avE 'bypass permissions on \(shift' \
    | tail -n1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Beads join: in_progress issues whose assignee tags this lane. Reads
# .beads/issues.jsonl directly (the reliable surface — never `br --json`).
beads_for() { # $1=surface-ref  $2=label
  [ -n "$BEADS_JSONL" ] || { printf '[]'; return; }
  jq -sc --arg s "$1" --arg lbl "$2" '
    def norm: (. // "") | ascii_downcase | gsub("\\s+";" ") | gsub("^ | $";"");
    ($s|norm) as $sn | ($lbl|norm) as $ln
    | [ .[] | select(.status=="in_progress"
          and ((.assignee|norm)==$sn or (.assignee|norm)==$ln))
        | {id, title, tfind:([.labels[]?|select(startswith("tfind:"))][0]//null)} ]' \
    "$BEADS_JSONL" 2>/dev/null || printf '[]'
}

# Enumerate surfaces from cmux. Lines look like:
#   "  surface:33  coordinator"
#   "* surface:153  Opus Coding Agent 1  [selected]"
# The leading "*" marks the selected surface — almost always the pane the
# coordinator is running this from — so skip it unless explicitly named.
ROWS=()
while IFS= read -r line; do ROWS+=("$line"); done < <(cmux list-pane-surfaces 2>/dev/null)

# "Relative to the current tab": exclude the surface this script is running
# in (the coordinator's own pane), resolved via `cmux identify` →
# .caller.surface_ref. This is robust regardless of which pane is *selected*
# or how lanes are labelled. Falls back to no self-exclusion if not run from
# inside a cmux pane (e.g. plain shell), where there is no "current tab".
SELF=""
if SELF_LINE=$(cmux identify 2>/dev/null | grep -m1 '"surface_ref"'); then
  [[ "$SELF_LINE" =~ surface:([0-9]+) ]] && SELF="${BASH_REMATCH[1]}"
fi

if [ "${#SURFACES[@]}" -eq 0 ]; then
  for row in "${ROWS[@]}"; do
    [[ "$row" =~ surface:([0-9]+) ]] || continue
    sn="${BASH_REMATCH[1]}"
    [ -n "$SELF" ] && [ "$sn" = "$SELF" ] && continue      # skip current tab
    SURFACES+=("$sn")
  done
fi

[ "${#SURFACES[@]}" -eq 0 ] && { echo "lane-sweep: no target surfaces"; exit 0; }

label_for() {
  for row in "${ROWS[@]}"; do
    if [[ "$row" =~ surface:$1([^0-9]|$) ]]; then
      printf '%s' "$(printf '%s' "$row" | sed -E 's/^[* ] *surface:[0-9]+ +//; s/ +\[selected\]$//')"
      return
    fi
  done
  printf 'surface:%s' "$1"
}

JSON_LANES=""
[ "$FORMAT" = text ] && printf '════ lane sweep · %s · tail=%s lines ════\n' "$(date '+%H:%M:%S')" "$LINES"

for s in "${SURFACES[@]}"; do
  label="$(label_for "$s")"
  raw="$(cmux read-screen --surface "surface:$s" --lines "$LINES" 2>&1 || true)"
  # `running` is a literal read of the TUI's own indicator, not a heuristic.
  running=false
  printf '%s' "$raw" | grep -qa 'esc to interrupt' && running=true
  status="$(printf '%s\n' "$raw" | status_line)"
  tail_clean="$(printf '%s\n' "$raw" | sed 's/[[:space:]]*$//' | denoise | sed '/^[[:space:]]*$/d' | tail -n "$LINES")"
  beads="$(beads_for "surface:$s" "$label")"

  if [ "$FORMAT" = json ]; then
    obj="$(jq -nc \
      --arg surface "surface:$s" --arg label "$label" \
      --arg status "$status" --argjson running "$running" \
      --arg tail "$tail_clean" --argjson beads "$beads" \
      '{surface:$surface,label:$label,running:$running,status:$status,beads:$beads,tail:($tail|split("\n")|map(select(length>0)))}')"
    JSON_LANES="${JSON_LANES:+$JSON_LANES,}$obj"
  else
    printf '\n──── surface:%s · %s ────\n' "$s" "$label"
    printf 'running=%s  status=%s\n' "$running" "${status:-<none>}"
    [ "$beads" != "[]" ] && printf 'beads=%s\n' "$(printf '%s' "$beads" | jq -c '[.[]|.id+" "+( .tfind//"")]')"
    printf '%s\n' "$tail_clean"
  fi
done

if [ "$FORMAT" = json ]; then
  printf '{"generated_at":"%s","lanes":[%s]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$JSON_LANES" | jq -c .
else
  printf '\n════ end · %s lanes ════\n' "${#SURFACES[@]}"
fi
