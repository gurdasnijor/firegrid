/**
 * Tests for the agent I/O event contract schemas.
 *
 * Codecs translate per-protocol wire formats into and out of these
 * events. The schemas exist so that codec authors and tests can
 * validate the event boundary at runtime.
 */

import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentCapabilitiesSchema,
  AgentInputEventSchema,
  AgentOutputEventSchema,
  PromptContentSchema,
} from "./contract.ts"

const decodes = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<A> =>
  Effect.runPromise(Schema.decodeUnknown(schema)(input))

const rejects = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<unknown> =>
  Effect.runPromise(Effect.flip(Schema.decodeUnknown(schema)(input)))

describe("AgentInputEvent", () => {
  it("decodes a Prompt input with text parts", async () => {
    const decoded = await decodes(AgentInputEventSchema, {
      _tag: "Prompt",
      content: [{ _tag: "Text", text: "hello" }],
      correlationId: "ingress-1",
    })
    expect(decoded._tag).toBe("Prompt")
  })

  it("decodes a ToolResult with isError", async () => {
    const decoded = await decodes(AgentInputEventSchema, {
      _tag: "ToolResult",
      toolUseId: "tool-1",
      content: { result: 42 },
      isError: false,
    })
    expect(decoded._tag).toBe("ToolResult")
  })

  it("decodes a PermissionResponse Allow", async () => {
    const decoded = await decodes(AgentInputEventSchema, {
      _tag: "PermissionResponse",
      permissionRequestId: "perm-1",
      decision: { _tag: "Allow", optionId: "allow-once" },
    })
    expect(decoded._tag).toBe("PermissionResponse")
  })

  it("rejects unknown event tags", async () => {
    const error = await rejects(AgentInputEventSchema, {
      _tag: "Bogus",
      payload: 1,
    })
    expect(error).toBeDefined()
  })
})

describe("AgentOutputEvent", () => {
  it("decodes a Ready event with full capabilities", async () => {
    const decoded = await decodes(AgentOutputEventSchema, {
      _tag: "Ready",
      capabilities: {
        streamingText: true,
        tools: true,
        permissions: true,
        images: false,
        structuredInput: false,
        cancellation: true,
        multiTurn: true,
        customStatus: ["tool_call_update"],
      },
    })
    expect(decoded._tag).toBe("Ready")
  })

  it("decodes a ToolUse event", async () => {
    const decoded = await decodes(AgentOutputEventSchema, {
      _tag: "ToolUse",
      toolUseId: "tool-1",
      name: "sleep",
      input: { durationMs: 100 },
    })
    expect(decoded._tag).toBe("ToolUse")
  })

  it("decodes a TurnComplete with end_turn", async () => {
    const decoded = await decodes(AgentOutputEventSchema, {
      _tag: "TurnComplete",
      stopReason: "end_turn",
    })
    expect(decoded._tag).toBe("TurnComplete")
  })

  it("rejects an unknown stop reason", async () => {
    const error = await rejects(AgentOutputEventSchema, {
      _tag: "TurnComplete",
      stopReason: "not-a-real-reason",
    })
    expect(error).toBeDefined()
  })
})

describe("prompt content", () => {
  it("decodes mixed text/structured parts", async () => {
    const decoded = await decodes(PromptContentSchema, [
      { _tag: "Text", text: "summarize" },
      { _tag: "Structured", data: { issueId: 1 } },
    ])
    expect(decoded).toHaveLength(2)
  })
})

describe("AgentCapabilities", () => {
  it("requires every boolean capability flag", async () => {
    const error = await rejects(AgentCapabilitiesSchema, {
      streamingText: true,
      // missing other fields
    })
    expect(error).toBeDefined()
  })
})
