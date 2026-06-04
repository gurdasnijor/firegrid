# FINDING - tf-gyxc Engine Recycle Is Suspend/Resume

## VERDICT

`GREEN-engine-recycle-suspends-not-cancels`

Workflow-engine scoped recycle now treats pure interrupt exits from
non-user-interrupted executions as replayable suspension. It does not persist
an Activity result or race deferred result for those recycle interrupts. A
user-requested workflow interrupt is still terminal cancellation and does not
resume after engine reconstruction.

## Load-Bearing Evidence

Runtime focused tests:

```bash
pnpm --filter @firegrid/runtime exec vitest run test/workflow-engine/DurableStreamsWorkflowEngine.test.ts
```

Result:

```text
17 tests passed
```

The new/strengthened guards are:

- `tf-gyxc keeps user-interrupted workflows terminal across engine reconstruction`
- `workflow-engine-durable-state.VALIDATION.8 replays failed activity exits through activityExecute`

The activity failure test confirms typed/domain Activity errors still persist
as `Complete` activity results and replay as the same domain error. The user
interrupt test confirms an interrupted workflow stays terminal after a fresh
engine generation and does not return the later deferred success value.

## Replay Smoke

Run:

```bash
pnpm --filter @firegrid/firelab simulate:run phase1-lane6-new-shape-replay --timeout-ms 120000 --watch
```

Run id:

```text
2026-05-20T09-18-32-847Z__phase1-lane6-new-shape-replay
```

Trace:

```text
docs/research/tf-gyxc-engine-recycle-suspend-not-cancel.trace.jsonl
```

Trace line 302 records:

```text
already_written.replay_completed = true
already_written.value = "matched-before-gen2"
live_after_restart.replay_completed = true
live_after_restart.value = "matched-after-gen2"
timeout_after_restart.replay_completed = true
timeout_after_restart.outcome = "Timeout"
timeout_after_restart.deadline_preserved = true
```

## Conclusion

The PR #469 RED path is fixed at the workflow-engine layer. The distinction is
the durable execution row and live instance state:

- recycle: execution is not marked `interrupted`, so pure interrupt exits from
  Activity/deferred cleanup are treated as suspension and are not written as
  durable results;
- user cancellation: execution/instance are marked `interrupted`, so the
  workflow remains terminal and cannot resume after restart.
