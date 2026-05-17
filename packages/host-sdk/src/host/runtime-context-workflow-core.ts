import {
  Activity,
  DurableDeferred,
  Workflow,
} from "@effect/workflow"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  Context,
  Effect,
  Layer,
  Schema,
} from "effect"
import { WaitFor } from "@firegrid/runtime/durable-tools"
import {
  AgentInputEventSchema,
  PermissionDecisionSchema,
  type AgentInputEvent,
  type AgentOutputEvent,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import {
  RuntimeToolUseExecutor,
  RuntimeContextError,
  asRuntimeContextError,
} from "@firegrid/runtime/host-substrate"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import {
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  RuntimeContextWorkflowName,
  RuntimeContextWorkflowPayload,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunStarted,
} from "./internal/runtime-context-workflow-run.ts"
import {
  RuntimeContextSupervisor,
  type RuntimeContextSupervisorCommand,
} from "./runtime-context-supervisor.ts"

const RuntimeContextSupervisorStartedEvidenceSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  supervisorSessionId: Schema.String,
  startCommandId: Schema.String,
})

const RuntimeContextSupervisorCommandAcceptedSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  supervisorSessionId: Schema.String,
  commandId: Schema.String,
})

interface RuntimeContextWorkflowSessionService {
  readonly startOrAttach: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof RuntimeContextSupervisorStartedEvidenceSchema>,
    RuntimeContextError
  >
  readonly send: (
    context: RuntimeContext,
    activityAttempt: number,
    command: RuntimeContextSupervisorCommand,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof RuntimeContextSupervisorCommandAcceptedSchema>,
    RuntimeContextError
  >
}

export class RuntimeContextWorkflowSession extends Context.Tag(
  "@firegrid/runtime/RuntimeContextWorkflowSession",
)<RuntimeContextWorkflowSession, RuntimeContextWorkflowSessionService>() {
  static layer = (
    service: RuntimeContextWorkflowSessionService,
  ): Layer.Layer<RuntimeContextWorkflowSession> => Layer.succeed(this, service)
}

const startOrAttachSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: `firegrid.runtime-context.session.start-or-attach.${context.contextId}.${activityAttempt}`,
    success: RuntimeContextSupervisorStartedEvidenceSchema,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      return yield* session.startOrAttach(context, activityAttempt)
    }),
  })

const sendSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
  command: RuntimeContextSupervisorCommand,
) =>
  Activity.make({
    name: `firegrid.runtime-context.session.send.${command.commandId}`,
    success: RuntimeContextSupervisorCommandAcceptedSchema,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      return yield* session.send(context, activityAttempt, command)
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

const toolCommandId = (
  context: RuntimeContext,
  activityAttempt: number,
  toolUseId: string,
) => `tool-${context.contextId}-${activityAttempt}-${toolUseId}`

const permissionDeferred = (
  permissionRequestId: string,
) => DurableDeferred.make(`permission-${permissionRequestId}`, {
  success: PermissionDecisionSchema,
})

const handleAgentOutput = (
  context: RuntimeContext,
  activityAttempt: number,
  observation: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    const event = observation.event
    if (event._tag === "ToolUse") {
      const result = yield* runToolUseActivity(context, event)
      yield* sendSessionActivity(
        context,
        activityAttempt,
        {
          commandId: toolCommandId(context, activityAttempt, event.part.id),
          event: result,
        },
      )
      return undefined
    }
    if (event._tag === "PermissionRequest") {
      const decision = yield* DurableDeferred.await(permissionDeferred(event.permissionRequestId))
      yield* sendSessionActivity(context, activityAttempt, {
        commandId: `permission-${event.permissionRequestId}`,
        event: {
          _tag: "PermissionResponse",
          permissionRequestId: event.permissionRequestId,
          decision,
        },
      })
      return undefined
    }
    if (event._tag === "Terminated") {
      return {
        exitCode: event.exitCode ?? 0,
      }
    }
    return undefined
  })

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
    yield* startOrAttachSessionActivity(context, activityAttempt)
    const exit = yield* runReactiveLoop(context, activityAttempt).pipe(
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
}).annotate(Workflow.SuspendOnFailure, true)

export const RuntimeContextWorkflowNativeLayer = RuntimeContextWorkflowNative.toLayer(({ contextId }) =>
  runWorkflowNativeRuntimeContext(contextId))

export { RuntimeContextWorkflowPayload }

export const RuntimeContextWorkflowSessionLive = Layer.effect(
  RuntimeContextWorkflowSession,
  Effect.gen(function*() {
    const supervisor = yield* RuntimeContextSupervisor
    return RuntimeContextWorkflowSession.of({
      startOrAttach: supervisor.startOrAttach,
      send: supervisor.send,
    })
  }),
)
