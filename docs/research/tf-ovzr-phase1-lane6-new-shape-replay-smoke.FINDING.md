# FINDING — tf-ovzr Phase-1 Lane 6 New-Shape Replay Smoke

## VERDICT

`RED-new-shape-replay-gap`

The exact INV-2 `WaitForWorkflow` body shape does **not** currently survive a
scoped engine bounce while the `Activity(Stream.runHead(...))` side is
suspended. This lane therefore does not close the Phase-1 Lane 6 acceptance
proof. It identifies the missing durability behavior Phase-1 needs to resolve
before treating INV-3 as equivalent evidence for the new shape.

The failure is not source matching. The sim starts the INV-2 body with no
matching row, observes the Activity claim and durable timeout clock, closes the
gen-1 scoped engine, reconstructs gen-2 against the same durable streams and
same stable worker id, then either writes the match before gen-2 execute or
after gen-2 starts. Gen-2 replay fails before a match or timeout can win because
the race deferred contains an interrupted cause that does not decode against
the INV-2 race schema (`error: Schema.Never`).

## Artifact

Run:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run phase1-lane6-new-shape-replay --timeout-ms 120000 --watch
```

Run id:

```text
2026-05-20T08-49-24-553Z__phase1-lane6-new-shape-replay
```

Trace artifact:

```text
docs/research/tf-ovzr-phase1-lane6-new-shape-replay.trace.jsonl
```

Runner copy:

```text
packages/tiny-firegrid/.simulate/runs/2026-05-20T08-49-24-553Z__phase1-lane6-new-shape-replay/trace.jsonl
```

## What Was Built

Simulation code:

```text
packages/tiny-firegrid/src/simulations/phase1-lane6-new-shape-replay/
```

The sim is self-contained and imports the merged INV-2
`WaitForWorkflow` / `WaitForWorkflowLayer` directly from:

```text
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/wait-for-workflow.ts
```

That keeps the body under test literally the INV-2 shape:

```text
Activity(Stream.runHead(filtered CallerFact source))
+ DurableDeferred.raceAll
+ DurableClock.sleep
```

The new code only supplies the Phase-1 Lane 6 harness:

- app-owned `Phase1Lane6FactTable` exposed through `CallerOwnedFactStreams`;
- scoped gen-1 / gen-2 `DurableStreamsWorkflowEngine.layer` construction;
- stable worker id across generations, so the failure is not a worker-id
  mismatch;
- three probes: already-written-after-restart, live-after-restart, and
  timeout-after-restart.

## Evidence

The gen-1 side reaches the intended suspended shape before each bounce:

| Scenario | Gen-1 evidence |
| --- | --- |
| already-written-after-restart | line 21 Activity claim, line 28 DurableClock schedule, line 43 race deferred write, line 47 gen-1 scope |
| live-after-restart | line 94 Activity claim, line 103 DurableClock schedule, line 118 race deferred write, line 122 gen-1 scope |
| timeout-after-restart | line 171 Activity claim, line 180 DurableClock schedule, line 195 race deferred write, line 199 gen-1 scope |

Gen-2 reconstructs against the same durable streams and worker id:

| Scenario | Gen-2 evidence |
| --- | --- |
| already-written-after-restart | line 68 `firegrid.phase1.lane6.host_generation`, worker `phase1-lane6-new-shape-replay-worker` |
| live-after-restart | line 144 `firegrid.phase1.lane6.host_generation`, same worker |
| timeout-after-restart | line 226 `firegrid.phase1.lane6.host_generation`, same worker |

Replay fails in all three scenarios with the same shape:

- line 63 / 67: already-written row is present before gen-2 execute, but
  replay fails decoding the race result: `Expected Cause<never>, actual ... Interrupt`.
- line 137 / 141: live-after-restart starts gen-2 and writes the matching row
  afterward, but replay has already failed on the same interrupted race result.
- line 216 / 222: timeout-after-restart also fails on the interrupted race
  result before the workflow can return `Timeout`.

The final probe span records:

```text
firegrid.phase1.lane6.already_written.replay_completed = false
firegrid.phase1.lane6.live_after_restart.replay_completed = false
firegrid.phase1.lane6.timeout_after_restart.replay_completed = false
firegrid.phase1.lane6.timeout_after_restart.deadline_preserved = true
```

That span is trace line 236.

## Interpretation

INV-3 remains valid old-shape evidence, but it is not direct proof for the new
shape. The old shape suspended on `WaitFor.match` / `DurableDeferred.await`;
closing gen-1 left a durable wait row that gen-2 could re-drive from source
offsets.

The new INV-2 shape has a different failure mode. While the match Activity is
blocked in `Stream.runHead`, closing the scoped engine interrupts the race
effect. `DurableDeferred.raceAll` persists that interrupted exit into the race
deferred. On gen-2, `DurableDeferred.raceAll` first reads the existing race
deferred and attempts to decode it as the declared race error type
(`Schema.Never`), which fails. The source stream and timeout clock are no
longer reached as replay drivers for the workflow result.

The timeout side separately proves DurableClock recovery still works: line 225
fires the preserved clock after gen-2 starts, and line 236 records
`deadline_preserved = true`. The blocker is the interrupted race deferred, not
clock deadline persistence.

## Acceptance Matrix

| Acceptance | Result |
| --- | --- |
| Start WaitForWorkflow while no matching row exists | PASS — each scenario records a gen-1 Activity claim and durable clock schedule before bounce. |
| Bounce while Activity side is suspended | PASS — gen-1 scope closes after the Activity claim and before any matching row is present. |
| Append matching row after restart | EXECUTED — live-after-restart writes the row after gen-2 starts, but replay has already failed. |
| Same workflow execution completes with a match | FAIL — gen-2 cannot decode the persisted interrupted race deferred. |
| Timeout deadline preservation if cheap | PARTIAL PASS — clock deadline is preserved and fires in gen-2, but the workflow still cannot return `Timeout` due the same race-deferred decode failure. |

## Recommendation

Do not cite INV-3 as proof that the new `Activity + raceAll + DurableClock`
shape survives restart. Phase-1 Lane 2 can still use INV-2 as the live
no-bounce proof, but Phase-1 needs an explicit fix or design decision for
interrupted `DurableDeferred.raceAll` replay when a long-running Activity is
inside the race.
