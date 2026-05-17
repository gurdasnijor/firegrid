/**
 * Tests for the structured ToolError ADT and the ToolResult builders.
 *
 * The error ADT is the substance that `toolUseToEffect` catches and
 * surfaces back as `ToolResult` events with `isError: true`.
 */

import { Effect, ParseResult, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  formatToolError,
  ToolError,
  toolErrorResult,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
  toolResult,
  unknownToolResult,
} from "../../src/agent-tools/bindings/tool-error.ts"

describe("ToolError schema", () => {
  it("accepts the ToolInvalidInput variant", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(ToolError)({
        _tag: "ToolInvalidInput",
        toolUseId: "t-1",
        name: "sleep",
        reason: "bad",
      }),
    )
    expect(decoded._tag).toBe("ToolInvalidInput")
  })

  it("accepts the ToolExecutionFailed variant", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(ToolError)({
        _tag: "ToolExecutionFailed",
        toolUseId: "t-1",
        name: "wait_for",
        message: "boom",
      }),
    )
    expect(decoded._tag).toBe("ToolExecutionFailed")
  })

  it("rejects unknown tags", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Schema.decodeUnknown(ToolError)({
          _tag: "Bogus",
          toolUseId: "t-1",
          name: "sleep",
        }),
      ),
    )
    expect(error).toBeDefined()
  })
})

describe("formatToolError", () => {
  it("formats ToolInvalidInput with reason", () => {
    const message = formatToolError({
      _tag: "ToolInvalidInput",
      toolUseId: "t-1",
      name: "sleep",
      reason: "expected integer",
    })
    expect(message).toContain("sleep")
    expect(message).toContain("expected integer")
  })

  it("formats ToolExecutionFailed with message", () => {
    const message = formatToolError({
      _tag: "ToolExecutionFailed",
      toolUseId: "t-1",
      name: "execute",
      message: "sandbox unreachable",
    })
    expect(message).toContain("execute")
    expect(message).toContain("sandbox unreachable")
  })

  it("formats ToolCancelled by name", () => {
    expect(
      formatToolError({
        _tag: "ToolCancelled",
        toolUseId: "t-1",
        name: "spawn",
      }),
    ).toContain("spawn")
  })
})

describe("ToolResult builders", () => {
  it("toolResult builds a non-error ToolResult event", () => {
    const result = toolResult("t-1", "sleep", { slept: true })
    expect(result).toMatchObject({
      _tag: "ToolResult",
      part: {
        id: "t-1",
        name: "sleep",
        result: { slept: true },
        isFailure: false,
      },
    })
  })

  it("unknownToolResult builds a structured error payload", () => {
    const result = unknownToolResult("t-1", "definitely_not_a_tool")
    expect(result.part.isFailure).toBe(true)
    expect(result.part.id).toBe("t-1")
    expect(result.part.result).toMatchObject({
      error: { _tag: "UnknownTool", name: "definitely_not_a_tool" },
    })
  })

  it("toolErrorResult preserves the tagged error payload", () => {
    const result = toolErrorResult(toolExecutionFailed("t-1", "sleep", "boom"))
    expect(result.part.isFailure).toBe(true)
    const content = result.part.result as {
      readonly error: ToolError
      readonly message: string
    }
    expect(content.error).toMatchObject({
      _tag: "ToolExecutionFailed",
      toolUseId: "t-1",
      name: "sleep",
    })
    expect(content.message).toContain("sleep")
  })

  it("toolInvalidInputFromParseError summarizes the parse error", async () => {
    const parseError = await Effect.runPromise(
      Effect.flip(
        Schema.decodeUnknown(Schema.Struct({ x: Schema.Number }))({ x: "no" }),
      ),
    )
    // Sanity: it is a ParseError.
    expect(parseError).toBeInstanceOf(ParseResult.ParseError)
    const error = toolInvalidInputFromParseError("t-1", "sleep", parseError)
    expect(error._tag).toBe("ToolInvalidInput")
    expect(error.reason.length).toBeGreaterThan(0)
  })
})
