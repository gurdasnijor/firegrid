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
 *  - effect-durable-operators.TABLE.26
 *  - effect-durable-operators.TABLE.28
 */

import {
  Chunk,
  Effect,
  Fiber,
  Match,
  Option,
  ParseResult,
  Ref,
  Schema,
  type SchemaAST,
  Stream,
} from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableTable, DurableTableError } from "../src/index.ts"
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

  it("effect-durable-operators.TABLE.26-1 insertOrGet returns Inserted for an absent primary key", async () => {
    const url = server.url("table-insert-or-get-inserted")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-insert-or-get-new",
            workflowName: "demo",
            payload: { version: 1 },
            status: "started",
          }

          const result = yield* table.executions.insertOrGet(row)

          expect(result).toMatchObject({ _tag: "Inserted" })
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

  it("effect-durable-operators.TABLE.26-2 insertOrGet returns Found in the same layer without replacement", async () => {
    const url = server.url("table-insert-or-get-found-same-layer")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const first: WorkflowExecution = {
            executionId: "exec-insert-or-get-found",
            workflowName: "demo",
            payload: { version: 1 },
            status: "started",
          }
          const candidate: WorkflowExecution = {
            ...first,
            payload: { version: 2 },
            status: "completed",
          }

          yield* table.executions.insertOrGet(first)
          const result = yield* table.executions.insertOrGet(candidate)

          expect(result).toMatchObject({ _tag: "Found", row: first })
          const current = yield* table.executions.get(first.executionId)
          expect(Option.isSome(current)).toBe(true)
          if (Option.isSome(current)) {
            expect(current.value).toEqual(first)
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

  it("effect-durable-operators.TABLE.26-3 concurrent insertOrGet calls from independent layers converge across at least 20 races", async () => {
    await runtime(
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++) {
          const url = server.url(`table-insert-or-get-concurrent-${i}`)
          const left: WorkflowExecution = {
            executionId: `exec-insert-or-get-race-${i}`,
            workflowName: "demo",
            payload: { contender: "left", iteration: i },
            status: "started",
          }
          const right: WorkflowExecution = {
            ...left,
            payload: { contender: "right", iteration: i },
          }
          const insertInLayer = (row: WorkflowExecution) =>
            Effect.gen(function* () {
              const table = yield* WorkflowTable
              return yield* table.executions.insertOrGet(row)
            }).pipe(
              Effect.provide(
                WorkflowTable.layer({
                  streamOptions: { url, contentType: "application/json" },
                }),
              ),
            )

          const leftFiber = yield* Effect.fork(insertInLayer(left))
          const rightFiber = yield* Effect.fork(insertInLayer(right))
          const leftResult = yield* Fiber.join(leftFiber)
          const rightResult = yield* Fiber.join(rightFiber)
          const tags = [leftResult._tag, rightResult._tag].sort()

          expect(tags).toEqual(["Found", "Inserted"])
        }
      }),
    )
  })

  it("effect-durable-operators.TABLE.26-11 distinct concurrent insertOrGet on one stream get distinct monotonic arrival offsets", async () => {
    const url = server.url("table-insert-or-get-arrival-offset")
    const count = 12

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const rows: ReadonlyArray<WorkflowExecution> = Array.from(
            { length: count },
            (_, i) => ({
              executionId: `exec-arrival-${i}`,
              workflowName: "demo",
              payload: { i },
              status: "started" as const,
            }),
          )

          // Fire all inserts concurrently against the SAME stream. The
          // reference server serializes appends, so each distinct key wins its
          // own insert fence and is assigned a distinct append offset.
          const results = yield* Effect.all(
            rows.map(row => table.executions.insertOrGet(row)),
            { concurrency: "unbounded" },
          )

          // All distinct keys win their insert.
          expect(results.map(r => r._tag)).toEqual(
            Array.from({ length: count }, () => "Inserted"),
          )

          const offsets = results.map(r => {
            if (r._tag !== "Inserted") {
              throw new Error(`expected Inserted, got ${r._tag}`)
            }
            return r.offset
          })
          // Offsets are distinct (no two concurrent inserts share a position).
          expect(new Set(offsets).size).toBe(count)
          // Offsets are non-empty strings carrying a real arrival position.
          for (const offset of offsets) {
            expect(typeof offset).toBe("string")
            expect(offset.length).toBeGreaterThan(0)
          }
          // Lexicographic order == append (arrival) order: the durable-stream
          // offset is zero-padded, so string compare is the arrival comparator.
          // Sorting yields a strictly increasing, gap-free total order.
          const sorted = [...offsets].sort()
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i]! > sorted[i - 1]!).toBe(true)
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

  it("effect-durable-operators.TABLE.26-11 Inserted carries an append offset; Found carries none", async () => {
    const url = server.url("table-insert-or-get-found-offset")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-arrival-dup",
            workflowName: "demo",
            payload: { version: 1 },
            status: "started",
          }

          const inserted = yield* table.executions.insertOrGet(row)
          const duplicate = yield* table.executions.insertOrGet({
            ...row,
            payload: { version: 2 },
          })

          // Inserted exposes the real arrival position.
          expect(inserted._tag).toBe("Inserted")
          if (inserted._tag === "Inserted") {
            expect(typeof inserted.offset).toBe("string")
            expect(inserted.offset.length).toBeGreaterThan(0)
          }
          // Found is the unchanged {_tag, row} shape — it wrote no event and
          // therefore reports no append position (no `offset` field).
          expect(duplicate._tag).toBe("Found")
          expect("offset" in duplicate).toBe(false)
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

  it("effect-durable-operators.TABLE.26-4 effect-durable-operators.TABLE.26-5 B proposes B but Found row is A", async () => {
    const url = server.url("table-insert-or-get-b-finds-a")

    await runtime(
      Effect.gen(function* () {
        const winner: WorkflowExecution = {
          executionId: "exec-insert-or-get-a-wins",
          workflowName: "demo",
          payload: { proposed: "A" },
          status: "started",
        }
        const loser: WorkflowExecution = {
          ...winner,
          payload: { proposed: "B" },
          status: "completed",
        }
        const insertInLayer = (row: WorkflowExecution) =>
          Effect.gen(function* () {
            const table = yield* WorkflowTable
            return yield* table.executions.insertOrGet(row)
          }).pipe(
            Effect.provide(
              WorkflowTable.layer({
                streamOptions: { url, contentType: "application/json" },
              }),
            ),
          )

        const inserted = yield* insertInLayer(winner)
        const found = yield* insertInLayer(loser)

        expect(inserted).toMatchObject({ _tag: "Inserted" })
        expect(found).toMatchObject({ _tag: "Found", row: winner })
      }),
    )
  })

  it("effect-durable-operators.TABLE.26-5 insertOrGet never silently overwrites an existing row", async () => {
    const url = server.url("table-insert-or-get-no-overwrite")

    await runtime(
      Effect.gen(function* () {
        const first: WorkflowExecution = {
          executionId: "exec-insert-or-get-no-overwrite",
          workflowName: "demo",
          payload: { contender: "first" },
          status: "started",
        }
        const second: WorkflowExecution = {
          ...first,
          payload: { contender: "second" },
          status: "completed",
        }

        const seed = Effect.gen(function* () {
          const table = yield* WorkflowTable
          return yield* table.executions.insertOrGet(first)
        }).pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
        const contend = Effect.gen(function* () {
          const table = yield* WorkflowTable
          return yield* table.executions.insertOrGet(second)
        }).pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )

        const seedResult = yield* seed
        const contendResult = yield* contend
        expect(seedResult._tag).toBe("Inserted")
        expect(contendResult).toMatchObject({ _tag: "Found", row: first })

        const read = yield* Effect.gen(function* () {
          const table = yield* WorkflowTable
          return yield* table.executions.get(first.executionId)
        }).pipe(
          Effect.provide(
            WorkflowTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )

        expect(Option.isSome(read)).toBe(true)
        if (Option.isSome(read)) {
          expect(read.value).toEqual(first)
        }
      }),
    )
  })

  it("effect-durable-operators.TABLE.26-6 insertOrGet Inserted result is queryable immediately", async () => {
    const url = server.url("table-insert-or-get-read-after-write")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-insert-or-get-readable",
            workflowName: "demo",
            payload: { visible: true },
            status: "started",
          }

          const result = yield* table.executions.insertOrGet(row)
          const read = yield* table.executions.get(row.executionId)

          expect(result).toMatchObject({ _tag: "Inserted" })
          expect(Option.isSome(read)).toBe(true)
          if (Option.isSome(read)) {
            expect(read.value).toEqual(row)
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

  it("effect-durable-operators.TABLE.26-7 insertOrGet failures surface as DurableTableError", async () => {
    const NumericEncodedKey = Schema.transform(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Schema.Any as unknown as Schema.Schema<string, any>,
      Schema.String,
      {
        strict: false,
        decode: (encoded: unknown) => String(encoded),
        encode: (decoded: string) => Number(decoded) as unknown as string,
      },
    )

    class BadInsertOrGetKeyTable extends DurableTable("badInsertOrGetKey", {
      rows: Schema.Struct({
        id: NumericEncodedKey.pipe(DurableTable.primaryKey),
        value: Schema.String,
      }),
    }) {}

    const url = server.url("table-insert-or-get-bad-pk-encode")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* BadInsertOrGetKeyTable
          const result = yield* table.rows
            .insertOrGet({ id: "123", value: "hello" })
            .pipe(Effect.either)

          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(DurableTableError)
          }
        })

        yield* program.pipe(
          Effect.provide(
            BadInsertOrGetKeyTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.26-8 effect-durable-operators.TABLE.26-9 consumes insertOrGet with Match.value", async () => {
    const url = server.url("table-insert-or-get-match")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable
          const row: WorkflowExecution = {
            executionId: "exec-insert-or-get-match",
            workflowName: "demo",
            payload: { match: true },
            status: "started",
          }

          yield* table.executions.insertOrGet(row)
          const result = yield* table.executions.insertOrGet({
            ...row,
            payload: { match: false },
          })
          const matched = Match.value(result).pipe(
            Match.tag("Inserted", () => "inserted"),
            Match.tag("Found", ({ row: found }) => found.payload),
            Match.exhaustive,
          )

          expect(matched).toEqual({ match: true })
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

  it("effect-durable-operators.TABLE.26-1 effect-durable-operators.TABLE.26-2 supports Schema.transformOrFail composite keys for Inserted and Found", async () => {
    const url = server.url("table-insert-or-get-composite")

    const invalidTuple = (
      ast: SchemaAST.AST,
      encoded: string,
      message: string,
    ) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

    const RequestKey = Schema.transformOrFail(
      Schema.String,
      Schema.Struct({
        executionId: Schema.String,
        activityId: Schema.String,
      }),
      {
        strict: false,
        decode: (encoded: string, _options, ast) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(encoded)
          } catch {
            return invalidTuple(ast, encoded, "RequestKey is not valid JSON")
          }
          if (!isUnknownArray(parsed) || parsed.length !== 2) {
            return invalidTuple(ast, encoded, "RequestKey must be a 2-item JSON tuple")
          }
          const executionId = parsed[0]
          const activityId = parsed[1]
          if (typeof executionId !== "string" || typeof activityId !== "string") {
            return invalidTuple(
              ast,
              encoded,
              "RequestKey tuple must be [executionId, activityId] of strings",
            )
          }
          return ParseResult.succeed({ executionId, activityId })
        },
        encode: ({ executionId, activityId }: { executionId: string; activityId: string }) =>
          ParseResult.succeed(JSON.stringify([executionId, activityId])),
      },
    )

    class ActivityRequestTable extends DurableTable("insertOrGetComposite", {
      requests: Schema.Struct({
        requestKey: RequestKey.pipe(DurableTable.primaryKey),
        owner: Schema.String,
      }),
    }) {}

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* ActivityRequestTable
          const insertedKey = { executionId: "exec-1", activityId: "activity-1" }
          const foundKey = { executionId: "exec-1", activityId: "activity-1" }
          const winner = { requestKey: insertedKey, owner: "A" }
          const candidate = { requestKey: foundKey, owner: "B" }

          const inserted = yield* table.requests.insertOrGet(winner)
          const found = yield* table.requests.insertOrGet(candidate)

          expect(inserted).toMatchObject({ _tag: "Inserted" })
          expect(found).toMatchObject({ _tag: "Found", row: winner })
        })

        yield* program.pipe(
          Effect.provide(
            ActivityRequestTable.layer({
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

  it("effect-durable-operators.TABLE.28, effect-durable-operators.TABLE.28-1 exposes rows as current plus live non-deleted row observations", async () => {
    const url = server.url("table-rows")

    await runtime(
      Effect.gen(function* () {

        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable

          yield* table.executions.insert({
            executionId: "exec-existing",
            workflowName: "demo",
            payload: { before: "subscribe" },
            status: "started",
          })

          const fiber = yield* table.executions.rows().pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
            Effect.fork,
          )

          yield* Effect.sleep("50 millis")
          yield* table.executions.delete("exec-existing")
          yield* Effect.sleep("50 millis")
          yield* table.executions.upsert({
            executionId: "exec-live-row",
            workflowName: "demo",
            payload: { after: "subscribe" },
            status: "started",
          })

          const rows = yield* Fiber.join(fiber)
          expect(rows.map(row => row.executionId)).toEqual([
            "exec-existing",
            "exec-live-row",
          ])
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

  it("effect-durable-operators.TABLE.16 effect-durable-operators.TABLE.17 effect-durable-operators.TABLE.18 supports decoded composite primary keys across get query and subscribe", async () => {
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
          const otherKey = {
            subscriberId: "sub-a",
            ingressId: "ing-2",
          }
          const other = yield* table.checkpoints.get(otherKey)
          expect(Option.isNone(other)).toBe(true)

          yield* table.checkpoints.upsert({
            key: otherKey,
            claimedAt: "2026-05-12T00:00:01.000Z",
          })
          const afterDistinctInsert = yield* table.checkpoints.query(
            (coll) => coll.toArray,
          )
          expect(afterDistinctInsert).toHaveLength(2)
          expect(afterDistinctInsert.map(row => row.key)).toEqual(
            expect.arrayContaining([key, otherKey]),
          )
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
          expect(table.executions.collection.map(row => row.executionId))
            .toEqual(["exec-readonly"])
          expect(Array.from(table.executions.collection.state.values()).map(row =>
            row.executionId,
          ))
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
          expect(() => {
            table.executions.collection.update("exec-readonly", (draft) => {
              draft.status = "completed"
            })
          }).toThrow(/read-only/)
          expect(() => {
            table.executions.collection.delete("exec-readonly")
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

  it("effect-durable-operators.TABLE.17 effect-durable-operators.TABLE.18 effect-durable-operators.TABLE.25 supports Schema.transformOrFail JSON-tuple composite keys across get/query/subscribe", async () => {
    // Mirrors packages/runtime/src/durable-tools/internal/keys.ts WaitKeyEncoded:
    // JSON-tuple composite key via Schema.transformOrFail with ParseResult.fail
    // on malformed input. Historically KNOWN_ISSUES claimed `.get` missed rows
    // for this schema flavor; this test pins behavior.
    const url = server.url("table-composite-key-tofail")

    const invalidTuple = (
      ast: SchemaAST.AST,
      encoded: string,
      message: string,
    ) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

    const WaitKey = Schema.transformOrFail(
      Schema.String,
      Schema.Struct({
        executionId: Schema.String,
        name: Schema.String,
      }),
      {
        strict: false,
        decode: (encoded: string, _options, ast) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(encoded)
          } catch {
            return invalidTuple(ast, encoded, "WaitKey is not valid JSON")
          }
          if (!isUnknownArray(parsed) || parsed.length !== 2) {
            return invalidTuple(ast, encoded, "WaitKey must be a 2-item JSON tuple")
          }
          const executionId = parsed[0]
          const name = parsed[1]
          if (typeof executionId !== "string" || typeof name !== "string") {
            return invalidTuple(
              ast,
              encoded,
              "WaitKey tuple must be [executionId, name] of strings",
            )
          }
          return ParseResult.succeed({ executionId, name })
        },
        encode: ({ executionId, name }: { executionId: string; name: string }) =>
          ParseResult.succeed(JSON.stringify([executionId, name])),
      },
    )

    class WaitsTable extends DurableTable("compositeKeyTofail", {
      waits: Schema.Struct({
        waitKey: WaitKey.pipe(DurableTable.primaryKey),
        deferredName: Schema.String,
      }),
    }) {}

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WaitsTable
          const key = { executionId: "exec-1", name: "approval" }

          yield* table.waits.upsert({ waitKey: key, deferredName: "approve" })

          // .query.toArray must return the row, decoded
          const rows = yield* table.waits.query((coll) => coll.toArray)
          expect(rows).toHaveLength(1)
          expect(rows[0]?.waitKey).toEqual(key)

          // .get on the same key must find the row (the regression we are
          // pinning: previously returned Option.none for transformOrFail keys)
          const got = yield* table.waits.get(key)
          expect(Option.isSome(got)).toBe(true)
          if (Option.isSome(got)) {
            expect(got.value.waitKey).toEqual(key)
            expect(got.value.deferredName).toBe("approve")
          }

          // Distinct composite key must miss
          const missing = yield* table.waits.get({
            executionId: "exec-1",
            name: "other",
          })
          expect(Option.isNone(missing)).toBe(true)

          // Subscribe with initial state must surface decoded composite keys
          const initial = yield* table.waits.subscribe((coll, emit) => {
            const sub = coll.subscribeChanges(
              (changes) => emit(changes.map((c) => c.value.waitKey)),
              { includeInitialState: true },
            )
            return () => sub.unsubscribe()
          }).pipe(Stream.runHead)
          expect(Option.isSome(initial)).toBe(true)
          if (Option.isSome(initial)) {
            expect(initial.value).toEqual([key])
          }
        })

        yield* program.pipe(
          Effect.provide(
            WaitsTable.layer({
              streamOptions: { url, contentType: "application/json" },
            }),
          ),
        )
      }),
    )
  })

  it("effect-durable-operators.TABLE.21 effect-durable-operators.TABLE.23 collection mutation rejection throws the typed DurableTableError directly (not a wrapped FiberFailure)", async () => {
    const url = server.url("table-collection-throws-typed")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* WorkflowTable

          yield* table.executions.upsert({
            executionId: "exec-throw",
            workflowName: "demo",
            payload: {},
            status: "started",
          })

          let caughtInsert: unknown
          try {
            table.executions.collection.insert({
              executionId: "exec-bypass",
              workflowName: "demo",
              payload: {},
              status: "started",
            })
          } catch (error) {
            caughtInsert = error
          }
          expect(caughtInsert).toBeInstanceOf(DurableTableError)

          let caughtUpdate: unknown
          try {
            table.executions.collection.update("exec-throw", (draft) => {
              draft.status = "completed"
            })
          } catch (error) {
            caughtUpdate = error
          }
          expect(caughtUpdate).toBeInstanceOf(DurableTableError)

          let caughtDelete: unknown
          try {
            table.executions.collection.delete("exec-throw")
          } catch (error) {
            caughtDelete = error
          }
          expect(caughtDelete).toBeInstanceOf(DurableTableError)
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

  it("effect-durable-operators.TABLE.18 effect-durable-operators.TABLE.24 fails loudly when a primary-key field encodes to a non-string value", async () => {
    // A primary-key transform that decodes string but encodes to a number is
    // a schema mistake; the package must reject it loudly rather than
    // String(...)-coercing the wire form.
    const NumericEncodedKey = Schema.transform(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Schema.Any as unknown as Schema.Schema<string, any>,
      Schema.String,
      {
        strict: false,
        decode: (encoded: unknown) => String(encoded),
        encode: (decoded: string) => Number(decoded) as unknown as string,
      },
    )

    class BadKeyTable extends DurableTable("badKey", {
      rows: Schema.Struct({
        id: NumericEncodedKey.pipe(DurableTable.primaryKey),
        value: Schema.String,
      }),
    }) {}

    const url = server.url("table-bad-pk-encode")

    await runtime(
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const table = yield* BadKeyTable
          const result = yield* table.rows
            .insert({ id: "123", value: "hello" })
            .pipe(Effect.either)
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(DurableTableError)
          }
        })

        yield* program.pipe(
          Effect.provide(
            BadKeyTable.layer({
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
