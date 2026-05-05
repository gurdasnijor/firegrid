import { DurableStream } from "@durable-streams/client"
import { Clock, Effect, TestClock, TestContext } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableWaits, DurableWaitsLive } from "../waits.ts"
import { rebuildProjection } from "../stream.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// ergonomic-facade.AWAITABLE_BOUNDARY.1, .2 — no new Awaitable namespace
// this slice. The sleep example uses the existing DurableWaits service
// directly to prove the boundary.
// ergonomic-facade.SUBSCRIBER_BOUNDARY.2 — subscriber profiles are NOT
// app-facing here; this test does not wire any subscriber.
// ergonomic-facade.AWAITABLE_BOUNDARY.3 — DurableWaits.sleep reads time
// via Effect Clock so tests can control time.
// ergonomic-facade.COMMON_USAGE_EXAMPLES.5
describe("ergonomic-facade.AWAITABLE_BOUNDARY.3 — sleep example uses DurableWaits.sleep with Effect Clock", () => {
  it("DurableWaits.sleep declares a pending timer completion whose dueAtMs derives from the Effect Clock (TestClock-controllable)", async () => {
    const url = freshStreamUrl("facade-sleep")
    await DurableStream.create({ url, contentType: "application/json" })

    const program = Effect.gen(function* () {
      const waits = yield* DurableWaits
      // Set deterministic clock to t=0 and confirm dueAtMs = 0 + 1500.
      yield* TestClock.setTime(0)
      const before = yield* Clock.currentTimeMillis
      expect(before).toBe(0)
      const result = yield* waits.sleep({ durationMs: 1500 })
      return result
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(DurableWaitsLive({ streamUrl: url })),
        Effect.provide(TestContext.TestContext),
      ),
    )
    expect(result.kind).toBe("timer")
    expect(result.state).toBe("pending")

    // Inspect the durable row to prove dueAtMs comes from Effect Clock and
    // the row is a durable.completion timer with no subscriber wired.
    const snap = await rebuildProjection({ url })
    const completion = snap.completions.get(result.completionId)
    expect(completion).toBeDefined()
    expect(completion?.kind).toBe("timer")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as { dueAtMs: number; durationMs: number }
    expect(data.dueAtMs).toBe(1500)
    expect(data.durationMs).toBe(1500)
  })
})
