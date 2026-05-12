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

const WorkflowExecution = Schema.Struct({
  executionId: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  payload: Schema.Unknown,
  status: Schema.Literal("started", "completed"),
})
type WorkflowExecution = Schema.Schema.Type<typeof WorkflowExecution>

const RawStateEvent = Schema.Struct({
  type: Schema.String,
  key: Schema.String,
  headers: Schema.Struct({
    operation: Schema.String,
    txid: Schema.optional(Schema.String),
  }),
})

class WorkflowTable extends DurableTable("workflow", {
  executions: WorkflowExecution,
}) {}

const createJsonStream = (url: string) =>
  DurableStream.define({
    endpoint: { url },
    schema: Schema.Unknown,
  }).create({ contentType: "application/json" })

const readRawEvents = (url: string) =>
  DurableStream.define({
    endpoint: { url },
    schema: RawStateEvent,
  }).collect

describe("DurableTable", () => {
  it("effect-durable-operators.TABLE.7 extracts pipeable primaryKey metadata and consumes the table with yield* Table", async () => {
    const url = server.url("table-primary-key")

    await runtime(
      Effect.gen(function* () {
        yield* createJsonStream(url)

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

  it("effect-durable-operators.TABLE.10 effect-durable-operators.TABLE.11 effect-durable-operators.TABLE.12 generated insert/upsert/delete actions materialize and write txid events", async () => {
    const url = server.url("table-actions")

    await runtime(
      Effect.gen(function* () {
        yield* createJsonStream(url)

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

    const events = await runtime(readRawEvents(url))
    expect(events.map((event) => event.type)).toEqual([
      "workflow.executions",
      "workflow.executions",
      "workflow.executions",
      "workflow.executions",
    ])
    expect(events.map((event) => event.headers.operation)).toEqual([
      "insert",
      "upsert",
      "insert",
      "delete",
    ])
    expect(
      events.every((event) => typeof event.headers.txid === "string"),
    ).toBe(true)
  })

  it("effect-durable-operators.TABLE.10 duplicate insert rejects rather than upserting", async () => {
    const url = server.url("table-duplicate-insert")

    await runtime(
      Effect.gen(function* () {
        yield* createJsonStream(url)

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
        yield* createJsonStream(url)

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
        yield* createJsonStream(url)

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
        yield* createJsonStream(url)

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

  it("effect-durable-operators.TABLE.3 still exposes awaitTxId through Effect", async () => {
    const url = server.url("table-await-txid")

    await runtime(
      Effect.gen(function* () {
        yield* createJsonStream(url)

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
