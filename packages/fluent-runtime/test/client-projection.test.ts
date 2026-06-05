import { describe, expect, it } from "vitest"
import {
  defaultAgentEventNormalizer,
  projectRawAgentHistory,
  type AgentEventNormalizer,
  type FluentNormalizedEvent,
  type StreamEnvelope,
} from "../src/index.ts"

const rawHistory = (): ReadonlyArray<StreamEnvelope> => [
  { direction: "bridge", raw: { type: "session_started" } },
  { direction: "user", raw: { type: "user_message", messageId: "u-1", text: "review this" } },
  { direction: "agent", raw: { type: "text_delta", messageId: "a-1", delta: "Looks " } },
  { direction: "agent", raw: { type: "text_delta", messageId: "a-1", delta: "good." } },
  { direction: "agent", raw: { type: "assistant_message", messageId: "a-2", text: "I can run tests." } },
  { direction: "agent", raw: { type: "tool_call", toolCallId: "tool-1", name: "shell", input: { cmd: "pnpm test" } } },
  { direction: "agent", raw: { type: "tool_progress", tool_call_id: "tool-1", status: "running", message: "started" } },
  { direction: "agent", raw: { type: "tool_result", toolCallId: "tool-1", output: { exitCode: 0 } } },
  { direction: "agent", raw: { type: "permission_request", requestId: "perm-1", tool_call_id: "tool-2", prompt: "edit file?" } },
  {
    direction: "user",
    raw: {
      type: "control_response",
      response: { request_id: "perm-1", subtype: "success", response: { decision: "allow" } },
    },
  },
  { direction: "agent", raw: { type: "turn_complete", result: { status: "ok" } } },
  { direction: "agent", raw: { type: "status", status: "idle" } },
  { direction: "agent", raw: { type: "unrecognized_native_event", payload: { native: true } } },
]

const rawSnapshot = (history: ReadonlyArray<StreamEnvelope>): string =>
  JSON.stringify(history)

describe("fluent-client-normalization projections", () => {
  it("fluent-client-normalization: Raw events project into normalized events", () => {
    const projection = projectRawAgentHistory(rawHistory())

    expect(projection.normalized.map((event) => event._tag)).toEqual([
      "SessionInit",
      "UserMessage",
      "StreamDelta",
      "StreamDelta",
      "AssistantMessage",
      "ToolCall",
      "ToolProgress",
      "ToolResult",
      "PermissionRequest",
      "ApprovalResponse",
      "TurnCompleted",
      "StatusChange",
      "Unknown",
    ])
    expect(projection.readModels.messages.find((message) => message.messageId === "a-1")?.text).toBe("Looks good.")
    expect(projection.readModels.toolCalls[0]).toMatchObject({
      toolCallId: "tool-1",
      name: "shell",
      status: "completed",
      result: { exitCode: 0 },
    })
    expect(projection.readModels.permissionRequests[0]).toMatchObject({
      requestId: "perm-1",
      status: "resolved",
      response: { decision: "allow" },
    })
    expect(projection.readModels.unknownEvents).toHaveLength(1)
  })

  it("fluent-client-normalization: Read models can be rebuilt from raw history", () => {
    const history = rawHistory()
    const first = projectRawAgentHistory(history)
    const second = projectRawAgentHistory(history)

    expect(first.readModels).toEqual(second.readModels)
    expect(first.readModels.sessions).toEqual([
      { sessionId: "session", status: "started", rawIndexes: [0, 11] },
    ])
    expect(first.readModels.participants.map((participant) => participant.participantId)).toEqual([
      "bridge",
      "user",
      "assistant",
    ])
    expect(first.readModels.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(first.readModels.turns).toEqual([
      { turnId: "turn-0", status: "completed", rawIndexes: [1, 10] },
    ])
    expect(first.readModels.toolCalls.map((tool) => tool.toolCallId)).toEqual(["tool-1"])
    expect(first.readModels.permissionRequests.map((request) => request.requestId)).toEqual(["perm-1"])
    expect(first.readModels.approvalResponses.map((response) => response.requestId)).toEqual(["perm-1"])
  })

  it("fluent-client-normalization: Projection changes do not rewrite raw history", () => {
    const history: ReadonlyArray<StreamEnvelope> = [
      { direction: "bridge", raw: { type: "session_started" } },
      { direction: "user", raw: { type: "user_message", text: "hello" } },
      { direction: "agent", raw: { type: "native_status_v2", state: "warming" } },
    ]
    const before = rawSnapshot(history)
    const v1 = projectRawAgentHistory(history)

    const updatedNormalizer: AgentEventNormalizer = (envelope, rawIndex) => {
      if (
        envelope.direction === "agent" &&
        typeof envelope.raw === "object" &&
        envelope.raw !== null &&
        (envelope.raw as { readonly type?: unknown }).type === "native_status_v2"
      ) {
        const state = (envelope.raw as { readonly state?: unknown }).state
        return [{
          _tag: "StatusChange",
          rawIndex,
          status: typeof state === "string" ? state : "unknown",
          detail: envelope.raw,
        } satisfies FluentNormalizedEvent]
      }
      return defaultAgentEventNormalizer(envelope, rawIndex)
    }

    const v2 = projectRawAgentHistory(history, updatedNormalizer)

    expect(rawSnapshot(history)).toBe(before)
    expect(v1.readModels.unknownEvents).toHaveLength(1)
    expect(v2.readModels.unknownEvents).toHaveLength(0)
    expect(v2.readModels.sessions).toEqual([
      { sessionId: "session", status: "started", rawIndexes: [0, 2] },
    ])
  })
})
