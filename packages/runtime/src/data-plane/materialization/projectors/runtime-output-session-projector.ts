import {
  RuntimeEventSchema,
  type RuntimeEvent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Schema } from "effect"
import {
  EventProjector,
  EventProjectorError,
  type EventPipelineFailure,
  type EventProjectorResult,
} from "../event-pipeline.ts"
import type { SessionStateChange } from "../sinks/state-protocol/session-state-change.ts"

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
    readonly failure: EventPipelineFailure
  }

const decodeRuntimeEvent = Schema.decodeUnknownEither(RuntimeEventSchema)

const eventProjectorError = (
  op: string,
  cause: unknown,
): EventProjectorError =>
  new EventProjectorError({ op, cause })

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
        sourceEventId: row.eventId,
        reason: "malformed-json",
        cause,
      },
    }
  }
}

export const projectRuntimeOutputToSessionState = (
  row: RuntimeEvent,
): EventProjectorResult<SessionStateChange> => {
  const decoded = decodeExampleAssistantEvent(row)
  switch (decoded._tag) {
    case "skip":
      return { _tag: "Ignored", reason: "unsupported-provider-payload" }
    case "fail":
      return { _tag: "Failed", failures: [decoded.failure] }
    case "ok":
      break
  }

  const event = decoded.event
  const sessionId = `session_${row.contextId}`
  return {
    _tag: "Projected",
    events: [
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
}

/**
 * firegrid-event-pipeline-materialization.PROJECTOR.1
 * firegrid-event-pipeline-materialization.PROJECTOR.2
 * firegrid-event-pipeline-materialization.PROJECTOR.3
 */
export const RuntimeOutputSessionProjectorLive = Layer.succeed(
  EventProjector,
  EventProjector.of({
    name: "runtime-output-session",
    version: "1",
    project: event => {
      const decoded = decodeRuntimeEvent(event)
      if (Either.isLeft(decoded)) {
        return Effect.fail(eventProjectorError(
          "runtime-output-session-projector.decode",
          decoded.left,
        ))
      }
      return Effect.succeed(projectRuntimeOutputToSessionState(decoded.right))
    },
  }),
)

