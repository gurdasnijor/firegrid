import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestWaitForReceiver } from "./wait-for-receiver.ts"

describe("F3B waitFor projection-match receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.9, durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.1, durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.4, durable-waits-and-scheduling.WAIT_FOR.1, durable-waits-and-scheduling.WAIT_FOR.8, firegrid-runtime-process.READY_WORK_OPERATOR.5 — app-owned run resolves projection-match wait and terminalizes ready work", async () => {
    const result = await Effect.runPromise(selfTestWaitForReceiver())
    const run = result.completed.runs.find((item) =>
      item.operation === "WaitForPermission"
    )
    const completion = result.completed.completions.find((item) =>
      item.kind === "projection_match"
    )

    expect(run).toMatchObject({
      state: "completed",
      result: {
        status: "approved",
      },
    })
    expect(completion).toMatchObject({
      state: "resolved",
      kind: "projection_match",
    })
    expect(completion?.completionId).toBe(run?.blockedOnCompletionId)
    expect(result.completed.counts.eventStreams).toBe(1)
    expect(result.completed.counts.readyWork).toBe(0)
  })
})
