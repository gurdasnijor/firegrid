import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestEchoReceiver } from "./echo-receiver.ts"

describe("F3A Echo receiver scenario", () => {
  it("firegrid-runtime-process.SCENARIOS.7, firegrid-runtime-process.RUNTIME_RUN_API.1, firegrid-runtime-process.READY_WORK_OPERATOR.7, firegrid-operation-messaging.RUNTIME_HANDLERS.1, firegrid-operation-messaging.RUNTIME_HANDLERS.4 — app-owned run terminalizes the F1A Echo row and inspect observes completion", async () => {
    const result = await Effect.runPromise(selfTestEchoReceiver())
    expect(
      result.completed.runs.find((run) => run.runId === "run-echo-cli-1"),
    ).toMatchObject({
      runId: "run-echo-cli-1",
      state: "completed",
      operation: "Echo",
      result: {
        message: "hello firegrid",
        length: 14,
      },
    })
  })
})
