# 013: Reactive Workflow Operators

## Status

Historical. The runtime-local `packages/runtime/src/runtime-operators/**`
surface proved useful as a tracer, but it was deleted in the required-action
cleanup lane after `effect-durable-operators` became the accepted generic
operator substrate.

Do not recreate `ReactiveWorkflowOperatorRuntime`,
`runReactiveWorkflowOperator`, or a runtime-local `OperatorSource.scan`
abstraction. New durable consumers should use:

```txt
effect-durable-streams DurableStream
  -> effect-durable-operators ConsumerSource
  -> effect-durable-operators DurableConsumer
  -> effect-durable-operators ConsumerCheckpointStoreLive
```

## Replacement Status

No replacement required-action operator is introduced by this cleanup.
Required-action runtime workflow/service semantics were deleted; only protocol
durable record schemas remain while workflow/operator architecture moves to the
generic `effect-durable-operators` package.

The rejected shape is:

```txt
required_action.requested fact
  -> required-action-specific operator module
  -> private required-action workflow launch wrapper
  -> required-action-specific mini composition root
```

Use generic operators directly in future tracers; do not reintroduce a
`required-action/operator.ts` replacement unless it is a genuinely reusable
operator outside required-action vocabulary.

The active generic operator references are:

- `effect-durable-operators.CONSUMER.1`
- `effect-durable-operators.CONSUMER.2`
- `effect-durable-operators.CONSUMER.5`
- `effect-durable-operators.SOURCE.1`
- `effect-durable-operators.FIREGRID_PROOF.1`
- `effect-durable-operators.FIREGRID_PROOF.2`
- `effect-durable-operators.FIREGRID_PROOF.3`

The deprecated `firegrid-reactive-workflow-operators.*` ACIDs are retained only
as historical decision log entries.

## Boundary Rules

- Required actions must not expose a required-action-specific mini composition
  root such as `RequiredActionRuntimeLive`.
- Required-action scenarios must not compose a required-action-specific
  workflow engine/service stack. Required-action behavior is deferred to future
  generic wait/operator tooling.
- Clients and tools append durable facts; they do not invoke private workflow
  handles or runtime-local operator endpoints.
- Runtime ingress subscribers and future workflow-backed tools should build on
  the generic durable operator package, not this historical tracer surface.

## Validation

The current proof lives in:

- `packages/protocol/src/required-action/schema.test.ts`
- `scenarios/firegrid/src/tracer-009.test.ts` is skipped because the runtime
  workflow surface is historical.
- `scenarios/firegrid/src/tracer-013.test.ts` is skipped because the tracer's
  original surface is deprecated.

Run:

```bash
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid test -- tracer-009
pnpm --filter @firegrid/scenario-firegrid test -- tracer-013
```
