# 013: Reactive Workflow Operators

## Objective

Define the generic runtime-host-owned operator substrate that lets Firegrid
react to durable facts, durable time, or projection predicates by running
Effect workflows.

The load-bearing claim is:

```txt
durable fact / durable time / projection predicate
  -> generic reactive operator observes eligibility
  -> deterministic workflow execution id
  -> Effect workflow runs or resumes through the configured workflow engine
  -> follow-up facts are appended through existing authority surfaces
```

This tracer exists because required actions, workflow-backed tools, scheduled
prompts, runtime ingress subscribers, and future trigger-based behavior are all
the same architectural class. None of them should add bespoke runtime-host
methods, bespoke stream topology, or a private workflow launch path.

## Ground Truth

Current code already proves useful pieces:

- `packages/durable-streams/src/DurableStreamsWorkflowEngine.ts` provides a
  Durable Streams-backed `@effect/workflow` engine and workflow state store.
- `packages/runtime/src/required-action/workflow.ts` proves
  `Workflow.make`, `Workflow.toLayer`, `DurableDeferred.token`, and
  `DurableDeferred.await` can express a durable external decision wait.
- `packages/runtime/src/required-action/service.ts` proves request and
  resolution facts can be retained and folded deterministically.
- `packages/runtime/src/runtime-host/index.ts` is currently the production
  host root for runtime context execution.

The gap is that required actions are too specific to be the substrate. They
should become the first consumer of a generic operator runtime.

Relevant ACIDs:

- `firegrid-reactive-workflow-operators.OPERATOR.1`
- `firegrid-reactive-workflow-operators.OPERATOR.2`
- `firegrid-reactive-workflow-operators.OPERATOR.3`
- `firegrid-reactive-workflow-operators.OPERATOR.4`
- `firegrid-reactive-workflow-operators.REPLAY.1`
- `firegrid-reactive-workflow-operators.REPLAY.2`
- `firegrid-reactive-workflow-operators.REPLAY.3`
- `firegrid-reactive-workflow-operators.WORKFLOW.1`
- `firegrid-reactive-workflow-operators.WORKFLOW.2`
- `firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.1`
- `firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.4`
- `firegrid-reactive-workflow-operators.INGRESS_CONSUMER.1`
- `firegrid-platform-invariants.AUTHORITY.8`

## Effect Workflow Alignment

Effect's workflow shape is the right abstraction boundary:

```ts
const SomeWorkflow = Workflow.make({
  name: "some-workflow",
  payload: PayloadSchema,
  success: SuccessSchema,
  error: ErrorSchema,
  idempotencyKey: payload => payload.id,
})

const SomeWorkflowLayer = SomeWorkflow.toLayer((payload, executionId) =>
  Effect.gen(function* () {
    // Activities, durable clock, durable deferred, and normal Effects.
  }),
)
```

The workflow definition remains separate from the workflow engine
implementation. `@firegrid/durable-streams` supplies the engine; runtime
operators supply the durable fact subscriptions and deterministic workflow
execution ids.

Do not create Firegrid-specific workflow launch endpoints. Operators call
workflow execution internally after observing durable eligibility.

## Target Runtime Shape

Implementation should start in `@firegrid/runtime`, not a new package:

```txt
packages/runtime/src/runtime-operators/
  OperatorDescriptor.ts
  OperatorSource.ts
  OperatorRuntime.ts
  OperatorProgress.ts
  index.ts
```

The exact file names can change, but the concepts should remain:

- **descriptor**: stable operator id, source id, workflow target, idempotency
  derivation, and retry/progress policy;
- **source**: retained snapshot plus live-follow or scan source over durable
  facts, time, or projection predicates;
- **runtime**: scoped program that turns eligible facts into workflow
  executions;
- **progress**: durable cursor, checkpoint, or deterministic idempotency proof
  used to survive restart.

Sketch:

```ts
interface ReactiveWorkflowOperator<Fact, Payload> {
  readonly operatorId: string
  readonly source: OperatorSource<Fact>
  readonly select: (fact: Fact) => Option.Option<Payload>
  readonly executionId: (payload: Payload) => string
  readonly workflow: Workflow.Workflow<Payload, unknown, unknown>
}

interface OperatorRuntime {
  readonly run: <Fact, Payload>(
    operator: ReactiveWorkflowOperator<Fact, Payload>,
  ) => Effect.Effect<OperatorRunSummary, OperatorError, Scope.Scope>
}
```

This is intentionally generic. Required-action requests, runtime ingress
delivery, scheduled prompts, and `wait_for` can all supply different sources and
workflows without changing the host root API.

## Required-Action Consumer Shape

Required actions should be refactored toward:

```txt
required_action.requested fact
  -> RequiredActionOperator selects request
  -> RequiredActionWorkflow.execute({ requiredActionId })
  -> workflow records/observes request, waits on durable resolution
  -> required_action.resolved fact resumes workflow
```

For tracer 013, the minimum proof can keep the existing
`RequiredActionWorkflow` but must remove any pressure to add
`host.requiredActions.*` methods. The operator runtime owns the subscription;
the required-action service owns request/resolution facts; the workflow engine
owns suspension and resume.

## Runtime Host Composition

The host root may select operators, but it should not grow one method per
operator.

Acceptable:

```ts
FiregridRuntimeHostLive({
  streams,
  operators: [
    requiredActionOperator(),
    runtimeIngressDeliveryOperator(),
  ],
})
```

Not acceptable:

```ts
host.startRequiredAction(...)
host.resolveRequiredAction(...)
host.requiredActionRows(...)
```

The runtime host owns topology and starts operator programs. Domain-specific
facts are appended through their owning surfaces.

## Minimal Proof

Implement one generic operator runtime and one required-action consumer.

Scenario proof should show:

```txt
append required_action.requested through production surface
  -> operator observes durable request
  -> workflow reaches durable wait
  -> append required_action.resolved through production surface
  -> workflow resumes and terminalizes
  -> restart/rescan does not create duplicate logical workflow execution
```

The scenario must invoke production package surfaces and assert retained
durable rows or workflow results. It must not wire a scenario-only workflow
launcher.

## Non-Goals

- Do not implement runtime ingress delivery in this tracer.
- Do not implement `sleep`, `wait_for`, `schedule_me`, or `spawn`.
- Do not define product permission UI, callbacks, webhooks, provider tool
  transports, MCP, ACP, or chat schemas.
- Do not add an HTTP/RPC workflow invocation endpoint.
- Do not introduce a new package until the runtime-local shape has been proven.
- Do not regenerate dependency graphs or edit
  `docs/architecture/current-architecture-alignment-review.md`.

## Acceptance Criteria

1. A generic reactive operator runtime exists as a production `@firegrid/runtime`
   surface.
2. Required actions use the generic operator runtime or are explicitly staged as
   its first consumer without host-specific required-action topology.
3. Operator execution derives deterministic workflow execution ids from
   operator identity and durable input identity.
4. Operator replay/rescan behavior is safe after process restart.
5. Operator follow-up effects use existing authority surfaces.
6. Scenario proof invokes production package surfaces and observes durable
   outcomes across the operator boundary.

## Validation

Expected validation:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-013
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```

## References

- Effect Workflow package source:
  <https://github.com/Effect-TS/effect/tree/main/packages/workflow/src>
- Effect `Workflow.make` / `Workflow.toLayer` source:
  <https://github.com/Effect-TS/effect/blob/main/packages/workflow/src/Workflow.ts>
- Effect Cluster workflow engine integration example:
  <https://github.com/Effect-TS/effect/blob/main/packages/cluster/src/ClusterWorkflowEngine.ts>
- Firegrid Durable Streams workflow engine:
  `packages/durable-streams/src/DurableStreamsWorkflowEngine.ts`
- Firegrid required-action workflow:
  `packages/runtime/src/required-action/workflow.ts`
- Firegrid required-action service:
  `packages/runtime/src/required-action/service.ts`
