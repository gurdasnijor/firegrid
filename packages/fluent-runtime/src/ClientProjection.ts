import type { StreamEnvelope } from "./Adapter.ts"

export type FluentNormalizedEvent =
  | {
    readonly _tag: "SessionInit"
    readonly rawIndex: number
    readonly direction: StreamEnvelope["direction"]
    readonly status: "started" | "resumed"
    readonly resumeId?: string
  }
  | {
    readonly _tag: "UserMessage"
    readonly rawIndex: number
    readonly messageId: string
    readonly text: string
  }
  | {
    readonly _tag: "AssistantMessage"
    readonly rawIndex: number
    readonly messageId: string
    readonly text: string
  }
  | {
    readonly _tag: "StreamDelta"
    readonly rawIndex: number
    readonly messageId: string
    readonly delta: string
  }
  | {
    readonly _tag: "ToolCall"
    readonly rawIndex: number
    readonly toolCallId: string
    readonly name: string
    readonly input: unknown
  }
  | {
    readonly _tag: "ToolResult"
    readonly rawIndex: number
    readonly toolCallId: string
    readonly output: unknown
    readonly isError: boolean
  }
  | {
    readonly _tag: "PermissionRequest"
    readonly rawIndex: number
    readonly requestId: string
    readonly toolCallId?: string
    readonly prompt?: string
    readonly payload: unknown
  }
  | {
    readonly _tag: "ApprovalResponse"
    readonly rawIndex: number
    readonly requestId: string
    readonly subtype: "success" | "cancelled"
    readonly response: unknown
  }
  | {
    readonly _tag: "TurnCompleted"
    readonly rawIndex: number
    readonly result?: unknown
  }
  | {
    readonly _tag: "ToolProgress"
    readonly rawIndex: number
    readonly toolCallId: string
    readonly status: string
    readonly message?: string
  }
  | {
    readonly _tag: "StatusChange"
    readonly rawIndex: number
    readonly status: string
    readonly detail?: unknown
  }
  | {
    readonly _tag: "Unknown"
    readonly rawIndex: number
    readonly direction: StreamEnvelope["direction"]
    readonly raw: unknown
  }

export interface ClientProjectionSession {
  readonly sessionId: string
  readonly status: "new" | "started" | "resumed" | "ended"
  readonly rawIndexes: ReadonlyArray<number>
}

export interface ClientProjectionParticipant {
  readonly participantId: "user" | "assistant" | "bridge"
  readonly kind: "user" | "assistant" | "bridge"
}

export interface ClientProjectionMessage {
  readonly messageId: string
  readonly role: "user" | "assistant"
  readonly text: string
  readonly rawIndexes: ReadonlyArray<number>
}

export interface ClientProjectionTurn {
  readonly turnId: string
  readonly status: "running" | "completed"
  readonly rawIndexes: ReadonlyArray<number>
}

export interface ClientProjectionToolCall {
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
  readonly status: "pending" | "completed" | "error"
  readonly result?: unknown
  readonly progress: ReadonlyArray<{
    readonly status: string
    readonly message?: string
    readonly rawIndex: number
  }>
  readonly rawIndexes: ReadonlyArray<number>
}

export interface ClientProjectionPermissionRequest {
  readonly requestId: string
  readonly status: "pending" | "resolved" | "cancelled"
  readonly toolCallId?: string
  readonly prompt?: string
  readonly response?: unknown
  readonly rawIndexes: ReadonlyArray<number>
}

export interface ClientProjectionApprovalResponse {
  readonly requestId: string
  readonly subtype: "success" | "cancelled"
  readonly response: unknown
  readonly rawIndex: number
}

export interface FluentClientReadModels {
  readonly sessions: ReadonlyArray<ClientProjectionSession>
  readonly participants: ReadonlyArray<ClientProjectionParticipant>
  readonly messages: ReadonlyArray<ClientProjectionMessage>
  readonly turns: ReadonlyArray<ClientProjectionTurn>
  readonly toolCalls: ReadonlyArray<ClientProjectionToolCall>
  readonly permissionRequests: ReadonlyArray<ClientProjectionPermissionRequest>
  readonly approvalResponses: ReadonlyArray<ClientProjectionApprovalResponse>
  readonly unknownEvents: ReadonlyArray<Extract<FluentNormalizedEvent, { readonly _tag: "Unknown" }>>
}

export interface FluentClientProjection {
  readonly normalized: ReadonlyArray<FluentNormalizedEvent>
  readonly readModels: FluentClientReadModels
}

export type AgentEventNormalizer = (
  envelope: StreamEnvelope,
  rawIndex: number,
) => ReadonlyArray<FluentNormalizedEvent>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const stringField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field]
  return typeof value === "string" ? value : undefined
}

const booleanField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): boolean | undefined => {
  const value = record[field]
  return typeof value === "boolean" ? value : undefined
}

const stringOrNumberField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field]
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

const unknownEvent = (
  envelope: StreamEnvelope,
  rawIndex: number,
): FluentNormalizedEvent => ({
  _tag: "Unknown",
  rawIndex,
  direction: envelope.direction,
  raw: envelope.raw,
})

export const defaultAgentEventNormalizer: AgentEventNormalizer = (
  envelope,
  rawIndex,
) => {
  if (!isRecord(envelope.raw)) return [unknownEvent(envelope, rawIndex)]
  const type = stringField(envelope.raw, "type")

  if (envelope.direction === "bridge") {
    if (type === "session_started") {
      return [{ _tag: "SessionInit", rawIndex, direction: "bridge", status: "started" }]
    }
    if (type === "session_resumed") {
      const resumeId = stringField(envelope.raw, "resumeId")
      return [{
        _tag: "SessionInit",
        rawIndex,
        direction: "bridge",
        status: "resumed",
        ...(resumeId === undefined ? {} : { resumeId }),
      }]
    }
    if (type === "session_ended" || type === "resume_fallback") {
      return [{
        _tag: "StatusChange",
        rawIndex,
        status: type,
        detail: envelope.raw,
      }]
    }
    return [unknownEvent(envelope, rawIndex)]
  }

  if (envelope.direction === "user") {
    if (type === "user_message") {
      return [{
        _tag: "UserMessage",
        rawIndex,
        messageId: stringField(envelope.raw, "messageId") ?? `user:${rawIndex}`,
        text: stringField(envelope.raw, "text") ?? "",
      }]
    }
    if (type === "control_response" && isRecord(envelope.raw.response)) {
      const response = envelope.raw.response
      const requestId = stringOrNumberField(response, "request_id")
      const subtype = stringField(response, "subtype")
      if (requestId !== undefined && (subtype === "success" || subtype === "cancelled")) {
        return [{
          _tag: "ApprovalResponse",
          rawIndex,
          requestId,
          subtype,
          response: response.response,
        }]
      }
    }
    return [unknownEvent(envelope, rawIndex)]
  }

  if (type === "assistant_message" || type === "assistant") {
    return [{
      _tag: "AssistantMessage",
      rawIndex,
      messageId: stringField(envelope.raw, "messageId") ?? `assistant:${rawIndex}`,
      text: stringField(envelope.raw, "text") ?? "",
    }]
  }
  if (type === "text_delta") {
    return [{
      _tag: "StreamDelta",
      rawIndex,
      messageId: stringField(envelope.raw, "messageId") ?? "assistant:stream",
      delta: stringField(envelope.raw, "delta") ?? "",
    }]
  }
  if (type === "tool_call") {
    return [{
      _tag: "ToolCall",
      rawIndex,
      toolCallId: stringField(envelope.raw, "toolCallId") ?? stringField(envelope.raw, "tool_call_id") ?? `tool:${rawIndex}`,
      name: stringField(envelope.raw, "name") ?? "unknown",
      input: envelope.raw.input,
    }]
  }
  if (type === "tool_result") {
    return [{
      _tag: "ToolResult",
      rawIndex,
      toolCallId: stringField(envelope.raw, "toolCallId") ?? stringField(envelope.raw, "tool_call_id") ?? `tool:${rawIndex}`,
      output: envelope.raw.output,
      isError: booleanField(envelope.raw, "isError") ?? false,
    }]
  }
  if (type === "permission_request") {
    const toolCallId = stringField(envelope.raw, "toolCallId") ?? stringField(envelope.raw, "tool_call_id")
    const prompt = stringField(envelope.raw, "prompt")
    return [{
      _tag: "PermissionRequest",
      rawIndex,
      requestId: stringOrNumberField(envelope.raw, "requestId") ?? stringOrNumberField(envelope.raw, "id") ?? `request:${rawIndex}`,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(prompt === undefined ? {} : { prompt }),
      payload: envelope.raw,
    }]
  }
  if (type === "turn_complete") {
    return [{
      _tag: "TurnCompleted",
      rawIndex,
      ...(envelope.raw.result === undefined ? {} : { result: envelope.raw.result }),
    }]
  }
  if (type === "tool_progress") {
    const message = stringField(envelope.raw, "message")
    return [{
      _tag: "ToolProgress",
      rawIndex,
      toolCallId: stringField(envelope.raw, "toolCallId") ?? stringField(envelope.raw, "tool_call_id") ?? `tool:${rawIndex}`,
      status: stringField(envelope.raw, "status") ?? "progress",
      ...(message === undefined ? {} : { message }),
    }]
  }
  if (type === "status") {
    return [{
      _tag: "StatusChange",
      rawIndex,
      status: stringField(envelope.raw, "status") ?? "unknown",
      detail: envelope.raw,
    }]
  }

  return [unknownEvent(envelope, rawIndex)]
}

export const normalizeRawAgentHistory = (
  history: ReadonlyArray<StreamEnvelope>,
  normalizer: AgentEventNormalizer = defaultAgentEventNormalizer,
): ReadonlyArray<FluentNormalizedEvent> => {
  const normalized: Array<FluentNormalizedEvent> = []
  for (let index = 0; index < history.length; index += 1) {
    const envelope = history[index]
    if (envelope === undefined) continue
    normalized.push(...normalizer(envelope, index))
  }
  return normalized
}

const ensureParticipant = (
  participants: Array<ClientProjectionParticipant>,
  participantId: ClientProjectionParticipant["participantId"],
): void => {
  if (participants.some((participant) => participant.participantId === participantId)) return
  participants.push({ participantId, kind: participantId })
}

const upsertMessage = (
  messages: Array<ClientProjectionMessage>,
  input: {
    readonly messageId: string
    readonly role: "user" | "assistant"
    readonly text: string
    readonly rawIndex: number
    readonly append: boolean
  },
): void => {
  const existing = messages.find((message) => message.messageId === input.messageId)
  if (existing === undefined) {
    messages.push({
      messageId: input.messageId,
      role: input.role,
      text: input.text,
      rawIndexes: [input.rawIndex],
    })
    return
  }
  const replacement: ClientProjectionMessage = {
    ...existing,
    text: input.append ? `${existing.text}${input.text}` : input.text,
    rawIndexes: [...existing.rawIndexes, input.rawIndex],
  }
  const index = messages.findIndex((message) => message.messageId === input.messageId)
  if (index >= 0) messages[index] = replacement
}

const upsertToolCall = (
  toolCalls: Array<ClientProjectionToolCall>,
  toolCall: ClientProjectionToolCall,
): void => {
  const index = toolCalls.findIndex((candidate) => candidate.toolCallId === toolCall.toolCallId)
  if (index >= 0) {
    const current = toolCalls[index]!
    toolCalls[index] = {
      ...current,
      ...toolCall,
      name: toolCall.name === "unknown" ? current.name : toolCall.name,
      input: toolCall.input === undefined ? current.input : toolCall.input,
      rawIndexes: [...current.rawIndexes, ...toolCall.rawIndexes],
      progress: [...current.progress, ...toolCall.progress],
    }
    return
  }
  toolCalls.push(toolCall)
}

const upsertPermission = (
  permissions: Array<ClientProjectionPermissionRequest>,
  permission: ClientProjectionPermissionRequest,
): void => {
  const index = permissions.findIndex((candidate) => candidate.requestId === permission.requestId)
  if (index >= 0) {
    permissions[index] = {
      ...permissions[index]!,
      ...permission,
      rawIndexes: [...permissions[index]!.rawIndexes, ...permission.rawIndexes],
    }
    return
  }
  permissions.push(permission)
}

export const projectClientReadModels = (
  normalized: ReadonlyArray<FluentNormalizedEvent>,
): FluentClientReadModels => {
  const sessions: Array<ClientProjectionSession> = []
  const participants: Array<ClientProjectionParticipant> = []
  const messages: Array<ClientProjectionMessage> = []
  const turns: Array<ClientProjectionTurn> = []
  const toolCalls: Array<ClientProjectionToolCall> = []
  const permissionRequests: Array<ClientProjectionPermissionRequest> = []
  const approvalResponses: Array<ClientProjectionApprovalResponse> = []
  const unknownEvents: Array<Extract<FluentNormalizedEvent, { readonly _tag: "Unknown" }>> = []
  let currentTurnIndex = -1

  for (let index = 0; index < normalized.length; index += 1) {
    const event = normalized[index]
    if (event === undefined) continue

    if (event._tag === "SessionInit") {
      ensureParticipant(participants, "bridge")
      sessions[0] = {
        sessionId: "session",
        status: event.status,
        rawIndexes: [...(sessions[0]?.rawIndexes ?? []), event.rawIndex],
      }
      continue
    }
    if (event._tag === "UserMessage") {
      ensureParticipant(participants, "user")
      currentTurnIndex += 1
      turns.push({
        turnId: `turn-${currentTurnIndex}`,
        status: "running",
        rawIndexes: [event.rawIndex],
      })
      upsertMessage(messages, {
        messageId: event.messageId,
        role: "user",
        text: event.text,
        rawIndex: event.rawIndex,
        append: false,
      })
      continue
    }
    if (event._tag === "AssistantMessage") {
      ensureParticipant(participants, "assistant")
      upsertMessage(messages, {
        messageId: event.messageId,
        role: "assistant",
        text: event.text,
        rawIndex: event.rawIndex,
        append: false,
      })
      continue
    }
    if (event._tag === "StreamDelta") {
      ensureParticipant(participants, "assistant")
      upsertMessage(messages, {
        messageId: event.messageId,
        role: "assistant",
        text: event.delta,
        rawIndex: event.rawIndex,
        append: true,
      })
      continue
    }
    if (event._tag === "ToolCall") {
      upsertToolCall(toolCalls, {
        toolCallId: event.toolCallId,
        name: event.name,
        input: event.input,
        status: "pending",
        progress: [],
        rawIndexes: [event.rawIndex],
      })
      continue
    }
    if (event._tag === "ToolResult") {
      upsertToolCall(toolCalls, {
        toolCallId: event.toolCallId,
        name: "unknown",
        input: undefined,
        status: event.isError ? "error" : "completed",
        result: event.output,
        progress: [],
        rawIndexes: [event.rawIndex],
      })
      continue
    }
    if (event._tag === "ToolProgress") {
      upsertToolCall(toolCalls, {
        toolCallId: event.toolCallId,
        name: "unknown",
        input: undefined,
        status: "pending",
        progress: [{
          status: event.status,
          ...(event.message === undefined ? {} : { message: event.message }),
          rawIndex: event.rawIndex,
        }],
        rawIndexes: [event.rawIndex],
      })
      continue
    }
    if (event._tag === "PermissionRequest") {
      upsertPermission(permissionRequests, {
        requestId: event.requestId,
        status: "pending",
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
        rawIndexes: [event.rawIndex],
      })
      continue
    }
    if (event._tag === "ApprovalResponse") {
      approvalResponses.push({
        requestId: event.requestId,
        subtype: event.subtype,
        response: event.response,
        rawIndex: event.rawIndex,
      })
      upsertPermission(permissionRequests, {
        requestId: event.requestId,
        status: event.subtype === "cancelled" ? "cancelled" : "resolved",
        response: event.response,
        rawIndexes: [event.rawIndex],
      })
      continue
    }
    if (event._tag === "TurnCompleted") {
      const current = turns.at(-1)
      if (current !== undefined) {
        turns[turns.length - 1] = {
          ...current,
          status: "completed",
          rawIndexes: [...current.rawIndexes, event.rawIndex],
        }
      } else {
        turns.push({
          turnId: "turn-0",
          status: "completed",
          rawIndexes: [event.rawIndex],
        })
      }
      continue
    }
    if (event._tag === "StatusChange") {
      ensureParticipant(participants, "bridge")
      const status = event.status === "session_ended" ? "ended" : (sessions[0]?.status ?? "new")
      sessions[0] = {
        sessionId: "session",
        status,
        rawIndexes: [...(sessions[0]?.rawIndexes ?? []), event.rawIndex],
      }
      continue
    }
    unknownEvents.push(event)
  }

  return {
    sessions,
    participants,
    messages,
    turns,
    toolCalls,
    permissionRequests,
    approvalResponses,
    unknownEvents,
  }
}

export const projectRawAgentHistory = (
  history: ReadonlyArray<StreamEnvelope>,
  normalizer: AgentEventNormalizer = defaultAgentEventNormalizer,
): FluentClientProjection => {
  const normalized = normalizeRawAgentHistory(history, normalizer)
  return {
    normalized,
    readModels: projectClientReadModels(normalized),
  }
}
