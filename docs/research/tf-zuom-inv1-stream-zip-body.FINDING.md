# tf-zuom / INV-1: Stream.zipLatest runtime-context body

## Conclusion

**PASS for the INV-1 de-risking question.** A self-contained firelab sim replaced the native runtime-context workflow registration with the same workflow name (`firegrid.runtime-context`) and a custom body shaped as:

```ts
Stream.zipLatest(
  runtimeInputStream(context.contextId),
  runtimeOutputStream(context.contextId, activityAttempt),
).pipe(
  Stream.runForEach(pair => handleZipPair(context, activityAttempt, state, pair)),
)
```

The live `claude-agent-acp` run completed through two public-session prompt turns without the `Fiber.join` hang mode, without invoking the native `firegrid.runtime_context.workflow.reactive_loop`, and without creating any per-row `firegrid.durable_tools.wait_for.upsert_active` spans.

Trace path:

```text
packages/firelab/.simulate/runs/2026-05-20T07-04-33-404Z__inv1-stream-zip-body/trace.jsonl
```

`.simulate/runs` is gitignored, so the relevant trace excerpts are embedded below.

## Source-Verified Claims

- Native input ingress already uses `DurableDeferred` keyed by context and sequence (`runtimeInputDeferredFor`), so the sim reuses the same input deferred contract instead of inventing a parallel input source. See `packages/host-sdk/src/host/runtime-context-workflow-core.ts:182`.
- Native output following currently uses `WaitFor.match` over `AgentOutputAfter` (`waitForAgentOutput` / `nextAgentOutput`), then the recursive `runReactiveLoop` alternates completed input handling with output following. See `packages/host-sdk/src/host/runtime-context-workflow-core.ts:192` and `packages/host-sdk/src/host/runtime-context-workflow-core.ts:486`.
- The production workflow name is `firegrid.runtime-context`; the sim registers the replacement workflow under the same name so existing `appendRuntimeInputDeferred` completions reach the custom body. See `packages/host-sdk/src/host/runtime-context-workflow-core.ts:563` and `packages/firelab/src/simulations/inv1-stream-zip-body/host.ts:591`.
- The sim input stream is sequential over `runtimeInputDeferredFor(contextId, sequence)`. The output stream is sequential over `RuntimeAgentOutputAfterEvents.initial/after`, avoiding durable wait-store row creation while still observing `AgentOutputAfter` boundaries. See `packages/firelab/src/simulations/inv1-stream-zip-body/host.ts:232` and `packages/firelab/src/simulations/inv1-stream-zip-body/host.ts:251`.
- The custom workflow body is exactly the requested `Stream.zipLatest(inputs, outputs).runForEach(handler)` shape, with handler spans annotating both input and output sequence numbers. See `packages/firelab/src/simulations/inv1-stream-zip-body/host.ts:509` and `packages/firelab/src/simulations/inv1-stream-zip-body/host.ts:536`.

## Trace-Amplified Claims

Summary counts from the clean run:

```text
firegrid.inv1.stream_zip.workflow.register       1
firegrid.inv1.stream_zip.output.after            2
firegrid.inv1.stream_zip.body.run                8
firegrid.inv1.stream_zip.pair                    12
firegrid.inv1.stream_zip.input.handle            12
firegrid.inv1.stream_zip.output.handle           12
firegrid.runtime_output.per_context.event.append 16
firegrid.durable_tools.wait_for.upsert_active    0
firegrid.runtime_context.workflow.reactive_loop  0
firegrid.simulation.run                          1
outcome                                          DriverCompleted
pairTags                                         {"Ready":11,"Status":1}
```

Representative zipped body spans:

```json
{"name":"firegrid.inv1.stream_zip.pair","attributes":{"firegrid.input.sequence":1,"firegrid.runtime.output.sequence":0,"firegrid.agent_output.event_tag":"Ready"}}
{"name":"firegrid.inv1.stream_zip.pair","attributes":{"firegrid.input.sequence":1,"firegrid.runtime.output.sequence":1,"firegrid.agent_output.event_tag":"Status"}}
```

Representative output observation spans:

```json
{"name":"firegrid.inv1.stream_zip.output.after","attributes":{"firegrid.runtime.output.after_sequence":-1,"firegrid.inv1.output.initial_hit":true}}
{"name":"firegrid.inv1.stream_zip.output.after","attributes":{"firegrid.runtime.output.after_sequence":0,"firegrid.inv1.output.initial_hit":true}}
```

The public driver used the real `claude-agent-acp` planner and required both markers:

```text
FIREGRID_INV1_FIRST_READY
FIREGRID_INV1_SECOND_DONE
```

Driver implementation evidence is in `packages/firelab/src/simulations/inv1-stream-zip-body/driver.ts:44` for the `claude-agent-acp` runtime and `packages/firelab/src/simulations/inv1-stream-zip-body/driver.ts:83` for the wait loop that sends turn 2 only after turn 1 output is observed.

## Acceptance Verdict

- **No Fiber.join hang:** accepted. The run stopped with `outcome=DriverCompleted` after the two-turn driver completed.
- **No per-row durable wait-store upsert:** accepted. The trace contains zero `firegrid.durable_tools.wait_for.upsert_active` spans.
- **Native reactive loop replaced:** accepted. The trace contains one `firegrid.inv1.stream_zip.workflow.register` span and zero `firegrid.runtime_context.workflow.reactive_loop` spans.
- **Stream body folds input/output boundaries:** accepted for INV-1. The body paired the latest input sequence `1` against output sequence `0` (`Ready`) and then output sequence `1` (`Status`), proving the body can advance on output observation boundaries after both streams have initial values.

## Notes

The sim is intentionally self-contained under `packages/firelab/src/simulations/inv1-stream-zip-body/` and does not modify `packages/host-sdk/test` or `packages/runtime/test`.

This finding validates the architectural shape for SDD_FIREGRID_ONE_SUBSTRATE Step 4. It is not a production refactor; productionizing should still decide whether the output stream should use the `RuntimeAgentOutputAfterEvents.initial/after` substrate directly, or a durable-deferred bridge, based on the desired replay and cancellation semantics.
