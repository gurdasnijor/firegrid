# tf-cxwu.1 — §12 modularity compile-spike: VERDICT

**Gate:** Firegrid Composition SDD §10 step 0 — the spike that turns §12 from a
*proposed target* into a *committed plan*. Validates **provide-order
requirement closure** (Seam 2), not merely DAG-ness.

**Status: PASS — §12 closes.** The two-line Prod/Sim constructor compiles and
launches with `R = never`, from the SAME constructor differing only by **which
adapter is passed and which backend Live is provided**, with no `as`-cast
laundering `E` or `R`.

Evidence (all green at `main` base, this branch):
- `pnpm typecheck` — repo-wide 16/16 packages.
- `packages/runtime/test/unified/tf-cxwu-1-modularity-compile-spike.test.ts` —
  both Prod and Sim `Layer.launch` (build + race a 50ms sleep). 1 test pass.
- Type-level `_assert*` consts pin `R = never` at the language level (the §6
  launchability gate), so the launch is not an accident of the 50ms race.
- `lint` / `lint:dead` (knip) / `lint:dup` / `lint:deps` (dep-cruiser airgap) —
  all green. Full runtime suite: 151 pass / 1 skip (prior tf-0awo.18 spike still
  green ⇒ the host.ts refactor is behavior-preserving).

---

## The exact provide expression that closes (PINNED)

The closing shape is the **existing `FiregridRuntime` body, with the floor
hoisted to an injected parameter** (`composeFiregridRuntimeWithFloor` in
`packages/runtime/src/unified/host.ts`). The floor is referenced at **two**
provide sites — under the interior adapter and under the upper layers:

```ts
// floor : Layer<SubstrateTags, DurableTableError, DurableStreams>
//   where SubstrateTags = RuntimeControlPlaneTable | RuntimeOutputTable
//                       | UnifiedTable | WorkflowEngine | WorkflowEngineTable
//                       | FiregridRuntimeContextMcpBaseUrl   ← McpEndpoint is a MEMBER of the floor
const adapterLayer = adapter.pipe(Layer.provide(floor), Layer.orDie)  // adapterLayer R = DurableStreams
workflowLayers.pipe(
  Layer.provideMerge(channelsAndObserver),
  Layer.provideMerge(floor),          // workflows' substrate discharged; R picks up DurableStreams
  Layer.provideMerge(hostSessionLayer),
)
// ⇒ runtime R = DurableStreams (the single leaf hole)

// at the call site — the only thing prod and sim differ by:
FiregridRuntimeV12(spec, ProdAdapter).pipe(Layer.provide(DurableStreamsLive.configuredWith(cfg)), Layer.launch) // R=never
FiregridRuntimeV12(spec, SimAdapter ).pipe(Layer.provide(DurableStreamsEmbedded),               Layer.launch) // R=never
```

## Why it closes — and the design rule the spike pins

The SDD (§12 Seam 2 / §10 step 0) predicted the closing shape was *likely* a
single merged-floor provide — `Floor(spec) = Layer.mergeAll(Substrate(spec),
McpEndpointLive)` with one `Layer.provideMerge` — to avoid the DAG-but-fails-to-
close hazard where a requirement (`McpEndpoint`) is *introduced after its
satisfier* in a plain provide chain.

The spike refutes the *fragility worry* while **confirming the SDD's core
instinct**, and the reason is the actionable rule:

> **`McpEndpoint` must stay a MEMBER of the merged floor, never a separate leaf
> provided last.** The live floor (`runtimeProvideFloor =
> Layer.mergeAll(tableLayer, engineLayer, FiregridRuntimeContextMcpBaseUrlLive)`)
> already does this, so `McpEndpoint` is introduced and satisfied by the *same*
> floor value — there is no "introduced after its satisfier" window. The hazard
> the SDD named would appear ONLY if `McpEndpoint` were pulled out of the floor
> and `Layer.provide`d after `Substrate`. Keeping it in the floor is what
> avoids it.

Two corollaries the data settles:

1. **The two-reference floor is not a closure hazard.** The floor is provided
   into the adapter (`Layer.provide(floor)`) *and* `provideMerge`-d for the
   workflows — two `DurableStreams` requirements, which **dedupe by Tag
   identity** to a single `R = DurableStreams`. So §12 does **not** need to
   collapse to literally one `provideMerge` to close; the live two-reference
   body closes as-is. The single-merged-floor is an available *simplification*,
   not a *necessity*.
2. **Seam 3's `Effect.cached` `McpEndpoint` is NOT needed for closure.** The
   spike closes with the live `FiregridRuntimeContextMcpBaseUrlLive` (`Ref<Option>`,
   `R = never`) as the floor's MCP member. Seam 3 is a runtime read-before-bind
   *race* fix, orthogonal to provide-order closure — confirming the SDD's
   sequencing (Seam 3 = §10 step 5, after the cutover).

---

## Signature deltas §12 needs (gathered, decision-grade)

1. **Floor becomes an injected parameter.** Done minimally as
   `composeFiregridRuntimeWithFloor(spec, adapter, floor)`; `FiregridRuntime`
   delegates with the spec-built floor so its `R = never` signature and all
   ~15 sim + 2 bin callers are unchanged. The §12 cutover (§10 step 4) flips the
   **default** floor to the `DurableStreams`-consuming one, making
   `FiregridRuntime(spec, adapter)` carry `R = DurableStreams`. **Migration
   cost:** each direct caller (the tiny-firegrid sim `host.ts` files +
   `bin/_compose.ts` + the `FiregridHost` shim) gains exactly one
   `.pipe(Layer.provide(DurableStreamsLive.{embedded|configured}))`. All
   mechanical; none require composition changes.

2. **The spec narrows — `durableStreamsBaseUrl` leaves it.** The floor-injectable
   constructor reads only `{ namespace, hostId? }` (captured as
   `FiregridRuntimeFloorSpec`). `durableStreamsBaseUrl` / `headers` move OUT of
   the spec INTO the backend Live (`DurableStreamsLive.configured` reads them
   from `Config`; `configuredWith(cfg)` takes them explicitly for the
   back-compat shim). This is Seam 1's "URL arithmetic lives in one place"
   realized at the type level: the base URL is no longer a constructor input.

3. **`StreamOptions` MUST carry a `url` — the one part of Seam 1 prose that does
   NOT hold as written.** Seam 1 says the embedded backend "has no URL at all,"
   but `DurableStreams.streamOptions(name): StreamOptions` has to return a `url`
   (the shape `DurableTable.layer` and `DurableStreamsWorkflowEngine.layer`
   consume — `LayerOptions.streamOptions: DurableStreamOptions`). So the embedded
   Live still mints a URL; here it is a **self-contained in-process
   `DurableStreamTestServer`** acquired/released inside the Live (genuinely
   embedded — no external config, `R = never`). A *true* zero-URL in-memory
   transport would require either changing the `StreamOptions`/
   `DurableStreamOptions` contract or plumbing an in-memory transport through the
   `DurableStreamOptions.fetch` hook. Named here, not papered over; not a blocker
   for closure.

---

## Placement (Seam 1b import-graph rule) — validated, no blocker

- `DurableStreams` Tag + `StreamName` (closed set, **no `contextId` param**) +
  the pure `configured` / `configuredWith` Lives live in
  `@firegrid/protocol/launch` (`packages/protocol/src/launch/durable-streams.ts`).
  Browser-safe: imports only `effect`, an `effect-durable-operators` *type*, and
  the pure `durableStreamUrl` encoder already in `protocol`.
- The `embedded` Live (owns a server lifecycle) is **sim-side**, in the spike
  test — never in `protocol`.
- `lint:deps` (dep-cruiser airgap gate) GREEN: no `client-sdk → runtime` edge
  introduced, `protocol` stays browser-safe. The placement rule holds; **no
  blocker to report to the coordinator.**

## Scope honesty (what this spike did NOT do)

This is the §10 **step 0** spike — closure + the exact provide expression +
signature deltas. It deliberately does NOT perform the §10 step 4 cutover: no
deletions (`per-context-output.ts`, snapshot channels), no read-views
migration, no flip of `FiregridRuntime`'s default floor, no `AcpAdapter(opts)` /
`SimAdapter` exported constructors. The spike reuses the REAL upper layers
(workflows/channels/observer/recovery/mcp-host) over a real adapter
(`ProductionCodecAdapterLive` for prod) — only the sandbox leaf is a stub, as in
the prior tf-0awo.18 spike — so the closure result is against the actual
composition, not a strawman.
