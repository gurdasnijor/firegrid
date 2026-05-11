# effect-durable-streams-state

Effect-native client for the [Durable Streams State Protocol](https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md). Built on [`effect-durable-streams`](../effect-durable-streams).

Per-type collections with schema-validated values, tagged `Insert`/`Update`/`Delete` events, snapshot/reset control messages.

## Quick start

```ts
import { State } from "effect-durable-streams-state"
import { Effect, Schema, Stream } from "effect"

const User = Schema.Struct({ name: Schema.String, email: Schema.String })

const program = Effect.gen(function* () {
  const state = yield* State.make({
    endpoint: { url: "https://streams.example.com/app-state" },
    producerId: "node-1",
  })

  const users = yield* state.collection({ type: "user", schema: User })

  yield* users.insert("alice", { name: "Alice", email: "alice@example.com" })

  const alice = yield* users.get("alice")
  // Option.some({ name: "Alice", email: "alice@example.com" })

  // Live changes
  yield* users.changes.pipe(
    Stream.tap((event) => Effect.log(event)),
    Stream.runDrain,
  )
})
```
