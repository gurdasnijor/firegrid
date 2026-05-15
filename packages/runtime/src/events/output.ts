import type { RuntimeEventRow } from "@firegrid/protocol/launch"
import { Either, Option, Schema } from "effect"
import { AgentOutputEventSchema, type AgentOutputEvent } from "../agent-io/index.ts"

export const RuntimeAgentOutputEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("firegrid.agent-output"),
  event: AgentOutputEventSchema,
})
export type RuntimeAgentOutputEnvelope = Schema.Schema.Type<
  typeof RuntimeAgentOutputEnvelopeSchema
>

export interface RuntimeAgentOutputObservation {
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly _tag: AgentOutputEvent["_tag"]
  readonly event: AgentOutputEvent
  readonly permissionRequestId?: string
  readonly toolUseId?: string
  readonly toolName?: string
}

export const encodeRuntimeAgentOutputEnvelope = (
  event: AgentOutputEvent,
): string =>
  JSON.stringify(Schema.encodeUnknownSync(RuntimeAgentOutputEnvelopeSchema)({
    type: "firegrid.agent-output",
    event,
  }))

export const decodeRuntimeAgentOutputEnvelope = (
  raw: string,
): Option.Option<AgentOutputEvent> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Option.none()
  }
  const decoded = Schema.decodeUnknownEither(RuntimeAgentOutputEnvelopeSchema)(parsed)
  return Either.isRight(decoded) ? Option.some(decoded.right.event) : Option.none()
}

export const runtimeAgentOutputObservationFromRow = (
  row: RuntimeEventRow,
): Option.Option<RuntimeAgentOutputObservation> =>
  Option.map(decodeRuntimeAgentOutputEnvelope(row.raw), (event) => {
    const base = {
      contextId: row.contextId,
      activityAttempt: row.activityAttempt,
      sequence: row.sequence,
      _tag: event._tag,
      event,
    } satisfies Omit<
      RuntimeAgentOutputObservation,
      "permissionRequestId" | "toolUseId" | "toolName"
    >
    if (event._tag === "PermissionRequest") {
      return {
        ...base,
        permissionRequestId: event.permissionRequestId,
        toolUseId: event.toolUseId,
      }
    }
    if (event._tag === "ToolUse") {
      return {
        ...base,
        toolUseId: event.part.id,
        toolName: event.part.name,
      }
    }
    return base
  })
