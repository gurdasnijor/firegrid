#!/usr/bin/env bash
# state-watch-cron.sh — the external runner. Cron has a near-empty env
# (no PATH/HOME/CMUX_*), so everything is made explicit here. This is the
# ONLY thing that should run state-watch once the cron is installed (see
# the single-consumer note at the bottom).
#
# Flow: env → lock → (cmux reachable? else SKIP without consuming deltas)
#       → state-watch --once --json → if deltas, deliver to the coordinator
#       via cmux-dispatch (stable label + verify-submit), all logged.
#
# Install with scripts/install-state-watch-cron.sh. Tune via env in the
# crontab line: FG_WS, FG_COORD, FG_REPO.
set -u

# --- explicit env (cron has none) ----------------------------------------
export HOME="${HOME:-/Users/gnijor}"
export PATH="/Applications/cmux.app/Contents/Resources/bin:/opt/homebrew/bin:/Users/gnijor/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="${FG_REPO:-/Users/gnijor/gurdasnijor/firegrid}"
WS="${FG_WS:-workspace:2}"
COORD="${FG_COORD:-coordinator}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/firegrid-state-watch"
LOG="$STATE_DIR/cron.log"
mkdir -p "$STATE_DIR"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# --- single-flight lock (overlapping cron ticks must not race the snapshot)
LOCK="$STATE_DIR/.cron.lock"
if ! mkdir "$LOCK" 2>/dev/null; then say "skip: previous tick still running"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$REPO" 2>/dev/null || { say "FATAL: repo $REPO not found"; exit 1; }

# --- if cmux is unreachable (laptop asleep / app closed), SKIP entirely.
# Do NOT run state-watch: it would consume the delta into its baseline and
# we couldn't deliver it — the delta would be lost forever. Better to
# re-detect it on a later tick when cmux is back.
if ! cmux version >/dev/null 2>&1; then say "skip: cmux unreachable (not consuming deltas)"; exit 0; fi

OUT="$(bash "$REPO/scripts/state-watch.sh" --once --json --workspace "$WS" 2>>"$LOG" || echo '{}')"
N="$(printf '%s' "$OUT" | jq -r 'first((.n // (.deltas|length) // 0))' 2>/dev/null | head -1 | tr -dc 0-9)"
if [ "${N:-0}" = 0 ] || [ -z "$N" ]; then say "ok: no delta"; exit 0; fi

MSG="$(printf '%s' "$OUT" | jq -r '"STATE CHANGE ("+(.n|tostring)+") — act/route then re-sweep: " + ([.deltas[]|"["+.kind+"] "+.msg]|join(" ; "))' 2>/dev/null)"
[ -n "$MSG" ] || MSG="STATE CHANGE detected ($N) — run: bash scripts/state-watch.sh --once"

if bash "$REPO/scripts/cmux-dispatch.sh" --workspace "$WS" "$COORD" "$MSG" >>"$LOG" 2>&1; then
  say "PINGED $COORD ($N delta): $MSG"
else
  say "WARN: delta detected ($N) but cmux-dispatch to $COORD UNCONFIRMED — $MSG"
  # state-watch already advanced its baseline; this delta won't re-fire.
  # The WARN line in the log is the audit trail; coordinator should also
  # run a manual sweep at session resume to catch any missed-while-down.
fi
exit 0

# ─── SINGLE-CONSUMER RULE ────────────────────────────────────────────────
# state-watch is edge-triggered against ONE snapshot. Once this cron is
# installed it is the SOLE thing that runs state-watch. The coordinator
# must NOT also run `state-watch.sh --once` — two consumers race the
# snapshot and silently drop deltas. Coordinator reacts to the cron's
# cmux ping; it still runs lane-sweep / signoff-queue / dispatch-gap
# on demand, just not state-watch.
