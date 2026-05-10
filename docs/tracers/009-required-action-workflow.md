# 009: Required-Action Workflow

## Objective

Prove that human-in-the-loop required actions are durable workflow waits over
durable event/projection state, not callbacks, process-local promises, or
launch-workflow special cases.

The load-bearing claim is:

```txt
runtime-output or tool event requests a required action
  -> required-action workflow records pending durable state
  -> workflow durably waits for resolution or timeout
  -> resolution resumes the blocked operation through workflow machinery
  -> response/input decision is durably recorded
```

This tracer provides the semantic foundation for permissions, approval gates,
`wait_for`, workflow-backed tools, and later agent `spawn(...)` interactions.

## Why This Is Load Bearing

Permissions are not a provider callback package. They are runtime workflow
behavior over durable facts.

The same pattern should support:

- tool-call approval;
- prompt-level fallback approval when a runtime cannot intercept tool calls;
- `wait_for(trigger, timeoutMs?)`;
- workflow-backed tools that durably suspend;
- future external UI/API resolution flows.

If this tracer gets the wait/resolution model wrong, every downstream tool and
permission design will inherit the wrong authority boundary.

## Relationship To Existing 003

Tracer 003 sketched a permission workflow over runtime events. Tracer 009 should
be the sharper version:

- use `required action` as the architectural vocabulary;
- model approval as an Effect workflow wait;
- keep callbacks and notification delivery out of the semantic boundary;
- record durable pending and terminal state.

Tracer 003 can remain a narrow historical sketch. Tracer 009 is the one to run
when implementing the required-action path.

## Relationship To Parallel Tracers

Tracer 006 owns runtime host root. Tracer 008 owns materialization strategy.
Tracer 009 should not require either to be finished.

Build a production required-action workflow surface that can later be wired into
the host root and materialization strategy. Scenario tests may provide concrete
layers, but the workflow and state services must live in package source.

## Current References

Relevant existing specs and docs:

- `durable-waits-and-scheduling.WAIT_FOR.1`
- `durable-waits-and-scheduling.WAIT_FOR.6`
- `durable-waits-and-scheduling.WAIT_FOR.7`
- `run-wait-primitives.RUN_WAIT_API.2`
- `run-wait-primitives.RUN_WAIT_API.8`
- `run-wait-primitives.BOUNDARY.1`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/durable-state-awaitables-approvals-timers.md`

The current specs are generic wait/run primitives. Add or extend a Firegrid
feature spec before implementation if the required-action domain needs stable
ACIDs for request/resolution rows.

## Target Shape

Preferred runtime package shape:

```txt
packages/runtime/src/required-action/
  schema.ts
  ids.ts
  service.ts
  workflow.ts
  launcher.ts
  index.ts
```

If tracer 006 has established a different runtime-kernel layout, follow that
layout while preserving the same boundary.

Minimum durable records:

```txt
required_action.requested
required_action.resolved
```

The projection/state should expose a single logical lifecycle:

```txt
requested -> approved | denied | timed_out | cancelled | failed
```

Timeout may be implemented in one of two ways for this tracer:

1. as a durable workflow timeout that records a terminal required-action row; or
2. as a documented non-goal with the state shape already reserving
   `timed_out`.

Do not make timeout an in-memory-only failure.

## Workflow Shape

Implementation should be close to:

```ts
const RequiredActionWorkflow = Workflow.make({
  name: "required-action",
  payload: RequiredActionPayload,
  success: RequiredActionDecision,
  error: RequiredActionError,
  idempotencyKey: payload => payload.requiredActionId,
})

const RequiredActionWorkflowLayer = RequiredActionWorkflow.toLayer(
  Effect.fn(function* (payload) {
    yield* appendRequiredActionRequested(payload)

    const decision = yield* waitForRequiredActionResolution(payload, {
      timeout: payload.expiresAt,
    })

    yield* appendRequiredActionTerminal(decision)

    return decision
  }),
)
```

Use the current `@effect/workflow` durable primitives available in the repo. If
`WorkflowInstance.waitForEvent(...)` is not available as a real API, model the
wait through the closest existing durable workflow/deferred mechanism and record
the API gap explicitly.

## Resolution Surface

Expose a package function or service for external resolution:

```ts
yield* RequiredActions.resolve({
  requiredActionId,
  selectedOptionId,
  outcome: "approved",
  resolvedBy,
})
```

This function appends durable resolution state and resumes/unblocks the
workflow through workflow-engine machinery. It must not resolve a process-local
callback as authority.

## Non-Goals

- Do not implement an approval UI.
- Do not introduce an HTTP callback package.
- Do not build tool-call interception for a real ACP/Claude provider.
- Do not couple required actions to session materialization.
- Do not add workflow-backed tools yet; tracer 010 owns that.
- Do not make launch workflow parse provider-specific permission schemas.

## Write Scope

Primary:

```txt
packages/runtime/src/required-action/**
packages/runtime/src/index.ts
features/firegrid/*required*action*.feature.yaml
features/firegrid/durable-waits-and-scheduling.feature.yaml
features/firegrid/run-wait-primitives.feature.yaml
scenarios/firegrid/src/tracer-009*.test.ts
```

Avoid:

```txt
packages/runtime/src/runtime-host/**
packages/runtime/src/data-plane/materialization/**
packages/runtime/src/data-plane/execution/sandbox/**
scenarios/firegrid/src/tracer-001.test.ts
scenarios/firegrid/src/tracer-002.test.ts
```

If a tiny runtime-output fixture is needed, create one inside the tracer 009
scenario rather than changing tracer 001.

## Acceptance Criteria

1. Required-action request and resolution durable record schemas exist.
2. A required-action workflow records pending state before waiting.
3. Resolution is durable and idempotent by required-action id.
4. Conflicting resolution after terminal state does not change the winning
   terminal decision.
5. The workflow resumes from durable resolution state and returns the decision.
6. Timeout is either implemented as a durable terminal state or explicitly
   documented as the next tracer gap; it is not represented as an in-memory-only
   failure.
7. Scenario proof invokes package production surfaces and observes durable
   required-action state.
8. Launch/runtime-output code remains unaware of provider-specific required
   action semantics.

## Validation

Run the relevant checks for the implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-009
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```

Adjust the scenario test selector to the actual tracer 009 file name.

## Questions To Answer

- What durable workflow primitive should Firegrid use today for “wait until
  external resolution”: `DurableDeferred`, a retained stream/projection wait, or
  a small adapter around the current workflow engine?
- Should required-action state live in control-plane State Protocol rows,
  data-plane raw journal rows, or a dedicated projection stream?
- What is the minimal state schema that supports tool-call approval later
  without baking in ACP or product session vocabulary now?
- Where does timeout authority belong: the waiting workflow, a timer operator,
  or a required-action operator?
- How should a denied approval map to a future runtime input/tool-result row
  without this tracer owning a real provider adapter?
