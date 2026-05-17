import {
  Activity,
  Workflow,
} from "@effect/workflow"
import type {
  RuntimeAgentProtocol,
  RuntimeContext,
} from "@firegrid/protocol/launch"
import type { RuntimeIngressRequest } from "@firegrid/protocol/runtime-ingress"
import {
  Context,
  Effect,
  Layer,
  Schema,
} from "effect"
import { WaitFor } from "@firegrid/runtime/durable-tools"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import {
  RuntimeToolUseExecutor,
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
} from "@firegrid/runtime/host-substrate"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import {
  RuntimeExitEvidence,
  type StartRuntimeResult,
  RuntimeContextWorkflowPayload,
  RuntimeContextWorkflowName,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunStarted,
} from "./internal/runtime-context-workflow-run.ts"
import { RuntimeHostConfig } from "./config.ts"
import { appendRuntimeIngressToOwner } from "./internal/runtime-ingress-owner.ts"
import { runRuntimeContext } from "./raw-process-runtime.ts"

const RuntimeContextWorkflowSessionStart = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Started"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Exited"),
    exit: RuntimeExitEvidence,
  }),
)

type RuntimeContextWorkflowSessionStart = Schema.Schema.Type<typeof RuntimeContextWorkflowSessionStart>

interface RuntimeContextWorkflowSessionService {
  readonly start: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextWorkflowSessionStart, RuntimeContextError, unknown>
  readonly send: (
    context: RuntimeContext,
    activityAttempt: number,
    event: AgentInputEvent,
  ) => Effect.Effect<void, RuntimeContextError, unknown>
}

export class RuntimeContextWorkflowSession extends Context.Tag(
  "@firegrid/runtime/RuntimeContextWorkflowSession",
)<RuntimeContextWorkflowSession, RuntimeContextWorkflowSessionService>() {
  static layer = (
    service: RuntimeContextWorkflowSessionService,
  ): Layer.Layer<RuntimeContextWorkflowSession> => Layer.succeed(this, service)
}

const startSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: `firegrid.runtime-context.session.start.${context.contextId}.${activityAttempt}`,
    success: RuntimeContextWorkflowSessionStart,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      return yield* session.start(context, activityAttempt)
    }),
  })

const sendSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
  event: AgentInputEvent,
  name: string,
) =>
  Activity.make({
    name,
    success: Schema.Void,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      yield* session.send(context, activityAttempt, event)
    }),
  })

const outputWaitName = (
  contextId: string,
  activityAttempt: number,
  afterSequence: number,
) => `runtime-context/${contextId}/output-after/${activityAttempt}/${afterSequence}`

const waitForAgentOutput = (
  context: RuntimeContext,
  activityAttempt: number,
  afterSequence: number,
) =>
  WaitFor.match<RuntimeAgentOutputObservation>({
    name: outputWaitName(context.contextId, activityAttempt, afterSequence),
    source: {
      _tag: "AgentOutputAfter",
      contextId: context.contextId,
      activityAttempt,
      afterSequence,
    },
    trigger: [],
  })

const runToolUseActivity = (
  context: RuntimeContext,
  event: Extract<AgentOutputEvent, { readonly _tag: "ToolUse" }>,
) =>
  Activity.make({
    name: `firegrid.runtime-context.tool.${event.part.id}`,
    success: AgentInputEventSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const executor = yield* RuntimeToolUseExecutor
      return yield* executor.execute({ contextId: context.contextId }, event)
    }),
  })

const handleAgentOutput = (
  context: RuntimeContext,
  activityAttempt: number,
  observation: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    const event = observation.event
    if (event._tag === "ToolUse" && toolUseModeForContext(context) === "client_result_roundtrip") {
      const result = yield* runToolUseActivity(context, event)
      yield* sendSessionActivity(
        context,
        activityAttempt,
        result,
        `firegrid.runtime-context.session.send.tool-result.${event.part.id}`,
      )
      return undefined
    }
    if (event._tag === "Terminated") {
      return {
        exitCode: event.exitCode ?? 0,
      }
    }
    return undefined
  })

const agentProtocolForContext = (
  context: RuntimeContext,
): RuntimeAgentProtocol => context.runtime.config.agentProtocol ?? "raw"

const toolUseModeForContext = (
  context: RuntimeContext,
) =>
  agentProtocolForContext(context) === "acp"
    ? "observation_only"
    : "client_result_roundtrip"

const runReactiveLoop = (
  context: RuntimeContext,
  activityAttempt: number,
) => {
  const loop = (
    lastOutputSequence: number,
  ): Effect.Effect<RuntimeExitEvidence, RuntimeContextError, unknown> =>
    Effect.gen(function*() {
      const output = yield* waitForAgentOutput(context, activityAttempt, lastOutputSequence).pipe(
        Effect.mapError(cause =>
          asRuntimeContextError(
            "runtime-context.output.wait",
            "failed waiting for runtime-context output",
            context.contextId,
            cause,
          )),
      )
      if (output._tag === "Timeout") {
        return yield* asRuntimeContextError(
          "runtime-context.wait.timeout",
          "runtime-context wait timed out unexpectedly",
          context.contextId,
        )
      }
      const exit = yield* handleAgentOutput(context, activityAttempt, output.row)
      if (exit !== undefined) return exit
      return yield* loop(output.row.sequence)
    })
  return loop(-1)
}

const runWorkflowNativeRuntimeContext = (
  contextId: string,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const start = yield* startSessionActivity(context, activityAttempt).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    const exit = start._tag === "Exited"
      ? start.exit
      : yield* runReactiveLoop(context, activityAttempt).pipe(
        Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
      )
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  })

export const RuntimeContextWorkflowNative = Workflow.make({
  name: RuntimeContextWorkflowName,
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
})

export const RuntimeContextWorkflowNativeLayer = RuntimeContextWorkflowNative.toLayer(({ contextId }) =>
  runWorkflowNativeRuntimeContext(contextId))

export { RuntimeContextWorkflowPayload }

const toolResultInputId = (
  contextId: string,
  activityAttempt: number,
  toolUseId: string,
): string => `agent-tool-result:${contextId}:${activityAttempt}:${toolUseId}:result`

const sessionInputId = (
  contextId: string,
  activityAttempt: number,
  event: AgentInputEvent,
): string | undefined => {
  if (event._tag === "ToolResult") {
    return toolResultInputId(contextId, activityAttempt, event.part.id)
  }
  return undefined
}

const sessionInputIdempotencyKey = (
  contextId: string,
  activityAttempt: number,
  event: AgentInputEvent,
): string => {
  if (event._tag === "Prompt") return `runtime-context-prompt:${contextId}:${event.correlationId}`
  if (event._tag === "ToolResult") return `agent-tool-result:${contextId}:${activityAttempt}:${event.part.id}`
  if (event._tag === "PermissionResponse") {
    return `runtime-context-permission:${contextId}:${event.permissionRequestId}`
  }
  return `runtime-context-control:${contextId}:${activityAttempt}:${event._tag}`
}

const ingressRequestForSessionEvent = (
  context: RuntimeContext,
  activityAttempt: number,
  event: AgentInputEvent,
): RuntimeIngressRequest => {
  const inputId = sessionInputId(context.contextId, activityAttempt, event)
  const base = {
    ...(inputId === undefined ? {} : { inputId }),
    contextId: context.contextId,
    idempotencyKey: sessionInputIdempotencyKey(context.contextId, activityAttempt, event),
  }
  if (event._tag === "Prompt") {
    return {
      ...base,
      kind: "message",
      authoredBy: "workflow",
      payload: event.prompt,
    }
  }
  if (event._tag === "ToolResult") {
    return {
      ...base,
      kind: "tool_result",
      authoredBy: "tool",
      payload: event.part,
      metadata: {
        activityAttempt: String(activityAttempt),
        toolUseId: event.part.id,
        toolName: event.part.name,
      },
    }
  }
  if (event._tag === "PermissionResponse") {
    return {
      ...base,
      kind: "required_action_result",
      authoredBy: "workflow",
      payload: event,
    }
  }
  return {
    ...base,
    kind: "control",
    authoredBy: "workflow",
    payload: event,
  }
}

export const RuntimeContextWorkflowSessionLive = Layer.effect(
  RuntimeContextWorkflowSession,
  Effect.gen(function*() {
    const hostConfig = yield* RuntimeHostConfig
    return RuntimeContextWorkflowSession.of({
      start: (context, activityAttempt) => {
        const run = runRuntimeContext(context, activityAttempt).pipe(
          Effect.map((exit): RuntimeExitEvidence => exit),
        )
        return run.pipe(
          Effect.map(exit => ({
            _tag: "Exited" as const,
            exit,
          })),
        )
      },
      send: (context, activityAttempt, event) =>
        appendRuntimeIngressToOwner(
          ingressRequestForSessionEvent(context, activityAttempt, event),
          context,
          hostConfig,
        ).pipe(
          mapRuntimeContextError(
            "runtime-context.session.send",
            "failed to append runtime-context session input",
            context.contextId,
          ),
          Effect.asVoid,
        ),
    })
  }),
)
