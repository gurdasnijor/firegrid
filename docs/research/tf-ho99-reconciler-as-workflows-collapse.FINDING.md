# FINDING — tf-ho99: control-request reconciler as workflows

## Verdict

GREEN, Path C hybrid.

The client-facing durable control request rows remain the SDK compatibility
surface:

- `RuntimeContextRequestRow`
- `RuntimeStartRequestRow`
- `RuntimeLifecycleRequestRow`
- `RuntimeControlRequestCompletionRow`

The old `RuntimeControlRequestClaimRow` table is now obsolete internal
coordination. Request ownership moves to the namespace-scoped
`DurableStreamsWorkflowEngine` installed by
`RuntimeControlRequestWorkflowEngineLive`.

## Implemented Shape

Three request workflow types now exist in
`packages/host-sdk/src/host/control-request-reconciler.ts`:

- `RuntimeContextProvisionWorkflow(context request)`
- `RuntimeStartWorkflow(start request)`
- `RuntimeLifecycleWorkflow(lifecycle request)`

`RuntimeContextProvisionWorkflow` performs host materialization inside a
workflow `Activity`, so concurrent hosts compete through workflow activity
claims instead of the legacy control-request claim table.

`RuntimeStartWorkflow` and `RuntimeLifecycleWorkflow` are durable dispatch
claim workflows. They decide the host-local request owner through workflow
execution state, then run the existing `startRuntime` / lifecycle side effect
outside the control workflow body. This avoids nesting a runtime-context
workflow execution inside a control-request workflow body while still replacing
the reconciler's claim/fan-out authority with engine execution semantics.

## Evidence

`packages/host-sdk/test/host/control-request-reconciler.test.ts` now asserts:

- materialize+start writes no legacy control-request claims;
- workflow executions exist for context and start request ids;
- context provisioning has exactly one workflow activity owner under concurrent
  host scans;
- legacy claim-window rows are ignored by the new workflow-owned coordination;
- `firegrid-workflow-driven-runtime.VALIDATION.9` still proves a second
  context can start while a first start request remains long-running.

Targeted validation:

```text
pnpm --filter @firegrid/host-sdk typecheck
pnpm --filter @firegrid/host-sdk exec vitest run test/host/control-request-reconciler.test.ts
```

Both pass locally.

## INV-5 Tie

INV-5's multi-context activation gap was caused by reconciler-side serial
authority around long-running starts. The updated validation keeps the
multi-context regression guard but changes the mechanism: dispatch now creates
request-specific workflow executions, and the long-running runtime start no
longer blocks the reconciler from dispatching the next context's request.

## Remaining Boundary

This is Path C hybrid, not Path A. Durable request/completion rows stay public
for SDK compatibility. Deleting the request rows entirely still requires a
separate compatibility decision.
