import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { tinyCurrentPipeline } from "../src/configurations/current-pipeline.ts"

describe("tiny-firegrid current pipeline", () => {
  it("wires intent through workflow/session into sandbox output observations", async () => {
    const result = await Effect.runPromise(tinyCurrentPipeline([
      { type: "output", channel: "stdout", text: "hello" },
      { type: "output", channel: "stderr", text: "ignored" },
      { type: "exit", exitCode: 0 },
    ]))

    expect(result.workflowOutput).toEqual({
      sentInputs: 1,
      persistedOutputs: 1,
    })
    expect(result.sentInputs).toMatchObject([
      { _tag: "Prompt", correlationId: "intent-a" },
    ])
    expect(result.observations.map(row => row.event._tag)).toEqual(["TextChunk"])
    expect(result.observations.map(row => row.contextId)).toEqual(["ctx-a"])
  })
})
