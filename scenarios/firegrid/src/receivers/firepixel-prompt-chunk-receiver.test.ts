import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  selfTestFirepixelPromptChunkReceiver,
} from "./firepixel-prompt-chunk-receiver.ts"

describe("FP2 Firepixel prompt chunk EventPlane receiver scenario", () => {
  it("client-event-plane-registration.PRODUCER_API.6, client-event-plane-registration.PROJECTION_API.6, firegrid-runtime-process.SCENARIOS.20, firegrid-runtime-process.RUNTIME_COMPOSITION.1, firegrid-runtime-process.RUNTIME_COMPOSITION.2, firegrid-runtime-process.RUNTIME_COMPOSITION.6 — handler composes explicit helper inputs and emits prompt and permission rows before RunWait resumes from EventPlane projection state", async () => {
    const result = await Effect.runPromise(
      selfTestFirepixelPromptChunkReceiver(),
    )
    const runValue = result.report.completed.runs.find((item) =>
      item.operation === "FirepixelPromptChunk"
    )
    const pendingRun = result.report.pending.runs.find((item) =>
      item.operation === "FirepixelPromptChunk"
    )
    const pendingCompletion = result.report.pending.completions.find((item) =>
      item.completionId === pendingRun?.blockedOnCompletionId
    )
    const resolvedCompletion = result.report.completed.completions.find(
      (item) => item.completionId === pendingCompletion?.completionId,
    )
    const projectionMatchCompletions =
      result.report.completed.completions.filter((item) =>
        item.kind === "projection_match"
      )
    const promptChunk = result.report.beforeDecision.promptChunks[0]
    const permissionRequest =
      result.report.beforeDecision.permissionRequests[0]
    const permissionDecision =
      result.report.afterDecision.permissionDecisions[0]

    expect(runValue).toMatchObject({
      state: "completed",
      result: {
        emitted: true,
        decision: "allowed",
      },
    })
    expect(pendingRun).toMatchObject({ state: "blocked" })
    expect(pendingCompletion).toMatchObject({
      kind: "projection_match",
      state: "pending",
    })
    expect(runValue?.blockedOnCompletionId).toBe(
      pendingCompletion?.completionId,
    )
    expect(result.report.beforeDecision.permissionDecisions).toHaveLength(0)
    const resultValue = runValue?.result as
      | {
        readonly promptId?: string
        readonly chunkId?: string
        readonly permissionId?: string
      }
      | undefined
    expect(promptChunk?.promptId).toBe(resultValue?.promptId)
    expect(promptChunk?.chunkId).toBe(resultValue?.chunkId)
    expect(promptChunk?.text).toBe("streamed prompt chunk")
    expect(promptChunk?.sequence).toBe(1)
    expect(permissionRequest).toMatchObject({
      promptId: resultValue?.promptId,
      permissionId: resultValue?.permissionId,
      state: "requested",
    })
    expect(permissionDecision).toMatchObject({
      promptId: resultValue?.promptId,
      permissionId: resultValue?.permissionId,
      decision: "allowed",
    })
    expect(resolvedCompletion).toMatchObject({
      kind: "projection_match",
      state: "resolved",
    })
    expect(projectionMatchCompletions).toHaveLength(1)
    expect(result.report.completed.counts.readyWork).toBe(0)
  })
})
