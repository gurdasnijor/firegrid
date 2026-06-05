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
