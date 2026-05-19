#!/usr/bin/env bash
# cmux-broadcast — fan one message out to every worker lane, with the same
# per-lane submission guarantee as cmux-dispatch (resolve stable label →
# current ref, send, VERIFY the agent is running, retry the Enter). Reports
# a per-lane pass/fail and exits non-zero if ANY lane was not confirmed —
# so a partial broadcast is never silent.
#
# Default targets: every surface labelled oca<N>/cca<N> in the workspace,
# EXCLUDING `coordinator` and the caller's own pane (resolved via
# cmux identify — you don't broadcast to yourself).
#
# Usage:
#   bash scripts/cmux-broadcast.sh "<message…>"
#   bash scripts/cmux-broadcast.sh --lanes "oca1 oca2" "<message…>"
#   bash scripts/cmux-broadcast.sh --workspace workspace:2 - < msg.txt
#
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WS="${CMUX_DISPATCH_WS:-workspace:2}"
LANES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="${2:?}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    --lanes) LANES="${2:?}"; shift 2 ;;
    --lanes=*) LANES="${1#*=}"; shift ;;
    --) shift; break ;;
    -*) echo "cmux-broadcast: unknown flag $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
if [ "${1:-}" = "-" ]; then MSG="$(cat)"; else MSG="$*"; fi
[ -n "$MSG" ] || { echo "cmux-broadcast: empty message" >&2; exit 1; }
command -v cmux >/dev/null 2>&1 || { echo "cmux-broadcast: cmux not on PATH" >&2; exit 1; }

# Don't broadcast to your own pane.
SELF="$(cmux identify 2>/dev/null | jq -r '.caller.surface_ref // empty' 2>/dev/null | grep -oE 'surface:[0-9]+' | head -1 || true)"

if [ -z "$LANES" ]; then
  # auto: worker lanes (oca<N>/cca<N>), excluding coordinator + self ref.
  LANES="$(cmux list-pane-surfaces --workspace "$WS" 2>/dev/null \
    | sed -E 's/ +\[selected\]$//' \
    | awk -v self="$SELF" '
        { mark=$1; ref=$2; if (mark!="*" ) { ref=$1 } ; lbl=$0
          sub(/^[* ] *surface:[0-9]+ +/,"",lbl)
          if (lbl ~ /^(oca|cca)[0-9]+$/ && ref!=self) print lbl }' \
    | sort -u | tr '\n' ' ')"
fi
[ -n "$LANES" ] || { echo "cmux-broadcast: no target lanes resolved in $WS" >&2; exit 1; }

echo "════ broadcast → [$LANES] · $WS ════"
ok=0; fail=0; failed=""
for lane in $LANES; do
  if bash "$HERE/cmux-dispatch.sh" --workspace "$WS" "$lane" "$MSG"; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); failed="$failed $lane"
  fi
done
echo "════ broadcast: $ok confirmed · $fail unconfirmed${failed:+ —$failed} ════"
[ "$fail" -eq 0 ] || { echo "⚠ re-dispatch the unconfirmed lane(s) individually." >&2; exit 1; }
