import type { RuntimeEvent } from "@firegrid/protocol/launch"
import type {
  MaterializerProjectResult,
  RuntimeOutputMaterializer,
} from "./types.ts"

type ExampleAssistantEvent = {
  readonly type: "assistant"
  readonly text: string
}

type DecodeExampleAssistantEventResult =
  | {
    readonly _tag: "ok"
    readonly event: ExampleAssistantEvent
  }
  | {
    readonly _tag: "skip"
  }
  | {
    readonly _tag: "fail"
    readonly failure: MaterializerProjectResult["failures"][number]
  }

const isExampleAssistantEvent = (
  value: unknown,
): value is ExampleAssistantEvent =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "assistant" &&
  "text" in value &&
  typeof value.text === "string"

const decodeExampleAssistantEvent = (
  row: RuntimeEvent,
): DecodeExampleAssistantEventResult => {
  try {
    const value: unknown = JSON.parse(row.raw)
    return isExampleAssistantEvent(value)
      ? { _tag: "ok", event: value }
      : { _tag: "skip" }
  } catch (cause) {
    return {
      _tag: "fail",
      failure: {
        sourceRuntimeEventId: row.eventId,
        reason: "malformed-json",
        cause,
      },
    }
  }
}

export const exampleJsonlSessionMaterializer: RuntimeOutputMaterializer = {
  name: "example-jsonl-session",
  version: "0",
  project: row => {
    const decoded = decodeExampleAssistantEvent(row)
    switch (decoded._tag) {
      case "skip":
        return { changes: [], failures: [] }
      case "fail":
        return { changes: [], failures: [decoded.failure] }
      case "ok":
        break
    }
    const event = decoded.event

    const sessionId = `session_${row.contextId}`
    return {
      failures: [],
      changes: [
        {
          kind: "upsertSession",
          value: {
            sessionId,
            contextId: row.contextId,
            status: "active",
          },
        },
        {
          kind: "upsertMessage",
          value: {
            messageId: `msg_${row.contextId}_${row.activityAttempt}_${row.sequence}`,
            sessionId,
            contextId: row.contextId,
            role: "assistant",
            text: event.text,
            sourceRuntimeEventId: row.eventId,
            createdAt: row.receivedAt,
          },
        },
      ],
    }
  },
}
