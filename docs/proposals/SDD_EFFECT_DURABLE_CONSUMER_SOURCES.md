# SDD: Effect Durable Consumer Sources

**Status:** proposed
**Scope:** narrow follow-up to `SDD_EFFECT_DURABLE_OPERATORS.md`
**Primary consumer:** `packages/effect-durable-operators/src/DurableConsumer.ts`

## Problem

`DurableConsumer` currently requires an `effect-durable-streams`
`DurableStream.Bound` as its source. That keeps Firegrid on the correct
Durable Streams substrate, but it also overfits the generic consumer operator
to one concrete source API.

The consumer's real source contract is smaller:

```txt
give me an Effect Stream of typed facts,
optionally live,
and let ConsumerCheckpointStore own processing progress
```

That contract should be explicit. Durable Streams remains Firegrid's production
source. A second adapter should prove the interface is not accidentally shaped
only around Durable Streams.

## References

- `packages/effect-durable-operators/src/DurableConsumer.ts`
- `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`
- Electric Shape HTTP API: `https://electric.ax/openapi#/paths/~1v1~1shape/get`
- Electric TypeScript client docs: `https://electric-sql.com/docs/api/clients/typescript`
- D2TS repo and Electric example:
  `https://github.com/electric-sql/d2ts/tree/main`
  `https://github.com/electric-sql/d2ts/blob/main/examples/electric/src/index.ts`

## Required ACIDs

- `effect-durable-operators.SOURCE.1`
- `effect-durable-operators.SOURCE.2`
- `effect-durable-operators.SOURCE.3`
- `effect-durable-operators.SOURCE.4`
- `effect-durable-operators.SOURCE.5`
- `effect-durable-operators.TRACER_018.1`
- `effect-durable-operators.TRACER_018.2`
- `effect-durable-operators.TRACER_018.3`

## Target Shape

Add a small source protocol owned by the operators package:

```ts
export interface ConsumerSource<Fact, E = never, R = never> {
  readonly read: (
    options?: { readonly live?: boolean },
  ) => Stream.Stream<Fact, E, R>
}
```

Then change `DurableConsumer.run` and `DurableConsumer.stream` to accept:

```ts
readonly source: ConsumerSource<Fact, ESource, RSource>
```

instead of:

```ts
readonly source: DurableStream.Bound<Fact, FactI>
```

The consumer still returns a combined Effect environment/error channel:

```txt
source error
  | process error
  | DurableConsumerError
```

```txt
source requirements
  | process requirements
  | ConsumerCheckpointStore
```

Do not hide Effect `Stream`. `ConsumerSource` is only the minimal read
capability needed by `DurableConsumer`.

## Durable Streams Adapter

Ship the production adapter first:

```ts
export const fromDurableStream = <A, I>(
  bound: DurableStream.Bound<A, I>,
): ConsumerSource<A, DurableStream.ReadError, HttpClient.HttpClient> => ({
  read: (options) => bound.read(options),
})
```

All existing DurableConsumer tests should migrate to
`ConsumerSource.fromDurableStream(...)`.

Firegrid runtime input delivery should also use
`ConsumerSource.fromDurableStream(...)`. Firegrid remains on the Durable
Streams substrate; the source interface is not a request to use Electric in
production.

## Electric/D2TS Adapter Proof

Add a second adapter to prove that the interface is genuinely source-shaped.

Electric's Shape API exposes table-shaped changes over HTTP. The TypeScript
client provides `ShapeStream`/`Shape` abstractions for consuming shape logs.
D2TS provides incremental graph execution over changing input streams, and its
Electric example adapts Electric shape changes into a D2TS input.

The adapter proof should be source-only:

```ts
export const fromElectricShape = <Fact, E, R>(options: {
  readonly stream: ShapeStream<unknown>
  readonly decode: (message: unknown) => Option.Option<Fact>
}): ConsumerSource<Fact, E, R>
```

The exact public signature may differ to match the Electric/D2TS package API,
but the boundary must stay this narrow:

```txt
Electric ShapeStream or D2TS output
  -> typed facts
  -> ConsumerSource.read(...)
  -> DurableConsumer
```

Do not let Electric offsets, handles, or shape progress become consumer
processing checkpoints. Those describe progress through the Electric shape
log. DurableConsumer's AtMostOnce/AtLeastOnce semantics are still governed by
`ConsumerCheckpointStore`.

## Non-Goals

- Do not replace Firegrid's Durable Streams substrate with Electric.
- Do not make Electric a table backend for `DurableTable` in this tracer.
- Do not treat Electric shape offsets as side-effect processing checkpoints.
- Do not add workflow, prompt, required-action, or tool semantics to
  `effect-durable-operators`.
- Do not introduce a broad source framework. One method, `read`, is enough.

## Tests

Required tests:

1. A Durable Streams source test proving existing consumer behavior still works
   through `ConsumerSource.fromDurableStream`.
2. A Firegrid path or package-level migration proving production runtime input
   code no longer depends on `DurableStream.Bound` directly in
   `DurableConsumer.run`.
3. An Electric/D2TS source test using the same `DurableConsumer.run` path as
   the Durable Streams test.
4. A checkpoint separation test: replaying the same Electric shape source with
   existing `ConsumerCheckpointStore` rows must skip already-completed logical
   keys, independent of Electric source offsets.

If a live Electric service is too heavy for package tests, use the official
Electric/D2TS shape message types and a local `ShapeStream`-compatible fixture.
Do not mock `DurableConsumer`; the proof is that the real consumer accepts a
non-Durable-Streams source.

## Acceptance

This tracer is complete when:

- `DurableConsumer` depends on `ConsumerSource`, not directly on
  `DurableStream.Bound`;
- `ConsumerSource.fromDurableStream` is the adapter used by existing DS-backed
  consumer tests and Firegrid code;
- an Electric/D2TS-backed source test proves the same consumer API accepts a
  second backend;
- docs and README examples show DS as the primary production path and
  Electric/D2TS as an adapter proof;
- all ACIDs listed above are referenced by tests or implementation comments.
