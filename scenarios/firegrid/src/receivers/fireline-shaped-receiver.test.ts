import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestFirelineShapedReceiver } from "./fireline-shaped-receiver.ts"

describe("FW2 Fireline-shaped happy-path receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.13, firegrid-runtime-process.SCENARIOS.16, client-event-plane-registration.BOUNDARY.5, run-wait-primitives.RUN_WAIT_API.1, run-wait-primitives.RUN_WAIT_API.2, run-wait-primitives.RUN_WAIT_API.6, run-wait-primitives.BOUNDARY.4, run-wait-primitives.BOUNDARY.5 — app-owned RunWait receiver resolves projection-match and terminalizes ready work", async () => {
    const result = await Effect.runPromise(selfTestFirelineShapedReceiver())
    const run = result.completed.runs.find((item) =>
      item.operation === "FirelineShapedHappyPath"
    )
    const completion = result.completed.completions.find((item) =>
      item.kind === "projection_match"
    )

    expect(run).toMatchObject({
      state: "completed",
      result: {
        approved: true,
      },
    })
    expect(completion).toMatchObject({
      kind: "projection_match",
      state: "resolved",
    })
    expect(completion?.completionId).toBe(run?.blockedOnCompletionId)
    expect(result.completed.counts.readyWork).toBe(0)
  })
})
