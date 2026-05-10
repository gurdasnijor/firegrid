# 009 Results: Required-Action Workflow

## Implemented Surface

- `packages/runtime/src/required-action/**` contains the production required-action namespace.
- `@firegrid/protocol/required-action` owns shared required-action request,
  resolution, row, and state schemas.
- Required-action request and resolution rows are durable retained JSON facts.
- `RequiredActionWorkflow` records requested state, waits on an `@effect/workflow` `DurableDeferred`, and returns the durable resolution decision.
- `RequiredActions.resolve(...)` records durable resolution state before completing the durable deferred token keyed by required action id.

## API Gap

`WorkflowInstance.waitForEvent(...)` is not present in the current `@effect/workflow` version. Tracer 009 uses `DurableDeferred` as the current durable workflow wait primitive instead. This satisfies `firegrid-required-actions.WORKFLOW.2` and aligns with `workflow-engine-durable-state.VALIDATION.2`.

## Timeout Gap

Timeout is reserved in the durable lifecycle as `timed_out`, but this tracer does not implement a timer operator for required actions. This keeps `firegrid-required-actions.WORKFLOW.6`, `durable-waits-and-scheduling.WAIT_FOR.6`, and `durable-waits-and-scheduling.WAIT_FOR.7` out of in-memory authority.

## Directory Boundary

Required actions live under `packages/runtime/src/required-action/**`, with
durable record schemas exported from
`packages/protocol/src/required-action/**`.

## Ownership Resolution

Required-action protocol schema extraction is complete for
`firegrid-required-actions.RECORDS.4` and
`firegrid-required-actions.BOUNDARY.5`. Required-action topology is
intentionally not integrated into `FiregridRuntimeHostLive` as bespoke host
methods. `firegrid-required-actions.WORKFLOW.7`,
`firegrid-required-actions.BOUNDARY.6`, and
`firegrid-platform-invariants.AUTHORITY.8` require the generic reactive
workflow/operator substrate from tracer 013 before required actions become the
model for workflow-backed tools.
