/**
 * Tests for the agent I/O event contract schemas.
 *
 * Codecs translate per-protocol wire formats into and out of these
 * events. The schemas exist so that codec authors and tests can
 * validate the event boundary at runtime.
 */

import { Prompt } from "@effect/ai"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AgentPromptSchema,
  AgentCapabilitiesSchema,
  AgentInputEventSchema,
  AgentOutputEventSchema,
  AgentToolUseModeSchema,
} from "../../src/events/contract.ts"

const decodes = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<A> =>
  Effect.runPromise(Schema.decodeUnknown(schema)(input))

const rejects = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Promise<unknown> =>
  Effect.runPromise(Effect.flip(Schema.decodeUnknown(schema)(input)))

const userMessage = (text: string): Prompt.UserMessage =>
  Prompt.userMessage({ content: [Prompt.textPart({ text })] })

describe("AgentInputEvent", () => {
  it("firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.1 decodes a Prompt input with Effect AI Prompt content", async () => {
    const decoded = await decodes(AgentInputEventSchema, {
      _tag: "Prompt",
      prompt: Schema.encodeSync(Prompt.UserMessage)(
        userMessage("hello"),
      ),
      correlationId: "ingress-1",
    })
    expect(decoded._tag).toBe("Prompt")
  })

  it("firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.1 rejects a full Prompt envelope instead of a UserMessage", async () => {
    const error = await rejects(AgentInputEventSchema, {
      _tag: "Prompt",
      prompt: Schema.encodeSync(Prompt.Prompt)(Prompt.make("hello")),
      correlationId: "ingress-1",
    })
    expect(error).toBeDefined()
  })

  it("firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.3 decodes a ToolResult with an Effect AI tool-result part", async () => {
    const decoded = await decodes(AgentInputEventSchema, {
      _tag: "ToolResult",
      part: {
        type: "tool-result",
        id: "tool-1",
        name: "sleep",
        result: { result: 42 },
        isFailure: false,
        providerExecuted: false,
      },
    })
    expect(decoded._tag).toBe("ToolResult")
  })

  it("firegrid-agent-io-effect-ai-alignment.LOCAL_LIFECYCLE_EVENTS.1 decodes a PermissionResponse Allow", async () => {
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
  it("firegrid-agent-io-effect-ai-alignment.LOCAL_LIFECYCLE_EVENTS.1 decodes a Ready event with full capabilities", async () => {
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

  it("firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.2 decodes a ToolUse event with an Effect AI tool-call part", async () => {
    const decoded = await decodes(AgentOutputEventSchema, {
      _tag: "ToolUse",
      part: {
        type: "tool-call",
        id: "tool-1",
        name: "sleep",
        params: { durationMs: 100 },
        providerExecuted: false,
      },
    })
    expect(decoded._tag).toBe("ToolUse")
  })

  it("decodes a TurnComplete with Effect AI finish reason", async () => {
    const decoded = await decodes(AgentOutputEventSchema, {
      _tag: "TurnComplete",
      finishReason: "stop",
    })
    expect(decoded._tag).toBe("TurnComplete")
  })

  it("rejects an unknown stop reason", async () => {
    const error = await rejects(AgentOutputEventSchema, {
      _tag: "TurnComplete",
      finishReason: "not-a-real-reason",
    })
    expect(error).toBeDefined()
  })
})

describe("prompt content", () => {
  it("firegrid-agent-io-effect-ai-alignment.VALIDATION.3 decodes Effect AI UserMessage schema", async () => {
    const decoded = await decodes(
      AgentPromptSchema,
      Schema.encodeSync(Prompt.UserMessage)(
        userMessage("summarize"),
      ),
    )
    expect(decoded.role).toBe("user")
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

describe("AgentToolUseMode", () => {
  it("firegrid-runtime-agent-event-pipeline.STAGES.3-9 uses the exact protocol mode taxonomy names", async () => {
    await expect(decodes(AgentToolUseModeSchema, "observation_only")).resolves
      .toBe("observation_only")
    await expect(decodes(AgentToolUseModeSchema, "client_result_roundtrip")).resolves
      .toBe("client_result_roundtrip")
    await expect(decodes(AgentToolUseModeSchema, "control_channel_request_response")).resolves
      .toBe("control_channel_request_response")
    await expect(rejects(AgentToolUseModeSchema, "client_result")).resolves.toBeDefined()
  })
})
