# FINDING - tf-xw0w Phase-1 Lane 2 WaitForWorkflow Cutover

## VERDICT

`GREEN-production-bridge-with-timeout-caveat`

Production `wait_for` now executes through `WaitForWorkflow` with deterministic
execution identity:

```text
wait:${contextId}:${toolUseId}
```

The production body intentionally uses the canonical Pattern B from
`docs/research/workflow-body-single-suspension-rule.md`: a single Activity
contains the match/timeout race, so the workflow body has one coherent
`Activity.execute` suspension point.

## Production Shape

The accepted bridge is:

```text
Workflow.make
+ Activity.make(match_or_timeout)
  + Effect.race(
      Stream.runHead(filteredSource),
      Effect.sleep(timeoutMs)
    )
```

The superseded INV-2 shape:

```text
DurableDeferred.raceAll([
  Activity(Stream.runHead(filteredSource)),
  DurableClock.sleep(timeoutMs),
])
```

failed same-generation timeout empirically: the clock-side durable row was
written, but the workflow body stayed alive-pinned behind the live
`Stream.runHead` Activity claim and no `raceAll/...` deferred was written.
That confirmed the workflow-body single-suspension rule.

## Timeout Semantics

`wait_for` timeout is **per Activity attempt**, not an absolute durable
deadline. If the host scope closes while the Activity is waiting, the Activity
restarts on the next generation with a fresh in-memory timer. A bounce can
therefore extend the effective timeout beyond the original `timeoutMs`.

This is an accepted tactical bridge. The long-term cleanup is to lower
`WaitForWorkflow` onto `streamWaitAny`, which can restore durable absolute
deadline semantics while still exposing one engine-managed suspension point to
the workflow body.

## Evidence

Focused host-sdk tests:

```bash
pnpm --filter @firegrid/host-sdk exec vitest run test/agent-tools/tool-use-to-effect.test.ts --testTimeout 20000 --hookTimeout 20000
```

Runtime workflow-engine regression suite:

```bash
pnpm --filter @firegrid/runtime exec vitest run test/workflow-engine/DurableStreamsWorkflowEngine.test.ts --testTimeout 30000 --hookTimeout 30000
```

Production-shape restart replay smoke:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run phase1-lane6-new-shape-replay --timeout-ms 120000
```

Run id:

```text
2026-05-20T11-45-29-223Z__phase1-lane6-new-shape-replay
```

Final probe span:

```text
firegrid.phase1.lane6.already_written.replay_completed = true
firegrid.phase1.lane6.already_written.outcome = "Match"
firegrid.phase1.lane6.already_written.value = "matched-before-gen2"
firegrid.phase1.lane6.live_after_restart.replay_completed = true
firegrid.phase1.lane6.live_after_restart.outcome = "Match"
firegrid.phase1.lane6.live_after_restart.value = "matched-after-gen2"
firegrid.phase1.lane6.timeout_after_restart.replay_completed = true
firegrid.phase1.lane6.timeout_after_restart.outcome = "Timeout"
firegrid.phase1.lane6.timeout_after_restart.eventually_fired = true
```
