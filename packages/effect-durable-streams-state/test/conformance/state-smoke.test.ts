import { DurableStreamTestServer } from "@durable-streams/server"
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, type Scope } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { State } from "../../src/index.ts"

let server: DurableStreamTestServer
let baseUrl: string

beforeAll(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterAll(async () => {
  await server.stop()
})

const streamUrl = (name: string) =>
  `${baseUrl}/v1/stream/${name}-${crypto.randomUUID()}`

const User = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
})

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

const runtime = <A, E>(eff: Effect.Effect<A, E, Reqs>) =>
  Effect.runPromise(
    Effect.scoped(eff.pipe(Effect.provide(FetchHttpClient.layer))) as unknown as Effect.Effect<A, E, never>,
  )

describe("Phase 2 state smoke", () => {
  it("creates a collection, inserts, and observes typed events", async () => {
    const url = streamUrl("state")
    // The State needs the underlying stream to exist; we pre-create it.
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({
          endpoint: { url },
          producerId: "state-1",
        })
        const users = yield* state.collection({ type: "user", schema: User })

        yield* users.insert("u1", { name: "Alice", email: "alice@example.com" })
        yield* users.update("u1", { name: "Alice", email: "alice@new.example.com" }, {
          oldValue: { name: "Alice", email: "alice@example.com" },
        })

        // Allow materialization fiber to consume.
        yield* Effect.sleep("150 millis")

        const alice = yield* users.get("u1")
        expect(Option.isSome(alice)).toBe(true)
        if (Option.isSome(alice)) {
          expect(alice.value.email).toBe("alice@new.example.com")
        }

        yield* users.delete("u1", { oldValue: { name: "Alice", email: "alice@new.example.com" } })
        yield* Effect.sleep("150 millis")
        const gone = yield* users.get("u1")
        expect(Option.isNone(gone)).toBe(true)
      }),
    )
  }, 15000)

  it("multi-type isolation: ops on one type don't affect another", async () => {
    const url = streamUrl("state-multi")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    const Doc = Schema.Struct({ title: Schema.String })

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({ endpoint: { url }, producerId: "state-multi" })
        const users = yield* state.collection({ type: "user", schema: User })
        const docs = yield* state.collection({ type: "doc", schema: Doc })

        yield* users.insert("u1", { name: "A", email: "a@x" })
        yield* docs.insert("d1", { title: "Doc 1" })
        yield* Effect.sleep("150 millis")

        const u = yield* users.size
        const d = yield* docs.size
        expect(u).toBe(1)
        expect(d).toBe(1)
      }),
    )
  }, 15000)

  it("SchemaConflict on incompatible schema for existing type", async () => {
    const url = streamUrl("state-conflict")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    const Other = Schema.Struct({ name: Schema.Number })

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({ endpoint: { url }, producerId: "state-conflict" })
        yield* state.collection({ type: "user", schema: User })
        const result = yield* Effect.exit(
          state.collection({ type: "user", schema: Other as unknown as typeof User }),
        )
        expect(result._tag).toBe("Failure")
      }),
    )
  }, 15000)
})
