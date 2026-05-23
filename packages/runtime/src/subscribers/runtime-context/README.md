# subscribers/runtime-context/

SHAPE: C

Stateful per-event RuntimeContext handler. The `R` channel may name
`RuntimeContextStateStore` (state — imported from
`@firegrid/runtime/tables/runtime-context-state`) and the channel/clock tags
it dispatches into. It MUST NOT name `WorkflowEngine`, `WorkflowInstance`,
or use `Activity.make` / `DurableDeferred` / parked-body patterns.

Wave 2 lands `handleRuntimeContextEvent`, `state-ops.ts`, and
`action-dispatch.ts` here, moving from
`packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/`.
Reserved public subpath: `@firegrid/runtime/subscribers/runtime-context`.

The fact-matrix dispatch primitive (`runtime-keyed-subscriber/`) wires this
handler to its keyed event source.
