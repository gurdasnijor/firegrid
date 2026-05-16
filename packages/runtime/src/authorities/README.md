# Runtime Authorities

`authorities/` owns durable Effect capability providers. An authority is not a
new type family; it is the unique live layer that provides capability tags for
a durable table family.

Use stock Effect surfaces:

- append-only writes: `Queue.Enqueue<Row>`;
- stream-terminal writes: `Sink.Sink<Out, In, L, E, R>`;
- observations: `Stream.Stream<Row, E, R>`;
- lookups or committed-row writes: narrow object services returning `Effect`.

## Pipeline Fit

Authorities sit at durable commit and replay points. `pipeline/` and
`subscribers/` consume capability tags; they should not accept `DurableTable`
facades or table-taking helpers. Provider internals may touch tables, but that
surface must not leak into production consumers.

Dynamic `wait_for` source registration is separate from static subscriber
reads. Static subscribers consume `Stream` capability tags through the Effect
requirement channel. Dynamic wait lookup uses `SourceCollectionHandle`
registrations that resolve to the same underlying durable streams.

## Boundary Rules

- Export capability tags and provider layers, not registry metadata.
- Keep table-taking helpers private provider internals or explicit test
  fixtures.
- Do not encode lifecycle policy in row providers. For waits, the provider
  owns wait rows and completion rows; the operator/router interprets them.
