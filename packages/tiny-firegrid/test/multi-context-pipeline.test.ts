import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { tinyMultiContextPipeline } from "../src/configurations/multi-context-pipeline.ts"

describe("tiny-firegrid multi-context pipeline", () => {
  it("demuxes interleaved intents through active per-context engine handles", async () => {
    const result = await Effect.runPromise(tinyMultiContextPipeline)

    expect(result.workflowOutputs).toEqual({
      "ctx-a": { sentInputs: 1, persistedOutputs: 1 },
      "ctx-b": { sentInputs: 1, persistedOutputs: 1 },
    })
    expect(result.sentInputsByContext["ctx-a"]).toMatchObject([
      { _tag: "Prompt", correlationId: "intent-a" },
    ])
    expect(result.sentInputsByContext["ctx-b"]).toMatchObject([
      { _tag: "Prompt", correlationId: "intent-b" },
    ])
    expect(result.observations.map(row => row.contextId).sort()).toEqual([
      "ctx-a",
      "ctx-b",
    ])
  })
})
