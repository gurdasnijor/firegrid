import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyDurableStreamsBackedPipeline } from "../src/configurations/durable-streams-backed-pipeline.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

describe("tiny-firegrid durable-streams-backed pipeline", () => {
  it("wires dispatcher-driven intent through the production Durable Streams substrate", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const pipeline = tinyDurableStreamsBackedPipeline({
      baseUrl,
      namespace: `tiny-e2e-${crypto.randomUUID()}`,
    })
    const result = await Effect.runPromise(pipeline.runEndToEnd())

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

  it("replays a completed workflow after engine restart without duplicate sends", async () => {
    if (baseUrl === undefined) throw new Error("server not started")

    const pipeline = tinyDurableStreamsBackedPipeline({
      baseUrl,
      namespace: `tiny-replay-${crypto.randomUUID()}`,
    })
    const result = await Effect.runPromise(pipeline.replayCompletedWorkflow())

    expect(result.firstRun.partial.map(row => row.sequence)).toEqual([0])
    expect(result.firstRun.completed.workflowOutput).toEqual({
      sentInputs: 1,
      persistedOutputs: 2,
    })
    expect(result.firstRunSentInputs).toMatchObject([
      { _tag: "Prompt", correlationId: "intent-a" },
    ])
    expect(result.secondRun.workflowOutput).toEqual({
      sentInputs: 1,
      persistedOutputs: 2,
    })
    expect(result.secondRunSentInputs).toEqual([])
    expect(result.secondRun.observations.map(row => row.sequence)).toEqual([0, 1])
  })
})
