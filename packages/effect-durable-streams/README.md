# effect-durable-streams

Effect-native client for the [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md).

Reads are `Stream<A, ReadError, Scope>`. Writes are `Sink<void, A, never, WriteError, never>`. Schema validates at the wire boundary. Resources are scoped. Retries, tracing, and interruption come from `@effect/platform/HttpClient`.

## Status

Phase 1 implementation: catch-up + long-poll + SSE reads, one-shot append, idempotent producer, stream lifecycle (create/close/delete). Conformance-tested against the reference `@durable-streams/server`.

## Quick start

```ts
import { DurableStream } from "effect-durable-streams"
import { Effect, Schema, Stream } from "effect"

const ChatMessage = Schema.Struct({
  user: Schema.String,
  text: Schema.String,
})

const chat = DurableStream.define({
  endpoint: { url: "https://streams.example.com/chat/room-1" },
  schema: ChatMessage,
})

// Read live
const program = Effect.gen(function* () {
  yield* chat.read({ live: "sse" }).pipe(
    Stream.tap((msg) => Effect.log(`${msg.user}: ${msg.text}`)),
    Stream.runDrain,
  )
})

// Produce
const writes = Effect.gen(function* () {
  const producer = yield* chat.producer({ producerId: "node-1", autoClaim: true })
  yield* Stream.fromIterable([
    { user: "alice", text: "hello" },
    { user: "bob", text: "world" },
  ]).pipe(Stream.run(producer))
})
```

See `src/DurableStream.ts` for the full namespace.
