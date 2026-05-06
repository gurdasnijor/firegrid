import { DurableStream } from "@durable-streams/client"
import { Effect, pipe } from "effect"
import { acquireSubstrateDb, openSubstrateDb } from "../packages/substrate/src/stream.ts"
import { readRetainedRunRecords } from "../packages/substrate/src/retained-records.ts"

const stream = new DurableStream({ url: "memory://test" })
declare const appendChange: (
  url: string,
  contentType: string,
  mapError: (cause: unknown) => Error,
) => (event: unknown) => Effect.Effect<void, Error>

// ruleid: firegrid-tryPromise-stream-append
Effect.tryPromise({
  try: () => stream.append(JSON.stringify({ type: "x", value: {} })),
  catch: (cause) => new Error(String(cause)),
})

// ok: firegrid-tryPromise-stream-append
appendChange("memory://test", "application/json", (cause) => new Error(String(cause)))({
  type: "x",
  value: {},
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
Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => ({ cancel: () => undefined }),
    catch: (cause) => new Error(String(cause)),
  }),
  (response) => Effect.sync(() => response.cancel()),
)

// ok: firegrid-acquire-db-shape
acquireSubstrateDb({ url: "memory://test" }, (cause) => new Error(String(cause)))

declare const readJsonItems: (url: string) => Effect.Effect<ReadonlyArray<{ type: string; value: unknown }>>
declare const decodeRun: (value: unknown) => { readonly runId: string }

Effect.gen(function* () {
  const items = yield* readJsonItems("memory://test")
  const result = []
  // ruleid: firegrid-retained-fold-by-field
  for (const event of items) {
    if (event.type !== "run") continue
    const decoded = decodeRun(event.value)
    if (decoded.runId !== "run-1") continue
    result.push(decoded)
  }
  return result
})

// ok: firegrid-retained-fold-by-field
Effect.gen(function* () {
  const values = [{ type: "run", value: { runId: "run-1" } }]
  return values.filter((value) => value.type === "run")
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

// ruleid: firegrid-authoritative-run-call
const records = readRetainedRunRecords("memory://test", "run-4")

// ruleid: firegrid-authoritative-run-call
const mapped = pipe(readRetainedRunRecords("memory://test", "run-5"), Effect.map((items) => items))

// ok: firegrid-authoritative-run-call
const alreadyCentralized = { runId: "run-6" }
// firegrid-remediation-hardening.STATIC_QUALITY.10 — semgrep test fixture
// for `firegrid-no-process-env-outside-bin`.

// ruleid: firegrid-no-process-env-outside-bin
const url = process.env.DURABLE_STREAMS_URL

// ruleid: firegrid-no-process-env-outside-bin
const port = process.env.PORT ?? "3000"

// ok: firegrid-no-process-env-outside-bin
declare const cfg: { readonly streamUrl: string }
const ok1 = cfg.streamUrl

// ok: firegrid-no-process-env-outside-bin
declare const env: Record<string, string>
const ok2 = env.SOME_VAR
