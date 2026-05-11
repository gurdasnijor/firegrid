# 016: Session Plane Input Control Surface

## Objective

Define the smallest stable session-plane control surface for managed-agent
interaction:

```txt
request session
  -> host-owned session/runtime start path

send input
  -> durable session input or prompt request fact
  -> host-owned dispatcher/session adapter reacts
  -> provider receives input
  -> runtime/session output facts prove the effect
```

This tracer should decide whether the current `runtime_ingress` implementation
is the right canonical shape, or whether it should collapse into clearer
session-plane facts such as session input / prompt request records.

## Why This Is Load Bearing

Most downstream features need a stable way to put input into an agent session:

- initial prompts;
- follow-up prompts;
- workflow-authored scheduled prompts;
- required-action results that become session input;
- tool-authored child-agent prompts;
- future steering or recovery inputs.

If this surface stays unclear, later tracers will keep inventing private input
paths, bespoke workflow endpoints, or per-feature planes. The session plane
should provide a small, durable, provider-neutral input model that all of those
features can reuse.

This tracer also clarifies the boundary between:

- **session plane**: user/workflow/system input facts and session output facts;
- **host plane**: configured dispatchers/adapters that react to those facts;
- **coordination plane**: durable waits, time, predicates, and decisions that
  may emit follow-up session input facts.

## Current Ground Truth

Current implementation:

```txt
packages/client/src/firegrid.ts
packages/runtime/src/runtime-host/index.ts
packages/runtime/src/runtime-ingress/**
packages/runtime/src/runtime-context/workflow.ts
packages/runtime/src/providers/sandboxes/**
```

Current public-ish surfaces:

- `@firegrid/client` exposes `launch(request)` and `open(contextId)`.
- `@firegrid/runtime` exposes `startRuntime(options)` through
  `FiregridRuntimeHost`.
- `@firegrid/runtime` exposes `appendRuntimeIngress(request)` through
  `FiregridRuntimeHost`.

Current durable input row family:

```ts
kind: "message" | "control" | "tool_result" | "required_action_result"
authoredBy: "client" | "workflow" | "tool" | "system"
payload: unknown
```

That row family was useful for tracer 012, but its name and shape still reflect
an implementation path more than a settled session-plane model.

Relevant docs:

- `docs/architecture/managed-agent-control-surface.md`
- `docs/architecture/managed-agent-runtime-target-durable-facts.md`
- `docs/tracers/012-agent-ingress-prompt-stream.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/managed-agent-primitives.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/session-prompt-adapters.md`

Relevant ACIDs:

- `firegrid-platform-invariants.AUTHORITY.8`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-agent-ingress.INGRESS.1`
- `firegrid-agent-ingress.INGRESS.2`
- `firegrid-agent-ingress.INGRESS.3`
- `firegrid-agent-ingress.INGRESS.4`
- `firegrid-agent-ingress.INGRESS.5`
- `firegrid-agent-ingress.INGRESS.6`
- `firegrid-agent-ingress.INGRESS.7`
- `firegrid-agent-ingress.DELIVERY.1`
- `firegrid-agent-ingress.DELIVERY.2`
- `firegrid-agent-ingress.DELIVERY.3`
- `firegrid-agent-ingress.DELIVERY.4`
- `firegrid-agent-ingress.DELIVERY.5`
- `firegrid-agent-ingress.HOST.1`
- `firegrid-agent-ingress.HOST.2`
- `firegrid-agent-ingress.HOST.3`
- `firegrid-agent-ingress.HOST.4`
- `firegrid-agent-ingress.SUBSCRIBERS.1`
- `firegrid-agent-ingress.SUBSCRIBERS.2`
- `firegrid-agent-ingress.SUBSCRIBERS.3`
- `firegrid-agent-ingress.BOUNDARY.1`
- `firegrid-agent-ingress.BOUNDARY.2`
- `firegrid-agent-ingress.BOUNDARY.3`
- `firegrid-agent-ingress.BOUNDARY.4`
- `firegrid-agent-ingress.BOUNDARY.5`

## Target Shape

The session plane should expose only the load-bearing control concepts:

```txt
request_session / launch
send_input / prompt
```

Do not add session-plane control verbs for cancellation, close, delivery,
event replay, tool result submission, or workflow execution in this tracer.
Those are either future provider-specific semantics, observation APIs,
runtime-authored facts, or coordination-plane capabilities.

At the package level, the tracer should aim for naming that makes the model
obvious:

```txt
session input request
  durable fact created by a client, workflow, tool, or system author

session adapter dispatch
  host-owned subscriber/operator action that feeds the live provider protocol

session output/update
  durable fact written by the runtime/provider adapter
```

If `runtime_ingress` remains the physical path for compatibility, the tracer
must document whether it is:

1. accepted target vocabulary; or
2. a transitional implementation name to be replaced by session input/prompt
   records.

## Required Design Decisions

### 1. Public Append Boundary

Decide the first production surface for sending input:

```txt
Option A: @firegrid/client prompt/sendInput API
  client appends durable input facts through configured stream endpoints

Option B: @firegrid/runtime host package API
  app/server code calls host-owned package API that appends durable input facts

Option C: both
  browser-safe client API and host package API share the same schema and
  idempotency rules
```

The decision must preserve:

```txt
client/app intent
  -> durable fact
  -> host-owned dispatcher reacts
```

It must not introduce:

```txt
client/app call
  -> workflow-specific endpoint
  -> private workflow launch path
```

### 2. Initial Input Lowering

Decide whether launch with initial input is part of this tracer.

Target rule:

```txt
launch({ runtime, input })
  -> session/runtime request fact
  -> session input fact
```

Initial input and follow-up input should not use different durable models.
If launch input is deferred, the tracer must record it as the immediate next
gap.

### 3. Fact Vocabulary

Decide whether the canonical row family is still `runtime_ingress` or a
session-oriented vocabulary.

The model should be understandable without knowing tracer 012 history. Names
such as `session_input.requested`, `prompt.requested`, or an equivalent
session-plane phrase may be clearer than `runtime_ingress.requested`.

### 4. Idempotency

Define idempotency scope for input requests.

At minimum, duplicate sends with the same logical key should not create a
second provider-visible input. Conflicting duplicate payload behavior may be
deferred, but the tracer should state whether conflict detection is in scope.

### 5. Dispatch Progress

Provider-visible delivery must have durable progress, but "deliver" should not
be a session-plane user operation.

The tracer should decide whether progress is represented as:

- an input-specific dispatched/delivered row;
- a subscriber/operator progress row;
- a provider-adapter-specific progress fact.

The important invariant is that retry after crash does not duplicate
provider-visible input.

## Expected Implementation Shape

This tracer should converge on stream-native code, not a new service hierarchy.
The intended shape is:

```txt
DurableStream<SessionInputFact>
  -> read retained/live facts
  -> fold durable progress
  -> select pending input for this runtime context
  -> perform one provider-visible adapter effect
  -> append durable progress/output facts
```

The production API may still be a package function, but the implementation
should be visibly fact-oriented:

```ts
const sessionInput = DurableStream.define({
  endpoint: { url: streams.sessionInput },
  schema: SessionInputFactSchema,
})

yield* sessionInput.append(sessionInputRequested({
  contextId,
  payload,
  idempotencyKey,
}))
```

The runtime side should look like a loop over durable facts:

```ts
const runSessionInputLoop = (options) =>
  options.sessionInput.read({ live: true }).pipe(
    Stream.filter(isRelevantSessionInput(options.contextId)),
    Stream.runForEach(input =>
      Effect.gen(function* () {
        const alreadyDelivered = yield* hasDurableDeliveryProgress(input)
        if (alreadyDelivered) return

        yield* options.adapter.send(input.payload)
        yield* options.sessionInput.append(sessionInputDispatched(input))
      }),
    ),
  )
```

The sketch is illustrative, not prescribed API. The load-bearing constraints
are:

- sending input appends a durable fact;
- provider-visible delivery is performed only by host-owned runtime code;
- delivery progress is durable;
- no caller invokes a workflow, operator, or provider adapter directly.

`packages/runtime/src/runtime-context/workflow.ts` may remain the place that
starts the live runtime for this tracer, but it should not grow further into a
per-feature composition root. If it must participate, the implementation should
move toward smaller stream-native helper functions that operate on
`DurableStream.define(...).read/append/producer` rather than adding new service
wrappers.

## Minimal Proof

Use a real local provider path rather than a mock. A small local stdin fixture
is enough.

Scenario shape:

```txt
1. client/app requests a session
2. runtime host starts the session through production surface
3. client/app sends input through the chosen production surface
4. host-owned adapter/dispatcher feeds the live local process
5. local process emits output
6. runtime/session output facts prove the input was received
7. duplicate input with the same idempotency key is not delivered twice
```

The scenario must invoke production package surfaces. It must not implement the
input append, dispatch, or provider delivery logic inside the scenario harness.

## Non-Goals

- Do not build cancellation, interrupt, pause, or close semantics.
- Do not build generic wait descriptors.
- Do not build required-action resolution.
- Do not build workflow-backed tools.
- Do not add a workflow-specific launch endpoint.
- Do not add an HTTP API unless the tracer explicitly chooses an app/server
  facade as the production surface.
- Do not make event replay/query a session control operation.
- Do not rename broad architecture only in docs without a production path and
  scenario proof.

## Write Scope

Likely:

```txt
features/firegrid/firegrid-agent-ingress.feature.yaml
features/firegrid/firegrid-client-api.feature.yaml
packages/client/src/**
packages/runtime/src/runtime-host/**
packages/runtime/src/runtime-ingress/**
packages/runtime/src/runtime-context/**
packages/runtime/src/providers/sandboxes/**
scenarios/firegrid/src/tracer-016*.test.ts
docs/architecture/managed-agent-control-surface.md
docs/tracers/README.md
```

Avoid unless the tracer makes a deliberate vocabulary decision:

```txt
packages/runtime/src/materialization/**
packages/runtime/src/required-action/**
packages/runtime/src/runtime-operators/**
```

## Acceptance Criteria

1. The tracer defines the canonical session-plane input control vocabulary.
2. The tracer exposes a production surface for sending session input.
3. The tracer preserves host-owned dispatch; callers do not invoke workflows or
   operators directly.
4. Initial and follow-up input either share the same durable model or the tracer
   records initial input as the next explicit gap.
5. Duplicate input with the same idempotency key does not cause duplicate
   provider-visible input.
6. Scenario E2E invokes production surfaces and observes durable output proving
   the provider received the input.

## Validation

Expected validation, refined by implementation scope:

```sh
pnpm --filter @firegrid/client run typecheck
pnpm --filter @firegrid/client run test
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-016
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
git diff --check
```
