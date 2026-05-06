import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestSleepReceiver } from "./sleep-receiver.ts"

describe("S2 sleep/timer receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.11, durable-subscribers.TIMER_SUBSCRIBER.1, durable-subscribers.TIMER_SUBSCRIBER.4, durable-waits-and-scheduling.SLEEP.6, choreography-facade.CHOREOGRAPHY_API.12, firegrid-runtime-process.READY_WORK_OPERATOR.5 — app-owned run resolves Choreography.sleep through timer completion and terminalizes ready work", async () => {
    const result = await Effect.runPromise(selfTestSleepReceiver())
    const run = result.completed.runs.find((item) =>
      item.operation === "Sleep"
    )
    const completion = result.completed.completions.find((item) =>
      item.kind === "timer"
    )

    expect(result.beforeDue.runs).toContainEqual(
      expect.objectContaining({
        operation: "Sleep",
        state: "blocked",
      }),
    )
    expect(result.beforeDue.completions).toContainEqual(
      expect.objectContaining({
        kind: "timer",
        state: "pending",
      }),
    )
    expect(run).toMatchObject({
      state: "completed",
      result: {
        slept: true,
      },
    })
    expect(completion).toMatchObject({
      kind: "timer",
      state: "resolved",
    })
    expect(completion?.completionId).toBe(run?.blockedOnCompletionId)
    expect(result.completed.counts.readyWork).toBe(0)
  })
})
