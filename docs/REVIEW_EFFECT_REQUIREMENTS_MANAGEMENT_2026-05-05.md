# Effect-TS Requirements-Management Review — Firegrid

Date: 2026-05-05
Scope: Service definitions (`Context.Tag` / `Layer`), `Layer.*` constructor
selection, `Effect.provide` vs `Effect.provideService`, default services,
layer memoization, `R`-channel threading through `Firegrid.handler` /
`Firegrid.eventStream`, and layer composition (`Layer.merge` /
`Layer.mergeAll` / `Layer.provide`). Production sources under
`packages/*/src` and `apps/*/src`; test files cross-referenced but not
re-audited (see the testing review for the inline-layer story).

## Summary

Post R7 the Firegrid requirements story is structurally clean: every
public service is a `Context.Tag` paired with a `*Live` Layer factory
(or a pre-built Layer value), there are zero `Effect.Service` /
`.Default` references in production source, and the per-package
convention is uniform. A literal source-text guard
(`packages/substrate/src/__tests__/effect-consistency.test.ts:78-79`)
keeps the producer module on `Context.Tag` + explicit
`SubstrateProducerLive(config)` wiring.

The constructor selection per Layer also matches SDD intent:
`Layer.scopedDiscard` for long-running daemons (subscribers, handlers,
materializers), `Layer.scoped` for resource-holding services
(`SubstrateClient`, `Projection`), `Layer.succeed` for value-only
services. Composition is bottom-up via `Layer.provide` / `Layer.mergeAll`
in the runtime boot pipeline.

There is, however, one **runtime-correctness bug** in the requirements
story that the per-Layer guards don't catch: `Firegrid.handler` accepts
caller code whose `R` includes choreography services like
`CurrentWorkContext`, type-propagates `R` correctly into the returned
`Layer<never, never, R | RuntimeContext>`, but never **provides**
`CurrentWorkContext` around the per-message handler invocation inside
the dispatch loop. Any `Choreography.sleep` / `scheduleAt` /
`awaitAwakeable` invoked from a Firegrid handler dies at runtime with
"service not found" — surfaced as a defect through `Effect.exit`,
encoded as a generic `failRun`, and silently swallowed. This is the #1
finding and overlaps with runtime review #1 — the runtime review
characterized it through the lens of `Layer.scopedDiscard` /
`Effect.forkScoped`; here it is the same bug viewed through the
Requirements channel.

Smaller hygiene findings: `SubstrateClientLive` is rebuilt **per call**
from the FiregridClient adapter (`operation-client.ts:212` and `:292`),
forfeiting layer memoization for every `send` / `result` / `observe`;
the lab adapter has the same shape (`apps/lab/src/lab/LabEventStreamClient.ts:39`,
`:48`). And a substantial fraction of the test suite still hand-builds
its layer environment per `Effect.gen` call — see the testing review
for the totals; this review only confirms the cause is structural
(no shared `TestEnv` exported per package).

## Findings

### F1. (TOP) `CurrentWorkContext` is not provided around handler invocation in `Firegrid.handler` — `packages/runtime/src/runtime/internal/operation-handler.ts:133`

`runOperationDispatchLoopWithAcquire` invokes the user-supplied handler
through `Effect.exit(input.run(matched.input))` at
`packages/runtime/src/runtime/internal/operation-handler.ts:133`. The
public surface (`packages/runtime/src/runtime/firegrid.ts:81-91`) is
typed:

```
Firegrid.handler<Op, E, R>(
  op,
  run: (input) => Effect.Effect<Output, Error | E, R>,
): Layer.Layer<never, never, R | RuntimeContext>
```

So `R` from the handler body propagates correctly into the returned
Layer's third type parameter, and the application Layer that mounts
`Firegrid.handler(Echo, body)` is required to provide whatever services
`body` mentions. That's where the abstraction stops working: at
`operation-handler.ts:133` `input.run(matched.input)` is run **as-is**
inside an `Effect.gen` whose only environment is the dispatch loop
(`RuntimeContext` + a `DurableStream` plus a `Scope`). Choreography
services are addressed by the static type but never injected at the
call site.

Concretely, the documented `CurrentWorkContext` is the per-message
identity used by `Choreography.sleep` / `Choreography.awaitAwakeable`
to pull `workId`/`ownerId`
(`packages/substrate/src/choreography/service.ts:155`,
`:322`,
`packages/substrate/src/choreography/tools.ts:146`). Its tag and
helper layer live at
`packages/substrate/src/choreography/context.ts:21` and `:28-30`. No
file under `packages/runtime/src` references `CurrentWorkContext` or
`currentWorkContextLayer`, so the dispatch loop has no path to provide
it. A handler such as

```
Firegrid.handler(Echo, (input) =>
  Effect.gen(function* () {
    const choreo = yield* Choreography
    yield* choreo.sleep("1 second")
    return { msg: input.msg, len: input.msg.length }
  }),
)
```

type-checks (compiler infers `R = Choreography | DurableWaits |
CurrentWorkContext`, the application layer provides those Lives), but at
runtime `Choreography.sleep` does `yield* CurrentWorkContext` inside
`blockAndSuspend` and dies because the tag is not in the local context.
The defect path is then:

1. `Effect.exit` at `operation-handler.ts:133` captures the cause as
   `Failure`/`Die` and returns a `Success`-shaped Exit with `_tag:
   "Failure"`.
2. The non-interrupt branch
   (`operation-handler.ts:158-185`) extracts `failureOption(cause)`,
   tries to encode through `op.error`, falls back to
   `Cause.pretty(cause)`, and writes a generic `failRunEffect`.
3. The handler appears to "fail with a defect string" rather than
   "suspend"; the run never blocks; `scheduleAt` records but the
   completion flow can't link back to a workId.

**Fix shape** (no patch — characterizing the requirements-side change):
the handler body must be invoked with a per-message
`currentWorkContextLayer` provided. The cleanest place is
`operation-handler.ts:133` itself, replacing
`Effect.exit(input.run(matched.input))` with
`Effect.exit(input.run(matched.input).pipe(Effect.provide(
  currentWorkContextLayer({ workId: matched.run.runId,
  ownerId: cfg.processId, … }))))`. The `R` returned by `Firegrid.handler`
must subtract `CurrentWorkContext` once provided (the public Layer's
remaining `R` becomes `Exclude<R, CurrentWorkContext> | RuntimeContext`).
This is the *same* observation as the runtime review's #1 finding;
that review framed it via `Effect.forkScoped` and the
`Layer.scopedDiscard` perimeter, this one frames it via the
Requirements-channel — both fixes converge on providing the layer at
the same call site.

### F2. Service-tag conventions are uniform after R7

Substrate (`producer.ts:78`, `:88`, `waits.ts:86`,
`facade/projection.ts:59`, `facade/work.ts:53`,
`choreography/context.ts:21`, `choreography/triggers.ts:60`,
`choreography/service.ts:107`), client (`firegrid/event-client.ts:76`,
`firegrid/client.ts:47`, `client/service.ts:32`), and runtime
(`runtime/runtime-context.ts:26`, `runtime/service.ts:27`,
`runtime/internal/stream-resolver.ts:52`, `:93`, `:126`) all use
`class Tag extends Context.Tag("…")<Tag, Service>() {}`. Lab carries no
service definitions — only consumes Layers. The substrate
`effect-consistency.test.ts:78-79` source-text guard locks the
`Effect.Service` / `.Default` ban into the test bar.

### F3. `Effect.Service` / `.Default` — zero stragglers

A grep across `packages/*/src` and `apps/*/src` for `Effect.Service`,
`extends Effect.Service`, and `.Default` returns only the substrate
consistency-test source (which forbids them). R7 finished the cutover
cleanly; no follow-up sweep is needed.

### F4. `Layer.*` constructor selection matches intent

| Constructor | Sites | Use |
| --- | --- | --- |
| `Layer.succeed` | `producer.ts:212-213`, `facade/work.ts:68`, `choreography/context.ts:30`, `choreography/triggers.ts:67`, `event-plane/layer.ts:34`, `runtime/layer.ts:61`, `:67`, `internal/stream-resolver.ts:57`, `:98`, `:135`, `client/operation-client.ts:300`, `client/event-client.ts:172` | Value-only services and per-message context wrappers. Correct. |
| `Layer.effect` | `waits.ts:121`, `event-plane/layer.ts:41` (via `Layer.scoped`) | DurableWaits has effectful construction (resolves contentType, builds DurableStream); fine. |
| `Layer.scoped` | `facade/projection.ts:108`, `client/service.ts:57`, `runtime/internal/stream-resolver.ts:159` | Resources whose lifetime must follow the Layer's scope (StreamDB, EmbeddedDurableStreams). Correct. |
| `Layer.scopedDiscard` | `runtime/firegrid.ts:50` (subscribers), `:91` (handler), `:117` (eventStream) | Long-running daemon programs. Correct, matches SDD §"Effect Type Conventions" and the SDD intent the brief calls out. |
| `Layer.unwrapScoped` | `runtime/layer.ts:51` | Builds the runtime layer inside an `Effect.gen` so the resolver runs once at boot. Correct. |
| `Layer.merge` / `Layer.mergeAll` | `producer.ts:211`, `event-plane/layer.ts:58`, `runtime/layer.ts:74`, `:146`, `client/service.ts:79` | Two-arg uses pick `Layer.merge`; ≥3-arg uses pick `Layer.mergeAll`. Consistent. |
| `Layer.provide` | `runtime/layer.ts:73`, `:130`, `:150-152`, `client/service.ts:77` | Bottom-up wiring (infra → resolver → core). Correct. |

`Layer.fresh` / `Layer.scopedFresh` is not used anywhere. Given the
`SubstrateClientLive(cfg)` per-call pattern in F7 it likely should not
be — the right fix is structural (build the layer once and provide it
at the FiregridClient root).

### F5. `Effect.provide` vs `Effect.provideService`

`Effect.provideService` does not appear in production sources — every
provision uses a Layer (`Effect.provide(layer)`) which is the
recommended shape per the skill (§"Effect.provide — Provide Layer").
The five production `Effect.provide` sites
(`bin/firegrid.ts:87`, `:138`, `:154`,
`client/firegrid/operation-client.ts:212`,
`apps/lab/src/lab/LabEventStreamClient.ts:39`, `:48`) all provide
fully-resolved Layer values. Stream sites use `Stream.provideLayer`
(`operation-client.ts:292`).

### F6. Default services — clean

There are no references to `Clock`, `TestClock`, `Random`, or
`*Default` in production source, and no `*.Default` static accessors
(which is what R7 was tasked with eliminating). The only
default-services touchpoint would be implicit usage by
`Effect.timestamp` / `Schedule.spaced` etc., which take Effect's
default `Clock` automatically and need no explicit Layer.

### F7. Layer memoization — structural per-call rebuild on the client adapter

`buildFiregridClientService` at
`packages/client/src/firegrid/operation-client.ts:206-292` defines a
local helper

```
const withSubstrate = (f) =>
  Effect.gen(function* () {
    const client = yield* SubstrateClient
    return yield* f(client)
  }).pipe(Effect.provide(SubstrateClientLive(substrateCfg)))
```

and uses it on every `send`, `result`, and `call`. `observe`
(`:283-292`) does the same with `Stream.provideLayer`. Each invocation
constructs a *fresh* `SubstrateClientLive(cfg)` Layer, which in turn
constructs fresh `ProjectionLive` (`Layer.scoped` over a new StreamDB)
and fresh `SubstrateProducerLive` (two `Layer.succeed` / DurableStream
instances). Effect memoizes services *within* a single Layer build, but
not across separate `Effect.provide` calls — every operation pays the
StreamDB-acquire cost.

The lab `LabEventStreamClient.ts:26-30` builds a per-call
`EventStreamClientLive` similarly. Less expensive (it's a `Layer.succeed`
with a `DurableStream` constructor inside `buildEventStreamService`),
but the same shape.

The fix is the standard Effect pattern: hoist the Layer build to module
level (or a single `FiregridClientLive`), have `FiregridClientLive`
**compose** `SubstrateClientLive` once via `Layer.provide`, and let
methods yield from `SubstrateClient` directly — no per-call
`Effect.provide`. The current code can't do this because the
service interface methods promise an `R = never` channel; the
restructure trades that "no requirements" promise for a single
SubstrateClient-typed requirement at the public boundary, which is
the Right Answer (the alternative is paying the layer-build cost on
the hot path).

### F8. R-channel threading through `Firegrid.handler` / `Firegrid.eventStream`

Apart from F1, the type-level threading is correct. Both
`runtime/firegrid.ts:81-91` and `:111-119` declare the returned Layer
as `Layer<never, never, R | RuntimeContext>` where `R` is exactly the
caller's handler/materializer requirements. `Layer.scopedDiscard`
preserves the `R` of its inner Effect because no `Layer.provide` is
applied there, so the application is forced to provide `R` at the
mounting site. The runtime boot pipeline at `runtime/layer.ts:67-74`
does this for `RuntimeContext` only — every other `R` (Choreography,
DurableWaits, EventStream services) must be supplied by the caller's
runtime Layer. F1 is the gap inside the perimeter; the perimeter
itself is correctly typed.

### F9. Layer composition shapes

`Layer.merge` (2-arg) vs `Layer.mergeAll` (n-arg) selection is
consistent. `Layer.provide` is used bottom-up
(`runtime/layer.ts:130-153` wires `infra → resolver → core`;
`client/service.ts:77-85` wires `Projection + Producer → SubstrateClient`).
No site uses `Layer.provideMerge`; nothing currently needs the
"provide-and-keep" shape, so its absence isn't a defect.

The runtime boot's `Layer.unwrapScoped`
(`runtime/layer.ts:51`) is the right tool: the resolver must execute
once at boot to produce `streamIdentity`, and `Layer.unwrapScoped`
hoists that Effect into the Layer-build phase so the resolved value
flows into both `Layer.succeed(FiregridRuntime, …)` and
`Layer.succeed(RuntimeContext, …)` — exactly one stream identity per
runtime, shared by every handler/eventStream Layer the caller
mounts.

### F10. Test layers — confirmation only

The testing review's count of 96 inline `Layer.provide` chains
(now 133 total `provide`-style references across `__tests__/*.test.ts`)
holds: no shared `TestEnv` is exported per package, so each test
file rebuilds its DurableStreamTestServer + `FiregridRuntimeBoot.embeddedDev`
+ Layer composition by hand. This is a testing concern (see
`REVIEW_EFFECT_TESTING_2026-05-05.md`); from the requirements-management
side, the structural cause is that no test fixture is published from
each package's `*-test-support.ts` or similar.

## Out of scope

- Choreography facade business logic (`REVIEW_FIREGRID_2026-05-05.md`).
- Test-suite layer cleanup count (testing review).
- Hot-path Stream operator selection (streams review).

## Top 5 improvements

1. **Provide `CurrentWorkContext` around handler invocation in the
   dispatch loop** (`operation-handler.ts:133`). Build a per-run
   `currentWorkContextLayer({ workId: matched.run.runId, ownerId:
   cfg.processId, … })` and apply via `Effect.provide` to
   `input.run(matched.input)` before `Effect.exit`. Returns the
   `Firegrid.handler` Layer's R to `Exclude<R, CurrentWorkContext> |
   RuntimeContext`. (F1 — runtime correctness, not just type hygiene.)
2. **Hoist `SubstrateClientLive` into `FiregridClientLive`** so every
   `send` / `result` / `call` / `observe` reuses one StreamDB +
   producer pair instead of rebuilding per call (F7 —
   `operation-client.ts:206-292`). Adopt the same fix for the lab's
   `LabEventStreamClient` (`apps/lab/src/lab/LabEventStreamClient.ts:39`,
   `:48`).
3. **Publish per-package test environments** (`*Test` Layers + a
   shared `TestEnv` exported from `packages/*/src/test-support/index.ts`)
   so test files yield from tags and provide one Layer instead of
   re-wiring runtime + substrate by hand. Cuts the 133 `provide`-style
   call sites in tests dramatically. (F10 — cross-references testing
   review.)
4. **Promote the `effect-consistency.test.ts` text guard** beyond
   the substrate package — replicate it under `packages/runtime/src/__tests__`
   and `packages/client/src/__tests__` so future drift in either
   package fails the test bar in-place rather than at substrate.
5. **Document the `Layer.scopedDiscard` daemon convention next to
   `Firegrid.handler` / `Firegrid.eventStream`** in
   `runtime/firegrid.ts` so the symmetry between subscribers/handlers/
   materializers is explicit at the call site (currently the comment at
   `:38-46` describes only the deadline subscribers; the same posture
   applies to `:91` and `:117`).

## What strict-baseline enforces vs gaps

**Enforced today:**

- No `Effect.Service` or `.Default` in substrate (literal grep guard,
  `effect-consistency.test.ts:78-79`).
- One Effect convention per package — substrate is uniform
  `Context.Tag` + `*Live(config)` factories returning Layers.
- Public surface tests assert the exported tag set
  (`__tests__/public-surface.test.ts:19`, `:39`).
- Type-level R-channel threading on `Firegrid.handler` /
  `Firegrid.eventStream` — TS compiler enforces the caller provides
  every service mentioned by handler/materializer bodies.
- Bottom-up `Layer.provide` boot pipeline (the runtime cannot be
  constructed without `RuntimeStreamResolver`).

**Gaps the baseline does NOT catch:**

- **F1**: TS sees `R = Choreography | DurableWaits | CurrentWorkContext`
  on the user's handler, the application Layer satisfies it at the
  surface, but the dispatch loop runs the handler in a smaller context
  than the type promises. There is no test that mounts a handler whose
  body yields `CurrentWorkContext` and asserts non-defect completion;
  adding that test would surface this immediately.
- **F7**: Layer-build cost per call. Effect's memoization is
  per-`Layer.build`; rebuilding the Layer in a closure forfeits it.
  No structural test catches this; it would surface as a runtime
  perf regression or a missing-finalizer trace under load.
- **F10**: the substrate consistency guard is text-based and substrate-
  scoped; it doesn't cross-package, doesn't catch shape regressions in
  runtime/client.

The brief calls out R7 as making producer wiring uniform — it does, and
the type-level review is clean. The remaining real-runtime risk is F1;
the remaining hot-path risk is F7. Everything else is style /
convention and stable.
