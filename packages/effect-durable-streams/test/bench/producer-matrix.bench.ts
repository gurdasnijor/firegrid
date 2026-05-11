import {
  DurableStream as RefDurableStream,
  IdempotentProducer,
} from "@durable-streams/client"
import { Effect, Schema, Stream } from "effect"
import { afterAll, beforeAll, bench, describe } from "vitest"
import { DurableStream } from "../../src/index.ts"
import {
  makeEffectRuntime,
  runScoped,
  startBenchServer,
  type EffectRuntime,
} from "./harness.ts"

let server: Awaited<ReturnType<typeof startBenchServer>>
let runtime: EffectRuntime

const N = 500

const Event = Schema.Struct({ n: Schema.Number })

beforeAll(async () => {
  server = await startBenchServer()
  runtime = makeEffectRuntime()
}, 30000)

afterAll(async () => {
  await runtime.dispose()
  await server.stop()
})

/**
 * Producer throughput across the (maxBatchSize, lingerMs) matrix called out
 * in the PR #148 review. Each iteration creates a fresh stream + producer,
 * pumps N events, and flushes. The reference IdempotentProducer is
 * byte-bounded (no count cap), so for the "matches reference" cells we set
 * the effect-side maxBatchSize very high.
 */
const grid: Array<{ maxBatchSize: number; lingerMs: number }> = [
  { maxBatchSize: 1, lingerMs: 0 },
  { maxBatchSize: 1, lingerMs: 5 },
  { maxBatchSize: 100, lingerMs: 0 },
  { maxBatchSize: 100, lingerMs: 5 },
  { maxBatchSize: 100, lingerMs: 10 },
  { maxBatchSize: 1000, lingerMs: 0 },
  { maxBatchSize: 1000, lingerMs: 5 },
  { maxBatchSize: 100000, lingerMs: 0 },
  { maxBatchSize: 100000, lingerMs: 5 },
]

for (const params of grid) {
  describe(`producer ${N} events · batch=${params.maxBatchSize} linger=${params.lingerMs}ms`, () => {
    bench("reference @durable-streams/client", async () => {
      const url = server.streamUrl("prod-ref-grid")
      const ref = new RefDurableStream({ url })
      await ref.create({ contentType: "application/json" })
      const producer = new IdempotentProducer(ref, "ref-prod", {
        epoch: 0,
        lingerMs: params.lingerMs,
        maxBatchBytes: 4 * 1024 * 1024,
        maxInFlight: 1,
      })
      for (let i = 0; i < N; i++) {
        producer.append(JSON.stringify({ n: i }))
      }
      await producer.flush()
    })

    bench("effect-durable-streams", async () => {
      const url = server.streamUrl("prod-eff-grid")
      await runScoped(
        runtime,
        Effect.gen(function* () {
          const s = DurableStream.define({ endpoint: { url }, schema: Event })
          yield* s.create({ contentType: "application/json" })
          const p = yield* s.producer({
            producerId: "eff-prod",
            epoch: 0,
            lingerMs: params.lingerMs,
            maxBatchSize: params.maxBatchSize,
          })
          yield* Stream.fromIterable(
            Array.from({ length: N }, (_, i) => ({ n: i })),
          ).pipe(Stream.run(p))
          yield* p.flush
        }),
      )
    })
  })
}
