import { Prompt } from "@effect/ai"
import {
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
} from "../../agent-event-pipeline/events/index.ts"
import { Effect, Either, Schema } from "effect"

class RuntimeIngressAgentInputTransformError extends Schema.TaggedError<
  RuntimeIngressAgentInputTransformError
>()("RuntimeIngressAgentInputTransformError", {
  op: Schema.String,
  contextId: Schema.String,
  inputId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const transformError = (
  row: RuntimeIngressInputRow,
  message: string,
  cause?: unknown,
): RuntimeIngressAgentInputTransformError =>
  new RuntimeIngressAgentInputTransformError({
    op: "runtime-ingress.agent-input.decode",
    contextId: row.contextId,
    inputId: row.inputId,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const RuntimePromptTextPayloadSchema = Schema.Union(
  Schema.String,
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ text: Schema.String }),
  Schema.Array(Schema.Union(
    Schema.String,
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ text: Schema.String }),
  )),
)

type RuntimePromptTextPayload = Schema.Schema.Type<
  typeof RuntimePromptTextPayloadSchema
>

const textFromIngressPayload = (
  payload: RuntimePromptTextPayload,
): string => {
  if (typeof payload === "string") return payload
  if (Array.isArray(payload)) return payload.map(textFromIngressPayload).join("\n")
  return (payload as { readonly text: string }).text
}

const promptFromIngressPayload = (
  row: RuntimeIngressInputRow,
): Effect.Effect<Extract<AgentInputEvent, { readonly _tag: "Prompt" }>, RuntimeIngressAgentInputTransformError> => {
  const text = Schema.decodeUnknownEither(RuntimePromptTextPayloadSchema)(row.payload)
  if (Either.isRight(text)) {
    return Effect.succeed({
      _tag: "Prompt",
      correlationId: row.inputId,
      prompt: Prompt.userMessage({
        content: [Prompt.textPart({ text: textFromIngressPayload(text.right) })],
      }),
    })
  }
  return Schema.decodeUnknown(Prompt.UserMessage)(row.payload).pipe(
    Effect.map(prompt => ({
      _tag: "Prompt" as const,
      correlationId: row.inputId,
      prompt,
    })),
    Effect.mapError(cause =>
      transformError(
        row,
        "runtime message ingress payload is not an AgentInputEvent, text payload, or Prompt.UserMessage",
        cause,
      )),
  )
}

export const agentInputEventFromRuntimeIngressRow = (
  row: RuntimeIngressInputRow,
): Effect.Effect<AgentInputEvent, RuntimeIngressAgentInputTransformError> => {
  const decoded = Schema.decodeUnknownEither(AgentInputEventSchema)(row.payload)
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right)

  if (row.kind === "message") return promptFromIngressPayload(row)

  if (row.kind === "tool_result") {
    return Schema.decodeUnknown(Prompt.ToolResultPart)(row.payload).pipe(
      Effect.map(part => ({ _tag: "ToolResult" as const, part })),
      Effect.mapError(cause =>
        transformError(
          row,
          "runtime tool_result ingress payload is not an AgentInputEvent or Prompt.ToolResultPart",
          cause,
        )),
    )
  }

  return Effect.fail(transformError(
    row,
    `runtime ${row.kind} ingress payload is not an AgentInputEvent`,
    decoded.left,
  ))
}
