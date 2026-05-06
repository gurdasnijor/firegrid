import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  selfTestFirelineRejectionReceiver,
} from "./fireline-rejection-receiver.ts"

describe("FW3 Fireline-shaped rejection receiver scenario", () => {
  it(
    "firegrid-runtime-process.SCENARIOS.14, firegrid-runtime-process.SCENARIOS.16, firegrid-runtime-process.RUNTIME_COMPOSITION.1, firegrid-runtime-process.RUNTIME_COMPOSITION.2, firegrid-runtime-process.RUNTIME_COMPOSITION.6, client-event-plane-registration.BOUNDARY.5, run-wait-primitives.RUN_WAIT_API.1, run-wait-primitives.RUN_WAIT_API.2, run-wait-primitives.RUN_WAIT_API.6, run-wait-primitives.BOUNDARY.4, run-wait-primitives.BOUNDARY.5 — app-owned RunWait receiver composes explicit helper inputs and maps resolved rejection to typed failed run",
    async () => {
      const result = await Effect.runPromise(selfTestFirelineRejectionReceiver())
      const run = result.failed.runs.find((item) =>
        item.operation === "FirelineShapedRejection"
      )
      const completion = result.failed.completions.find((item) =>
        item.kind === "projection_match"
      )

      expect(run).toMatchObject({
        state: "failed",
        error: {
          _tag: "FirelineRequestRejected",
        },
      })
      expect(completion).toMatchObject({
        kind: "projection_match",
        state: "resolved",
      })
      expect(completion?.completionId).toBe(run?.blockedOnCompletionId)
      expect(result.failed.counts.readyWork).toBe(0)
    },
    10_000,
  )
})
