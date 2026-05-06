# Effect-TS Runtime Review — Firegrid

Date: 2026-05-05
Scope: Effect runtime composition, Layer wiring, RuntimeContext shape,
`Firegrid.handler` / `Firegrid.eventStream` typing, `Firegrid.subscribers.*`,
`FiregridRuntimeBoot.{attached, embeddedDev}`, and an audit of
`Effect.run*` in production source. Tests, scripts, and docs are out of
scope per the brief.

## Summary

Post‑R0 the firegrid runtime topology is in good shape. The
`bin/firegrid.ts` entrypoint is a thin `Effect.scoped` + `NodeRuntime.runMain`
shell that delegates everything to `FiregridRuntimeBoot`; the resolver
indirection (attached vs embedded‑dev as two providers of one
`RuntimeStreamResolver` Tag) is the right shape; the long‑running
subscriber/handler/materializer fibers are uniformly built as
`Layer.scopedDiscard(Effect.forkScoped(...))` so layer finalization
interrupts them. There are zero `Effect.runPromise|runSync|runFork`
calls in production source outside the two documented surfaces
(`bin/firegrid.ts` `NodeRuntime.runMain`, and `LabEventStreamPanel.tsx`
React boundary with explicit `eslint-disable-next-line
no-restricted-syntax`). ESLint already flags `Effect.run*` at warn level.

The issues that remain are surface‑shape and discipline questions, not
correctness defects:

1. The runtime never provides a `CurrentWorkContext` Layer around the
   per‑run handler invocation, even though substrate's choreography
   primitives consume that Tag.
2. `FiregridClientLive` is a Layer factory only; there is no
   opinionated `ManagedRuntime` API for long‑lived backend client
   processes.
3. `RuntimeContext` carries a redundant projection of the same boot
   identity already on `FiregridRuntime` (`streamUrl`,
   `streamIdentity`).
4. `runOperationDispatchLoopWithAcquire` and
   `runScopedSubscriberLoopFromDb` add an inner `Effect.scoped` whose
   scope semantics overlap with the outer `forkScoped` scope; this is
   benign but the redundancy is non‑obvious.
5. `Firegrid.subscribers.{timer, scheduledWork}` are eagerly
   materialized values, not factories — slightly inconsistent with the
   `handler` / `eventStream` factory shape.

## Findings by concept

### `Effect.run*` discipline

Searched `packages/**` and `apps/**`, excluding `__tests__`, scripts,
and docs. The complete production‑source occurrence list is:

- `packages/runtime/bin/firegrid.ts:154` — `NodeRuntime.runMain(...)`.
  This is the documented binary entrypoint; not in scope.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:54` — `Effect.runFork(...)`
  inside a React `useEffect`, paired with…
- `apps/lab/src/lab/LabEventStreamPanel.tsx:82` — `Effect.runPromise(Fiber.interrupt(fiber))`
  in the cleanup callback.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:92` — `Effect.runPromiseExit(...)`
  in the click handler.

All three React‑boundary sites carry an explicit
`// eslint-disable-next-line no-restricted-syntax` comment with a
documented rationale (lines 51‑53, 80‑81, 89‑91). No other production
file calls `Effect.run*`. Discipline holds.

The repo's `eslint.config.js` already restricts `Effect.runPromise`,
`Effect.runPromiseExit`, `Effect.runSync`, and `Effect.runFork` via
`no-restricted-syntax` (lines 9‑22). That guard plus the documented
suppressions is the strict baseline; nothing further to enforce here.

### Layer composition (`runtime/firegrid.ts`, `runtime/layer.ts`)

`buildCoreRuntimeLayer` (`layer.ts:42`) is a small `Layer.unwrapScoped`
that resolves the `RuntimeStreamResolver`, builds the
`FiregridRuntimeService` value, and either returns the bare service
layer (when no caller `runtime` graph is supplied) or
`Layer.mergeAll(serviceLayer, runtime ▷ Layer.provide(runtimeContextLayer))`.
The pattern — `runtime` consumes `RuntimeContext`, the core layer
provides `RuntimeContext`, and both expose `FiregridRuntime` upward —
is correct. Two notes:

- `Layer.mergeAll(serviceLayer, wired)` (`layer.ts:74`) is fine because
  `wired` no longer requires `RuntimeContext`. The cast at `layer.ts:122-133`
  / `layer.ts:138-153` is documented and necessary because TS preserves
  a redundant `Exclude<…, RuntimeStreamResolver>` peel; the comment on
  `layer.ts:124-129` is honest about why.
- `Firegrid.eventStream`, `Firegrid.handler`, and the
  `subscribers.{timer, scheduledWork}` Layers all wear the type
  `Layer.Layer<never, never, R | RuntimeContext>`, so `runtime` is the
  app's caller‑built Layer of those Layers (typically via
  `Layer.mergeAll`). That contract is internally consistent.

### `RuntimeContext` shape (`runtime/runtime-context.ts`)

Today:

```
RuntimeContextService = { streamUrl, contentType, processId, streamIdentity }
FiregridRuntimeService = { processId, bootMode, streamIdentity }
```

`processId`, `streamIdentity`, and (transitively) `streamUrl` appear on
both. The duplication is intentional (one is the **app‑facing**
launchable capability, the other the **internal** binding context for
helper Layers), but the practical effect is that
`runtime/firegrid.ts:53` reads `streamUrl` and `contentType` from
`RuntimeContext`, while every test/inspection point that wants the
identity reads `FiregridRuntime.streamIdentity`. A single
`Layer.succeed` provides both at `layer.ts:61-72`, so consolidation is
cheap.

Splitting `RuntimeContext` into `ProcessContext` (processId,
contentType) + `StreamContext` (streamUrl, streamIdentity) — as the
review brief raises — would only pay off if a future helper Layer
needed one and not the other; today every consumer needs both. Keeping
the single Tag is the right call. The defensible cleanup is to drop
`processId` and `streamIdentity` from `RuntimeContextService` and have
helpers that need them read `FiregridRuntime`.

### `CurrentWorkContext` provision

The brief's call‑out is correct and worth flagging as the highest‑value
finding. `CurrentWorkContext` is defined in
`packages/substrate/src/choreography/context.ts:21-30` with helper
`currentWorkContextLayer`. Substrate choreography primitives (sleep,
scheduleAt, awaitAwakeable, …) read `workId` / `ownerId` from this Tag.

`Firegrid.handler` (`runtime/firegrid.ts:81-91`) dispatches a started
run to the caller's `run(input)` Effect, but `runOperationHandler`
(`runtime/internal/operation-handler.ts:89-95`) and the dispatch loop
(`runtime/internal/operation-handler.ts:103-219`) never wrap
`input.run(matched.input)` (line 133) in a `Layer.provide` /
`Effect.provide` of `currentWorkContextLayer({ workId, ownerId, ... })`
sourced from the matched `run`. That means a `Firegrid.handler` whose
body uses any choreography primitive that requires
`CurrentWorkContext` (sleep / scheduleAt / awaitAwakeable / etc.) will
fail to type‑check — or, worse, will compile when the handler's `R` is
left wide and die at runtime when the Tag isn't in context.

The fix is local to `runOperationDispatchLoopWithAcquire`: after
`matchStartedRun` resolves, derive a `CurrentWorkContextValue` from
`matched.run` (workId, ownerId, plus optional correlation/causation
plumbed through the operation envelope), build
`currentWorkContextLayer(value)`, and `Effect.provide` that layer to
the call to `input.run(matched.input)` only — not to the surrounding
loop. The `Firegrid.handler` public type can then advertise
`R = R | RuntimeContext` (no `CurrentWorkContext`) honestly: handlers
get the per‑message Tag for free.

### `Firegrid.handler` type signature vs implementation

Public:

```
handler<Op, E, R>(op, run): Layer.Layer<never, never, R | RuntimeContext>
```

Implementation calls `Layer.scopedDiscard(runOperationHandler(...))`
which is `Effect.gen` that yields `RuntimeContext` and forks
`runOperationDispatchLoop`. The loop's body invokes
`input.run(matched.input)` with caller‑supplied `R`. So the inner
effect's full requirement is `RuntimeContext | R`, matching the public
signature exactly. Threading is correct today.

The per‑run `R` (from the caller's `Effect.Effect<…, …, R>`) flows in
through the same Layer that provides `RuntimeContext`. That's the right
place: by the time the dispatch loop calls `input.run`, `R` has already
been satisfied at Layer wiring time. The only caveat is the
`CurrentWorkContext` gap above — which today is the user's
responsibility to pre‑provide, but should move into the dispatch
boundary.

### `Firegrid.eventStream` type signature vs implementation

Same shape:
`eventStream<S, E, R>(descriptor, materialize): Layer.Layer<never, never, R | RuntimeContext>`.
`runEventStreamMaterializer` (`event-stream-materializer.ts:72-82`)
yields `RuntimeContext` and forks the materializer loop, which calls
`input.materialize(event)` with caller `R`. Public type matches.

The materializer never needs `CurrentWorkContext` — events are
fire‑and‑forget downstream writes, not durable invocations — so the
omission is correct here.

### `Layer.scopedDiscard` use sites

Three sites:

1. `runtime/firegrid.ts:50` — `deadlineSubscriberLayer`.
2. `runtime/firegrid.ts:91` — `Firegrid.handler`.
3. `runtime/firegrid.ts:117` — `Firegrid.eventStream`.

Each runs an `Effect.gen` that calls `Effect.forkScoped(...)`. The
fork's parent scope is the layer's scope, so finalizing the providing
Layer interrupts the fiber. That is the correct shape for
"layer holds a long‑running fiber."

One non‑bug subtlety: each forked program (`runOperationDispatchLoopWithAcquire`,
`runScopedSubscriberLoopFromDb`, `runMaterializerLoop`) is itself
wrapped in `Effect.scoped`. Since `forkScoped` already makes the fork
inherit the calling scope, the inner `Effect.scoped` opens a *child*
scope that closes when the fork's body completes. That child scope
is what releases the `acquireDb` / `acquireSession` resources when
the loop exits or fails. This is correct — without the inner
`Effect.scoped`, those resources would be tied to the layer's lifetime
even after the loop crashed — but it deserves a one‑line comment
making the layered‑scope pattern explicit.

### `FiregridRuntimeBoot.{attached, embeddedDev}` factoring

Both call `buildRuntimeCoreFromOptions` then layer `Layer.provide` over
the resolver chain. Differences are exactly two:

- `attached` provides `attachedResolverLayer(streamUrl)` (no infra
  dependencies).
- `embeddedDev` provides `embeddedResolverLayer({...})` and supplies
  its `EmbeddedDurableStreams | DurableStreamAdmin` requirements via
  the inner `Layer.provide(resolver, infra)`.

This is the cleanest possible factoring of "two provider strategies for
the same Tag." A config‑driven single entry (e.g.
`FiregridRuntimeBoot.fromEnv()`) would add a soft env contract that the
review brief explicitly says belongs at the binary edge — and indeed
`bin/firegrid.ts:74-78` already implements that env switch in the one
place it belongs. Keep the two factories.

### `Firegrid.subscribers.{timer, scheduledWork}`

Defined as eagerly materialized Layer values
(`runtime/firegrid.ts:122-133`), one call to `deadlineSubscriberLayer`
each at module load. Because `Layer.scopedDiscard` produces a memoized
Layer, this is fine — each provided context gets one fork — but it's
inconsistent with `handler` and `eventStream`, which are factory
functions. There's no concrete bug; if a future profile wants a
parameter (e.g. metrics tag), having them be factories
(`Firegrid.subscribers.timer({ ... })`) is a smaller jump.

### `ManagedRuntime` opportunities

The `runtime` package never uses `ManagedRuntime`. That's correct: the
binary holds the live runtime under `Effect.scoped` +
`NodeRuntime.runMain` (`bin/firegrid.ts:72-89`, `:142-154`), which is
exactly what `ManagedRuntime` exists to wrap, and bringing
`ManagedRuntime` in would only add ceremony.

The interesting question is `packages/client/src/firegrid/operation-client.ts:297-300`:

```ts
export const FiregridClientLive = (
  cfg: FiregridClientConfig,
): Layer.Layer<FiregridClient> =>
  Layer.succeed(FiregridClient, buildFiregridClientService(cfg))
```

A long‑lived backend Node process that wants to call
`FiregridClient.send` / `result` from non‑Effect code (e.g. an Express
handler) today has to either:

- carry an `Effect.Effect<…, …, FiregridClient>` around and run it
  itself (forbidden by ESLint outside boundaries), or
- build its own `ManagedRuntime.make(FiregridClientLive(cfg))` and call
  `runtime.runPromise(...)`.

Adding an opinionated `FiregridClient.managed(cfg): { runPromise, dispose }`
helper — exactly the framework‑integration pattern the runtime skill
documents — would close the gap without exposing `Effect.run*`. The
review brief flags this as a candidate gap; it is.

### `Layer.provide` vs `Layer.merge` audit

Three locations use `Layer.mergeAll`:

- `layer.ts:74` — `Layer.mergeAll(serviceLayer, wired)`. Both produce
  `FiregridRuntime`/disjoint outputs; merge is correct.
- `layer.ts:146-149` — `Layer.mergeAll(EmbeddedDurableStreamsLive, DurableStreamAdminLive)`.
  Two unrelated services. Merge is correct.

`Layer.provide` is used wherever one layer satisfies another's
requirements: `runtime ▷ Layer.provide(runtimeContextLayer)`
(`layer.ts:73`), `core ▷ Layer.provide(attachedResolverLayer)`
(`layer.ts:130`), `core ▷ Layer.provide(Layer.provide(resolver, infra))`
(`layer.ts:150`). All correct.

### Custom runtime services

Beyond the public `FiregridRuntime` / `RuntimeContext` Tags, the
runtime defines three internal Tags (`stream-resolver.ts`):
`EmbeddedDurableStreams`, `DurableStreamAdmin`, `RuntimeStreamResolver`.
The shape is exemplary — every external dependency
(DurableStreamTestServer, DurableStream.create) is behind a Tag with a
default `Live` layer, so tests can swap any layer in the chain. No
findings.

## Out of scope (per brief)

- `__tests__` directories under `packages/runtime`, `packages/client`,
  `packages/substrate`, `apps/lab`. The detector flagged subscribers in
  `packages/substrate` for unrelated `with-style` issues; that is
  separate from this runtime review.
- `bin/firegrid.ts` `NodeRuntime.runMain` (documented entry boundary).
- `LabEventStreamPanel.tsx` `Effect.runFork` / `runPromise` /
  `runPromiseExit` (documented React lifecycle bridge with
  `eslint-disable` suppressions on lines 53, 81, 91).

## Top 5 highest‑leverage improvements

1. **Provide `CurrentWorkContext` inside the operation‑handler dispatch
   loop.** Without it, any `Firegrid.handler` body that uses substrate
   choreography primitives is broken at runtime. Fix in
   `packages/runtime/src/runtime/internal/operation-handler.ts:120-186`
   by deriving `{ workId, ownerId, correlation/causation }` from
   `matched.run` and `Effect.provide`‑ing
   `currentWorkContextLayer(value)` to the call to
   `input.run(matched.input)` on line 133.
2. **Add a `ManagedRuntime`‑backed convenience for the backend
   client.** Expose `FiregridClient.managed(cfg)` that internally
   builds `ManagedRuntime.make(FiregridClientLive(cfg))` and exposes
   `{ runPromise, dispose }` so non‑Effect callers don't reach for
   `Effect.run*`. Lives in
   `packages/client/src/firegrid/operation-client.ts`.
3. **Drop redundant fields from `RuntimeContextService`.** Remove
   `processId` and `streamIdentity` from
   `runtime/runtime-context.ts:19-24` and have helpers that need them
   read `FiregridRuntime`. Cuts the per‑process Tag down to its actual
   role: stream binding (`streamUrl`, `contentType`).
4. **Document the layered‑scope pattern in the three internal loops.**
   Add a comment to `operation-handler.ts:113`,
   `event-stream-materializer.ts:142`, and `runner.ts:119`/`:130`
   explaining why each forked loop has its own `Effect.scoped`
   (resource lifecycle on loop exit, not just on layer finalization).
   No code change.
5. **Make `Firegrid.subscribers.timer` / `scheduledWork` factories.**
   Convert them from materialized Layer values to zero‑arg factories
   (or factories taking a profile config) so the public surface shape
   is consistent with `handler` / `eventStream`. Forward‑compatible
   for adding metric tags / per‑subscriber configuration later.

## What strict‑baseline already enforces

- `eslint.config.js:9-22` warns on `Effect.runPromise`,
  `Effect.runPromiseExit`, `Effect.runSync`, `Effect.runFork`
  outside scoped suppressions. Production source has zero unsuppressed
  occurrences.
- `bin/firegrid.ts` and `LabEventStreamPanel.tsx` carry the only
  `eslint-disable-next-line no-restricted-syntax` annotations in
  production code (three sites, all in the lab panel) — and each has
  a one‑line comment naming the React/Node boundary.
- `runtime/firegrid.ts` keeps the public surface to three names
  (`subscribers`, `handler`, `eventStream`); `runtime/index.ts:35-53`
  enumerates the package's exports explicitly. There is no
  `FiregridRuntimeLive`, `FiregridRuntimeBootPlan`, or
  `boot-plan-from-env` helper — runtime process configuration is
  pinned to the binary edge.
- `runtime/internal/*.ts` files are private (the package's
  `index.ts` does not re‑export them); `Firegrid.handler` /
  `eventStream` / `subscribers` are the only public way to install
  long‑running runtime work.
- `Layer.scopedDiscard` is used uniformly for forked long‑running
  programs; `Effect.scoped` wraps each acquire boundary. The pattern
  is consistent across the three loops and is the right shape for
  "layer holds a fiber that owns a stream resource."
