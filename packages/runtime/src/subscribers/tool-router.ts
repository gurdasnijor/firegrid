import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Option, Stream } from "effect"
import type { RuntimeIngressAuthorityService } from "../authorities/index.ts"
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
import type { SourceCollectionHandle } from "../waits/index.ts"

type ToolResultIngressAuthority = Pick<
  RuntimeIngressAuthorityService["write"],
  "append" | "findInput"
>

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

const isRuntimeAgentOutputObservation = (
  value: unknown,
): value is RuntimeAgentOutputObservation => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.contextId === "string" &&
    typeof record.activityAttempt === "number" &&
    typeof record.sequence === "number" &&
    typeof record._tag === "string" &&
    typeof record.event === "object" &&
    record.event !== null
}

const toolUseObservations = (options: {
  readonly source: SourceCollectionHandle
  readonly context: RuntimeContext
  readonly activityAttempt: number
}): Stream.Stream<RuntimeAgentOutputObservation, RuntimeContextError> =>
  options.source.subscribe().pipe(
    Stream.filterMap(value =>
      isRuntimeAgentOutputObservation(value)
        ? Option.some(value)
        : Option.none(),
    ),
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
  readonly source: SourceCollectionHandle
  readonly ingressAuthority: ToolResultIngressAuthority
}): Effect.Effect<void, RuntimeContextError, unknown> => {
  if (options.toolUseMode !== "client_result_roundtrip") {
    return Effect.never
  }

  return toolUseObservations(options).pipe(
    Stream.mapEffect(observation =>
      Effect.gen(function* () {
        if (observation.event._tag !== "ToolUse") return
        const inputId = toolResultInputId(
          options.context.contextId,
          options.activityAttempt,
          observation.event.part.id,
        )
        const existing = yield* options.ingressAuthority.findInput(inputId).pipe(
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
        yield* options.ingressAuthority.append({
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
}
