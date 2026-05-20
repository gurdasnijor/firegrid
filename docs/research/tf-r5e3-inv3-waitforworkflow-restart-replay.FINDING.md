# FINDING — INV-3 WaitForWorkflow Restart-Replay Durability

Bead: `tf-r5e3`

## Verdict

PASS for the substrate question: a minimal `Workflow.make`-based
`inv3.wait-for-workflow` can suspend on `WaitFor.match` /
`DurableDeferred.await`, lose its in-memory host generation, and resume from
Durable Streams state after a fresh host generation starts.

The source-as-offset principle held empirically: the persisted wait row keeps
the workflow execution id, wait name, typed source, trigger, and timeout
deadline. On generation 2, the router derives all pending work from durable
source/wait rows; no in-memory gen-1 state is required.

## Artifact

Run:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run inv3-restart-replay --timeout-ms 120000
```

Run id:

```text
2026-05-20T06-50-02-694Z__inv3-restart-replay
```

Trace artifact:

```text
docs/research/tf-r5e3-inv3-waitforworkflow-restart-replay.trace.jsonl
```

Runner copy:

```text
packages/tiny-firegrid/.simulate/runs/2026-05-20T06-50-02-694Z__inv3-restart-replay/trace.jsonl
```

The trace has 345 JSONL spans. Relevant span counts:

| Span | Count |
| --- | ---: |
| `firegrid.inv3.host_generation` | 6 |
| `firegrid.durable_tools.wait_router.start` | 6 |
| `firegrid.durable_tools.wait_router.initial_check` | 6 |
| `firegrid.durable_tools.wait_router.complete_match` | 8 |
| `firegrid.durable_tools.wait_for.match` | 7 |
| `firegrid.workflow_engine.deferred.done` | 6 |
| `firegrid.workflow_engine.clock.fire` | 1 |

The probe verdict span includes:

```text
firegrid.inv3.already_written.value = row-written-before-generation-2
firegrid.inv3.live_after_restart.value = row-written-after-generation-2
firegrid.inv3.timeout_after_restart.outcome = Timeout
firegrid.inv3.timeout_after_restart.deadline_preserved = true
```

## Acceptance Matrix

| Acceptance | Result | Evidence |
| --- | --- | --- |
| (a) Same workflow execution resumes | PASS | Each scenario computes one `WaitForWorkflow.executionId(payload)`, persists the active gen-1 wait with that execution id, and asserts the gen-2 workflow result uses the same id. Trace execution ids: `015c4b4b11e9864f395e9588d032611a`, `04524a67f581ec09eb3f710bed2d547e`, `521a6e9a552e54cd776062b8862ec647`. |
| (b) Already-written match row replays the same value | PASS | `already-written` closes gen 1 with an active wait, writes the matching fact before gen 2 starts, then gen 2 returns `row-written-before-generation-2`. |
| (c) Missing match row re-subscribes and waits | PASS | `live-after-restart` closes gen 1 with an active wait, starts gen 2, delays 100ms, writes the matching fact, and returns `row-written-after-generation-2`. The trace includes `wait.satisfied` and `fireline.agent.resumed` on the gen-2 `complete_match` span. |
| (d) DurableClock timeout deadline preserved | PASS | `timeout-after-restart` records the gen-1 wait row and `clockWakeups` deadline, sleeps past that deadline while no host generation is running, then gen 2 fires `firegrid.workflow_engine.clock.fire` and returns `Timeout`; the probe asserts the gen-2 clock deadline and final wait deadline equal the gen-1 values. |

## What Was Built

Simulation code:

```text
packages/tiny-firegrid/src/simulations/inv3-restart-replay/
```

The simulation is self-contained:

- app-owned `Inv3FactTable` for `CallerFact` rows;
- minimal `inv3.wait-for-workflow` built with `Workflow.make`;
- `DurableStreamsWorkflowEngine.layer` plus `DurableToolsWaitForLive`;
- scoped gen-1 and gen-2 layer construction to model host restart with durable streams preserved;
- module-level host/driver handshake so host probe failures fail the normal simulation runner.

## Runner Gap

The stock tiny-firegrid runner exposes one `host(env)` layer per simulation
run. It does not expose an official two-generation lifecycle API or OS-level
process kill/restart driver. This sim therefore uses the smallest available
probe: close the gen-1 Effect scope, construct a fresh gen-2 host composition
against the same durable stream URLs, and assert the replay behavior through
trace plus workflow return values.

This is equivalent to the in-memory-loss invariant under test, but it is not a
literal `process.kill` of a separate host OS process.

## Bounds

- The branch intentionally uses the dispatch-approved minimal
  `WaitForWorkflow` instead of waiting for INV-2.
- No production code was edited in `packages/runtime`, `packages/host-sdk`, or
  `packages/client-sdk`.
- No host-sdk/runtime tests were edited.
- The run did not involve a real `claude-agent-acp` planner process; the proof
  is at the workflow-engine/durable-wait substrate level. That matches the
  parallel-note path for INV-3, but a separate app-level live-agent smoke would
  still be useful after INV-2/INV-3 converge.
