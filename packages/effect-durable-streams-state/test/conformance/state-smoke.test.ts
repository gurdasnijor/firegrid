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

  it("late-registered collection sees the full history of its type", async () => {
    // Producer writes for type "user" BEFORE any collection() call. The
    // State opens at offset 0 and starts replaying immediately. When we
    // finally register the collection, it must materialize the full history.
    const url = streamUrl("state-late-register")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({ endpoint: { url }, producerId: "late-1" })

        // Pre-create a collection for "user", insert N entries via it.
        // (We need _something_ to talk through the producer since the State's
        // wire format lives in the encoded change-message form.)
        const writer = yield* state.collection({ type: "user", schema: User })
        for (let i = 0; i < 5; i++) {
          yield* writer.insert(`u${i}`, { name: `n${i}`, email: `e${i}@x` })
        }
        yield* Effect.sleep("300 millis")

        // Now spin up a SECOND State instance against the same stream,
        // and register the collection LATE — well after replay started.
        const state2 = yield* State.make({ endpoint: { url }, producerId: "late-2" })
        // Give the replay fiber a chance to consume some history without a
        // registered collection.
        yield* Effect.sleep("300 millis")
        const usersLate = yield* state2.collection({ type: "user", schema: User })

        // After a short propagation delay, the late collection must show
        // every entry — proving buffered events were replayed on register.
        yield* Effect.sleep("300 millis")
        const size = yield* usersLate.size
        expect(size).toBe(5)
        const first = yield* usersLate.get("u0")
        expect(Option.isSome(first)).toBe(true)
      }),
    )
  }, 20000)

  it("pre-registration buffer is bounded (FIFO drop)", async () => {
    // Write 5 entries, then create a fresh State with cap=2. The late
    // collection should only see the LAST 2 events because the buffer
    // drops oldest on overflow.
    const url = streamUrl("state-buffer-cap")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const writer = yield* State.make({ endpoint: { url }, producerId: "cap-w" })
        const writeUsers = yield* writer.collection({ type: "user", schema: User })
        for (let i = 0; i < 5; i++) {
          yield* writeUsers.insert(`u${i}`, { name: `n${i}`, email: `e${i}@x` })
        }
        yield* Effect.sleep("300 millis")

        // Spin up a SECOND State with cap=2 — replay starts, buffers events,
        // overflows to keep only the last 2.
        const capped = yield* State.make({
          endpoint: { url },
          producerId: "cap-r",
          maxBufferedEventsPerType: 2,
        })
        yield* Effect.sleep("300 millis")
        const usersLate = yield* capped.collection({ type: "user", schema: User })
        yield* Effect.sleep("300 millis")
        const size = yield* usersLate.size
        // Late collection sees AT MOST the last 2 + any post-registration
        // events (none here). Confirm cap enforced.
        expect(size).toBeLessThanOrEqual(2)
        expect(size).toBeGreaterThan(0)
      }),
    )
  }, 20000)

  it("write fails fast when the value does not conform to the collection schema", async () => {
    const url = streamUrl("state-schema-write")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({ endpoint: { url }, producerId: "schema-write" })
        const users = yield* state.collection({ type: "user", schema: User })
        // `email` is required-string per User schema. An unknown-shaped
        // value is rejected at the API boundary, BEFORE the wire write.
        const exit = yield* Effect.exit(
          users.insert("bad", { name: "x" } as unknown as { name: string; email: string }),
        )
        expect(exit._tag).toBe("Failure")
        // Materialization fiber should still be healthy — write-side
        // validation does not corrupt the read pipeline.
        const fail = yield* state.failure
        expect(Option.isNone(fail)).toBe(true)
      }),
    )
  }, 15000)

  it("State.failure surfaces a decode failure on a registered type", async () => {
    // Register the user collection with the User schema, then write a
    // wire-level message whose value does NOT conform — bypassing the
    // collection's encode path so the bad value lands on the stream. The
    // materialization fiber decodes against User, fails, and records the
    // failure for the caller to observe.
    const url = streamUrl("state-decode-fail")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const state = yield* State.make({ endpoint: { url }, producerId: "decode-fail" })
        const _users = yield* state.collection({ type: "user", schema: User })
        void _users

        // Bypass the collection encode and write a wire-shaped change msg
        // whose `value` doesn't match the User schema.
        const proto = DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        })
        yield* proto.append({
          type: "user",
          key: "bad",
          value: { name: 42, email: 99 },
          headers: { operation: "insert" },
        })

        // Give the live read a moment to round-trip and decode.
        for (let i = 0; i < 30; i++) {
          const fail = yield* state.failure
          if (Option.isSome(fail)) break
          yield* Effect.sleep("100 millis")
        }
        const finalFailure = yield* state.failure
        expect(Option.isSome(finalFailure)).toBe(true)
      }),
    )
  }, 30000)

  it("late registration replay preserves typed/control ordering", async () => {
    // Two Reset markers interleaved with typed events: a registration
    // that arrives AFTER all this history must replay events such that
    // each Reset clears the state that came before it. The previous
    // design applied typed events first and controls afterward, which
    // would have collapsed every reset to the end and produced an empty
    // collection.
    const url = streamUrl("state-replay-order")
    await runtime(
      DurableStream.define({ endpoint: { url }, schema: Schema.Unknown }).create({
        contentType: "application/json",
      }),
    )

    await runtime(
      Effect.gen(function* () {
        // Write the history directly through the protocol stream so each
        // append is a synchronous one-shot HTTP POST and order is
        // deterministic on the wire. (Going via writer-State would batch
        // the inserts and the resets — issued through a different
        // append path — could interleave non-deterministically.)
        const proto = DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        })

        const change = (key: string, value: { name: string; email: string }) =>
          proto.append({
            type: "user",
            key,
            value,
            headers: { operation: "insert" },
          }).pipe(Effect.asVoid)

        const reset = () =>
          proto.append({ headers: { control: "reset" } }).pipe(Effect.asVoid)

        yield* change("u1", { name: "A", email: "a@x" })
        yield* reset()
        yield* change("u2", { name: "B", email: "b@x" })
        yield* reset()
        yield* change("u3", { name: "C", email: "c@x" })

        // Now start a State and register the collection AFTER all events
        // are on the wire. Replay must apply the two resets in order:
        // u1 → reset (cleared) → u2 → reset (cleared) → u3 → only u3 remains.
        const latestate = yield* State.make({ endpoint: { url }, producerId: "rep-r" })
        // Let the live-read replay catch up before we register the
        // collection so events sit in the pre-registration log.
        yield* Effect.sleep("300 millis")
        const usersLate = yield* latestate.collection({ type: "user", schema: User })
        yield* Effect.sleep("200 millis")

        const size = yield* usersLate.size
        const u3 = yield* usersLate.get("u3")
        expect(size).toBe(1)
        expect(Option.isSome(u3)).toBe(true)
      }),
    )
  }, 30000)

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
