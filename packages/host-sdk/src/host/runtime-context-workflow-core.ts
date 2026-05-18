import {
  Activity,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  RuntimeIngressInputRowSchema,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  Context,
  Cause,
  Effect,
  Layer,
  Predicate,
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
  toolErrorResult,
  toolExecutionFailed,
} from "../agent-tools/bindings/tool-error.ts"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import { agentInputEventFromRuntimeIngressRow } from "./runtime-ingress-transform.ts"
import {
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  RuntimeContextWorkflowPayload,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunFailedResult,
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

const RuntimeContextSessionStartOutcomeSchema = Schema.Union(
  Schema.TaggedStruct("Started", {
    evidence: RuntimeContextSessionStartedEvidenceSchema,
  }),
  Schema.TaggedStruct("Failed", {
    error: RuntimeContextError,
  }),
)

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
    success: RuntimeContextSessionStartOutcomeSchema,
    error: Schema.Never,
    execute: Effect.gen(function*() {
      const session = yield* RuntimeContextWorkflowSession
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.5
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.7
      const evidence = yield* session.startOrAttach(context, activityAttempt)
      return { _tag: "Started" as const, evidence }
    }).pipe(
      Effect.catchAll(error => Effect.succeed({ _tag: "Failed" as const, error })),
    ),
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

const inputWaitName = (
  contextId: string,
  sequence: number,
) => `runtime-context/${contextId}/input/${sequence}`

export const runtimeInputDeferredName = inputWaitName

export const runtimeInputDeferredFor = (
  contextId: string,
  sequence: number,
) =>
  DurableDeferred.make(inputWaitName(contextId, sequence), {
    success: RuntimeIngressInputRowSchema,
  })

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

const completedRuntimeInput = (
  context: RuntimeContext,
  sequence: number,
) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(runtimeInputDeferredFor(context.contextId, sequence)),
      Predicate.isUndefined,
    )
    if (exit === undefined) return undefined
    return yield* exit
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
    }).pipe(
      Effect.catchAllCause(cause =>
        Effect.succeed(toolErrorResult(
          toolExecutionFailed(
            event.part.id,
            event.part.name,
            Cause.squash(cause),
          ),
        ))),
    ),
  })

const handleAgentOutput = (
  context: RuntimeContext,
  activityAttempt: number,
  observation: RuntimeAgentOutputObservation,
) =>
  Effect.gen(function*() {
    const event = observation.event
    if (event._tag === "ToolUse") {
      // TFIND-041 (decided): session/codec mode is the INTENTIONAL,
      // by-decision authority for the ToolUse execution lifecycle — it is
      // not an accident of "by default". ACP codecs are observation-only
      // (the host does not execute the tool; the provider already did), so
      // the workflow skips `RuntimeToolUseExecutor` here; stdio-jsonl is
      // client-result roundtrip (the host executes and feeds the result
      // back). The `AgentOutput` ToolUse event is deliberately NOT
      // discriminated by execution authority; interpretation stays
      // codec/session-aware on purpose. Promoting an event-level
      // discriminant (option A: `ToolUseRequest` vs `ToolUseObservation`)
      // is a tracked, deliberately-deferred future option, not the
      // current contract.
      if (context.runtime.config.agentProtocol === "acp") {
        return undefined
      }
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

const handleRuntimeInput = (
  context: RuntimeContext,
  activityAttempt: number,
  row: RuntimeIngressInputRow,
) =>
  Effect.gen(function*() {
    const event = yield* agentInputEventFromRuntimeIngressRow(row).pipe(
      Effect.mapError(cause =>
        asRuntimeContextError(
          "runtime-context.input.decode",
          "failed decoding runtime input row",
          context.contextId,
          cause,
        )),
    )
    yield* sendSessionActivity(
      context,
      activityAttempt,
      {
        _tag: "AgentInput",
        commandId: `runtime-input-${context.contextId}-${row.inputId}`,
        event,
      },
      `firegrid.runtime-context.session.send.runtime-input.${row.inputId}`,
    )
  })

const runReactiveLoop = (
  context: RuntimeContext,
  activityAttempt: number,
) => {
  const loop = (
    lastOutputSequence: number,
    nextInputSequence: number,
  ): Effect.Effect<RuntimeExitEvidence, RuntimeContextError, unknown> =>
    Effect.gen(function*() {
      const input = yield* completedRuntimeInput(context, nextInputSequence)
      if (input !== undefined) {
        yield* handleRuntimeInput(context, activityAttempt, input)
        return yield* loop(lastOutputSequence, nextInputSequence + 1)
      }

      const output = yield* waitForAgentOutput(context, activityAttempt, lastOutputSequence).pipe(
        Effect.mapError(cause =>
          asRuntimeContextError(
            "runtime-context.output.wait",
            "failed waiting for runtime-context output",
            context.contextId,
            cause,
          )),
        Effect.flatMap((result): Effect.Effect<RuntimeAgentOutputObservation, RuntimeContextError> =>
          result._tag === "Timeout"
            ? asRuntimeContextError(
              "runtime-context.wait.timeout",
              "runtime-context output wait timed out unexpectedly",
              context.contextId,
            )
            : Effect.succeed(result.row)),
      )

      const exit = yield* handleAgentOutput(context, activityAttempt, output)
      if (exit !== undefined) return exit
      return yield* loop(output.sequence, nextInputSequence)
    })
  return loop(-1, 0)
}

const runWorkflowNativeRuntimeContext = (
  contextId: string,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, unknown> =>
  Effect.gen(function*() {
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* Effect.gen(function*() {
      // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.6
      const start = yield* startSessionActivity(context, activityAttempt)
      if (start._tag === "Failed") {
        return yield* writeRunFailedResult(context, activityAttempt, start.error)
      }
      return yield* runReactiveLoop(context, activityAttempt)
    }).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    if ("failure" in exit && exit.failure !== undefined) return exit
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  })

export const RuntimeContextWorkflowNative = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
}).annotate(Workflow.SuspendOnFailure, true)

export const RuntimeContextWorkflowNativeLayer = Layer.scopedDiscard(
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const captured = yield* Effect.context<never>()
    yield* engine.register(RuntimeContextWorkflowNative, ({ contextId }) =>
      runWorkflowNativeRuntimeContext(contextId).pipe(
        Effect.provide(captured),
      ) as Effect.Effect<StartRuntimeResult, RuntimeContextError>)
  }),
)
