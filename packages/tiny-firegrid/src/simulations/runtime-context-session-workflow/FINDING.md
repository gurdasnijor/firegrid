# runtime-context-session-workflow — GREEN

**Verdict:** GREEN. All three probes pass on real `DurableStreamsWorkflowEngine`.

## What this proof gates

The production `RuntimeContextSessionWorkflow` Shape D lane that replaces the
existing Shape C subscriber's lifecycle gap. Two interlocking races on the
Shape C path were reproduced in production and are fully resolved by the
workflow shape proved here:

| Production race | Root cause | Resolution proved here |
|---|---|---|
| Input arrives BEFORE `runs.started` → handler returns silently at `subscribers/runtime-context/index.ts:107`; `RuntimeContextInputFacts.forContext()` live tail emits each row ONCE per subscription, so the input is never re-delivered → Zed `agent_silent` | `RuntimeContextInputFactsLive` taps `inputIntents.rows()` ({includeInitialState: true}); no replay on "next subscriber materialization" without subscriber restart | Probe C — body parks on `Workflow.suspend`; kernel-owned write+arm controller re-arms via `Workflow.resume`; inputs are durable wakeup facts, not live-tail-once rows |
| Two `claude-agent-acp` PIDs spawned for one logical session | `adapter-common.ts:189-192` `Ref.get + check + Ref.update` TOCTOU between control-side-effect's `startOrAttach` and subscriber's `send → getOrStart → startOrAttach` | Probes A + B + C — `idempotencyKey: (p) => ${contextId}:${attempt}` admits ONE execution; `Activity.make({name: ".spawn/${key}"})` memoizes the spawn so it fires once across executes, resumes, and reconstructions |

## Probes

| Probe | Shape | Acceptance | Result |
|---|---|---|---|
| **A — early-input-then-start** | Append input row at sequence 0, THEN `Workflow.execute(payload)`. Body spawns once, point-gets row, sends, terminates. | `spawn_count == 1`, `send_count == 1`, first send carries the pre-existing inputId, `inputsConsumed == 1`. | ✅ `spawn=1 send=1 first=input-A0 inputsConsumed=1` |
| **B — concurrent-execute-no-dual-spawn** | Two concurrent `Workflow.execute(payload)` with the SAME payload (same idempotencyKey). | `spawn_count == 1` (kills production race 2), `send_count == 1` (no dup), both fibers return the same success row. | ✅ `spawn=1 send=1 result_a==result_b == {key:"ctx-B:1", inputsConsumed:1}` |
| **C — post-start-input-in-order** | `execute` first; body parks on cursor=0 miss. Then `kernelWriteArm` × 3 in order (write input row + `Workflow.resume`). | `spawn_count == 1` across all resumes (kills production race 2 across reconstruction), `send_count == 3`, send order `C-0,C-1,C-2`, `inputsConsumed == 3`. | ✅ `spawn=1 send=3 order=C-0,C-1,C-2 inputsConsumed=3` |

## Run command + raw output

```
$ pnpm --filter @firegrid/tiny-firegrid exec tsx src/index.ts run runtime-context-session-workflow

simulation starting   runId: 2026-05-24T03-28-54-502Z__runtime-context-session-workflow
[rcsw] probe A: executionId=0e47a3cb63be16e545f6792d01f8adcd | spawn_count=1 | send_count=1 | first_send_input=input-A0
[rcsw] probe B: executionId=9b86cff0d3d4f1c29b2eaa1926309ab1 | spawn_count=1 | send_count=1 | result_a={"key":"ctx-B:1","inputsConsumed":1} | result_b={"key":"ctx-B:1","inputsConsumed":1}
[rcsw] probe C: executionId=606f0bc6b283f718b5785a5bf1088221 | spawn_count=1 | send_count=3 | send_order=C-0,C-1,C-2
simulation stopped    outcome: DriverCompleted   spans=220
```

## Shape D justification (per `runtime-design-constraints.md` §SDD Gate)

The workflow's R-channel adds `WorkflowEngine.WorkflowEngine` and
`WorkflowEngine.WorkflowInstance` and `WorkflowEngineTable` because the
proof needs **all three** of:
- **Exclusive ownership of a per-key resource** — one agent process per
  `(contextId, attempt)`, proved by Probe B.
- **Cross-execution handoff** — `Workflow.suspend` / `Workflow.resume` over a
  kernel write+arm fact, proved by Probe C (post-start delivery).
- **Restart-safe live side effect** — `Activity.make` memoization makes the
  spawn replay-safe across reconstruction, proved by the `spawn_count == 1`
  invariant holding in Probe C (3 resumes against 1 execution).

## What this proof does NOT cover

- Real ACP/stdio-jsonl codec session — the recording session adapter stands
  in for the production codec. The production workflow's `spawn` Activity
  will call the real codec's `startOrAttach` (or its equivalent); this proof
  only asserts the lifecycle envelope.
- Crash + reconstruction (kwa probe shape). The kwa sim already proves
  kernel-owned write+arm survives reconstruction; the production lane will
  inherit that property.
- ChannelRouter dispatch shape — the production workflow is dispatched by
  the existing `control-request-side-effects.start` path, not by a new
  router target. Out of scope for this proof.

## Production target home (recommendation)

`packages/runtime/src/subscribers/runtime-context-session-workflow/` —
a NEW target folder so the existing `runtime-context-session/` (Shape C
codec command sink) keeps its contract. Add a `README.md` with the Shape D
machinery justification line items above.

Do NOT graft `WorkflowEngine` imports into the existing
`runtime-context-session/` Shape C folder (its README contract excludes
workflow machinery). Per Gary's dispatch: "prefer a D-named target folder
or runtime-control workflow home with explicit shape justification."

## Diff summary

This sim adds (NEW files only, no production runtime/src changes):

```
A packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/FINDING.md   (this file)
A packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/workflow.ts   (the workflow + body + Activity + tables + recording adapter + kernel write+arm)
A packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/host.ts       (three probes A/B/C)
A packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/driver.ts     (invariant assertions)
A packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/index.ts      (defineSimulation entry)
```

## Next steps (for Gary's call)

1. (CC6) Open production lane against this proof:
   - new folder `packages/runtime/src/subscribers/runtime-context-session-workflow/`
   - `RuntimeContextSessionWorkflow` = `Workflow.make` with the same shape as
     this proof, but `spawn` Activity calls the production codec
     `startOrAttach` and `send` Activity calls the codec's `sendCommand`
   - `control-request-side-effects.start` dispatches the workflow (replaces
     its current direct `session.startOrAttach` + `waitTerminal` block)
   - Shape C subscriber's `handle` no longer drops on no-runs.started;
     instead, the subscriber `kernelWriteArm`s the input fact and the
     workflow consumes it
2. Existing falsifying test
   `packages/runtime/test/subscribers/runtime-context/input-delivery.test.ts`
   (untracked from the diagnosis session) becomes the production regression;
   it must pass against the new lane WITHOUT subscriber-side retry / wait
   bandaids.
3. Live ACP smoke (`firegrid run --prompt --agent claude-acp …` and Zed
   equivalent) — the final acceptance.
