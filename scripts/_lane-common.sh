#!/usr/bin/env bash
# Shared lane-lifecycle hardening, sourced by task-enter/task-exit and the
# dispatch/sweep/reap scripts. Its whole job is: an agent lane runs with NO
# stdin, so any interactive prompt (ssh passphrase, git credential, gh auth,
# pnpm confirm) blocks the lane FOREVER — the "stuck agent". These guards turn
# every such prompt into an immediate, actionable failure, and `with_timeout`
# caps the long-running commands so nothing can wedge indefinitely.
#
# Source it right after `set -eu`:  . "$(dirname "$0")/_lane-common.sh"
# Idempotent + safe to source under `set -eu`.

# ── no-hang guards: nothing may block on absent stdin ────────────────────────
export GIT_TERMINAL_PROMPT=0                                    # git: fail, never prompt for credentials
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
export GH_PROMPT_DISABLED=1                                     # gh: never interactive-prompt
export GH_NO_UPDATE_NOTIFIER=1
export CI="${CI:-1}"                                           # pnpm/turbo: non-interactive
export PNPM_CONFIG_CONFIRM_MODULES_PURGE=false

# ── step tracer (opt-in via TASK_DEBUG=1) so a future wedge is visible ───────
# Prints "+ [script:line] cmd" for every command — read the LAST line to see
# exactly where a lane stuck (the diagnose-first instrument).
if [ "${TASK_DEBUG:-}" = "1" ]; then
  export PS4='+ [${BASH_SOURCE##*/}:${LINENO}] '
  set -x
fi

# ── portable command timeout (macOS ships no coreutils `timeout`) ────────────
# Usage:  with_timeout <seconds> <cmd...>
# Runs cmd in the foreground's stdio (output streams live); on expiry it TERMs
# then KILLs the process group and returns 124. Returns cmd's own rc otherwise.
# Never let `set -e` abort the caller mid-measure: callers use `if with_timeout …`.
with_timeout() {
  local secs="$1"; shift
  ( "$@" ) &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 3; kill -KILL "$pid" 2>/dev/null ) &
  local watcher=$!
  local rc=0
  if wait "$pid" 2>/dev/null; then rc=0; else rc=$?; fi
  kill -TERM "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  # 143 = SIGTERM, 137 = SIGKILL → our watchdog fired (timeout), normalize to 124.
  if [ "$rc" = "143" ] || [ "$rc" = "137" ]; then
    echo "⏱ with_timeout: '$*' exceeded ${secs}s — killed (treat as failure, not a hang)." >&2
    return 124
  fi
  return "$rc"
}

# ── agent-safe invocation advisory ───────────────────────────────────────────
# The recurring "stuck lane" is an AGENT-SIDE wrapper, not the script: running
# `bash scripts/task-… 2>&1 | tail -N` or backgrounding it (`&`) strands a
# pager/subshell so a FINISHED lane looks hung, and the bounded final status is
# hidden. These scripts already stream concise progress and print ONE terminal
# `LANE STATUS:` line — so they must be run DIRECTLY. We can't truly block a
# pipe (and redirect-to-file in CI is legitimate), so advise loudly when stdout
# is not a terminal. Call once, right after sourcing.
lane_output_advisory() {
  if [ ! -t 1 ]; then
    echo "ℹ lane: run this wrapper DIRECTLY — do not pipe it through tail/head or background it (&)." >&2
    echo "  It streams concise progress and ends with a single 'LANE STATUS:' line; a pipe hides that and can look stuck." >&2
  fi
}

# Resolve the ONE beads store a lane must use for `br`, so task-enter and
# task-exit never disagree (the enter-claims-here / exit-flushes-there bug:
# beads live in the inherited br-owner store, e.g. ~/…/.beads, while task-exit
# had hard-coded the in-repo .beads). Precedence: inherited $BEADS_DIR (the
# br-owner store the operator/cron uses) > the repo .beads next to the PRIMARY
# checkout. Prints nothing; echoes the path.
resolve_beads_dir() {
  if [ -n "${BEADS_DIR:-}" ]; then
    printf '%s' "$BEADS_DIR"
    return 0
  fi
  local common
  common="$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd)" || return 1
  printf '%s/.beads' "$(dirname "$common")"
}

# Print one visibility line for a bead in the resolved store, and a loud warning
# when it is absent there (the store-confusion symptom) — so an operator sees
# WHICH store is authoritative before trusting enter/exit bead state.
lane_beads_status() {
  local bead="$1" store="$2"
  if BEADS_DIR="$store" br show "$bead" >/dev/null 2>&1; then
    echo "✓ beads store: $store (bead $bead: found)"
    return 0
  fi
  echo "⚠ beads store: $store — bead $bead NOT FOUND here." >&2
  echo "  If it lives in a different br-owner store, set BEADS_DIR to that store so" >&2
  echo "  task-enter and task-exit agree. Check: BEADS_DIR='$store' br show $bead" >&2
  return 1
}
