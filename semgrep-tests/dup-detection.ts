import { DurableStream } from "@durable-streams/client"
import { Effect } from "effect"
import { acquireSubstrateDb, openSubstrateDb } from "../packages/substrate/src/stream.ts"
import { readRetainedRunRecords } from "../packages/substrate/src/retained-records.ts"

const stream = new DurableStream({ url: "memory://test" })

// ruleid: firegrid-tryPromise-stream-append
Effect.tryPromise({
  try: () => stream.append(JSON.stringify({ type: "x", value: {} })),
  catch: (cause) => new Error(String(cause)),
})

// ok: firegrid-tryPromise-stream-append
const appendChange = (event: unknown) =>
  Effect.tryPromise({
    try: () => stream.append(JSON.stringify(event)),
    catch: (cause) => new Error(String(cause)),
  })

// ruleid: firegrid-acquire-db-shape
Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const db = openSubstrateDb({ url: "memory://test" })
      await db.preload()
      return db
    },
    catch: (cause) => new Error(String(cause)),
  }),
  (db) => Effect.sync(() => db.close()),
)

// ok: firegrid-acquire-db-shape
acquireSubstrateDb({ url: "memory://test" }, (cause) => new Error(String(cause)))

declare const readJsonItems: (url: string) => Effect.Effect<ReadonlyArray<{ type: string; value: unknown }>>
declare const decodeRun: (value: unknown) => { readonly runId: string }

// ruleid: firegrid-retained-fold-by-field
Effect.gen(function* () {
  const items = yield* readJsonItems("memory://test")
  const result = []
  for (const event of items) {
    if (event.type !== "run") continue
    const decoded = decodeRun(event.value)
    if (decoded.runId !== "run-1") continue
    result.push(decoded)
  }
  return result
})

// ruleid: firegrid-authoritative-run-call
readRetainedRunRecords("memory://test", "run-1").pipe(Effect.map((records) => records))

// ruleid: firegrid-authoritative-run-call
Effect.map(readRetainedRunRecords("memory://test", "run-2"), (records) => records)

Effect.gen(function* () {
  // ruleid: firegrid-authoritative-run-call
  const records = yield* readRetainedRunRecords("memory://test", "run-3")
  return records
})
