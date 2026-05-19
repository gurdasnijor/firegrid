#!/usr/bin/env bash
# cmux-dispatch — deterministic dispatch to a lane by STABLE LABEL, with
# guaranteed submission.
#
# Two failure modes this kills:
#   1. Surface numbers renumber (coordinator was surface:153 → :199; oca1
#      isn't durably :155). Hardcoding `--surface surface:155` silently
#      targets the wrong pane / "Surface index not found". → resolve the
#      stable LABEL (oca1/cca2/coordinator) to its current ref at send time.
#   2. A multi-line message pastes as a `[Pasted text +N lines]` block that
#      does NOT submit on a trailing \n — it sits queued until an explicit
#      Enter. Agents/dispatch "forget" the Enter → the message never runs.
#      → send body, then SEND ENTER AND VERIFY THE AGENT IS RUNNING, retrying
#      the Enter; fail LOUD rather than leave a queued message.
#
# Usage:
#   bash scripts/cmux-dispatch.sh <lane-label> <message…>
#   echo "<msg>" | bash scripts/cmux-dispatch.sh <lane-label> -
#   bash scripts/cmux-dispatch.sh --workspace workspace:2 oca1 "resume #326"
#
set -u
WS="${CMUX_DISPATCH_WS:-workspace:2}"
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="${2:?}"; shift 2 ;;
    --workspace=*) WS="${1#*=}"; shift ;;
    --) shift; break ;;
    -*) echo "cmux-dispatch: unknown flag $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
TARGET="${1:?usage: cmux-dispatch.sh [--workspace ws] <lane-label|bead-id> <message…>}"; shift
if [ "${1:-}" = "-" ]; then MSG="$(cat)"; else MSG="$*"; fi
[ -n "$MSG" ] || { echo "cmux-dispatch: empty message" >&2; exit 1; }
command -v cmux >/dev/null 2>&1 || { echo "cmux-dispatch: cmux not on PATH" >&2; exit 1; }

# Target may be a lane label (oca1) OR a bead id (tf-80d). For a bead, look
# up its assignee (the lane label) from the SoT — the payoff of the
# structured assignee: dispatch by what you're working, not by pane number.
LANE="$TARGET"
if printf '%s' "$TARGET" | grep -qE '^tf-[a-z0-9]+$'; then
  RR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  JSONL="$RR/.beads/issues.jsonl"
  [ -n "$RR" ] && [ -f "$JSONL" ] || { echo "cmux-dispatch: '$TARGET' looks like a bead but no .beads/issues.jsonl found" >&2; exit 1; }
  LANE="$(jq -r --arg b "$TARGET" 'select(.id==$b) | .assignee // empty' "$JSONL" 2>/dev/null | head -1)"
  if [ -z "$LANE" ]; then
    echo "cmux-dispatch: bead $TARGET has no assignee. Set it (task-enter does this:" >&2
    echo "  br update $TARGET --assignee <lane>), or pass the lane label directly." >&2
    exit 1
  fi
  echo "  $TARGET → assignee '$LANE'"
fi

# 1. label → CURRENT surface ref (exact label match; renumber-proof).
REF="$(cmux list-pane-surfaces --workspace "$WS" 2>/dev/null \
  | sed -E 's/^[* ] *//; s/ +\[selected\]$//' \
  | awk -v L="$LANE" '{ ref=$1; $1=""; sub(/^ +/,""); if ($0==L){ print ref; exit } }')"
if [ -z "$REF" ]; then
  echo "cmux-dispatch: no surface labelled '$LANE' in $WS. Current lanes:" >&2
  cmux list-pane-surfaces --workspace "$WS" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi

screen() { cmux read-screen --workspace "$WS" --surface "$REF" --lines 30 2>/dev/null; }
# "submitted & accepted" = the agent began a turn (its TUI shows the running
# indicator). A queued/un-submitted paste shows no such indicator.
running() { screen | grep -qa 'esc to interrupt'; }

# 2. send the body (no embedded submit — multi-line pastes don't submit on \n)
cmux send --workspace "$WS" --surface "$REF" "$MSG" >/dev/null 2>&1 \
  || { echo "cmux-dispatch: send(body) failed → $LANE ($REF)" >&2; exit 1; }

# 3. submit, then VERIFY; retry the Enter (idempotent) until the agent runs.
submitted=0
for attempt in 1 2 3 4 5; do
  sleep 1
  cmux send --workspace "$WS" --surface "$REF" '\r' >/dev/null 2>&1   # \r = Enter
  sleep 2
  if running; then submitted=1; break; fi
done

if [ "$submitted" = 1 ]; then
  echo "✓ dispatched & SUBMITTED → $LANE ($REF) — agent is now running"
  exit 0
fi
echo "✋ cmux-dispatch: message delivered to $LANE ($REF) but NOT confirmed" >&2
echo "   running after 5 Enter attempts. It may be QUEUED UNSENT — inspect:" >&2
echo "     cmux read-screen --workspace $WS --surface $REF --lines 30" >&2
echo "   and submit manually (cmux send --surface $REF '\\\\r')." >&2
exit 1
