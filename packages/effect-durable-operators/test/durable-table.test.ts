/**
 * Verifies the ksql-inspired DurableTable declaration/action API.
 *
 * Key ACIDs:
 *  - effect-durable-operators.TABLE.1
 *  - effect-durable-operators.TABLE.2
 *  - effect-durable-operators.TABLE.3
 *  - effect-durable-operators.TABLE.4
 *  - effect-durable-operators.TABLE.5
 *  - effect-durable-operators.TABLE.6
 *  - effect-durable-operators.TABLE.7
 *  - effect-durable-operators.TABLE.8
 *  - effect-durable-operators.TABLE.9
 *  - effect-durable-operators.TABLE.10
 *  - effect-durable-operators.TABLE.11
 *  - effect-durable-operators.TABLE.12
 *  - effect-durable-operators.TABLE.13
 *  - effect-durable-operators.TABLE.14
 *  - effect-durable-operators.TABLE.15
 *  - effect-durable-operators.TABLE.21
 *  - effect-durable-operators.TABLE.22
 */

import { Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableTable } from "../src/index.ts"
import { runtime, TestStreamServer } from "./harness.ts"

// DurableTable tests validate the table primitive natively through its
// merged service API (yield* Table, Table.layer, collection facades). Raw
// durable-stream mechanics — server lifecycle, stream pre-creation — live
// behind TestStreamServer in ./harness.ts; the test never imports a stream
// client plane directly.

const server = new TestStreamServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const WorkflowExecution = Schema.Struct({
  executionId: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  payload: Schema.Unknown,
  status: Schema.Literal("started", "completed"),
})
type WorkflowExecution = Schema.Schema.Type<typeof WorkflowExecution>

class WorkflowTable extends DurableTable("workflow", {
  executions: WorkflowExecution,
}) {}

const isUnknownArray = (value: unknown): value is ReadonlyArray<unknown> =>
  Array.isArray(value)

describe("DurableTable", () => {
  it("effect-durable-operators.TABLE.7 extracts pipeable primaryKey metadata and consumes the table with yield* Table", async () => {
    const url = server.url("table-primary-key")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          // effect-durable-operators.TABLE.6
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-pk",
            workflowName: "demo",
            payload: { hello: "world" },
            status: "started",
          }

          yield* table.executions.insert(row)
          const got = yield* table.executions.get("exec-pk")

          expect(Option.isSome(got)).toBe(true)
          if (Option.isSome(got)) {
            expect(got.value.executionId).toBe("exec-pk")
          }
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.19 layer acquisition against a fresh stream URL succeeds without prior create and is idempotent on re-acquire", async () => {
    const url = server.url("table-layer-creates-stream")

    // First acquisition: stream does not exist; layer must create it and
    // preload to readiness before the program runs.
    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          yield* table.executions.insert({
            executionId: "exec-fresh",
            workflowName: "demo",
            payload: {},
            status: "started",
          })
          const got = yield* table.executions.get("exec-fresh")
          expect(Option.isSome(got)).toBe(true)
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )

    // Second acquisition: stream already exists; the layer must tolerate
    // CONFLICT_EXISTS from the underlying create and proceed to preload.
    // Cold-start replay also proves the previously-written row is visible.
    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const got = yield* table.executions.get("exec-fresh")
          expect(Option.isSome(got)).toBe(true)
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.7 supports direct primaryKey(schema) form", () => {
    expect(() => {
      class DirectPrimaryKeyTable extends DurableTable("direct", {
        rows: Schema.Struct({
          id: DurableTable.primaryKey(Schema.String),
          value: Schema.Number,
        }),
      }) {}
      return DirectPrimaryKeyTable
    }).not.toThrow()
  })

  it("effect-durable-operators.TABLE.8 fails loudly for zero or multiple primary keys", () => {
    expect(() => {
      class MissingPrimaryKeyTable extends DurableTable("missing", {
        rows: Schema.Struct({
          id: Schema.String,
          value: Schema.Number,
        }),
      }) {}
      return MissingPrimaryKeyTable
    }).toThrow(/exactly one DurableTable\.primaryKey/)

    expect(() => {
      class MultiplePrimaryKeyTable extends DurableTable("multiple", {
        rows: Schema.Struct({
          id: Schema.String.pipe(DurableTable.primaryKey),
          otherId: Schema.String.pipe(DurableTable.primaryKey),
        }),
      }) {}
      return MultiplePrimaryKeyTable
    }).toThrow(/found 2/)
  })

  it("effect-durable-operators.TABLE.10 rejects collection names reserved by the table service", () => {
    expect(() => {
      class ReservedCollectionTable extends DurableTable("reserved", {
        awaitTxId: Schema.Struct({
          id: Schema.String.pipe(DurableTable.primaryKey),
        }),
      }) {}
      return ReservedCollectionTable
    }).toThrow(/collides with a table service property/)
  })

  it("effect-durable-operators.TABLE.10 effect-durable-operators.TABLE.11 effect-durable-operators.TABLE.12 effect-durable-operators.TABLE.15 generated insert/upsert/delete actions sequence correctly and survive cold-start replay", async () => {
    const url = server.url("table-actions")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable

          yield* table.executions.insert({
            executionId: "exec-1",
            workflowName: "demo",
            payload: { step: 1 },
            status: "started",
          })

          yield* table.executions.upsert({
            executionId: "exec-1",
            workflowName: "demo",
            payload: { step: 2 },
            status: "completed",
          })

          yield* table.executions.insert({
            executionId: "exec-2",
            workflowName: "demo",
            payload: { step: 3 },
            status: "started",
          })

          yield* table.executions.delete("exec-1")

          const deleted = yield* table.executions.get("exec-1")
          const kept = yield* table.executions.get("exec-2")
          const rows = yield* table.executions.query((coll) => coll.toArray)

          expect(Option.isNone(deleted)).toBe(true)
          expect(Option.isSome(kept)).toBe(true)
          expect(rows.map((row) => row.executionId)).toEqual(["exec-2"])
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )

    // TABLE.11/12/15: a fresh DurableTable layer over the same durable
    // stream cold-start replays State Protocol change events to rebuild
    // identical materialized state. This implicitly verifies that the
    // generated actions wrote createStateSchema-produced insert/upsert/
    // delete events with the correct namespace.collectionKey wire type and
    // that txid coordination kept reads consistent with writes.
    await runtime(
      Effect.gen(function* () {
        const replay = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const deleted = yield* table.executions.get("exec-1")
          const kept = yield* table.executions.get("exec-2")
          const rows = yield* table.executions.query((coll) => coll.toArray)
          expect(Option.isNone(deleted)).toBe(true)
          expect(Option.isSome(kept)).toBe(true)
          expect(rows.map((row) => row.executionId)).toEqual(["exec-2"])
        })

        yield* replay.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.10 duplicate insert rejects rather than upserting", async () => {
    const url = server.url("table-duplicate-insert")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-dup",
            workflowName: "demo",
            payload: { version: 1 },
            status: "started",
          }

          yield* table.executions.insert(row)
          const duplicate = yield* table.executions.insert({
            ...row,
            payload: { version: 2 },
            status: "completed",
          }).pipe(Effect.either)

          expect(duplicate._tag).toBe("Left")

          const current = yield* table.executions.get("exec-dup")
          expect(Option.isSome(current)).toBe(true)
          if (Option.isSome(current)) {
            expect(current.value.status).toBe("started")
            expect(current.value.payload).toEqual({ version: 1 })
          }
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.12 generated writes are queryable immediately after action completion", async () => {
    const url = server.url("table-read-after-write")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable

          yield* table.executions.upsert({
            executionId: "exec-tx",
            workflowName: "demo",
            payload: { after: "write" },
            status: "started",
          })

          const row = yield* table.executions.get("exec-tx")
          expect(Option.isSome(row)).toBe(true)
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.4 exposes subscribe as a push query over live materialized updates", async () => {
    const url = server.url("table-subscribe")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const seenRef = yield* Ref.make<ReadonlyArray<string>>([])

          const updates = table.executions.subscribe<string>((coll, emit) => {
            const sub = coll.subscribeChanges(
              (changes) => {
                for (const change of changes) {
                  if (change.value !== undefined && change.value !== null) {
                    emit(change.value.executionId)
                  }
                }
              },
              { includeInitialState: false },
            )
            return () => sub.unsubscribe()
          })

          const fiber = yield* Effect.fork(
            Stream.runForEach(updates, (id) =>
              Ref.update(seenRef, (seen) => [...seen, id]),
            ),
          )

          yield* Effect.sleep("50 millis")
          yield* table.executions.upsert({
            executionId: "exec-live",
            workflowName: "demo",
            payload: {},
            status: "started",
          })
          yield* Effect.sleep("150 millis")
          yield* Fiber.interrupt(fiber)

          const seen = yield* Ref.get(seenRef)
          expect(seen).toContain("exec-live")
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.5 cold-start replay rebuilds action-written state", async () => {
    const url = server.url("table-cold-start")

    await runtime(
      Effect.gen(function* () {

        const seed = Effect.gen(function* () {
          const table = yield* WorkflowTable
          yield* table.executions.upsert({
            executionId: "exec-replay-1",
            workflowName: "demo",
            payload: {},
            status: "started",
          })
          yield* table.executions.upsert({
            executionId: "exec-replay-2",
            workflowName: "demo",
            payload: {},
            status: "completed",
          })
        })

        yield* seed.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )

    await runtime(
      Effect.gen(function* () {
        const replay = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const rows = yield* table.executions.query((coll) => coll.toArray)
          expect(rows.map((row) => row.executionId).sort()).toEqual([
            "exec-replay-1",
            "exec-replay-2",
          ])
        })

        yield* replay.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.17 effect-durable-operators.TABLE.18 supports decoded composite primary keys across get query and subscribe", async () => {
    const url = server.url("table-composite-key")

    const CompositeKey = Schema.transform(
      Schema.String,
      Schema.Struct({
        subscriberId: Schema.String,
        ingressId: Schema.String,
      }),
      {
        strict: false,
        decode: (encoded: string) => {
          const parsed: unknown = JSON.parse(encoded)
          if (!isUnknownArray(parsed) || parsed.length !== 2) {
            throw new Error("invalid composite key")
          }
          const subscriberId = parsed[0]
          const ingressId = parsed[1]
          if (typeof subscriberId !== "string" || typeof ingressId !== "string") {
            throw new Error("invalid composite key")
          }
          return { subscriberId, ingressId }
        },
        encode: ({ subscriberId, ingressId }: { subscriberId: string; ingressId: string }) =>
          JSON.stringify([subscriberId, ingressId]),
      },
    )

    class CheckpointTable extends DurableTable("compositeKeyTest", {
      checkpoints: Schema.Struct({
        key: CompositeKey.pipe(DurableTable.primaryKey),
        claimedAt: Schema.String,
      }),
    }) {}

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* CheckpointTable
          const key = { subscriberId: "sub-a", ingressId: "ing-1" }

          const missing = yield* table.checkpoints.get(key)
          expect(Option.isNone(missing)).toBe(true)

          yield* table.checkpoints.upsert({
            key,
            claimedAt: "2026-05-12T00:00:00.000Z",
          })

          const found = yield* table.checkpoints.get(key)
          expect(Option.isSome(found)).toBe(true)
          if (Option.isSome(found)) {
            expect(found.value.key).toEqual(key)
            expect(found.value.claimedAt).toBe("2026-05-12T00:00:00.000Z")
          }

          const queried = yield* table.checkpoints.query((coll) => coll.toArray)
          expect(queried).toHaveLength(1)
          expect(queried[0]?.key).toEqual(key)
          expect(typeof queried[0]?.key).toBe("object")

          const stateRows = yield* table.checkpoints.query((coll) =>
            Array.from(coll.state.values()))
          expect(stateRows[0]?.key).toEqual(key)

          const mapped = yield* table.checkpoints.query((coll) =>
            coll.map(row => row.key))
          expect(mapped).toEqual([key])

          const initialChanges = yield* table.checkpoints.subscribe(
            (coll, emit) => {
              const sub = coll.subscribeChanges(
                changes => emit(changes.map(change => change.value.key)),
                { includeInitialState: true },
              )
              return () => sub.unsubscribe()
            },
          ).pipe(Stream.runHead)
          expect(Option.isSome(initialChanges)).toBe(true)
          if (Option.isSome(initialChanges)) {
            expect(initialChanges.value).toEqual([key])
          }

          // Distinct composite key must miss.
          const other = yield* table.checkpoints.get({
            subscriberId: "sub-a",
            ingressId: "ing-2",
          })
          expect(Option.isNone(other)).toBe(true)
        })

        yield* program.pipe(
          Effect.provide(
            CheckpointTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.21 effect-durable-operators.TABLE.22 exposes a decoded read-only collection view", async () => {
    const url = server.url("table-readonly-collection")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable

          yield* table.executions.upsert({
            executionId: "exec-readonly",
            workflowName: "demo",
            payload: {},
            status: "started",
          })

          expect(table.executions.collection.toArray.map(row => row.executionId))
            .toEqual(["exec-readonly"])

          const initialChanges: Array<string> = []
          const sub = table.executions.collection.subscribeChanges(
            changes => {
              for (const change of changes) {
                initialChanges.push(change.value.executionId)
              }
            },
            { includeInitialState: true },
          )
          sub.unsubscribe()
          expect(initialChanges).toEqual(["exec-readonly"])

          expect(() => {
            table.executions.collection.insert({
              executionId: "exec-bypass",
              workflowName: "demo",
              payload: {},
              status: "started",
            })
          }).toThrow(/read-only/)

          const bypassed = yield* table.executions.get("exec-bypass")
          expect(Option.isNone(bypassed)).toBe(true)
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.3 still exposes awaitTxId through Effect", async () => {
    const url = server.url("table-await-txid")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const missed = yield* table.awaitTxId("missing", 100).pipe(
            Effect.either,
          )
          expect(missed._tag).toBe("Left")
        })

        yield* program.pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })
})
