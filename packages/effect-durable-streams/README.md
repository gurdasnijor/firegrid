# `effect-durable-streams`

Low-level Effect adapter for the
[Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md).

Most Firegrid state should use
[`effect-durable-operators` `DurableTable`](../effect-durable-operators/README.md)
instead. Use this package only when you intentionally need raw retained stream
semantics, such as an append-only fact stream or a generic producer-fenced
append path.

## Public API

```ts
import { DurableStream } from "effect-durable-streams"
```

`DurableStream.define(...)` returns a schema-bound stream facade with
Effect-native operations:

- `create`
- `append`
- `appendWithProducer`
- `collect`
- `read`
- `producer`
- `snapshotThenFollow`

Reads are `Stream`s. Writes are `Effect`s or scoped producers. Schema
validation happens at the wire boundary.

`appendWithProducer` is a one-shot producer-fenced append for callers that
need to distinguish a newly accepted append from an idempotent duplicate:

```ts
const result = yield* DurableStream.appendWithProducer({
  endpoint,
  schema: Message,
  event: { user: "alice", text: "hello" },
  producerId: "message-123",
  producerEpoch: 0,
  producerSeq: 0,
})
```

## Example

```ts
import { DurableStream } from "effect-durable-streams"
import { Effect, Schema, Stream } from "effect"

const Message = Schema.Struct({
  user: Schema.String,
  text: Schema.String,
})

const messages = DurableStream.define({
  endpoint: { url: "https://streams.example.com/v1/stream/chat.room-1" },
  schema: Message,
})

const write = messages.append({ user: "alice", text: "hello" })

const readLive = messages.read({ live: "sse" }).pipe(
  Stream.tap((message) => Effect.log(`${message.user}: ${message.text}`)),
  Stream.runDrain,
)
```

## When Not To Use This Package

Do not build table state, checkpoints, projections, or app query surfaces on
raw streams. Model those as owner-local `DurableTable` declarations and use
the generated `insert`, `upsert`, `delete`, `get`, `query`, `subscribe`, and
read-only TanStack collection views.

This package remains as the narrow raw-stream escape hatch.
