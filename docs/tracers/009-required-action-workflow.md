# 009: Required-Action Workflow

## Status

Historical. The runtime-local required-action workflow/service surface proved
the early durable-wait idea, but it was deleted in the required-action cleanup
lane.

Do not recreate:

- `packages/runtime/src/required-action/**`
- `RequiredActionsLive`
- `RequiredActionWorkflow`
- `RequiredActionWorkflowLayer`
- `startRequiredAction`
- `awaitRequiredActionWorkflow`

## Current Ownership

Required-action durable record schemas remain in:

```txt
packages/protocol/src/required-action/**
```

That protocol ownership satisfies:

- `firegrid-required-actions.RECORDS.1`
- `firegrid-required-actions.RECORDS.2`
- `firegrid-required-actions.RECORDS.3`
- `firegrid-required-actions.RECORDS.4`
- `firegrid-required-actions.BOUNDARY.5`

The `firegrid-required-actions.WORKFLOW.*` requirements are deprecated. Future
required-action behavior must be rebuilt through generic wait/operator tooling,
not a required-action-specific runtime mini-plane.

## Deferred Behavior

Future work should model required-action request/resolution as durable facts and
lower waiting/resume behavior through generic mechanisms such as:

```txt
effect-durable-streams facts
  -> effect-durable-operators consumer/table/projection
  -> generic wait/operator capability
  -> host-owned workflow/runtime effect
```

No client, tool, or scenario should invoke private required-action workflow
handles.

## Validation

Current validation is protocol-level only:

```bash
pnpm --filter @firegrid/protocol run test -- required-action
```

The historical `scenarios/firegrid/src/tracer-009.test.ts` placeholder was
removed after PR #166. Reintroduce a scenario only when generic wait/operator
tooling owns a current production surface.
