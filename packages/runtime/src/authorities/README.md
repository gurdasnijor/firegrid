# Runtime Control-Plane Authorities

`authorities/` owns runtime control-plane capability providers and shared
authority helpers. Agent event-pipeline runtime output and ingress authorities
live under `agent-event-pipeline/authorities/`.

An authority is not a new type family; it is the unique live layer that
provides capability tags for a durable table family.

Use stock Effect surfaces:

- append-only writes: `Queue.Enqueue<Row>`;
- stream-terminal writes: `Sink.Sink<Out, In, L, E, R>`;
- observations: `Stream.Stream<Row, E, R>`;
- lookups or committed-row writes: narrow object services returning `Effect`.

Example shape:

```ts
export class RuntimeAgentOutputAfterEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputAfterEvents",
)<RuntimeAgentOutputAfterEvents, {
  readonly after: (
    contextId: string,
    sequence: number,
  ) => Stream.Stream<RuntimeEventRow, DurableTableError>
}>() {}

export const RuntimeAgentOutputEventsLayer: Layer.Layer<
  RuntimeAgentOutputEvents | RuntimeAgentOutputAfterEvents,
  never,
  RuntimeOutputTable
>
```

This mirrors Effect's own least-privilege split. A `Queue` value may support
enqueue and dequeue, but producers should depend only on `Queue.Enqueue`. A
runtime table layer may provide many tags, but consumers should request only the
capability they need.

## Pipeline Fit

Authorities sit at durable commit and replay points. `agent-event-pipeline`
session runtime and subscribers consume capability tags; they should not accept
`DurableTable` facades or table-taking helpers. Provider internals may touch
tables, but that surface must not leak into production consumers.

Dynamic `wait_for` source registration is separate from static subscriber
reads. Static subscribers consume `Stream` capability tags through the Effect
requirement channel. Dynamic wait lookup uses `SourceCollectionHandle`
registrations that resolve to the same underlying durable streams.

Provider layers group only the surviving read-side tags over the same table
family. Callers should not depend on a bundled "journal service."

## Boundary Rules

- Export capability tags and provider layers, not registry metadata.
- Keep table-taking helpers private provider internals or explicit test
  fixtures.
- Do not encode lifecycle policy in row providers. For waits, the provider
  owns wait rows and completion rows; the operator/router interprets them.
