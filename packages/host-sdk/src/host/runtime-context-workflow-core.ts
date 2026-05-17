import {
  Activity,
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
  type AgentInputEvent,
  type AgentOutputEvent,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import {
  RuntimeContextError,
  asRuntimeContextError,
} from "@firegrid/runtime/errors"
import {
  RuntimeToolUseExecutor,
} from "@firegrid/runtime/tool-executor"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import {
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  RuntimeContextWorkflowPayload,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunStarted,
} from "./internal/runtime-context-workflow-run.ts"

export { RuntimeContextWorkflowPayload }

const RuntimeContextSessionStartedEvidenceSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  ownerKind: Schema.Literal("raw", "codec"),
  ownerSessionId: Schema.String,
  startCommandId: Schema.String,
})
export type RuntimeContextSessionStartedEvidence = Schema.Schema.Type<
  typeof RuntimeContextSessionStartedEvidenceSchema
>

export interface RuntimeContextSessionCommand {
  readonly _tag: "AgentInput"
  readonly commandId: string
  readonly event: AgentInputEvent
}

const RuntimeContextSessionCommandAcceptedSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  commandId: Schema.String,
  ownerSessionId: Schema.String,
})
export type RuntimeContextSessionCommandAccepted = Schema.Schema.Type<
  typeof RuntimeContextSessionCommandAcceptedSchema
>

export interface RuntimeContextWorkflowSessionService {
  readonly startOrAttach: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextSessionStartedEvidence, RuntimeContextError>
  readonly send: (
    context: RuntimeContext,
    activityAttempt: number,
    command: RuntimeContextSessionCommand,
  ) => Effect.Effect<RuntimeContextSessionCommandAccepted, RuntimeContextError>
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
    success: RuntimeContextSessionStartedEvidenceSchema,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.5
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.7
      return yield* session.startOrAttach(context, activityAttempt)
    }),
  })

const sendSessionActivity = (
  context: RuntimeContext,
  activityAttempt: number,
  command: RuntimeContextSessionCommand,
  name: string,
) =>
  Activity.make({
    name,
    success: RuntimeContextSessionCommandAcceptedSchema,
    error: RuntimeContextError,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.5
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
          _tag: "AgentInput",
          commandId: `tool-${context.contextId}-${activityAttempt}-${event.part.id}`,
          event: result,
        },
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
    // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.6
    yield* startSessionActivity(context, activityAttempt)
    const exit = yield* runReactiveLoop(context, activityAttempt).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  })

export const RuntimeContextWorkflowNative = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
}).annotate(Workflow.SuspendOnFailure, true)

export const RuntimeContextWorkflowNativeLayer = RuntimeContextWorkflowNative.toLayer(({ contextId }) =>
  runWorkflowNativeRuntimeContext(contextId))
