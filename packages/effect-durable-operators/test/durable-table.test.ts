/**
 * Verifies:
 *  - effect-durable-operators.TABLE.1 — facade over createStreamDB, not a
 *    new engine
 *  - effect-durable-operators.TABLE.2 — Effect Schema input, Standard Schema
 *    only at the @durable-streams/state boundary
 *  - effect-durable-operators.TABLE.3 — Scope-managed; preload on acquire,
 *    close on scope finalization; awaitTxId surfaced as Effect
 *  - effect-durable-operators.TABLE.4 — get / query / changes are real pull
 *    and push helpers, no re-folding of retained history
 *  - effect-durable-operators.TABLE.5 — cold-start replay rebuilds state
 *    from retained change events
 *  - effect-durable-operators.PACKAGE.1, PACKAGE.3 — package exposes typed
 *    operators and uses Effect Stream/Schema directly.
 */

import { DurableStream } from "effect-durable-streams"
import { Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableTable } from "../src/index.ts"
import { runtime, TestStreamServer } from "./harness.ts"

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const Webhook = Schema.Struct({
  providerEventId: Schema.String,
  receivedAt: Schema.String,
  status: Schema.Literal("received", "processed", "failed"),
})
type Webhook = Schema.Schema.Type<typeof Webhook>

const webhookCollections = DurableTable.collections({
  webhooks: DurableTable.collection({
    type: "example.webhook",
    primaryKey: "providerEventId",
    schema: Webhook,
  }),
})

describe("DurableTable", () => {
  it("materializes upserts and serves get/query through @durable-streams/state", async () => {
    const url = server.url("table")

    await runtime(
      Effect.gen(function* () {
        // Pre-create the underlying durable stream so createStreamDB can read it.
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const wireBound = DurableStream.define({
          endpoint: { url },
          schema: Schema.Any,
        })
        // Append change events directly — the table observes via the wire.
        const row: Webhook = {
          providerEventId: "evt-1",
          receivedAt: "2026-01-01T00:00:00.000Z",
          status: "received",
        }
        const base = webhookCollections.collections.webhooks.upsert(row)
        // Tag with a txid so we can deterministically synchronize on
        // observed materialization rather than sleeping for "long enough".
        yield* wireBound.append({
          ...base,
          headers: { ...base.headers, txid: "evt-1-tx" },
        })

        const table = yield* DurableTable.materialize({
          streamOptions: { url, contentType: "application/json" },
          collections: webhookCollections,
        })

        // Wait for the tagged tx to flow through the materialization.
        yield* table.awaitTxId("evt-1-tx", 3000)

        const got = yield* table.get("webhooks", "evt-1")
        expect(Option.isSome(got)).toBe(true)
        if (Option.isSome(got)) {
          expect(got.value.providerEventId).toBe("evt-1")
          expect(got.value.status).toBe("received")
        }

        // query returns the synchronous view of the collection.
        const allRows = yield* table.query("webhooks", (coll) => coll.toArray)
        expect(allRows.length).toBe(1)
      }),
    )
  })

  it("push subscription via `changes` observes a later update after initial materialize (TABLE.4)", async () => {
    const url = server.url("table-push")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })
        const wireBound = DurableStream.define({
          endpoint: { url },
          schema: Schema.Any,
        })
        // Seed one row, materialize, then append a SECOND row — the
        // subscription must fire for the live update without re-folding.
        yield* wireBound.append(
          webhookCollections.collections.webhooks.upsert({
            providerEventId: "p-1",
            receivedAt: "2026-01-01T00:00:00.000Z",
            status: "received",
          }),
        )

        const table = yield* DurableTable.materialize({
          streamOptions: { url, contentType: "application/json" },
          collections: webhookCollections,
        })

        const seenRef = yield* Ref.make<ReadonlyArray<string>>([])

        // Subscribe — bridge TanStack subscribeChanges into the changes stream.
        const changesStream = table.changes<"webhooks", string>(
          "webhooks",
          (coll, emit) => {
            const sub = coll.subscribeChanges(
              (changes) => {
                for (const c of changes) {
                  if (c.value !== undefined && c.value !== null) {
                    emit(c.value.providerEventId)
                  }
                }
              },
              { includeInitialState: true },
            )
            return () => sub.unsubscribe()
          },
        )
        const fiber = yield* Effect.fork(
          Stream.runForEach(changesStream, (id) =>
            Ref.update(seenRef, (a) => [...a, id]),
          ),
        )

        // Let the subscription deliver initial state.
        yield* Effect.sleep("200 millis")
        // Append a SECOND row — this is the live update we want to observe.
        yield* wireBound.append(
          webhookCollections.collections.webhooks.upsert({
            providerEventId: "p-2",
            receivedAt: "2026-01-01T00:00:01.000Z",
            status: "processed",
          }),
        )
        yield* Effect.sleep("250 millis")
        yield* Fiber.interrupt(fiber)

        const ids = yield* Ref.get(seenRef)
        expect(ids).toContain("p-1")
        expect(ids).toContain("p-2")
      }),
    )
  })

  it("wait_for-shaped: snapshot query misses; live subscription observes the later matching update (TABLE.4)", async () => {
    const url = server.url("table-wait-for")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const table = yield* DurableTable.materialize({
          streamOptions: { url, contentType: "application/json" },
          collections: webhookCollections,
        })
        yield* Effect.sleep("100 millis")

        // Snapshot query misses — nothing has been appended yet.
        const initial = yield* table.get("webhooks", "later")
        expect(Option.isNone(initial)).toBe(true)

        // Subscribe to changes BEFORE the append.
        const matchedRef = yield* Ref.make<Array<string>>([])
        const changesStream = table.changes<"webhooks", string>(
          "webhooks",
          (coll, emit) => {
            const sub = coll.subscribeChanges(
              (changes) => {
                for (const c of changes) {
                  if (c.value !== undefined && c.value !== null) {
                    if (c.value.providerEventId === "later") {
                      emit(c.value.status)
                    }
                  }
                }
              },
              { includeInitialState: false },
            )
            return () => sub.unsubscribe()
          },
        )
        const fiber = yield* Effect.fork(
          Stream.runForEach(changesStream, (status) =>
            Ref.update(matchedRef, (a) => [...a, status]),
          ),
        )

        // Append the matching row.
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Any,
        }).append(
          webhookCollections.collections.webhooks.upsert({
            providerEventId: "later",
            receivedAt: "2026-01-01T00:00:00.000Z",
            status: "processed",
          }),
        )

        // Allow the subscription to deliver.
        yield* Effect.sleep("300 millis")
        const observed = yield* Ref.get(matchedRef)
        expect(observed).toContain("processed")
        yield* Fiber.interrupt(fiber)
      }),
    )
  })

  it("awaitTxId is a coordination point: succeeds after sync, times out before (TABLE.3)", async () => {
    const url = server.url("table-awaittx")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const table = yield* DurableTable.materialize({
          streamOptions: { url, contentType: "application/json" },
          collections: webhookCollections,
        })

        // Negative half: awaiting a txid that was never written must time
        // out — proves awaitTxId is not a no-op. A short 250ms deadline
        // keeps the test fast.
        const missResult = yield* table.awaitTxId("never-written", 250).pipe(
          Effect.either,
        )
        expect(missResult._tag).toBe("Left")

        // Positive half: tag an upsert with a txid, append, then await.
        // The await must (a) succeed and (b) the row must be queryable
        // immediately after — proving the txid signals a real
        // read-after-write coordination point, not just a timer.
        const event = webhookCollections.collections.webhooks.upsert({
          providerEventId: "txid-evt",
          receivedAt: "2026-01-01T00:00:00.000Z",
          status: "received",
        })
        const tagged = {
          ...event,
          headers: { ...event.headers, txid: "tx-001" },
        }
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Any,
        }).append(tagged)

        const hitResult = yield* table.awaitTxId("tx-001", 3000).pipe(
          Effect.either,
        )
        expect(hitResult._tag).toBe("Right")

        // After awaitTxId resolves, the row MUST be queryable — that's the
        // read-after-write contract this method is meant to provide.
        const row = yield* table.get("webhooks", "txid-evt")
        expect(Option.isSome(row)).toBe(true)
      }),
    )
  })

  it("rebuilds state on cold start from retained change events (TABLE.5)", async () => {
    const url = server.url("table-replay")

    await runtime(
      Effect.gen(function* () {
        yield* DurableStream.define({
          endpoint: { url },
          schema: Schema.Unknown,
        }).create({ contentType: "application/json" })

        const wireBound = DurableStream.define({
          endpoint: { url },
          schema: Schema.Any,
        })
        // Append three upserts BEFORE any table materializes.
        for (let i = 0; i < 3; i++) {
          yield* wireBound.append(
            webhookCollections.collections.webhooks.upsert({
              providerEventId: `evt-${i}`,
              receivedAt: `2026-01-01T00:00:0${i}.000Z`,
              status: "received",
            }),
          )
        }
      }),
    )

    // Fresh scope: a brand-new DurableTable acquires, preloads, and must
    // observe the full retained history through cold-start replay. The
    // `materialize` Effect runs `createStreamDB.preload()` before acquire
    // returns, so the snapshot is queryable IMMEDIATELY — no sleep needed.
    await runtime(
      Effect.gen(function* () {
        const table = yield* DurableTable.materialize({
          streamOptions: { url, contentType: "application/json" },
          collections: webhookCollections,
        })
        const rows = yield* table.query("webhooks", (coll) => coll.toArray)
        expect(rows.length).toBe(3)
      }),
    )
  })
})
