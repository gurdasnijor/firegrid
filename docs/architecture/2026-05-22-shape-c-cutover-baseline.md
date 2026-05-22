# Shape C Cutover Baseline

Doc-Class: internal-contract
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

Baseline branch: `rearch/shape-c-cutover`
Baseline commit: `2e2e74283383e11936a885d931e20f5454e5ce7f`

This is the pre-cutover line/module baseline for the greenfield Shape C
RuntimeContext rewrite. The final cutover PR must report the same groups after
the rewrite and explain any net-positive movement.

## Groups

| Group | Modules | Lines |
|---|---:|---:|
| RuntimeContext state/input/output handling | 8 | 2731 |
| Tool dispatch and tool result handling | 5 | 377 |
| Output observation and transition handling | 5 | 541 |
| Wait routing / observation matching | 3 | 583 |

These groups intentionally overlap where one current module carries multiple
responsibilities. The final report should show both group deltas and the
deduplicated deletion map.

## RuntimeContext State/Input/Output Handling

```text
429 packages/runtime/src/kernel/runtime-context-workflow-runtime.ts
388 packages/runtime/src/agent-event-pipeline/session-byte-stream-adapter.ts
209 packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts
 71 packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts
369 packages/runtime/src/workflow-engine/runtime-context-state.ts
171 packages/runtime/src/workflow-engine/runtime-input-deferred.ts
166 packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts
928 packages/runtime/src/workflow-engine/workflows/runtime-context.ts
2731 total
```

## Tool Dispatch And Tool Result Handling

```text
 26 packages/runtime/src/agent-event-pipeline/tool-execution/index.ts
 27 packages/runtime/src/agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts
268 packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts
 21 packages/runtime/src/workflow-engine/workflows/tool-call.ts
 35 packages/runtime/src/workflow-engine/tool-execution/runtime-tool-use-executor.ts
377 total
```

## Output Observation And Transition Handling

```text
 50 packages/runtime/src/channels/session-agent-output.ts
 67 packages/runtime/src/channels/session-agent-output-route.ts
209 packages/runtime/src/agent-event-pipeline/authorities/per-context-output.ts
 71 packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts
144 packages/runtime/src/streams/runtime-observation-streams.ts
541 total
```

## Wait Routing / Observation Matching

```text
268 packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts
144 packages/runtime/src/streams/runtime-observation-streams.ts
171 packages/runtime/src/workflow-engine/workflows/wait-for.ts
583 total
```

## Final Gate

The cutover is succeeding if:

- `RuntimeContextWorkflowNative` as a context-lifetime body is deleted;
- the per-sequence RuntimeContext input `DurableDeferred` mailbox is deleted;
- RuntimeContext state no longer scans dense raw output for transition progress;
- tool and wait execution use Shape C unless a Shape D capability is explicitly
  justified;
- the cumulative line/module delta for these groups is negative, or any
  positive movement is justified by a named target-shaped capability.
