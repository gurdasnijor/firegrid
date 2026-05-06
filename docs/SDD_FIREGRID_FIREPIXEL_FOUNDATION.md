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

Firegrid can support Firepixel-style managed-agent runtimes without adopting
Firepixel vocabulary as substrate row families. Higher layers define their own
stateful domain rows with `EventPlane`, run typed operations with
`Firegrid.handler`, emit domain rows through plane producers, suspend through
`RunWait`, and inspect durable outcomes while Firegrid keeps ownership of
operation dispatch, completion authority, ready-work derivation, claims, and
terminal run authorship.

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
  Layer.provide(
    EventPlane.layer(FirepixelPlane, { streamUrl }),
  ),
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

## FP1 Acceptance

- `EventPlane`, `EventPlaneDefinition`, `EventPlaneLayerConfig`,
  `PlaneProducer`, `PlaneProjection`, `PlaneProjectionQuery`, `PlaneSnapshot`,
  `RowAuthority`, and producer/projection error types are available through
  `@firegrid/substrate/event-plane`.
- App-facing examples use the non-kernel import path.
- Public-surface tests cover the exported shape.

ACIDs:

- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.BOUNDARY.6`
