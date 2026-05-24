// Pure runtime-ingress row decoder.
//
// Logical pipeline position: transforms/ (peer of producers, channels).
// Pure: no Effect, no Layer, no Context.Tag, no I/O. The function returns an
// `Either` so it is callable in a unit test with no Effect environment
// (docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7). Callers that need an Effect wrap with
// `Effect.fromEither`.
//
// Moved here from `workflow-engine/workflows/runtime-ingress-transform.ts`
// under the Shape C cutover physical target tree
// (docs/architecture/2026-05-22-runtime-physical-target-tree.md). The old
// path retains a thin Effect-form re-export shim until callers migrate.

import {
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  AgentInputEventSchema,
  AgentPromptSchema,
  AgentToolResultPartSchema,
  agentPromptTextPart,
  agentUserPromptMessage,
  type AgentInputEvent,
} from "../events/agent-input.ts"
import { Either, Schema } from "effect"

export class RuntimeIngressAgentInputTransformError extends Schema.TaggedError<
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
): Either.Either<
  Extract<AgentInputEvent, { readonly _tag: "Prompt" }>,
  RuntimeIngressAgentInputTransformError
> => {
  const text = Schema.decodeUnknownEither(RuntimePromptTextPayloadSchema)(row.payload)
  if (Either.isRight(text)) {
    return Either.right({
      _tag: "Prompt",
      correlationId: row.inputId,
      prompt: agentUserPromptMessage({
        content: [agentPromptTextPart({ text: textFromIngressPayload(text.right) })],
      }),
    })
  }
  return Either.mapBoth(
    Schema.decodeUnknownEither(AgentPromptSchema)(row.payload),
    {
      onLeft: cause =>
        transformError(
          row,
          "runtime message ingress payload is not an AgentInputEvent, text payload, or AgentPrompt (UserMessage)",
          cause,
        ),
      onRight: prompt => ({
        _tag: "Prompt" as const,
        correlationId: row.inputId,
        prompt,
      }),
    },
  )
}

export const agentInputEventFromRuntimeIngressRow = (
  row: RuntimeIngressInputRow,
): Either.Either<AgentInputEvent, RuntimeIngressAgentInputTransformError> => {
  const decoded = Schema.decodeUnknownEither(AgentInputEventSchema)(row.payload)
  if (Either.isRight(decoded)) return Either.right(decoded.right)

  if (row.kind === "message") return promptFromIngressPayload(row)

  if (row.kind === "tool_result") {
    return Either.mapBoth(
      Schema.decodeUnknownEither(AgentToolResultPartSchema)(row.payload),
      {
        onLeft: cause =>
          transformError(
            row,
            "runtime tool_result ingress payload is not an AgentInputEvent or AgentToolResultPart",
            cause,
          ),
        onRight: part => ({ _tag: "ToolResult" as const, part }),
      },
    )
  }

  return Either.left(transformError(
    row,
    `runtime ${row.kind} ingress payload is not an AgentInputEvent`,
    decoded.left,
  ))
}
