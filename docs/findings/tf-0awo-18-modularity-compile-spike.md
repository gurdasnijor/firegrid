# tf-0awo.18 Modularity Compile Spike Finding

Status: closes.

Scope note: the prompt cites `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` §12/§10, but that file is not present on this `origin/main` checkout. The spike is anchored to `features/firegrid/firegrid-runtime-host-modularity.feature.yaml` via `firegrid-runtime-host-modularity.VALIDATION.1` and models the requested `FiregridRuntime(spec, adapter)` constructor against the current `FiregridHost`/`ProductionCodecAdapterLive` surfaces.

Working provide expression:

```ts
const closedAdapter = adapter.pipe(
  Layer.provide(runtimeProvideFloor(spec)),
  Layer.orDie,
)
```

where `runtimeProvideFloor(spec)` is one merged floor:

```ts
Layer.mergeAll(
  durableStreamsFloor(spec),
  FiregridRuntimeContextMcpBaseUrlLive,
)
```

and `durableStreamsFloor(spec)` merges the real durable-streams-backed `RuntimeControlPlaneTable`, `RuntimeOutputTable`, `SignalTable`, `UnifiedTable`, and `DurableStreamsWorkflowEngine` Lives.

The exact `ProductionCodecAdapterLive` support floor that leaves only substrate/MCP requirements is:

```ts
const productionCodecAdapterSupportLive =
  SandboxProvider.layer(stubSandboxProvider).pipe(
    Layer.merge(
      Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
    ),
    Layer.merge(ContextResolverFromDurableStreamsLive),
    Layer.merge(CodecOutputJournalFromDurableStreamsLive),
    Layer.merge(RuntimeEnvResolverPolicy.denyAll),
    Layer.orDie,
  )

const ProductionCodecAdapterFromDurableStreamsLive: Layer.Layer<
  RuntimeContextSessionAdapter,
  never,
  RuntimeControlPlaneTable | RuntimeOutputTable | FiregridRuntimeContextMcpBaseUrl
> = ProductionCodecAdapterLive.pipe(
  Layer.provide(productionCodecAdapterSupportLive),
)
```

Result: `ProductionCodecAdapterLive`'s real substrate `R` closes to `RuntimeControlPlaneTable | RuntimeOutputTable`, with `FiregridRuntimeContextMcpBaseUrl` as the placeholder MCP endpoint requirement. `RuntimeControlPlaneTable` and `RuntimeOutputTable` close through real in-memory `DurableStreamTestServer` URLs in the spike.

The two constructors compile and launch at `R = never`:

```ts
const FiregridRuntimeProd = (spec: FiregridRuntimeSpec) =>
  FiregridRuntime(spec, ProductionCodecAdapterFromDurableStreamsLive)

const FiregridRuntimeSim = (spec: FiregridRuntimeSpec) =>
  FiregridRuntime(spec, SimAdapterLive)
```

Caveat: current `FiregridHost({ adapter })` requires the adapter Layer's error channel to be `never`. Closing the adapter over durable table Lives introduces durable-table build errors, so the spike uses `Layer.orDie` at the closed-adapter boundary. If §12 wants those build errors preserved in the constructor's `E` channel, the target signature must widen the adapter option from `Layer<RuntimeContextSessionAdapter, never, ...>` to allow the substrate floor's build error type. This is not an `R` closure failure.
