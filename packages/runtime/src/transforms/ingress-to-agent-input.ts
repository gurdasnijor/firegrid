import { Prompt } from "@effect/ai"
import {
  type RuntimeIngressDeliveryRow,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Either, Schema, Stream } from "effect"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
  type RuntimeTransform,
} from "../events/index.ts"
import {
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../host/errors.ts"

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

const textFromIngressPayload = (payload: unknown): string | undefined => {
  if (typeof payload === "string") return payload
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return record.type === "text" && typeof record.text === "string"
    ? record.text
    : undefined
}

const promptFromIngressPayload = (
  row: RuntimeIngressInputRow,
): Effect.Effect<Extract<AgentInputEvent, { readonly _tag: "Prompt" }>, RuntimeIngressAgentInputTransformError> => {
  const text = textFromIngressPayload(row.payload)
  if (text !== undefined) {
    return Effect.succeed({
      _tag: "Prompt",
      correlationId: row.inputId,
      prompt: Prompt.userMessage({
        content: [Prompt.textPart({ text })],
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

const agentInputEventFromRuntimeIngressRow = (
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

interface ClaimedRuntimeIngressRow {
  readonly row: RuntimeIngressInputRow
  readonly delivery: RuntimeIngressDeliveryRow
}

interface ClaimedAgentInputEvent {
  readonly input: AgentInputEvent
  readonly delivery: RuntimeIngressDeliveryRow
}

interface SequencedIngressOrderState {
  readonly nextSequence: number
  readonly pending: Map<number, RuntimeIngressInputRow>
}

export const orderSequencedRuntimeIngressRows = <Error, Requirements>(
  rows: Stream.Stream<RuntimeIngressInputRow, Error, Requirements>,
): Stream.Stream<RuntimeIngressInputRow, Error, Requirements> =>
  rows.pipe(
    Stream.mapAccum<SequencedIngressOrderState, RuntimeIngressInputRow, ReadonlyArray<RuntimeIngressInputRow>>(
      {
        nextSequence: 0,
        pending: new Map<number, RuntimeIngressInputRow>(),
      },
      (state, row) => {
        const ordered: Array<RuntimeIngressInputRow> = []
        if (row.sequence === undefined) {
          return [state, ordered] as const
        }
        const pending = new Map(state.pending)
        pending.set(row.sequence, row)
        let nextSequence = state.nextSequence
        while (true) {
          const next = pending.get(nextSequence)
          if (next === undefined) break
          pending.delete(nextSequence)
          ordered.push(next)
          nextSequence += 1
        }
        return [{ nextSequence, pending }, ordered] as const
      },
    ),
    Stream.flatMap(rows => Stream.fromIterable(rows)),
  )

export const runtimeIngressRowsToAgentInputEvents = (
  contextId: string,
): RuntimeTransform<ClaimedRuntimeIngressRow, ClaimedAgentInputEvent, RuntimeContextError> =>
  rows =>
    rows.pipe(
      Stream.mapEffect(({ row, delivery }) =>
        agentInputEventFromRuntimeIngressRow(row).pipe(
          mapRuntimeContextError(
            "runtime-ingress.codec.decode",
            "failed to decode runtime ingress row for agent codec",
            contextId,
          ),
          Effect.map(input => ({ input, delivery })),
        )),
    )
