import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { selfTestFirepixelToolInvocationReceiver } from "./firepixel-tool-invocation-receiver.ts"

describe("FP4 Firepixel tool invocation receiver scenario", () => {
  it("client-event-plane-registration.FIREPIXEL_PROFILE.4, firegrid-runtime-process.SCENARIOS.21 — app-owned EventPlane request/result rows terminalize a typed operation without Firegrid-native tool semantics", async () => {
    const result = await Effect.runPromise(
      selfTestFirepixelToolInvocationReceiver(),
    )
    const run = result.report.completed.runs.find((item) =>
      item.runId.startsWith("run-firepixel-tool-")
    )
    expect(run).toMatchObject({
      state: "completed",
      operation: "FirepixelToolInvocation",
      result: {
        invocationId: result.report.plane.result.invocationId,
        promptId: result.report.plane.result.promptId,
        toolName: "scenario.lookup",
        status: "succeeded",
        output: "scenario-result:firepixel tool invocation",
      },
    })
    expect(result.report.plane.request).toMatchObject({
      invocationId: result.report.plane.result.invocationId,
      promptId: result.report.plane.result.promptId,
      toolName: "scenario.lookup",
      state: "requested",
    })
    expect(result.report.completed.counts.completions).toBe(0)
  })
})
