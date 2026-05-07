import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestDirectStateClockReceiver } from "./direct-state-clock-receiver.ts"

describe("Direct Durable Streams State + durable Clock scenario", () => {
  it("runs a job through createStreamDB actions and Effect.sleep over the durable Clock layer", async () => {
    const result = await Effect.runPromise(selfTestDirectStateClockReceiver())

    expect(result.pendingWakeups.length).toBeGreaterThan(0)
    expect(result.completedJob).toMatchObject({
      status: "completed",
      message: "direct durable state plus durable clock",
    })
    expect(result.event).toMatchObject({
      type: "completed",
      message: "direct durable state plus durable clock",
    })
    expect(result.clockRows.some((row) => row.status === "dispatched"))
      .toBe(true)
  })
})
