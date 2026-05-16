import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentIo from "../events/index.ts"
import {
  type AgentCodecOpenOptions,
} from "./contract.ts"

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
    const { echo } = EchoToolkit.tools
    if (echo === undefined) {
      throw new Error("expected echo tool")
    }

    expect(echo.name).toBe("echo")
    expect(echo.description).toBe("Echo text.")
    expect(echo.parametersSchema).toBe(EchoTool.parametersSchema)
    expect(echo.successSchema).toBe(EchoTool.successSchema)
    expect(echo.failureSchema).toBe(EchoTool.failureSchema)
    expect(echo.annotations).toBeDefined()

    const encodedFromToolkit = await Effect.runPromise(
      Schema.encodeUnknown(echo.parametersSchema)({
        text: "hello",
      }),
    )
    const encodedFromTool = await Effect.runPromise(
      Schema.encodeUnknown(EchoTool.parametersSchema)({
        text: "hello",
      }),
    )
    expect(encodedFromToolkit).toEqual(encodedFromTool)
  })

  it("firegrid-agent-io-effect-ai-alignment.VALIDATION.2 does not export the retired descriptor helper", () => {
    expect("defineAgentTool" in AgentIo).toBe(false)
  })
})
