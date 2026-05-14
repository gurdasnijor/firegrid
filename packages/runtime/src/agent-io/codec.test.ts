import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentIo from "./index.ts"
import {
  type AgentCodecOpenOptions,
  publishToolkitMetadata,
} from "./codec.ts"

const EchoTool = Tool.make("echo", {
  description: "Echo text.",
})
  .setParameters(Schema.Struct({
    text: Schema.String,
  }))
  .setSuccess(Schema.Struct({
    text: Schema.String,
  }))

const EchoToolkit = Toolkit.make(EchoTool)

describe("AgentCodecOpenOptions", () => {
  it("firegrid-agent-io-effect-ai-alignment.TOOLKIT_METADATA.1 firegrid-agent-io-effect-ai-alignment.VALIDATION.1 accepts Effect AI Toolkit metadata", () => {
    const options: AgentCodecOpenOptions = {
      toolkit: EchoToolkit,
    }
    const tool = options.toolkit?.tools.echo
    if (tool === undefined) {
      throw new Error("expected echo tool")
    }

    expect(tool.name).toBe("echo")
  })

  it("firegrid-agent-io-effect-ai-alignment.TOOLKIT_METADATA.2 projects Effect AI Tool metadata without descriptors", async () => {
    const published = publishToolkitMetadata(EchoToolkit)
    expect(published).toHaveLength(1)
    const [tool] = published
    if (tool === undefined) {
      throw new Error("expected echo tool metadata")
    }

    expect(tool.name).toBe("echo")
    expect(tool.description).toBe("Echo text.")
    expect(tool.parametersSchema).toBe(EchoTool.parametersSchema)
    expect(tool.successSchema).toBe(EchoTool.successSchema)
    expect(tool.failureSchema).toBe(EchoTool.failureSchema)
    expect(tool.annotations).toBeDefined()

    const encodedFromPublished = await Effect.runPromise(
      Schema.encodeUnknown(tool.parametersSchema)({
        text: "hello",
      }),
    )
    const encodedFromTool = await Effect.runPromise(
      Schema.encodeUnknown(EchoTool.parametersSchema)({
        text: "hello",
      }),
    )
    expect(encodedFromPublished).toEqual(encodedFromTool)
  })

  it("firegrid-agent-io-effect-ai-alignment.VALIDATION.2 does not export the retired descriptor helper", () => {
    expect("defineAgentTool" in AgentIo).toBe(false)
  })
})
