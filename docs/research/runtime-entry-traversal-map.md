# Runtime Entry Traversal Map

Source: removed historical handoff notes, `docs/proposals/SDD_STREAM_FIRST_SUBSTRATE_SIMPLIFICATION.md`, `features/firegrid/stream-first-substrate-simplification.feature.yaml`, `packages/runtime/bin/firegrid.ts`, and `packages/runtime/src/run.ts`.

This map follows `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.1` and `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.2`: start at the runtime entrypoints, descend reachable imports, and stop at the first outdated concept on each branch.

## Relevant ACIDs

- `stream-first-substrate-simplification.CLIENT_RUNTIME_FIRST.1`: design starts from `@firegrid/client` and `@firegrid/runtime`, not from preserving substrate concepts.
- `stream-first-substrate-simplification.CLIENT_RUNTIME_FIRST.3`: runtime examples import substrate internals only through runtime-owned implementation code, not canonical handler authoring APIs.
- `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.1`: runtime simplification starts from `packages/runtime/bin/firegrid.ts` and `packages/runtime/src/run.ts`.
- `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.2`: follow the reachable import tree downward until the first outdated concept.
- `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.3`: branches reaching concepts already provided by Durable Streams State or Effect are classified for replacement, privatization, or deletion.
- `stream-first-substrate-simplification.RUNTIME_TRAVERSAL.4`: traversal artifacts include a before/after for the caller-supplied runtime Layer.
- `stream-first-substrate-simplification.STREAMDB_STATE.1`: stateful durable Firegrid data uses Durable Streams State Protocol collections as canonical persisted shape.
- `stream-first-substrate-simplification.STREAMDB_STATE.2`: confirmed state writes use `createStreamDB` actions with transaction ids and `awaitTxId`.
- `stream-first-substrate-simplification.STREAMDB_STATE.3`: generated write helpers lower to StreamDB actions rather than Firegrid-specific append helpers.
- `stream-first-substrate-simplification.STREAM_OBSERVATION.1`: public observation APIs expose Effect Stream values or StreamDB/live-query-native collection surfaces.
- `stream-first-substrate-simplification.STREAM_OBSERVATION.2`: public APIs do not wrap standard Stream operators.
- `stream-first-substrate-simplification.STREAM_OBSERVATION.3`: observation paths avoid snapshot-then-stream races without a single durable no-gap follow boundary.
- `stream-first-substrate-simplification.CLOCK_TIME.1`: new durable time examples use Effect Clock-backed APIs.
- `stream-first-substrate-simplification.CLOCK_TIME.2`: new durable time examples do not add Firegrid-specific sleep, wait, timeout, retry, or schedule verbs.
- `stream-first-substrate-simplification.CLOCK_TIME.3`: existing RunWait/choreography time APIs remain compatibility surfaces until migration.
- `stream-first-substrate-simplification.PUBLIC_EXAMPLES.3`: new runtime examples author product actions or typed operation outputs rather than raw State Protocol row envelopes.
- `stream-first-substrate-simplification.DEPRECATION.1`: substrate APIs may remain private or deprecated compatibility while replacements land.
- `stream-first-substrate-simplification.DEPRECATION.3`: `appendChange` is internal compatibility, not public or canonical state write path.
- `stream-first-substrate-simplification.DEPRECATION.4`: each substrate concept must prove it is not already provided upstream before remaining public.
- `stream-first-substrate-simplification.AUTHORITY.3`: runtime-only claim, checkpoint, and terminal-winner algorithms remain runtime-owned private implementation when Durable Streams State does not provide the semantics.

## Entry Tree

```text
packages/runtime/bin/firegrid.ts
`-- packages/runtime/src/index.ts
    |-- packages/runtime/src/run.ts
    |   `-- packages/runtime/src/boot.ts
    |       |-- packages/runtime/src/internal/identity.ts
    |       |   `-- @firegrid/substrate/id-gen
    |       |-- packages/runtime/src/internal/stream-resolver.ts
    |       |-- packages/runtime/src/context.ts
    |       `-- packages/runtime/src/service.ts
    |-- packages/runtime/src/boot.ts
    |-- packages/runtime/src/composition.ts
    |-- packages/runtime/src/context.ts
    |-- packages/runtime/src/service.ts
    `-- packages/runtime/src/runtime-api.ts        first stale branch
        |-- @firegrid/substrate/kernel             first outdated concept
        |-- @firegrid/substrate                    current work context ids
        |-- packages/runtime/src/internal/runner.ts
        |   |-- @firegrid/substrate/kernel         stale subscriber/projection snapshot branch
        |   `-- @durable-streams/client            raw stream edge source
        |-- packages/runtime/src/internal/operation-handler.ts
        |   |-- @firegrid/substrate/kernel         stale durable.run/append branch
        |   |-- @firegrid/substrate                current work context ids
        |   `-- @durable-streams/client            raw DurableStream append handle
        |-- packages/runtime/src/internal/event-stream-materializer.ts
        |   |-- @durable-streams/client            raw DurableStream live-tail handle
        |   `-- @firegrid/substrate/descriptors    EventStream envelope helpers
        `-- packages/runtime/src/internal/wake-stream.ts

packages/runtime/src/run.ts
`-- packages/runtime/src/boot.ts
    |-- packages/runtime/src/internal/identity.ts
    |   `-- @firegrid/substrate/id-gen
    |-- packages/runtime/src/internal/stream-resolver.ts
    |-- packages/runtime/src/context.ts
    `-- packages/runtime/src/service.ts
```

`packages/runtime/src/run.ts` itself stays on the clean attached-runtime path: it accepts a caller-supplied `Layer`, provides `FiregridRuntimeBoot.attached`, and never imports `runtime-api.ts`. The stale branch appears when the package root or runtime callers use `Firegrid` from `runtime-api.ts`.

## Branch Classifications

### `bin/firegrid.ts` and `run.ts` boot path

Classification: `keep public`.

Reason: the attached runtime process and `run({ connection, runtime })` Layer entrypoint match the client/runtime-first direction; they do not expose substrate kernel, subscribers, RunWait, EventPlane, ProjectionSnapshot, `appendChange`, raw DurableStream handles, or durable.run helpers.

Notes: `boot.ts -> internal/identity.ts` imports `IdGen` and `IdGenLive` from `@firegrid/substrate/id-gen`, but this is private process-id generation rather than a public app/runtime authoring branch.

### `src/index.ts -> src/runtime-api.ts`

Classification: `replace`.

Exact outdated concepts imported at the first stale branch:

- substrate kernel via `@firegrid/substrate/kernel`
- subscriber helpers: `runTimerSubscriberFromSnapshot`, `runScheduledWorkSubscriberFromSnapshot`, `runProjectionMatchSubscriberFromSnapshot`
- `ProjectionSnapshot`
- `EventStream`
- ready-work and durable.run shapes: `deriveReadyWork`, `processReadyWorkItem`, `ReadyWorkItem`, `RunValue`, `ClaimOutcome`, `CompletionKind`, `SubscriberInput`, `SubscriberError`
- kernel database helpers: `acquireSubstrateDb`, `snapshotFromDb`
- substrate current work context: `OwnerId`, `WorkId`, `currentWorkContextLayer`, `CurrentWorkContext`
- RunWait compatibility in the handler comments and resume model

Reason: `Firegrid` is still the public helper namespace, but its implementation lowers directly through substrate kernel snapshots, subscriber helpers, and ready-work compatibility; the public runtime seam should remain descriptor/client-runtime shaped while these internals move to StreamDB actions, Effect Stream, Effect Clock, or private runtime authority.

### `Firegrid.subscribers.* -> internal/runner.ts`

Classification: `delete`.

Exact outdated concepts imported by the branch:

- substrate kernel database helpers: `acquireSubstrateDb`, `snapshotFromDb`
- `SubstrateStreamDB`
- `ProjectionSnapshot`
- `CompletionValue`
- raw Durable Streams edge source: `stream as openDurableStream`, `StreamResponse`
- subscriber/deadline scan loop over completions and EventPlane row families

Reason: public `Firegrid.subscribers.timer`, `scheduledWork`, and `projectionMatch` teach runtime authors to install substrate subscriber loops; stream-first runtime examples should use Effect Clock/Stream and descriptor-generated runtime processing, with any remaining claim/deadline machinery private under `stream-first-substrate-simplification.AUTHORITY.3`.

### `Firegrid.handler -> internal/operation-handler.ts`

Classification: `replace`.

Exact outdated concepts imported by the branch:

- raw `DurableStream` append handle from `@durable-streams/client`
- substrate root current work context: `OwnerId`, `WorkId`, `currentWorkContextLayer`, `CurrentWorkContext`
- substrate kernel database helpers: `acquireSubstrateDb`, `snapshotFromDb`, `SubstrateStreamDB`
- Firegrid-specific state append helper: `appendChange`
- durable.run helpers: `completeRunEffect`, `failRunEffect`, `isOperationEnvelope`, `RunValue`
- boundary codecs from the substrate kernel: `decodeAtBoundary`, `encodeAtBoundary`

Reason: a typed operation handler is still a valuable runtime surface, but the current dispatch and terminalization path is built on raw durable.run rows plus `appendChange`; the stream-first replacement should lower operation lifecycle writes through StreamDB-backed actions or runtime-private authority helpers.

### `Firegrid.handler -> runReadyWorkOperator` inside `runtime-api.ts`

Classification: `make private`.

Exact outdated concepts imported by the branch:

- `deriveReadyWork`
- `processReadyWorkItem`
- `ProjectionSnapshot`
- `ReadyWorkItem`
- `RunValue`
- `ClaimOutcome`
- `acquireSubstrateDb`
- `snapshotFromDb`
- substrate current work context: `OwnerId`, `WorkId`, `currentWorkContextLayer`, `CurrentWorkContext`
- RunWait resume model in comments

Reason: ready-work claim and terminal-winner behavior may remain runtime-owned private implementation where upstream Durable Streams State does not provide the semantics, but it should not be visible as the canonical operation-handler model or coupled to public RunWait examples.

### `Firegrid.eventStream -> internal/event-stream-materializer.ts`

Classification: `replace`.

Exact outdated concepts imported by the branch:

- raw `DurableStream` and `StreamResponse` from `@durable-streams/client`
- Firegrid EventStream descriptor/envelope helpers: `EventStream`, `eventStreamEnvelopeFromStateRow`, `isEventStreamEnvelope`
- raw live-tail materialization over State Protocol rows

Reason: the descriptor-driven materializer is useful behavior, but the current branch follows raw retained rows and Firegrid EventStream envelopes; stream-first observation should expose Effect Stream or StreamDB/live-query-native surfaces with no Firegrid-specific stream-operator wrapper or snapshot/live race.

### `internal/wake-stream.ts`

Classification: `make private`.

Reason: this helper is not stale by itself; it is a small internal Effect Stream bridge and should remain hidden behind whichever runtime-private replacement keeps a callback-style durable source alive.

## Caller-Supplied Runtime Layer

Before:

```ts
run({
  connection: { streamUrl },
  runtime: Firegrid.composeRuntime({
    handlers: [Firegrid.handler(operation, handler)],
    subscribers: [
      Firegrid.subscribers.timer,
      Firegrid.subscribers.scheduledWork,
      Firegrid.subscribers.projectionMatch({ evaluate }),
    ],
    eventStreams: [Firegrid.eventStream(events, materialize)],
  }),
})
```

This shape pulls public runtime authors toward substrate subscriber loops, EventStream envelopes, RunWait resume semantics, and durable.run row terminalization.

After target:

```ts
run({
  connection: { streamUrl },
  runtime: appRuntimeLayer,
})
```

`appRuntimeLayer` should be composed from descriptor-generated operation processors, generated StreamDB actions, Effect Stream observation, and the Firegrid runtime context. Runtime-only claim, checkpoint, and terminal-winner algorithms can remain private if needed, but app code should not import substrate kernel, raw DurableStream handles, `appendChange`, RunWait, EventPlane producer/projection internals, or ProjectionSnapshot.

## First Stale Branch Found

The first stale branch is `packages/runtime/bin/firegrid.ts -> packages/runtime/src/index.ts -> packages/runtime/src/runtime-api.ts`. The runtime binary itself is clean and attached-only, but the public root import reaches `runtime-api.ts`, where `Firegrid` immediately imports substrate kernel, subscriber snapshot helpers, `ProjectionSnapshot`, ready-work/durable.run concepts, and substrate current-work context ids.
