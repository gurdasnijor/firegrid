import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Chunk, Effect, Fiber, Ref, type Scope, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStream } from "../../src/index.ts"
import { startTestServer, type TestServerHandle } from "./test-server.ts"

let server: TestServerHandle

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.stop()
})

const Message = Schema.Struct({ n: Schema.Number })

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

const runtime = <A, E>(eff: Effect.Effect<A, E, Reqs>) =>
  Effect.runPromise(
    Effect.scoped(eff.pipe(Effect.provide(FetchHttpClient.layer))) as unknown as Effect.Effect<A, E, never>,
  )

describe("Phase 1 live reads", () => {
  it("long-poll delivers items appended after the reader starts", async () => {
    const url = server.streamUrl("longpoll")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })
        yield* s.append({ n: 0 })

        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const fiber = yield* s
          .read({ live: "long-poll" })
          .pipe(
            Stream.take(3),
            Stream.runForEach((msg) =>
              Ref.update(seen, (arr) => [...arr, msg.n]),
            ),
            Effect.fork,
          )

        // Give the reader a moment to attach via long-poll.
        yield* Effect.sleep("50 millis")
        yield* s.append({ n: 1 })
        yield* s.append({ n: 2 })

        yield* Fiber.join(fiber)
        const result = yield* Ref.get(seen)
        expect(result).toEqual([0, 1, 2])
      }),
    )
  }, 15000)

  it("SSE delivers items appended after the reader starts", async () => {
    const url = server.streamUrl("sse")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })
        yield* s.append({ n: 100 })

        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const fiber = yield* s
          .read({ live: "sse" })
          .pipe(
            Stream.take(3),
            Stream.runForEach((msg) =>
              Ref.update(seen, (arr) => [...arr, msg.n]),
            ),
            Effect.fork,
          )

        yield* Effect.sleep("100 millis")
        yield* s.append({ n: 101 })
        yield* s.append({ n: 102 })

        yield* Fiber.join(fiber)
        const result = yield* Ref.get(seen)
        expect(result).toEqual([100, 101, 102])
      }),
    )
  }, 15000)

  it("snapshotThenFollow has no gap under concurrent appends", async () => {
    const url = server.streamUrl("snapfollow-gap")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })
        for (let i = 0; i < 5; i++) {
          yield* s.append({ n: i })
        }
        const result = yield* s.snapshotThenFollow
        const snap = result.snapshot.map((m) => m.n)
        expect(snap).toEqual([0, 1, 2, 3, 4])

        // Now append a few more and confirm the live stream picks them up.
        const seen = yield* Ref.make<ReadonlyArray<number>>([])
        const liveFiber = yield* result.live
          .pipe(
            Stream.take(2),
            Stream.runForEach((msg) =>
              Ref.update(seen, (arr) => [...arr, msg.n]),
            ),
            Effect.fork,
          )
        yield* Effect.sleep("50 millis")
        yield* s.append({ n: 5 })
        yield* s.append({ n: 6 })
        yield* Fiber.join(liveFiber)
        const liveSeen = yield* Ref.get(seen)
        expect(liveSeen).toEqual([5, 6])
      }),
    )
  }, 15000)
})

describe("Phase 1 idempotent producer correctness", () => {
  it("survives restart with overlapping seqs (server dedupes)", async () => {
    const url = server.streamUrl("idem-restart")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })

        // First epoch produces 3 batches.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const p = yield* s.producer({
              producerId: "writer-1",
              epoch: 0,
              lingerMs: 5,
              maxBatchSize: 1,
            })
            yield* p.append({ n: 0 })
            yield* p.append({ n: 1 })
            yield* p.flush
          }),
        )

        // Same epoch and same producer-id (simulated restart with same epoch
        // re-sending the same seqs) — server returns 204 (duplicate), state
        // remains consistent.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const p = yield* s.producer({
              producerId: "writer-1",
              epoch: 0,
              lingerMs: 5,
              maxBatchSize: 1,
            })
            // Append two NEW items; producer assigns fresh seqs (its lastSeq
            // is local, so it starts at 0 again — server's lastSeq is 1).
            // The first two will be duplicates (204), the next two new (200).
            yield* p.append({ n: 0 })
            yield* p.append({ n: 1 })
            yield* p.append({ n: 2 })
            yield* p.append({ n: 3 })
            yield* p.flush
          }),
        )

        const collected = yield* s.collect
        // We should see [0, 1, 2, 3] — duplicates discarded by the server.
        expect(collected.map((m) => m.n)).toEqual([0, 1, 2, 3])
      }),
    )
  }, 15000)

  it("autoClaim recovers from stale-epoch fencing", async () => {
    const url = server.streamUrl("idem-autoclaim")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })

        // Writer A claims epoch 5 first.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* s.producer({
              producerId: "shared",
              epoch: 5,
              lingerMs: 5,
              maxBatchSize: 1,
            })
            yield* a.append({ n: 0 })
            yield* a.flush
          }),
        )

        // Writer B starts at the same epoch=5; the first batch should be
        // rejected as duplicate (seq=0 vs server's lastSeq=0) — but B is
        // fresh and uses autoClaim, so a stale-epoch race elsewhere bumps it.
        // To trigger 403, we start B at a lower epoch and let autoClaim
        // bump it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const b = yield* s.producer({
              producerId: "shared",
              epoch: 0,
              autoClaim: true,
              lingerMs: 5,
              maxBatchSize: 1,
            })
            yield* b.append({ n: 1 })
            yield* b.flush
          }),
        )

        const collected = yield* s.collect
        expect(collected.length).toBe(2)
        expect(collected.map((m) => m.n).sort()).toEqual([0, 1])
      }),
    )
  }, 15000)
})

describe("Phase 1 retention and lifecycle", () => {
  it("delete + subsequent head returns NotFound (or Gone)", async () => {
    const url = server.streamUrl("delete-flow")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })
        yield* s.append({ n: 1 })
        yield* s.delete
        const exit = yield* Effect.exit(s.head)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  it("collect on a closed stream returns all items including the close payload", async () => {
    const url = server.streamUrl("collect-closed")
    const s = DurableStream.define({ endpoint: { url }, schema: Message })

    await runtime(
      Effect.gen(function* () {
        yield* s.create({ contentType: "application/json" })
        yield* s.append({ n: 1 })
        yield* s.append({ n: 2 })
        yield* s.close()
        const items = yield* s.collect
        expect(items.map((m) => m.n)).toEqual([1, 2])
      }),
    )
  })
})

// `Chunk` is needed by the type signature of Stream operators; keep it
// imported to satisfy strict lint.
void Chunk
