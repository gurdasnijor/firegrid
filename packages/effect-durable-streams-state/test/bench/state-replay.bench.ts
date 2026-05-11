import {
  DurableStream as RefDurableStream,
  IdempotentProducer,
} from "@durable-streams/client"
import { MaterializedState } from "@durable-streams/state"
import { DurableStream } from "effect-durable-streams"
import { Effect, Schema } from "effect"
import { afterAll, beforeAll, bench, describe } from "vitest"
import { State } from "../../src/index.ts"
import {
  makeEffectRuntime,
  runScoped,
  startBenchServer,
  type EffectRuntime,
} from "./harness.ts"

let server: Awaited<ReturnType<typeof startBenchServer>>
let runtime: EffectRuntime
let populatedUrl: string

const N = 500

const User = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
})

interface ChangeMessage {
  type: string
  key: string
  value: { name: string; email: string }
  headers: { operation: "insert" }
}

beforeAll(async () => {
  server = await startBenchServer()
  runtime = makeEffectRuntime()
  populatedUrl = server.streamUrl("state-replay")

  // Seed N insert change-messages so both clients have history to replay.
  const ref = new RefDurableStream({ url: populatedUrl })
  await ref.create({ contentType: "application/json" })
  const p = new IdempotentProducer(ref, "seed", {
    epoch: 0,
    lingerMs: 5,
    maxBatchBytes: 4 * 1024 * 1024,
    maxInFlight: 1,
  })
  for (let i = 0; i < N; i++) {
    const msg: ChangeMessage = {
      type: "user",
      key: `u${i}`,
      value: { name: `n${i}`, email: `e${i}@x` },
      headers: { operation: "insert" },
    }
    p.append(JSON.stringify(msg))
  }
  await p.flush()
}, 60000)

afterAll(async () => {
  await runtime.dispose()
  await server.stop()
})

describe(`state replay ${N} change events from existing stream`, () => {
  bench("reference @durable-streams/state (MaterializedState)", async () => {
    // The reference state library's MaterializedState is the equivalent
    // of materializing N change events into an in-memory view. We read
    // the raw change events via the client and apply them.
    const ref = new RefDurableStream({ url: populatedUrl })
    const res = await ref.stream<ChangeMessage>({ offset: "-1", live: false })
    const events = await res.json()
    const ms = new MaterializedState()
    ms.applyBatch(events)
    if (ms.getType("user").size !== N) {
      throw new Error(`expected ${N}, got ${ms.getType("user").size}`)
    }
  })

  bench("effect-durable-streams-state (State.collection)", async () => {
    const size = await runScoped(
      runtime,
      Effect.gen(function* () {
        const state = yield* State.make({
          endpoint: { url: populatedUrl },
          producerId: "replay-bench",
        })
        // Register collection then wait for replay to complete.
        const users = yield* state.collection({ type: "user", schema: User })
        // Spin until size matches, bounded by a short timeout. Replay is
        // async — driven by the live read fiber — so we need to await it.
        let size = 0
        for (let i = 0; i < 200; i++) {
          size = yield* users.size
          if (size === N) break
          yield* Effect.sleep("5 millis")
        }
        return size
      }),
    )
    if (size !== N) throw new Error(`expected ${N}, got ${size}`)
  })
})

// Reference `DurableStream` reference is used only to avoid an unused import.
void DurableStream
