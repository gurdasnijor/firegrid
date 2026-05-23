import { Prompt } from "@effect/ai"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { type AgentOutputEvent } from "../../src/events/index.ts"
import {
  decodeRuntimeAgentOutputEnvelope,
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
} from "../../src/events/output.ts"

describe("runtime agent output envelope", () => {
  it("firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.8 encodes and decodes AgentOutputEvent envelopes", () => {
    const event: AgentOutputEvent = {
      _tag: "ToolUse",
      part: Prompt.toolCallPart({
        id: "tool-1",
        name: "sleep",
        params: { durationMs: 1 },
        providerExecuted: false,
      }),
    }

    const decoded = decodeRuntimeAgentOutputEnvelope(
      encodeRuntimeAgentOutputEnvelope(event),
    )

    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isSome(decoded)) {
      expect(decoded.value).toEqual(event)
    }
  })

  it("firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.8 projects durable ToolUse identity from RuntimeOutput rows", () => {
    const raw = encodeRuntimeAgentOutputEnvelope({
      _tag: "ToolUse",
      part: Prompt.toolCallPart({
        id: "tool-1",
        name: "sleep",
        params: { durationMs: 1 },
        providerExecuted: false,
      }),
    })

    const observation = runtimeAgentOutputObservationFromRow({
      eventId: {
        contextId: "ctx_test",
        activityAttempt: 2,
        target: "events",
        sequence: 3,
      },
      contextId: "ctx_test",
      activityAttempt: 2,
      sequence: 3,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-15T00:00:00.000Z",
      raw,
    })

    expect(Option.isSome(observation)).toBe(true)
    if (Option.isSome(observation)) {
      expect(observation.value).toMatchObject({
        contextId: "ctx_test",
        activityAttempt: 2,
        sequence: 3,
        _tag: "ToolUse",
        toolUseId: "tool-1",
        toolName: "sleep",
      })
    }
  })
})
