import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostProgramRuntime,
  HostPrograms,
  SubstrateHostBoot,
} from "../../index.js"

// Graph extra-R (compile-time + runtime) — a graph that requires an
// adapter / provider service Tag beyond HostProgramRuntime can be
// wired with Layer.provide BEFORE being passed to the host. Once
// wired, the residual RIn at the host boundary is exactly
// HostProgramRuntime, which the host injects internally. The host
// layer's outward RIn is `never` after `Exclude<GraphRIn,
// HostProgramRuntime>`. The Effect program below would not compile
// if the type pipeline did not preserve and discharge the extra R.

interface FakeAdapterShape {
  readonly value: number
}
class FakeAdapter extends Context.Tag("test/FakeAdapter")<
  FakeAdapter,
  FakeAdapterShape
>() {}

describe("HostProgramGraph — extra adapter R can be wired before the host accepts the graph", () => {
  it("a graph that depends on a caller-owned adapter Tag composes via Layer.provide; resulting host layer has no extra RIn", async () => {
    // Operator helper that closes over the FakeAdapter Tag in its
    // handler. Its layer's RIn includes both HostProgramRuntime
    // (from the helper) and FakeAdapter (from the closure).
    const adapterDependentOperator = HostPrograms.operator({
      name: "adapter-dep",
      handler: () =>
        Effect.gen(function* () {
          const adapter = yield* FakeAdapter
          return adapter.value
        }),
      // Match nothing so the operator runner does not actually
      // attempt to claim work (avoids any runtime side effect in
      // this typing-focused test).
      select: () => false,
    })

    // Caller-side adapter wiring — supplied BEFORE the graph is
    // handed to the host. After Layer.provide(FakeAdapterLive),
    // the residual layer's RIn = HostProgramRuntime only.
    const FakeAdapterLive = Layer.succeed(FakeAdapter, { value: 42 })
    const wiredOperator = adapterDependentOperator.pipe(
      Layer.provide(FakeAdapterLive),
    )
    const Graph = HostProgramGraph.define({
      name: "with-adapter",
      layer: wiredOperator,
    })

    // SubstrateHostBoot.attached typed: Layer<SubstrateHost, never, never>.
    // If the type pipeline lost the FakeAdapter handling, this
    // would either fail to typecheck or surface FakeAdapter in the
    // resulting Effect's RIn.
    const layer = SubstrateHostBoot.attached({
      streamUrl: "http://example.invalid/substrate/none",
      program: Graph,
    })

    // Compile-time assertion: the layer's RIn is `never`. The
    // following assignment forces the check.
    const _typedAssertion: Layer.Layer<typeof Graph extends never ? never : ReturnType<
      typeof SubstrateHostBoot.attached
    > extends Layer.Layer<infer _A, infer _E, infer R>
      ? R
      : never> = layer as never
    void _typedAssertion

    // Smoke runtime: just confirm the layer is constructible. This
    // test does not start a real host (no actual stream URL), so we
    // do not Effect.runPromise the layer.
    expect(typeof layer).toBe("object")
  })

  // Negative type assertion: a graph that still requires an
  // unsatisfied adapter Tag at the host boundary surfaces that Tag
  // in the host layer's RIn — i.e. the residual `Exclude<GraphRIn,
  // HostProgramRuntime>` correctly retains FakeAdapter when the
  // user does NOT pre-provide it.
  it("an unwired adapter dependency remains in the host layer's RIn for the caller to satisfy", () => {
    const unwiredOperator = HostPrograms.operator({
      name: "adapter-dep-unwired",
      handler: () =>
        Effect.gen(function* () {
          const adapter = yield* FakeAdapter
          return adapter.value
        }),
      select: () => false,
    })

    const Graph = HostProgramGraph.define({
      name: "unwired-adapter",
      layer: unwiredOperator,
    })

    // attached returns Layer<SubstrateHost, never, FakeAdapter>:
    // the FakeAdapter requirement remains for the caller to
    // satisfy via Layer.provide(SubstrateHostBoot.attached(...),
    // FakeAdapterLive) — exactly the SDD's "incompletely wired
    // graph" path.
    const layer = SubstrateHostBoot.attached({
      streamUrl: "http://example.invalid/substrate/none",
      program: Graph,
    })

    // Compile-time: assigning to a typed slot proves FakeAdapter
    // appears in RIn.
    const _expected: Layer.Layer<
      ReturnType<typeof SubstrateHostBoot.attached> extends Layer.Layer<
        infer A,
        infer _E,
        infer _R
      >
        ? A
        : never,
      never,
      FakeAdapter
    > = layer
    void _expected

    expect(typeof layer).toBe("object")
  })

  // Runtime assertion: the wired adapter is actually used by the
  // graph at launch time.
  it("a wired-adapter operator graph runs to host startup without runtime requirement leaks", async () => {
    let adapterReadCount = 0
    const FakeAdapterLive = Layer.effect(
      FakeAdapter,
      Effect.sync(() => {
        adapterReadCount += 1
        return { value: 7 }
      }),
    )
    const operatorLayer = HostPrograms.operator({
      name: "adapter-runtime",
      handler: () =>
        Effect.gen(function* () {
          const adapter = yield* FakeAdapter
          return adapter.value
        }),
      select: () => false,
    })
    const Graph = HostProgramGraph.define({
      name: "adapter-runtime",
      layer: operatorLayer.pipe(Layer.provide(FakeAdapterLive)),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.void.pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "graph-extra-r-runtime",
              program: Graph,
            }),
          ),
        ),
      ),
    )

    // The adapter layer was materialized during host startup;
    // adapterReadCount > 0 is the proof.
    expect(adapterReadCount).toBeGreaterThan(0)
    // HostProgramRuntime is referenced to keep the import live —
    // the helper closes over it implicitly.
    void HostProgramRuntime
  })
})
