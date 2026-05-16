import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Option, Stream } from "effect"
import {
  RuntimeAgentOutputEvents,
  RuntimeIngressAppendAndGet,
} from "../authorities/index.ts"
import {
  type RuntimeAgentOutputObservation,
  type AgentToolUseMode,
  runtimeIdempotencyKey,
} from "../events/index.ts"
import { toolUseToEffect } from "../agent-tools/tool-use-to-effect.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../host/errors.ts"

const toolResultInputId = (
  contextId: string,
  activityAttempt: number,
  toolUseId: string,
): string => `agent-tool-result:${contextId}:${activityAttempt}:${toolUseId}:result`

const toolResultIdempotencyKey = (
  contextId: string,
  activityAttempt: number,
  toolUseId: string,
) => runtimeIdempotencyKey(`agent-tool-result:${contextId}:${activityAttempt}:${toolUseId}`)

const toolUseObservations = (options: {
  readonly source: Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly context: RuntimeContext
  readonly activityAttempt: number
}): Stream.Stream<RuntimeAgentOutputObservation, RuntimeContextError> =>
  options.source.pipe(
    Stream.filter(observation =>
      observation.contextId === options.context.contextId &&
      observation.activityAttempt === options.activityAttempt &&
      observation._tag === "ToolUse" &&
      observation.event._tag === "ToolUse",
    ),
    Stream.mapError(cause =>
      asRuntimeContextError(
        "runtime-output.tool-router.subscribe",
        "failed to subscribe to agent output observations",
        options.context.contextId,
        cause,
      )),
  )

export const runToolRouter = (options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly toolUseMode: AgentToolUseMode
}) => {
  if (options.toolUseMode !== "client_result_roundtrip") {
    return Effect.never
  }

  return Effect.gen(function* () {
    const outputEvents = yield* RuntimeAgentOutputEvents
    const appendIngress = yield* RuntimeIngressAppendAndGet

    return yield* toolUseObservations({
      ...options,
      source: outputEvents,
    }).pipe(
      Stream.mapEffect(observation =>
        Effect.gen(function* () {
          if (observation.event._tag !== "ToolUse") return
          const inputId = toolResultInputId(
            options.context.contextId,
            options.activityAttempt,
            observation.event.part.id,
          )
          const existing = yield* appendIngress.findInput(inputId).pipe(
            mapRuntimeContextError(
              "agent-tool-router.result.get",
              "failed to check existing tool result ingress row",
              options.context.contextId,
            ),
          )
          if (Option.isSome(existing)) return

          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1
          // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.2
          // firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1
          const result = yield* toolUseToEffect(
            { contextId: options.context.contextId },
            observation.event,
          )
          yield* appendIngress.append({
            inputId,
            contextId: options.context.contextId,
            kind: "tool_result",
            authoredBy: "tool",
            payload: result,
            idempotencyKey: toolResultIdempotencyKey(
              options.context.contextId,
              options.activityAttempt,
              observation.event.part.id,
            ),
            metadata: {
              activityAttempt: String(options.activityAttempt),
              toolUseId: observation.event.part.id,
              toolName: observation.event.part.name,
            },
          }).pipe(
            mapRuntimeContextError(
              "agent-tool-router.result.append",
              "failed to append agent tool result ingress row",
              options.context.contextId,
            ),
          )
        })),
      Stream.runDrain,
    )
  })
}
