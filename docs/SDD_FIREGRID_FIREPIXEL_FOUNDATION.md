# SDD: Firegrid As Firepixel Foundation

Status: Draft
Product: Firegrid
Related:
- `client-event-plane-registration`
- `firegrid-runtime-process`
- `run-wait-primitives`
- `durable-waits-and-scheduling`
- `claim-and-operator-authority`

## Summary

Firegrid can be a substrate foundation for a Firepixel-style managed-agent
runtime, but the proof must be app-shaped rather than another Fireline-shaped
EventStream example. Higher layers define stateful domain row families with
`EventPlane`, run typed operations with `Firegrid.handler`, emit domain rows
from inside handlers, suspend and resume through `RunWait`, and inspect durable
outcomes while Firegrid keeps ownership of operation dispatch, completion
authority, ready-work derivation, claims, and terminal run authorship.

The target shape is:

```txt
client appends intent
runtime handler claims and runs through Firegrid
handler emits app-owned EventPlane rows such as prompt chunks or permissions
handler waits through RunWait when it needs durable external state
stock subscribers resolve substrate completions
ready-work resumes the same handler
runtime terminalizes the operation through substrate authority
read-only inspection proves the domain rows and terminal state
```

Firegrid owns durable execution mechanics. Firepixel owns prompt/session/tool
vocabulary, row schemas, permission policy, provider adapters, and UX
semantics.

## Prior Art And Avoiding Duplication

Permission-like waits are already covered with `EventStream` scenarios:

- `scenarios/firegrid/src/emitters/wait-for.ts`
- `scenarios/firegrid/src/receivers/wait-for-receiver.ts`
- `scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts`

Those prove descriptor-scoped event rows plus projection-match completion
resolution. The Firepixel foundation work must not duplicate that with renamed
permissions. Its value is proving `EventPlane` as the stateful row-family
surface: primary-keyed rows, materialized projection reads, and app-owned state
that can drive substrate waits without becoming Firegrid-native row families.

## Public EventPlane Boundary

`EventPlane` is the app-facing surface for stateful higher-layer row families
with projections:

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
```

App-owned runtime entrypoints use this non-kernel import path when composing a
plane `Producer` and `Projection` service:

```ts
const FirepixelPlane = EventPlane.define({
  name: "firepixel",
  state: FirepixelState,
})

const runtime = Layer.mergeAll(
  Firegrid.handler(PromptOperation, (input) =>
    Effect.gen(function* () {
      const producer = yield* FirepixelPlane.Producer
      yield* producer.emit(
        FirepixelPlane.state.promptChunks.insert({
          value: {
            chunkId: input.chunkId,
            promptId: input.promptId,
            text: "started",
          },
        }),
      )
      return { promptId: input.promptId }
    }),
  ),
).pipe(
  Layer.provide(EventPlane.layer(FirepixelPlane, { streamUrl })),
)
```

The handler does not import `@firegrid/substrate/kernel`, raw Durable Streams
APIs, or `@firegrid/client`.

## EventPlane Versus EventStream

Use `EventPlane` when the higher layer needs a stateful durable row family:

- prompt chunks,
- permission requests and resolutions,
- tool invocation requests and results,
- runtime or provider observations,
- session state,
- app-specific terminal projections.

Use `EventStream` when the higher layer needs a descriptor-scoped stream of
events without a full caller-owned state schema or projection service.

The two surfaces can coexist. `EventStream` remains useful for lightweight
descriptor-driven event emission and replay. `EventPlane` is the preferred
surface for Firepixel-style row families that need state, primary keys,
projection reads, and projection-match evaluation.

## App-Facing Runtime Shape

The intended app-owned runtime composition is:

```ts
const runtime = Layer.mergeAll(
  Firegrid.subscribers.projectionMatch({
    evaluate: (_substrateSnapshot, trigger) =>
      Effect.gen(function* () {
        const projection = yield* FirepixelPlane.Projection
        return yield* projection.snapshot({
          label: "firepixel.permission.match",
          authority: "observational",
          evaluate: (snapshot) =>
            Effect.succeed(matchPermission(snapshot, trigger)),
        })
      }),
  }),
  Firegrid.handler(PromptOperation, (input) =>
    Effect.gen(function* () {
      const producer = yield* FirepixelPlane.Producer

      yield* producer.emit(
        FirepixelPlane.state.promptChunks.insert({
          value: {
            chunkId: input.chunkId,
            promptId: input.promptId,
            text: "started",
          },
        }),
        {
          idempotencyKey: input.chunkId,
          correlationId: input.promptId,
        },
      )

      yield* producer.emit(
        FirepixelPlane.state.permissions.insert({
          value: {
            permissionId: input.permissionId,
            promptId: input.promptId,
            state: "requested",
          },
        }),
      )

      const decision = yield* (yield* RunWait).for(input.permissionTrigger, {
        resultSchema: PermissionDecision,
      })

      return { promptId: input.promptId, decision }
    }),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      EventPlane.layer(FirepixelPlane, { streamUrl }),
      RunWait.layer({ streamUrl }),
      triggerMatchersLayer(...),
    ),
  ),
)
```

Important boundaries:

- The plane rows are app-owned domain state.
- The projection-match completion is substrate-owned wait authority.
- Ready-work and terminal run authorship stay substrate-owned.
- The handler does not import raw Durable Streams APIs.
- The runtime entrypoint does not import `@firegrid/substrate/kernel`.

## Ordering And Lifecycle Contracts

`PlaneProducer.emit(...)` must be treated as a durable sequencing boundary: if a
handler yields an emit and then yields `RunWait.for(...)`, the emitted row must
already be appended to the Durable Streams stream before the wait is authored or
resumed. Firepixel-style adapters rely on this when a handler records
`permission.requested` before suspending for a decision.

App-owned adapter resources also need an Effect Scope story. ACP servers,
Claude Code subprocesses, MCP transports, provider streams, and sandbox
supervisors are not Firegrid concepts, but their Layers must be composable into
the same `run({ connection, runtime })` runtime graph so interruption
finalizes them with the Firegrid runtime scope.

## Required Scenario Proofs

### FP1: Public EventPlane Boundary

Prove `EventPlane` is importable without `@firegrid/substrate/kernel`.

Acceptance:

- `EventPlane`, `EventPlaneDefinition`, `EventPlaneLayerConfig`,
  `PlaneProducer`, `PlaneProjection`, `PlaneProjectionQuery`, `PlaneSnapshot`,
  `RowAuthority`, and producer/projection error types are available through
  `@firegrid/substrate/event-plane`.
- App-facing examples use the non-kernel import path.
- Public-surface tests cover the exported shape.

ACIDs:

- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.BOUNDARY.6`

### FP2: Firepixel Emit-Then-Wait Path

Prove a handler can emit typed Firepixel-style rows and then suspend on a wait
whose matcher reads those rows through `EventPlane` projection state.

Acceptance:

- Scenario defines a caller-owned `EventPlane` with prompt chunk and permission
  collections.
- Receiver composes `EventPlane.layer(...)`, `RunWait.layer(...)`, stock
  subscribers, `Firegrid.handler(...)`, and `run(...)`.
- Handler emits a prompt chunk and a `permission.requested` row through
  `PlaneProducer.emit(...)`.
- Handler then calls `RunWait.for(..., { resultSchema })`.
- Projection-match evaluator reads caller-owned `PlaneProjection` state by
  primary key rather than scanning a one-shot `EventStream` row.
- Self-test appends or emits a `permission.resolved` row through the same
  EventPlane surface.
- Inspection proves prompt chunk, permission request, permission resolution,
  resolved completion, no ready work, and terminal operation state.
- No raw stream writer is used in the handler or receiver.

ACIDs:

- `client-event-plane-registration.PRODUCER_API.6`
- `client-event-plane-registration.PROJECTION_API.6`
- `client-event-plane-registration.FIREPIXEL_PROFILE.1`
- `client-event-plane-registration.FIREPIXEL_PROFILE.2`
- `client-event-plane-registration.FIREPIXEL_PROFILE.3`
- `firegrid-runtime-process.SCENARIOS.20`
- `run-wait-primitives.RUN_WAIT_API.8`
- `durable-waits-and-scheduling.WAIT_FOR.9`

### FP3: Adapter Scope Contract

Prove app-owned long-lived adapter resources compose into the same runtime
Effect Scope as Firegrid.

Acceptance:

- Scenario or focused runtime test defines a minimal app-owned adapter Layer
  with acquisition and finalizer.
- The adapter Layer is required by a `Firegrid.handler` and provided alongside
  `EventPlane.layer(...)` and `RunWait.layer(...)`.
- Interrupting `run({ connection, runtime })` finalizes the adapter resource.
- The adapter does not require Firegrid-specific process launchers or kernel
  imports.

ACIDs:

- `firegrid-runtime-process.RUNTIME_RUN_API.11`
- `firegrid-runtime-process.EFFECT_PLATFORM.6`

### FP4: Tool Invocation Path

Prove tool invocation is app-owned EventPlane state, not a Firegrid-native
concept.

Acceptance:

- Scenario defines tool descriptor / invocation request / invocation result
  rows in a caller-owned EventPlane.
- Handler emits the invocation request row.
- A scenario self-test appends a result row or runs a minimal in-process tool
  adapter owned by the scenario.
- Handler resumes or completes from durable observation.
- Firegrid does not interpret tool names, transports, credentials, ACP, MCP, or
  provider semantics.

Scenario commands:

```sh
pnpm --filter @firegrid/scenarios run firepixel-tool-invocation
pnpm --filter @firegrid/scenarios run firepixel-tool-invocation-receiver -- --stream-url "$DURABLE_STREAMS_URL"
pnpm --filter @firegrid/scenarios run firepixel-tool-invocation-receiver:self-test
```

ACIDs:

- `client-event-plane-registration.FIREPIXEL_PROFILE.4`
- `firegrid-runtime-process.SCENARIOS.21`

### FP6: Runtime Composition Ergonomics

Specify and implement a first-class app-owned runtime composition helper that reduces
repeated `Layer.mergeAll` / `Layer.provide` boilerplate without hiding the
runtime graph.

Acceptance:

- The SDD describes a helper that returns an ordinary Effect Layer accepted by
  `run({ connection, runtime })`.
- Handlers, stock subscribers, `EventPlane.layer(...)`, `RunWait.layer(...)`,
  `triggerMatchersLayer(...)`, and app adapter Layers remain explicit inputs.
- The helper does not install subscribers implicitly.
- The helper does not import `@firegrid/client`, `@firegrid/substrate/kernel`,
  Choreography, or `DurableWaitsLive`.
- The helper does not encode Firepixel, Fireline, ACP, MCP, tool, provider,
  permission, session, or transport semantics.

ACIDs:

- `firegrid-runtime-process.RUNTIME_COMPOSITION.1`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.2`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.3`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.4`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.5`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.6`

## Non-Goals

- Do not implement Firepixel packages in the Firegrid repo.
- Do not make Firepixel row names native Firegrid substrate rows.
- Do not add a global EventPlane registry.
- Do not import `@firegrid/client` from runtime/scenario receivers.
- Do not use `@firegrid/substrate/kernel` in app-owned runtime entrypoints.
- Do not add dynamic runtime module loading.
- Do not add Firegrid-owned Durable Streams dev-server launchers.
- Do not replace `RunWait` with product workflow vocabulary.

## Dispatch Order

1. FP1: expose/document the EventPlane public import path.
2. FP2: emit-then-wait Firepixel path using EventPlane projection reads.
3. FP3: adapter Scope/lifecycle contract.
4. FP4: tool invocation path.
5. FP6: runtime composition ergonomics helper for the next implementation wave
   after the foundation proof.

FP2 is the first real evidence that Firegrid can underlie a Firepixel-style
runtime. It intentionally supersedes a prompt-chunk-only proof because emit-only
does not exercise the ordering contract a real Firepixel integration needs.
