import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { tinyWaitForOutputPipeline } from "../src/configurations/wait-for-output-pipeline.ts"

describe("tiny-firegrid wait_for output pipeline", () => {
  it("resolves AgentOutput sources against per-context output targets", async () => {
    const result = await Effect.runPromise(tinyWaitForOutputPipeline)

    expect(result.agentOutputAfter.target).toEqual({
      _tag: "PerContextOutput",
      contextId: "ctx-a",
      activityAttempt: 0,
      afterSequence: 0,
    })
    expect(result.agentOutputAfter.outcome).toMatchObject({
      _tag: "Match",
      row: { contextId: "ctx-a", sequence: 1 },
    })
    expect(result.agentOutputInCurrentContext.target).toEqual({
      _tag: "PerContextOutput",
      contextId: "ctx-a",
      activityAttempt: 0,
    })
    expect(result.agentOutputInCurrentContext.outcome).toMatchObject({
      _tag: "Match",
      row: { contextId: "ctx-a", sequence: 0 },
    })
  })
})
