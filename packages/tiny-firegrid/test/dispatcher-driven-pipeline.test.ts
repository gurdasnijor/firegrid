import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { tinyDispatcherDrivenPipeline } from "../src/configurations/dispatcher-driven-pipeline.ts"

describe("tiny-firegrid dispatcher-driven pipeline", () => {
  it("routes durable input intents through a host-side dispatcher before workflow send", async () => {
    const result = await Effect.runPromise(tinyDispatcherDrivenPipeline([
      { type: "output", channel: "stdout", text: "hello" },
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
  })
})
