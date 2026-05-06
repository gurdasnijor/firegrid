# SDD: Firegrid Runtime Composition Ergonomics

Status: Accepted
Product: Firegrid
Related:
- `firegrid-runtime-process`
- `client-event-plane-registration`
- `run-wait-primitives`

## Summary

Fireline- and Firepixel-shaped runtime entrypoints now prove that app code can
compose typed handlers, stock subscribers, `RunWait`, `EventPlane`, trigger
matchers, and app-owned adapter Layers through `run({ connection, runtime })`.
The remaining ergonomics problem is not capability. It is repeated
`Layer.mergeAll(...).pipe(Layer.provide(...))` boilerplate that makes app-owned
runtime graphs harder to scan.

Firegrid provides a first-class composition helper that reduces that
boilerplate while preserving the important boundary: apps still own the runtime
entrypoint, list the handlers and subscribers they want, provide their app
adapters explicitly, and pass one ordinary Effect Layer to `run(...)`.

## Current Shape

Firepixel-style app entrypoints currently compose the runtime graph directly:

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
  Firegrid.handler(PromptOperation, promptHandler),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      EventPlane.layer(FirepixelPlane, { streamUrl }),
      RunWait.layer({ streamUrl }),
      triggerMatchersLayer(matchers),
      ProviderAdapterLive({ apiKey }),
    ),
  ),
)

yield* run({
  connection: { streamUrl },
  runtime,
})
```

This is explicit and uses ordinary Effect APIs, which is correct. The downside
is that the boilerplate repeats across app-owned entrypoints and can obscure
the runtime graph's domain-relevant parts: operation handlers, subscriber loops,
EventPlane services, wait primitives, trigger matching, and adapter resources.

## Helper Contract

`Firegrid.composeRuntime(...)` is a small runtime Layer composer:

```ts
const runtime = Firegrid.composeRuntime({
  handlers: [
    Firegrid.handler(PromptOperation, promptHandler),
    Firegrid.handler(ToolOperation, toolHandler),
  ],
  subscribers: [
    Firegrid.subscribers.projectionMatch({ evaluate: matchProjection }),
    Firegrid.subscribers.timer,
    Firegrid.subscribers.scheduledWork,
  ],
  provide: [
    EventPlane.layer(FirepixelPlane, { streamUrl }),
    EventPlane.layer(AuditPlane, { streamUrl }),
    RunWait.layer({ streamUrl }),
    triggerMatchersLayer(matchers),
    ProviderAdapterLive({ apiKey }),
  ],
})

yield* run({
  connection: { streamUrl },
  runtime,
})
```

- The helper returns an ordinary `Layer.Layer<never, E, RuntimeContext | R>`
  shape accepted by `run({ connection, runtime })`.
- `handlers` are app-selected `Firegrid.handler(...)` Layers.
- `subscribers` are app-selected stock subscriber Layers. The helper never
  installs projection-match, timer, scheduled-work, or future subscribers
  implicitly.
- `provide` contains explicit provider Layers such as `EventPlane.layer(...)`,
  `RunWait.layer(...)`, `triggerMatchersLayer(...)`, and app adapter Layers.
- App-owned adapter resources remain scoped to the `run(...)` Effect and
  finalize when that runtime is interrupted.
- The resulting type preserves unprovided app requirements instead of erasing
  them behind an untyped graph object.

The helper is a convenience around `Layer.mergeAll` and `Layer.provide`, not a
new composition system.

## Boundaries

The helper must not import, expose, or require:

- `@firegrid/client`,
- `@firegrid/substrate/kernel`,
- Choreography,
- `DurableWaitsLive`,
- raw Durable Streams writer APIs,
- dynamic module loading or `FIREGRID_RUNTIME_MODULE`-style discovery.

The helper must not add product semantics to Firegrid. Fireline operation names,
Firepixel permission/tool/session/provider concepts, ACP/MCP transports,
provider credentials, and sandbox policies remain app-owned adapter or row
vocabulary. Firegrid only composes the runtime mechanics the app explicitly
lists.

The helper must not become a hidden launcher. Durable Streams still runs
outside Firegrid-owned dev-server lifecycle, and app entrypoints still call
`run({ connection, runtime })`.

## Why Not Implicit Subscribers

Implicit subscribers make an app entrypoint look simpler, but they hide runtime
behavior that affects durable execution. For example, a process that installs
projection matching, timers, and scheduled-work subscribers behaves differently
from a process that only handles fresh operation starts. That difference must
be visible in code review and scenario validation.

The helper can make explicit lists easier to read, but the lists stay explicit:

```ts
subscribers: [
  Firegrid.subscribers.projectionMatch({ evaluate }),
  Firegrid.subscribers.timer,
]
```

No empty or omitted `subscribers` list should install a default subscriber set.

## Relationship To EventPlane And RunWait

`EventPlane` and `RunWait` remain separate public boundaries:

- `EventPlane.layer(Plane, { streamUrl })` provides app-owned stateful row
  producer and projection services.
- `RunWait.layer({ streamUrl })` provides durable wait primitives to operation
  handlers without app code importing substrate kernel internals.
- `triggerMatchersLayer(...)` provides app-owned trigger matching behavior.

The composition helper does not understand plane schemas, trigger semantics, or
wait kinds. It only composes the Layers the app passes.

## Rejected Designs

### Firegrid Graph DSL

A custom graph DSL would create a second composition model next to Effect
Layers. Firegrid should keep ordinary `Layer` APIs as the runtime graph model
and only reduce repetitive wiring.

### Product Presets

Firegrid should not export `Firepixel.runtime(...)`, `Fireline.runtime(...)`,
or tool/provider/session presets. Higher products can build their own presets
above Firegrid if needed.

### Dynamic Runtime Modules

The helper is for app-owned TypeScript entrypoints. It does not bring back
dynamic module discovery, `FIREGRID_RUNTIME_MODULE`, package scanning, or a
Firegrid-owned process launcher.

### Auto-Installed Subscriber Sets

The helper must not install all stock subscribers by default. If an app needs
projection matching, timers, or scheduled work, the app lists those subscriber
Layers.

## Implementation Acceptance

The implementation must prove:

- app code can compose multiple `Firegrid.handler(...)` Layers through the
  helper;
- stock subscribers are explicit inputs and are not installed implicitly;
- `EventPlane.layer(...)`, `RunWait.layer(...)`, `triggerMatchersLayer(...)`,
  and app adapter Layers can be provided through the helper;
- app-owned adapter Layer finalizers still run when the surrounding `run(...)`
  scope is interrupted;
- public examples import no `@firegrid/client`, `@firegrid/substrate/kernel`,
  Choreography, or `DurableWaitsLive`;
- the helper returns an ordinary Effect Layer accepted by `run(...)`.

## ACIDs

- `firegrid-runtime-process.RUNTIME_COMPOSITION.1`: Runtime composition helpers
  reduce repetitive app-owned Layer wiring while still returning ordinary
  Effect Layers accepted by `run({ connection, runtime })`.
- `firegrid-runtime-process.RUNTIME_COMPOSITION.2`: Runtime composition helpers
  require callers to list handlers, stock subscribers, EventPlane layers,
  RunWait layers, trigger matcher layers, and app adapter layers explicitly
  rather than installing subscribers or providers implicitly.
- `firegrid-runtime-process.RUNTIME_COMPOSITION.3`: Runtime composition helpers
  do not import, expose, or require `@firegrid/client`,
  `@firegrid/substrate/kernel`, Choreography, or `DurableWaitsLive`.
- `firegrid-runtime-process.RUNTIME_COMPOSITION.4`: Runtime composition helpers
  remain product-neutral and do not encode Fireline, Firepixel, ACP, MCP, tool,
  provider, permission, session, or transport semantics.
- `firegrid-runtime-process.RUNTIME_COMPOSITION.5`: Runtime composition helpers
  preserve app-owned adapter Layer lifetimes in the same `run(...)` Effect
  scope and preserve unprovided app requirements in the composed Layer type.
- `firegrid-runtime-process.RUNTIME_COMPOSITION.6`: Runtime composition helpers
  organize multiple `Firegrid.handler(...)` Layers, explicit stock subscriber
  Layers, `EventPlane.layer(...)` values, `RunWait.layer(...)`,
  `triggerMatchersLayer(...)`, and app adapter Layers without creating a
  Firegrid-specific graph DSL, runtime module loader, or hidden Durable Streams
  launcher.
