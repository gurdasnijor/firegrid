# 009 Results: Required-Action Workflow

## Implemented Surface

- `packages/runtime/src/required-action/**` contains the production required-action namespace.
- Required-action request and resolution rows are durable retained JSON facts.
- `RequiredActionWorkflow` records requested state, waits on an `@effect/workflow` `DurableDeferred`, and returns the durable resolution decision.
- `RequiredActions.resolve(...)` records durable resolution state before completing the durable deferred token keyed by required action id.

## API Gap

`WorkflowInstance.waitForEvent(...)` is not present in the current `@effect/workflow` version. Tracer 009 uses `DurableDeferred` as the current durable workflow wait primitive instead. This satisfies `firegrid-required-actions.WORKFLOW.2` and aligns with `workflow-engine-durable-state.VALIDATION.2`.

## Timeout Gap

Timeout is reserved in the durable lifecycle as `timed_out`, but this tracer does not implement a timer operator for required actions. This keeps `firegrid-required-actions.WORKFLOW.6`, `durable-waits-and-scheduling.WAIT_FOR.6`, and `durable-waits-and-scheduling.WAIT_FOR.7` out of in-memory authority.

## Directory Boundary

Required actions live under `packages/runtime/src/required-action/**`. Stale `control-plane` and `data-plane` runtime directories were read for existing patterns only; they remain outside tracer 009 scope.

## Follow-Up Architecture Gap

Required-action protocol schema extraction and Durable Streams State descriptor design are intentionally deferred. Tracer 009 keeps raw retained required-action request and resolution facts in the runtime namespace so the PR remains focused on workflow wait and resolution semantics.
