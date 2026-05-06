import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestFailingOperationReceiver } from "./failing-operation-receiver.ts"

describe("S3 handler failure receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.12, firegrid-runtime-process.RUNTIME_RUN_API.1, firegrid-operation-messaging.RUNTIME_HANDLERS.3, firegrid-operation-messaging.RUNTIME_HANDLERS.4 — app-owned receiver terminalizes typed handler failure as failed run observed through inspect", async () => {
    const result = await Effect.runPromise(selfTestFailingOperationReceiver())
    expect(
      result.completed.runs.find((run) =>
        run.runId === "run-failing-operation-cli-1"
      ),
    ).toMatchObject({
      runId: "run-failing-operation-cli-1",
      state: "failed",
      operation: "FailingOperation",
      error: {
        _tag: "ScenarioFailure",
        requestId: "request-failing-operation-cli-1",
        reason: "scenario handler failed intentionally",
      },
    })
  })
})
