# Effect-TS Requirements-Management Review — Firegrid

Date: 2026-05-05
Scope: Service definitions (`Context.Tag` / `Layer`), `Layer.*` constructor
selection, `Effect.provide` vs `Effect.provideService`, default services,
layer memoization and per-call construction, `R`-channel threading through
`Firegrid.handler` / `Firegrid.eventStream`, and layer composition shapes
(`Layer.merge` / `Layer.mergeAll` / `Layer.provide`). Production source
under `packages/*/src` and `apps/*/src`; tests cross-referenced but not
re-audited (see the testing review for the inline-layer story).

## Summary

Post R0–R7 the Firegrid requirements story is in a deliberately
homogeneous shape. R7 retired the last `Effect.Service` / `.Default`
holdouts, and a literal source-text guard (`packages/substrate/src/__tests__/effect-consistency.test.ts:75-105`)
now keeps substrate's producer module on `Context.Tag` + explicit
`SubstrateProducerLive(config)` wiring. Every public service in the
repo — `WorkProducer`, `CompletionProducer`, `Projection`, `WorkClaim`,
`Choreography`, `CurrentWorkContext`, `TriggerMatchers`, `DurableWaits`,
`SubstrateClient`, `FiregridClient`, `EventStreamClient`, `RuntimeContext`,
`FiregridRuntime`, `RuntimeStreamResolver`, `EmbeddedDurableStreams`,
`DurableStreamAdmin` — is a `Context.Tag` paired with a `*Live` Layer
factory or pre-built Layer value. There are zero `Effect.Service` and
zero `.Default` references in production source. Lab has no service
tags, only Layers it consumes.

The convention selection per Layer constructor matches the SDD intent:
`Layer.scopedDiscard` for long-running daemons (subscribers, handlers,
materializers), `Layer.scoped` for resource-holding services
(`Projection`, embedded resolver), and `Layer.succeed` / `Layer.sync` /
`Layer.effect` for value-only services. `Layer.unwrapScoped` is used
once at the runtime root to thread a resolved `RuntimeStreamResolver`
into the downstream graph.

The single real correctness gap is the same one runtime review #1
called out: `runOperationDispatchLoopWithAcquire` invokes the
caller-supplied handler without ever providing a `CurrentWorkContext`
Layer around it, so any handler that uses `Choreography.sleep`,
`waitFor`, or `awaitAwakeable` dies at runtime with an unsatisfied
`R = CurrentWorkContext` — even though its outer Layer typechecks
because the handler's `R` is propagated upward as a remaining
requirement on the returned Layer. That is finding 1 below.

## Findings

### 1. `CurrentWorkContext` is never provided around the handler invocation (correctness gap)

`packages/runtime/src/runtime/internal/operation-handler.ts:133`
calls `Effect.exit(input.run(matched.input))` directly. `input.run`
has the signature
`(input) => Effect.Effect<Output, Error | E, R>` where `R` is
caller-controlled (`packages/runtime/src/runtime/firegrid.ts:81-91`,
the `Firegrid.handler<Op, E, R>` factory). The factory's return type is
`Layer.Layer<never, never, R | RuntimeContext>` — `R` is propagated
upward as a remaining requirement on the wired Layer. That makes the
Layer typecheck even when `R = CurrentWorkContext`, because the
handler graph is supposed to provide `CurrentWorkContext` further up.

It does not. Nowhere in `packages/runtime/src/` does a
`currentWorkContextLayer({...})` (`packages/substrate/src/choreography/context.ts:28-30`)
get constructed. `processRun` derives `matched.run.runId` and could
trivially synthesize a `CurrentWorkContextValue { workId, ownerId }`,
but the dispatch site at `operation-handler.ts:133` provides nothing
on the Effect call. Any handler that does
`yield* Choreography.sleep(...)` therefore reaches
`Choreography.sleep` (`packages/substrate/src/choreography/service.ts:248-259`,
which yields `CurrentWorkContext` at line 155 / 322) with an empty
Context, and Effect dies with `Service not found:
substrate/CurrentWorkContext`.

Fix shape: synthesize a `CurrentWorkContextValue` from
`matched.run.runId` (cast/branded as `WorkId`) plus a derived `OwnerId`
(reusing `cfg.processId` is the obvious v1 choice), then provide it
once per dispatch via `Effect.provide(currentWorkContextLayer(value))`
on the `input.run(matched.input)` call at `operation-handler.ts:133`.
The factory's `Firegrid.handler` return type then drops
`CurrentWorkContext` from the propagated `R` — the public surface
becomes `Layer<never, never, RuntimeContext | Exclude<R, CurrentWorkContext>>`
(or the substrate types it provides explicitly: `DurableWaits`,
`TriggerMatchers`). This is the same conclusion runtime review #1
reached; flagged here because it is the largest single
requirements-management defect in the repo.

### 2. Service-convention uniformity (post-R7)

Substrate, runtime, and client now all use `Context.Tag` + a Layer
factory. Concrete sites (with the public Tags listed in the order
they appear):

- substrate: `WorkProducer` `producer.ts:78`, `CompletionProducer`
  `producer.ts:88`, `Projection` `facade/projection.ts:59`,
  `WorkClaim` `facade/work.ts:53`, `DurableWaits` `waits.ts:91-106`,
  `Choreography` `choreography/service.ts:107`, `CurrentWorkContext`
  `choreography/context.ts:21`, `TriggerMatchers` `choreography/triggers.ts`.
- runtime: `RuntimeContext` `runtime/runtime-context.ts:26`,
  `FiregridRuntime` `runtime/service.ts:27`,
  `RuntimeStreamResolver` `runtime/internal/stream-resolver.ts:126`,
  `EmbeddedDurableStreams` `runtime/internal/stream-resolver.ts:52`,
  `DurableStreamAdmin` `runtime/internal/stream-resolver.ts:93`.
- client: `SubstrateClient` `client/service.ts:32`,
  `FiregridClient` `firegrid/client.ts`, `EventStreamClient`
  `firegrid/event-client.ts`.

Each Tag has exactly one `*Live` factory in the same file. None of
them re-export a `.Default` constructor. Lab has zero service Tags;
it consumes Layers (`apps/lab/src/lab/LabEventStreamClient.ts:26-30`)
and never declares its own. SDD §"Effect Type Conventions" item 3
("one convention per package") is satisfied across the four
workspaces.

### 3. `Effect.Service` vs `Context.Tag + Live` — full cutover

`grep -rn 'Effect\.Service'` over `packages/*/src` and `apps/*/src`
returns one hit, and that hit is the literal string match guard at
`packages/substrate/src/__tests__/effect-consistency.test.ts:78`.
Symmetrically, `\.Default\b` returns only the test's negative
assertion (`effect-consistency.test.ts:79`). No production file uses
the constructor, no production file consumes a `*.Default` layer, and
no runtime helper depends on `Effect.Service`'s implicit Layer
materialization. R7's cutover is complete.

### 4. `Layer.*` constructor selection per intent

Constructor choice tracks the SKILL's mapping:

- `Layer.scopedDiscard` for daemon Layers consuming `RuntimeContext`
  and forking a loop: `runtime/firegrid.ts:50` (`deadlineSubscriberLayer`),
  `:91` (`handler`), `:117` (`eventStream`). Each calls
  `Effect.forkScoped`, so layer-finalization interrupts the daemon.
- `Layer.scoped` for resource-holding services:
  `substrate/src/facade/projection.ts:108`,
  `substrate/src/event-plane/layer.ts:41`,
  `runtime/src/runtime/internal/stream-resolver.ts:159` (embedded
  resolver wraps a `DurableStreamTestServer`),
  `client/src/client/service.ts:57` (`SubstrateClient` binds to the
  `Projection` scope).
- `Layer.succeed` for value-only services: `producer.ts:212-213`,
  `facade/work.ts:68`, `firegrid/event-client.ts:172`,
  `firegrid/operation-client.ts:300`,
  `runtime/internal/stream-resolver.ts:57/98/135`,
  `choreography/context.ts:30`, `choreography/triggers.ts:67`.
- `Layer.sync` / `Layer.effect` where a side-effecting closure
  constructs a one-shot `new DurableStream(...)`:
  `choreography/service.ts:119` and `waits.ts:121`.
- `Layer.unwrapScoped` once at `runtime/layer.ts:51` where the
  resolver must run inside a Scope before the Layer graph is
  assembled.

No misclassifications. Note: `Choreography` and `DurableWaits` could
in principle be `Layer.scoped` to bind the `DurableStream` to the
Layer scope, but `DurableStream` from `@durable-streams/client`
exposes no explicit `acquireRelease` shape, so the current
`Layer.sync` / `Layer.effect` choice tracks the upstream API. Not
actionable.

### 5. `Effect.provide` vs `Effect.provideService`

Production `Effect.provide(...)` sites: `runtime/bin/firegrid.ts:87,
138, 154` (boot-time runtime + `NodeContext.layer`),
`client/src/firegrid/operation-client.ts:212` (`withSubstrate`
helper, per-call), `apps/lab/src/lab/LabEventStreamClient.ts:39, 48`
(per-call). Zero `Effect.provideService` calls. That is appropriate:
`provideService` shines when injecting a single service, but
Firegrid's graphs always route through `*Live` Layers, so
`Effect.provide` is the consistent surface. `Stream.provideLayer`
appears once at `firegrid/operation-client.ts:292` for the `observe`
Stream — symmetric, required because `Stream` is the carrier. The
two per-call sites are the layer-memoization concern in finding 6.

### 6. Layer memoization / per-call construction

Two related sites construct a Layer per call rather than once:

- `client/src/firegrid/operation-client.ts:206-212` — `withSubstrate`
  builds `SubstrateClientLive(substrateCfg)` *inside* every `send` /
  `result` call's `pipe`. Each invocation acquires and releases its
  own `SubstrateClient` graph (which itself wraps a scoped
  `Projection` and therefore a `SubstrateStreamDB`). For browser /
  one-shot CLI use cases this is fine — the `Layer.scoped` correctly
  scopes the per-call resource — but it foregoes Effect's
  per-graph memoization. Result: each `client.work.declare(...)`
  reads a fresh `StreamDB` snapshot, materializes a new
  `DurableStream` handle inside each producer, and tears it all down
  at the end of the call. Not a leak (scope guarantees release), but
  not the "build once" posture you'd want for a backend agent that
  calls `result` in a tight loop.
- `apps/lab/src/lab/LabEventStreamClient.ts:26-30` — `layerFor(cfg)`
  is called once per `emitLabEvent` and once per `labEvents` Stream.
  Same shape, with the same posture justification (lab is one-shot
  per panel session).

Neither is a defect. Both are improvement opportunities: a
`SubstrateClient`-scoped service held at the client root would let
`send` / `result` / `observe` reuse one StreamDB. The right fix is
to lift `withSubstrate` into a `Layer.scoped` over a long-lived
`SubstrateClient`, then make `FiregridClientLive` itself depend on
it (`Layer.provide` chain). That mirrors the runtime side, where
`RuntimeContext` is built once at boot and threaded through.

The runtime side has no per-call layer construction. `RuntimeContext`
is built exactly once at `runtime/layer.ts:67`, the resolver runs
exactly once at `layer.ts:54`, and downstream daemon Layers consume
the resolved context. Correct.

### 7. `R`-channel threading through `Firegrid.handler` / `eventStream`

`Firegrid.handler<Op, E, R>` (`runtime/firegrid.ts:81-91`) declares
`run: (input) => Effect<Output, Error | E, R>` and returns
`Layer<never, never, R | RuntimeContext>`. `runOperationHandler`
(`operation-handler.ts:89-95`) yields `RuntimeContext` and forks the
dispatch loop, which passes `input.run(matched.input)` straight
through (`:133`). Inference threads the caller's `R` out to the
wrapping `Layer.scopedDiscard` and TypeScript surfaces it on the
returned Layer. The same shape holds for `Firegrid.eventStream<S, E, R>`
(`runtime/firegrid.ts:111-119`).

Where this matters: the handler `R` is exactly where the gap from
finding 1 hides. `Choreography.sleep` / `awaitAwakeable` / `waitFor`
add `CurrentWorkContext` to their R channel, so a handler that uses
them returns `Effect<…, …, Choreography | DurableWaits | CurrentWorkContext>`,
and `Firegrid.handler` faithfully widens the Layer's R to include
`CurrentWorkContext` — but the runtime never satisfies it. The
finding-1 fix internalizes `CurrentWorkContext`: the caller's `R`
becomes `Choreography | DurableWaits` only. `eventStream` has no
parallel concern (events have no "current run"), so its `R` channel
is purely caller-domain dependencies.

### 8. Layer composition (`merge` / `mergeAll` / `provide`)

`Layer.merge` is used twice:
`producer.ts:211` and `event-plane/layer.ts:58`. Both are
two-Layer combinations of independent services on the same config —
appropriate. `Layer.mergeAll` is used twice in `runtime/layer.ts`
(lines 74 and 146) for three-or-more Layer fan-ins (service + wired
runtime; embedded streams + admin); appropriate. `Layer.provide`
appears five times in `runtime/layer.ts` and once at
`client/src/client/service.ts:77` to thread infra Layers under the
service Layer; the chain shape is bottom-up (infra → repos →
services), matching the SKILL's "Typical Pattern". No misuses
spotted.

`Layer.fresh` and `Layer.empty` are unused — there is no service in
the repo whose memoization needs to be defeated. Correct default.

### 9. Default services

The Firegrid repo does not use any `Effect.*.Default` layer (there
are none — the `\.Default` test guard exists precisely to keep it
that way). Default services Effect ships natively (`Clock`, `Random`,
`Tracer`, `Logger`) are used through `Effect.logError` / `Effect.logInfo`
calls in subscriber and handler error paths; there is no
`Effect.provide(TestClock.layer)` or similar override in production.
Tests do override (e.g., `TestClock`), but tests are out of scope.

### 10. Test layers

Tests rely on inline `Effect.provide(Layer.mergeAll(...))` chains
across a large surface (the testing review previously counted ~96
inline composition sites). Same finding holds here — the fix is the
same: per-feature `TestEnv` Layers in `helpers.ts` files. The tests
do correctly use `Layer.succeed` for stateless stubs and
`Layer.effect` + `Ref.make` for stateful stubs (e.g., the
`TriggerMatchers` test stubs in `choreography-tools.test.ts`). The
patterns the SKILL recommends are present; the repetition is the
gap. Cross-reference the testing review; not duplicating here.

## Out of scope

- Test layer organization — covered in
  `REVIEW_EFFECT_TESTING_2026-05-05.md`.
- `Effect.runPromise` / `Effect.runSync` audit — covered in
  `REVIEW_EFFECT_RUNTIME_2026-05-05.md`.
- Schema R-channel handling — covered in
  `REVIEW_EFFECT_SCHEMA_2026-05-05.md`.
- The lab UI's `Effect.runFork` / `Effect.runPromise` boundary — by
  design, with explicit ESLint suppressions.

## Top 5 Improvements

1. **Provide `CurrentWorkContext` inside the operation-handler dispatch.**
   `operation-handler.ts:133`. Synthesize a
   `CurrentWorkContextValue` from `matched.run.runId` and
   `cfg.processId`, wrap `input.run(...)` in
   `Effect.provide(currentWorkContextLayer(value))`. Drops the gap
   from finding 1, simplifies the `Firegrid.handler` public R-channel,
   and unblocks choreography use inside handlers. (Cross-references
   runtime review finding #1.)

2. **Hoist `SubstrateClient` to a long-lived scoped service in
   `FiregridClient`.** Today
   `firegrid/operation-client.ts:206-212` builds
   `SubstrateClientLive(substrateCfg)` per call. Move that into a
   single `Layer.scoped` chained under `FiregridClientLive` so the
   underlying `Projection` / `StreamDB` are reused across `send`,
   `result`, `observe`. This is finding 6 promoted to the top
   because every backend agent that calls `result` repeatedly pays a
   per-call StreamDB acquisition.

3. **Mirror the move for `EventStreamClient` in lab.**
   `apps/lab/src/lab/LabEventStreamClient.ts:26-30` rebuilds the
   layer per emit and per stream. Hoist `layerFor(cfg)` to a
   `useEffect`-bound Scope, or to a single Layer in the React module
   wired through `runFork`. Same reuse story; lower stakes than #2
   because lab is short-lived.

4. **Drop the redundant inner `Effect.scoped` in the dispatch loop.**
   `operation-handler.ts:113` wraps the body in `Effect.scoped`
   inside an outer `Layer.scopedDiscard(...forkScoped...)`. Both
   establish a Scope; the inner one is unused (no
   `acquireRelease` is bound to it that isn't already bound to the
   outer Layer scope). Remove for clarity. (Same callout as runtime
   review finding #4.)

5. **Make `Firegrid.subscribers.{timer, scheduledWork}` factories.**
   They are eagerly materialized Layer values today
   (`runtime/firegrid.ts:122-133`); `handler` and `eventStream` are
   factories. Either align the subscribers to factories
   (`subscribers.timer()`) or document why they are values. Cosmetic
   but consistent with the runtime review.

## What strict-baseline enforces vs gaps

**Enforced today:**

- `Effect.Service` and `.Default` are forbidden in
  `packages/substrate/src/producer.ts` by literal source-text checks
  (`effect-consistency.test.ts:75-105`). The same test asserts that
  `WorkProducer` and `CompletionProducer` use `Context.Tag` +
  `Layer.succeed` and that `SubstrateProducerLive(config)` returns a
  Layer with zero remaining requirements when given `streamUrl`.
- Public expected error classes do not extend `Error` or hand-roll
  `_tag` (`effect-consistency.test.ts:60-72`, scanning
  `operator-errors.ts`, `operator.ts`, `retained-records.ts`,
  `waits.ts`, `choreography/service.ts`).
- `Effect.runPromise|runSync|runFork` are warn-restricted by
  `eslint.config.js` outside the documented binary entry and lab
  React boundary (cross-reference: runtime review).
- Public-surface tests pin the curated substrate root export shape
  (`public-surface.test.ts:19, 39`).

**Gaps not enforced:**

- No guard prevents a future
  `Firegrid.handler` from forgetting to provide
  `CurrentWorkContext`. A plausible enforcement: a runtime test
  that wires a handler using `Choreography.sleep` and asserts the
  Effect returns instead of dying with "Service not found:
  substrate/CurrentWorkContext". Today the surface typechecks
  because `CurrentWorkContext` propagates outward as part of the
  caller's `R`.
- The convention-uniformity guard is producer-scoped only. There is
  no test that walks every package's source tree asserting "no
  `Effect.Service`" globally. Easy to add.
- No guard catches per-call layer construction (finding 6). A
  repo-wide ESLint or static check could flag
  `Effect.provide(<Tag>Live(...))` inside a function body that is
  itself `Effect.gen`-shaped.
- No test pins the layer-constructor selection. A repo-wide
  inventory step that reports which Tags use `Layer.scoped` vs
  `Layer.succeed` exists in `effect-artifact-inventory.json`
  (referenced from `SDD_FIREGRID_EFFECT_QUALITY.md`), but it is not
  failing.

The strict baseline shape is "correct conventions, with one runtime
correctness gap (finding 1) that the convention guard cannot see
because it is a wiring omission, not a syntactic one". Closing
finding 1 plus adding the global Tag-usage guard (finding 3 in
"What strict-baseline enforces") and the per-call layer-construction
guard (finding 6) covers the rest.
